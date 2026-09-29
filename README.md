# DSH Lite

> DeepSeek Harness（DSH）的**轻量** VS Code 侧栏客户端：**直接嵌入官方界面**，只隐藏设置入口。

DSH Lite 与浏览器里的 DSH 官方界面**完全一致**——对话渲染、回合折叠、工具卡、历史（顶栏集合）、
模型选择、斜杠命令、审批全部由官方页面自己承担；插件侧只做两件事：

1. **本地代理**：webview 外壳对 `http://127.0.0.1` 是跨站来源，带不上 dsh 的
   `SameSite=Strict` 认证 cookie——代理在服务端注入 cookie，官方页面才能真正加载；
2. **隐藏设置入口**：向官方页面注入 `data-dsh-lite` 样式隐藏「设置」按钮
   （Lite 产品定位：不要多层设置页）。

> **实测适配**：DSH **`0.2.0-rc.1`**（官方 `next`，2026-09-28 发布）——真机 smoke 全过：
> 令牌兑换 → 代理取首页 200（含 `__DSH_BOOT__`）→ 隐藏设置注入 → WebSocket 升级
> `/api/remote.mux` 完整 101。代理链不解析对话内容、不依赖 RPC 方法表，官方 UI 更新即插件更新。
>
> 此前架构（自研 React 渲染 + RPC 直连）实测到 `0.1.7-rc.2`（E2E 3/3）；`0.1.0` 起退役，
> 详见 CHANGELOG。

## 与 dsh-vscode（chai1110 fork，0.5.4）的区别

两者都用「本地代理 + iframe 嵌入官方整页」，区别只在轻量化程度：

| 维度 | dsh-vscode 0.5.4 | DSH Lite |
|---|---|---|
| 设置入口 | 保留 | **注入 CSS 隐藏** |
| 全页打开 | 有（浏览器窗口） | 有（编辑器标签） |
| 激活事件 | 较多 | 5 个 |
| 扩展 ID / 配置前缀 | `dsh-vscode` / `dsh.*` | `dsh-lite` / `dshLite.*` |
| 并存 | — | **可同时启用、互不干扰**（各自拉起自己的 dsh 实例） |

## 当前状态

`0.1.0`（2026-09-28）：iframe 架构重构完成——退役自研渲染层（webview/、rpc/、session/、
协议与状态合成，约 6000 行），连接层精简为 **manager + boot（令牌→cookie）+ 重连**。

**验证**：`npm run typecheck` 清零；`npm test` **33 过 / 0 失败 / 1 跳过**（跳过项 = 真 dsh
集成测试，需 `DSH_LITE_E2E=1` 且健康 dsh 环境，见下）；对运行中的 dsh `0.2.0-rc.1` 实例
真机 smoke 全过（兑换 → 200+boot → 注入 → WS 101）。

> 真实 dsh 集成测试（自起 → 令牌 → cookie → 代理 200 → WS 升级 → 停止）请在**本机正常终端**跑：
> `DSH_LITE_E2E=1 npm test`。沙箱里 `~/.dsh` 凭证写锁竞争会导致 dsh boot 无法完成（非代码缺陷）。

## 开发命令

| 命令 | 作用 |
|---|---|
| `npm run compile` | esbuild 单 bundle → `out/extension.js` |
| `npm run watch` | bundle watch 模式 |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm test` | 构建测试并跑 `node --test`（4 个套件；集成项默认跳过） |
| `npm run package` | 编译 + `vsce package` 出 `dsh-lite.vsix` |

> 依赖已预装，**无需** `npm install`。

## 配置项（`dshLite.*`，共 5 个）

全部为宿主行为，在 VS Code 原生设置中配置；面板内不出现任何设置项（官方设置入口已隐藏，
需要改 dsh 配置时用浏览器打开 dsh 网页端或直接编辑配置文件）。

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dshLite.executablePath` | string | `""`（自动探测） | dsh 可执行文件绝对路径 |
| `dshLite.autoStart` | boolean | `true` | 无可用实例时自动启动 dsh |
| `dshLite.openOnStartup` | boolean | `false` | 启动 VS Code 后自动在右侧打开对话 |
| `dshLite.workspaceRootIndex` | number | `0` | 多根工作区用第几个根作会话 cwd |
| `dshLite.advanced.port` | number | `3082`（占用回退） | 自起实例的监听端口 |

## 开发原则

- **不改官方行为**：能靠官方页面做到的（渲染/折叠/历史/模型/审批），插件一律不接管。
- 插件侧只负责：进程管理、认证代理、设置入口隐藏——三层都各自独立可测
  （`src/process/`、`src/service/proxy.ts`、`src/panel/`）。
- 编译产物 `out/` 不入库（已在 `.gitignore`）。
