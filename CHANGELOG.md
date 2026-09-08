# 更新日志

所有 notable 变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
本插件采用里程碑（M0/M1/…）驱动的版本节奏。

## 未发布

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
- 配置项 `dshLite.*` 共 8 个一次性声明（声明不等于实现），与 0.5.1 的 ID / 配置前缀完全独立。
- 文档底座：README、CHANGELOG、`.gitignore`、`.vscodeignore`、`assets/icon.svg`。
- 与已装 dsh-vscode 0.5.1 同时启用互不干扰（容器 id、配置前缀、激活事件均独立）。

### 未接（后续里程碑）
- ❌ DSH 连接与进程探测（**M1**）。
- ❌ 会话列表 / 消息渲染 / 事件流（M2+）。
- ❌ 新建会话、附加文件、停止、审批等命令（M3/M4）。
- ❌ 日志面板（M5）。
- ❌ 设置页（**永久不做**，配置走 VS Code 原生设置或 DSH 网页端）。
