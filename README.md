# DSH Lite

> DeepSeek Harness（DSH）的**精简** VS Code 侧栏客户端：一页到底，只保留对话、会话与审批。

DSH Lite 不像 0.5.1 那样用 iframe 嵌入整站，而是**自研 webview + RPC 直连本机 DSH**，
像 Codex / Claude Code 插件那样极简——进去只有一个页面，没有设置页、没有二级/三级页、
没有左下角设置齿轮。顶栏只有三样（会话 ▾ / ＋ / ⋯），下面就是输入框；
一切"配置"走 VS Code 原生设置（`dshLite.*`）或 DSH 网页端。

## 与 dsh-vscode 0.5.1 的区别

| 维度 | dsh-vscode 0.5.1 | DSH Lite |
|---|---|---|
| 渲染方式 | iframe 嵌入整站 | 自研 webview，React 单页 |
| 通信 | 整站资源加载 | postMessage RPC 直连本机 DSH |
| 扩展 ID / 配置前缀 | `dsh-vscode` / `dsh.*` | `dsh-lite` / `dshLite.*` |
| 页面数量 | 含整站全部页面 | 一页到底，无设置页 |
| 激活事件 | 13 个 | 5 个（两视图 `onView:dshLite.view.left|.right` + 三命令 `onCommand:dshLite.openSidebar|openChat|openChatFull`） |
| 并存 | — | 与 0.5.1 **可同时启用、互不干扰**（容器 id、配置前缀均独立） |

## 当前状态

**M1~M13 已实现**（本地构建 + 89 项测试：沙箱 86 通过 / 0 失败 / 3 跳过（真实 dsh E2E），本机 `DSH_LITE_E2E=1` 89/89 全绿）：

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 脚手架：宿主 + Webview 双 bundle 骨架 | ✅ |
| M1 | 连接层：dsh 探测 / 自起（3082，占用回退）/ 令牌换 cookie / WS mux / L1·L2 重连 / 会话清单 | ✅ |
| M2 | 只读渲染：会话下拉 + 消息流 + shadow 折叠（编辑重发不残留）+ 切流不串 | ✅ |
| M3 | 写入：发送（Enter 可配置）/ 停止 / 新建 + 乐观气泡去重 | ✅ |
| M4 | 工具卡片：tool/call 命令行 + tool/result 折叠展开；附件/图片降级占位 | ✅ |
| M5 | 打磨与共存 + 打包 | ✅ |
| M6 | 原生 Agent 能力：斜杠命令平面 + 审批应答卡 + 目标 dock（后端契约全保留，UI 极简） | ✅ |
| M7 | 会话管理：全量历史（不按 cwd 过滤，与浏览器一致）+ 命名 + 归档/取消归档分组 | ✅ |
| M8 | 双栏布局：右侧（次要）侧栏容器 + 右上角入口（editor/title 图标，点它右侧开聊），左右同屏同会话，对齐 Codex / Claude Code / 0.5.1 | ✅ |
| M9 | 符号与交互对齐：codicon 图标字体（emoji/文本符号全替换）+ 历史弹层搜索与时间分组（今天/昨天/7天/更早）+ 消息角色图标列与 hover 复制 + CC 式圆形发送/停止钮 | ✅ |
| M9b | 顶栏收口「logo + 会话名」单入口；消息统一 16px 角色图标 + 整宽文本（去气泡/大色块），工具/命令内嵌缩进小卡片 | ✅ |
| M10 | 消息左右分栏（assistant 左 / user 右气泡）+ 右上角 editor/title 图标 light/dark 双套（根因：该区域 svg 不染色） | ✅ |
| M11 | 对标 dsh web 窗口感：空态大插画「探索未至之境」+ composer 三行（模式条/textarea/工具条）；tools/preview.html 自查 | ✅ |
| M12 | 右上角入口修复：openChat/openSidebar 改「先展开容器再 focus」两步法（focus 不展开收起容器），<1.106 回退左栏 | ✅ |
| M13 | 整页对话（命令 `dshLite.openChatFull`，编辑区标签，与侧栏同会话广播）+ `openOnStartup` 开机即右侧 + 布局机制梳理文档 | ✅ |
| M13.1 | 修复「点右上角却出现在左侧 Explorer」：根因=旧 view id 被 VS Code 持久化记进 Explorer 容器；容器/视图 ID 全换新（`dshLitePanel`/`dshLitePanelRight` + `dshLite.view.left|.right`） | ✅ |

**验收路径**：`npm run typecheck` && `npm test`（沙箱 86 通过 / 0 失败 / 3 跳过；本机 `DSH_LITE_E2E=1` 89/89——真实 dsh 三次 boot M1/M6/M7 集成全绿）。

> ⚠️ 真实 dsh 端到端（会话打开渲染、写文件+命令任务走完、与 0.5.1 同开 1 小时）
> 需在**本机正常终端**跑：`DSH_LITE_E2E=1 npm test`（沙箱内 dsh boot 受
> `~/.dsh/.credentials.yaml.lock` 写锁竞争影响无法完成，非代码缺陷）。
> 沙箱中留下的锁：`rm -f ~/.dsh/.credentials.yaml.lock`。

## 功能边界（0.1.2-rc.1 装机包实证，见 docs/api/approval-and-tools.md 与 docs/design/Cline功能评估.md）

- **「Cline 式编辑器 shell」（实时 diff 拦截 / 编辑器写前确认 / checkpoint 恢复）在 Lite 中冗余，不做**
  —— 那是 0.5.1 / dsh-cline 的定位（需 DSH 进程内插件 + 编辑器宿主）；Lite 补审批卡即可获得等价安全闸。
- **DSH 原生 Agent 能力已按 M6 接入（后端契约全部真实存在，UI 极简三处操作面）**：
  - 斜杠命令平面：输入 `/` 弹命令浮层（`commands/list`），Enter/点击执行（`commands/execute`），
    `/goal xxx`、`/clear` 等内置命令全量可达；`command/run`↔`command/done` 配对渲染成命令气泡。
  - 审批应答：`$events` 流接 `approval/request` 瀑布，composer 上方出审批卡（允许一次 / 拒绝），
    经 `$events/result` 应答；`approval/asked`/`decided` 审计状态行保留。
  - 目标 dock：`goal/change` 整快照折叠投影显示在输入区上方；暂停/继续/清除走 `goals.*`（CAS ref）；
    新建 = `/goal <objective>`（与官方一致）。权限预设切换 / 用户提问表单本期不做（官方 GUI 承担，理由见
    docs/design/命令与审批与目标.md §5）。
- `assistant/chunk` 文本在 `data.chunk` 键；内部噪音事件（session/*、subagent/*、team/*、hook/* 等）不渲染。
- M7 会话管理：会话清单为 session/list **全量**（历史与浏览器同库可见，不做 cwd 过滤）；
  行悬停 ✎ 命名（`session/rename`）、🗂/↺ 归档/取消归档（`workspace/archiveSession` /
  `workspace/unarchiveSession`）。注意：`unarchiveSession` 在官方 0.1.2-rc.1 原版 Remote
  网关未暴露（HTTP 404，registry 有方法、controller 未挂 Remote，属 host 补丁范畴）——
  Lite 已接入，host 支持即生效，不支持时收到明确 RPC 错误。
- 分页续拉：快照已够，不做。

## 与 0.5.1 的交互边界

- 互不复用实例：Lite 总是自起自己的 dsh（默认 3082），即使探测到 0.5.1 的实例也只用空闲端口。
- 容器 id / 命令 / 配置前缀均独立（`dshLite.*`），可同开互不干扰。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm run compile` | esbuild 双 bundle → `out/extension.js` + `out/webview.js` |
| `npm run watch` | 上述两个 bundle 进入 watch 模式 |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm test` | 构建测试并跑 `node --test`（协议单测） |
| `npm run package` | 编译 + `vsce package` 出 `dsh-lite.vsix` |

> 依赖已预装，**无需** `npm install`。

## 配置项（`dshLite.*`，共 7 个）

全部为宿主行为，在 VS Code 原生设置中配置，面板内不出现任何设置项。

| 配置键 | 类型 | 默认 | 生效里程碑 |
|---|---|---|---|
| `dshLite.executablePath` | string | `""`（自动探测） | M1 |
| `dshLite.autoStart` | boolean | `true` | M1 |
| `dshLite.openOnStartup` | boolean | `false` | M1 |
| `dshLite.composerEnterBehavior` | `send` \| `newline` | `send` | M3 |
| `dshLite.followUpQueueMode` | `queue` \| `steer` | `queue` | M3 |
| `dshLite.workspaceRootIndex` | number | `0` | M3 |
| `dshLite.advanced.port` | number | `3082`（占用回退） | M1 |

> host 固定 `127.0.0.1` 不配置（只连本机）；端口放 `advanced.port`，与 0.5.1 的 3080、用户已有 3081 错开。

## 开发原则

- **先文档后代码**：文档在 `docs/`（需求/规划/UI 规格/里程碑），代码以文档为契约。
- 宿主与 UI 的唯一共享契约是 `src/panel/protocol.ts`，两侧都从这里 import，禁止各写一份。
- 面板只干活、不配置；配置走 VS Code 原生设置或 DSH 网页端。
- 编译产物 `out/` 不入库（已在 `.gitignore`）。
