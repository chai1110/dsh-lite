// webview/components/topbar.tsx — 顶栏（logo + 会话名 + 连接点 + ＋新建）。
import type { ReactElement } from 'react';

import { Icon } from '../lib/codicon';
import { connectionStateClass } from '../lib/util';

interface TopbarProps {
  ready: boolean;
  activeTitle: string;
  connection: string;
  onToggleDropdown: () => void;
  onNewSession: () => void;
}

export function Topbar(props: TopbarProps): ReactElement {
  const { ready, activeTitle, connection, onToggleDropdown, onNewSession } = props;
  // M9b：宿主注入的品牌 logo URL（assets/icon.svg）；扩展未携带图标时为空（UI 回退 codicon）
  const brandLogo: string | undefined = (window as { DSH_LOGO?: string }).DSH_LOGO;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="btn session-btn"
          type="button"
          title={ready ? '点开查看全部历史会话 / 切换会话' : '查看历史会话（当前未就绪）'}
          onClick={onToggleDropdown}
        >
          {brandLogo ? (
            <img className="brand-logo" src={brandLogo} alt="DSH Lite" />
          ) : (
            <span className="brand-mark">
              <Icon n="comment-discussion" />
            </span>
          )}
          <span className="session-btn-title">{ready ? activeTitle : 'DSH Lite'}</span>
          {/* M13.3：历史入口对齐 Codex —— 时钟历史图标，点开展开全部会话 */}
          <Icon n="history" />
        </button>
      </div>
      <div className="topbar-right">
        <span
          className={`conn-dot ${connectionStateClass(connection)}`}
          title={`连接：${connection}`}
        />
        <button
          className="btn btn-icon btn-new"
          type="button"
          disabled={!ready}
          title="新建会话"
          onClick={onNewSession}
        >
          <Icon n="add" />
        </button>
      </div>
    </header>
  );
}
