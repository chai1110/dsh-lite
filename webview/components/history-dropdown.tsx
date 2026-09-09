// webview/components/history-dropdown.tsx — 会话下拉（搜索 + 时间分组 + 归档折叠 + 行操作）。
import type { ReactElement } from 'react';

import type { SessionBrief } from '../../src/panel/protocol';
import { Icon } from '../lib/codicon';
import { post } from '../lib/post';

interface Group {
  label: string;
  rows: SessionBrief[];
}

interface HistoryDropdownProps {
  /** 搜索词 + setter（受控） */
  query: string;
  onQueryChange: (v: string) => void;
  /** 时间分组（已按 updatedAt 倒序排好） */
  groups: Group[];
  /** 已归档（折叠时仍展示头部） */
  archived: SessionBrief[];
  showArchived: boolean;
  onToggleArchived: () => void;
  /** 当前 active id（用于行高亮） */
  activeSessionId: string | null;
  /** 行级回调：进入 / 重命名开始 / 改名保存 / 改名取消 / 改名输入变化 */
  onOpen: (s: SessionBrief) => void;
  onStartRename: (s: SessionBrief) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  renameId: string | null;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  /** 关闭下拉 */
  onClose: () => void;
}

export function HistoryDropdown(props: HistoryDropdownProps): ReactElement {
  const {
    query, onQueryChange, groups, archived, showArchived, onToggleArchived,
    activeSessionId, onOpen, onStartRename, onSaveRename, onCancelRename,
    renameId, renameValue, onRenameValueChange, onClose,
  } = props;
  const trimmed = query.trim().toLowerCase();
  const totalShown = groups.reduce((n, g) => n + g.rows.length, 0) + archived.length;
  const q = trimmed;

  return (
    <>
      <div className="dropdown-backdrop" onClick={onClose} />
      <div className="session-list">
        <div className="history-search">
          <Icon n="search" />
          <input
            className="history-search-input"
            type="text"
            autoFocus
            placeholder="搜索历史会话…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        {totalShown === 0 ? (
          <div className="session-empty">{q ? '无匹配会话' : '暂无会话'}</div>
        ) : (
          <>
            {groups.map((g) => (
              <div className="history-group" key={g.label}>
                <div className="history-group-title">{g.label}</div>
                {g.rows.map((s) => (
                  <SessionItem
                    key={s.sessionId}
                    s={s}
                    active={s.sessionId === activeSessionId}
                    editing={renameId === s.sessionId}
                    renameValue={renameValue}
                    onRenameValueChange={onRenameValueChange}
                    onOpen={onOpen}
                    onStartRename={onStartRename}
                    onSaveRename={onSaveRename}
                    onCancelRename={onCancelRename}
                  />
                ))}
              </div>
            ))}
            {archived.length > 0 ? (
              <>
                <button
                  className="archived-toggle"
                  type="button"
                  onClick={onToggleArchived}
                >
                  <Icon n="archive" />
                  <span>已归档（{archived.length}）</span>
                  <Icon n={showArchived ? 'chevron-down' : 'chevron-right'} />
                </button>
                {showArchived
                  ? archived.map((s) => (
                      <SessionItem
                        key={s.sessionId}
                        s={s}
                        active={s.sessionId === activeSessionId}
                        editing={renameId === s.sessionId}
                        renameValue={renameValue}
                        onRenameValueChange={onRenameValueChange}
                        onOpen={onOpen}
                        onStartRename={onStartRename}
                        onSaveRename={onSaveRename}
                        onCancelRename={onCancelRename}
                      />
                    ))
                  : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

interface ItemProps {
  s: SessionBrief;
  active: boolean;
  editing: boolean;
  renameValue: string;
  onRenameValueChange: (v: string) => void;
  onOpen: (s: SessionBrief) => void;
  onStartRename: (s: SessionBrief) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
}

function SessionItem(props: ItemProps): ReactElement {
  const {
    s, active, editing, renameValue, onRenameValueChange,
    onOpen, onStartRename, onSaveRename, onCancelRename,
  } = props;
  return (
    <div className={`session-item${active ? ' is-active' : ''}${s.archived ? ' is-archived' : ''}`}>
      <button className="session-item-main" type="button" title={s.title} onClick={() => onOpen(s)}>
        <span className="session-item-title">{s.title}</span>
        <span className="session-item-meta">
          {s.running ? <Icon n="loading" spin /> : null}
          {s.cwd ? ` ${s.cwd.split(/[\\/]/).pop()}` : ''}
        </span>
      </button>
      {!editing ? (
        <span className="session-row-actions">
          <button className="row-btn" type="button" title="重命名" onClick={() => onStartRename(s)}>
            <Icon n="pencil" />
          </button>
          {s.archived ? (
            <button
              className="row-btn"
              type="button"
              title="恢复（取消归档）"
              onClick={() => post({ type: 'ui/sessionUnarchive', sessionId: s.sessionId })}
            >
              <Icon n="history" />
            </button>
          ) : (
            <button
              className="row-btn"
              type="button"
              title="归档"
              onClick={() => post({ type: 'ui/sessionArchive', sessionId: s.sessionId })}
            >
              <Icon n="archive" />
            </button>
          )}
        </span>
      ) : null}
      {editing ? (
        <span className="session-rename-row">
          <input
            className="session-rename-input"
            type="text"
            autoFocus
            value={renameValue}
            placeholder="会话标题"
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') onSaveRename();
              else if (e.key === 'Escape') onCancelRename();
            }}
          />
          <button className="row-btn" type="button" title="保存" onClick={onSaveRename}>
            <Icon n="check" />
          </button>
          <button className="row-btn" type="button" title="取消" onClick={onCancelRename}>
            <Icon n="close" />
          </button>
        </span>
      ) : null}
    </div>
  );
}
