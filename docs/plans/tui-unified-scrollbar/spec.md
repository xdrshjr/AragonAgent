# TUI 右缘拖动条与输入区统一滚动设计

版本：v2；日期：2026-10-03；节点：设计评审。

本次交付仅为设计规格。下文“新增”“修改”和验收命令均是后续实施要求，不表示本节点已经修改代码或完成终端实测。实施范围为 `packages/cli`，不改变 Core、会话持久化或模型调用协议。

## 评审记录

评审依据为当前源码、已安装 Ink 的实现、`CLAUDE.md` 和 `.claude-index/config.md`，不是仅按上一节点的摘要判断。按可行性、完整性、一致性、范围适配性逐节核对；以下状态均表示**设计已修订**，不表示功能已实现或测试已通过。未发现 P0；8 项 P1、3 项 P2 均已在正文处理，无未解决的 P0／P1。

| 编号 | 级别 | 关注点、证据与影响 | 正文处理及验证入口 | 状态 |
| --- | --- | --- | --- | --- |
| R01 | P1 | §3.3–3.5 只累加 footerDelta，遗漏短文档填充抵消；`reduceFollow` 自带 clamp，串联会在同周期伸缩时过早截断 | §3.5 明确统一事务及填充抵消，§4–6 补充接口／文件，T13–T14 | 已解决 |
| R02 | P1 | §3.7 从卸载改为隐藏后，现有 resume timer 会继续运行；隐藏的 overlay 若仍挂载也会继续接收 Ink 输入 | §3.7 明确 inactive 的计时、意图、测量与恢复契约，覆盖层仅容器常驻，A11 | 已解决 |
| R03 | P1 | `App.tsx` 的小于 12 行 early return 会卸载 Composer，破坏草稿连续性；现有运行时分支未检查列数 | §3.2／3.7 用稳定提示槽取代 early return，A12 | 已解决 |
| R04 | P1 | `thumbRange(20,21,0)` 得到 size=20、travel=0，有溢出却无法拖动；比例量化使未移动的 release 也可能跳行 | §3.8 保留可移动轨道并明确无移动释放规则，T15 | 已解决 |
| R05 | P1 | §3.9 同步 capture 仅阻止选择，跟随仍读 React hold；同批输出可能抢先 pin；修饰键在拖动中变化的所有权未定义 | §3.5／3.9 同步 hold 读取及完整手势路由，T16 | 已解决 |
| R06 | P1 | `PromptInput` 的 popup 分支先于 Shift+方向键排除分支，会在滚动历史时改补全选择，并触发编辑返回 | §3.6 把 viewport 专属键 guard 放到 popup 之前，A13 | 已解决 |
| R07 | P1 | §3.8 将 Yoga 提交等同于已显示帧；本地 Ink 的 onRender 存在 32 ms 节流，resize 还有 50 ms 尺寸去抖 | §3.8 定义尺寸失效与输出确认门控，§4–6 补输出观察接口／文件，A14 | 已解决 |
| R08 | P1 | §6 对超千行 App／cli 默认豁免，与 `CLAUDE.md` 要求显式记录例外不符；config 当前没有这两个例外 | §6 要求实施先记录限定范围例外或完成必要拆分，不隐式放宽规范 | 已解决 |
| R09 | P2 | `PgDn latest` 暗示一次回底，但 `applyScroll` 中 PgDn 只翻一页；服务停止与强制中断提示仍只在会滚走的 Composer | §3.6 改为准确的一行状态提示与紧急操作优先级 | 已解决 |
| R10 | P2 | §8–10 缺少具体回退路径，且仍要求“下一节点评审到 v2” | §10 明确实施／发布门禁、已有参数退路与整组回退 | 已解决 |
| R11 | P2 | §3.2 团队预算重复预留三行：`buildTeamPanelLayout` 内部已扣 `panelMinRows`，会过早折叠 | §3.2 明确两层预算职责，补充预算测试 | 已解决 |

逐节结论：§1–2 的目标和代码证据成立；§3 的上述交互边界已补齐；§4–5 的接口与状态不变量同步修正；§6–7 的实施路径与规范例外已明确；§8 的自动化／实机验证保持分离并增加反例；§9 风险有对应机制；§10 改为评审后的交接。保留单一偏移、自绘单列及现有虚拟化，不引入第二套编辑器、鼠标协议或通用布局框架，范围适当。

## 1. 概述

Aragon 的全屏 TUI 需要提供始终可发现的右侧滚动条，使用户在 PowerShell 所在的终端中直接拖动查看历史。滚动对象同时包含 Agent 消息与当前输入区：向历史方向滚动时，输入框逐行移出屏幕，释放原先占据的阅读空间；返回最新位置后，输入框重新出现在文档尾部。输入草稿、光标、粘贴块和补全状态必须连续，不能因为滚动而销毁重建。

采用应用自绘滚动条，延续现有 Ink 全屏、负 `marginTop` 裁剪、消息虚拟化和增量帧写入架构。消息与输入区使用同一个滚动偏移；TODO 侧栏保留为固定辅助列，滚动条放在该侧栏之外、终端最后一列。保留一行 Header、一行活动／通知栏、一行 StatusBar；团队面板移入消息尾部与输入框之间。这样既扩大历史阅读区域，又保留运行状态和中断操作的可发现性。

“PowerShell 不显示滚动条”是用户报告，不能仅凭静态代码确定其机器上的单一原因。本设计修复已经确认的结构性缺口，并规定真实 Windows 终端验收：区分外部终端原生滚动条、应用位置指示器和应用可拖动滚动条，分别验证绘制、输入协议、命中与滚动效果。全屏以外的 inline、管道和 `aragon exec` 保持既有契约。

## 2. 现状与证据

已阅读根目录 `README.md`、`CLAUDE.md`、项目索引、CLI 包清单及相关源码。项目为 npm workspaces，使用 TypeScript strict／NodeNext、React 18、Ink 5、Vitest。当前 CLI 包版本为 0.6.7；索引中的版本和行数较旧，设计以实际源码为准。未发现适用的 `AGENTS.md`。遵循现有 ASCII 字形门禁、公开接口优先 `interface`、新模块单一职责、不新增依赖等约定。

| 现有代码路径 | 已确认行为 | 对本需求的影响 |
| --- | --- | --- |
| `ui/layout/AppShell.tsx::AppShell` | fullscreen 的 `team`、`toast`、`composer`、`status` 位于固定底栏 | 输入框不会随消息滚动 |
| `ui/layout/ScrollViewport.tsx::ScrollViewport` | 唯一偏移所有者；测量内外高度；负边距裁剪；绘制内部指示列 | 应扩展此机制，不能在 App 再维护第二个偏移 |
| `ui/layout/ScrollIndicator.tsx::MIN_INDICATOR_COLS` | 小于 50 列时隐藏指示器；指示器无输入处理 | 40–49 列可进入全屏却看不到条，且看到也无法拖动 |
| `ui/App.tsx` 和 `AppShell` | TODO 位于 viewport 右侧 | 现有指示器不是终端最右列 |
| `input/mouse-events.ts::splitMouseEvents` | 已识别 SGR 左键按下、拖动、释放；X10 只提供滚轮事件 | 无需新造鼠标协议解析器 |
| `cli.tsx` 的 `wantSelect` 与 `ui/screen.ts` 的 `motion` | `1002` 按钮移动报告目前随文字选择开关启停 | `--no-mouse-select` 下也要支持拖条，必须拆分能力 |
| `ui/selection/selection-controller.ts::createSelectionController` | 直接订阅鼠标源，拖动释放会复制文字 | 新滚动条不能与它同时处理同一手势 |
| `ui/Transcript.tsx::TranscriptList` | `selectWindow` 把消息尾部视为滚动内容尾部 | 插入输入区后必须换算尾部附加行数 |
| `ui/PromptInput.tsx::PromptInput` | 编辑状态保存在组件内；宽度直接读取 `stdout.columns` | 不可滚动时卸载；进入较窄正文列后必须传实际宽度 |
| `ui/layout/follow-state.ts` | 只根据消息尾部计数补偿，避免总高度反馈环 | 输入区高度变化需独立补偿，不能冒充新消息 |
| `ui/layout/frame.ts::frameHeight` | 帧高严格小于终端行数 | 保留 `rows - 1`，防止末行换行与全屏重绘回归 |

协议依据：Windows 的备用屏幕没有普通回滚缓冲区，不能要求外部滚动条提供应用内历史；VT 输入需相应控制台模式。参见 [Microsoft 控制台 VT 文档](https://learn.microsoft.com/en-us/windows/console/console-virtual-terminal-sequences)。按钮移动跟踪 `1002` 与 SGR 坐标编码 `1006` 的语义参见 [xterm 控制序列规范](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)。这些协议说明不等于已验证每一种 Windows 宿主都支持拖动。

## 3. 技术设计

### 3.1 方案选择

| 方案 | 收益 | 代价与结论 |
| --- | --- | --- |
| 使用外部终端回滚，退出备用屏幕 | 接近普通命令行输出 | 改变全屏产品形态，受宿主行为约束，不采用 |
| 仅给现有指示器加拖动，浏览时隐藏固定输入框 | 代码较少 | 输入区没有真实文档坐标，隐藏时视口高度突变，不满足共同滚动，不采用 |
| 扩展现有视口为统一文档，右缘独立交互列 | 一个偏移、输入状态连续、可复用虚拟化 | 需要明确尾部坐标及鼠标所有权，采用 |

### 3.2 布局与固定预算

全屏结构固定如下，各容器的 React 类型、位置和 key 不随是否有 TODO、是否滚离底部而变化：

```text
AppShell：高度 frameHeight(rows)，宽度 cols
  Header：1 行
  中部：V 行
    ScrollViewport（始终挂载）
      聊天分支（overlay 打开时 display=none）
        横向容器
          裁剪正文：documentCols 列
            内部文档：flexShrink=0，marginTop=-shiftUp
              SessionOpener（仅空会话）
              TranscriptList（含虚拟占位）
              短文档填充空白
              footer：TeamPanel、Composer（含补全列表与提示）
          TODO 侧栏：railWidth 列或空槽
          ScrollIndicator：1 列，终端最右缘
      overlay 分支（聊天时 display=none）
        既有 OverlayFrame／交互覆盖层
  BottomStatusRow：1 行，保留活动／通知优先级
  StatusBar：1 行
```

定义 `V = max(0, frameHeight(rows) - 3)`。聊天正文总高度包含消息、团队和输入框，固定预算不再扣除 composer、补全和团队行。当输入框滚出屏幕后，历史内容实际可占满 V 行。12 行终端的 V 为 8；24 行终端为 20。小于现有全屏最小行数或列数时，维持备用屏幕，暂停命中处理；不在会话中切换 inline。必须移除 App 当前小于 12 行时替换整棵树的 early return：在稳定的外层 frame 内设置正常内容槽与小尺寸提示槽，正常槽仅隐藏，提示槽占 `frameHeight(rows)`。同时检查 `MIN_FULLSCREEN_ROWS=12` 与 `MIN_FULLSCREEN_COLS=40`，恢复尺寸后仍是原 Composer 实例。只有提示文案沿用现有设计，不能沿用会卸载草稿的分支结构。

`AppShell` 的 inline 分支维持原顺序。fullscreen 分支只固定 header、toast、status；团队、输入框、侧栏由 App 组装到 `ScrollViewport` 的指定槽位。旧 props 为兼容 inline 保留，但 fullscreen 不再二次渲染这些节点。更新旧注释和对应旧布局断言，不能同时保留“输入框永远固定”这一已被需求替代的约束。

所有可用 fullscreen 尺寸均预留一列滚动条，移除聊天分支的 50 列显示门槛。不随溢出、hover、鼠标能力或主题变化增减列。调用 `buildTodoRailLayout` 时先扣该列，以 `cols - 1` 作为总可分配宽度；返回的 `contentCols` 就是 `documentCols`，禁止再次减一。Header、活动栏、StatusBar、覆盖层仍使用终端全宽。

全屏 TODO 的行数等于 V，不受 footer 或补全高度影响。保留 `todoRailWidth` 宽度阈值及开关语义，修改 `todo-layout.ts` 的全屏投影，取消用团队／补全占用量缩短 TODO。团队布局的 `availableRows` 采用 `max(0, V - composerBaseRows)`；现有 `buildTeamPanelLayout` 内部已为消息扣除 `TODO_LIMITS.panelMinRows=3`，调用者不可再扣一次。补全 `maxHeight` 采用 `max(0, V - teamRows - composerBaseRows - 3)`，仍交给 `buildAutocompleteLayout` 处理小于可用菜单最低高度的情况。三行是底部可见消息保留目标，空间不足时仍以输入区可编辑为先。预算只依赖终端与草稿，不依赖当前滚动位置；补全实际行数只进入 footer 测量，不反向决定 TODO 是否显示。`todo-layout` 的全屏 `popupMaxHeight` 必须与此补全预算一致，不能继续以 TODO 高度反推菜单容量。

`composerBaseRows = 2 + clampDraftRows(rows, draftRows) + Number(showHint && hintsEnabled)`，不含补全。`viewportRows` 保留第二个 draftRows 参数以兼容调用，但新全屏 V 不再依赖该参数；`chromeBudget` 的 composer 字段仍表示输入自然高度辅助值，不能再把它当固定 chrome 扣除。ScrollViewport 的 cols 改传中部总宽 cols；TranscriptList、Composer、TeamPanel 分别使用 documentCols，二者不能混用。

`Composer` 新增可选 `cols` 并传递给 `PromptInput`。正文中的所有换行、滚动提示 chip、草稿行报告、补全宽度使用该值；默认仍取 stdout，保持 inline 兼容。团队面板也传 `documentCols`。正文内容与高度缓存必须使用相同宽度，否则中文换行、边框和条位置会错一列。

### 3.3 单一滚动坐标与短文档

`ScrollViewport` 继续唯一持有 `offsetFromBottom`。设消息及开场区自然高度为 B，footer 自然高度为 F：

- `paddingRows = max(0, V - B - F)`，填充放在消息后、footer 前。
- `C = B + paddingRows + F`，`overflow = max(0, C - V)`。
- `offset = clampScroll(rawOffset, overflow)`；`shiftUp = overflow - offset`。
- 可见文档区间为 `[shiftUp, shiftUp + V)`；内部正文统一使用负边距位移。

短会话中 footer 仍自然贴近底部，但不是固定定位。长会话向上滚动一行，输入框同样向下移出可见区一行；直到完全裁掉，不能在 `offset > 0` 时整块突兀隐藏。父层不根据 `scrolledLines` 改变可用高度。

在视口中分别测量正文主体与 footer，填充为纯派生值。初始未知测量采用 0，下一布局提交收敛；对相同数值不 setState。禁止以总高度变化作为“新增输出”或根据选择窗口循环补偿。

### 3.4 虚拟列表坐标换算

给 `ViewportGeometry` 增加 `trailingContentRows`，表示消息列表之后的 `paddingRows + F`，默认 0。给 `SelectWindowInput` 增加同名可选值，默认 0。`TranscriptList` 将 context 中的该值传入。现有消息高度缓存、key、overscan、窗口保留上限及消息尾部计数保持职责不变。

设消息条目高度和为 T，则选择窗口使用：

```text
bottom = T + trailingContentRows - offset
top = bottom - max(1, viewportRows)
```

用此区间与条目累计行区间求交，再沿用前后至少两个条目的 overscan。不要先对 `offset - trailingContentRows` 截断到零，否则底部 footer 占据的高度会被错误认为可显示消息。消息之前的 collapsed 提示／开场区无需加到这条尾部公式中；它们进入总文档测量，尾部参考系已经抵消前缀高度。短文档的填充必须包含在 `trailingContentRows` 中。

保留首次未知 V 时挂载最新条目、pin 状态最后条目必须挂载的规则。如果当前区间完全处于 footer，允许只保留最新条目和既定 overscan，不扩展为全列表。输入框不加入 `Entry[]`，不进入 `HeightStore`、`transcriptWindow` 或 `/save` 导出。仅将高度换算接入虚拟化。

### 3.5 流式输出与阅读锚点

消息到来仍由 `TailSink` 提供真正的消息尾部增量。扩展 `follow-state.ts::reduceFollow` 的纯计算输入，增加默认 0 的 `layoutTailDelta`，其值为同一有效测量周期的 `footerDelta + paddingDelta`。只在旧 offset>0 或 effectiveHold 时，计算 `oldOffset + tailDelta + layoutTailDelta`，最后对新 overflow 截断一次；否则维持 offset=0。不能先调用会 clamp 的旧 reduceFollow，再叠加 footerDelta。`newLinesWhilePaused` 只累计 tailDelta，最终 offset=0 时归零；仅有布局变化不启动或重置恢复倒计时。footer 包含补全、提示与团队，均使用同一测量结果。

`paddingDelta` 只用于抵消同周期尾部变化对短文档空白的占用，不作为独立输出来源。在几何与上方内容都稳定时，用 `deltaN=tailDelta+footerDelta`、`oldNaturalRows=oldBodyRows+oldFooterRows` 得到 `paddingDelta=max(0,V-oldNaturalRows-deltaN)-max(0,V-oldNaturalRows)`；不读取整个文档测量差值来充当尾部增量。这样短文档自然高度由 18 增至 23、V=20、hold=true 时，只补 3 行，而非 5 行；纯 footer 改变也不伪造新消息。初始化仅建立基线。resize、TODO 改宽等重排按 §3.7 重新建立测量和尾部基线，保持旧 offset 后 clamp，不把重排导致的 F／padding 变化算作新尾部。重排同周期输出以新几何基线为准，允许一次重排位置调整，不承诺逐字锚定。

`effectiveHold = selectionHold || scrollbarController.isCaptured()`，跟随测量及恢复 timer 触发时必须读取同步捕获状态，不能只等待 `scrollbarHold` 的 React 更新。React hold 用于重渲染和状态展示；捕获起止同时立即清理／重评估恢复 timer，保证同一 stdin 批次中的 press、输出、release 顺序确定。

同一布局周期的优先级：显式 pin／用户手势、消息尾部补偿、footer 补偿、最终 clamp。读取旧的已渲染 offset，累加必要增量后再按新 overflow 截断，避免收缩时先截断又扣增量。pin 优先时本周期的其它补偿不覆盖 pin；新状态与 ref 同步后才判断计时器。拖条过程中无新指针坐标的输出仍按历史阅读规则锚定；有新坐标时以当前几何计算绝对目标并覆盖该次定位，不二次叠加此前增量。

沿用 `scrollResumeMs` 配置契约。本次不修改默认值：新增输出且用户离开底部时按配置恢复；只阅读已完成消息不自动跳回；选择或拖条 hold 期间禁用恢复。正常拖条结束后从结束时重新计时。若配置为 0，必须显式 PgDn／继续编辑／提交才回到底部。StatusBar 的 offset 表示“距整个文档末尾的行数”，不能称为“新消息行数”。

### 3.6 输入区生命周期与键盘

Composer 和 PromptInput 始终挂载在同一 footer 槽位。向历史滚动不修改 `isActive`，否则无法接收“开始编辑即返回”的首字符；视觉光标单独通过 `cursorVisible` 控制。`cursorVisible` 由已测量输入区域是否完整在视口内以及 overlay 状态派生，不能用它禁用输入。

App 创建稳定的 `composerRef`，经 Composer 的 `measureRef` 挂到其最外层 Box，并交给 ScrollViewport 读取。用 Yoga 已提交布局沿祖先求和得到 Composer 相对 clip 的 top，再结合 `measureElement` 的 height 判断 `top >= 0 && top + height <= V`；计算必须包含内部负 marginTop。PromptInput 只在 `layoutComposer` 的 active 参数使用 `isActive && cursorVisible`，useInput 的 isActive 取聊天活动状态（无 overlay 且尺寸可用），不取滚动可见性。默认 cursorVisible=true，避免改变既有调用者。

新增 `onInteraction` 回调，由 PromptInput 在确认一个键会被编辑器处理、且在执行其原有分支前调用一次。涵盖插入字符、合法粘贴、换行、删除、Home／End／单词编辑、左右移动、无 Shift 的上下／历史、补全选择与接受、Enter 提交。App 的回调清除待处理滚轮与拖条，发出 pin nonce，再让原分支执行原动作：首字符只插入一次，首个 Enter 保留既有发送行为，不能回放整段 stdin。

不触发返回的输入：PgUp／PgDn、Shift+Up／Down、滚轮、鼠标选择、App 拥有的中断／重绘／模式切换快捷键及未知控制序列。识别发生在 PromptInput 的既有分支内部，不让 App 再注册一个“所有可打印输入”监听器。受限粘贴先通过现有校验，再返回并插入；不改变 paste reducer、token 展开或 Enter 的既有语义。

在 PromptInput 的 popup 分支**之前**排除 PgUp／PgDn、Shift+Up／Down 和 Shift+Tab，再分派补全及编辑。已有 Shift+Tab guard 保留；新增 Shift+方向键 guard 不能仅放在普通历史分支，否则隐藏在文档尾部的补全仍会处理该键并 pin。空草稿 Enter 沿用无操作，不调用 onInteraction；按 `?` 打开帮助沿用 overlay 行为。一次输入事件即使包含多个粘贴片段，也只在通过校验后调用一次 onInteraction。

StatusBar 在 `scrolledLines > 0` 时显示 `PgDn down`，它表示向下翻页，连续翻页直到末尾；编辑动作则直接返回输入。不要把单次 PgDn 描述成跳到最新。保留现有键盘行为，不新增全局快捷键。窄屏信息优先级为运行中的 `Esc abort`（已有强制阶段显示 `Esc x2 force`）、有后台服务时的 `Ctrl+C stop N`／退出阶段提示、`PgDn down`，随后才是模型长名、速率和费用；按实际显示列裁剪为一行。无法同时放下时先保留当前紧急操作，其它提示仍由帮助提供。Composer 内 chip 可以保留，但其存在不是返回提示可见的前提。产品字符串遵守仓库现有英文与 ASCII 约定；本文及实施说明为中文。

### 3.7 覆盖层与缩放

给 ScrollViewport 增加 `active` 和 `overlay` 槽位。overlay 打开时聊天分支 `display="none"`，覆盖层分支占 V 行，聊天树仍挂载；不把 footer 搬到其它父节点。此时输入停用、拖条取消、pending wheel 清空、选择清空。暂停聊天测量，保留最后有效度量，禁止用 display:none 测得的 0 重置偏移。

常驻的是覆盖层**容器**，其内容仅在 overlay 非空时挂载；关闭时令内容为 null，避免已隐藏的 ModelPicker／确认框继续通过 useInput 接收按键。聊天的 `active = !overlayOpen && !tooSmall`，在布局 effect 中冻结旧 offset、尾部计数和 footer 基线，并清除 resume timer；timer 的触发回调也复查 active。active=false 期间禁止运行跟随补偿、clamp、自动 pin 和 geometry 发布。消费并记录收到的 intent／pin nonce，但不执行，防止恢复时重放；明确的会话重置除外。

overlay 期间消息仍可更新 TailSink。重新显示聊天后的首次测量，将累计尾部增量按打开前是否 pinned 决定应用，浏览位置不重放旧 intent；`active=false` 时收到的键盘意图不存作待执行命令。保持既有 overlay 自己的分页与滚轮规则，本需求不添加弹窗滚动条拖动。

恢复时先等有效布局，再一次性吸收冻结期间累计 tailDelta 与 footer／padding 的净变化，并按 §3.5 统一 clamp；期间发生宽度或高度重排则走重新建基线规则。`useHeightStore.report` 已忽略非正测量值，保留此防线，不为隐藏状态清空缓存。完成恢复后才重新判断 resume 条件，从恢复时刻开始完整倒计时。小尺寸提示使用同一 inactive 流程，PromptInput 停用但不卸载；App 的退出／中断键继续可用。会话替换和清空则显式将 offset、新消息计数、尾部及 footer 基线重置到新会话，不能把两个会话的高度相减。其它编辑状态沿用对应会话命令原有契约。

resize、TODO 宽度改变、会话替换、清空、小尺寸提示、退出均取消拖条和待处理目标，使用当前实际宽度重建高度 key。普通重排保持从底部偏移后 clamp，沿用原有可预期行为；不承诺 resize 前后同一文字的像素坐标相同。视口几何版本只因边界／宽度／活动状态改变而递增，不能因为正常滚动或流式 contentRows 更新每帧取消拖动。

### 3.8 滚动条绘制与几何

复用 `thumbRange` 的比例算法，但为聊天新增可选参数 `reserveTravel=false`，默认保持其它调用者不变；聊天传 true。当 C>V 且 V>=2 时，`size=min(V-1,max(1,round(V*V/C)))`，确保至少一格 travel；其余沿用原函数。`travel=V-size`；`start=round((overflow-offset)/overflow*travel)`。例如 V=20、C=21 时 size=19，而不是原来的 20。V<=1 无可拖动空间，保持键盘退路。无溢出时仅画轨道，不可拖动。无颜色模式也依靠不同字符区分；Unicode 使用 `pickGlyphs` 的轨道／滑块，ASCII 使用 `|`／`#`。轨道颜色使用 `theme.muted`，滑块使用 `theme.primary`，拖动时 bold；不使用隐去轨道的空格或只有颜色区别的空白背景。

指标列宽固定 1、`flexShrink=0`，每行一格，不跨行包装；不引入动画。它属于整个中部横向行，位于 TODO 之后。有效全屏帧中，轨道终端坐标 x=cols、top=2（1-based），height=V；该契约由固定 1 行 Header 保证，并用帧测试校验。其它容器加 padding 的未来改动必须同时调整这份几何契约。

几何分为 Yoga 已布局快照与输出有效尺寸两层。当前 Ink 先同步 calculateLayout，但输出受 32 ms 节流，不能宣称 useLayoutEffect 就等于屏幕已经刷新。CLI 在原始 stdout resize 事件立即使 scrollbar bridge 的 `frameReady=false` 并 cancel，不能等 App 的 50 ms 尺寸去抖。在 stdout 写入边界增加轻量 `frame-observer.ts`：从 `frame-differ.ts` 提取已有擦行前缀识别逻辑到共用 `frame-parser.ts`，由纯函数 `parseInkFrame` 识别完整帧，另覆盖首帧无前缀形式；它们都是实施新增接口。核对行数／显示列、聊天轨道列与当前真实终端尺寸及布局尺寸，只有对应有效全屏帧交给真实 stdout 后才调用 `markFrameReady`。首次进入、overlay／小尺寸恢复也必须等待有效聊天帧。首帧可能先于 layout effect 写出，因此观察器保留最后一份尺寸与轨道摘要，发布布局时也执行相同匹配，不依赖再来一帧才能启用。无法识别／外部写入时使摘要及 ready 失效，等待下一完整帧；不从鼠标 handler 直接补写屏幕。

观察包装放在 Ink stdout 与现有差分 writer 之间，`--no-diff-render` 也经过它；不改变差分算法、写入返回值、回调或背压语义。frame 元数据仅用于尺寸有效性，不复制 offset 所有权。普通流式更新允许滑块相对最新布局有一个输出周期的视觉滞后，控制器使用最新有效几何且按下不定位；不为每个 token 建立逐帧握手。该限定取代“任何布局提交都已显示”的不实保证，真实交互延迟仍受 §8.3 约束。

拖动命中范围精确为轨道一列，不抢占旁边 TODO 文字。无溢出点击该列消费但不滚动、不复制。左键在滑块内按下记录 `grabRow = y - trackTop - thumb.start`，初始按下不得跳动。拖动时 x 可离开轨道，y 夹紧在轨道范围：

```text
thumbTop = clamp(y - trackTop - grabRow, 0, travel)
offset = overflow - round(thumbTop / travel * overflow)
```

`travel <= 0` 时不执行除法且不启动拖动。顶部必须精确达到 overflow，底部必须精确达到 0，直接定位不使用两行吸附容差。内容增长改变 size 时，将 grabRow 夹到新的 `[0,size-1]`，使用最新已提交几何重新换算；按下后指针没动不能重算绝对比例而使历史跳动。

捕获保存 `lastPointerY` 和 `pendingY`。press 仅记录位置；同 y 的 drag（包括只改变 x）不产生新定位。release 的 y 若与最后指针 y 相同，仅 flush 已存在的 pendingY，禁止把 thumb.start 再反算一次；有不同 y 才把 release 当最后移动坐标。因此 V=20、C=100、offset=41 的一次按下／原位释放仍为 41，而不会因滑块量化跳成 40。flush 后清空 pendingY，重复 release 不重复提交。

点击滑块上方轨道执行一次 pageUp，下方执行一次 pageDown，步长复用 `pageSize(V)`；按住轨道不连发，不把轨道点击转为滑块拖动，但消费至对应 release，避免文字选择收到半个手势。右键、中键和带修饰键的报告不触发拖条，保留原行为。

上句的修饰键规则只用于**未捕获时的 press**。捕获后的左键 drag／release 始终由原所有者消费，期间按下 Shift／Ctrl／Alt 不转给选择控制器。右键／中键 press 取消旧捕获再按原行为处理。无溢出的左键轨道 press 建立仅消费、不翻页的 track 捕获，直至 release／cancel，避免把半个手势泄漏到正文选择。

### 3.9 鼠标路由、能力与清理

继续使用 `stdin-filter` 清除所有鼠标转义，`MouseEvent` 不变。新增 `input/pointer-router.ts`，在 CLI 建立一个从原 MouseSource 到文字选择的过滤源：对按钮事件先调用晚绑定 scrollbar handler；若返回 consumed=true，则不发送给 SelectionController；否则按到达顺序送入 selectionSource。滚轮仍由 App 的既有 useWheelRouting 订阅原源，并且仍转发到 selectionSource，让现有 SelectionController 保留“滚轮取消正文选择”的行为。禁止依赖两个监听器谁先 setState，也不向共享事件对象写 consumed 标记。

滚动条 handler 在视口 effect 中绑定到 terminal scrollbar bridge。handler 同步判定按下并设置内部 capture，再通知 React hold；这样紧随按下到来的同批拖动不会漏接。开始拖条时清空文字选择及滚轮累计；正文起手的选择即使后来进入轨道，也不会被劫持，因为拖条只能由新的轨道 press 开始。拖条期滚轮消费后忽略，以免两种手势竞争偏移；新增 `isPointerCaptured` 只读回调供 useWheelRouting 在事件和 flush 时复查。

按钮移动报告的门控改为 `wantMotion = mouseOn`，文字选择仍为 `wantSelect = mouseOn && config.mouseSelect`。将 wantMotion 传给 `enterAltScreen`，从而 `--no-mouse-select` 只关闭文字选择，保留拖条；`--no-mouse`、`/mouse off`、非 TTY、VT 输入不可用时无拖条事件。滚动条依然可视，键盘滚动可用。沿用现有 Windows VT 探测与有限超时 helper，不增加每次拖动的 PowerShell 进程。

`screen.ts` 继续成对开启／关闭 `1000`、`1002`、`1006`，不改括号粘贴 `2004` 和 alternate-scroll `1007` 的恢复职责。正常退出、异常退出、`/mouse off`、overlay、resize、键盘编辑、会话切换、桥接解绑，都必须 cancel capture、清除 16 ms coalescer 和释放 hold。丢 release 使用与选择一致的 30 秒静止 watchdog，每个 drag 重置；超时只取消，不跳位置。晚到的 drag／release 不得重新建立 capture。

拖动每 16 ms 最多发布一个最新 y，合并绝对目标而非累加移动量。release 先同步应用最后坐标再结束；取消只丢弃待提交坐标。flush 再检查 active、鼠标捕获和几何版本；已无效则丢弃。正常移动不直接写 stdout，走现有 React／frame-writer 管线；鼠标快速移动不应解除 render governor 或触发整屏 clear。

## 4. 接口设计

无新增 REST、WebSocket、CLI 参数或公共 Core 导出。下列为 CLI 内部 TypeScript 接口约定，源码实现使用 `.js` 导入后缀。命名中的新接口均为计划新增，不是声称已有导出。

| 位置／接口 | 签名或新增字段 | 语义 |
| --- | --- | --- |
| `layout/document-layout.ts` | `buildDocumentLayout(input: DocumentLayoutInput): DocumentLayout` | 输入 rows、bodyRows、footerRows，返回 V、paddingRows、contentRows 和 trailingContentRows |
| `layout/viewport-geometry.ts` | `ViewportGeometry.trailingContentRows: number` | 默认 context 为 0，消息列表之后的文档行数 |
| `layout/virtual-window.ts` | `SelectWindowInput.trailingContentRows?: number` | 省略保持旧算法行为，传入时按第 3.4 节计算窗口 |
| `layout/follow-state.ts` | `FollowInput.layoutTailDelta?: number` | 默认 0；使用旧已渲染 offset，一次合并 tailDelta 与布局尾部增量再 clamp |
| `layout/todo-layout.ts` | `TodoRailLayoutInput.composerBaseRows?: number` | 全屏补全预算显式扣输入自然高度；默认 0 兼容旧独立调用，App 必须传实值 |
| `layout/scroll-indicator.ts` | `thumbRange(V,C,offset,reserveTravel=false)` | 聊天为 true，有溢出且 V>=2 时至少保留一格滑动距离 |
| `layout/scrollbar-geometry.ts` | `offsetForThumb(input: ThumbOffsetInput): number` | 有限整数输入校验、clamp、零 travel 和正反向公式 |
| `layout/ScrollViewport.tsx` | `footer?: ReactNode; rail?: ReactNode; overlay?: ReactNode; active?: boolean` | active 默认 true，现有直接挂载测试仍可用；无 footer 不强制短文档填充 |
| 同上 | `scrollbar?: ScrollbarBridge; onComposerVisibilityChange?: (visible: boolean) => void` | bridge 可缺省；只在布尔值变化时发布可见性 |
| 同上 | `composerRef?: React.RefObject<DOMElement>` | footer 整体用于尾部补偿，Composer 区域用于光标可见性判断 |
| `ui/scrollbar-controller.ts` | `createScrollbarController(options: ScrollbarOptions): ScrollbarController` | 非 React 控制器，最多一个 options 对象，持有手势和 timer，不持有第二份 scroll offset |
| `ScrollbarController` | `handle(event: MouseEvent): boolean; cancel(): void; dispose(): void; isCaptured(): boolean` | consumed 返回值供优先路由；options 提供 getGeometry、setOffset、page、onHold、onStart、isEnabled |
| `ScrollbarBridge` | `handle: ((event: MouseEvent) => boolean) \| null; cancel: (() => void) \| null; isCaptured: (() => boolean) \| null` | CLI 创建，视口挂接，卸载清空；桥接无 offset 副本 |
| 同上 | `frameReady: boolean; invalidateFrame(): void; markFrameReady(summary: FrameSummary): void` | 原始 resize／inactive 同步失效；按当前布局匹配输出摘要，不发布另一套滚动状态 |
| `ui/frame-parser.ts`／`ui/frame-observer.ts` | `parseInkFrame`／`observeInkFrames(options): FrameObserverHandle` | 共享纯帧识别；包装 stdout、保留最近帧摘要及幂等 dispose；透传全部写入语义 |
| `input/pointer-router.ts` | `createPointerRouter({source, scrollbar}): {selectionSource: MouseSource; dispose(): void}` | 唯一过滤层，保持事件顺序，dispose 幂等 |
| `ui/App.tsx` terminal bridge | `scrollbar?: ScrollbarBridge` | 即使关闭文字选择也提供 scrollbar，inline 不建立 |
| `ComposerProps`／PromptInput props | `cols?: number; cursorVisible?: boolean; onInteraction?: () => void` | 默认兼容；视觉光标和键盘活跃分离，实际编辑分支调用回调 |
| 仅 `ComposerProps` | `measureRef?: React.Ref<DOMElement>` | 挂到 Composer 最外层 Box，不改变 PromptInput 的父节点或 key |
| `WheelRoutingOptions` | `isPointerCaptured?: () => boolean` | 默认 false，拖条时不积累或 flush 滚轮 |

直接 setOffset 是视口内闭包能力，仅传给控制器；App 仍只发送原来的 ScrollIntent／pin nonce。所有几何 getter 在事件触发和 timer flush 时读取最新值，回调稳定化，订阅不因每个流式 token 重建。

## 5. 数据模型与不变量

无数据库变更，无配置迁移，无会话 JSON schema 变更。所有新增数据只存在于当前 TUI 生命周期。

| 内存结构 | 字段 | 所有者与生命周期 |
| --- | --- | --- |
| `DocumentLayoutInput` | rows、bodyRows、footerRows | 纯计算参数，全为非负有限行数 |
| `DocumentLayout` | viewportRows、paddingRows、contentRows、trailingContentRows | 纯派生，不能额外驱动跟随计数 |
| `ScrollbarGeometry` | trackTop、trackCol、trackRows、contentRows、offset、thumb、revision | 视口测量提交后发布，坐标 1-based，thumb.start 为 0-based |
| `ThumbOffsetInput` | geometry、pointerY、grabRow | 单次绝对定位输入，非法数值不制造 NaN offset |
| `ScrollbarCapture` | kind=`thumb` 或 `track`、grabRow、revision、lastPointerY、pendingY | 控制器私有；null 表示未捕获；不保存持久化偏移；同 y 事件不重复定位 |
| `ScrollbarOptions` | 几何 getter、定位／翻页 callback、hold callback、onStart、enabled getter | 创建控制器时传入，变动数据通过 ref 读取 |
| `footerRows` 与 `previousFooterRows` | 测量值及上次有效值 | 视口局部，display:none 时不覆盖 |
| `scrollbarHold` | boolean | React 展示状态；跟随／timer 另同步读取 isCaptured，与 selectionHold 做 OR，不互相赋值 |
| `FrameSummary` | columns、rows、trackTop、trackRows、轨道存在性、geometry revision | 输出观察器保存最近一份；仅用于开启尺寸命中，不持有 offset |
| 冻结基线 | offset、tailRows、bodyRows、footerRows、paddingRows、布局尺寸 | active=false 时冻结，恢复一次应用或在重排／会话重置时重新建立 |

实施时必须保持以下约束：

1. offset 唯一所有者是 ScrollViewport；显示用 scrolledLines 不可反馈成为第二份控制状态。
2. `0 <= offset <= max(0,C-V)`，且 frameHeight 始终小于终端行数。
3. 同一条鼠标 press 到 release 只能执行文字选择或滚动条行为之一。
4. footer 不随 offset 卸载；编辑状态与界面可见性独立。
5. scrollbar 的绘制列、命中列和实际终端列完全一致；TODO 显隐不影响它的最右位置。
6. 新消息计数只来自消息尾部；footer、宽度重排和虚拟化测量都不能伪造新消息。
7. 一次拖动最多一个合并 timer，一个 watchdog；所有终止分支均可重复调用清理。
8. 每条正文的实际可用宽度等于高度缓存的 cols；禁止把终端全宽误传给较窄输入区。
9. 隐藏聊天期间没有恢复 timer 改写 offset；小尺寸提示不得卸载编辑器；隐藏 overlay 不接收输入。
10. 布局补偿只解释尾部变化，消息计数不包含填充／footer；所有增量合并后只 clamp 一次。
11. 原始 resize 立即使命中失效；只有尺寸匹配的实际输出才重新启用，布局提交不能单独证明已绘制。

## 6. 文件／模块变更计划

以下是后续实施的目标清单。本评审节点仅更新第一行文档；其余路径在实施节点变更。表内分组路径均为独立文件，不能把测试写入生产模块。

| 文件 | 操作 | 意图 |
| --- | --- | --- |
| `docs/plans/tui-unified-scrollbar/spec.md` | 新增／评审更新 | 本规格，后续记录评审及实施偏差 |
| `packages/cli/src/ui/layout/document-layout.ts` | 新增 | 统一行预算、短文档填充与尾部几何纯函数 |
| `packages/cli/src/ui/layout/scrollbar-geometry.ts` | 新增 | 拖条命中与绝对偏移反算，复用 thumbRange |
| `packages/cli/src/ui/scrollbar-controller.ts` | 新增 | 手势捕获、16 ms 合并、释放、watchdog、bridge 类型 |
| `packages/cli/src/ui/frame-parser.ts` | 新增 | 从差分器抽取完整帧识别，保留首帧与异常输入边界 |
| `packages/cli/src/ui/frame-observer.ts` | 新增 | 在输出边界确认有效聊天尺寸，resize 同步失效，兼容关闭差分 |
| `packages/cli/src/ui/frame-differ.ts` | 修改 | 使用共用帧解析辅助函数，保留原有差分／首帧／回退行为 |
| `packages/cli/src/input/pointer-router.ts` | 新增 | 滚动条优先的文字选择过滤鼠标源 |
| `packages/cli/src/cli.tsx` | 修改 | 创建路由／bridge、拆分 motion 与 select 能力、各退出分支清理 |
| `packages/cli/src/ui/screen.ts` | 修改 | 更新 motion 契约注释，核对关闭与恢复路径 |
| `packages/cli/src/ui/App.tsx` | 修改 | 组装统一文档、实际列宽、稳定 overlay、编辑 pin、拖条 hold 接线 |
| `packages/cli/src/ui/layout/AppShell.tsx` | 修改 | fullscreen 固定区域缩减为 header／toast／status，inline 顺序保留 |
| `packages/cli/src/ui/layout/ScrollViewport.tsx` | 修改 | footer 测量、填充、滚动条 bridge、尾部补偿和覆盖层稳定树 |
| `packages/cli/src/ui/layout/ScrollIndicator.tsx` | 修改 | 聊天最右列常驻与拖动视觉状态，取消聊天窄屏隐藏 |
| `packages/cli/src/ui/layout/viewport-geometry.ts` | 修改 | 发布 trailingContentRows，保留默认上下文兼容 |
| `packages/cli/src/ui/layout/virtual-window.ts` | 修改 | 消息选择窗口支持末尾附加内容 |
| `packages/cli/src/ui/layout/follow-state.ts` | 修改 | layoutTailDelta 默认 0，合并后单次 clamp，消息计数仍只读 tailDelta |
| `packages/cli/src/ui/layout/scroll-indicator.ts` | 修改 | 聊天 reserveTravel，避免轻微溢出无法拖动 |
| `packages/cli/src/ui/Transcript.tsx` | 修改 | 传入统一几何，保持消息计数和虚拟缓存边界 |
| `packages/cli/src/ui/layout/budget.ts` | 修改 | 全屏 viewportRows 改为固定三行 chrome，保留草稿 clamp 和输入高度辅助函数 |
| `packages/cli/src/ui/layout/todo-layout.ts` | 修改 | TODO 按完整 V 投影，不扣 footer，使用已预留条列的宽度 |
| `packages/cli/src/ui/Composer.tsx` | 修改 | 透传实际宽度、光标可见性及编辑开始回调 |
| `packages/cli/src/ui/PromptInput.tsx` | 修改 | 用实际列宽排版，复用既有编辑分支触发 pin，隐藏不可见光标 |
| `packages/cli/src/ui/use-wheel-routing.ts` | 修改 | 拖条 capture 期间取消积累并在 flush 时复查 |
| `packages/cli/src/ui/StatusBar.tsx` | 修改 | 输入框不可见时仍展示历史／返回提示与中断提示 |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | 修改 | 区分拖条和文字选择，说明输入框随滚动及编辑返回 |
| `packages/cli/README.md` | 修改 | 更新全屏布局、鼠标开关及宿主降级说明，清除矛盾旧叙述 |
| `packages/cli/src/__tests__/document-layout.test.ts` | 新增 | 行预算、填充、有限输入和尾部补偿数值用例 |
| `packages/cli/src/__tests__/scrollbar-controller.test.ts` | 新增 | 拖动、轨道翻页、绝对几何、竞态、取消和 watchdog |
| `packages/cli/src/__tests__/pointer-router.test.ts` | 新增 | 选择／拖条互斥、订阅清理与晚到事件 |
| `packages/cli/src/__tests__/frame-observer.test.ts` | 新增 | 首帧、resize、输出迟于布局、无差分、未知写入及清理 |
| `packages/cli/src/__tests__/frame-differ.test.ts` | 修改 | 抽取解析逻辑后的完整既有差分语义回归 |
| `packages/cli/src/__tests__/follow-state.test.ts` | 修改 | 同周期增量相抵、单次 clamp、填充耗尽与 hold |
| `packages/cli/src/__tests__/helpers/terminal-harness.tsx` | 新增 | 可变 rows／columns 的真实 Ink 布局与输入源测试夹具 |
| `packages/cli/src/__tests__/unified-scroll-layout.test.tsx` | 新增 | 输入区逐行滚出、最右条、TODO、草稿、粘贴、覆盖层集成 |
| `packages/cli/src/__tests__/scroll-indicator.test.ts` | 修改 | 40 列可见、无颜色、无溢出与反算端点 |
| `packages/cli/src/__tests__/virtual-window.test.ts` | 修改 | trailingContentRows 的交集、短会话与长 footer |
| `packages/cli/src/__tests__/transcript-virtual.test.tsx` | 修改 | 上下文投影与实际渲染窗口一致 |
| `packages/cli/src/__tests__/scroll-follow.test.tsx` | 修改 | 真实高度下消息／footer 同时变化、overlay 暂停恢复 |
| `packages/cli/src/__tests__/mouse-routing.test.tsx` | 修改 | 拖条时轮滚禁止、取消后轮滚恢复、overlay flush 竞态 |
| `packages/cli/src/__tests__/screen.test.ts` | 修改 | motion 独立于文字选择开关、启停序列对称 |
| `packages/cli/src/__tests__/budget.test.ts` | 修改 | 用统一文档预算替换固定输入预算断言 |
| `packages/cli/src/__tests__/todo-layout.test.ts` | 修改 | TODO 高度不随补全变化及预留条列断点 |
| `packages/cli/src/__tests__/todo-app-layout.test.tsx` | 修改 | TODO 右侧仍有末列滚动条，输入使用正文宽度 |
| `packages/cli/src/__tests__/scroll-chip.test.tsx` | 修改 | 底部距离语义、返回提示不依赖已滚走的输入框 |
| `packages/cli/src/__tests__/prompt-input-commits.test.tsx` | 修改 | 首字符／粘贴不丢不重，兼容回调缺省 |
| `packages/cli/src/__tests__/render-budget.test.tsx` | 修改 | 拖动长会话仍满足虚拟化上限 |

不修改 `mouse-events.ts`、`stdin-filter.ts` 的协议形状，不重写 selection-controller，不新增 runtime 依赖。现有 glyphs 已提供所需字符，无需新增字符常量。App 和 cli 已超过仓库行数限制，当前 `.claude-index/config.md` 没有记录例外。实施前必须统计这两个文件的基线，在该配置的新增“本功能历史文件例外”节记录精确路径、基线行数、限于本次接线的最多 100 行净增额度和原因；该记录为实施清单中的额外文档修改，明确作为 `CLAUDE.md` 所允许的有记录例外。新模块／函数仍遵循全部默认阈值。若接线超过额度，则把本功能组装逻辑提取到 CLI 内独立模块，更新清单，不扩大成无关重构。不能把“只做接线”当成无需记录的默认豁免。本评审不修改此配置。

## 7. 操作时序与实施顺序

一次普通拖动：终端发送 SGR → stdin-filter 去掉协议字节 → pointer-router 先交给 scrollbar handler → 命中滑块并同步 capture → 清理选择与 pending wheel → 合并拖动坐标 → 视口用当前几何算 offset → 同一偏移驱动消息、footer 和指示器 → release 提交最后坐标并释放 hold → 按现有配置恢复跟随计时。

一次编辑返回：PromptInput 识别可处理动作 → onInteraction 取消拖条／轮滚并 pin → 原 reducer 处理一次编辑 → 输入框在文档尾部可见 → 草稿布局重测 → pinned 下 offset 保持 0。不要用“先停用输入，等 App 捕获首字符再重新发送”的两阶段机制。

实施顺序固定为：

1. 记录 §6 的历史文件例外或完成必要的本功能拆分；增加几何和控制器失败用例，分别复现缺少拖条与输入固定的可观察行为。
2. 实现 document-layout、scrollbar-geometry、controller 和 pointer-router 纯／非 React 层。
3. 接入统一文档、尾部坐标和实际输入宽度；先保证键盘滚动、短会话和虚拟化正确。
4. 接入 motion 能力、鼠标优先路由和生命周期，验证文字选择与拖条互斥。
5. 接入编辑返回、稳定 overlay、状态提示，更新旧布局断言与 README。
6. 运行类型检查、定向回归、完整测试与构建，完成 Windows 真终端验收后提交实施结果。

## 8. 测试与验收标准

### 8.1 纯逻辑与交互边界

| 编号 | 输入／场景 | 必须观察到的结果 |
| --- | --- | --- |
| T01 | V=20，C=100，offset=0／80 | thumb size=4，start=16／0；反算准确到 0／80 |
| T02 | V=20，C=100，offset=40；在滑块内第 2 行按下 | 按下不跳；grabRow 保持，移动 x 不终止拖动 |
| T03 | 无溢出、V=0、V=1、非法或越界坐标 | 无 NaN、无零除、无死锁；非法输入不改变有效位置 |
| T04 | 点击上下轨道、长按、release | 一次 pageSize，长按不连续翻页，不触发复制 |
| T05 | 100 个 drag 在同一 16 ms 窗口 | 仅发布末坐标；release 无须再等 timer，落点正确 |
| T06 | drag 与 output、footer 缩放同周期 | 非 pin 时阅读锚定；用户定位优先；未发生双倍补偿 |
| T07 | 鼠标释放丢失，推进假时钟 30 秒 | capture 和 hold 解除；下一次新 press 正常；晚到 release 无复制 |
| T08 | resize／overlay／mouse off／dispose 发生在 timer 前 | pending 目标丢弃，timer 和监听器全部清理 |
| T09 | 正文选择移入条列、条列拖动移入正文 | 每次手势仅一个所有者；前者只复制、后者只滚动 |
| T10 | T=100，V=20，F=6，offset=0／10 | 消息可见区分别为 [86,100)／[76,96)，按 overscan 扩展，不能按 20 行消息误算 |
| T11 | 历史浏览时 F 从 6 变 9，再变 5 | offset 分别 +3、-4 后统一 clamp；新消息计数不变 |
| T12 | `scrollResumeMs=0`／非零；只有布局变化／真正新消息 | 只有配置允许且存在新消息时恢复；hold 阻止恢复 |
| T13 | V=20，旧 B=70、F=10、offset=60；tailDelta=+5、footerDelta=-10，新 overflow=55 | 最终 offset=55；不得先按新 overflow 截成 55 再补偿成为 50 |
| T14 | V=20，旧 B=12、F=6、padding=2，offset=0、hold=true；消息增加 5 行 | 新 padding=0、overflow=3、offset=3，原有消息屏幕位置不动；仅新增消息进入计数 |
| T15 | V=20、C=21；另取 C=100、offset=41，原位 press／同 y drag／release | 前者 travel=1 可到两个端点；后者保持 41，不因量化变为 40；默认 reserveTravel=false 的旧调用不变 |
| T16 | 同批 press→tail 更新；拖动中按修饰键；正文选择中滚轮；无溢出轨道点击 | 同步 hold 阻止回底；捕获不中途交给选择；正文选择按既有行为取消；无溢出手势只消费不复制 |
| T17 | footer 独立增高但被短文档 padding 全部抵消；resize 导致输入重新换行 | 前者 offset 不动、不新增计数；后者重建基线，只保持旧 offset 后 clamp，无伪造消息 |

### 8.2 真实 Ink 布局集成

默认 ink-testing-library stdout 不提供可信高度，原有 scroll-follow 测试明确只是 smoke，不能据此宣布拖条可用。新增夹具必须给真实 Ink `render` 注入 rows、columns、TTY、resize EventEmitter 和可推入数据的 stdin；使用固定高度父容器、`exitOnCtrlC:false`、`patchConsole:false`，必要时调用底层流读取模拟输入。debug 完整帧用于内容位置断言；差分写入与恢复沿用已有 frame-writer／screen 测试验证，不混为一个断言。

| 编号 | 场景 | 验收结果 |
| --- | --- | --- |
| A01 | 40×12、49×20、80×24、120×40；空会话和长历史 | 全屏每帧最右列可见轨道；内容无越界；不多出第 rows 行 |
| A02 | 输入框 4 行，历史足够长，逐行 scrollUp | 输入框逐行离开，滚至其完全隐藏后消息可占满 V，底部没有空的输入占位 |
| A03 | 多行草稿、中文、emoji、粘贴 token、光标不在末尾，连续上滚与回底 | 草稿和光标保持；首个编辑动作只执行一次；粘贴原文未泄露成协议字符 |
| A04 | TODO 显隐及宽度断点 76／77，80／120 列 | 最右列始终为条；正文／Composer 使用同一宽度；无重新挂载导致的偏移归零 |
| A05 | 补全开启、团队状态变化、toast 出现与消失 | footer 正常滚动，TODO 高度稳定，通知和运行指示仍可见 |
| A06 | 浏览历史期间 agent 连续输出，overlay 开关 | 浏览锚点保持，关闭后不重放旧 wheel；保留输入草稿，pending 交互清理 |
| A07 | `--no-mouse-select`、`--no-diff-render` | 前者仍可拖条但不文字复制；后者功能正确，只允许渲染策略退化 |
| A08 | `--no-mouse`、VT helper 失败、inline、非 TTY | 前两者有可视条及键盘滚动；后两者不启用本全屏机制、不泄漏鼠标控制序列 |
| A09 | 10000 条保留范围内消息、一个超长工具结果，持续拖动 | 挂载条目仍由可见窗口和 overscan 限制，不退化为全量渲染 |
| A10 | 正常退出、Ctrl+C 退出、渲染初始化失败 | 还原终端模式，监听器／timer 无泄漏，后续 shell 鼠标行为正常 |
| A11 | 已开启恢复 timer 时打开 overlay，推进超过 resumeMs；期间追加消息再关闭 | 隐藏期间 offset 不变；恢复一次补偿，从恢复时完整计时；已关闭 ModelPicker 不再接收方向键 |
| A12 | 有中文草稿／粘贴块／非末尾光标时，从 80×24 缩至 39×11，再恢复 | 提示出现，编辑输入停用，Composer 未重新挂载；恢复后草稿／光标／粘贴一致，滚动不重放 |
| A13 | 补全打开且输入已滚出，依次 Shift+Up／Down、PgUp／Dn、普通方向键、粘贴 | 前四个视口键不改变补全选择、不 pin；普通编辑或合法粘贴只返回一次、不丢首字符 |
| A14 | 非 debug Ink，连续 resize 及 resize 后 50 ms 内点击旧／新末列；分别启用和关闭差分 | 尺寸失配期间不捕获；有效聊天帧输出后可拖动；首帧早于布局 effect 时不永久禁用；无需强制全屏 clear |
| A15 | 团队自然高度刚好满足 V-composerBaseRows-3；提示关闭与补全展开 | 团队不因重复扣三行而过早折叠；输入／补全预算一致且 TODO 高度仍为 V |

### 8.3 Windows 真终端与性能

至少实测 Windows Terminal＋PowerShell 7，以及 conhost＋Windows PowerShell 5.1；分别记录 Windows 构建、终端版本、Node 版本、VT helper 结果、Unicode／ASCII 和主题。Node 测试至少覆盖仓库已有 VT 判定阈值两侧的一个版本。不得把 PowerShell 版本当成终端宿主能力判断。

操作采用脚本化／本地夹具产生 200 条消息并持续追加，无需真实模型或 API 密钥。依次记录：首帧轨道、拖到顶／中／底、输入框滚出、草稿返回、TODO、补全、选择复制、`/mouse off`／on 和退出恢复。截图中标记最右列与 footer 位置；记录控制台是否实际收到 SGR drag。若宿主不提供移动报告，必须标注“键盘降级通过、拖动能力不可用”，不能写成拖动通过；支持协议的 Windows Terminal 上拖动是必需验收项。

性能目标：指针事件到可见帧延迟 P95 ≤100 ms，连续拖动无持续超过 200 ms 的卡顿。测量使用同一机器、同一消息集、固定窗口尺寸的 30 秒样本，并同时记录 `/perf` 的 mountedEntries 与 governor 状态。这是实施验收目标，不是本设计节点实测数字。除了正常 resize／外部输出导致失效，不得每次拖动发送 clearTerminal；不通过提高全局输出频率掩盖重复渲染。

### 8.4 实施节点命令

在仓库根目录逐条运行，先确认上一条退出状态，再执行下一条；不在 PowerShell 5.1 中用 `&&` 连接：

```powershell
npm run typecheck -w packages/cli
npm test -w packages/cli -- src/__tests__/document-layout.test.ts src/__tests__/scrollbar-controller.test.ts src/__tests__/pointer-router.test.ts src/__tests__/unified-scroll-layout.test.tsx
npm test -w packages/cli -- src/__tests__/frame-observer.test.ts src/__tests__/frame-differ.test.ts src/__tests__/stdout-frame-writer.test.ts
npm test -w packages/cli -- src/__tests__/scroll-indicator.test.ts src/__tests__/virtual-window.test.ts src/__tests__/transcript-virtual.test.tsx src/__tests__/scroll-follow.test.tsx src/__tests__/follow-state.test.ts src/__tests__/mouse-routing.test.tsx src/__tests__/screen.test.ts
npm test -w packages/cli -- src/__tests__/budget.test.ts src/__tests__/todo-layout.test.ts src/__tests__/todo-app-layout.test.tsx src/__tests__/scroll-chip.test.tsx src/__tests__/prompt-input-commits.test.tsx src/__tests__/render-budget.test.tsx src/__tests__/glyphs.test.ts
npm test
npm run build
```

不因旧断言失败就删除测试；仅调整已经被本需求明确替代的固定输入栏／50 列隐藏／motion 跟随文字选择约束，其余兼容性用例必须通过。真实终端结果与自动化测试分别记录，不互相代替。

## 9. 风险与缓解

| 风险 | 缓解及已确定边界 |
| --- | --- |
| 用户机器上的“条不显示”还有字体、主题或宿主问题 | 本方案取消宽度隐藏、提高字符可辨识度、固定末列；实机按绘制与输入分别取证，不预设都由 Windows VT 引起 |
| 输入框入文档后出现高度反馈环 | 一处 offset，独立 footer 测量，补偿不读取虚拟窗口选择结果；数值相同不触发状态更新 |
| 选择复制与拖动竞争 | CLI 层过滤源先路由，再送选择；不用 React 异步状态争抢事件 |
| 窄输入宽度与 stdout 全宽不一致 | 显式 cols 从布局透传，中文／emoji 用真实帧和 string-width 验证，不用字符串 length 判断显示列 |
| 虚拟高度估计导致滑块位置小幅修正 | 延续现有测量校正；允许一帧几何收敛，不允许 offset 在总高度反馈环中振荡 |
| 流式输出与拖条比例目标不同步 | 只在新 pointer 坐标时做绝对定位；否则继续尾部锚定，使用最新提交几何 |
| 输入框不可见时误发送或丢首字符 | 既有键语义保持，在实际编辑分支同步 pin，不复制／重放输入事件，测试 Enter 与大段粘贴 |
| display:none 使测量归零或草稿丢失 | 保持树与 key，inactive 暂停度量覆盖，恢复时一次吸收尾部增量 |
| 旧 Node／受限控制台没有鼠标协议 | 复用 VT 探测与有限 helper；保留可视条和键盘退路，不承诺不可用宿主可拖动 |
| 没有 release 导致永远暂停 | 30 秒静止 watchdog 与显式 cancel 路径，晚到事件不重新捕获 |
| 修改底部布局破坏 spinner／通知／中断可见性 | 活动栏与 StatusBar 固定，保留现有单 spinner 约束，中断提示不只放在输入框 |
| 测试把无高度 viewport 当成功 | 新夹具注入真实 rows／cols，至少一个集成断言证实 overflow>0 且输入框确实移出 |
| 扩大重构范围 | 新机制独立模块；不改 Core、不换 UI 框架、不引入依赖、不改变 inline 或持久化格式 |
| 短文档或同周期伸缩出现阅读跳动 | tail／footer／填充抵消一次计算后 clamp，按 T13–T17 验证反例 |
| 布局已经更新但屏幕仍显示旧尺寸 | 原始 resize 立即禁用捕获，输出观察器按尺寸及轨道确认；允许正常 token 更新的一帧视觉滞后 |
| 稳定挂载后隐藏组件仍执行副作用 | inactive 冻结跟随及计时器；overlay 子内容卸载；小尺寸只隐藏编辑器 |

## 10. 设计交付检查与后续交接

本规格已完成 v2 设计评审。实施节点按第 6 节清单和第 7 节顺序落地，任何实施偏差须同步修改公式、接口及验收断言。评审通过不等于用户功能已经修复；本评审仅修改 spec.md，没有执行源码测试、构建或实机验收，也没有提交 Git。

实施与发布门禁：先通过类型检查、定向回归、完整测试及构建，再按 §8.3 记录 Windows Terminal 的拖动实测；conhost 若缺少协议可登记键盘降级，不能代替 Windows Terminal 的必测结果。无法取得实机证据时明确标为“实现待终端验收”，不能发布成已验证修复。性能目标使用相同机器与样本记录，不将 debug 夹具耗时当生产延迟。

回退使用现有能力：鼠标兼容性问题可用 `--no-mouse` 保留新布局与键盘滚动，差分输出问题用 `--no-diff-render`；统一布局本身异常时用已有 `--no-fullscreen` 临时绕开全屏。无需新用户配置、配置迁移或运行中切换布局。发布回退必须整组恢复布局／尾部换算／输入宽度／路由变更，不能仅恢复固定输入框却保留 trailingContentRows 等新公式；用户会话格式未变，可直接使用前一版本。发布和整组回退均属于后续实施／发布节点，本评审不执行。

本节点的完成门禁为：v2 标记、顶部评审记录、末尾结论齐备；全部 P0／P1 在正文有明确方案与验收入口；核对本节点仅编辑 spec.md；最后通过任务工具上报并查询服务端状态。

## 评审结论

**通过**。

设计在当前 React 18／Ink／TypeScript 栈上可实施。已修正 8 项 P1 和 3 项 P2，未发现 P0，无未解决的 P0／P1。单一文档偏移、输入状态连续性、鼠标所有权及虚拟化边界保持一致；新增输出观察仅解决尺寸命中窗口，不替换现有渲染器。

此结论为设计通过，允许进入实施。第 8、10 节的自动化、真实终端和发布门禁仍须由实施节点执行；本评审不宣称这些尚未执行的验证已经通过。

## 实施过程发现的方案缺陷

- 全量测试还包含 `todo-responsive.test.tsx`、`bottom-status-row.test.tsx`、
  `update-bottom-row.test.tsx` 对旧 AppShell 固定输入栏／旧预算的断言，清单遗漏。
  将三者追加到实施范围：保留原测试场景，改接统一 footer／rail 槽及新预算。
- 真实 non-debug Ink 复核发现快速 resize 回到原尺寸时没有新输出，单纯清空帧摘要会永久
  禁用拖动。输出观察器在尺寸稳定 60ms 后仅在仍未确认时请求一次普通 React 重绘，
  经现有 redraw nonce 产生完整 Ink 输入帧；不直接清屏或提高全局刷新频率。

- A03 的 emoji／非末尾光标组合暴露原编辑器左右键按 UTF-16 单元移动，会拆开代理对。
  在已列入范围的 PromptInput 中改为按 Unicode 码点跨越左右边界；不改粘贴协议及 reducer。
  真实 Ink 回归先复现乱码，再验证中文、emoji、粘贴内容和首个返回编辑字符的完整提交。

- R04/T15 的数值前提有误：现有 `round(20*20/21)` 实际为 19，并非 20。
  保留 `reserveTravel` 防线及默认兼容行为，测试以实际整数算法为准。
- 当前工作区在实施前已有输入生命周期相关改动和其它工作区的未提交文件。
  本次保留这些基线，不将已有修改误报为本次变更，也不执行清理或提交。


### 实施验证记录（2026-10-03）

- 第 6 节全部模块已实现，补入三处旧布局回归测试，未引入 runtime 依赖或更改鼠标协议。
- `ViewportGeometry.trailingContentRows` 类型保留可选以兼容已有独立 Provider；默认 context 和真实视口始终发布数值，窗口算法缺省值为 0。
- `npm run typecheck -w packages/cli`：退出 0，生产及测试 TypeScript 均通过。
- `npm test`：退出 0；CLI 209 文件、3083 通过、6 跳过；Core 29 文件、466 通过。故障回退用例打印的预期 rollback 错误文本不代表测试失败。
- `npm run build`：退出 0，CLI 和 Core 均构建成功。
- `node packages/cli/dist/cli.js --version`：退出 0，输出 0.6.7。
- `git diff --check -- .`：退出 0，无空白错误，仅 Git 换行转换提示。
- 真实 Ink 夹具覆盖四种尺寸、末列轨道、输入逐行滚出、中文／emoji／粘贴保留、同周期尾部伸缩、隐藏期间恢复计时冻结、捕获与清理、差分开关、快速 resize 往返及 10000 条历史挂载预算。日志位于 `.agentmesh/scroll-*.log`。
- 独立复核发现的快速 resize P1 已通过失败后修复的回归闭环处理，无遗留已确认 P0/P1。
- 当前环境为 Windows、Windows PowerShell 5.1、Node v22.18.0。本会话缺少可操作的 Windows Terminal/PowerShell 7 与 conhost 双宿主界面、屏幕采集及真实鼠标注入工具，因此 §8.3 的双宿主截图、SGR 实机采集、双 Node 版本运行和 30 秒 P95 性能目标仍待验证。真实 Ink 自动化不能替代上述实测。
- 交付状态为“实现待终端验收”；不能宣称发布门禁已通过。未运行 git commit、未发布，保留本次任务之前及并行任务的其它改动。

### 最终代码审查记录（2026-10-03）

本节为最终审查节点记录，前面的“未提交”描述保留为实施节点的历史状态。

| 审查项 | 结论与证据 |
| --- | --- |
| §6 变更清单覆盖 | 所列源码、文档及测试均已落地；追加历史文件例外、真实终端夹具，以及底部活动栏、更新通知与 TODO 响应式旧布局断言的调整 |
| 统一文档与虚拟化 | 消息、填充、团队和输入区共用 ScrollViewport 偏移；尾部附加行数进入窗口投影，footer 不进入持久化消息或高度缓存 |
| 草稿与输入 | 覆盖层和小尺寸隐藏保留编辑器；实际正文宽度透传，编辑返回仅消费一次输入；分页键在补全前排除 |
| 跟随与捕获 | 消息及 footer 增量单次 clamp，隐藏时暂停恢复；捕获同步互斥，轮滚清空，释放与取消分别处理待提交坐标 |
| 输出与退出 | 原始 resize 立即失效，真实输出确认后恢复；差分开关均经过观察器；订阅、计时器及鼠标模式有对称清理 |
| 最终修复 | 真实 Ink 复现 40 列状态栏输出 55 列；为重绘首列、操作提示、详情分别分配列预算，避免超宽帧阻断输出确认；补入四种宽度回归 |
| 命名、风格与注释 | 沿用现有布局、bridge、glyph 和测试夹具风格；清除 motion 绑定文字选择、覆盖层卸载和窄屏隐藏指示列等失效注释 |
| 范围 | 无新增依赖、无 Core 源码或协议修改；只逐文件暂存此功能，构建产物、任务运行文件和仓库其它改动不纳入提交 |

本节点重新执行验证：

- `npm run typecheck -w packages/cli`：退出 0。
- `npm test`：退出 0；CLI 210 文件、3084 项通过、6 项跳过；Core 29 文件、466 项通过。
- 随后将状态栏回归扩展到 40／49／80／120 列，定向运行 4 项全部通过。
- `npm run build`：退出 0；CLI 和 Core 构建成功。
- `node packages/cli/dist/cli.js --version`：退出 0，版本 0.6.7。
- `git diff --check -- .`：退出 0；日志保存在任务目录 `.agentmesh/scroll-final-review.log`。

最终结论：代码审查通过，允许按本节点要求创建本地 `feat:` 提交。
仍为“实现待终端验收”：§8.3 的双宿主、真实 SGR、双 Node 版本及 30 秒 P95
采样没有新增实机证据，发布门禁保持未通过。本地审查提交不等同于发布验收。
