# 架构总览

> DSH Lite 的模块分层、依赖方向、数据流速查。**看这一张就能定位 80% 问题的归属。**

## 1. 分层与依赖方向（自下而上）

```
        ┌─────────────────────────────────────────┐
 L6     │              src/extension.ts            │  入口装配
        └─────────────┬───────────────────────────┘
                      ▼
        ┌─────────────────────────────────────────┐
 L5     │       src/panel/   (webview 宿主)        │  provider / commands / migration / state / html / protocol
        └─────────────┬───────────────────────────┘
                      ▼
        ┌─────────────────────────────────────────┐
 L4     │       src/session/  (业务编排)           │  service / controller / viewmodel / goals / slash / events
        └─────────────┬───────────────────────────┘
                      ▼
        ┌─────────────────────────────────────────┐
 L3     │       src/connection/  (连接编排)        │  ConnectionManager（组合服务层 + RPC + 会话清单 + 重连）
        └────┬─────────────────────┬─────────────┘
             ▼                     ▼
   ┌──────────────────┐  ┌──────────────────────┐
L2 │ src/process/     │  │ src/rpc/             │
   │ dsh 子进程 + 端口 │  │ WS mux + 一元 RPC    │
   └────────┬─────────┘  └────────┬─────────────┘
            ▼                     ▼
        ┌─────────────────────────────────────────┐
 L1     │  src/model.ts   src/config.ts   src/log.ts │  共享类型 / 配置 / 日志（无 vscode 依赖）
        └─────────────────────────────────────────┘
```

依赖铁律：**只允许向下依赖**。上层不能 import 它的下层的私有实现（除了通过 index.ts 的公开 API）。跨层共享的类型放 L1。

## 2. 各层职责一句话

| 层 | 目录 | 职责 | 出了问题看哪个文件 |
|----|------|------|----------------------|
| L1 | `src/model.ts` `src/config.ts` `src/log.ts` | 纯类型 / 配置 / 共享日志 | 类型/配置对不上 → 这里 |
| L2 | `src/process/` `src/rpc/` | 跟 OS / 网络打交道 | dsh 进程没起来、WS 连不上 → 这里 |
| L3 | `src/connection.ts` | 组合 L2 + 会话清单 + 重连策略 | 「状态一直是 connecting/ready」 → 这里 |
| L4 | `src/session/` | 会话级业务（发送/审批/目标/命令/归档） | 「发送无反应 / 审批不显示」 → 这里 |
| L5 | `src/panel/` | 跟 webview 通信、HTML、命令、迁移 | 「点开图标没反应 / 协议错」 → 这里 |
| L6 | `src/extension.ts` | 装配 | 入口错改这里 |

## 3. 数据流（一次发送消息）

```
[User 按 Enter]
    ↓
[webview/app.tsx]  onKeyDown → submit()
    ↓ post({ type:'ui/promptSubmit', text })
[webview/lib/post.ts]
    ↓ acquireVsCodeApi().postMessage
[VS Code 桥]
    ↓ onDidReceiveMessage
[src/panel/provider.ts]  handleUiMessage → service.submit(text)
    ↓
[src/session/service.ts]  submit → 走斜杠分流 → SessionController.prompt / runCommand
    ↓
[src/connection.ts]  → ServiceManager / MuxClient
    ↓
[src/rpc/mux.ts]      → ws.send frame { type:'open', endpoint:'session/prompt', args:{...} }
    ↓
[src/process/manager.ts] / dsh web
    ↓
流反过来：事件流 → connection → service.viewmodel → provider.buildPanelState → post({type:'host/state'}) → webview 重渲
```

## 4. 三个「单一来源」原则

| 概念 | 唯一来源 | 谁消费 |
|------|---------|--------|
| 连接快照 | `ConnectionManager.snapshot` (L3) | service (L4) + provider (L5) |
| 面板状态 | `buildPanelState(...)` (L5 panel/state.ts) | provider → webview |
| UI 协议 | `src/panel/protocol.ts` (L5) | 宿主 + webview（import 自同一文件） |

## 5. 模块公共 API（import 入口）

| 想用 | import 自 |
|------|-----------|
| DSH Lite provider / 命令注册 / 一次性迁移 | `src/panel` |
| 连接 / 状态 / 错误描述 | `src/panel/{protocol,errors,state}` |
| 共享类型 | `src/model`（实际是 `src/model.ts`）|
| 配置 | `src/config` |
| 日志 | `src/log` |

详见 [`folder-map.md`](./folder-map.md)。
