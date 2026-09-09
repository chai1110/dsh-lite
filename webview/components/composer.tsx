// webview/components/composer.tsx — M11 三行布局：模式条 + textarea + 工具条。
import type { KeyboardEvent, ReactElement, RefObject } from 'react';

import type { SessionBrief } from '../../src/panel/protocol';
import { Icon } from '../lib/codicon';

interface ComposerProps {
  ready: boolean;
  hasActive: boolean;
  draft: string;
  canSend: boolean;
  running: boolean;
  /** 是否有 active 目标 / 开启创建面板（控制 "目标" chip 显示） */
  hasGoal: boolean;
  /** 当前 active 会话（取 cwd 显示） */
  active: SessionBrief | null;
  /** Enter 行为提示 */
  sendHint: string;
  /** 父级 textarea ref（让工具栏 ＋ 按钮可唤起斜杠目录） */
  inputRef: RefObject<HTMLTextAreaElement>;
  onDraftChange: (next: string) => void;
  /** 清空时同步通知宿主清理斜杠目录 */
  onDraftEmpty: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  onStop: () => void;
  onOpenGoalCreate: () => void;
  /** 点 ＋ 工具按钮时把 draft 设为 '/goal '（已带 / 则不动）并聚焦 */
  onAppendGoalSlash: () => void;
}

export function Composer(props: ComposerProps): ReactElement {
  const {
    ready, hasActive, draft, canSend, running, hasGoal, active, sendHint,
    inputRef, onDraftChange, onDraftEmpty, onKeyDown, onSubmit, onStop,
    onOpenGoalCreate, onAppendGoalSlash,
  } = props;

  return (
    <footer className="composer">
      {/* M11 模式条：左 = 当前会话 cwd 短名；右 = 模式 pill（普通/目标等）。
          视觉对齐 dsh web 的「dsh_data / 标准模式」行；功能性只展示当前状态。 */}
      {ready && hasActive ? (
        <div className="composer-modebar">
          <span className="mode-pill" title={active?.cwd ?? ''}>
            <Icon n="root-folder" />
            <span className="mode-pill-text">
              {active?.cwd ? active.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] : 'workspace'}
            </span>
            <Icon n="chevron-down" />
          </span>
          <span className="mode-pill mode-pill-select" title="当前模式">
            <span className="mode-dot" />
            <span className="mode-pill-text">普通</span>
            <Icon n="chevron-down" />
          </span>
        </div>
      ) : null}

      <textarea
        ref={inputRef}
        className="composer-input"
        rows={3}
        disabled={!ready || !hasActive}
        placeholder={
          !ready
            ? '等待连接…'
            : !hasActive
              ? '先选择或新建一个会话'
              : sendHint
        }
        value={draft}
        onChange={(e) => {
          const next = e.target.value;
          onDraftChange(next);
          // 退出 '/' 编辑态（整段清空）时通知宿主清理目录
          if (next === '') onDraftEmpty();
        }}
        onKeyDown={onKeyDown}
      />

      {/* M11 工具条：左 = + 操作菜单，右 = ↑ 发送 */}
      <div className="composer-toolbar">
        <div className="toolbar-left">
          <button
            className="tool-btn"
            type="button"
            disabled={!ready || !hasActive}
            title="快捷操作（新建目标 / 审批 / 历史）"
            onClick={onAppendGoalSlash}
          >
            <Icon n="add" />
          </button>
          {!hasGoal && ready && hasActive ? (
            <button
              className="tool-chip"
              type="button"
              onClick={onOpenGoalCreate}
              title="设定一个目标（/goal）"
            >
              <Icon n="target" />
              <span>目标</span>
            </button>
          ) : null}
        </div>
        <div className="toolbar-right">
          {running ? (
            <button
              className="send-btn is-stop"
              type="button"
              title="停止生成"
              onClick={onStop}
            >
              <Icon n="debug-stop" />
            </button>
          ) : (
            <button
              className="send-btn btn-primary"
              type="button"
              disabled={!canSend}
              title={canSend ? sendHint : '输入消息后可发送'}
              onClick={onSubmit}
            >
              <Icon n="arrow-up" />
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
