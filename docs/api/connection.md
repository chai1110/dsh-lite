# 连接层契约 —— 进程探测 / 端口 / 令牌换 cookie / WS / 重连

> 阶段：M1　状态：**待评审**
> 上级文档：`05-开发总规划.md` §M1　配套：`api/remote-mux.md`（wire 帧格式，本文不复述）· `design/宿主-UI协议.md`（状态如何上屏）
> 代码依据：0.5.1 `src/service/detect.ts` / `process.ts` / `manager.ts`（本机源码）；`tools/probe.mjs`（对 0.1.2-rc.1 实测通过）
> 一句话：**本文回答 M1 的四件事——怎么发现/拉起 dsh、怎么拿到 cookie、怎么建起稳定的 mux 连接、断了怎么办。**

---

## 0. 目标 / 非目标

### 目标
1. 扩展激活 + 侧栏打开后，**全自动**把 DSH 0.1.2-rc.1 的 `dsh web` 拉起来并完成「令牌 → cookie」交换（无需用户干预、不弹浏览器）。
2. 产品化的 `/api/remote.mux` 客户端：帧收发、心跳保活、断线自动重连、流重建；一元 HTTP RPC（`session/list`）打通。
3. 连接状态**单向、可观测**：内部状态机 → 对外快照 → 面板 `PanelState.connection`（UI 能如实显示 connecting / ready / offline / error）。
4. 会话清单可拉：`session/list` 产品化并映射为 `SessionBrief[]`（cwd 客户端过滤的规则在此定义，消费在 M2）。

### 非目标（M1 明确不做）
- ❌ 不复用任何外部 dsh 实例（含探测为免鉴权旧版 `dsh` 的情况）——见 §2 决策 A，与 0.5.1 不同。
- ❌ 不做 `--no-open` 崩溃降级（目标版本 0.1.2-rc.1 支持该参数；探测到旧版 dsh 属于「应升级」提示而非兼容对象）。
- ❌ 不自动重启已崩溃的 dsh 进程（防抖动；由用户按「重连」触发 restart，见 §6 L1）。
- ❌ `session/follow` / `page` 的窗口回放与补洞（M2 职责）；M1 重连后只重建 control 流 + 重拉 session/list。

---

## 1. 关键事实与约束（全部有源码/实测依据）

### 1.1 端口探测四态判定（沿用 0.5.1 `detect.ts`，一字不改地移植）

| 判定 | 探测结果 | 含义 | Lite 的处理 |
|---|---|---|---|
| HTTP 200 且首页含 `__DSH_BOOT__` | `dsh` | 免鉴权旧版 dsh（0.1.1-） | **不复用**（§2 决策 A），走端口回退 |
| 401/403 且响应体含 `dsh web authentication required` | `dsh-auth` | 0.1.2+ 新版，启动令牌在进程内存 | **不复用**（外部实例拿不到令牌），走端口回退 |
| 有 HTTP 响应但不是 DSH | `foreign` | 端口被其他程序占用 | 走端口回退 |
| 连接失败 / 超时 / 拒绝 | `down` | 未运行 | **视为空闲，可占用** |

- 超时：单次探测 **3s**（`AbortController`）；`redirect: 'manual'`（探测首页绝不能跟随 303）。
- 常量：`PORT_FALLBACK_ATTEMPTS = 50`（从 startPort+1 起逐端口探测，首个 `down` 即命中）。

### 1.2 进程启动形态（沿用 0.5.1 `process.ts`，生产已验证）

```
# POSIX / macOS
dsh web --host 127.0.0.1 --port <N> --no-open        # cwd 缺省 = 工作区根（存在时）
# Windows：.cmd 是 npm 批处理 shim，Node v24 直接 spawn 会同步抛 EINVAL
node <node.exe> <…/node_modules/@deepseek-ai/dsh/lib/bin.js> web --host … --port <N> --no-open
```

- **就绪地址解析**：stdout 首条匹配 `/dsh web: (https?:\/\/[^\s)]+)/`（`extractDshWebUrl`）——只认第一条，后续 HMR 重复输出不覆盖。
- 就绪行示例：`dsh web: http://127.0.0.1:3082/?token=<launchToken> …`
- Windows node 解析（`resolveWindowsNodeExecutable`，4 级）：shim 旁 `node.exe` → PATH 里 `node.exe` → 非 Electron 时 `process.execPath` 兜底 → 全失败抛 `NODE_NOT_FOUND`。
  **Electron 的 `execPath` 是 Code.exe，绝不能当 node 用**（dsh 的 loader/HMR 依赖系统 Node 内部特性，实测会崩）。
- spawn 选项：POSIX `detached: true`（脱离父进程组）、`windowsHide: true`、stdio `['ignore','pipe','pipe']`。
- 优雅停止：SIGTERM → 宽限 **3s** → SIGKILL（`stopChild`）。
- 父进程退出钩子：`process.once('exit')` 时 SIGKILL 子进程，防僵尸。
- cwd 容错（`sanitizeCwd`）：Windows 上 UNC（`\\…`）/不存在/相对路径一律过滤为 `undefined`，否则 spawn 同步抛 EINVAL。

### 1.3 令牌换 cookie（沿用 `probe.mjs` 实测序列，remote-mux.md §1.2 已记）

```
GET 就绪地址（redirect:'manual'）→ 303 → Set-Cookie
dsh-auth-<authorityHash>=<signed value>      ← 只取 name=value 段
```

- cookie **绑定 authority（host:port）**：换端口必须重新交换。本设计每次自启都从零走一遍（新令牌 + 新 cookie），天然满足。
- Node 侧请求手工带 `Cookie` 头，**绝不带 `Origin` / `Sec-Fetch-Site: cross-site`** → 天然通过 Host 围栏（remote-mux.md §1.3 实测结论：Node 直连不需要代理）。

### 1.4 心跳（remote-mux.md §2.1 实测）

- 服务端每 **2s** ping 一次，`MAX_MISSED_HEARTBEATS = 2` → 连续漏 2 次即 `terminate()`。
- 客户端只需**自动回 pong**：用 `ws` v8（`autoPong` 默认 true）即满足，无需手写定时器。

---

## 2. 端口与实例策略（决策记录）

### 决策 A：永远自起自有实例，不复用任何外部 dsh

| 场景 | 0.5.1 的做法 | **Lite 的做法** | 理由 |
|---|---|---|---|
| 端口探测 `dsh`（旧版免鉴权） | **复用**外部实例 | **不回退**（走端口回退，自起 0.1.2） | 客户端契约锁 0.1.2-rc.1；旧实例的 typert 帧/方法表不兼容，复用 = 慢性带歪契约 |
| 端口探测 `dsh-auth`（0.1.2+） | 回退端口，自起（**不可复用**：令牌在进程内存） | 同 0.5.1 | remote-mux §1.2 实测：外部实例拿不到令牌，无 cookie 一律 401 |
| 端口探测 `foreign` | 回退端口自起 | 同 0.5.1 | 端口被占用 |
| 端口 `down` | 直接自起 | 同 0.5.1 | 空闲即占用 |

**启动流程（探测结果 ≠ down 时）**：`findFreePort(3082, +1..+50)` → 首个空闲端口 → 自起 → 从**自有实例** stdout 取令牌。候选全被占 → `failed(err.portOccupied)`。

**并发场景（决策 1，05 总规划 §3.5）**：

| 端口 | 归属 | Lite 视角 |
|---|---|---|
| 3080 | 0.5.1 插件实例 | 不碰（不同端口） |
| 3081 | 用户手动/网页实例 | 不碰 |
| **3082** | **Lite 默认** | 空闲即自起；被占（任意类型）→ 回退 3083+ |

- 回退**只本次会话生效，不写 VS Code 配置**（沿用 0.5.1）；重启 VS Code 后恢复 `dshLite.advanced.port`（默认 3082）。
- host 固定 `127.0.0.1`，不配置（03-UI规格 §四 决策）。

### 决策 B：崩溃自愈沿用 0.5.1，但去掉「复用」分支

启动期间子进程提前退出（EADDRINUSE / 启动期被抢占 / 命令不支持）：
1. 探测一次端口——若已有 dsh 在跑：0.5.1 复用；**Lite 不复用**（决策 A），直接落入 2。
2. `autoStart` 且自愈轮数 < 3 → 换首个空闲端口重启（递归，轮数 +1）。
3. 超轮数 → `failed(err.startCrashed)`。

---

## 3. 状态机（服务层 `src/process/manager.ts`）

> 沿用 0.5.1 `ServiceManager` 的形态，**删掉** authProxy / i18n 键 / 复用分支，错误用 code 而非文案。

```
        ensureConnected()               启动完成(拿到cookie)
idle ──────────────────→ connecting ──────────────────→ ready
  ▲                          │  │                          │
  │   restart()/ui:refresh    │  │ 失败                      │ 进程意外退出 / 健康探测失联
  └───────────────────────────┘  ▼                          ▼
    stopping ──stop()──→ idle     failed ──(UI 提示)──→    idle(面板显示 offline/已断开)
```

| 服务状态 | 含义 | 触发 | 对 UI（`PanelState.connection`） |
|---|---|---|---|
| `idle` | 未启动 / 已停止 / 意外退出后 | 初始；stop；崩溃回退 | `idle` |
| `detecting` | 探测 3082 | ensureConnected | `connecting` |
| `starting` | spawn 子进程 | 探测非 down | `connecting` |
| `waiting` | 轮询等就绪（解析令牌 URL） | spawn 成功 | `connecting` |
| `ready` | 进程活 + 端口通 + 令牌 URL 已解析 | stdout 命中 / auth 宽限兜底 | `connecting`→（RPC 层再转 ready） |
| `failed` | 启动失败（各类 err.*） | spawn 错误 / 超时 / 崩溃 | `error` |
| `stopping` | 停止中 | stop() | `idle`（短暂） |

**就绪判定细节**：
- `waiting` 循环：探测 `dsh-auth` 且 `childAuthUrl !== null` → 服务层就绪（**Lite 不需要 display URL**：我们不嵌 iframe / 不开浏览器，就绪 URL 只用于取 cookie，不展示）。
- 宽限：探测到 `dsh-auth` 但连续 4 轮（每轮 pollMs）仍无令牌 URL → `failed(err.tokenParse)`。
  （0.5.1 在此时「无令牌地址兜底就绪」，那是为在 iframe 里展示 401 页面服务的；Lite 不嵌页面，没有令牌就拿不到 cookie → RPC 必然 401，兜底就绪无意义，直接判失败。）
- 启动总超时：**15s**（`startTimeoutMs`）→ `failed(err.startTimeout)`。
- 轮询间隔：**500ms**。

**spawn 错误分支**（同步抛 / `error` 事件，沿用 0.5.1 归因）：

| code | 归因 | 结果 |
|---|---|---|
| `EINVAL` | Windows spawn 参数无效（cwd 等） | 先去掉 cwd 重试一次；仍失败 → `failed(err.spawnEinval)` |
| `ENOENT` | 命令缺失 | `failed(err.dshNotFound)` |
| `NODE_NOT_FOUND` | Windows 找不到可用 node.exe | `failed(err.nodeNotFound)` |

**健康探测**：`ready` 后每 **30s** probe 一次；进程活着但服务不再是 DSH → 回 `idle`（RPC 层随之断开）。子进程 `exit` 事件同样回 `idle`（`handleUnexpectedExit`：先确认仍是当前 child，防 stop 竞态）。

---

## 4. 令牌换 cookie 序列（连接层第一步）

```
1. spawn（§1.2 形态）                        —— state: starting
2. stdout 累计缓冲，正则 /dsh web: (https?:\/\/[^\s)]+)/ 取第一条 → authUrl
3. fetch(authUrl, { redirect: 'manual' })   —— 期望 3xx + set-cookie
4. 取 set-cookie 的 name=value 段（dsh-auth-*=…）→ cookie
5. cookie 绑定 authUrl.origin；同一 origin 下 WS 与 unary 共用
```

**失败分类**：stdout 超时无 URL → `err.tokenParse`；fetch 非 3xx 或无 set-cookie → `err.cookieExchange`。
**注意**：Node `fetch` 不维护 cookie jar——每次请求手工带 `Cookie` 头；只带 name=value，不带 Path/Expires 等属性段。

---

## 5. WS mux 客户端（`src/rpc/mux.ts`，原创实现）

> 0.5.1 的 WS 全在 iframe/webview 里，宿主侧**没有** mux 客户端可抄——本模块以 `tools/probe.mjs` 的 `Mux` 类为原型做产品化。这是 M1 唯一需要「从 0 写协议客户端」的地方，参考物已实测可用。

### 5.1 依赖决策：bundle `ws` v8（runtime 0 依赖不变）

| 方案 | 结论 |
|---|---|
| **bundle `ws` v8（推荐）** | 纯 JS 可打进 `out/extension.js`；`autoPong` 默认 true，与 DSH 2s ping 心跳天然匹配；probe 已验证其行为 |
| `globalThis.WebSocket` | 扩展宿主是 Electron（Node < 21），**无全局 WS**；undici 的 ping/pong 也不保证自动应答。否决 |

- 实施：`ws` 放 devDependencies（供构建期打包），esbuild **external `bufferutil` / `utf-8-validate`**（可选原生加速，ws 内部 try-catch 处理缺失）；`.vscodeignore` 排除 node_modules → 产物仍 0 运行时依赖。
- `package.json` 的 `dependencies` 保持空（打包即依赖，与 05 总规划「0 运行时依赖」不冲突）。

### 5.2 接口（流句柄化，替代 probe 的「收集数组」）

```ts
interface MuxClient {
  connect(url: string, cookie: string): Promise<void>;      // 5s 握手超时
  open<T>(endpoint: string, args: Record<string, unknown>): MuxStream<T>;  // 见下
  cancel(streamId: string): void;
  close(): void;                                             // 主动关闭（clean）
  readonly state: 'idle'|'connecting'|'open'|'closing';
  onStateChange(cb): () => void;
}

interface MuxStream<T> {          // open() 返回的句柄
  onItem(cb: (v: T) => void): void;
  onEnd(cb: () => void): void;
  onError(cb: (e: { code: string; message: string }) => void): void;
  cancel(): void;                 // 发 {type:'cancel', streamId}
}
```

- 帧格式（open/item/end/error/cancel、`{args:…}` 包裹、wire 名）→ 见 `remote-mux.md` §2，不复制。
- 与服务端的关联：客户端生成 `streamId`，按帧内 `streamId` 分发到对应句柄。

### 5.3 心跳与死链判定

- 依赖 `ws` 的 `autoPong` 自动回 pong（DSH 服务端每 2s ping；漏 2 次服务端 terminate）。
- 客户端侧死链信号 = `ws.on('close')`（非我们主动 close）。**不必**自己发 ping。
- 服务端 `terminate()` 不留半开连接，close 事件会如实到达 → 重连判据可靠。

---

## 6. 重连策略（决策）

### 两层重连，各管各的

| 层 | 断因 | 行为 | 对 UI |
|---|---|---|---|
| **L1 服务层** | 子进程 exit / 健康探测失联 | **不自动重启进程**（防抖动）；状态回 idle | `offline`（曾连过）/ 首次失败是 `error`；用户点「重连」→ `restart()` |
| **L2 RPC 层** | WS 断（进程还活着） | **自动重连**，指数退避，成功后重建流 | `connecting`（重连期间）；全败 → `error(err.wsUnreachable)` |

### L2 重连算法（`src/rpc/reconnect` 内聚）

```
前提：仅「曾成功连上后又断」才自动重连；首次建连失败直接 error（不静默重试，用户按重连）
退避：1s → 2s → 4s → 8s → 16s（5 次，累计约 31s），每次握手超时 5s
成功：重建会话 = 重开 session/control 流 + 重拉 session/list → 对外发新快照
全败且进程仍在 → error(err.wsUnreachable)（UI 显示可重连）
进程在这期间 exit → 服务层接管 → offline
```

### 状态不丢的边界（M1 口径）

- **连接状态**：单向流转、由宿主唯一维护，UI 不做本地状态缓存（宿主-UI协议 §3）。
- **会话列表**：重连后由 `session/list` **重建**；M1 无消息渲染，天然不丢「消息」。
- 重连间隙丢失的增量事件：M1 不承诺（无 follow）；**M2 起 follow 窗口用 revision 校验 + 重放补齐**（写进 M2 文档）。

---

## 7. 对外接口（组合根 `src/panel/` 与 `extension.ts` 的装配）

```ts
// src/process/manager.ts         服务层状态机（探测/自起/回退/健康）
// src/rpc/mux.ts                WS mux 客户端 + L2 重连
// src/rpc/unary.ts              POST /api/<ns>/<method>（信封见 remote-mux §2.2）
// src/session/list.ts           session/list → SessionBrief[]（含 cwd 过滤规则）
// src/connection.ts             ConnectionManager：组合上三者，对外一个快照源
```

```ts
interface ConnectionSnapshot {
  phase: 'idle'|'connecting'|'ready'|'error'|'offline';   // 与 protocol.ts ConnectionState 对齐
  url: string | null;          // 就绪的带令牌地址（仅内部用于换 cookie/日志，不上 UI）
  error?: { code: string; message: string };
  sessions: SessionBrief[];    // ready 后由 session/list 填充
}
class ConnectionManager {
  ensureConnected(): Promise<ConnectionSnapshot>;   // 幂等：面板打开 / ui:refresh 触发
  reconnect(): Promise<ConnectionSnapshot>;         // 用户「重连」：L1 restart + L2 重连
  getSnapshot(): ConnectionSnapshot;
  onChange(cb): () => void;                          // provider 订阅 → 下发 host/state
}
```

- 触发时机：面板 `resolveWebviewView` 首次打开时 `ensureConnected()`（`autoStart` 默认 true）。
- `session/list` cwd 过滤规则（决策 3 落地）：入参只有 `{cursor?}` → **过滤在客户端**——按 `SessionBrief.cwd` 与工作区根匹配；无工作区时全显并保留 cwd 字段（M2 渲染用）。

---

## 8. 错误码目录（err.*，宿主侧全集）

> 分态约定：进程死后（曾连上）→ `offline` + `err.connectionLost`；其余启动/建连/重连失败 → `error` + 下表对应 code。
> UI 侧的处理与文案见 `design/宿主-UI协议.md` §4。

| code | 对应 connection | 触发 | UI 展示要点（工作稿，M5 打磨文案） |
|---|---|---|---|
| `err.connectionLost` | `offline` | 曾连上后进程意外退出 / 健康探测失联 | 已与 dsh 断开，点「重连」重新拉起 |
| `err.dshNotFound` | `error` | spawn ENOENT / 找不到 dsh.cmd | 未找到 dsh，请安装或设置 `dshLite.executablePath` |
| `err.nodeNotFound` | `error` | Windows 无可用 node.exe | 未找到 node.exe（检查 PATH） |
| `err.spawnEinval` | `error` | spawn 参数无效（Windows cwd） | 启动参数无效，重试 |
| `err.portOccupied` | `error` | 连续 50 个候选被占 | 端口全部被占用 |
| `err.startTimeout` | `error` | 15s 未就绪 | 启动超时，请重试 |
| `err.startCrashed` | `error` | 崩溃自愈超轮数 | 服务启动后崩溃 |
| `err.tokenParse` | `error` | stdout 无令牌 URL（4 轮宽限后） | 未能取得启动令牌，请重试 |
| `err.cookieExchange` | `error` | 令牌换 cookie 失败 | 认证交换失败 |
| `err.wsUnreachable` | `error` | 重连 5 次失败 | 连接断开，请重连 |
| `protocol-mismatch` | `error` | （M0 已有）协议版本不符 | 请重载窗口 / 更新扩展 |

---

## 9. 测试清单

### 9.1 注入式单测（`node --test`，假 spawn/fetch/ws/探测）

| 模块 | 用例 |
|---|---|
| detect | 四态判定矩阵（200+标记 / 401+文案 / 其他 HTTP / 超时）；URL 正则命中与容错；findFreePort 首个 down 命中与 65535 越界 |
| process | POSIX / Windows 的 spawn 参数组装；bin.js 推导；node 解析 4 级回退；EINVAL 去 cwd 重试 |
| manager | 状态机序列：down→自起→就绪；dsh-auth→回退→自起；foreign→回退；spawn ENOENT→failed；崩溃→自愈换端口→3 轮上限 |
| mux | 帧按 streamId 分发；end/error 终态；cancel 帧；连接超时；（假 ws 或本地 stub 对端） |
| session/list | 响应 → SessionBrief 映射；`blank`/缺 title 回退；cwd 过滤匹配/无工作区 |
| 协议 | 见 `design/宿主-UI协议.md` §7 |

### 9.2 本机实跑（环境有真 dsh 时，标 `--dsh=…`）

1. `tools/probe.mjs` 回归（最外层已覆盖，M1 后必须仍绿）。
2. 集成冒烟：spawn 真 dsh → cookie → WS 建连 → `session/list` 打印 N 会话 → 杀 dsh → 观察 offline → 重连（重新拉起）→ ready。

---

## 10. 验收对照（M1 定义，来自 05 总规划 §M1）

- [ ] 不打开 UI 也能产品化拉会话（extension 日志或集成测试输出会话数）。
- [ ] 断线自动重连且状态不丢：杀 dsh → UI 正确 offline；进程存活时掐 WS → 自动重连回 ready。
- [ ] 杀掉 dsh 后插件进入正确错误态（offline + 可重连，不白屏、不假 ready）。
- [ ] 端口回退：3082 被占（任意类型）→ 自动用 3083+，日志告知，不写配置。
- [ ] 与 0.5.1 并存：各自实例互不抢占（Lite 3082 系 vs 0.5.1 3080）。

---

## 11. 风险

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | 自起实例与用户手动/0.5.1 实例同开，多 dsh 守护进程占内存 | 资源开销 | 决策 1 端口错开 + 仅在面板打开时自起；可加 `autoStart=false` 完全关掉 |
| 2 | `ws` bundle 体积/兼容 | 产物变大或构建失败 | external bufferutil/utf-8-validate；构建期即验证 |
| 3 | 重连风暴（L1/L2 叠加） | 抖动 | 进程死了绝不自动重启；L2 退避封顶 5 次 |
| 4 | 旧版 dsh（0.1.1-）被探测为 `dsh` | 版本契约错配 | 决策 A 一律不复用；UI 提示「请升级 dsh ≥ 0.1.2-rc.1」 |

---

## 附录 A：与 0.5.1 的差异点（实现时对照，防止惯性照抄）

| 维度 | 0.5.1 | **Lite（M1）** | 原因 |
|---|---|---|---|
| 复用外部实例 | 探测 `dsh`（旧版）时复用 | **一律不复用，自起** | 契约锁 0.1.2-rc.1（§2 决策 A） |
| 鉴权代理 | iframe 跨站需要 authproxy | **不需要**（Node 直连带 Cookie） | remote-mux §1.3 实测 |
| WS 客户端 | iframe 内 DSH 自带 | **宿主原创 mux.ts**（probe 产品化） | 0.5.1 宿主无此模块 |
| 启动形态 | `web --host … --no-open` | 相同 | 生产已验证 |
| 旧版 `--no-open` 降级 | 识别 stderr 后去掉参数重启 | **不做**（目标版本支持） | 目标锁 0.1.2-rc.1 |
| 进程崩溃自愈 | 复用优先 | 复用 → 直接换端口重启 | 决策 A |
| 面板展示 URL | iframe 直连/代理地址 | 无展示 URL（不嵌 iframe） | 形态不同 |
