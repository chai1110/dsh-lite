// test/protocol.test.ts — 协议 v1 的编解码与版本校验单测。
//
// 运行环境：node（不是浏览器）。用 node:test + node:assert/strict，
// 不引入 vitest / jest。本文件由 scripts/build.mjs --test 编到 out/test/，
// import 路径写 `../src/panel/protocol`（相对，不带 .ts 后缀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  isProtocolCompatible,
  mismatchHint,
  initialState,
} from '../src/panel/protocol';

test('isProtocolCompatible(PROTOCOL_VERSION) 为 true', () => {
  assert.equal(isProtocolCompatible(PROTOCOL_VERSION), true);
});

test('isProtocolCompatible 其他值（含非数字）均为 false', () => {
  assert.equal(isProtocolCompatible(PROTOCOL_VERSION + 1), false);
  assert.equal(isProtocolCompatible(PROTOCOL_VERSION - 1), false);
  assert.equal(isProtocolCompatible('1'), false);
  assert.equal(isProtocolCompatible(null), false);
  assert.equal(isProtocolCompatible(undefined), false);
});

test('mismatchHint(PROTOCOL_VERSION - 1) === "reload"', () => {
  assert.equal(mismatchHint(PROTOCOL_VERSION - 1), 'reload');
});

test('mismatchHint(PROTOCOL_VERSION + 1) === "upgrade"', () => {
  assert.equal(mismatchHint(PROTOCOL_VERSION + 1), 'upgrade');
});

test('initialState 返回 idle + 空骨架', () => {
  const s = initialState();
  assert.equal(s.connection, 'idle');
  assert.deepEqual(s.sessions, []);
  assert.equal(s.activeSessionId, null);
  assert.deepEqual(s.messages, []);
});
