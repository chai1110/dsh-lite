# 更新日志

所有 notable 变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
本插件采用里程碑（M0/M1/…）驱动的版本节奏。

## 未发布

### M15 全量代码核查与缺陷修复（19 项）
- 起因：对全项目做一次彻底走查（42 文件 / 5,162 行），所有判定均以实证脚本验证而非静态推断。
  报告见 `docs/audit/2026-09-09-代码核查报告.md`。
- **错误透明度（最影响排障）**
  - **F**：`unary()` 原先抛裸对象 `{kind,status,body}`，导致全部 `catch { String(err) }` 记出
    `[object Object]`——401 的「reopen the URL printed by dsh web」恰在 body 里，每次排障都在盲飞。
    改为 `RpcHttpError extends Error`，`message` 含 status 与前 300 字 body。
- **启动/停止生命周期**
  - **K**：端口探测最坏 50×3000ms=150s，远超 15s 启动超时（10 倍）。新增单次探测 400ms +
    整体预算 8000ms，`findFreePort` 超预算即返回 null。
  - **H**：端口回退曾写回 `this.opts`，造成配置永久漂移（用户改设置不生效，须重载扩展）。
    改为经 `doStart(rounds, preferredPort)` 参数传递，不再触碰 opts。
  - **I**：`for(;;)` 等待循环不检查 `disposed`，停用扩展后仍空转到 deadline 并可能重启子进程。
  - **J**：旧轮次 child 的延迟 `error` 事件会污染新进程状态，加 `this.child !== child` 守卫。
  - **O**：`migration.ts` 的 `readdirSync` 无 try/catch（上方 `existsSync` 有守卫），
    权限异常会让整个 `activate()` 失败；已加守卫，并在 `extension.ts` 对迁移调用兜底。
- **UI 正确性**
  - **T**：`MsgRow` 的 `useState` 位于三个 early return 之后（Hooks 规则违规）
    ——当前因 key=`s${seq}` 且 kind 不可变而恰好不触发，但属定时炸弹。hook 提到函数首行。
  - **U**：`App` 的 `if (mismatch)` 早退绕过其后的 5 个 hook（2×useMemo + 2×useEffect），
    一旦触发协议不匹配即白屏（18→13 hooks）。早退下移到所有 hook 之后。
  - **M**：空白标题（`"   "` 是真值）不走 fallback，历史下拉出现无法辨识的空白行；改为 `trim()` 兜底。
- **资源与健壮性**
  - **B/C**：mux `close()` 未置空 socket（旧 socket 延迟 close 会改错新连接状态）→ 置 null + 事件守卫；
    `streamId` 由 8 位截断（32bit，碰撞即串帧）改为全量 UUID。
  - **D**：`$events` 应答 Promise 无超时，服务端静默时永久悬挂 → 加 8s 兜底。
  - **Q**：配置改动原先既不生效也无提示 → 注册 `onDidChangeConfiguration`，连接相关键提示重载窗口
    （可一键执行），其它键立即重发状态。
  - **R/S**：迁移的 SQL 拼接加 `ALLOWED_KEYS` 白名单校验；CSP 去掉 `style-src 'unsafe-inline'`
    （唯一内联 style 改为 class），`fullCss` 的 `<style>` 补 nonce。
  - **G/P**：删除死字段 `owned`、死函数 `needsMigration`、死状态 `'closing'`。
  - **噪音**：`goal/change` 不再落「目标已更新」状态行（目标周期内高频推送，会把消息流刷成墙），
    仅折叠进 goal dock 投影；`textOf` 支持嵌套块（`chunk={type:'text',text}`）不再退化为 JSON。
- **测试基建（本次新增，此前 webview 侧零测试）**
  - `test/hooks-order.test.ts`：静态守护 hooks 顺序 + 禁止内联 style。
  - `test/webview-render.test.tsx`：jsdom + react-dom 18 真实客户端渲染（各 kind、折叠、流式、增删）。
  - `test/unary.test.ts`：守护错误形态可读。
  - `scripts/build.mjs` 支持 `.test.tsx`；`.vscodeignore` 排除 `out/test/**`（vsix 由 463 条目降到 18）。
  - **测试有效性已自证**：临时把 F/T 缺陷改回，对应测试立即失败。
- 验证：typecheck 通过；单测 **100 tests / 97 pass / 0 fail / 3 skipped**；
  E2E 真实 dsh 三次 boot **3/3**；`dsh-lite.vsix` 434.98 KB。

### M14 代码规整：分层清晰、职责单一（不改变行为）
- 目的：让模块边界一眼能看清，排查问题时知道该翻哪个文件。
- **src/ 重组**：
  - 新增 `src/log.ts`（共享 Logger，包装 OutputChannel，支持 `child('xxx')` 嵌套）
  - `src/panel/` 按职责拆分（之前 352 行的 provider.ts 拆成 6 个）：
    - `panel/provider.ts`（只负责 webview 句柄+消息分发+广播）
    - `panel/state.ts`（`buildPanelState` 快照合成，独立可单测）
    - `panel/html.ts`（`getHtml` HTML 模板）
    - `panel/commands.ts`（命令注册 + 共享 `openChatRight`）
    - `panel/migration.ts`（一次性视图位置迁移）
    - `panel/index.ts`（公开 API 入口，extension.ts 只从这里 import）
  - `src/extension.ts` 瘦身：156 行 → 110 行（纯装配 6 步：日志→迁移→provider→连接/服务→openOnStartup→命令）
- **webview/ 拆分**（之前 960 行的 app.tsx 拆成 10 个文件）：
  - `webview/app.tsx`（状态机 + 消息路由 + JSX 拼装，440 行）
  - `webview/components/` 7 个组件：topbar / history-dropdown / empty-state / messages / approval-card / goal-dock / slash-overlay / composer
  - `webview/lib/` 纯函数工具：post（上行通信）/ util（timeBucket 等）/ codicon（图标组件）
- **文档**：
  - `docs/architecture.md`（分层图 + 数据流 + 「单一来源」原则）
  - `docs/folder-map.md`（每文件职责 + 改动前看哪里 + 典型问题排查路径）
- 验证：typecheck 通过；单测 86 过 / 0 失败 / 3 跳过（与重构前完全一致）；vsix 409.55KB；M13/M13.1 行为零变化。

### M13.1 修复：点右上角却出现在左侧 Explorer —— 视图位置持久化污染
- 现象：openChat 打开后对话在左侧文件树下面；右侧副侧栏容器条无 DSH Lite 图标（默认 Chat /
  Claude Code / Codex / 0.5.1 都在右边）。
- 根因：workspaceStorage 的 `workbench.explorer.views.state` 把旧视图 id
  `dshLite.panel` / `dshLite.panel.secondary` 记成了 **Explorer 容器的成员**——M8~M12 早期对
  “未展开的右侧视图”直接 `.focus()` 时，VS Code 把视图挪进当时可见的左侧 Explorer 并持久化，
  此后无论命令怎么改都按记忆渲染在 Explorer。
- 修复：容器/视图 ID 全换新（容器 `dshLitePanel` + `dshLitePanelRight`，视图
  `dshLite.view.left` / `dshLite.view.right`，整页标签 `dshLite.chat.full`），抹掉全部陈旧
  位置记录，按 manifest 声明位置全新注册（右容器 = secondarySidebar）。ID 见 src/panel/provider.ts
  与 package.json。
- 对照实证：0.5.1 `openSecondary()` = 直接 `dsh.panel.secondary.focus`（成功即返回），旧版回退
  `workbench.action.focusSecondarySideBar` + 左视图 focus；Codex 现行两步法与本扩展一致。
- 用户侧（可选）：若老窗口仍有残留，命令面板执行 `View: Reset View Locations`。

### M13 整页对话 + 开机开右栏 + 布局机制梳理（与 Codex/CC 位置机制对齐收口）
- **入口决策落地**：① 保留双入口（左侧 activitybar 容器 + 右侧 secondarySidebar 容器，两边都可开，
  与 Codex/CC 一致）；② `openOnStartup` 改为「开机即右侧」——由原来只 `focus` 左侧视图改为
  共享 `openChatRight()`（M12 两步法：先 `workbench.view.extension.dshLiteSecondary` 展开右侧容器、
  再 `dshLite.panel.secondary.focus`），旧版 VS Code（<1.106）自动回退左侧容器；③ 新增**整页对话**；
  ④ 右栏宽度由用户拖拽记忆，不做处理（与 Codex 行为一致）。
- **整页对话（Chat Editor 形态）**：新命令 `dshLite.openChatFull`（命令面板可搜）→
  `DshLitePanelProvider.openFullPage()` 以 `WebviewPanel` 在编辑区开「DSH Lite」整页标签，
  iconPath 用 light/dark 配对；单实例，重复执行只 `reveal` 聚焦。与左/右侧栏共用同一
  host（`post()` 广播至全部存活面）与同一会话——任一面操作，其它面实时同步。
- **provider 接线重构**：抽 `wireWebview(webview, attachDispose, full)` 统一装载（侧栏视图与
  整页面板同一份 HTML/协议/CSP）；`hello` 应答从「广播给所有面」改为 `postTo(from)` 只回发出方
  （多面共存时不重复广播）。
- **整页样式**：`body.dsh-full` 模式注入额外 CSS——`.app` 约束 `max-width:1160px` 居中阅读列 +
  编辑器底色 + 左右 1px 细分隔，避免全宽拉伸；侧栏模式零变化。
- **机制梳理文档**：`docs/design/vscode布局与插件嵌入位置梳理.md` —— VS Code 六区域、插件可贡献
  点全表（容器/视图/editor/title/面板/状态栏/自定义编辑器）、「focus 不展开容器」语义、
  主流聊天插件（Copilot/Codex/CC/Cline）落点对照、`package.json` + `extension.ts` 逐条对照、
  真机验证 7 步清单。
- 激活事件 4→5（增 `onCommand:dshLite.openChatFull`）；配置描述更新。
- 测试：typecheck 通过；单测 86 过 / 0 失败 / 3 跳过（E2E 需真实 dsh）。

### M12 右上角入口修复：先展开容器再 focus（对齐 Codex/CC 两步聚焦法）
- 根因：`openChat` 之前只 `.focus()` 右侧视图——`focus` 不会把默认隐藏的
  `secondarySidebar` 容器拉开，结果视图跑到左侧/最下方（「没有整个右边扩展」）。
- 修复：`dshLite.openChat` / `dshLite.openSidebar` 均改为两步——先
  `executeCommand('workbench.view.extension.<容器Id>')` 展开所在侧栏，再 `<viewId>.focus`；
  <1.106 无副侧栏时 catch 回退左侧容器两步，再兜底纯 focus。
- 证据：反编译 Codex `openSidebar`（`workbench.view.extension.codexSecondaryViewContainer`
  + `chatgpt.sidebarSecondaryView.focus`）、CC `sidebar.open`（focus + show()）。

### M11 对标 dsh web「窗口感」：空态大插画 + 底栏三行 composer
- 大空态「探索未至之境」（96px rocket+sparkle 插画 + 按连接/会话/错误四态引导 + 动作按钮）。
- composer 拆三行：模式条（cwd pill + ●普通 pill）→ textarea → 工具条（round ＋ + 目标 chip
  + 圆形发送/停止主钮）。保留审批卡与目标 dock。
- 自查工具 `tools/preview.html` 增 `?view=empty`；playwright-core + 共享 Chrome 截图（深/浅 × 空/消息）。

### M10 消息左右分栏气泡 + 右上角图标双套配色
- 消息流分栏：assistant 左整宽文本 + sparkle 紫标；user 右对齐气泡（圆角 10/10/2/10、
  `--vscode-chat-requestBackground/Border`）+ account 图标贴最右。
- 右上角 editor/title 图标隐形根因：该区域把 command svg 当普通 image 渲染（不走 mask 染色），
  `fill="currentColor"` → 黑色隐形；改 `{light: icon-light.svg(#1F1F1F), dark: icon-dark.svg(#C5C5C5)}`
  配对，命令与两容器共用；webview 内 `.brand-logo` 深色主题 invert。

### M9b 对照 Codex / Claude Code 界面逐项校准（顶栏收口 + 消息观感对齐）
- **顶栏收口为「logo + 会话名」单入口**：左侧 = 品牌 logo（assets/icon.svg，host 注入
  window.DSH_LOGO；缺失回退 codicon 占位）+ 当前会话标题 + chevron，整钮点击即展开全部历史；
  右侧仅 连接状态点 + 圆形 ＋新建。收敛此前"标题+chevron / 连接点 / ＋"三个控件的堆叠。
- **消息观感按 CC/Codex 共识形态校准**（去掉上一版 user 右气泡/彩色大色块）：
  - user / assistant / system 统一为「左列 16px 极小角色图标（account / sparkle(紫) / info）+ 整宽文本」，
    user 不反色、无气泡、无背景大块；助手用紫 sparkle 标记，系统灰斜体——与 Codex/CC 一致；
  - 工具调用/工具结果/命令保留为**内嵌缩进小卡片**（等宽 + 彩色左竖条 + hover 复制），CC 同款；
  - 行高 1.55、间距 8px，阅读节奏更接近 CC/Codex。
- 依据：对 Codex（openai.chatgpt）/ Claude Code（anthropic.claude-code）安装产物做结构对照
  （双层设计令牌 --app-*、消息无气泡整宽、composer 圆形发送钮、角色用极小 icon 而非色块）。
- 测试：typecheck + 全量单测 0 fail（沙箱 86 过 / 3 跳过 E2E）；mock 预览截图自查（400px 侧栏）。

### M9 修复（实机核查反馈：顶栏右区消失 / 消息观感 / 右上角入口可见性）
- **修复顶栏右区被挤出**：M9 误把 `.session-btn` 改成 `max-width:100%`，把「连接点 + 新建圆钮」
  （.topbar-right）挤到视口外；恢复 `max-width:60%` + `min-width:0`（可收缩/省略号），右侧操作组回归。
- **消息观感回归对话节奏**：user 消息改为**右对齐柔和气泡**（限宽 88%）；assistant 左整宽、
  3px 紫色左 accent + sparkle 小图标；tool/command 卡片左缩进 6px 并带彩色左竖条
  （工具=蓝、命令=紫）——修正 M9 初版「user/assistant 同色块难区分、工具直白平铺」的杂乱感。
- **右上角入口始终可见**：`menus.editor/title` 移除 `when: editorIsOpen`——之前必须打开过
  编辑器文件才显示右上角 logo（Codex/CC 恒显示），现在任何时候都显示。
- **新增 UI 预览工具** `tools/preview.html`：mock 宿主（假会话/消息/目标）+ `acquireVsCodeApi`
  桩，配无头 Chrome 截图即可自查 UI（`python3 -m http.server 8899` + chrome headless screenshot）。
- 测试：typecheck + 全量单测 0 fail（沙箱 86 过 / 3 跳过 E2E）。

### M9 符号与交互对齐（Codex / Claude Code 观感）：图标字体 + 历史搜索分组 + 消息行操作
- **codicon 图标字体**：vendor `@vscode/codicons`（css+ttf → `assets/codicons/`，url query 已剔除），
  provider 的 `localResourceRoots` 增 assets、CSP 放行 `font-src`、head 按需注入 css；
  图标缺失时 UI 优雅降级为无图标（功能不依赖图标）。全部 emoji/文本符号 → codicon：
  ＋→add、✎→pencil、🗂→archive、↺→history、🎯→target、▶/‖→debug-continue/pause、
  ✕→close、✓→check、●→loading(spin)、■→debug-stop、文本「发送」→arrow-up 圆形主钮。
- **顶栏**：改为 CC 式——左「会话标题 + chevron-down」，右侧连接状态点 + 圆形新建钮（add）。
- **历史弹层（会话下拉）**：顶部加**搜索框**（按标题/目录过滤，Esc 关闭）；未归档会话按
  updatedAt 分「今天 / 昨天 / 最近 7 天 / 更早」时间组（组内倒序），对齐 Codex/CC 历史面板；
  「已归档」折叠头符号化（archive + chevron）。
- **消息流**：文本消息行加**角色图标列**（user=account / assistant=sparkle(紫) / system=info），
  与 CC/Codex 的角色符号观感一致；每条消息 hover 出**复制**按钮（navigator.clipboard）；
  工具 call 前加 terminal 图标、result 卡带头部行（output 图标 + "工具结果" + hover 复制）；
  命令气泡前加 terminal-bash 图标、完成后可复制结果。
- **输入区**：发送=圆形主钮 arrow-up（running 时原位切换 debug-stop 停止方块），title 随
  Enter 行为提示；斜杠浮层行补 terminal-bash 前缀。
- 测试：typecheck + 全量单测无回归；未改宿主业务逻辑（纯 UI 层）。

### M8 双栏布局：右侧（次要）侧栏 + 右上角入口（对齐 Codex / Claude Code / 0.5.1）
- **双容器**：`viewsContainers` 新增 `secondarySidebar` 容器 `dshLiteSecondary`
  （与既有左侧 activitybar 容器 `dshLite` 并存），视图 `dshLite.panel.secondary` 与
  `dshLite.panel` 各自独立 resolve——左侧栏、右侧栏可同时打开。
- **右上角入口**：`menus."editor/title"`（navigation@0, `editorIsOpen`）挂
  `dshLite.openChat`（图标复用 `assets/icon.svg`）——点它即「在右侧打开对话」，
  聚焦右侧栏视图；旧版 VS Code（<1.106，无 secondarySidebar）时命令回退聚焦左侧栏。
- **宿主侧**：`DshLitePanelProvider` 由单 view 引用改为
  `Map<viewType, WebviewView>` 多视图服务——同一 provider 实例对两个 viewId 各注册一次，
  状态变更广播到两侧，保证左右同屏同会话（会话/审批/目标在两侧实时一致）。
- **激活**：`activationEvents` 增 `onView:dshLite.panel.secondary` 与
  `onCommand:dshLite.openChat`；`retainContextWhenHidden` 对两视图均保留。
- 命令调色板补充：`dshLite.openSidebar`（左侧）、`dshLite.openChat`（右侧）均可搜到。
- 要求：secondarySidebar 容器需 VS Code ≥ 1.106 才显示；旧版本自动降级为仅左侧。

### M7 会话管理：全量历史 + 命名 + 归档/取消归档
- **全量历史（不再按 cwd 过滤）**：移除连接层 `filterSessionsByCwd` 过滤，会话清单改为
  session/list 全量展示——与官方浏览器 GUI 同源（同 ~/.dsh 库），彻底解决「浏览器能查到、
  插件查不到历史」的不一致。
- **命名**：会话行悬停 ✎ → 内联改名 → `session/rename {request:{sessionId,title}}`
  （中文标题 OK，probe2/集成 E2E 实证），成功后刷新清单取新 title 投影。
- **归档/取消归档**：行悬停 🗂/↺ → `workspace/archiveSession|unarchiveSession`
  `{request:{sessionId}}` → 以返回的 `archivedSessionIds` 全集覆盖本地集合；
  归档=workspace 级「隐藏不删」（session/list 数据仍在，靠归档集合区分）。
- **归档态同步**：连接就绪后开 `workspace/follow` 读基线首帧
  （`{type:'baseline', value:{items, archivedSessionIds}}`），重连后归档集合自动恢复；
  读完即 cancel，不留长连（5s 兜底）。
- **UI 分组**：会话下拉分「最近会话 + 已归档(可折叠)」两区；点已归档会话自动取消归档并打开。
- **契约实证**：`workspace/unarchiveSession` 在官方 0.1.2-rc.1 原版 Remote 网关 **404**
  （typert host/remote-client 描述零命中；registry 服务层有该方法但 controller 未挂 Remote，
  属 host 补丁范畴——dsh-custom-patches 的 workspace patch 同源）。dsh-lite 照常调用，
  官方原版会收到明确 RPC 错误而非静默失败；集成 E2E 对 404 降级断言（list 仍见 a）。
- 测试：service 层 rename/archive/unarchive 状态机 + baseline 同步（fake conn+mux，+5 用例）；
  集成 E2E 新增 M7 真实 dsh 用例（rename 中文标题生效 + follow 基线 + archive 往返）。
  全量 89 通过 / 0 跳过（含真实 dsh 三次 boot：M1/M6/M7 集成全绿）。

### 校验修复（M0–M6 全量走查 + 真实 dsh E2E 固化）
- 走查修复 ①斜杠浮层死锁：`commands` 未就绪时浮层永远不出现 → 拆「拉取资格」与「可见性」，
  首击 `/` 即触发目录拉取（webview/app.tsx）。
- 走查修复 ②Esc/点选关闭浮层后被 effect 立即重新拉起 → 加本地 `slashDismissed` 标记，
  「用户主动关闭」不再因宿主清目录(commands→undefined)被当作「尚未拉取」重发请求。
- 走查修复 ③断线后陈旧审批卡：WS 重连网关会对新 `$events` 代次重推待批瀑布 →
  断开时清空 `pendingApprovals`（src/session/service.ts onConnection），补单测锁定。
- 走查修复 ④审批卡在未就绪(连接中)时也渲染 → 增加 `ready` 门槛。
- E2E 固化：`test/integration.dsh.test.ts` 改为 DSH_HOME 自动隔离（沙箱可跑、本机不污染），
  M1 修正 control 首帧断言（0.1.2-rc.1 实测为 typed 帧 `{type:'baseline', value:{queues,jobs,projections}}`），
  新增 M6 真实 dsh 用例：commands/list（内置 ≥5 含 goal/plan/permission）→ `/goal` 执行 →
  command 配对与目标折叠（走 SessionController 产品路径）→ goals CAS（陈旧 ref 拒绝、正确 ref pause/clear）。
- 单测 83 通过 / 0 跳过（含 E2E：真实 dsh 两次 boot 全绿）。

### M6 原生 Agent 能力：斜杠命令 / 审批 / 目标（后端契约全保留，UI 极简）
- 契约勘误：0.1.2-rc.1 装机包实证 `commands/*`、`goals/*`、`approval/*`、`goal/change` 全部真实存在；
  修正 M2–M4「follow 流无审批/命令帧 → 不做」的旧结论（见 docs/design/命令与审批与目标.md §1）。
- 斜杠命令平面（M6b）：`commands/list`+`commands/execute`（扁平 agentId/line/images 信封，活体 probe 实证）；
  输入 `/` 弹命令浮层（目录宿主拉取、本地过滤、键盘可选）；普通 Enter 提交遇 `/` 开头自动分流为命令执行；
  `command/run`↔`command/done` 按 commandId 配对，渲染「/命令 + 状态徽标」气泡。
- 审批应答（M6c）：连接级 `$events` 流（ready 帧带 clientId，活体实测）接 `approval/request` 瀑布；
  composer 上方审批卡（拒绝 / 允许一次），经 `$events/result`（{clientId,eventId,outcome}）应答；
  cancel 帧撤卡。权限预设切换 / 用户提问表单本期不做（理由见设计文档 §3/§5）。
- 目标 dock（M6d）：`goal/change` 整快照折叠 → 输入区上方目标条（进行中/暂停/受阻/已完成 + 目标文本）；
  暂停/继续/清除走 `goals/pause|resume|clear {agentId, ref}`（CAS）；新建目标 = `/goal <目标>` 命令。
- UI 补欠账：会话下拉（M2 起缺 CSS）与斜杠/审批/目标新组件样式补齐。
- 测试：viewmodel 命令配对 / 目标折叠；service 斜杠分流 / 目录 / 审批瀑布应答 / 目标动作（fake conn+mux）。
  单测 80 通过 / 1 跳过（真实 dsh 冒烟需健康终端环境）。

### M5 打磨（已完成）
- 移除从未生效的 `dshLite.advanced.logLevel`（未发布过，不留死配置）。
- 会话选中但快照未到时空态显示「会话加载中…」。
- README 补功能边界（审批/变更不做的事实依据）与真实 dsh 验收说明。

### M4 工具 / 审批 / 变更
- 依据 0.1.2-rc.1 真实抓帧定范围：follow 流**无审批帧、无文件变更帧**（本机
  danger-full-access）→ 审批/变更卡片明确不做；只做有真实帧支撑的部分。
- 工具卡片：`tool/call` 等宽命令行；`tool/result` 折叠/展开（存储上限 2000 字）。
- content 块解析：text 拼接；image → `[图片附件]`；其它带 type 块 → `[附件:<type>]`。
- `ViewMessage` 增 `toolState`，工具条目统一 `kind:'tool'`。

### M3 写入（prompt / cancel / create）
- `session/create|prompt|cancel` 一元 RPC（字段按契约 + 防御式取值）。
- 发送乐观气泡 + 回声去重；运行中再发默认排队（`dshLite.followUpQueueMode`）。
- 输入框 Enter 行为可配置（`dshLite.composerEnterBehavior`：send / newline）；
  IME 组合输入不误触发送。
- 已选中会话优先挂 follow 流；ready 自动选最新会话。
- 未实现并记档：改名（无契约端点）、`/` 斜杠提示（无命令清单）、错误 toast（宿主日志）。

### M2 只读渲染
- `session/follow` 流 → 视图模型：15 类事件映射（依据真实抓帧 eventTypeCounts）。
- shadow 折叠：`sourceEventSeqs` 折叠被编辑重发覆盖的旧消息（含整段回合替换）。
- 流式尾巴：`assistant/chunk`（文本在 `data.chunk` 键）累积 → `assistant/message` 前缀升级定稿。
- `session/*` 生命周期元事件静默；未知事件折叠为状态行；seq 幂等去重。
- 会话下拉切换不串流（每个会话独立 controller + 视图模型）。
- 视图模型/服务单测（fake mux 注入事件帧，无网络依赖）。

### M1 连接层
- 服务探测（空闲/同版本/其它/无响应）+ 自起 dsh（默认 3082，被占自动回退空闲端口），
  复用了 0.5.1 的探测/端口回退逻辑但**不复用外部实例**（决策 A）。
- 启动失败全路径清理子进程（SIGKILL，防孤儿/凭证锁残留）。
- 令牌换 cookie → `/api/remote.mux` WS 建连（ws@8，autoPong 匹配心跳）。
- L1（进程死→offline 不自动拉起）/ L2（WS 掉→1+2+4+8+16s 退避自动重连）双层断线策略。
- `session/list` 会话清单（按 cwd 过滤）+ 状态条/错误码文案。

## 0.0.1（M0 脚手架）

> 阶段：M0　状态：已交付　范围：仅搭骨架，不接 DSH。

### 新增
- 扩展骨架：能安装、激活、在侧栏（活动栏 `DSH Lite`）打开空白面板。
- 宿主 ↔ UI 的 **postMessage 协议 v1 骨架**：`PROTOCOL_VERSION=1`、版本化握手、
  `hello` / `ui/ready` / `host/state` / `host/error` 消息类型（`src/panel/protocol.ts`）。
- Webview **三行框架**（M0 全部禁用占位）：顶栏（会话 ▾ / ＋ / ⋯ + 连接状态点）/
  消息区（空态"尚未连接"）/ 输入区（输入框 + @ + 发送）。
- 协议版本不匹配时按 `mismatchHint()` 显示醒目提示（reload → 重载窗口；upgrade → 更新扩展），
  且不再渲染正常内容，**绝不静默降级**。
- esbuild 双 bundle 构建：`src/extension.ts` → `out/extension.js`（node/cjs）、
  `webview/index.tsx` → `out/webview.js`（browser/iife，打包 React），支持 `--watch` 与 `--test`。
- 协议单测 `test/protocol.test.ts`（node:test + node:assert/strict）。
- 配置项 `dshLite.*` 共 8 个一次性声明（M5 移除从未生效的 logLevel 后为 7 个）（声明不等于实现），与 0.5.1 的 ID / 配置前缀完全独立。
- 文档底座：README、CHANGELOG、`.gitignore`、`.vscodeignore`、`assets/icon.svg`。
- 与已装 dsh-vscode 0.5.1 同时启用互不干扰（容器 id、配置前缀、激活事件均独立）。

### 未接（后续里程碑）
- ❌ DSH 连接与进程探测（**M1**）。
- ❌ 会话列表 / 消息渲染 / 事件流（M2+）。
- ❌ 新建会话、附加文件、停止、审批等命令（M3/M4）。
- ❌ 日志面板（M5）。
- ❌ 设置页（**永久不做**，配置走 VS Code 原生设置或 DSH 网页端）。
