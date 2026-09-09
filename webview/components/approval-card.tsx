// webview/components/approval-card.tsx — M6c 工具审批卡（出现在 composer 上方）。
import type { ReactElement } from 'react';

import type { ApprovalView } from '../../src/panel/protocol';

interface ApprovalCardProps {
  approval: ApprovalView;
  busy: boolean;
  onAnswer: (outcome: 'allowed-once' | 'rejected') => void;
}

export function ApprovalCard({ approval, busy, onAnswer }: ApprovalCardProps): ReactElement {
  return (
    <div className="approval-card" role="alert">
      <div className="approval-strip">
        <span className="approval-dot" />
        <span className="approval-title">工具 {approval.toolName} 请求执行</span>
      </div>
      {approval.reason ? <div className="approval-reason">{approval.reason}</div> : null}
      <div className="approval-actions">
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => onAnswer('rejected')}
        >
          拒绝
        </button>
        <button
          className="btn btn-primary"
          type="button"
          disabled={busy}
          onClick={() => onAnswer('allowed-once')}
        >
          允许一次
        </button>
      </div>
    </div>
  );
}
