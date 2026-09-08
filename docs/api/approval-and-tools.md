# M4 设计 · 工具 / 审批 / 变更（docs/api/approval-and-tools.md）

> 状态：🚧 进行中（工具渲染增强；审批见 §1 实测结论）
> 目的：填 docs/api/remote-mux.md §5 的 5、6 号开放问题。结论以 0.1.2-rc.1 真实抓帧为准
> （docs/api/fixtures/sample-0.1.2-rc.1.json，2026-09-07 采集，非臆造）。
>
> **2026-09-07 勘误（M6 前置，见 docs/design/Cline功能评估.md）**：§1 的「follow 流不含审批帧」仅对
> 本机 `danger-full-access` 会话成立。装机包审计证明 0.1.2-rc.1 的审批契约真实存在
> （`approval/asked` server-request + 客户端应答 echo rpcId，outcome `allowed-once|rejected`；
> 事件全集 known-event-types.js 共 43 类）。审批卡 UI 列入 **M6c** 补齐；「变更 diff」维持不做。

## 1. 实测：follow 流里到底有哪些帧（§5 开放问题 5、6 的答案）

抓帧会话统计（eventTypeCounts，共 15 类 / 738 条记录）：

| 帧类型 | 计数 | 结论 |
|---|---|---|
| `assistant/chunk` | 338 | 流式正文（data={turn,step,chunk}） |
| `tool/result` | 48 | **工具结果存在**（形状未在抓帧展开，防御式渲染） |
| `assistant/message` | 47 | 定稿 |
| `step/start` / `step/end` | 46/47 | 步骤生命周期 |
| `tool/call` | 44 | **工具调用存在**（形状未展开，防御式渲染） |
| `llm/retry*` | 25/25 | 状态 |
| `todo/write` / `compaction/prune` | 4/4 | 状态 |
| `agent/inbox/spliced` | 4 | 状态 |
| `user/message` | 3 | 输入 |
| `turn/*` / `request/header` | 2/3/1 | 状态 |

**关键结论**：
1. **0.1.2-rc.1 的 follow 事件流不含审批事件**（approval/permission 类计数为 0）——
   本机 profile `permissions.currentValue = "danger-full-access"`（快照 projections 实测），
   一切工具自动执行，没有待批卡片可发。
2. **不含离散的文件变更/编辑事件**——文件修改是 tool/call 的副作用（写文件由工具执行完成），
   事件流里没有 Claude-Code 式 `acceptProposedDiff` 的独立帧。
3. 附件/图片：user/message 的 data.content 是块数组（imageLimits 实测存在），
   **图片/附件块会真实出现**，Lite 无法内嵌渲染 → 降级为占位说明。

## 2. Lite 的 M4 范围（只做有真实帧支撑的部分）

### 2.1 工具条目渲染增强（真实帧：tool/call 44 次、tool/result 48 次）
- `tool/call`：等宽字体命令行（`name(args)`），灰底描边。
- `tool/result`：结果文本默认折叠，点「展开/收起」查看；
  视图模型存储上限 **2000 字符**（防大结果每次下发全量撑爆 postMessage），超出截断加标记。
- 状态条不渲染为工具卡片（保持 text-first）。

### 2.2 content 块感知的文本提取（真实帧：content 块数组 + imageLimits）
- text 块 → 正常文本；image 块 → `[图片附件]` 占位；
  其它带 type 的无文本块 → `[附件:<type>]`；避免把整段 JSON 糊进对话。

### 2.3 变更 / 审批卡片（不做，记档原因）
- 帧源不存在（§1 结论），UI 臆造 allow/deny 卡或 diff 卡会让用户对着永不出现的控件操作。
- 若未来 dsh 暴露审批/编辑帧（换权限档位或版本演进），再按当时契约实现：
  设计草图（不实现）：`approval/*` 事件 → 卡片 + 允许/拒绝 → 对应 `session/control` 应答续跑；
  `change/*` 事件 → 宿主侧 `vscode.diff` 原生对比。

## 3. 验收

- [x] tool/call + tool/result 进入消息流（M2 已有，viewmodel 单测覆盖）
- [x] tool/result 折叠/展开 + 2000 字截断（viewmodel cap + MsgRow toggle，70 测通过）
- [x] 图片/附件块降级占位（textOf content 块解析：`[图片附件]`/`[附件:<type>]`）
- [ ] 真实 dsh 跑「一次含写文件+命令的任务」渲染核对（终端 DSH_LITE_E2E 后人工）
- [ ] 审批/变更卡片：**明确不做**（§1 依据）

## 4. 变更记录
- 2026-09-08：初稿，依据 0.1.2-rc.1 抓帧定范围。
