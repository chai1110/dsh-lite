// webview/app.tsx — 面板根组件：状态管理 + 消息路由 + 把状态分发给子组件。
//
// 设计铁律（docs/03-UI规格.md §零）：极简一页到底，无设置页。UI 只渲染宿主下发的快照；
// 发送/停止/切换/新建/命令/审批/目标都以消息上行，业务全在宿主。
//
// 子组件拆分见 webview/components/；纯工具见 webview/lib/。
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import {
  initialState,
  isProtocolCompatible,
  mismatchHint,
  PROTOCOL_VERSION,
  type HostMessage,
  type PanelState,
  type SessionBrief,
} from '../src/panel/protocol';

import { ApprovalCard } from './components/approval-card';
import { Composer } from './components/composer';
import { EmptyState, type EmptyAction } from './components/empty-state';
import { GoalDock } from './components/goal-dock';
import { HistoryDropdown } from './components/history-dropdown';
import { Messages } from './components/messages';
import { SlashOverlay } from './components/slash-overlay';
import { Topbar } from './components/topbar';
import { post } from './lib/post';
import { timeBucket } from './lib/util';

export function App(): ReactElement {
  // ===== 1. 状态 =====
  const [state, setState] = useState<PanelState>(initialState());
  const [mismatch, setMismatch] = useState<null | 'reload' | 'upgrade'>(null);
  const [dropdown, setDropdown] = useState(false);
  /** M7：下拉中正在改名的会话 id + 编辑值；已归档区是否展开 */
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  /** M9：历史弹层搜索词（按标题 / 目录过滤，对齐 Codex/CC 历史面板） */
  const [historyQuery, setHistoryQuery] = useState('');
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

  // ===== 2. 宿主消息订阅 =====
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

  // ===== 3. 派生数据 =====
  const ready = state.connection === 'ready';
  const active = state.sessions.find((s) => s.sessionId === state.activeSessionId) ?? null;
  const activeTitle = active?.title ?? '会话 ▾';
  const hasMsgs = state.messages.length > 0;
  const approval = state.approval ?? null;
  const goal = state.goal ?? null;

  // M6b 斜杠浮层相关
  const slashQuery = draft.match(/^\/([^\s]*)$/)?.[1] ?? null;
  const slashEligible = ready && state.activeSessionId !== null && slashQuery !== null;
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

  // 进入目标时收起创建面板
  useEffect(() => {
    if (goal?.id) setCreateOpen(false);
  }, [goal?.id]);

  // running：会话列表中 active 的 running 或消息尾部仍在流式
  const running =
    Boolean(active?.running) ||
    [...state.messages].reverse().find((m) => m.role === 'user' || m.role === 'assistant')
      ?.streaming === true;
  const canSend = ready && state.activeSessionId !== null && draft.trim().length > 0;
  const enterMode = state.composerEnterBehavior ?? 'send';
  const sendHint =
    enterMode === 'send' ? '输入消息，Enter 发送（/ 开头执行命令）' : '输入消息，Enter 换行，⌘/Ctrl+Enter 发送';

  // 空态数据
  const { title: emptyTitle, sub: emptySub, actions: emptyActions } = useMemo(
    () => buildEmptyState(state),
    [state],
  );

  // 历史下拉数据：搜索 + 时间分组
  const q = historyQuery.trim().toLowerCase();
  const shownSessions = state.sessions.filter(
    (s) =>
      !q ||
      s.title.toLowerCase().includes(q) ||
      (s.cwd ?? '').toLowerCase().includes(q),
  );
  const byRecent = (a: SessionBrief, b: SessionBrief): number => b.updatedAt - a.updatedAt;
  const archivedSessions = shownSessions.filter((s) => s.archived).sort(byRecent);
  const activeSessions = shownSessions.filter((s) => !s.archived).sort(byRecent);
  const groups: Array<{ label: string; rows: SessionBrief[] }> = useMemo(() => {
    const map = new Map<string, SessionBrief[]>();
    for (const s of activeSessions) {
      const k = timeBucket(s.updatedAt);
      const arr = map.get(k);
      if (arr) arr.push(s);
      else map.set(k, [s]);
    }
    const order = ['今天', '昨天', '最近 7 天', '更早'];
    return order.filter((k) => map.has(k)).map((k) => ({ label: k, rows: map.get(k)! }));
  }, [activeSessions]);

  // ===== 4. 回调 =====
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
    const sendViaMod = enterMode === 'newline';
    if (sendViaMod && !e.metaKey && !e.ctrlKey) return; // newline 模式：Enter 换行
    if (!sendViaMod && e.shiftKey) return; // send 模式：Shift+Enter 换行
    e.preventDefault();
    submit();
  };

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

  const openSession = (s: SessionBrief): void => {
    setDropdown(false);
    // 打开已归档会话 = 先恢复再选中（与官方一致：归档只是收进隐藏区）
    if (s.archived) post({ type: 'ui/sessionUnarchive', sessionId: s.sessionId });
    post({ type: 'ui/selectSession', sessionId: s.sessionId });
  };

  const startRename = (s: SessionBrief): void => {
    setRenameId(s.sessionId);
    setRenameValue(s.title);
  };

  const saveRename = (): void => {
    const sid = renameId;
    const title = renameValue.trim();
    setRenameId(null);
    setRenameValue('');
    if (sid && title) post({ type: 'ui/sessionRename', sessionId: sid, title });
  };

  const cancelRename = (): void => {
    setRenameId(null);
    setRenameValue('');
  };

  // 点 ＋ 工具按钮 → 写入 /goal 唤起斜杠目录
  const onAppendGoalSlash = (): void => {
    setDraft((d) => (d.startsWith('/') ? d : '/goal '));
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // ===== 5. 渲染 =====
  return (
    <div className="app">
      <Topbar
        ready={ready}
        activeTitle={activeTitle}
        connection={state.connection}
        onToggleDropdown={() => setDropdown((v) => !v)}
        onNewSession={() => post({ type: 'ui/newSession' })}
      />

      {dropdown && ready ? (
        <HistoryDropdown
          query={historyQuery}
          onQueryChange={setHistoryQuery}
          groups={groups}
          archived={archivedSessions}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          activeSessionId={state.activeSessionId}
          onOpen={openSession}
          onStartRename={startRename}
          onSaveRename={saveRename}
          onCancelRename={cancelRename}
          renameId={renameId}
          renameValue={renameValue}
          onRenameValueChange={setRenameValue}
          onClose={() => setDropdown(false)}
        />
      ) : null}

      <main className="messages" ref={scrollRef}>
        {!hasMsgs ? (
          <EmptyState
            connection={state.connection}
            title={emptyTitle}
            sub={emptySub}
            actions={emptyActions}
          />
        ) : (
          <Messages messages={state.messages} />
        )}
      </main>

      <Composer
        ready={ready}
        hasActive={state.activeSessionId !== null}
        draft={draft}
        canSend={canSend}
        running={running}
        hasGoal={goal !== null}
        active={active}
        sendHint={sendHint}
        inputRef={inputRef}
        onDraftChange={setDraft}
        onDraftEmpty={closeSlash}
        onKeyDown={onKeyDown}
        onSubmit={submit}
        onStop={() => post({ type: 'ui/stop' })}
        onOpenGoalCreate={() => setCreateOpen(true)}
        onAppendGoalSlash={onAppendGoalSlash}
      />

      {/* M6c 审批卡：就绪且当前会话有待批审批时置顶显示 */}
      {ready && approval ? (
        <ApprovalCard approval={approval} busy={approvalBusy} onAnswer={onAnswer} />
      ) : null}

      {/* M6d 目标 dock：有 active 会话 + 已有目标 或 正在创建时才显示（避免无目标时也占空白） */}
      {ready && state.activeSessionId !== null && (goal || createOpen) ? (
        <GoalDock
          goal={goal}
          createOpen={createOpen}
          createDraft={createDraft}
          goalBusy={goalBusy}
          onSetCreateOpen={setCreateOpen}
          onCreateDraftChange={setCreateDraft}
          onGoalAction={onGoalAction}
          onGoalCreate={onGoalCreate}
        />
      ) : null}

      {/* M6b 斜杠命令浮层（绝对定位，由 CSS 覆盖 composer 上方） */}
      <SlashOverlay
        open={slashOpen}
        rows={slashRows}
        activeIdx={slashIdx}
        loading={state.commands === null && !state.commandsError}
        errorMessage={state.commandsError ?? null}
        draft={draft}
        onHover={setSlashIdx}
        onPick={pickSlash}
      />
    </div>
  );
}

/** 根据连接/活动会话/错误派生空态标题/副标题/动作。 */
function buildEmptyState(state: PanelState): {
  title: string;
  sub?: string;
  actions: EmptyAction[];
} {
  let title = '未连接';
  let sub: string | undefined;
  const actions: EmptyAction[] = [];
  if (state.connection === 'connecting') {
    title = '正在连接…';
    sub = '正在探测并启动 dsh';
  } else if (state.connection === 'ready') {
    if (state.activeSessionId !== null) {
      title = '会话加载中…';
      sub = '正在拉取会话记录';
    } else {
      title = '探索未至之境';
      sub =
        state.sessions.length > 0
          ? '从顶部 ▾ 选择一个历史会话继续，或点下方「新建会话」开始'
          : '点下方「新建会话」开始，/ 开头可执行命令，/goal 可设目标';
      actions.push({
        label: '新建会话',
        onClick: () => post({ type: 'ui/newSession' }),
        primary: true,
        title: '新建一个空会话',
      });
    }
  } else if (state.connection === 'error') {
    title = '连接出错';
    sub = state.error?.message ?? '未知错误';
    actions.push({ label: '重连', onClick: () => post({ type: 'ui/refresh' }), primary: true });
  } else if (state.connection === 'offline') {
    title = '已断开';
    sub = state.error?.message ?? '点击重连重新拉起 dsh';
    actions.push({ label: '重连', onClick: () => post({ type: 'ui/refresh' }), primary: true });
  } else {
    sub = '点击启动开始连接';
    actions.push({ label: '启动', onClick: () => post({ type: 'ui/refresh' }), primary: true });
  }
  return { title, sub, actions };
}
