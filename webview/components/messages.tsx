// webview/components/messages.tsx — 消息流 + 单条消息渲染。
//
// M13.4 折叠策略（学 dsh-client-ui-tool 的 ToolRow）：
//   - 工具调用 (tool/call)：默认折叠，只显示「工具名 + 参数预览」一行；
//     展开后才看完整参数。
//   - 工具结果 (tool/result)：默认折叠，头部显示「行数 / 字数」摘要；
//     展开后才看完整输出。
//   - 助手长文本 (> 500 字)：默认 6 行 clamp，展开看全文。
//   - 用户气泡 / 命令 / 状态行：保持原样。
import { useState, type ReactElement } from 'react';

import type { ViewMessage } from '../../src/panel/protocol';
import { Icon } from '../lib/codicon';
import { commandBadge, copyText, roleIcon, roleTitle } from '../lib/util';

interface MessagesProps {
  messages: ViewMessage[];
}

export function Messages({ messages }: MessagesProps): ReactElement {
  return (
    <>
      {messages.map((m) => (
        <MsgRow key={m.id} m={m} />
      ))}
    </>
  );
}

/** 工具调用的参数预览：从 "name(arg1, arg2, ...)" 抽出 args 的可读首段 */
function previewArgs(text: string): { name: string; args: string } {
  const i = text.indexOf('(');
  if (i < 0) return !text ? { name: 'tool', args: '' } : { name: text, args: '' };
  if (!text.endsWith(')')) return { name: text.slice(0, i) || 'tool', args: '' };
  return { name: text.slice(0, i) || 'tool', args: text.slice(i + 1, -1) };
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

/** 折叠头组件：chevron + 图标 + 标题 + meta + 复制 */
function CollapseRow({
  icon,
  title,
  meta,
  copyValue,
  defaultOpen = false,
  children,
}: {
  icon: string;
  title: ReactElement | string;
  meta?: string;
  copyValue?: string;
  defaultOpen?: boolean;
  children: ReactElement;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapse${open ? ' is-open' : ' is-collapsed'}`}>
      <div className="collapse-head" onClick={() => setOpen((v) => !v)}>
        <span className="collapse-chevron" aria-hidden="true">
          <Icon n={open ? 'chevron-down' : 'chevron-right'} />
        </span>
        <span className="collapse-icon" aria-hidden="true">
          <Icon n={icon} />
        </span>
        <span className="collapse-title">{title}</span>
        {meta ? <span className="collapse-meta">{meta}</span> : null}
        {copyValue !== undefined ? (
          <button
            className="row-btn collapse-copy"
            type="button"
            title="复制"
            onClick={(e) => {
              e.stopPropagation();
              copyText(copyValue);
            }}
          >
            <Icon n="copy" />
          </button>
        ) : null}
      </div>
      {open ? <div className="collapse-body">{children}</div> : null}
    </div>
  );
}

function MsgRow({ m }: { m: ViewMessage }): ReactElement {
  // 流式尾巴：极细光标，淡灰闪动（CSS 处理）；不在文本里硬塞字符（避免撑宽布局）
  const showStreaming = Boolean(m.streaming);

  // ===== 工具调用：默认折叠 =====
  if (m.kind === 'tool' && m.toolState === 'call') {
    const fullArgs = m.text;
    const { name, args } = previewArgs(fullArgs);
    const argsPreview =
      args.length > 120
        ? `${(args.split('\n', 1)[0] ?? args).slice(0, 120)}…`
        : args;
    const callTitle = argsPreview ? `${name}(${argsPreview})` : name;
    return (
      <CollapseRow
        icon="terminal"
        title={callTitle}
        copyValue={fullArgs}
      >
        <pre className="tool-body">{fullArgs}</pre>
      </CollapseRow>
    );
  }

  // ===== 工具结果：默认折叠，头部显示摘要 =====
  if (m.kind === 'tool' && m.toolState === 'result') {
    const text = m.text || '\u00A0';
    const lines = lineCount(text);
    const bytes = text.length;
    const truncated = text.endsWith('…(已截断)');
    const { name: toolName } = previewArgs(m.text);
    return (
      <CollapseRow
        icon="output"
        title={`工具结果 · ${toolName}`}
        meta={`${lines} 行 · ${bytes} 字${truncated ? ' · 已截断' : ''}`}
        copyValue={text}
      >
        <pre className="tool-result-body">{text}</pre>
      </CollapseRow>
    );
  }

  // ===== 命令气泡：保持原观感（已很整洁：徽标 + 命令行 + 可选结果） =====
  if (m.kind === 'command') {
    const badge = commandBadge(m);
    return (
      <div className="msg msg-command">
        <div className="cmd-line">
          <Icon n="terminal-bash" />
          <span className="tool-cmd">{m.text}</span>
          <span className={`cmd-badge ${badge.cls}`}>{badge.text}</span>
          {m.cmdState === 'done' && m.resultText ? (
            <span className="msg-actions">
              <button
                className="row-btn"
                type="button"
                title="复制命令结果"
                onClick={() => copyText(m.resultText ?? '')}
              >
                <Icon n="copy" />
              </button>
            </span>
          ) : null}
        </div>
        {m.cmdState === 'done' && m.resultText ? (
          <div className="cmd-result">{m.resultText}</div>
        ) : null}
      </div>
    );
  }

  // ===== 普通文本（user / assistant / system） =====
  const isSystem = m.role === 'system';
  const isAssistant = m.role === 'assistant';
  const text = m.text || '\u00A0';
  // 助手长文本默认 clamp 到 6 行，可展开
  const longAssistant = isAssistant && text.length > 500;
  const [open, setOpen] = useState(false);
  const clamped = longAssistant && !open;
  const hasCopy = m.text.length > 0;

  return (
    <div className={`msg msg-${m.role}${isAssistant ? ' msg-text' : ''}`}>
      {!isSystem ? (
        <span className={`msg-role-icon role-${m.role}`} title={roleTitle(m.role)}>
          <Icon n={roleIcon(m.role)} />
        </span>
      ) : null}
      <div className="msg-body-wrap">
        <div className={`msg-body${clamped ? ' clamp' : ''}${showStreaming ? ' is-streaming' : ''}`}>
          {text}
        </div>
        {longAssistant ? (
          <button
            className="msg-toggle"
            type="button"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '收起' : '展开全文'}
          </button>
        ) : null}
      </div>
      {!isSystem && hasCopy ? (
        <span className="msg-actions">
          <button
            className="row-btn"
            type="button"
            title="复制消息"
            onClick={() => copyText(m.text)}
          >
            <Icon n="copy" />
          </button>
        </span>
      ) : null}
    </div>
  );
}