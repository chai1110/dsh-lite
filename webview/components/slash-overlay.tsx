// webview/components/slash-overlay.tsx — M6b 斜杠命令浮层。
import type { ReactElement } from 'react';

import type { CommandRow } from '../../src/panel/protocol';
import { Icon } from '../lib/codicon';
import { post } from '../lib/post';

interface SlashOverlayProps {
  open: boolean;
  rows: CommandRow[];
  activeIdx: number;
  /** 加载/失败状态 */
  loading: boolean;
  errorMessage: string | null;
  /** 当前 draft（用于错误时点重试） */
  draft: string;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}

export function SlashOverlay(props: SlashOverlayProps): ReactElement {
  const { open, rows, activeIdx, loading, errorMessage, draft, onHover, onPick } = props;
  if (!open) return <></>;
  return (
    <div className="slash-popup">
      {errorMessage ? (
        <div className="slash-status is-error">
          <span>{errorMessage}</span>
          <button className="btn" type="button" onClick={() => post({ type: 'ui/slashQuery', text: draft })}>
            重试
          </button>
        </div>
      ) : loading ? (
        <div className="slash-status">正在加载命令…</div>
      ) : rows.length === 0 ? (
        <div className="slash-status">无匹配命令</div>
      ) : (
        <div className="slash-list" role="listbox">
          {rows.map((c, i) => (
            <div
              key={c.name}
              role="option"
              aria-selected={i === activeIdx}
              className={`slash-row${i === activeIdx ? ' is-active' : ''}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(i)}
            >
              <span className="slash-name">
                <Icon n="terminal-bash" />
                <span>/{c.name}</span>
              </span>
              <span className="slash-desc" title={c.description}>
                {c.description ?? ''}
              </span>
              {c.hint !== undefined ? <span className="slash-hint">可带参</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
