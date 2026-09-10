# DSH Lite 交接文档（HANDOFF）

> 给一个**完全没有上下文**的新对话快速了解 + 衔接工作用。
> 最后更新：2026-09-09（M13.4 刚推完），作者：csl × WorkBuddy。
>
> 项目一句话：DSH 0.1.2-rc.1 的精简 VS Code 侧栏客户端 `chai1110.dsh-lite`，与官方 fork 0.5.1 (`fengze233.dsh-vscode-panel`) 共存。

---

## 0. 仓库 + 工作目录

| 项 | 路径 / 值 |
|---|---|
| 仓库根 | `/Users/csl/Documents/dsh_data/dsh-vscode-lite` ⚠️ **不在 WorkBuddy 会话目录** |
| GitHub | https://github.com/chai1110/dsh-lite（PUBLIC，已从 `dsh-vscode-lite` 改名） |
| 默认分支 | `main` |
| SSH remote | `git@github.com-chai1110:chai1110/dsh-lite.git`（key `~/.ssh/id_ed25519_chai1110`） |
| gh CLI | `/opt/homebrew/bin/gh`，hosts 存 `chai1110` / `cslht11` / `cslht` 三账号 |
| 当前 HEAD | `da1aa3c`（M13.4） |
| 最近提交串 | M13.1 `acc9a39` → M13.2 `b2f0db5` → M13.3 `de18796` → M13.4 `da1aa3c` |
| WorkBuddy 会话目录 | `/Users/csl/WorkBuddy/2026-09-03-21-12-11/`（存 overview/记忆，**与仓库分开**） |
| 工作区长期记忆 | `/Users/csl/WorkBuddy/2026-09-03-21-12-11/.workbuddy/memory/MEMORY.md` |

⚠️ WorkBuddy 的 Bash 沙箱**当前目录是 WorkBuddy 会话目录**，要操作 DSH 仓库必须 `cd` 或用绝对路径。所有 `git` 命令前置 `rm -f .git/index.lock` + `-c core.fsmonitor=false -c gc.auto=0`（沙箱 unlink 限制导致 lock 残留）。

---

## 1. 项目速览

- **目标**：把 `dsh web` 这个浏览器 GUI 用 VS Code 侧栏 webview 替代。极简单页，无设置页。
- **架构**：扩展宿主 (Node cjs) + webview (浏览器 iife) 双 bundle（`scripts/build.mjs`）。
- **运行机制**：宿主启动 `dsh web` 子进程 → 换 cookie → WS 连接到 `/api/remote.mux` → `session/follow` 拉历史 + 增量 → 渲染到 webview。
- **与 0.5.1 共存**：0.5.1 (`fengze233.dsh-vscode-panel`) 通过 iframe 嵌入官方整站；我们是自研 webview，**不能装同一个 container id**（已用全新 `dshLite.view.left` / `dshLite.view.right`）。
- **配置**（7 项，均 VS Code 原生设置）：`dshLite.executablePath` / `autoStart` / `openOnStartup` / `composerEnterBehavior` (send|newline) / `followUpQueueMode` (queue|steer) / `workspaceRootIndex` / `advanced.port` (3082)。

---

## 2. 完整对话脉络（用户在 WorkBuddy 这边的全部诉求）

> 这是 2026-09-09 一整天的工作流，不是单次任务。

### 阶段 A：DSH Lite 修复 Explorer bug（M13.1 + M13.2）
- **用户报**：左活动栏点开 DSH Lite 图标 → 视图掉到资源管理器里、且 Explorer 里出现**两个**「DSH Lite」。
- **M13.1**（v2 → v3 → v4 三版迁移）：清理 workspaceStorage 里的 `workbench.explorer.views.state` 孤儿 view 记录。
  - v3/v4 用直接 sqlite purge，迁移键 v4 = `dshLite.viewLocationMigrated_v4`，orphan ids = `['dshLite.panel', 'dshLite.panel.secondary', 'dshLite.view.left', 'dshLite.view.right']`。
- **M13.2 终极根因**（commit `b2f0db5`）：从 renderer.log 拿到 schema 校验报错 →
  ```json
  [error] 属性 "icon" 是必需项并且必须为 "string" 类型
  [warning] 视图容器"dshLitePanel"不存在
  ```
  → M10 给 `viewsContainers` 配了 `{"light":...,"dark":...}` 对象 icon，schema 只接受 string，**容器注册被静默丢弃** → 视图兜底塞进 Explorer。
- **修法**：容器 icon 改回 `"assets/icon.svg"` 字符串（activitybar mask-tinted 自动着色）。commands[].icon 的 `{light,dark}` 合法保留。
- **验证**：renderer.log 零 dsh 报错；`workbench.view.extension.dshLite.numberOfVisibleViews`、activitybar / auxiliarybar 的 view container 都注册成功。

### 阶段 B：学 Codex 历史入口（M13.3 + M13.4）
- **用户报 1**（截图 Codex）："你看人家这个历史消息符号是什么？然后点开之后直接就展开全部各种。"
- **用户报 2**："点开左侧那个框...只有一个让搜索，这也是不正常的，全部都进行修复。"
- **用户报 3**："这个会话的显示对话还是要是AI回复的在左侧，我们自己的在右侧。"
- **诊断弯路**：先加 `/tmp/dsh-lite-panel-state.json` 探针（`fs.writeFileSync`），沙箱里 ls /tmp 偶发看不到真实文件（**TMPDIR 重映射**），绕了一大圈最后证明宿主→UI 健康（ready + 33 会话 + 739 条 follow 快照）。
- **M13.3**（commit `de18796`）：
  - 顶栏历史钮 `chevron-down` → codicon **`history`**（Codex 同款时钟图标）
  - 历史下拉**不再要求 ready 才展开**；非 ready 时顶部显示状态横幅（connecting/error/offline/idle 各文案 + 重连按钮）
  - 接入全链路成功日志：cookie 交换 / WS 建连 / 清单 N 个 / 自动选中 / follow 快照 N 条 / UI 握手 protocol=N
  - 实机 9 行日志全绿，最关键：`[follow] 会话快照已载入（739 条记录））`
- **用户报 4**："还是有些问题的，他没有把那个消息该折叠的折叠，他什么都打印输出出来了，乱七八糟的。"
- **学习官方**：`~/.local/node-v24/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/types/.../ToolRow.d.ts`
  - 头部一行（icon + title + summary + summarySuffix + chevron）+ 展开正文（bodyRaw + output）
  - 各工具特化卡：terminal / diff / read / search / web / askQuestion
- **M13.4**（commit `da1aa3c`）：CollapseRow 模式
  - `tool/call` → 「▸ 工具名(参数预览)」参数首行 / 首 120 字截断
  - `tool/result` → 「▸ 工具结果 · 名称 · N 行 · M 字」展开看完整输出（容器 `max-height:480px` + overflow）
  - assistant 长文本（>500 字）→ 6 行 clamp + 「展开全文」/「收起」按钮
  - 流式 ▍ 从文本末尾字符 → CSS `::after` 伪元素 + `dsh-blink` 1s 闪烁（避免跟随气泡宽度滚动）
  - 复制按钮：hover 才显现

---

## 3. 当前状态

| 项 | 状态 |
|---|---|
| 仓库 HEAD | `da1aa3c`（已推送 origin/main） |
| 安装包 vsix | 756KB，仓库根 `dsh-lite.vsix`（已 gitignore） |
| 安装位置 | `~/.vscode/extensions/chai1110.dsh-lite-0.0.1`（已 force install） |
| VS Code 状态 | **当前在运行**，PID 90938，会话目录 `20260909T071739`，用户可能在用 |
| 测试 | 单测 86/0 失败 / 3 跳过（E2E 未跑，本轮改动仅限 UI + 日志） |
| preview 工具 | `tools/preview.html` + `tools/shot.cjs`（playwright-core 无头截图） |
| 实机日志 | 输出通道「`DSH Lite`」能完整看到激活→握手→连接→自动选中→739 条载入链路 |
| 临时探针文件 | 已移除（`fs` import + dumpDebugState 都清理了） |

---

## 4. 已完成清单（M13 全串 + 配套）

- [x] M13.1 v4 视图位置迁移（acc9a39）
- [x] M13.2 容器 icon 字符串化（b2f0db5）✅ **真正的 Explorer 双 DSH Lite 根因**
- [x] M13.3 历史入口对齐 Codex + 下拉连接态透明化 + 全链路日志（de18796）
- [x] M13.4 消息折叠策略对齐官方 ToolRow（da1aa3c）
- [x] provider.ts 移除 `/tmp` 调试探针（之前的 diagnosis 已闭环）
- [x] tools/preview.html：mock 宿主 + 多场景参数（`view=history` / `view=empty` / `conn=error`）
- [x] tools/shot.cjs：playwright-core 无头截图工具入库
- [x] 项目工作区长期记忆（MEMORY.md + 日日日志 2026-09-09.md）同步到 M13.4

---

## 5. 当前卡在哪 / 未做项

| 项 | 说明 | 下一步建议 |
|---|---|---|
| **E2E 测试未跑** | M13 全程只跑单测，E2E 需 `DSH_LITE_E2E=1 npm test` 提权（触发 SAFE_DELETE） | 用户用真机对话一段时间稳定后，安排一次完整 E2E |
| 用户还没在新构建上**真实聊过** | 9 行日志绿、preview 截图看着 OK，但用户实际场景下的"几十条工具调用堆叠"视觉还要他确认 | 等他回复使用反馈 |
| `m.tool/call` 的 `name` 字段 | viewmodel 写到 `ViewEntry.name`，`entryToMessage` 没复制到 `ViewMessage`；UI 现在从 `text` 解析 `name(args)` 拿名字 | 改干净的话给 `ViewMessage` 加 `name?: string` |
| 旧 `.msg-tool*` / `.tool-result-body` / `.tool-toggle` 死样式 | CollapseRow 已替代，旧 CSS 还在 styles.css | 下次顺手清掉 |
| M6 设计文档 `docs/design/命令与审批与目标.md` | 命令契约勘误版本没跟上 M13 链路日志改造 | 改日志规范时同步文档 |

---

## 6. 下一步计划

1. **等用户实机反馈**：M13.4 是否解决了「消息墙」问题；展开/收起交互顺不顺手
2. **若用户还要再加官方观感**：可以接 `dsh-client-ui-tool` 的 terminal/diff/read/search/web 各特化卡（用 viewmodel 区分 `toolName`，例如 `bash` → terminal、`read` → read 卡、`rg/grep` → search 行）
3. **下一次大的 UI 改动前**：先用 `tools/preview.html` + `tools/shot.cjs` 自查，不要直接装 VS Code 让用户看
4. **跑一次完整 E2E**：`DSH_LITE_E2E=1 npm test`（89/89 应全过），改动较大时必跑
5. **窗口右侧栏图标**：`secondarySidebar` 容器 `dshLitePanelRight` 已有，但用户基本只用左/整页；右上图标等用户真用起来再调
6. **M6 设计文档补全**：把 M13.3 加的全链路日志契约写到 `docs/design/`

---

## 7. 踩过的坑（**绝对不要再踩**）

### 沙箱 / 工具链
- **沙箱里 `ls /tmp/xxx` 偶发看不到真实文件**（TMPDIR 重映射）。`/tmp` 写入用 `fs` 在扩展宿主里是正常的，但 Bash 沙箱读 /tmp 不可靠。**所有调试探针改走 OutputChannel 日志**——`/tmp` 不可信。
- **沙箱 unlink 限制导致 git `index.lock` 残留**：每个 git 命令前 `rm -f .git/index.lock`，命令加 `-c core.fsmonitor=false -c gc.auto=0`。
- **`ps` / `lsof` 跨进程操作被拒**：用 `pgrep -fl` 看进程命令行；要看开放端口靠 `curl` 探测。
- **`timeout` 命令 macOS 没装**：用 `(cmd & sleep N; kill PID)` 替代。

### esbuild bundle 验证
- **esbuild 输出中文是**大写 `\uXXXX**（如 `\u63E1\u624B\u5B8C\u6210`），直接 grep 中文永远 miss。要在 bundle 里找中文，必须用 python 按 `%04X` 编码后搜：
  ```python
  def esc(s): return ''.join(c if ord(c)<128 else '\\u%04X'%ord(c) for c in s)
  data = open('out/extension.js').read()
  print(esc('握手完成') in data)
  ```

### VS Code 扩展安装 / 重装
- 报 **`Please restart VS Code before reinstalling`** 时：先 `rm -rf ~/.vscode/extensions/chai1110.dsh-lite-0.0.1` + 清 `extensions.json` 里对应 entry，再 `--install-extension --force`。
- 卸载/重装前确认 VS Code 已退出（`pgrep` 检查；`kill -TERM` 给 4-6 秒）。
- vsce 自身的 secretlint 网络超时，所以**手动 Python zipfile 重新打包**：保留旧 vsix 的 `[Content_Types].xml` + `extension.vsixmanifest`，只替换 `extension/out/*`。

### dsh web 子进程 / Token
- **dsh web 每次启动打印一次性 token URL**，旧 URL 对重启后的实例返回 401（`reopen the URL printed by dsh web`）。
- 决策：**绝不**复用外部 dsh 实例（决策 A），只回收自己 spawn 的 child。被占回退空闲端口（`mux.getMux()` 内置探测）。
- 网页端 URL 永远取自「自己终端里那台 dsh web」，不要从插件输出通道复制。

### 视图位置 / 容器注册
- **视图位置问题先看 renderer.log**（`~/Library/Application Support/Code/logs/<最新会话>/window1/renderer.log`），schema 校验错误只打在这里，sqlite 分析只能看到下游症状。
- **`viewsContainers` 的 `icon` 字段只接受 string**，**不接受** `{light, dark}` 对象——后者触发 schema 校验失败 → 容器**被丢弃** → 视图兜底塞进 Explorer。
- `commands[].icon` **可以**用 `{light, dark}`（这条合法）。

### 协议 / API 契约（来自 M7 实证）
- 会话历史**全量展示**（M7 起不做 cwd 过滤，与官方浏览器同库）
- `session/rename` → `{request:{sessionId,title}}` → `{title,seq}`（中文 OK）
- `workspace/archiveSession` → `{request:{sessionId}}` → `{archivedSessionIds[]}`（归档后**全量集合**）
- `workspace/follow` 零参流首帧 = `{type:'baseline', value:{items, archivedSessionIds}}`（**双包 typed 帧**）；读完首帧即 cancel + 5s 兜底
- **官方 0.1.2-rc.1 Remote 网关无 `workspace/unarchiveSession`**（HTTP 404），浏览器 GUI 恢复按钮同样不可用——我们接入但探测 404 后降级
- `commands/list|execute` 扁平 `{agentId}` / `{agentId,line,images}`；`goals/create` 嵌套 `{request:{objective}}`
- 审批实时通道 = mux **`$events`** 流（不是 `approvals/follow`）

### 写代码纪律
- 同一文件多次 Edit 必须串行（并行会丢更新，整文件 Write 更稳）
- 文档先行于代码
- 协议层/模型层保持纯类型（webview 会 import，禁止拉入 node 内建模块）
- **用户感知的功能坏 = 真 bug + 连接卡死 + UI 零错误反馈 三者叠加**。宿主数据链健康 ≠ 用户看得到——错误透明度本身就是功能。

---

## 8. 用户偏好（沟通 + 风格）

- **语言**：中文。语气简洁随意，不喜欢反复确认提问
- **回答风格**：详细、结构化（表格 + 小标题）、好读易打印（A4 排版）
- **技术工作**：带版本对照、修改前显式验证的结构化报告；**静态分析声称成功后，必须在生产流程中再次复核**
- **协作**：偏好助手**直接处理修复**，不要反复确认提问
- **用户头像**：「吴八哥」expert 由用户在 expert 中心选择；本次任务遵循 SeniorDeveloper 工作流

---

## 9. 用户本人的并行线（不是 DSH Lite 工作，但跟用户当前关注相关）

> 用户身份：csl，1997-11 生，28 岁博士生，Mac，身高 172 / 75kg / BMI 25.4，手腕有旧伤不能做俯卧撑

### 母亲抖音号副业（持续在跟）
- **背景**：母亲 50 岁，腰伤休养，文化程度不高。用户主动寻找低门槛增收路径
- **目标**：月入几百元，绿植盆栽养花内容方向
- **已盘点优势**：家中几十盆、养花口碑好（朋友养不活的到她手中能恢复）、靠网上自学解决问题
- **内容方向**：陪伴型 / 励志型 / 经验分享型，**避开专业养护人设**（她不是科班出身）
- **变现路径**：橱窗、绿植售卖、流量激励
- **下一步**：给出可执行的抖音号运营 + 选题 + 变现方案（结构化、可打印）

### 30 天减脂方案（持续在跟）
- **约束**：手腕旧伤不能做俯卧撑等支撑动作 / 博士生碎片时间 / 食堂饮食蛋白不足 / 跑完 5 公里要立即吃修复餐（鸭腿+蛋+燕麦+蔬菜）
- **已确认**：偏好 A4 排版、可打印的结构化方案
- **下一步**：迭代一版兼顾以上约束的执行方案

### DSH 自定义补丁（dsh-custom-patches 仓库）
- 修过 **编辑重发** (edit-and-replay) 双重根因（host RPC 未注册到 invocations 数组 + UI wrapper 缺少 return），commit `8d60505`
- 当前活跃版本 **0.1.2-rc.1**，旧版 0.1.1-rc.2 保留
- 仓库：`chai1110/dsh-custom-patches`（与 dsh-lite / dsh-provider-config / dsh-ssh-remote 同账号三插件）

---

## 10. 关键文件速查

| 想看什么 | 文件 |
|---|---|
| 扩展入口 + 接线 | `src/extension.ts` |
| 视图宿主（多视图 + 整页 + 协议分发） | `src/panel/provider.ts` |
| 协议类型（host/ui 消息、PanelState 初始态） | `src/panel/protocol.ts` + `src/model.ts` |
| 状态合成（连接 + 服务 → PanelState） | `src/panel/state.ts` |
| 连接管理（dsh 子进程 + cookie + WS + 自动重连） | `src/connection.ts` |
| 服务层（select / send / stop / 审批 / 目标） | `src/session/service.ts` |
| 单会话 follow 流 → ViewModel | `src/session/controller.ts` + `src/session/viewmodel.ts` |
| 事件防御式解析（toolCallText / statusLineOf） | `src/session/events.ts` |
| HTML 注入（webview + 资源根 + CSP） | `src/panel/html.ts` |
| 一次性迁移（explorer 脏 view） | `src/panel/migration.ts` |
| UI 根组件（host 消息订阅 + 斜杠浮层 + 空态） | `webview/app.tsx` |
| 消息渲染（CollapseRow 模式） | `webview/components/messages.tsx` |
| 顶栏（Logo + 历史入口 + 连接点） | `webview/components/topbar.tsx` |
| 历史下拉（搜索 + 时间分组 + 归档） | `webview/components/history-dropdown.tsx` |
| 输入区 | `webview/components/composer.tsx` |
| 斜杠命令浮层 | `webview/components/slash-overlay.tsx` |
| 目标 dock | `webview/components/goal-dock.tsx` |
| 审批卡 | `webview/components/approval-card.tsx` |
| 空态 | `webview/components/empty-state.tsx` |
| 工具（codicon Icon、timeBucket、连接色） | `webview/lib/util.ts` + `webview/lib/codicon.tsx` |
| 所有 webview 样式 | `webview/styles.css` |
| 自查 UI 预览（mock 宿主 + 多场景 URL 参数） | `tools/preview.html` |
| 无头截图工具 | `tools/shot.cjs` |
| 双 bundle 构建脚本 | `scripts/build.mjs` |
| 项目文档 | `docs/design/命令与审批与目标.md` |

---

## 11. 验证流程（每次 UI / 数据流改动前自查）

1. **改 webview 组件** → `node tools/shot.cjs "<view param>" /tmp/shot.png 520 900 2200` → 肉眼复核截图
2. **改数据流 / 协议层** → 跑 `npm test`（必须 86+/0 失败/3 跳）
3. **改 viewmodel / 事件解析** → 跑 `npm test`（覆盖更广，失败 0 才能继续）
4. **改 manifest / 容器注册** → 必须看 `renderer.log`（schema 错误最权威在这里）
5. **改服务层 / 认证 / WS** → 必看 DSH Lite 输出通道日志链（cookie 交换/WS 建连/快照载入）
6. **改较大** → 完整 E2E `DSH_LITE_E2E=1 npm test`（需提权，触发 SAFE_DELETE）

---

## 12. 一句话回顾

DSH Lite 这个仓库已经把 DSH 0.1.2-rc.1 浏览器 GUI 移植到 VS Code 侧栏 webview，M13 这轮把「视图位置、连接透明度、消息观感」三件事全部治了一遍，每一步都附带了真实证据（renderer.log / 739 条快照 / preview 截图）。当前在 `da1aa3c` HEAD 等用户实机验证 M13.4 的折叠观感。下一次对话继续从这里接：等用户反馈 → 必要时接官方 ToolRow 的特化卡 → 跑一次完整 E2E 收尾。