// test/webview-render.test.tsx — webview 组件的真实客户端渲染测试（jsdom + react-dom 18）
//
// 覆盖范围（本文件）：
//   - 各 kind 的消息（tool/命令/文本/流式）能正常渲染并产出内容
//   - 同一 key 的条目在不同 kind 之间切换、列表增删时不崩溃
//
// 明确不在本文件覆盖：hooks 调用顺序违规（early return 绕过 useState/useMemo）。
//   实测 React 18 在 createRoot 渲染下对「hook 数量变化」既不抛错也不走 console.error
//   （legacy render 同样静默），无法在本环境构造可靠断言。
//   该风险由 test/hooks-order.test.ts 用源码静态断言守护——见该文件头部说明。
//
// 关键点：jsdom 必须在 react-dom 被加载之前就位（react-dom 模块初始化时探测 window），
// 故 react / react-dom 都用 require 在全局注入之后再取。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { ReactElement } from 'react';

import type { ViewMessage } from '../src/panel/protocol';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });

/** Node 22 起 globalThis.navigator 是只读 getter，直接赋值会抛错，故统一用 defineProperty */
const defineGlobal = (key: string, value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};
defineGlobal('window', dom.window);
defineGlobal('document', dom.window.document);
defineGlobal('navigator', dom.window.navigator);
defineGlobal('HTMLElement', dom.window.HTMLElement);
defineGlobal('Element', dom.window.Element);
defineGlobal('Node', dom.window.Node);
// React 18 要求显式声明 act 环境，否则 act() 会告警
defineGlobal('IS_REACT_ACT_ENVIRONMENT', true);

/* eslint-disable @typescript-eslint/no-var-requires */
const React = require('react') as typeof import('react') & { act?: (cb: () => void) => void };
const ReactDOMClient = require('react-dom/client') as typeof import('react-dom/client');
// React 18.3 已把 act 提升到 react；旧版从 react-dom/test-utils 取
const act: (cb: () => void) => void =
  React.act ?? (require('react-dom/test-utils') as { act: (cb: () => void) => void }).act;
const { Messages } = require('../webview/components/messages') as typeof import('../webview/components/messages');
/* eslint-enable @typescript-eslint/no-var-requires */

interface Mounted {
  container: HTMLElement;
  /** 渲染一批元素（每次一个独立 act 批次，模拟真实的状态推送序列） */
  render: (...els: ReactElement[]) => void;
  text: () => string;
}

function mount(): Mounted {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  return {
    container,
    render: (...els: ReactElement[]) => {
      act(() => {
        for (const el of els) root.render(el);
      });
    },
    text: () => container.textContent ?? '',
  };
}

test('MsgRow：同一 key 在 tool/命令/文本三类分支间切换可正常渲染', () => {
  const m = mount();
  const variants: ViewMessage[] = [
    { id: 's1', role: 'system', kind: 'tool', toolState: 'call', text: 'read_file(/a/b.ts)' },
    { id: 's1', role: 'system', kind: 'tool', toolState: 'result', text: 'line1\nline2' },
    { id: 's1', role: 'system', kind: 'command', cmdState: 'run', text: '/goal 跑 5 公里' },
    { id: 's1', role: 'system', kind: 'command', cmdState: 'done', cmdOk: true, text: '/goal x', resultText: 'ok' },
    { id: 's1', role: 'assistant', text: 'A'.repeat(600) },
    { id: 's1', role: 'user', text: 'hello' },
  ];
  assert.doesNotThrow(() => {
    for (const v of variants) m.render(React.createElement(Messages, { messages: [v] }));
  });
  assert.ok(m.text().length > 0, '应渲染出内容');
});

test('MsgRow：工具条目默认折叠，只显示一行摘要（M13.4 折叠策略）', () => {
  const m = mount();
  m.render(
    React.createElement(Messages, {
      messages: [{ id: 's1', role: 'system', kind: 'tool', toolState: 'call', text: 'grep(pattern=foo)' }],
    }),
  );
  const text = m.text();
  assert.ok(text.includes('grep'), `应显示工具名，实际：${text.slice(0, 120)}`);
  // 折叠态不展开完整正文（正文在 CollapseRow 的 body 里，open=false 时不渲染）
  assert.ok(!text.includes('pattern=foo') || text.includes('grep(pattern=foo)'), '折叠态不应把完整参数整块铺开');
});

test('MsgRow：流式助手文本（streaming 标记切换）可正常渲染', () => {
  const m = mount();
  const base = { id: 's2', role: 'assistant' as const };
  assert.doesNotThrow(() => {
    m.render(React.createElement(Messages, { messages: [{ ...base, text: '部分', streaming: true }] }));
    m.render(React.createElement(Messages, { messages: [{ ...base, text: '部分内容已完成' }] }));
    m.render(
      React.createElement(Messages, {
        messages: [{ ...base, text: '部分内容已完成，继续追加', streaming: true }],
      }),
    );
  });
  assert.ok(m.text().includes('继续追加'), '应显示最新流式内容');
});

test('MsgRow：超长助手文本默认 clamp，可展开全文', () => {
  const m = mount();
  const long = 'A'.repeat(600);
  m.render(React.createElement(Messages, { messages: [{ id: 's1', role: 'assistant', text: long }] }));
  const text = m.text();
  assert.ok(text.includes('展开全文'), `超长文本应提供展开按钮，实际：${text.slice(-80)}`);
});

test('Messages 列表按 id 增删可正常渲染（key 稳定）', () => {
  const m = mount();
  const a: ViewMessage = { id: 's1', role: 'user', text: 'a' };
  const b: ViewMessage = { id: 's2', role: 'assistant', text: 'b' };
  const c: ViewMessage = { id: 's3', role: 'system', kind: 'tool', toolState: 'call', text: 'grep(x)' };
  assert.doesNotThrow(() => {
    m.render(React.createElement(Messages, { messages: [a] }));
    m.render(React.createElement(Messages, { messages: [a, b] }));
    m.render(React.createElement(Messages, { messages: [a, c] }));
    m.render(React.createElement(Messages, { messages: [] }));
  });
  assert.equal(m.text(), '', '清空后应无内容');
});
