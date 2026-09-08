# M6 前置 · Cline 功能评估与 DSH Lite 补齐方案（docs/design/Cline功能评估.md）

> 日期：2026-09-07 夜 · 依据：本机已装插件 fengze233/dsh-vscode-panel 0.5.1、
> shengsuan-cloud.cline-shengsuan 4.2.8（= DM010727/dsh-cline 构建产物）+ 其源码、
> 装机 dsh 0.1.2-rc.1 的 `node_modules/@deepseek-ai/*` 实证审计 + deepseek-harness 源码。

## 1. dsh-cline 是什么（学到的东西）

- 形态：**iframe 内嵌 DSH 官方 Web 客户端**（与 0.5.1 同一思路），外加一批打进 DSH 进程的
  host-services 插件（diff-mirror / checkpoint / vscode-tool / task-injector / mcp-loader / web-gateway）。
- 「Cline 功能」实为三块：
  1. **DSH Web 原生功能**（斜杠命令平面 / 目标 / 审批 / 提问 / plan·act / todo / 子代理 / MCP…）
     —— 由官方 web UI 提供，后端契约在 0.1.2-rc.1 装机包中**全部存在**；
  2. **Cline 式编辑器 shell**：实时编辑 diff（tools/pre-execute 写前拦截 + 滚动揭示）、
     编辑器右键动作（添加/解释/优化）、`@文件` 上下文、vscode 工具、checkpoint 恢复 —— 靠 DSH 进程内插件；
  3. **胜算云商业层**（OAuth、模型选择、余额卡）—— 与 DSH Lite 无关，略。

## 2. 0.1.2-rc.1 后端契约实证（修正此前 M3/M4 的「没有/不做」结论）

装机包审计（`dsh-session/lib/types/known-event-types.js` = 43 类事件全集；
`dsh-api-session-controller/lib/typert.host.js` = remote.mux 宿主面）：

| 功能 | 后端契约（0.1.2-rc.1 实测存在） | 此前结论 | 修正 |
|---|---|---|---|
| 斜杠命令 | `dsh-commands` 命令平面；`/` 开头由适配层 execute，不进模型历史；`command/run`/`command/done` 为日志事件；自带 command-goal/compact/feedback | M3「无命令清单，不做提示」 | 契约真实存在 → M6 补发现+执行 |
| 目标（勾目标） | `goal/change` 事件进 mux 全客户端可见；goals API create/edit/pause/resume；读侧=goal projection；goal-round-driver 自动续跑 | （未评估） | 契约真实存在 → M6 补轻量展示+入口 |
| 审批 | `approval/asked` server-request(稳定 rpcId) → 客户端应答(echo rpcId) outcome `allowed-once`/`rejected`；`approval/decided|policy`；权限档位 permission-presets 可切 | M4「follow 无审批帧，不做卡片」 | 无帧只因会话是 danger-full-access；协议在 → M6 补卡片+应答 |
| 提问 | user-questions / tool-ask-user（question 帧 + 应答通道） | （未评估） | M6 低优先 |
| 编辑重发 | sessionController typert 有 `editLastPrompt` 方法（web「编辑重发」的后端本体） | M2 只做了 shadow 折叠消费 | 可选 M6 接入（发送侧） |
| 变更 diff | **无离散 change 帧**；文件修改是 tool 副作用，写前拦截需要 DSH 进程内插件(diff-mirror) | M4 不做 | **维持不做**（见 §3） |
| 其它事件 | plan/mode、permission/preset、sandbox/mode、model/selection、session/title、schedule/change、subagent/*、team/*、hook/* 等 | 未知 → 乱渲染 | M6a 已补（状态行/静默分类，72 测过） |

## 3. 冗余性判断（用户问题：Cline 功能冗不冗余）

**「DSH 原生 Agent 能力」（斜杠/目标/审批/提问…）**：必要、且在 Lite 里**不冗余**——
它们是对话/agent 交互的一部分，Lite 作为直连 remote.mux 的替代壳，必须能消费与应答，
否则等于把功能剪没了（正是用户强调「功能都要有、只是界面精简」的点）。

**「Cline 式编辑器 shell」（实时 diff 拦截 / 编辑器内写前确认 / 选中右键 / vscode 工具 /
checkpoint 恢复）**：在 DSH Lite 里**冗余**，不加。理由：
1. 与 Lite「一页到底、宿主只做会话与对话」的定位冲突，等于再做一个 0.5.1；
2. 需要 DSH 进程内插件（pre-execute 钩子）与编辑器文档宿主的大量机制，
   而用户已装有 0.5.1 与 dsh-cline 两个这类插件，重复；
3. 它们解决的是「编辑安全」问题——DSH 侧已有等价物：切权限档位后用**审批卡**兜底，
   Lite 补审批即可获得同样的安全闸，不必复制编辑器 shell。

**胜算云商业层**：无关，忽略。

## 4. M6 补齐方案（只加后端功能，UI 维持极简一页）

| 阶段 | 内容 | UI 呈现（极简） | 依赖 |
|---|---|---|---|
| M6a ✅ | 事件认知补齐（状态行/静默分类） | 无需新 UI | 已完成（72 测通过） |
| M6b | 斜杠命令平面：命令发现 + `/` 输入联想 + execute 通道 + command/run·done 渲染 | 输入框 `/` 联想小浮层；结果进消息流 | typert 命令方法名（M6b 实现时核实） |
| M6c | 审批 + 提问：approval/asked 卡（允许一次/拒绝）→ 应答；permission 档位切换入口 | 消息内嵌卡片，样式同工具卡 | respond 帧格式（已文档化于 apiproxy） |
| M6d | 目标：goal/change 状态 + create/pause/resume 入口 | 会话「⋯」菜单小项，不进顶栏 | goals unary 方法名核实 |
| M6e | 打磨回归 + 真实 dsh 全量核对（终端） | — | 用户本机 |

## 5. 变更记录
- 2026-09-07：初稿。M3/M4 文档的「不做」结论勘误见 docs/api/prompt-and-control.md、approval-and-tools.md。
