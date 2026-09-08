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
| 激活事件 | 13 个 | 2 个（`onView:dshLite.panel` / `onCommand:dshLite.openSidebar`） |
| 并存 | — | 与 0.5.1 **可同时启用、互不干扰**（容器 id、配置前缀均独立） |

## 当前状态

**M0 脚手架**：仅搭骨架，尚未连接 DSH。侧栏默认显示空态（"尚未连接"）。
连接 DSH、会话列表、事件流见后续里程碑（M1 连接层）。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm run compile` | esbuild 双 bundle → `out/extension.js` + `out/webview.js` |
| `npm run watch` | 上述两个 bundle 进入 watch 模式 |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm test` | 构建测试并跑 `node --test`（协议单测） |
| `npm run package` | 编译 + `vsce package` 出 `dsh-lite.vsix` |

> 依赖已预装，**无需** `npm install`。

## 配置项（`dshLite.*`，共 8 个）

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
| `dshLite.advanced.logLevel` | `error\|warn\|info\|debug` | `info` | M5 |

> host 固定 `127.0.0.1` 不配置（只连本机）；端口放 `advanced.port`，与 0.5.1 的 3080、用户已有 3081 错开。

## 开发原则

- **先文档后代码**：文档在 `docs/`（需求/规划/UI 规格/里程碑），代码以文档为契约。
- 宿主与 UI 的唯一共享契约是 `src/panel/protocol.ts`，两侧都从这里 import，禁止各写一份。
- 面板只干活、不配置；配置走 VS Code 原生设置或 DSH 网页端。
- 编译产物 `out/` 不入库（已在 `.gitignore`）。
