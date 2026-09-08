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
  type SessionBrief,
  type UiMessage,
  type ViewMessage,
} from '../src/panel/protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();

function post(msg: UiMessage): void {
  vscode.postMessage(msg);
}

/** M9b：宿主注入的品牌 logo URL（assets/icon.svg）；扩展未携带图标时为 undefined（UI 回退 codicon） */
const brandLogo: string | undefined = (window as { DSH_LOGO?: string }).DSH_LOGO;

/** M9：codicon 图标（字体由 provider 注入 assets/codicons；缺失时自动退化为空，功能不依赖图标） */
function Icon({ n, spin }: { n: string; spin?: boolean }): ReactElement {
  return <span className={`codicon codicon-${n}${spin ? ' is-spin' : ''}`} aria-hidden="true" />;
}

/** 消息/会话文本复制（hover 行操作用） */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** M9：按 updatedAt 分桶（对齐 Codex/CC 历史面板的时间分组语） */
function timeBucket(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const day = 86400000;
  const diff = startOfDay(now) - startOfDay(d);
  if (diff < 0) return '今天';
  if (diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return '最近 7 天';
  return '更早';
}

/** 角色图标（消息流左侧标识，对齐 Codex/CC 的「角色符号」观感） */
function roleIcon(role: string): string {
  if (role === 'user') return 'account';
  if (role === 'assistant') return 'sparkle';
  return 'info';
}

function roleTitle(role: string): string {
  if (role === 'user') return '你';
  if (role === 'assistant') return '助手';
  return '系统';
}

function commandBadge(m: ViewMessage): { text: string; cls: string } {
  if (m.cmdState !== 'done') return { text: '执行中', cls: 'is-run' };
  return m.cmdOk ? { text: '成功', cls: 'is-ok' } : { text: '失败', cls: 'is-fail' };
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

function MsgRow({ m }: { m: ViewMessage }): ReactElement {
  const [open, setOpen] = useState(false);
  const text = m.streaming ? `${m.text}▍` : m.text;

  // M4 工具条目：call=等宽命令行（带终端图标）/ result=可折叠结果（带复制）
  if (m.kind === 'tool') {
    if (m.toolState === 'call') {
      return (
        <div className="msg msg-tool msg-tool-call">
          <Icon n="terminal" />
          <span className="tool-cmd">{text || '\u00A0'}</span>
        </div>
      );
    }
    const long = m.text.length > 300;
    return (
      <div className="msg msg-tool msg-tool-result">
        <div className="tool-result-head">
          <Icon n="output" />
          <span className="tool-result-label">工具结果</span>
          <span className="msg-actions">
            <button
              className="row-btn"
              type="button"
              title="复制结果"
              onClick={() => copyText(m.text)}
            >
              <Icon n="copy" />
            </button>
          </span>
        </div>
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
          <Icon n="terminal-bash" />
          <span className="tool-cmd">{m.text}</span>
          <span className={`cmd-badge ${badge.cls}`}>{badge.text}</span>
          {m.cmdState === 'done' && m.resultText ? (
            <span className="msg-actions">
              <button
                className="row-btn"
                type="button"
                title="复制命令结果"
                onClick={() => copyText(m.resultText ?? '')}
              >
                <Icon n="copy" />
              </button>
            </span>
          ) : null}
        </div>
        {m.cmdState === 'done' && m.resultText ? (
          <div className="cmd-result">{m.resultText}</div>
        ) : null}
      </div>
    );
  }

  // M10 左右分栏：assistant=AI 回复在左（角色标+文本）；user=我们发送在右（角色标+气泡）。
  // system=整行居中弱化。复制钮 hover 浮现（右侧悬浮，不占布局）。
  const hasCopy = m.text.length > 0;
  const isSystem = m.role === 'system';
  return (
    <div className={`msg msg-${m.role}`}>
      {!isSystem ? (
        <span className={`msg-role-icon role-${m.role}`} title={roleTitle(m.role)}>
          <Icon n={roleIcon(m.role)} />
        </span>
      ) : null}
      <div className="msg-body">{text || '\u00A0'}</div>
      {!isSystem && hasCopy ? (
        <span className="msg-actions">
          <button
            className="row-btn"
            type="button"
            title="复制消息"
            onClick={() => copyText(m.text)}
          >
            <Icon n="copy" />
          </button>
        </span>
      ) : null}
    </div>
  );
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

  // —— M7/M9 会话管理：搜索 + 时间分组 + 归档折叠 ——
  const q = historyQuery.trim().toLowerCase();
  const matchSession = (s: SessionBrief): boolean =>
    !q || s.title.toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q);
  const shownSessions = state.sessions.filter(matchSession);
  // 组内按 updatedAt 倒序（历史面板习惯：最近的在上）
  const byRecent = (a: SessionBrief, b: SessionBrief): number => b.updatedAt - a.updatedAt;
  const archivedSessions = shownSessions.filter((s) => s.archived).sort(byRecent);
  const activeSessions = shownSessions.filter((s) => !s.archived).sort(byRecent);

  /** M9：未归档会话按时间桶分组（今天/昨天/最近 7 天/更早），组间保序 */
  const groups: Array<[string, SessionBrief[]]> = useMemo(() => {
    const map = new Map<string, SessionBrief[]>();
    for (const s of activeSessions) {
      const k = timeBucket(s.updatedAt);
      const arr = map.get(k);
      if (arr) arr.push(s);
      else map.set(k, [s]);
    }
    const order = ['今天', '昨天', '最近 7 天', '更早'];
    return order.filter((k) => map.has(k)).map((k) => [k, map.get(k)!]);
  }, [activeSessions]);

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

  const renderSessionItem = (s: SessionBrief): ReactElement => {
    const editing = renameId === s.sessionId;
    return (
      <div
        key={s.sessionId}
        className={`session-item${s.sessionId === state.activeSessionId ? ' is-active' : ''}${
          s.archived ? ' is-archived' : ''
        }`}
      >
        <button className="session-item-main" type="button" title={s.title} onClick={() => openSession(s)}>
          <span className="session-item-title">{s.title}</span>
          <span className="session-item-meta">
            {s.running ? <Icon n="loading" spin /> : null}
            {s.cwd ? ` ${s.cwd.split(/[\\/]/).pop()}` : ''}
          </span>
        </button>
        {!editing ? (
          <span className="session-row-actions">
            <button
              className="row-btn"
              type="button"
              title="重命名"
              onClick={() => startRename(s)}
            >
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
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') saveRename();
                else if (e.key === 'Escape') {
                  setRenameId(null);
                  setRenameValue('');
                }
              }}
            />
            <button className="row-btn" type="button" title="保存" onClick={saveRename}>
              <Icon n="check" />
            </button>
            <button
              className="row-btn"
              type="button"
              title="取消"
              onClick={() => {
                setRenameId(null);
                setRenameValue('');
              }}
            >
              <Icon n="close" />
            </button>
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="btn session-btn"
            type="button"
            disabled={!ready}
            title={ready ? '点开查看全部历史会话 / 切换会话' : '等待连接…'}
            onClick={() => setDropdown((v) => !v)}
          >
            {brandLogo ? (
              <img className="brand-logo" src={brandLogo} alt="DSH Lite" />
            ) : (
              <span className="brand-mark">
                <Icon n="comment-discussion" />
              </span>
            )}
            <span className="session-btn-title">{ready ? activeTitle : 'DSH Lite'}</span>
            {ready ? <Icon n="chevron-down" /> : null}
          </button>
        </div>
        <div className="topbar-right">
          <span
            className="conn-dot"
            title={`连接：${state.connection}`}
            style={{ background: connectionColor(state.connection) }}
          />
          <button
            className="btn btn-icon btn-new"
            type="button"
            disabled={!ready}
            title="新建会话"
            onClick={() => post({ type: 'ui/newSession' })}
          >
            <Icon n="add" />
          </button>
        </div>
      </header>

      {dropdown && ready ? (
        <>
          <div className="dropdown-backdrop" onClick={() => setDropdown(false)} />
          <div className="session-list">
            <div className="history-search">
              <Icon n="search" />
              <input
                className="history-search-input"
                type="text"
                autoFocus
                placeholder="搜索历史会话…"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Escape') setDropdown(false);
                }}
              />
            </div>
            {shownSessions.length === 0 ? (
              <div className="session-empty">{q ? '无匹配会话' : '暂无会话'}</div>
            ) : (
              <>
                {groups.map(([label, rows]) => (
                  <div className="history-group" key={label}>
                    <div className="history-group-title">{label}</div>
                    {rows.map((s) => renderSessionItem(s))}
                  </div>
                ))}
                {archivedSessions.length > 0 ? (
                  <>
                    <button
                      className="archived-toggle"
                      type="button"
                      onClick={() => setShowArchived((v) => !v)}
                    >
                      <Icon n="archive" />
                      <span>已归档（{archivedSessions.length}）</span>
                      <Icon n={showArchived ? 'chevron-down' : 'chevron-right'} />
                    </button>
                    {showArchived ? archivedSessions.map((s) => renderSessionItem(s)) : null}
                  </>
                ) : null}
              </>
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
                <span className="goal-glyph">
                  <Icon n="target" />
                </span>
                <span className="goal-obj goal-obj-empty">无目标</span>
                <button
                  className="btn goal-btn"
                  type="button"
                  onClick={() => setCreateOpen(true)}
                  title="新建目标（等价 /goal）"
                >
                  <Icon n="add" />
                  <span>目标</span>
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
              className="send-btn is-stop"
              type="button"
              title="停止生成"
              onClick={() => post({ type: 'ui/stop' })}
            >
              <Icon n="debug-stop" />
            </button>
          ) : (
            <button
              className="send-btn btn-primary"
              type="button"
              disabled={!canSend}
              title={canSend ? sendHint : '输入消息后可发送'}
              onClick={submit}
            >
              <Icon n="arrow-up" />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
