# DSH RPC 契约快照 —— `/api/remote.mux`

> DSH 版本：**0.1.2-rc.1**（本机实测）　采集日期：2026-09-07
> 采集方式：`tools/probe.mjs`（起临时实例 → 令牌换 cookie → 直连 WS → 落盘真实帧）
> **本文件是 M2 及以后开发的唯一协议依据**。升级 DSH 后第一件事：diff `typert.remote-client.js`，再跑一次 probe 回归。

---

## 1. 连接与鉴权（实测，非推断）

### 1.1 三段判定，缺一不可

| 阶段 | 判定 | 失败表现 |
|---|---|---|
| ① Host/Origin 围栏 | `isTrustedApiRequest()`：Host 必须是 loopback 或 trusted-host；`Sec-Fetch-Site: cross-site` 直接拒；若带 `Origin` 必须与 Host 同源 | **403 forbidden** |
| ② Cookie 校验 | `browserAuth.isAuthenticated()`：需要本进程签发的有效 cookie | **401 unauthorized** |
| ③ 首页鉴权 | `authorizeIndex()`：**只作用于静态资源 fallback**（`GET /`），与 `/api/*` 无关 | `dsh web authentication required…` |

**实测记录**

```
GET /                                   → 401  "dsh web authentication required; …"
WS 升级 /api/remote.mux（无 cookie）     → 401  unauthorized
POST /api/session/list（无 cookie）      → 401  unauthorized
带 Sec-Fetch-Site: cross-site           → 403  forbidden
```

### 1.2 拿 cookie 的唯一正规途径

```
dsh --profile web --no-open --host 127.0.0.1 --port <port>
   ↓ stdout 打印就绪地址：http://127.0.0.1:<port>/?token=<launchToken>
GET 该地址（redirect: 'manual'）
   ↓ 303 + Set-Cookie
dsh-auth-<authorityHash>=<signed value>     ← 取 name=value 部分即可
```

- 启动令牌是**进程内存态**（`PROCESS_LAUNCH_TOKENS` WeakMap），**只在插件自己拉起 dsh 时才能拿到**。
- → 因此沿用 0.5.1 已验证的策略：**插件自起自有实例**；端口被 `dsh-auth`/`foreign` 占用时回退到空闲端口，不复用外部实例。
- Cookie 绑定 authority（host:port），换端口要重新交换。

### 1.3 Node 侧为什么不需要代理

0.5.1 的 `authproxy` 是为 **webview 跨站 iframe 带不上 `SameSite=Strict` cookie** 而存在的。
我们从 **Node 侧**发请求，可以任意设置 `Cookie` 头，且 Node 的 `fetch` / `ws` **不会自动带 `Origin`** → 天然满足围栏。

> ✅ 已实测：Node 侧 `new WebSocket(url, { headers: { cookie } })` 直连成功，无代理。

---

## 2. 线上帧格式

### 2.1 WebSocket 流（`/api/remote.mux`）

**客户端 → 服务端**

```jsonc
{ "type": "open",   "streamId": "s1", "endpoint": "session/control", "payload": { "args": {} } }
{ "type": "cancel", "streamId": "s1" }
```

**服务端 → 客户端**

```jsonc
{ "type": "item",  "streamId": "s1", "value": <一帧业务数据> }
{ "type": "end",   "streamId": "s1" }
{ "type": "error", "streamId": "s1", "error": { "code": "...", "message": "...", "details": {} } }
```

**心跳**：服务端每 **2s** ping 一次，`MAX_MISSED_HEARTBEATS = 2` → 连续漏 2 次即 `terminate()`。
`ws` 库自动回 pong，无需手动处理；自研客户端务必实现 pong。

### 2.2 一元 HTTP RPC

```
POST /api/<namespace>/<method>
Content-Type: application/json
Cookie: dsh-auth-...=...

{ "type": "client-request", "rpcId": "<uuid>", "method": "session/list", "payload": { "args": {} } }
```

响应：

```jsonc
{ "type": "server-response", "rpcId": "...",
  "result": { "ok": true, "value": { ... } }
          | { "ok": false, "error": { "code": "...", "message": "...", "details": {} } } }
```

> `method` 必须与 URL 路径端点一致，否则 `gateway/bad-request`。

### 2.3 ⚠ 头号坑：payload 必须是 `{ args: ... }`

`remoteRequest()` 强制校验 "exactly one plain-object args field"。

```
payload = {}                      → gateway/internal: Remote payload must contain exactly one plain-object args field
payload = { args: { _request:{} } } → ✅
```

且 `args` 内的字段名是**描述符里的 `wire` 名**，不是 TS 参数名：

```
session/list   → args = { "_request": { cursor?: string } }     ← 注意下划线
session/follow → args = { "request":  { address: {...} } }
```

---

## 3. 方法表（从 typert 描述符提取，权威）

`session` 命名空间（含 `fileReferences` / `skills`），格式为 `<namespace>/<method>`：

| 端点 | 调用 | wire 参数 | 可取消 | 说明 |
|---|---|---|---|---|
| `session/control` | direct | — | signal | **流**：`baseline{queues,jobs,projections}` + 增量，非会话清单 |
| `session/follow` | direct | `request` | signal | **流**：`snapshot` + `event` 增量 |
| `session/page` | direct | `request` | signal | **流**：历史分页 |
| `session/search` | direct | `request` | signal | 流 |
| `session/list` | direct | `_request` | signal | **unary**：会话清单 |
| `session/create` | direct | `request` | — | 新建会话 |
| `session/prompt` | direct | `request` | signal | 发消息 |
| `session/cancel` | direct | `request` | — | 停止 |
| `session/rename` | direct | `request` | — | 重命名 |
| `session/updateQueue` | direct | `request` | — | 队列控制 |
| `session/editLastPrompt` | direct | `request` | signal | **编辑重发** |
| `session/attachment` | direct | `request` | — | 附件/图片 |
| `session/fork` | direct | `request` | — | 分叉 |
| `session/selectModel` | direct | `request` | — | 选模型 |
| `session/modelCatalog` | direct | — | — | 模型目录 |
| `session/canOpenWorkspacePath` | direct | — | — | |
| `session/openWorkspacePath` | direct | `request` | signal | |
| `skills/list` | direct | `request` | signal | |
| `fileReferences/list` | direct | `agentId,agentId,query` | signal | |

> **升级 DSH 后第一件事**：重新提取这张表做 diff。提取方法见 §7。

---

## 4. 真实帧结构（抓帧所得）

### 4.1 `session/list` → 29 个会话

```jsonc
{ "items": [{
    "sessionId": "session-ee672aaf-…",
    "updatedAt": 1788761773121,
    "running": false,
    "blank": false,
    "cwd": "/Users/csl/Documents/dsh_data",
    "projections": { "asOfSeq": 1288679, "values": { "title": "自开发插件适配", … } }
    // 可选：parentSessionId, origin:"subagent"
}]}
```

→ **会话下拉条的数据源**：`sessionId` + `projections.values.title` + `updatedAt` + `running`。

### 4.2 `session/follow` → snapshot

```jsonc
{ "type": "snapshot",
  "header": { "version": 0, "id": "session-…", "createdAt": 1787410260514,
              "cwd": "/Users/csl/Documents/dsh_data", "delegationDepth": 0, "agentPreset": "standard" },
  "cursor": 1288679,
  "records": [ { "type": "event" | "chunks", … } ],     // 本次实例抓到 738 条
  "hasMore": true,
  "projections": { "asOfSeq": 1288679, "values": { … } } }
```

`projections.values` 可用键（对 UI 很有用）：

`title` / `goal` / `tokenUsage` / `contextPressure` / `contextBreakdown` / `sessionStats` /
`turnOutline` / `agentPreset` / `subagentTiming` / `subagent` / `permissions` / `modelSelection` /
`sessionListMetadata` / `imageLimits`

### 4.3 记录（record）与事件（event）

```jsonc
{ "type": "event",
  "event": { "type": "assistant/message", "seq": 1279980, "time": 1788801053017,
             "data": { … },
             "surfaceOp": "append" | { "op":"replace", "start":N, "end":M },
             "sourceEventSeqs": [ 1279822, 1279823, … ],   // 可选
             "ignorable": true } }                          // 可选
```

### 4.4 真实事件类型分布（一次采样，738 记录 = 641 event + 97 chunks）

| 事件类型 | 次数 | M2/M3 是否需要渲染 |
|---|---|---|
| `assistant/chunk` | 338 | ✅ 流式增量（chunks 记录） |
| `tool/result` | 48 | ✅ M4 工具卡片 |
| `assistant/message` | 47 | ✅ 主渲染 |
| `step/end` / `step/start` | 47 / 46 | ⚠ 可作为分组/折叠边界 |
| `tool/call` | 44 | ✅ M4 工具卡片 |
| `llm/retry` / `llm/retry-started` | 25 / 25 | ⚠ 提示态 |
| `todo/write` | 4 | ✅ 待办 |
| `compaction/prune` | 4 | ⚠ 上下文压缩提示 |
| `agent/inbox/spliced` | 4 | ⚠ |
| `user/message` | 3 | ✅ 主渲染 |
| `turn/end` / `turn/start` | 3 / 2 | ✅ 回合边界 |
| `request/header` | 1 | ⚠ |
| `session/end-seed` | (增量帧) | 内部 |

### 4.5 替换语义（编辑重发的关键）

- 采样中 **98 条**事件带 `surfaceOp`，其中 `assistant/message` 带 `sourceEventSeqs`（一长串被覆盖的旧 seq）。
- **规则**：出现 `surfaceOp:{op:"replace",start,end}` 或 `sourceEventSeqs` 时，UI 必须把对应 seq 区间/集合**折叠掉**，只渲染新事件。
- 这正是现有插件踩过坑的地方，M2 必须最先覆盖。

---

## 5. 开放问题回答进度（原 01-技术方案 §10）

| # | 问题 | 状态 |
|---|---|---|
| 1 | Node 侧连 mux 要不要额外头？ | ✅ **要 cookie，不要 Origin**；不得带 `Sec-Fetch-Site: cross-site` |
| 2 | `session.control` 字段？ | ✅ 是 `baseline{queues,jobs,projections}`，**会话清单走 `session/list`** |
| 3 | `session.prompt` 参数？ | ⚠ 契约已定（`request`），字段待 M3 前细读：含 `requestId`/`sessionId`/`mode: queue\|steer`/`content[]` |
| 4 | 停止用 `cancel` 还是 `updateQueue`？ | ⚠ 待 M3 实测（两者都在） |
| 5 | 审批事件结构？ | ⚠ 待 M4（`dsh-client-ui-approval` 包 + `permissions` 投影） |
| 6 | 附件/图片走哪个接口？ | ⚠ 待 M4：`session/attachment`（`{request:{sessionId,attachmentId}}`），可能需要 cookie |

---

## 6. 复用探针

```bash
node tools/probe.mjs                 # 自动起实例 → 抓帧 → 落盘 → 杀实例
node tools/probe.mjs --port 3199     # 指定端口
node tools/probe.mjs --keep          # 抓完保留实例便于手动观察
node tools/probe.mjs --only control  # 只抓某个流
```

夹具落在 `docs/api/fixtures/probe-<时间戳>.jsonl`。

---

## 7. 升级 DSH 后的回归清单

1. diff `dsh-api-session-controller/lib/typert.remote-client.js`（方法表 + 参数 wire 名 + zod schema）
2. diff `dsh-api-gateway/lib/index.js`（帧格式、心跳、错误码）
3. 重跑 `tools/probe.mjs`，与新夹具逐项对比
4. 更新本文件头部版本号，CHANGELOG 记"适配 DSH x.y.z"
