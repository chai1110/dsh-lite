# 目录速查（folder-map）

> 每行：**目录** — 职责 — 典型问题排查路径 — 改动前先看的依赖文件。

## 顶层

| 目录 | 职责 | 改动前先看 |
|------|------|------------|
| `src/` | 扩展宿主（Node 端） | `docs/architecture.md` 看清依赖方向 |
| `webview/` | 面板（浏览器端，esbuild bundle 出 `out/webview.js/css`） | 与宿主的契约是 `src/panel/protocol.ts` |
| `docs/` | 需求 / 设计 / API / 里程碑文档 | `docs/architecture.md` `docs/folder-map.md` `docs/design/vscode布局与插件嵌入位置梳理.md` |
| `scripts/` | 构建脚本（`build.mjs` = esbuild + tsc） | — |
| `tools/` | 离线工具（`preview.html` 浏览器预览、headless Chrome 截图） | — |
| `test/` | 单元 + 集成测试 | `src/*` 一一对应 |

## src/ —— 宿主端（Node）

### L1 基础（无 vscode 依赖）

| 文件 | 职责 | 注意 |
|------|------|------|
| `model.ts` | 跨层共享类型（SessionBrief/ViewMessage/GoalBrief/LiteErrorCode…） | webview 也会 import，**绝不能** import node 内建模块 |
| `config.ts` | `getConfig()` 读 `dshLite.*` 设置（包名/类型/默认值与 package.json 的 `contributes.configuration` 一致） | 改默认值要同步改 package.json |
| `log.ts` | `createLogger(outputChannel, prefix)` —— 包装 OutputChannel，支持 `log.child('xxx')` 嵌套 | 替换之前散落的 `(line)=>output.appendLine(line)` 模式 |

### L2 外部接口

| 目录 | 职责 | 典型问题 | 改动前看 |
|------|------|---------|---------|
| `process/` | dsh 子进程 + 端口探测（detect / manager / process / types） | 「没找到 dsh」「端口被占」「启动超时」→ 这里 | `docs/api/connection.md` |
| `rpc/` | `/api/remote.mux` WS 客户端 + 一元 RPC | 「WS 收不到帧」「payload 字段错」→ 这里 | `docs/api/remote-mux.md` |

### L3 连接（orchestrator）

| 文件 | 职责 |
|------|------|
| `connection.ts` | `ConnectionManager` —— 组合 L2 + 会话清单 + L1/L2 重连策略，对外发 `LiteSnapshot` |

### L4 业务（session）

| 文件 | 职责 |
|------|------|
| `session/service.ts` | `SessionService` —— 当前会话编排（select / submit / stop / newSession / slash / goal / approval） |
| `session/controller.ts` | `SessionController` —— 单会话流控（assistant/chunk 流式展开） |
| `session/viewmodel.ts` | UI 消息投影（host 流 → `ViewMessage[]`） |
| `session/api.ts` | RPC 适配（createSession / promptSession / cancelSession） |
| `session/list.ts` | session/list 列表解析（**M7 起不再按 cwd 过滤**） |
| `session/workspace.ts` | rename / archive / unarchive unary |
| `session/commands.ts` | 斜杠命令（commands/list、commands/execute） |
| `session/goals.ts` | 目标 pause/resume/clear（goals.*） |
| `session/events.ts` | 事件流适配（assistant/chunk、tool/call/result、goal/change…） |
| `session/events-stream.ts` | `RemoteEventsHub` —— $events 实时通道 + 审批 request 收集 |

### L5 webview 宿主

| 文件 | 职责 | 改前注意 |
|------|------|---------|
| `panel/index.ts` | **公开 API**（extension.ts 只从这里 import） | 内部实现不外漏 |
| `panel/provider.ts` | `DshLitePanelProvider` —— 接 webview / 消息分发 / 状态广播 | 改前先看 state/html/commands/migration 子模块 |
| `panel/protocol.ts` | 宿主 ↔ webview 协议 v1（`HostMessage` / `UiMessage` / `PanelState`） | webview 也 import，**不能 import node 内建** |
| `panel/state.ts` | `buildPanelState()` —— 快照合成（连接 + 服务 + 错误） | 纯函数，单测覆盖 |
| `panel/html.ts` | `getHtml()` —— webview HTML 模板（含 CSP） | 改前必看 CSP 白名单 |
| `panel/commands.ts` | `registerPanelCommands()` + `openChatRight()` | 入口命令全在这里 |
| `panel/migration.ts` | `runViewLocationMigration()` —— 直读 sqlite 精准删 M13.1 前的孤儿 viewId + 死 container state | 由 `globalState.viewLocationMigrated_v3` 控制只跑一次，依赖外置 sqlite3 CLI |
| `panel/errors.ts` | `err.*` code → 中文描述 | `describeErr` |

### L6 入口

| 文件 | 职责 | 注意 |
|------|------|------|
| `extension.ts` | **纯装配** —— 6 步：日志 → 迁移 → provider 注册 → 装配 connection/service → openOnStartup → 命令注册 | 别在这里写业务；想加新功能先找正确层 |

## webview/ —— 浏览器端

| 路径 | 职责 | 改前注意 |
|------|------|---------|
| `index.tsx` | 入口：mount `<App/>` 到 #root | 一般不改 |
| `app.tsx` | 面板根：状态机 + 消息路由 + 把状态分发给子组件 | 业务 / 派生 / 回调都在这里；渲染只放 JSX 拼装 |
| `lib/post.ts` | `acquireVsCodeApi()` + `post(UiMessage)` —— 唯一上行通道 | 任何上行消息都走这里 |
| `lib/util.ts` | 纯函数：`copyText` / `timeBucket` / `roleIcon` / `roleTitle` / `commandBadge` / `goalPhaseLabel` / `connectionColor` | 无 React 依赖；可单测 |
| `lib/codicon.tsx` | `<Icon n="…" spin?/>` —— codicon 字符渲染 | 字体由宿主注入，缺失时自动降级 |
| `components/topbar.tsx` | 顶栏（logo + 会话名 + 连接点 + ＋新建） | — |
| `components/history-dropdown.tsx` | 会话下拉（搜索 / 时间分组 / 归档折叠 / 行操作：重命名/归档/恢复） | — |
| `components/empty-state.tsx` | 空态大插画（M11「探索未至之境」） | — |
| `components/messages.tsx` | 消息流 + `MsgRow`（tool/command/text 三态） | — |
| `components/approval-card.tsx` | 审批卡（M6c） | — |
| `components/goal-dock.tsx` | 目标 dock（M6d） | — |
| `components/slash-overlay.tsx` | 斜杠命令浮层（M6b） | — |
| `components/composer.tsx` | 三行 composer（模式条 + textarea + 工具条） | — |
| `styles.css` | 所有 UI 样式（不引入 CSS-in-JS） | 改前先 grep class 名确认有 1:1 对应组件 |

## 典型问题排查路径

| 现象 | 先看 |
|------|------|
| 「连接不上」「端口被占」「dsh 未找到」 | `src/process/`（detect / manager）+ Output 通道 [DSH Lite/conn] |
| 「WS 收不到帧」「payload 错误」 | `src/rpc/mux.ts` + `docs/api/remote-mux.md` |
| 「发送后无反应」「会话列表不对」 | `src/session/service.ts` + Output [DSH Lite/session] |
| 「审批卡不显示 / 答了没反应」 | `src/session/events-stream.ts` + `src/panel/provider.ts` 的 `ui/approvalAnswer` |
| 「右上角图标点了没反应 / 视图位置错」 | `src/panel/{commands,migration,provider}.ts` + `docs/design/vscode布局与插件嵌入位置梳理.md` |
| 「UI 一直不更新 / 协议不匹配」 | `src/panel/protocol.ts` + webview `lib/post.ts` + 浏览器控制台 |
| 「编译后扩展装不上 / 行为不对」 | `out/` 是否更新（`npm run compile` 必跑）；`dsh-lite.vsix` 是否重装（`code --install-extension --force`）|
