// test/viewmodel.test.ts — SessionViewModel 单测：事件→条目、流式尾巴、shadow 折叠、幂等
// 运行环境：node（不是浏览器）。node:test + node:assert/strict，由 scripts/build.mjs --test 编到 out/test/。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionViewModel } from '../src/session/viewmodel';
import type { RawEvent } from '../src/session/events';

function evt(partial: Partial<RawEvent> & { type: string; seq: number }): RawEvent {
  return { type: partial.type, seq: partial.seq, data: partial.data, sourceEventSeqs: partial.sourceEventSeqs, ignorable: partial.ignorable, time: partial.time };
}

function kinds(vm: SessionViewModel): string[] {
  return vm.getState().entries.map((e) => e.kind);
}
function texts(vm: SessionViewModel): string[] {
  return vm.getState().entries.map((e) => e.text);
}

test('user/message 追加 user 条目', () => {
  const vm = new SessionViewModel();
  assert.equal(vm.applyEvent(evt({ type: 'user/message', seq: 1, data: { text: '你好' } })), true);
  const s = vm.getState();
  assert.equal(s.entries.length, 1);
  assert.deepEqual({ kind: s.entries[0].kind, text: s.entries[0].text, seq: s.entries[0].seq }, { kind: 'user', text: '你好', seq: 1 });
});

test('assistant/chunk 累积到流式尾巴，assistant/message 定稿', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'hello' }));
  vm.applyEvent(evt({ type: 'assistant/chunk', seq: 2, data: { text: 'Hi,' } }));
  vm.applyEvent(evt({ type: 'assistant/chunk', seq: 3, data: { text: ' world' } }));
  let s = vm.getState();
  assert.equal(s.entries.length, 2); // 没有多出占位条目
  assert.equal(s.entries[1].text, 'Hi, world');
  assert.equal(s.entries[1].streaming, true);

  // 定稿消息是尾巴的前缀 → 原地升级，不再追加
  vm.applyEvent(evt({ type: 'assistant/message', seq: 4, data: { text: 'Hi, world!' } }));
  s = vm.getState();
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[1].text, 'Hi, world!');
  assert.equal(s.entries[1].streaming, false);
});

test('定稿消息与流式尾巴不一致时各自成条目', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'assistant/chunk', seq: 2, data: { text: 'old' } }));
  vm.applyEvent(evt({ type: 'assistant/message', seq: 3, data: { text: 'totally-different' } }));
  const s = vm.getState();
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[0].text, 'old');
  assert.equal(s.entries[0].streaming, false); // 旧尾巴关闭
  assert.equal(s.entries[1].text, 'totally-different');
});

test('sourceEventSeqs 折叠旧条目（编辑重发替换整段回合）', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'hello' }));
  vm.applyEvent(evt({ type: 'assistant/message', seq: 2, data: { text: 'response' } }));
  // 编辑重发：新 user/message 带 sourceEventSeqs=[1,2]，旧的 user+assistant 都被折叠
  vm.applyEvent(evt({ type: 'user/message', seq: 3, data: 'hello (edited)', sourceEventSeqs: [1, 2] }));
  const s = vm.getState();
  assert.deepEqual(kinds(vm), ['user']);
  assert.deepEqual(texts(vm), ['hello (edited)']);
  assert.deepEqual(s.entries.map((e) => e.seq), [3]);
});

test('sourceEventSeqs 只删列出的 seq，不影响其它条目', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'a' }));
  vm.applyEvent(evt({ type: 'user/message', seq: 2, data: 'b' }));
  vm.applyEvent(evt({ type: 'assistant/message', seq: 3, data: { text: 'c' }, sourceEventSeqs: [1] }));
  const s = vm.getState();
  assert.deepEqual(s.entries.map((e) => e.seq), [2, 3]);
});

test('相同 seq 幂等（重复帧只采纳一次）', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'x' }));
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'y' }));
  assert.equal(vm.getState().entries.length, 1);
  assert.equal(vm.getState().entries[0].text, 'x');
});

test('ignorable 事件跳过不渲染', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'some/internal', seq: 1, ignorable: true }));
  assert.equal(vm.getState().entries.length, 0);
  assert.equal(vm.getState().lastSeq, 1); // 但 seq 仍推进（去重依据）
});

test('tool/call 与 tool/result 渲染为 tool 条目', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'tool/call', seq: 1, data: { name: 'Bash', input: 'ls -la' } }));
  let s = vm.getState();
  assert.equal(s.entries[0].kind, 'tool');
  assert.equal(s.entries[0].toolState, 'call');
  assert.equal(s.entries[0].name, 'Bash');
  assert.ok(s.entries[0].text.includes('ls -la'));

  vm.applyEvent(evt({ type: 'tool/result', seq: 2, data: { text: 'file1\nfile2' } }));
  s = vm.getState();
  assert.equal(s.entries[1].toolState, 'result');
  assert.ok(s.entries[1].text.includes('file1'));
});

test('tool/result 超长结果截断到 300 字符', () => {
  const vm = new SessionViewModel();
  const long = 'x'.repeat(500);
  vm.applyEvent(evt({ type: 'tool/result', seq: 1, data: { text: long } }));
  const text = vm.getState().entries[0].text;
  assert.equal(text.length, 301); // 300 + …
  assert.ok(text.endsWith('…'));
});

test('已知状态事件 → 中文状态行', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'turn/start', seq: 1 }));
  vm.applyEvent(evt({ type: 'todo/write', seq: 2 }));
  const s = vm.getState();
  assert.equal(s.entries[0].kind, 'status');
  assert.equal(s.entries[0].text, '回合开始');
  assert.equal(s.entries[1].text, '待办更新');
});

test('assistant/chunk 的文本在 data.chunk（实测形状 {turn,step,chunk}）', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'q' }));
  vm.applyEvent(evt({ type: 'assistant/chunk', seq: 2, data: { turn: 't1', step: 's1', chunk: '增量' } }));
  const s = vm.getState();
  assert.equal(s.entries[1].text, '增量');
});

test('session/* 生命周期元事件不渲染（推进 seq 但无条目）', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'session/end-seed', seq: 1, data: {} }));
  assert.equal(vm.getState().entries.length, 0);
  assert.equal(vm.getState().lastSeq, 1);
});

test('未识别事件折叠为 type 短标签状态行', () => {
  const vm = new SessionViewModel();
  vm.applyEvent(evt({ type: 'custom/weird', seq: 1 }));
  const s = vm.getState();
  assert.equal(s.entries[0].kind, 'status');
  assert.equal(s.entries[0].text, 'weird'); // label() 取最后一段
});

test('applyRecords 批量回放 + reset 清空', () => {
  const vm = new SessionViewModel();
  vm.applyRecords([
    { type: 'record', event: evt({ type: 'user/message', seq: 1, data: 'a' }) },
    { type: 'record', event: evt({ type: 'assistant/chunk', seq: 2, data: { text: 'b' } }) },
  ]);
  let s = vm.getState();
  assert.deepEqual(kinds(vm), ['user', 'assistant']);
  assert.equal(s.lastSeq, 2);
  vm.reset();
  s = vm.getState();
  assert.equal(s.entries.length, 0);
  assert.equal(s.lastSeq, 0);
});

test('onChange 在条目变化时触发', () => {
  const vm = new SessionViewModel();
  let fired = 0;
  vm.onChange(() => fired++);
  vm.applyEvent(evt({ type: 'user/message', seq: 1, data: 'a' }));
  assert.equal(fired, 1);
});
