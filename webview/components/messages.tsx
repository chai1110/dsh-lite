// webview/components/messages.tsx — 消息流 + 单条消息渲染（工具 / 命令 / 普通文本）。
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

function MsgRow({ m }: { m: ViewMessage }): ReactElement {
  const [open, setOpen] = useState(false);
  const text = m.streaming ? `${m.text}▍` : m.text;

  // M4 工具条目：call=等宽命令行（带终端图标）/ result=可折叠结果（带复制）
  if (m.kind === 'tool') {
    if (m.toolState === 'call') {
      return (
        <div className="msg msg-tool msg-tool-call">
          <Icon n="terminal" />
          <span className="tool-cmd">{text || '\u00A0'}</span>
        </div>
      );
    }
    const long = m.text.length > 300;
    return (
      <div className="msg msg-tool msg-tool-result">
        <div className="tool-result-head">
          <Icon n="output" />
          <span className="tool-result-label">工具结果</span>
          <span className="msg-actions">
            <button
              className="row-btn"
              type="button"
              title="复制结果"
              onClick={() => copyText(m.text)}
            >
              <Icon n="copy" />
            </button>
          </span>
        </div>
        <div className={`tool-result-body${long && !open ? ' clamp' : ''}`}>{text || '\u00A0'}</div>
        {long ? (
          <button className="btn tool-toggle" type="button" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
    );
  }

  // M6b 斜杠命令条目：/name args + 状态徽标（run↔done 由宿主配对）
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

  // M10 左右分栏：assistant=AI 回复在左（角色标+文本）；user=我们发送在右（角色标+气泡）。
  // system=整行居中弱化。复制钮 hover 浮现（右侧悬浮，不占布局）。
  const hasCopy = m.text.length > 0;
  const isSystem = m.role === 'system';
  return (
    <div className={`msg msg-${m.role}`}>
      {!isSystem ? (
        <span className={`msg-role-icon role-${m.role}`} title={roleTitle(m.role)}>
          <Icon n={roleIcon(m.role)} />
        </span>
      ) : null}
      <div className="msg-body">{text || '\u00A0'}</div>
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
