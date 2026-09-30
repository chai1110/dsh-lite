# 历史档案（0.1.0 前的自研渲染架构）

> **本目录全部内容描述已在 `0.1.0`（2026-09-29）退役的架构**：自研 webview + React 渲染 +
> RPC 直连（`webview/`、`src/rpc/`、`src/session/`、协议与状态合成）。
> `0.1.0` 起改为「本地代理 + iframe 嵌入官方界面」，当前架构见根目录 [README.md](../README.md) 与 [HANDOFF.md](../../HANDOFF.md)。
>
> 保留作史料与设计决策溯源，**不再维护**；其中引用的文件路径是当时的，与现状不符。

| 内容 | 说明 |
|---|---|
| `01-技术方案.md` … `05-开发总规划.md` | 立项与规划（M0 时期） |
| `architecture.md` / `folder-map.md` | 旧分层结构与目录速查（M14） |
| `milestones/` | M0–M15 逐里程碑记录 |
| `design/` | UI 规格、协议、审批/目标等设计稿 |
| `api/`（connection.md 除外） | 退役 RPC/会话层的 API 契约 |
| `audit/` | 旧代码核查报告 |
| `tools/preview.html`、`tools/shot.cjs` | 旧 webview 的自查预览与截图工具 |

> 注：`docs/api/connection.md` **不在本档案**——它描述的进程/连接层（`src/process/`）在 0.1.0 仍存活，
> 且被现役代码注释引用，留在 `docs/api/` 原位。
