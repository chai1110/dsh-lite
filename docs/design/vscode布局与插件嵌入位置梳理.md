# VS Code 布局与插件嵌入位置 —— 全量梳理（对照 DSH Lite）

> 目的：先把「VS Code 界面由哪些区域组成、一个插件能把自己的 UI 嵌在哪些位置、聊天类插件各自怎么落位、点一下之后发生了什么」彻底讲清楚，再逐条对照 DSH Lite 的 `package.json` / `src/extension.ts`。
> 基线：运行环境 VS Code 1.136.1；我们声明 `engines.vscode ^1.90.0`。参考来源：VS Code 官方 UI/布局文档、Contribution Points 文档、1.106 Release Notes、反编译 Codex 26.901 与 Claude Code 2.1.218 产物。
> 状态：梳理先行（不改代码）；**经用户拍板后，M13 已按第 8 节决策落地**（见 README/CHANGELOG M13）。

---

## 1. VS Code 工作台：官方划分的六大区域

| # | 区域 | 默认位置 | 装什么 | 聊天插件能用吗 |
|---|------|---------|--------|----------------|
| ① | Activity Bar 活动栏 | 最左一窄列 | 容器图标按钮（Explorer/Git/…及插件的图标），一串纵向图标 | **能**：一个图标 = 一个视图容器（见第 3 节），点它在该侧栏展开对应视图 |
| ② | Primary Side Bar 主侧栏 | 默认左侧 | 资源管理器、搜索、SCM 等视图 | **能**：视图既可在自定义容器里，也可直接挂进内置容器（explorer/scm/debug/test） |
| — | Editor 编辑器区 | 中间主体 | 打开的文件标签（tabs），可左右/上下分栏成多个 editor group | **能**（两种形态）：见下方“编辑器区的两个位” |
| ③ | Editor Title 编辑器标题栏 | 每个 editor group 标签条最右端 | `menus.editor/title` 贡献的图标按钮（如 markdown 预览、我们的入口） | **是入口**：不承载聊天本体，只放“打开/切换”按钮 |
| ④ | Secondary Side Bar 副侧栏 | 与主侧栏相对（默认右侧） | **Chat 视图默认就在这**；1.106 起插件可在此注册容器 | **能，而且是主流聊天位**：Copilot Chat / Codex / Claude Code / 我们 |
| ⑤ | Panel 面板 | 底部 | 终端、输出、问题、调试控制台 | 文档上容器位置允许 `panel`，但聊天插件几乎不用 |
| ⑥ | Status Bar 状态栏 | 最底一细条 | 状态小部件（图标+文本） | 只够放“状态开关/小按钮”，放不下聊天界面 |
| — | Editor 区的自定义编辑器 | 编辑区里占一个**整页标签** | `customEditors` / webview 编辑器 | **能**（另一条路线）：像 Copilot 的 Chat Editor，聊天以“编辑器标签”形式开满整个编辑区，不是侧栏 |

> 官方原文把布局称为“six main areas”（Editor / Primary Side Bar / Secondary Side Bar / Status Bar / Activity Bar / Panel）。Secondary Side Bar 始终与 Primary Side Bar 相对：把主侧栏移到右边，副侧栏会自动到左边。
> 视图可以在主/副侧栏之间**拖拽**，位置会被记住；拖乱了可用命令 `View: Reset View Locations` 恢复。

---

## 2. 一个插件能把 UI 嵌到哪些“位置点”（可贡献点全表）

| 可贡献点 | 声明位置 | 装什么 | 备注 |
|---------|---------|--------|------|
| `viewsContainers` | `package.json` | 一个**全新的容器**（自带活动栏图标 + 独立侧栏区） | 位置仅 3 个：`activitybar`（老）、`panel`（文档里写支持但少见）、`secondarySidebar`（**1.106 新增**，官方旧文档没写） |
| `views` | `package.json` | 把**视图**放进取：自定义容器 or 内置容器（explorer/scm/debug/test…） | 视图内容两类：`TreeView`（列表树）或 `WebviewView`（任意 HTML，需 `registerWebviewViewProvider`） |
| `menus."editor/title"` | `package.json` | **图标按钮**，渲染在编辑器标签条右上角 | `group:"navigation@0"` 排最前；带 `icon` 的命令以按钮呈现 |
| `menus."view/title"` | `package.json` | 视图标题栏右侧的小图标 | 次要 |
| `statusBar`（API） | 代码 `createStatusBarItem` | 状态栏小部件 | 次要 |
| `customEditors` | `package.json` | **整页**自定义编辑器（webview 标签） | 聊天也可以开成“编辑区里的一个整页”，另一路线 |
| `terminal` API | 代码 | 集成终端里的扩展终端 | 放命令行 UI |
| 命令面板 | `commands` + `menus.commandPalette` | 命令入口 | 我们两条命令都注册了 |

**关键结论**：真正的“大块聊天 UI”只有 3 个落点候选 —— 主侧栏容器（②）、副侧栏容器（④）、编辑区整页自定义编辑器；外加“③ 右上角按钮”作为一键入口；⑤⑥ 装不下聊天本体。

---

## 3. 三层模型：容器 → 视图 → 内容（以及最容易踩的“展开/聚焦”语义）

```
viewsContainers（容器，=活动栏一个图标，如 dshLite）
  └─ views（视图，=侧栏里一个面板，如 dshLite.panel）
       └─ WebviewViewProvider（内容=webview HTML / tree）
```

同一个 `WebviewViewProvider` 可以注册给多个 `viewId`（我们就是这么干的：一个 provider 同时服务左/右两个 view，`Map<viewType, WebviewView>` 管理，`post()` 广播两侧 → 左右同屏同会话）。

**两条命令，语义完全不同（M12 的根因就在这）：**

| 命令 | 行为 |
|------|------|
| `workbench.view.extension.<容器Id>` | 等价于**点击活动栏那个图标**：把该容器所在的侧栏展开并切到该容器。对 `secondarySidebar` 容器，会把**右侧副侧栏整条拉开**。 |
| `<视图Id>.focus` | 只把**焦点**给到视图内部；如果它所在的容器/侧栏当前是收起的，**不会替你拉开**。 |

> Codex 反编译实证：`openSidebar = await executeCommand(workbench.view.extension.codexSecondaryViewContainer) + executeCommand(chatgpt.sidebarSecondaryView.focus)` —— 先开容器、再 focus 视图，两步缺一不可。CC 是 `sidebar.open = focus + show()`，同理。
> **反例（我们 M12 之前）：只 `.focus()` 不先开容器 → 右侧容器默认收起，视图被塞到别处（表现为跑到左侧/最下方），这就是“嵌入位置不对、乱七八糟”的直接原因。**

另外两个生命周期事实：
- `WebviewViewProvider.resolveWebviewView` 在视图被实际打开时触发；`activationEvents` 配 `onView:<viewId>` 可以“用户一打开视图才激活扩展”。
- `retainContextWhenHidden: true` 让视图隐藏时 webview 上下文不销毁（代价是常驻内存），左右切换不重载 —— 我们两侧都开了。

---

## 4. 主流聊天插件落点对照

| 插件 | 主侧栏/活动栏 | 副侧栏（右） | editor/title 入口 | 其他 |
|------|--------------|--------------|-------------------|------|
| VS Code 内置 Chat | — | **默认住这**（内置 `chat` 容器） | 有 | 还支持编辑区内联 Chat / Chat Editor（整页） |
| Copilot Chat | 活动栏图标 | Chat 视图 | 有 | 同内置 Chat 一体化 |
| **Codex** | `activitybar` 容器 `chatgpt`（视图 `chatgpt.sidebarView`） | `secondarySidebar` 容器 `codexSecondaryViewContainer`（视图 `chatgpt.sidebarSecondaryView`） | 有，命令=`chatgpt.openChat`（组 navigation） | ≥1.106 走右容器两步开，旧版回退 |
| **Claude Code** | `activitybar` 容器（视图 `claudeVSCodeSidebarView`） | `secondarySidebar` 容器（视图 `claudeVSCodeSidebarSecondary`） | 有，`sidebar.open` = focus+show | 无 |
| Cline / Roo | 仅活动栏自定义容器 | 无（可被用户拖过去） | 无 | — |
| **DSH Lite（我们）** | `activitybar` 容器 `dshLite`（视图 `dshLite.panel`） | `secondarySidebar` 容器 `dshLiteSecondary`（视图 `dshLite.panel.secondary`） | 有，`dshLite.openChat`（navigation@0，图标 light/dark 成对） | 命令面板两条命令都可搜到 |

**结论**：我们的结构 = Codex/CC 的“双容器 + 右上角入口”同款，位置机制上没有任何缺项。差异只剩“点击后是否真的把右侧整栏拉开”这个**行为**问题 —— M12 已按 Codex 两步法修复。

---

## 5. editor/title 按钮：位置与图标渲染规则

- **位置**：`editor/title` 菜单项渲染在**每个编辑器组的标签条最右端**（即编辑器区右上角那一小排图标里）。你看到的“Codex/CC 右上角图标”就是它。`group: "navigation@0"` 让它排在最前、尽量靠左出现。
- **图标渲染规则**：editor/title 按钮图标是**当作普通图片画的，不会按主题着色**。若 svg 里写 `fill="currentColor"`，深色主题下会渲染成黑色 → 看不见。**必须给 `{light, dark}` 两套**（浅色主题用深色图、深色主题用浅色图）。我们 M10 已修：`assets/icon-light.svg`(#1F1F1F) / `assets/icon-dark.svg`(#C5C5C5)，命令与两个容器共用。
- **命令里可带 `when`** 控制出现条件；我们刻意**没加 when**（任何编辑器状态下都可点），与 Codex 一致。

---

## 6. 逐条对照我们的 package.json 与 extension.ts

### 6.1 清单声明 → 真实落点

| package.json 声明 | 内容 | 真实落点 / 行为 |
|---|---|---|
| `viewsContainers.activitybar.dshLite`（L24-33） | 图标成对 | 活动栏出现 DSH 图标；点它 → 主侧栏(左)切出 `dshLite.panel` |
| `viewsContainers.secondarySidebar.dshLiteSecondary`（L34-43） | 图标成对 | **副侧栏(右)出现 DSH 图标**；这是“整右栏展开”的本体容器 |
| `views.dshLite → dshLite.panel`（L46-52） | `type:"webview"` | 左侧栏里的面板 |
| `views.dshLiteSecondary → dshLite.panel.secondary`（L53-59） | `type:"webview"` | 右侧栏里的面板（=Codex 的 `sidebarSecondaryView`） |
| `commands.dshLite.openChat`（L67-75） | 带 light/dark 图标 | 右上角按钮 + 命令面板“在右侧打开对话” |
| `menus."editor/title"`（L78-83） | `navigation@0`、无 when | 编辑器标签条右上角第一个动作 |
| `activationEvents`（L16-21） | 两个 onView + 两个 onCommand | 点视图或跑命令才激活，不抢启动 |
| `engines.vscode ^1.90.0`（L12-14） | — | 见 6.3 兼容性 |

### 6.2 行为逻辑（src/extension.ts）

- **provider 双侧注册**（L25-32）：同一实例注册给 `dshLite.panel` 与 `dshLite.panel.secondary`，都带 `retainContextWhenHidden` → 一个宿主状态广播到两侧，左右开的是同一会话。
- **`dshLite.openSidebar`（L66-74）**：先 `workbench.view.extension.dshLite` 再 `.focus` 左侧视图（左栏两步法；失败兜底直接 focus）。
- **`dshLite.openChat`（L78-90）**（M12 修复后）：
  1. 先 `workbench.view.extension.dshLiteSecondary` → **把右侧副侧栏整条拉开**；
  2. 再 `dshLite.panel.secondary.focus` → 焦点进聊天；
  3. catch 回退：左容器两步（<1.106 无副侧栏时），再兜底纯 focus。
- **`openOnStartup`（L57-59）**：目前只 focus 左侧视图；若想要“开机就在右栏”，需要改成两步开右容器（见第 8 节待定项）。

### 6.3 兼容性口径

- `secondarySidebar` 容器贡献点在 **1.106 才 finalize**；我们引擎声明 `^1.90.0`，运行于 1.136.1 → 正常。
- 万一跑在 <1.106：`secondarySidebar` 容器不生效，点击 openChat 会因执行 `workbench.view.extension.dshLiteSecondary` 抛错 → 落入 catch → 走左容器两步。**行为正确降级，不会白屏/乱跑**（这正是 M12 里 catch 链的意义）。
- 不需要改引擎版本声明：JSON 里多写一个容器 key 在旧版只是“不注册”，不报错。

---

## 7. 真机验证清单（在 1.136.1 上亲手确认）

| # | 操作 | 期望 |
|---|------|------|
| 1 | 随便打开一个文件 → 看编辑器标签条最右上角 | 有 DSH 图标按钮（深色主题下可见，浅色下可见，非黑块） |
| 2 | 收起右侧副侧栏（Ctrl+Alt+B）→ 点右上角按钮 | **右侧整条重新拉开**并出现 DSH Lite 聊天（不再是左侧/最下方） |
| 3 | 点活动栏最左列的 DSH 图标 | 主侧栏（左）切出同一会话的副本；左右消息实时同步 |
| 4 | 点右侧栏里 DSH 图标列（若有多个容器图标） | 右侧在 Chat / Codex / DSH 等容器间切换，DSH 容器正常显示 |
| 5 | 命令面板搜“在右侧打开对话”“打开 DSH 侧栏（左侧）” | 都能执行，行为同 2/3 |
| 6 | 把 DSH 视图在主/副侧栏间拖一拖，再 `View: Reset View Locations` | 回到默认双栏位 |
| 7 | 把主侧栏移到右侧试试（右击活动栏 → Move Primary Side Bar Right） | 副侧栏自动跑到左侧，DSH 右容器跟随“相对侧”出现 —— 这正是 Codex/CC 同样表现 |

若 1、2 通过，说明“右上角 → 整个右边”这条链路已完全打通，与 Codex/CC 一致。

---

## 8. 决策落地（M13，用户拍板后实现）

1. **左侧活动栏的 DSH 图标**：**保留**，与右侧并存 —— 和 Codex/CC 一样“两边都可以”（`activitybar.dshLite` + `secondarySidebar.dshLiteSecondary` 双容器不动）。
2. **openOnStartup → 开机即右侧**：由原来只 `focus` 左侧视图改为共享 `openChatRight()`（第 6.2 节两步法），启动即展开右侧 `dshLiteSecondary` 容器并 focus 副视图；<1.106 自动回退左侧。配置描述已同步。
3. **整页聊天**：**新增**命令 `dshLite.openChatFull`（命令面板可搜）→ `provider.openFullPage()`：以 `WebviewPanel` 在编辑区开「DSH Lite」整页标签（Chat Editor 形态，tab 图标 light/dark 配对）。与左/右栏共用同一 host 与同一会话：`post()` 广播到所有存活面，任一面操作其余面实时同步；单实例，重复执行只 `reveal` 聚焦。整页模式注入 `body.dsh-full` 样式：`.app` 约束 `max-width:1160px` 居中阅读列 + 编辑器底色 + 左右细分隔，避免消息全宽拉伸。侧栏模式零变化。
   - 接线：provider 抽 `wireWebview(webview, attachDispose, full)` 统一装载（侧栏视图/整页面板同一份 HTML+协议）；`hello` 应答由广播改为 `postTo(from)` 只回发出方（多面共存不重复广播）。
4. 右侧栏宽度由用户拖拽记忆，插件不可控 —— 与 Codex 行为一致，**不做处理**。

> 侧栏 vs 整页：**并存**。右上角 editor/title 按钮仍走“③→④ 右侧整栏”（Codex/CC 形态）；
> 整页是额外入口，给需要“占满编辑区看长对话”的场景。

真机新增验证（在 1.136.1 上）：
| # | 操作 | 期望 |
|---|------|------|
| 8 | 命令面板搜「在整页标签中打开对话」并执行 | 编辑区开「DSH Lite」整页标签，内容与侧栏同会话、同频更新 |
| 9 | 整页开着时再执行一次 | 不重复开新页，只聚焦已有整页 |
| 10 | 整页与右侧栏各发一条消息 | 两处（含左侧栏）消息实时一致 |
| 11 | 设置 `dshLite.openOnStartup: true` 后 Reload Window | 启动即在**右侧**打开 DSH 对话 |

---

## 9. 结论一句话

**位置结构上我们与 Codex / Claude Code 完全同构（双容器：activitybar + secondarySidebar；右上角 editor/title 入口；同 provider 多面广播）；M12 修掉“只 focus 不展开容器”这一唯一行为缺陷；M13 依决策补齐“开机开右栏”与“整页对话”两个能力，并沉淀本文档。位置机制层面与主流聊天插件已完全对齐。**
