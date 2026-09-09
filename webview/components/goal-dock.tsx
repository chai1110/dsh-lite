// webview/components/goal-dock.tsx — M6d 目标 dock（显示当前目标 + 暂停/继续/清除；或创建新目标）。
import type { ReactElement } from 'react';

import type { GoalBrief } from '../../src/panel/protocol';
import { Icon } from '../lib/codicon';
import { goalPhaseLabel } from '../lib/util';

interface GoalDockProps {
  goal: GoalBrief | null;
  createOpen: boolean;
  createDraft: string;
  goalBusy: 'pause' | 'resume' | 'clear' | null;
  onSetCreateOpen: (open: boolean) => void;
  onCreateDraftChange: (v: string) => void;
  onGoalAction: (action: 'pause' | 'resume' | 'clear') => void;
  onGoalCreate: () => void;
}

export function GoalDock(props: GoalDockProps): ReactElement {
  const {
    goal, createOpen, createDraft, goalBusy,
    onSetCreateOpen, onCreateDraftChange, onGoalAction, onGoalCreate,
  } = props;
  return (
    <div className="goal-dock">
      {goal ? (
        <>
          <span className="goal-glyph">
            <Icon n="target" />
          </span>
          <span className="goal-chip">{goalPhaseLabel(goal.phase)}</span>
          <span className="goal-obj" title={goal.objective}>
            {goal.objective}
          </span>
          <span className="goal-actions">
            {goal.phase === 'paused' ? (
              <button
                className="btn goal-btn"
                type="button"
                disabled={goalBusy !== null}
                onClick={() => onGoalAction('resume')}
                title="继续目标"
              >
                <Icon n="debug-continue" />
                <span>继续</span>
              </button>
            ) : null}
            {goal.phase === 'active' ? (
              <button
                className="btn goal-btn"
                type="button"
                disabled={goalBusy !== null}
                onClick={() => onGoalAction('pause')}
                title="暂停目标"
              >
                <Icon n="debug-pause" />
                <span>暂停</span>
              </button>
            ) : null}
            <button
              className="btn goal-btn goal-btn-icon"
              type="button"
              disabled={goalBusy !== null}
              onClick={() => onGoalAction('clear')}
              title="清除目标"
            >
              <Icon n="close" />
            </button>
          </span>
        </>
      ) : createOpen ? (
        <>
          <input
            className="goal-create-input"
            type="text"
            autoFocus
            placeholder="目标描述，Enter 创建（/goal）"
            value={createDraft}
            onChange={(e) => onCreateDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                onGoalCreate();
              } else if (e.key === 'Escape') {
                onSetCreateOpen(false);
                onCreateDraftChange('');
              }
            }}
          />
          <button
            className="btn goal-btn"
            type="button"
            disabled={!createDraft.trim()}
            onClick={onGoalCreate}
          >
            创建
          </button>
          <button
            className="btn goal-btn"
            type="button"
            onClick={() => {
              onSetCreateOpen(false);
              onCreateDraftChange('');
            }}
          >
            取消
          </button>
        </>
      ) : null}
    </div>
  );
}
