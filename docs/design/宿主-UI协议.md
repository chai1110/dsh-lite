# 宿主 ↔ UI postMessage 协议（v1 语义补全，M1 版）

> 阶段：M1　状态：**待评审**
> 上级文档：`05-开发总规划.md` §5.2　代码契约：`src/panel/protocol.ts`（**唯一共享契约**，两侧都从它 import）
> 配套：`api/connection.md`（状态从哪来）、`api/remote-mux.md`（DSH 侧 wire）
> 一句话：**protocol.ts 是类型定义，本文是它的语义说明书——六态怎么流转、每个字段 M1 时取什么值、错误码双方怎么约定、UI 这个阶段该画什么。**

---

## 0. 设计原则（回顾 + M1 补充）

1. **UI 只渲染，不做业务**：所有状态由宿主维护；webview 只收快照（`host/state` 全量覆盖）与少量指令。
2. **版本化握手**：`hello` 先于一切；不匹配显示 `mismatchHint`（reload / upgrade），绝不静默降级。
3. **快照是唯一事实源**：UI 不得本地缓存会话/消息做「增量自洽」——重连后宿主重建并整包下发。
4. **M1 协议形状不变**（仍 v1），只补语义：`connection` 状态机跑起来、`sessions` 有值、`ui/refresh` 真正接线、错误码目录双方对齐。

> **版本号纪律**：新增消息 type 是**向后兼容**的（UI 遇未知 type 忽略；宿主遇未知 type 记日志忽略）→ v1 可一路用到 M3。
> 只有**形状破坏性变更**（如 `PanelState` 增必填字段、删字段）才升 v2 + `mismatchHint` 分支。M2/M3 若只加字段，用可选字段 + 默认值，不升版。

---

## 1. 消息总表

### 1.1 UI → 宿主（`UiMessage`）

| type | 载荷 | 时机 | M1 行为 |
|---|---|---|---|
| `hello` | `{ protocolVersion }` | UI 挂载后第一条 | 宿主校验版本：不符 → `host/error(protocol-mismatch)`；相符 → `host/hello` + `postState()` |
| `ui/ready` | — | UI 挂载完成（React effect 尾部） | 宿主补发一次当前快照（握手与挂载顺序不保证） |
| `ui/refresh` | — | 用户点「重连」 | **M1 接线**：触发 `ConnectionManager.reconnect()`（进程没了 → restart；进程在 → L2 重连） |

### 1.2 宿主 → UI（`HostMessage`）

| type | 载荷 | 时机 |
|---|---|---|
| `host/hello` | `{ protocolVersion }` | `hello` 校验通过后 |
| `host/state` | `{ state: PanelState }` | ①`hello` 应答后 ②`ui/ready` ③**任何连接/会话状态变化** |
| `host/error` | `{ code, message }` | 握手期致命错误（protocol-mismatch）与一次性提示 |

> **分工约定**：`host/error` 只管「握手期 + 一次性提示」；**一切状态类错误必须走 `host/state.error`**（保证 UI 渲染只有一个事实源，避免 error 消息与快照打架）。M0 里 `host/error` 仅 protocol-mismatch 一条，M1 保持不变。

---

## 2. 连接状态机（六态，UI 与宿主共同理解）

> 代码契约里 `ConnectionState = 'idle' | 'connecting' | 'ready' | 'error' | 'offline'`。语义补全如下。

```
                 ensureConnected()            RPC 就绪(WS open + 心跳正常)
 idle ──────────────────────────→ connecting ────────────────→ ready
  ▲                                  │  │                        │  │
  │                                  │  │启动/建连失败             │  │WS 断(进程在)→L2 自动重连→connecting
  │                                  │  ▼                        │  ▼
  │         reconnect()              │ error ──┐                 │ 进程退出→offline(不自动重启)
  └──────────────────────────────────┘         │                 │
     (error/offline 下用户点重连)                 │ 用户点重连          │
                                                └────────► idle ◄──┘
```

| 态 | 含义 | 何时进入 | 何时离开 | M1 UI 表现 |
|---|---|---|---|---|
| `idle` | 未连接（初始/已停/进程意外退出后待命） | 初始；stop；进程 exit | ensureConnected | 空态 + 「启动」按钮（若 autoStart 则自动走，通常一闪而过） |
| `connecting` | 服务层探测/启动/等待 + RPC 层建连/重连 | ensureConnected；L2 自动重连 | 成功 → ready；失败 → error | 状态条「连接中…」 |
| `ready` | 进程活 + WS open + 心跳正常 + 会话可拉 | RPC 就绪 | WS 断 / 进程退出 / 健康失联 | 状态条「已连接」+ 主体（M1 为占位） |
| `error` | 可重试失败（需用户操作） | 启动/建连/重连失败 | 用户点「重连」 | 错误文案 + 「重连」按钮 |
| `offline` | 曾连上后进程死亡/彻底失联（不自动重启） | ready → 进程 exit / 重连全败后进程也没了 | 用户点「重连」 | 「已断开」+ 「重连」按钮 |

**流转约束（宿主实现时必须遵守）**
1. `offline` 只能从 `ready` 到达（「曾连上」是 offline 的语义前提）；首次启动就失败只进 `error`，不进 `offline`。
2. `connecting` 是**瞬态**，宿主必须在进入后启动超时守卫（服务层 15s / RPC 握手 5s），不得永久停留。
3. L2 自动重连期间对外呈现 `connecting`（不抖动回 idle）；重连全败才定格 `error(err.wsUnreachable)`。

---

## 3. `PanelState` 逐字段语义（M1 取值规则）

```ts
interface PanelState {
  connection: ConnectionState;      // §2 状态机
  sessions: SessionBrief[];         // M1 起有值：ConnectionManager 重建后整包下发
  activeSessionId: string | null;   // M1 恒 null（会话下拉/选择是 M2）
  messages: ViewMessage[];          // M1 恒 []（消息流是 M2）
  error?: { code: string; message: string };  // 仅 connection ∈ {error, offline} 时有值
}
```

| 字段 | M0（现状） | **M1** | M2+（预告） |
|---|---|---|---|
| `connection` | 恒 `idle` | **真实流转**（§2） | 同 |
| `sessions` | 恒 `[]` | **session/list 产品化后填充**；重连重建 | 同 + 按 cwd 过滤可选展示 |
| `activeSessionId` | null | null | 用户选中会话 |
| `messages` | `[]` | `[]` | follow/page 窗口产出 |
| `error` | 无 | `error`/`offline` 时携带 code | 同 |

**快照推送节流**：状态变化低频（探测/启动/就绪/重连），**不做节流**；每次变化整包推 `host/state`，UI 无脑覆盖。

---

## 4. 错误码 → 展示映射（双方共用一份）

> 完整触发表见 `api/connection.md` §8；这里只约定「UI 收到后怎么处理」，保证宿主与 UI 不各写一套。

| connection | error.code | UI 处理 | 展示文案（工作稿） |
|---|---|---|---|
| `error` | `err.dshNotFound` | 常态渲染 + 重连按钮 | 未找到 dsh，请安装或设置 dshLite.executablePath |
| `error` | `err.nodeNotFound` | 同上 | 未找到 node.exe |
| `error` | `err.spawnEinval` | 同上 | 启动参数无效，请重试 |
| `error` | `err.portOccupied` | 同上 | 端口全部被占用 |
| `error` | `err.startTimeout` | 同上 | 启动超时，请重试 |
| `error` | `err.startCrashed` | 同上 | 服务启动后崩溃 |
| `error` | `err.tokenParse` | 同上 | 未能取得启动令牌 |
| `error` | `err.cookieExchange` | 同上 | 认证交换失败 |
| `error` | `err.wsUnreachable` | 同上 | 连接断开，请重连 |
| `offline` | `err.connectionLost` | 常态渲染 + 重连按钮 | 已与 dsh 断开 |
| `error` | `protocol-mismatch` | **全屏**错误态（无重连按钮） | 面板与扩展协议版本不一致：请重载窗口 / 更新 DSH Lite |

> 规则：`offline` 统一配 `err.connectionLost`（语义=曾连上、进程没了）；其余失败态一律 `error` + 具体 code。UI **不得**根据 code 拼业务逻辑，只做「展示文案 + 是否允许重连」。

---

## 5. M1 UI 行为规格（webview 侧最小实现）

> 视觉细则以 `03-UI规格.md` 为准；本节只定义 M1 必须能演示的最小行为。主体布局（顶栏三件套/输入框）M2 才完整，但 M1 就绪后应已呈现**可运行的三行框架**。

### 5.1 结构（沿用 M0 三行框架）

```
┌────────────────────────────┐
│ 顶栏（M2 完整：标题/新会话/历史） │  ← M1 仅占位
├────────────────────────────┤
│ 状态条（M1 核心）              │  ← connection 的唯一直观出口
├────────────────────────────┤
│ 主体 / 输入框（M2）           │  ← M1 占位（见 5.3）
└────────────────────────────┘
```

### 5.2 状态条（M1 核心交付）

| connection | 状态条内容 | 可交互 |
|---|---|---|
| `idle` | 「未连接」 | [启动]（= 发 `ui/refresh`） |
| `connecting` | 「连接中…」 | 无 |
| `ready` | 「已连接」+（M1 起可附）「N 个会话」 | 无 |
| `error` | error.message | [重连]（= 发 `ui/refresh`） |
| `offline` | 「已断开」 | [重连] |

> M1 不引入 spinner/动画等视觉资产；文案颜色可用 `--vscode-errorForeground` / 默认前景区分，M5 统一打磨。

### 5.3 主体与输入框

- 主体：`ready` 时显示空态占位「会话与消息将在下一步提供」；其余状态跟随状态条。
- 输入框：**渲染但禁用**（灰态，占好位）；M3 才接线——提前占位避免 M2 布局返工。
- **sessions 到了也不渲染列表**：下拉是 M2 交付。M1 中「会话可拉」的验证走宿主日志/集成测试（connection.md §9.2），UI 只需让 `ready` 成立。

### 5.4 时序（hello 握手，M0 已实现，M1 不变）

```
webview mount
  → post {type:'hello', protocolVersion:1}
宿主: 校验
  → 不符: post {type:'host/error', code:'protocol-mismatch', …}     (UI 全屏错误, 不再发消息)
  → 相符: post {type:'host/hello'} + post host/state(当前快照)
UI 收到 host/hello → effect 尾部 post {type:'ui/ready'}   (宿主再补一帧快照)
此后宿主在状态变化时持续 post host/state
```

---

## 6. M2/M3 扩展预留（不升版的做法，供规划对照）

| 阶段 | 新增 | 方式 |
|---|---|---|
| M2 | 会话下拉选择 | 复用 `host/state`（`activeSessionId` 由宿主填）；UI 增 `ui/selectSession` |
| M2 | 消息流 | 复用 `host/state`（`messages` 由宿主填）；增量走 M2 视图模型文档，仍以快照为主 |
| M3 | 发送 | UI 增 `ui/promptSubmit`；宿主回 `host/state`（streaming 字段已在 ViewMessage 预留） |
| M3 | `/` 斜杠命令 | UI 内渲染 DSH 原生清单（宿主经 RPC 拉取后随 state 下发，或本地按需请求） |
| 任意 | 双向新增 type | **向后兼容，不升版**；仅形状破坏才 v2 |

> 预留字段：`ViewMessage.streaming`（M0 已定义）等均已在 `protocol.ts` 就位，M2/M3 直接使用。

---

## 7. 协议层单测（`test/protocol.test.ts` 扩展）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 编解码两侧一致 | `UiMessage`/`HostMessage` 形状对拍（现有） |
| 2 | 版本不匹配 → mismatchHint | lower→reload / higher→upgrade（现有） |
| 3 | 未知 type 忽略 | UI 侧 reducer / 宿主侧 switch 默认分支：无异常、无状态变更（新增） |
| 4 | 六态流转合法 | 状态机守卫：`offline` 只能来自 `ready`；`connecting` 不可永久停留（宿主侧状态机单测，新增） |
| 5 | error 携带规则 | `error`/`offline` 必有 error.code；其他态必无（宿主侧快照校验，新增） |

---

## 8. M1 验收对照（UI 部分）

- [ ] 打开侧栏：状态条从「未连接/连接中」走到「已连接」（真 dsh 环境），全程无假 ready。
- [ ] 杀掉 dsh：状态条正确变「已断开」，点「重连」能重新拉起并回到「已连接」。
- [ ] 进程存活时制造 WS 断（如暂停网关）：自动重连回「已连接」，不闪错误、不白屏。
- [ ] `protocol-mismatch` 路径仍可用（改 protocol.ts 版本号临时验证，验完还原）。
