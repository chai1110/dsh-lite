# 更新日志

所有 notable 变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
本插件采用里程碑（M0/M1/…）驱动的版本节奏。

## 未发布

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
