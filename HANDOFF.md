# DSH Lite 交接文档（HANDOFF）

> 给一个**完全没有上下文**的新对话快速了解 + 衔接工作用。
> 最后更新：2026-09-29（0.1.0 iframe 架构重构完成 + dsh 0.2.0-rc.2 升级验证），作者：csl × ZCode。
>
> 项目一句话：DSH 的轻量 VS Code 侧栏客户端 `chai1110.dsh-lite`——**iframe 嵌入官方界面 + 本地代理**，
> 只隐藏设置入口；与 `chai1110.dsh-vscode-panel`（0.5.4 fork）共存。

---

## 0. 仓库 + 工作目录

| 项 | 路径 / 值 |
|---|---|
| 仓库根 | `/Users/csl/Documents/dsh_data/dsh-vscode-lite` ⚠️ **不在会话目录** |
| GitHub | https://github.com/chai1110/dsh-lite（PUBLIC） |
| 默认分支 | `main`，SSH remote `git@github.com-chai1110:chai1110/dsh-lite.git` |
| 当前版本 | **0.1.0**（2026-09-29 打包安装） |
| 兄弟仓库 | `dsh-vscode`（0.5.4 fork）/ `dsh-custom-patches` / `dsh-provider-config`，同在 `~/Documents/dsh_data/` |

## 1. 当前架构（0.1.0 iframe 重构后）

**用户决策（原话）**："直接用原版官方界面（iframe 嵌入），隐藏设置入口，历史集合在顶栏，模型选择要有"——
即官方啥样 Lite 就啥样，只少设置。

| 层 | 文件 | 职责 |
|---|---|---|
| 扩展入口 | `src/extension.ts` | 命令/视图接线、配置消费、代理生命周期 |
| 连接层 | `src/connection.ts` + `src/process/` | dsh 自起（默认 3082 占用回退）→ 启动行解析 → 令牌换 cookie → 就绪快照 |
| 本地代理 | `src/service/proxy.ts` | **cookie 注入**（跨站 iframe 带不上 SameSite=Strict）、**注入 `data-dsh-lite` CSS 隐藏设置入口**、WS 升级（`/api/remote.mux`）原样转发 |
| 面板 | `src/panel/`（provider/html/errors/index） | 三态壳（loading/error/ready）+ ready 页全幅 iframe 指向代理 |

**退役**（0.1.0 起删除，勿再引用）：`webview/`（React 渲染全套）、`src/rpc/`、`src/session/`、
`src/panel/{protocol,state}.ts`、`src/model.ts`——官方页面自己承担渲染/RPC/会话管理。

## 2. 当前状态与验证证据（2026-09-29）

- `npm run typecheck` 清零；`npm test` **33 过 / 0 失败 / 1 跳过**（跳过 = 真 dsh 集成，需 `DSH_LITE_E2E=1`）
- **真机 smoke PASS**（对 launchd 常驻 dsh `0.2.0-rc.2` @3080；rc.1 亦通过）：令牌兑换 303 → 代理首页 200 +
  `__DSH_BOOT__` + 隐藏设置标记 → WS 升级 **101 完整成功**
- vsix 已装 VS Code：`chai1110.dsh-lite@0.1.0`（等用户真机验证侧栏/整页/对话/模型切换）
- 本机 dsh：**0.2.0-rc.2**（官方 latest 与 next，2026-09-29 起），launchd `com.csl.dsh-web` @3080，
  9 项补丁已重套（`node --check` 9/9 过；补丁仓库 `tools/dsh-patch.mjs --dry-run` 识别"全部在位"）

## 3. 下一步

1. **用户真机验证 0.1.0**：侧栏 + 整页打开、对话、历史（顶栏）、模型选择、确认设置入口已隐藏。
2. 官方 **0.2.0 正式版**（非 rc）发布后：重跑本文件 §8 验证流程。
3. `dsh-ssh-remote` 已归档（用户决定，不再维护）。

## 4. 踩过的坑（**绝对不要再踩**）

### 本次重构新踩（2026-09-29）
- **代理转发压缩响应会损坏**：官方 HTML 是 gzip 的，注入 CSS 前把压缩字节当 UTF-8 解码再编码 →
  undici `Z_DATA_ERROR: incorrect header check`。修法：**剥离请求的 `accept-encoding`**（上游回传未压缩）。
- **注入后必须重写 `content-length`**：注入改了体积，旧长度头会让浏览器/undici 卡死或报错。
- **测试里 `fetch('ws://…')` 永远抛错**（undici 不支持 ws scheme）→ WS 升级探测必须用**原始 socket**。
- **`node --check './@scope/…'` 必须带 `./` 前缀**，否则被当包名解析报"找不到模块"（假警报）。
- **冒烟脚本别拼 `baseUrl + '/'`**：baseUrl 自带尾斜杠，拼出 `//` 上游直接 400（dsh 严格校验路径）。
- **集成测试的 skip 守卫要真的接到 `it(..., { skip })` 上**——算出 SKIP_REASON 再 `void` 掉等于没有守卫，
  普通 `npm test` 会真起 dsh 然后沙箱挂死。

### 沙箱 / 工具链
- 沙箱里 `ls /tmp` 偶发不可靠；调试探针走 OutputChannel 日志。
- git `index.lock` 残留：每个 git 命令前 `rm -f .git/index.lock`，加 `-c core.fsmonitor=false -c gc.auto=0`。
- `ps`/`lsof` 跨进程被拒：用 `pgrep -fl`；端口探测用 `curl`。
- **macOS 无 `timeout` 命令**；Bash 工具自带的 timeout 参数可用。
- 沙箱内 `dsh boot` 因 `~/.dsh` 凭证写锁竞争无法完成——真机集成测试在**用户终端**跑。

### dsh web / Token
- dsh web 每次启动打印一次性 token URL；重启后旧 URL 的兑换仍可用（代理 401 自动重兑）。
- Lite **只回收自己 spawn 的 child**，绝不接管外部实例；端口被占回退空闲端口。
- **`pkill -f` 模式含端口前缀会误杀**（`--port 308` 会命中 3080）——kill 用精确 PID。

### VS Code 扩展安装 / 重装
- 报 `Please restart VS Code before reinstalling`：先删 `~/.vscode/extensions/chai1110.dsh-lite-*` 旧目录再 `--force`。
- `code` CLI 不在默认 PATH：用 `/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`。

## 5. 用户偏好（沟通 + 风格）

- 中文；语气简洁随意；**偏好助手直接处理修复，不要反复确认提问**。
- 详细结构化报告（表格 + 小标题），好读易打印。
- **先本地改好 + 验证，再推 GitHub；README/文档与代码必须同步**（用户多次强调）。
- 静态分析声称成功后，必须在真实流程中再次复核。
- 不要动用户手动微调过的东西；改前先看现状。

## 6. 用户并行线（非本项目工作）

- 母亲抖音号副业（绿植盆栽方向，橱窗/售卖/流量变现）与用户 30 天减脂方案持续在跟，偏好 A4 可打印。
- **dsh-custom-patches**：当前基线 **0.2.0-rc.2**（9 项补丁；`tools/dsh-patch.mjs` 推荐安装器）；
  版本以 tag `version/X` 分支管理。dsh-provider-config：SenseNova 模型模板，默认
  `deepseek-flash`(=V4.1 Flash 备选 `v4-flash`，用户实测 4.1 拥挤时回退 4 更顺)。

## 7. 关键文件速查

| 想看什么 | 文件 |
|---|---|
| 扩展入口 + 代理生命周期 | `src/extension.ts` |
| 面板三态壳 + iframe | `src/panel/provider.ts` + `src/panel/html.ts` |
| 连接管理（自起→令牌→cookie→快照） | `src/connection.ts` |
| dsh 探测 / 进程管理 | `src/process/detect.ts` + `src/process/manager.ts` |
| **本地代理（cookie 注入 + 隐藏设置 + WS）** | `src/service/proxy.ts` |
| 配置读取（5 个 `dshLite.*` 键） | `src/config.ts` |
| 真机集成测试 | `test/integration.dsh.test.ts`（`DSH_LITE_E2E=1` 才跑） |
| 单 bundle 构建 | `scripts/build.mjs` |

## 8. 验证流程（每次改动后）

1. `npm run typecheck` → 必须清零。
2. `npm test` → 必须 0 失败（集成项正常跳过）。
3. 改了 `src/service/proxy.ts` / `src/connection.ts`：**必须跑真机 smoke**——
   对运行中的 dsh 实例验证：兑换 → 代理首页 200 + `__DSH_BOOT__` + `data-dsh-lite` 标记 →
   WS 升级 101（原始 socket 探测）。参照 2026-09-29 会话的 `/tmp/lite-smoke2.ts` 流程。
4. 改了面板/清单：重打包 `npm run package` → 重装 vsix → 用户真机确认。
5. 全部绿了才 commit + push；README/CHANGELOG/HANDOFF 同步更新。
