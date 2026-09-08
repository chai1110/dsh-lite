# M3 设计 · 会话写入（docs/api/prompt-and-control.md）

> 状态：✅ prompt/cancel/create 已实现并提交（commit 514bce3，M2/M3 同批）；rename、斜杠提示见 §4 挂起项。
> 契约依据 docs/api/remote-mux.md §3（session 命名空间）+ 本文件填 3、4 号开放问题（以真实 dsh 实测为准，见 §5）。

## 1. 三个写操作（已实现，src/session/api.ts）

统一信封：`POST {origin}/api/<method>`，`{type:'client-request', rpcId, method, payload:{args}}`，
header `cookie`。响应信封 `result` 为 `{ok:true,value}|{ok:false,error}`（src/rpc/unary.ts）。

| 方法 | 入参（payload.args） | 返回值取用 | 超时 |
|---|---|---|---|
| `session/create` | `{request:{ cwd? }}`（cwd=工作区根，M3 决策） | `value.sessionId ?? value.id` | 10s |
| `session/prompt` | `{request:{ sessionId, requestId:uuid, mode:'queue'\|'steer', content:[{type:'text',text}] }}` | `value.accepted` | 15s |
| `session/cancel` | `{request:{ sessionId }}` | `value.accepted` | 10s |

## 2. 写入边界（源自 docs/05-开发总规划.md §3.5 决策 2 的落点）

- Lite **对任何会话都开放 prompt/cancel**（不做「仅本会话新建才可写」的硬限制）——
  实际约束来自 UI：用户只能看到/选中 `session/list` 按 cwd 过滤后的会话（工作区根），
  天然聚焦于本工作区。
- 并发写同一会话的损坏风险（决策 2 提到的 M3 专项）→ 降级策略：
  - `dshLite.followUpQueueMode`（默认 `queue`）：运行中再次发送 → mode:'queue' 排队，避免打断；
  - 更激进的 'steer' 仅在用户显式改配置后生效。
  - 服务端多客户端并发写（Lite 与网页端同时）属 DSH 侧语义，不在本文件承诺——留 §5 实测。

## 3. 乐观 UI（M3 体验关键）

- `SessionService.submit()` 先置 `pendingOptimistic` 并 emit（UI 立即出现用户气泡），再发 prompt。
- 回声去重：DSH 会把用户消息作为 `user/message` 事件回流到 follow 流；
  当最后一条真实 user 条目文本 == 乐观文本时，`getMessages()` 自动丢弃乐观占位（service 单测覆盖）。
- 发送失败（HTTP/业务 error）→ 清乐观占位 + 记日志（当前 UI 不做 toast，见 §4 打磨项）。

## 4. 挂起/明确不做（记档，避免 M5 误当 bug）

1. **rename**：DSH 0.1.2 follow 快照 projections 里 title 是派生值；契约中未见 `session/rename`
   端点名与其参数。**不做**（不改名入口）。若后续确认真实端点（如 `session/update`），再补。
2. **`/` 斜杠命令提示**：任何文档/抓帧都没有 dsh 原生斜杠命令清单（grep docs/、src/ 无命中），
   UI 臆造列表会误导用户。**不做提示条**；`/` 开头内容照常按普通文本发送，由服务端解析。
3. **发送失败 toast / 错误回显到消息区**：M5 打磨项（沿用宿主日志输出通道）。

## 5. 仍需真实 dsh 核对（终端跑 DSH_LITE_E2E=1 后人工确认）

- [ ] `session/create` 返回值键名（sessionId vs id）——防御式两者都取，但需实测定死
- [ ] `session/prompt` 的 `mode` 字段是否真实生效（queue/steer 语义）——M3 决策 2 的并发写专项
- [ ] 多客户端并发写同一会话的日志损坏与否
- [ ] `session/cancel` 在无运行回合时返回什么（accepted=false 还是 error）

> 说明：本沙箱内 dsh boot 受 `~/.dsh/.credentials.yaml.lock` 写锁竞争影响无法可靠完成
> （插件加载器上百个条目并发写凭证，自身竞争锁 → atomic-write 30s 超时崩溃），
> 上述核对须在用户本机正常终端执行。
