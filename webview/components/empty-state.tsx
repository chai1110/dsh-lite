// webview/components/empty-state.tsx — 空态大插画（M11 对齐 dsh web「探索未至之境」观感）。
import type { ReactElement } from 'react';

import { Icon } from '../lib/codicon';

export interface EmptyAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}

interface EmptyStateProps {
  connection: string;
  title: string;
  sub?: string;
  actions: EmptyAction[];
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  const { connection, title, sub, actions } = props;
  return (
    <div className="empty">
      <div className="empty-illu" aria-hidden="true">
        <span className="empty-illu-main">
          <Icon n="rocket" />
        </span>
        <span className="empty-illu-spark">
          <Icon n="sparkle" />
        </span>
      </div>
      <div className="empty-title">{title}</div>
      {sub ? <div className="empty-sub">{sub}</div> : null}
      {actions.length > 0 ? (
        <div className="empty-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              className={`btn empty-action${a.primary ? ' btn-primary' : ''}`}
              type="button"
              title={a.title ?? a.label}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
      {actions.length === 0 && connection === 'connecting' ? (
        <div className="empty-spinner" aria-label="连接中">
          <Icon n="loading" spin />
        </div>
      ) : null}
    </div>
  );
}
