// webview/app.tsx — M0「三行框架」：顶栏 / 消息区 / 输入区。
//
// 设计铁律（见 docs/03-UI规格.md §零）：像 Codex / Claude Code 那样极简一页到底，
// 没有设置页、没有二级/三级页、没有左下角齿轮。顶栏只有三样：会话 ▾ / ＋ / ⋯。
// M0 只搭骨架、不接 DSH：所有交互元素禁用占位，消息区恒为空态。
import { useEffect, useState, type ReactElement } from 'react';

import {
  PROTOCOL_VERSION,
  initialState,
  isProtocolCompatible,
  mismatchHint,
  type ConnectionState,
  type HostMessage,
  type PanelState,
  type UiMessage,
} from '../src/panel/protocol';

// acquireVsCodeApi 由 VS Code webview 运行时注入，只能调用一次；
// 在本模块作用域获取一次并缓存（重复调用会抛错）。
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

function postUiMessage(message: UiMessage): void {
  vscode.postMessage(message);
}

/** 顶栏右侧连接状态点的颜色，一律用 --vscode-* 变量（明暗主题自动跟随）。 */
function connectionColor(connection: ConnectionState): string {
  switch (connection) {
    case 'ready':
      return 'var(--vscode-charts-green, var(--vscode-descriptionForeground))';
    case 'error':
      return 'var(--vscode-errorForeground, var(--vscode-charts-red))';
    case 'offline':
      return 'var(--vscode-charts-red, var(--vscode-descriptionForeground))';
    case 'connecting':
      return 'var(--vscode-charts-yellow, var(--vscode-descriptionForeground))';
    case 'idle':
    default:
      return 'var(--vscode-descriptionForeground)';
  }
}

export function App(): ReactElement {
  const [state, setState] = useState<PanelState>(initialState());
  // 协议版本不匹配时，按 mismatchHint 显示醒目提示，且不再渲染正常内容。
  const [mismatch, setMismatch] = useState<null | 'reload' | 'upgrade'>(null);

  useEffect(() => {
    // 1) 握手：UI 启动后第一条消息，携带自身协议版本。
    postUiMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    // 2) 已挂载，可以接收状态快照（握手与挂载顺序不保证，宿主会补发）。
    postUiMessage({ type: 'ui/ready' });

    // 3) 监听宿主消息，host/state 直接整体替换 state。
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

  if (mismatch) {
    const banner =
      mismatch === 'reload'
        ? '请重载窗口以更新面板'
        : '面板版本高于扩展，请更新 DSH Lite';
    return (
      <div className="mismatch">
        <div className="mismatch-banner" role="alert">
          {banner}
        </div>
      </div>
    );
  }

  const isEmpty = state.messages.length === 0;

  // 空态文案/动作按连接态变化（docs/design/宿主-UI协议.md §5.2）
  const conn = state.connection;
  let emptyTitle = '未连接';
  let emptySub: string | undefined;
  let actionLabel: string | null = null;
  if (conn === 'connecting') {
    emptyTitle = '连接中…';
    emptySub = '正在探测并启动 dsh';
  } else if (conn === 'ready') {
    emptyTitle = '已连接';
    emptySub = '会话与消息列表将在后续版本提供';
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
  const canAct = actionLabel !== null && conn !== 'connecting';

  return (
    <div className="app">
      {/* 顶栏：固定一行，只有三样 —— 会话下拉 / ＋新建 / ⋯更多 */}
      <header className="topbar">
        <button className="btn" type="button" disabled title="会话">
          会话 ▾
        </button>
        <button className="btn" type="button" disabled title="新建会话">
          ＋
        </button>
        <button className="btn" type="button" disabled title="更多">
          ⋯
        </button>
        {/* 右侧连接状态点：仅用颜色，无文字标签 */}
        <span
          className="conn-dot"
          title={state.connection}
          style={{ background: connectionColor(state.connection) }}
        />
      </header>

      {/* 消息区：占满剩余空间 */}
      <main className="messages">
        {isEmpty ? (
          <div className="empty">
            <div className="empty-title">{emptyTitle}</div>
            {emptySub ? <div className="empty-sub">{emptySub}</div> : null}
            {canAct && actionLabel ? (
              <button
                className="btn empty-action"
                type="button"
                onClick={() => postUiMessage({ type: 'ui/refresh' })}
              >
                {actionLabel}
              </button>
            ) : null}
          </div>
        ) : (
          state.messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.role}`}>
              {m.text}
            </div>
          ))
        )}
      </main>

      {/* 输入区：固定底部，M0 全部禁用 */}
      <footer className="composer">
        <textarea
          className="composer-input"
          disabled
          placeholder="连接后即可输入"
          rows={3}
        />
        <div className="composer-actions">
          <button className="btn" type="button" disabled title="附加文件">
            @
          </button>
          <button className="btn btn-primary" type="button" disabled>
            发送
          </button>
        </div>
      </footer>
    </div>
  );
}
