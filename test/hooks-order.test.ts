// test/hooks-order.test.ts — 守护 React Hooks 调用顺序（静态断言，无 DOM 依赖）
//
// 背景：webview 组件里若把 useState/useMemo 放在 early return 之后，同一实例在状态切换时
// hook 调用数量会变化，React 抛 "Rendered more/fewer hooks than during the previous render" 并白屏。
// 这类 bug 需要「真实客户端渲染 + 重渲染」才能复现，跑一次渲染测不出来，故用源码静态断言守护。
//
// 覆盖：
//   - MsgRow（webview/components/messages.tsx）：三个分支 early return 不得绕过 useState
//   - App（webview/app.tsx）：mismatch 的 early return 不得绕过其后的 5 个 hook
//   - CSP：webview 内不得出现内联 style 属性（style-src 已收紧，内联会被拦截）
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** 取函数体行范围（大括号配平近似；仅用于结构断言） */
function functionRange(lines: string[], signature: RegExp): { start: number; end: number } {
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && signature.test(lines[i])) start = i;
    if (start === -1) continue;
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0 && i > start) return { start, end: i };
  }
  return { start: -1, end: -1 };
}

const HOOK_RE = /\buse(State|Memo|Effect|Ref|Callback|Context|Reducer|LayoutEffect)\s*[<(]/;

test('MsgRow：useState 必须在所有 early return 之前（Hooks 规则）', () => {
  const lines = readFileSync('webview/components/messages.tsx', 'utf8').split('\n');
  const { start, end } = functionRange(lines, /^function MsgRow\(/);
  assert.ok(start >= 0, '未定位到 MsgRow 函数');

  let firstReturn = -1;
  let firstHook = -1;
  for (let i = start; i <= end; i++) {
    if (firstReturn === -1 && /^\s+return[ (]/.test(lines[i])) firstReturn = i;
    if (firstHook === -1 && HOOK_RE.test(lines[i])) firstHook = i;
  }
  assert.ok(firstHook >= 0, 'MsgRow 内应至少有一个 hook 调用');
  assert.ok(
    firstReturn === -1 || firstHook < firstReturn,
    `MsgRow 的 hook(L${firstHook + 1}) 必须早于首个 early return(L${firstReturn + 1})，否则 kind 变化时会白屏`,
  );
});

test('App：mismatch 的 early return 不得绕过其后的任何 hook（Hooks 规则）', () => {
  const lines = readFileSync('webview/app.tsx', 'utf8').split('\n');
  const { start, end } = functionRange(lines, /^export function App\(/);
  assert.ok(start >= 0, '未定位到 App 函数');

  let mismatchBranch = -1;
  for (let i = start; i <= end; i++) {
    if (/^\s*if \(mismatch\) \{/.test(lines[i])) {
      mismatchBranch = i;
      break;
    }
  }
  assert.ok(mismatchBranch > 0, '未定位到 mismatch 分支');

  const hooksAfter: number[] = [];
  for (let i = mismatchBranch; i <= end; i++) {
    if (HOOK_RE.test(lines[i])) hooksAfter.push(i + 1);
  }
  assert.deepEqual(
    hooksAfter,
    [],
    `mismatch 分支之后仍有 hook 调用（行 ${hooksAfter.join(', ')}）→ 一旦触发协议不匹配会白屏`,
  );
});

test('webview 无内联 style 属性（CSP 已收紧，内联 style 会被拦截）', () => {
  const files = readdirSync('webview', { recursive: true })
    .map((f) => String(f))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => join('webview', f));

  assert.ok(files.length > 0, '未扫描到 webview 源文件');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(
      !/\bstyle=\{/.test(text),
      `${f} 含内联 style 属性；CSP style-src 已收紧为 nonce+cspSource，内联 style 会被拦截`,
    );
  }
});
