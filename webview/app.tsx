// webview/app.tsx — DSH Lite 面板（M2/M3）：会话下拉 + 消息流 + 输入区
//
// 设计铁律（docs/03-UI规格.md §零）：极简一页到底，无设置页。顶栏只有 会话▾ / ＋新建 / ⋯更多。
// UI 只渲染宿主下发的快照；发送/停止/切换/新建都以消息上行，业务全在宿主。
import { useEffect, useRef, useState, type ReactElement } from 'react';

import {
  PROTOCOL_VERSION,
  initialState,
  isProtocolCompatible,
  mismatchHint,
  type HostMessage,
  type PanelState,
  type UiMessage,
  type ViewMessage,
} from '../src/panel/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

function post(msg: UiMessage): void {
  vscode.postMessage(msg);
}

/** 顶栏连接状态点的颜色，一律用 --vscode-* 变量 */
function connectionColor(connection: string): string {
  switch (connection) {
    case 'ready':
      return 'var(--vscode-charts-green, var(--vscode-descriptionForeground))';
    case 'error':
      return 'var(--vscode-errorForeground, var(--vscode-charts-red))';
    case 'offline':
      return 'var(--vscode-charts-red, var(--vscode-descriptionForeground))';
    case 'connecting':
      return 'var(--vscode-charts-yellow, var(--vscode-descriptionForeground))';
    default:
      return 'var(--vscode-descriptionForeground)';
  }
}

function MsgRow({ m }: { m: ViewMessage }): ReactElement {
  const cls =
    m.role === 'user' ? 'msg-user' : m.role === 'assistant' ? 'msg-assistant' : 'msg-system';
  const text = m.streaming ? `${m.text}▍` : m.text;
  return <div className={`msg ${cls}`}>{text || '\u00A0'}</div>;
}

export function App(): ReactElement {
  const [state, setState] = useState<PanelState>(initialState());
  const [mismatch, setMismatch] = useState<null | 'reload' | 'upgrade'>(null);
  const [dropdown, setDropdown] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    post({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    post({ type: 'ui/ready' });

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as HostMessage;
      switch (data.type) {
        case 'hello':
          if (!isProtocolCompatible(data.protocolVersion)) {
            setMismatch(mismatchHint(data.protocolVersion));
          }
          break;
        case 'host/state':
          setState(data.state);
          break;
        case 'host/error':
          setState((prev) => ({
            ...prev,
            connection: 'error',
            error: { code: data.code, message: data.message },
          }));
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // 新消息/流式时自动滚到底（state.messages 每次发布都是新引用，流式尾巴变化也会触发）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages]);

  if (mismatch) {
    const banner =
      mismatch === 'reload' ? '请重载窗口以更新面板' : '面板版本高于扩展，请更新 DSH Lite';
    return (
      <div className="mismatch">
        <div className="mismatch-banner" role="alert">
          {banner}
        </div>
      </div>
    );
  }

  const conn = state.connection;
  const ready = conn === 'ready';
  const active = state.sessions.find((s) => s.sessionId === state.activeSessionId) ?? null;
  const activeTitle = active?.title ?? '会话 ▾';
  const hasMsgs = state.messages.length > 0;

  // 空态文案（docs/design/宿主-UI协议.md §5.2）
  let emptyTitle = '未连接';
  let emptySub: string | undefined;
  let actionLabel: string | null = null;
  if (conn === 'connecting') {
    emptyTitle = '连接中…';
    emptySub = '正在探测并启动 dsh';
  } else if (conn === 'ready') {
    emptyTitle = '没有可显示的会话';
    emptySub = '从顶部下拉选择历史会话，或点 ＋ 新建';
  } else if (conn === 'error') {
    emptyTitle = '连接出错';
    emptySub = state.error?.message ?? '未知错误';
    actionLabel = '重连';
  } else if (conn === 'offline') {
    emptyTitle = '已断开';
    emptySub = state.error?.message ?? '点击重连重新拉起 dsh';
    actionLabel = '重连';
  } else {
    emptySub = '点击启动开始连接';
    actionLabel = '启动';
  }

  // running：会话列表中 active 的 running 或消息尾部仍在流式
  const running =
    Boolean(active?.running) ||
    [...state.messages].reverse().find((m) => m.role === 'user' || m.role === 'assistant')
      ?.streaming === true;

  const canSend = ready && state.activeSessionId !== null && draft.trim().length > 0;
  const enterMode = state.composerEnterBehavior ?? 'send';
  const sendHint =
    enterMode === 'send' ? '输入消息，Enter 发送' : '输入消息，Enter 换行，⌘/Ctrl+Enter 发送';

  const submit = (): void => {
    if (!canSend) return;
    const text = draft.trim();
    setDraft('');
    post({ type: 'ui/promptSubmit', text });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="btn session-btn"
            type="button"
            disabled={!ready}
            title="切换历史会话"
            onClick={() => setDropdown((v) => !v)}
          >
            {ready ? activeTitle : '会话 ▾'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={!ready}
            title="新建会话"
            onClick={() => post({ type: 'ui/newSession' })}
          >
            ＋
          </button>
        </div>
        <span
          className="conn-dot"
          title={conn}
          style={{ background: connectionColor(conn) }}
        />
      </header>

      {dropdown && ready ? (
        <>
          <div className="dropdown-backdrop" onClick={() => setDropdown(false)} />
          <div className="session-list">
            {state.sessions.length === 0 ? (
              <div className="session-empty">暂无会话</div>
            ) : (
              [...state.sessions].map((s) => (
                <button
                  key={s.sessionId}
                  className={`session-item${s.sessionId === state.activeSessionId ? ' is-active' : ''}`}
                  type="button"
                  onClick={() => {
                    setDropdown(false);
                    post({ type: 'ui/selectSession', sessionId: s.sessionId });
                  }}
                >
                  <span className="session-item-title" title={s.title}>
                    {s.title}
                  </span>
                  <span className="session-item-meta">
                    {s.running ? '●' : ''}
                    {s.cwd ? ` ${s.cwd.split(/[\\/]/).pop()}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      ) : null}

      <main className="messages" ref={scrollRef}>
        {!hasMsgs ? (
          <div className="empty">
            <div className="empty-title">{emptyTitle}</div>
            {emptySub ? <div className="empty-sub">{emptySub}</div> : null}
            {actionLabel && conn !== 'connecting' ? (
              <button
                className="btn empty-action"
                type="button"
                onClick={() => post({ type: 'ui/refresh' })}
              >
                {actionLabel}
              </button>
            ) : null}
          </div>
        ) : (
          state.messages.map((m) => <MsgRow key={m.id} m={m} />)
        )}
      </main>

      <footer className="composer">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={3}
          disabled={!ready || state.activeSessionId === null}
          placeholder={
            !ready
              ? '等待连接…'
              : state.activeSessionId === null
                ? '先选择或新建一个会话'
                : sendHint
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // 输入法组合中不拦截
            if (e.key !== 'Enter') return;
            const sendViaMod = enterMode === 'newline';
            if (sendViaMod && !e.metaKey && !e.ctrlKey) return; // newline 模式：Enter 换行
            if (!sendViaMod && e.shiftKey) return; // send 模式：Shift+Enter 换行
            e.preventDefault();
            submit();
          }}
        />
        <div className="composer-actions">
          {running ? (
            <button
              className="btn"
              type="button"
              title="停止生成"
              onClick={() => post({ type: 'ui/stop' })}
            >
              ■ 停止
            </button>
          ) : null}
          <button className="btn btn-primary" type="button" disabled={!canSend} onClick={submit}>
            发送
          </button>
        </div>
      </footer>
    </div>
  );
}
