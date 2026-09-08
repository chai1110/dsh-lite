// webview/app.tsx — DSH Lite 面板（M2–M6）：会话下拉 + 消息流 + 输入区 + 命令浮层/审批卡/目标 dock
//
// 设计铁律（docs/03-UI规格.md §零）：极简一页到底，无设置页。顶栏只有 会话▾ / ＋新建 / 连接点。
// UI 只渲染宿主下发的快照；发送/停止/切换/新建/命令/审批/目标都以消息上行，业务全在宿主。
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

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

function commandBadge(m: ViewMessage): { text: string; cls: string } {
  if (m.cmdState !== 'done') return { text: '执行中', cls: 'is-run' };
  return m.cmdOk ? { text: '成功', cls: 'is-ok' } : { text: '失败', cls: 'is-fail' };
}

function MsgRow({ m }: { m: ViewMessage }): ReactElement {
  const [open, setOpen] = useState(false);
  const text = m.streaming ? `${m.text}▍` : m.text;

  // M4 工具条目：call=等宽命令行 / result=可折叠结果；其余按角色着色
  if (m.kind === 'tool') {
    if (m.toolState === 'call') {
      return (
        <div className="msg msg-tool msg-tool-call">
          <span className="tool-cmd">{text || '\u00A0'}</span>
        </div>
      );
    }
    const long = m.text.length > 300;
    return (
      <div className="msg msg-tool msg-tool-result">
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
          <span className="tool-cmd">{m.text}</span>
          <span className={`cmd-badge ${badge.cls}`}>{badge.text}</span>
        </div>
        {m.cmdState === 'done' && m.resultText ? (
          <div className="cmd-result">{m.resultText}</div>
        ) : null}
      </div>
    );
  }

  const cls =
    m.role === 'user' ? 'msg-user' : m.role === 'assistant' ? 'msg-assistant' : 'msg-system';
  return <div className={`msg ${cls}`}>{text || '\u00A0'}</div>;
}

/** 目标相位徽标文本 */
function goalPhaseLabel(phase: string): string {
  switch (phase) {
    case 'active':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'blocked':
      return '受阻';
    case 'complete':
      return '已完成';
    default:
      return phase;
  }
}

export function App(): ReactElement {
  const [state, setState] = useState<PanelState>(initialState());
  const [mismatch, setMismatch] = useState<null | 'reload' | 'upgrade'>(null);
  const [dropdown, setDropdown] = useState(false);
  const [draft, setDraft] = useState('');
  const [slashIdx, setSlashIdx] = useState(0);
  /** 用户 Esc/点选等主动关过浮层 → 本次 '/' 编辑态内不再自动重拉/重开（与「尚未拉取」区分） */
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState('');
  const [goalBusy, setGoalBusy] = useState<'pause' | 'resume' | 'clear' | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
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

  // 协议版本不匹配：整面板提示，不做任何业务
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

  const ready = state.connection === 'ready';
  const active = state.sessions.find((s) => s.sessionId === state.activeSessionId) ?? null;
  const activeTitle = active?.title ?? '会话 ▾';
  const hasMsgs = state.messages.length > 0;

  // —— M6b 斜杠浮层：draft 形如 /name（无空格）时展示；命令目录来自宿主下拉（commands）——
  const slashQuery = draft.match(/^\/([^\s]*)$/)?.[1] ?? null;
  // 具备弹层资格：就绪 + 有活动会话 + 输入形如 '/name'
  const slashEligible = ready && state.activeSessionId !== null && slashQuery !== null;
  // 可见性：宿主已给出命令目录（null=拉取中 / 数组=就绪）；undefined=尚未拉取 → 先不显示；
  // 用户主动关过（slashDismissed）→ 本次编辑态内保持隐藏
  const slashOpen = slashEligible && !slashDismissed && state.commands !== undefined;
  const slashRows = useMemo(() => {
    const rows = state.commands ?? [];
    const q = (slashQuery ?? '').toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => c.name.toLowerCase().includes(q));
  }, [state.commands, slashQuery]);

  // 进入 '/' 编辑态：请求目录（首次 commands===undefined 且未被用户关闭时才上行，避免每键刷）；
  // 退出 '/' 编辑态（slashEligible=false）→ 复位 dismissed，下次 '/' 重新可用
  useEffect(() => {
    if (!slashEligible) {
      if (slashDismissed) setSlashDismissed(false);
      return;
    }
    setSlashIdx(0);
    if (!slashDismissed && state.commands === undefined) {
      post({ type: 'ui/slashQuery', text: draft });
    }
  }, [slashEligible, slashDismissed, state.commands]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeSlash = (): void => {
    setSlashIdx(0);
    setSlashDismissed(true); // 主动关闭：宿主清目录后不会因 commands→undefined 被 effect 重新拉取
    post({ type: 'ui/slashClose' });
  };

  const pickSlash = (i: number): void => {
    const row = slashRows[i];
    if (!row) return;
    if (row.hint !== undefined) {
      // 带自由输入：落到输入框 '/name ' 让用户补参
      setDraft(`/${row.name} `);
      setSlashIdx(0);
      inputRef.current?.focus();
      return;
    }
    // 裸命令：直接执行
    setDraft('');
    closeSlash();
    post({ type: 'ui/promptSubmit', text: `/${row.name}` });
  };

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (slashOpen) closeSlash();
    post({ type: 'ui/promptSubmit', text });
  };

  // —— M6d 目标 dock ——
  const goal = state.goal ?? null;
  useEffect(() => {
    if (goal?.id) setCreateOpen(false);
  }, [goal?.id]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return; // 输入法组合中不拦截
    if (slashOpen && slashRows.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((v) => (v + 1) % slashRows.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((v) => (v - 1 + slashRows.length) % slashRows.length);
        return;
      }
      if (e.key === 'Enter' && e.shiftKey) {
        // Shift+Enter 在浮层中仍走换行（不选命令）
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        pickSlash(slashIdx);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlash();
        return;
      }
    }
    if (e.key === 'Escape') {
      closeSlash();
      return;
    }
    if (e.key !== 'Enter') return;
    const enterMode = state.composerEnterBehavior ?? 'send';
    const sendViaMod = enterMode === 'newline';
    if (sendViaMod && !e.metaKey && !e.ctrlKey) return; // newline 模式：Enter 换行
    if (!sendViaMod && e.shiftKey) return; // send 模式：Shift+Enter 换行
    e.preventDefault();
    submit();
  };

  // 空态文案（docs/design/宿主-UI协议.md §5.2）
  let emptyTitle = '未连接';
  let emptySub: string | undefined;
  let actionLabel: string | null = null;
  if (state.connection === 'connecting') {
    emptyTitle = '连接中…';
    emptySub = '正在探测并启动 dsh';
  } else if (ready) {
    if (state.activeSessionId !== null) {
      emptyTitle = '会话加载中…';
      emptySub = '正在拉取会话记录';
    } else {
      emptyTitle = '没有可显示的会话';
      emptySub = '从顶部下拉选择历史会话，或点 ＋ 新建';
    }
  } else if (state.connection === 'error') {
    emptyTitle = '连接出错';
    emptySub = state.error?.message ?? '未知错误';
    actionLabel = '重连';
  } else if (state.connection === 'offline') {
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
    enterMode === 'send' ? '输入消息，Enter 发送（/ 开头执行命令）' : '输入消息，Enter 换行，⌘/Ctrl+Enter 发送';

  const approval = state.approval ?? null;
  const onAnswer = (outcome: 'allowed-once' | 'rejected'): void => {
    if (!approval || approvalBusy) return;
    setApprovalBusy(true);
    post({ type: 'ui/approvalAnswer', eventId: approval.eventId, outcome });
    // 卡片消失由宿主快照驱动；应答失败宿主会记日志——超时兜底释放按钮，避免卡死
    window.setTimeout(() => setApprovalBusy(false), 1500);
  };

  const onGoalAction = (action: 'pause' | 'resume' | 'clear'): void => {
    if (!goal || goalBusy) return;
    setGoalBusy(action);
    post({ type: 'ui/goalAction', action });
    window.setTimeout(() => setGoalBusy(null), 800);
  };

  const onGoalCreate = (): void => {
    const objective = createDraft.trim();
    if (!objective) return;
    setCreateDraft('');
    setCreateOpen(false);
    post({ type: 'ui/promptSubmit', text: `/goal ${objective}` });
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
          title={state.connection}
          style={{ background: connectionColor(state.connection) }}
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
            {actionLabel && state.connection !== 'connecting' ? (
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
        {/* M6c 审批卡：就绪且当前会话有待批审批时置顶显示 */}
        {ready && approval ? (
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
                disabled={approvalBusy}
                onClick={() => onAnswer('rejected')}
              >
                拒绝
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={approvalBusy}
                onClick={() => onAnswer('allowed-once')}
              >
                允许一次
              </button>
            </div>
          </div>
        ) : null}

        {/* M6d 目标 dock：有 active 会话才显示 */}
        {ready && state.activeSessionId !== null ? (
          <div className="goal-dock">
            {goal ? (
              <>
                <span className="goal-glyph">🎯</span>
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
                      ▶ 继续
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
                      ‖ 暂停
                    </button>
                  ) : null}
                  <button
                    className="btn goal-btn"
                    type="button"
                    disabled={goalBusy !== null}
                    onClick={() => onGoalAction('clear')}
                    title="清除目标"
                  >
                    ✕
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
                  onChange={(e) => setCreateDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onGoalCreate();
                    } else if (e.key === 'Escape') {
                      setCreateOpen(false);
                      setCreateDraft('');
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
                    setCreateOpen(false);
                    setCreateDraft('');
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <>
                <span className="goal-glyph">🎯</span>
                <span className="goal-obj goal-obj-empty">无目标</span>
                <button
                  className="btn goal-btn"
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  title="新建目标（等价 /goal）"
                >
                  ＋ 目标
                </button>
              </>
            )}
          </div>
        ) : null}

        {/* M6b 斜杠命令浮层 */}
        {slashOpen ? (
          <div className="slash-popup">
            {state.commandsError ? (
              <div className="slash-status is-error">
                <span>{state.commandsError}</span>
                <button
                  className="btn"
                  type="button"
                  onClick={() => post({ type: 'ui/slashQuery', text: draft })}
                >
                  重试
                </button>
              </div>
            ) : state.commands === null ? (
              <div className="slash-status">正在加载命令…</div>
            ) : slashRows.length === 0 ? (
              <div className="slash-status">无匹配命令</div>
            ) : (
              <div className="slash-list" role="listbox">
                {slashRows.map((c, i) => (
                  <div
                    key={c.name}
                    role="option"
                    aria-selected={i === slashIdx}
                    className={`slash-row${i === slashIdx ? ' is-active' : ''}`}
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => pickSlash(i)}
                  >
                    <span className="slash-name">/{c.name}</span>
                    <span className="slash-desc" title={c.description}>
                      {c.description ?? ''}
                    </span>
                    {c.hint !== undefined ? <span className="slash-hint">可带参</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

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
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            // 退出 '/' 编辑态（整段清空）时通知宿主清理目录
            if (next === '') closeSlash();
          }}
          onKeyDown={onKeyDown}
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
