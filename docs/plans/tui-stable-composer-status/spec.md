# TUI 固定输入区与精简状态栏设计

版本：v2；日期：2026-10-08；阶段：实施与代码审查完成，跨终端人工视觉验收待完成。

**目标：** 流式思考、回答和工具输出不改变输入框位置；输入框下默认只有一行英文状态，用户按 Ctrl+G 展开第二行。

**架构：** 将 Composer 从消息滚动文档移入 AppShell 的独立底部槽位；由统一高度预算分配正文、输入区和状态区；沿用现有 Ink 帧差分写入链路。

**技术栈：** TypeScript、React 18、Ink 5、Yoga、string-width、Vitest；npm workspaces；不增加运行时依赖。

实施时可按 superpowers:executing-plans 逐项执行第八节。当前评审节点仅修改本文档，不修改产品代码，不执行 git commit。

## 评审记录

评审依据为当前工作区源码、CLAUDE.md 和项目索引；已有未提交改动作为现状保留。逐节核查可行性、完整性、一致性及范围适当性。未发现 P0；以下 9 项 P1、3 项 P2 均已在正文修订，未解决 P0/P1 为 0。此结论批准设计，不代表运行时缺陷已修复或产品测试已通过。

| 编号 | 等级 | 问题与源码依据 | 正文处理及验收 |
| --- | --- | --- | --- |
| R01 | P1 | FrameBudget.composerRows 与 AppShell 同名参数未明确是否包含菜单；App.onDraftRows 延迟收缩、PromptInput 被动报告草稿，不能保证菜单与槽位同帧一致 | §3.1–3.2、§四区分 C/P/输入槽总高，定义同步报告与容量裁剪；A41 |
| R02 | P1 | StatusBar 写死三列分隔符，五个字段数组无法携带短格式的一列分隔符；格式器合格仍可能实际溢出 | §3.4、§四增加行计划及渲染契约；A42 |
| R03 | P1 | 原反馈仅有文本，ctrlCArmed 是 ref 且失效不触发渲染；复制 sent 不等于 confirmed，短文案不能都显示 Copied | §3.5 定义结构化反馈来源、到期和 Copy sent；A43–A44 |
| R04 | P1 | 反馈抢占停止提示后可能隐藏复制错误；补全打开时 Esc 实际关闭菜单，不能显示 Esc stop/force；详情也可能被长反馈挤满 | §3.5 定义执行状态与操作提示组合、预留真实 Esc 子句及提示开关边界；A45 |
| R05 | P1 | usageTotal 包含 teamUsage/fastUsage/compactionUsage；App 空闲时清零 elapsedMs，与主 Agent 平均速度、保留耗时及手动压缩计时承诺冲突 | §3.4、§四改为隔离的 UI 运行统计，明确时间来源和生命周期；A46–A48 |
| R06 | P1 | 40×12 展开时 V=3，OverlayFrame 至少需要四行，宽屏带边框需要六行；单纯传 V 会裁掉确认内容和操作 | §3.3 增加短高度弹层、可滚动正文及确认输入约束，补齐模块计划；A49 |
| R07 | P1 | 当前 App 全局按键无统一 tooSmall 早退，overlay 分支只拦截部分键；“放在既有保护之后”不能保证 Ctrl+G 被忽略 | §四明确独立守卫位置，保留 Ctrl+C 退出与原 overlay 按键归属；A50 |
| R08 | P1 | 选择清理只依赖位移/resize，固定输入槽几何变化还需主动取消拖动；等测量发布后处理有过期坐标窗口 | §3.3 明确几何修订前清理顺序和释放 hold；A51 |
| R09 | P1 | terminal-harness 捕获 stdout chunk 而非 React commit；300 个同步 delta 可被合并成一帧，VT 最终屏幕也不能证明输入行未被重写 | §6.1 区分事件、完整帧与 ANSI 写入，规定逐帧正向证据和重写观测；A52 |
| R10 | P2 | rows/cols 非法值处理未定义，最小屏幕以下仍套正常高度方程会产生负数 | §3.1 明确归一化和 inactive 预算；A53 |
| R11 | P2 | Header mini 分支提前返回会遗漏入口；Context.pct 负数与近似标记的验证不完整 | §3.4–3.5 明确有效性及所有 header 分支一致；A54 |
| R12 | P2 | 发布失败没有回退边界，可能因工作区并行改动而整文件覆盖；计划的“只创建文档”已过时 | §五、§七、§八修正文档阶段，明确原子发布及按本次差异回退 |

逐节结论：第一、二节的目标与结构性原因成立；第三、四节按 R01–R08/R10–R11 补齐可实施契约；第五节补齐必要的弹层与 UI 投影模块；第六节按 R09 增加可观测验收；第七、八节按 R12 明确发布边界。采用现有 Ink/Yoga 和帧写入器，不引入依赖、持久化配置或新的公共 API，范围限于布局、显示投影及直接受影响的交互适配。

## 一、概述

AragonAgent 的 CLI 使用全屏终端展示 Agent 对话、思考过程、工具调用和可持续编辑的输入框。用户报告输出期间输入框上下跳动，思考流式输出时尤为明显。本次目标是建立可以通过逐帧坐标验证的稳定性契约：在终端尺寸、草稿显示行数和用户选择的状态栏模式不变时，任意 Agent 事件都不能移动输入框边界。正文仍然连续更新、可滚动和选择复制；输入框始终可见，运行期间仍能提交补充消息进入现有队列。

底部信息按使用频率分层。默认仅显示动画图标、执行状态、上下文、思考级别、输出速度和耗时；每个字段都有窄屏格式，不因为费用、服务数量或队列计数而被挤掉。Ctrl+G 将状态区从一行切换成两行，第二行显示操作提示及可容纳的详细信息，再按一次收起。扩展只由用户触发，错误、复制提示、队列变化或更新通知都不能自动增加行数。产品内置文字默认使用英文，用户输入和模型返回内容保持原语言。

本设计以当前工作区源码为依据，而不是把旧设计文档当作当前实现。已阅读 README.md、CLAUDE.md、项目索引和相关代码；工作区已有上下文压缩等未提交变更，其中 App.tsx 也已修改。后续实施必须在这些现状之上增量编辑，保留压缩活动、输入队列回执、模式切换和取消流程。当前文档不声称已运行真实终端复现或修复缺陷；下述结构性原因来自代码检查，实际跳动与擦屏需分别按验收矩阵测量。

## 二、现状证据与方案选择

### 2.1 已确认的代码关系

| 代码路径与符号 | 当前行为 | 设计含义 |
| --- | --- | --- |
| `packages/cli/src/ui/App.tsx::App` | 将 TeamPanel、QueuePanel、Composer 一同传给 ScrollViewport.footer | 输入框属于可移动的消息文档 |
| `ui/layout/ScrollViewport.tsx::ScrollViewport` | 正文、补白和 footer 共同应用负 marginTop；高度经 layout effect 测量、microtask 发布 | 正文高度变化与输入框位置耦合，不能依靠最后一帧稳定证明中间帧稳定 |
| `ui/layout/document-layout.ts::buildDocumentLayout` | 从终端行数扣固定三行，计算正文末尾补白 | 更改底栏高度后不能继续使用隐含常数 |
| `ui/layout/budget.ts::viewportRows` | 返回 frameHeight(rows)-3，草稿参数实际不参与 | 当前预算代表包含输入框的文档，不是纯消息区域 |
| `ui/layout/AppShell.tsx::AppShell` | header 一行、可伸缩 viewport、toast 一行、status 一行 | 输入框下目前始终两行 |
| `ui/layout/status-layout.ts::planStatusFields` | 先放状态、队列、上下文，再依次尝试费用等附加字段 | 思考级别、速度、耗时在窄屏可能被舍弃 |
| `ui/PromptInput.tsx::scrollChip` | 历史提示出现时减少草稿可用列数 | 即使输入框移出滚动容器，提示的出现仍可能让草稿换行 |
| `App.tsx` 的 contentCols | TODO rail 占宽后的列数也用于 Composer | TODO 内容出现可能改变输入宽度及高度 |
| `ui/interaction-copy.ts::interactionCopy` | 交互文案多数为中文 Unicode 转义 | 默认中文来自静态文案，不是已存在的语言配置 |
| `ui/frame-differ.ts::createFrameDiffer` | 以绝对行地址更新变化行，帧行数变化时整帧重绘 | 保持总帧高度恒定才能保留已有抗闪烁保障 |

上表中以 `ui/` 开头的路径均相对于 `packages/cli/src/`。另有 `ui/layout/queue-layout.ts`、`ui/overlays/QueueOverlay.tsx` 和 App 的内置中文反馈，需要一并处理，不能只替换状态栏文本。TodoPanel 中的 Unicode 转义是图标 variation selector，不是中文文案，保持原样。

### 2.2 三种方案及决定

1. **采用：独立固定输入槽位。** 消息区和输入区使用不同的 Yoga 容器；消息偏移只作用于消息文档。优点是通过结构保证输入框位置，缺点是必须调整“消息与输入一起滚动”的旧测试和帮助说明。
2. **不采用：保留统一滚动，仅调整测量和节流。** 可以减少频率，但正文增高、虚拟高度修正、补白回收和 footer 增减仍共享一个偏移，无法保证每一帧坐标不变。
3. **不采用：直接用 ANSI 在终端底部额外绘制输入框。** 将出现 Ink 与额外输出者共同维护屏幕、选择镜像和光标的情况，破坏 frame-differ 的单写入者假设。

不通过隐藏思考、截断真实对话、停止工具日志或降低输出吞吐掩盖问题。不更换 Ink，不新增终端渲染框架，不修改 Core 公共 API、REST、WebSocket、exec NDJSON 或持久化会话结构。

## 三、技术设计

### 3.1 固定布局与高度方程

全屏最小尺寸继续为 40 列、12 行，低于阈值继续显示现有英文小屏提示并保留编辑器实例。设终端行为 R，frameHeight 为 F=R-1，保留最后一行作为终端换行安全区。全屏正常模式下：

- H=1：顶部 header。
- S=1 或 2：紧凑或展开状态区。
- D=clampDraftRows(R, reportedDraftRows)：草稿可见行数，继续使用 draftMaxRows 的现有限制。
- C=2+D：输入框边框加草稿。
- Pmax=max(0, F-H-S-C-1)：补全菜单最多可占的高度，始终给消息区留一行。
- P：现有 buildAutocompleteLayout 在 Pmax 限制下返回的实际 rowCount；小于三行时不显示菜单。
- V=F-H-S-C-P：消息 viewport 高度。

所有结果均为非负整数，正常模式 V>=1。对于 rows/cols 缺失，继续使用现有终端尺寸钩子的 24/80 后备值；非法数值统一在预算函数入口处理，不分散到 JSX 中。参考值：80×24、单行草稿、无菜单，紧凑模式 V=18，展开模式 V=17；40×12、三行草稿、展开模式 V=3。

归一化规则：非有限值、缺失或小于 1 的尺寸使用 24/80；其余向下取整，不能将真实 1–11 行或 1–39 列钳至全屏最小值。预算返回归一化尺寸及 inactive，AppShell、tooSmall、Composer 和状态栏使用同一份值。inactive 时 frameRows=max(0,R-1)，可见内容仅小屏提示，headerRows/composerRows/popupRows/composerSlotRows/viewportRows/statusRows 全为 0；statusExpanded 偏好与编辑器实例仍保留。正常模式下 composerRows=C，popupRows=P，composerSlotRows=C+P，严格满足 H+V+composerSlotRows+S=F。

```text
AppShell，height = F
  Header，height = 1
  消息容器，height = V，overflow hidden
    ScrollViewport（或同槽位 overlay）
      正文 + TeamPanel + QueuePanel
      TODO rail + 最右侧 scrollbar
  输入槽位，height = C + P，flexShrink = 0
    AutocompletePopup（存在时，在输入框上方）
    Composer / PromptInput（稳定实例）
  StatusBar，height = 1
  BottomStatusRow，height = 1，仅展开时占位
```

输入框下边界的零基坐标为 F-S-1，上边界为 F-S-C。因此菜单展开只占用输入框上方空间，不移动输入框；草稿行数增长时只向上增长；用户展开第二行时输入框明确上移一行，这是允许的布局变化。Agent 文本、思考、工具、队列或 TODO 更新均不得进入 C、P、S 的计算。

根节点及每个固定槽位显式指定 height、flexShrink=0、overflow="hidden"；消息容器使用已计算的 V，避免让自然内容高度参与固定槽位分配。禁止新增 marginBottom、paddingBottom 或隐藏空白 toast 行。最外层高度在紧凑/展开之间仍然保持 F，不应因此触发 frame-differ 的行数变更分支。

### 3.2 输入宽度、菜单和稳定实例

Composer 使用独立的 `composerCols=cols-1`，与 TODO rail 可见性无关，右侧留一列安全空位。Transcript 继续使用 `cols-1-railWidth`，scrollbar 仍位于终端最后一列。输入区不进入 ViewportGeometryContext，不随 marginTop 位移。

PromptInput 继续持有 buffer、cursor、paste token、历史和补全选择状态；不要因 runPhase、statusExpanded、overlay 或 tooSmall 改变 key 或卸载它。overlay 打开时输入区保持可见但 inactive，菜单隐藏；过小终端时通过 display 切换保留树，禁止提交和快捷键切换，恢复尺寸后草稿及光标恢复。

App 将预算归一化的 terminalRows 经 Composer 传给 PromptInput，取代其独立 stdout 高度读取；cols 同样使用 composerCols，草稿上限及菜单测量不能跨用 resize 前后的两份尺寸。当前 overlay 也不能因 tooSmall 被替换为 null：保留同一实例并传 isActive=false，嵌套输入组件同步禁用，恢复时不会丢失问题答案或设置草稿。

删除产品渲染路径中的 scrollChip 及其对 baseCols 的扣减；旧纯格式化函数如仍被测试引用，可暂时保留为兼容工具，但不得再影响实际输入布局。历史偏移提示移到 header 的固定宽度右侧栏，显示 `^N`，超过 9999 显示 `^9999+`。正在查看历史时输入字符仍沿用 returnToComposer 的回到底部语义；这只改变消息区，不改变输入框。用户按 Enter 的提交、拒绝保留草稿、队列回执等逻辑保持现状。

补全仍在 PromptInput 内、输入框之前渲染，复用现有 rowCount 与 onPopupRowsChange。菜单上限仅依赖 R、D、S，不依赖 Agent 输出、team/queue 高度、TODO 或菜单当前高度，消除菜单反馈环。maxRows 是候选项上限（沿用默认六项），maxHeight=Pmax 才是含边框和更多提示的总行数，不得混用。Pmax<3 时强制 P=0；旧 popupRows 报告只在当前容量内有效，预算先钳制再使用。

将 PromptInput 的草稿行数报告改为去重的 useLayoutEffect，并去掉 App.onDraftRows 的 setTimeout 收缩延迟；输入槽位使用 height=composerSlotRows、justifyContent="flex-end"、flexShrink=0 与 overflow="hidden"。PromptInput 按当前实际草稿行数和同一份 R/S 计算菜单容量，草稿/菜单变化在 layout effect 同步到父预算后才允许可见帧落地；不得在 render 内更新父 state。子树根及边框不收缩，短暂容量不足仅可从菜单顶部裁剪，禁止裁掉 caret、输入下边框或覆盖状态栏。验收覆盖菜单异步到达、连删草稿、缩放和 Ctrl+G 交错，任何输出帧都必须满足高度守恒；若当前 Ink 调度暴露中间错误帧，必须合并几何报告在同次布局提交内完成，不能靠延迟等待绕过断言。resize 引起的合法重排与纯流式事件验收分开记录。

### 3.3 消息滚动、面板和选择复制

ScrollViewport 的 footer 保留给 TeamPanel 和 QueuePanel，Composer 从该 prop 移除。消息文档仍包含 opener、虚拟化 TranscriptList 和这两个面板；消息不足一屏时允许底部补白，使面板保持在消息区底部，补白不能包含输入框。

将 buildDocumentLayout 输入改为显式 `viewportRows`、`bodyRows`、`footerRows`，返回值继续为 viewportRows、paddingRows、contentRows、trailingContentRows。其计算为 padding=max(0,V-body-footer)，content=body+footer+padding。ScrollViewport 不再用 `rows: viewport+4` 反推出终端高度。继续保留现有高度缓存、microtask 合并、tailDelta 与 layoutTailDelta 区分、reduceFollow、滚动暂停和恢复计时，避免把本次变更扩大为虚拟化重写。

队列和团队预算按顺序分配：queue.availableRows=max(0,V-1)，team.availableRows=max(0,V-queue.rows-1)。仅面板占用受限制，正文继续可滚动。TODO rail 的 viewportBudget=V，composerBaseRows=0、popupRows=0；其 popupMaxHeight 返回值不再用于输入区。TODO 出现只重排消息列宽，不影响输入列宽。

scrollbar.trackTop=2（终端一基坐标），trackRows=实际测得 V，trackCol=终端 cols；拖动轨道不能延伸到输入框或状态栏。所有使用 viewportBudget 的 opener、overlayMaxRows、调试度量、rail 和虚拟窗口统一读取 V。移除 App 对 composerRef/activityRef 可见性的依赖；输入光标可见性只取决于编辑器 active、终端尺寸和现有闪烁配置。兼容 props 可保留在 ScrollViewport，但生产路径不再传入。

保留“正文发生屏幕位移时清除选择”的现有规则；Ctrl+G、草稿显示行数变化、popup 高度变化和 resize 都会改变屏幕坐标，必须在现有选择清理入口清除选择并取消 scrollbar capture。仅 spinner 或数字更新不清除选择。Ctrl+G 本身不发起复制、不清空草稿、不提交消息、不改变 Agent 状态，也不自动把消息滚回底部。

新增几何修订键，由 rows/cols/V/composerSlotRows/S/消息列宽/overlay/inactive 组成；在对应变更生效的 layout effect 中，先 selectionController.clear()，再 scrollbar.controller.cancel() 并 invalidate()，释放 selectionHold 和 dragging，随后发布新 geometry revision，帧就绪前拒绝旧轨道命中。保留原 onViewportShiftChange 对真实正文位移的清理，不能仅靠该回调覆盖 V 改变但 shiftUp 未变的情况。不要 remount ScrollViewport 或重置 offset 来清理捕获；resize 的偏移钳制遵循既有 follow 逻辑。

**短高度弹层：** Composer 保持 C，不因确认请求改变草稿行数；overlay 使 P=0，故正常最小 V 为 3。OverlayFrame 必须按 maxRows 同时决定边框和 margin：不足“边框+留白+标题+至少一行正文+操作行”时去掉边框及留白，仅保留一行标题、V-2 行正文、一行操作提示，每行按显示列截断。受控弹层继续使用 sliceWindow；ConfirmDialog 的多行 summary、QuestionOverlay 的问题/选项、ModelPicker 和 SettingsScreen 的当前条目必须窗口化，焦点移动保持选中项可见，不能让 self-managed children 的自然高度溢出。确认弹层提供正文翻页但保留 y 批准、n/Enter/Esc 拒绝；问题及计划保留现有提交含义。所有正文均可查看，裁剪内容以位置提示说明。tooSmall 隐藏时禁用弹层自身 useInput/isFocused，恢复后保留编辑和选择状态；不得在用户看不到提示时接受批准。

### 3.4 单行状态内容

状态模型仍使用 state.runPhase、state.activeTool、state.runOutcome、state.context、cfg.thinkingLevel，以及 §四定义的 UI elapsedMs/tokPerSec，不另建 Agent 状态机。第一行始终包含六个概念，图标和执行状态作为一个布局字段，因此行计划 fields 包含五个 StatusField：phase（含图标）、context、thinking、speed、elapsed。队列、费用、模型、服务、团队、TODO 等只能进入第二行或 header/现有完整查看入口。

```text
宽屏： * Thinking | Context ~35% | Think high | 12 tok/s | 1m 04s
窄屏： * Think C~35% Th:H 12t/s 1m04s
未知： - Idle C? Th:O --t/s 0s
展开： Enter queue | Esc x2 stop | Q2 | Cost $0.013 | Ctrl+G less
```

示例仅表达排布；实际必须调用 string-width 测宽并按下述规则生成，不以 JS 字符串长度判断终端列数。

1. 用预算 cols-1 保留现有首列 redraw carrier，消毒所有外来工具名和反馈文本，去掉 ANSI、换行和控制字节。
2. 先尝试完整格式及 ` | ` 分隔符；如果超宽，全行切换短格式，以单空格分隔，禁止逐字段贪心删除核心字段。
3. 短状态最长六列：Idle、Start、Wait、Think、Write、Prep、Tool、Ask、Stop、Pack、Retry、Done、Abort、Error。工具全名只在完整格式且容得下时出现，窄屏不打印无限长名称。
4. 上下文仅在 windowKnown 且 occupied/window/pct/deltaTokens 均有限、window>0、其余均非负时显示 C35% 或 C~35%；source=estimate 或 deltaTokens>0 时必须带 `~`。未知窗口及非法读数为 C?；百分比不夹成 100%，大于 999 显示 `C>999%`，近似时 `C~>999%`。完整格式使用 `Context` 标签。真实 occupied/window token 数在第二行优先提供，也可 `/context` 完整查看。绝不以 usageTotal 代替 context。
5. 思考级别完整显示 `Think off|minimal|low|medium|high|xhigh`；短格式映射为 Th:O/N/L/M/H/X，未知配置为 Th:?，不隐藏 off。
6. 速度使用当前主 Agent 运行内已收到的有效 turn_end.usage.outputTokens 累加值除以本轮已过秒数，排除 team/fast/compaction 用量，不再使用 usageTotal 差值。没有可用用量或 elapsedMs<=500 时显示 `-- tok/s`；有效上报为 0 时允许显示 0。短格式为 Nt/s；大于 999 时使用一位小数 k/M 后缀，超过格式上界显示 `>99Mt/s`。不得按字符估算 token，不称其为即时速度；帮助说明为“主 Agent 已报告输出 token / 本轮总耗时（含工具与等待）”。结束后显示 `--`，保留本轮耗时，下一轮重置。会话费用和总 tokens 仍按原 usageTotal 口径。
7. 完整耗时复用 formatDuration；短格式为 Ns、NmSSs、NhMMm、Nd，超过 999 天为 `>999d`，非法或未开始为 0s。速度与耗时没有数据时也必须占有字段。
8. 若短格式极端值仍超过预算，依次将思考标签缩为 H/O 等单字母、速度单位缩为 /s、百分比保留 C 前缀，状态缩为上表的前四个 ASCII 字母，再以 1 列图标无后置空格形式压缩。不得删除字段；在最低 40 列下，测试覆盖所有最大格式组合并证明宽度不超过 39。

每个字段一行、固定本次分配宽度、禁止 wrap；容器 height=1。布局选型只改变横向文字，不改变总行高。色彩复用 theme：普通 muted、状态 primary、错误 noticeError、待确认和停止 noticeWarn；不能仅凭颜色表达状态。

格式器返回 StatusLinePlan：fields、separator、separatorCells、cells。完整格式 separator=` | `、separatorCells=3；短格式为空格、separatorCells=1。cells 为所有字段和分隔符之和，不含首列 carrier，必须 <=columns-1；StatusBar 按计划渲染，删除硬编码 width=3，不能二次拼接或截断整行。phase 的图标前缀独立保留，liveSpinner 只替换该前缀且每帧占相同列数，空闲也显示静态图标。包含反馈的极限短状态最长六列；Copying/Copy sent 等另有明确缩写 Copy/Sent，组合反馈如 Err/EscF 可在最终降级变为 E/F，帮助页解释 E 为复制错误、F 为再次 Esc 强停。禁止因用 phase 前四字符盲截而丢失关键操作区别。

运行状态优先级继续是待用户确认 > stopping > compaction > retry > activeTool > runPhase/outcome。动画使用现有 liveSpinner 与 pickGlyphs，紧凑状态最多一个全局 spinner；空闲显示静态 glyph，reducedMotion 时使用固定图标。保留现有各工具卡的独立进度表现，不额外在第二行或 Composer 增加 spinner。

### 3.5 反馈与第二行

默认状态区确切为一行；展开时确切为两行，第一行维持核心字段，第二行复用 BottomStatusRow 外壳和 action-hint 语义。将详细行格式函数放到独立 status-detail-layout.ts，避免 status-layout 与 interaction-hints 双向导入。

详细行先为真实 Esc 操作及 `^G less` 预留短子句，再按以下顺序收纳：当前反馈；当前确认/补全/选择复制操作；Enter send/queue 与 Ctrl+J newline；队列 Qn、服务 Svcn、当前及待切换模式；上下文 occupied/window tokens；本轮平均速度说明；session input/output 与估算 Cost；team/todo、model/provider、fast/eco、更新入口。反馈可按 grapheme/显示列裁剪以给已预留操作让位，其余取能完整容纳的子句。不轮播、不自动折行；详细数据还可在 /context、/queue、/bg、/todo status、/settings 查看。展开为两行不承诺一屏显示所有已有统计项。hints=false 只隐藏教学提示，不能隐藏反馈、确认/取消行为、Ctrl+G 发现入口。

紧凑时，将短反馈临时并入执行状态字段：Copying、Copied、Copy sent、Copy err、^C exit、Esc stop、Esc force；反馈不会替换上下文等四个字段，也不增加行数。执行状态仍按 §3.4 的优先级投影；反馈优先级为有效退出确认 > 复制失败/清理 > 复制进度/结果 > 普通 toast。实际 armed/stopping 与复制错误并发时使用组合短句（如 Err/EscF），不能直接用停止状态盖住错误；确认 overlay 的具体操作始终可见于其操作行。Esc 操作先判断 overlay，再判断 completion，最后才是中断手势；菜单打开时只显示 Esc menu，不误报 Esc stop/force。运行时保留 spinner；^C exit 仅在下一次 Ctrl+C 确实会退出时显示，复制忙、待复制选择或活跃服务均优先按现有按键梯级处理。

反馈由新的 UI 纯投影模块接收结构化事实，不从翻译后的文本正则推断行为：interruptGesture.phase、completion、overlay、copyState.busy/cleanupPending、复制结果 status、ctrlCArmed、liveServices 和当前 toast。App 在原复制回调中登记 confirmed→Copied、sent→Copy sent（终端已接收但未确认）、失败→Copy err；与对应 toast id 一起存入进程内反馈关联，dismissToast 或被更新结果替换时清理，不修改 Toast/会话序列化。复制清理属于持续状态，在 cleanupPending=false 前仍显示，不受瞬时 toast 到期影响。退出确认继续使用原 1500ms 窗口，但 armed/失效、复制重置、退出重置必须触发 UI 重新投影，不能只更改 ref 留下陈旧提示。普通 toast 保持现有 TTL；长文本紧凑只显示 Notice，原 level 决定颜色。更新通知只进入详情。

全文在对应 toast 存活期间供第二行显示；失败原因沿用 notify('error') 进入 transcript notice。当前 pushToast 并不保存永久历史，故不承诺成功提示过期后仍可回看，也不新增通知中心。结构化反馈在 App 的原回调/计时器内接线，提取格式与优先级至独立模块，避免向已有超长 App 继续堆叠业务分支。

header 右侧增加固定 18 列辅助区，左侧现有品牌、模型和 cwd 在剩余宽度截断。辅助区紧凑显示 `^N  ^G more` 或 `^G more`，展开显示 `^N  ^G less` 或 `^G less`，不足数字上界使用 ^9999+。该区域总宽固定，不受计数增长影响；正常 40 列仍保留 ^G 的发现入口。帮助页明确 Ctrl+G、各短字段含义、本轮平均速度口径，并删除“messages and input together”的旧说明。

Header 的 mini 与 bar 两个分支均共用辅助区，不得在 mini 提前返回时漏掉入口；leftCols=max(0,cols-18)。^N 表示现有 scrolledLines（距底部偏移），不声称为精确的新消息数。overlay 期间 Ctrl+G 被禁用，辅助区显示静态详情模式而非可操作的 more/less 提示，关闭后恢复入口。

### 3.6 英文默认与兼容边界

不新增 locale 配置或自动检测 OS 语言。将 interactionCopy 全部内置字符串切换为英文，包括占位符、状态、复制错误、操作提示和队列动作；保留 key 和元组结构以减少调用方迁移。必须使用 ASCII 文案，glyph 仍通过 pickGlyphs 获得，不在 UI 源码新增非 ASCII 字面量。

确定文案：Idle、Starting、Waiting for model、Thinking、Generating、Preparing tool、Running tool、Awaiting confirmation、Stopping、Compacting context、Retrying、Done、Interrupted、Failed；占位符为 `Ask a question or describe a task...`、`Add a follow-up...`；队列为 `Queue: N pending`、`paused`、`+N more`、`(+N lines)`、`Queue is empty`。App 中转义中文 toast 按相同原则替换；无需翻译用户 TODO 内容、路径、模型输出、历史会话或工具返回。审计中文字面量时应解析转义后匹配汉字范围，不能把所有 Unicode 转义一律判为中文。

配置 schema、会话版本、语言模型 system prompt 保持不变，不能为了英文 UI 强制模型用英文回答。现有中文测试夹具继续用于验证双宽字符输入与复制，只更新断言中的产品文案。

### 3.7 输出写入链路

继续通过 stdout-frame-writer 的 Proxy 与 frame-differ 输出全部 Ink 帧。不得增加 setInterval 定时整屏清除，不直接输出 CSI 2J，不把 spinner 写到独立 stdout。保留帧高小于终端行数、resize invalidation、首次合法帧和光标显隐序列的已有保护。

React 重新渲染不等于终端重绘：验收以最终 ANSI 写入和屏幕位置为依据。纯正文输出时，未变化的输入边框和草稿行应被 frame-differ 跳过；活动颜色从 idle 转 running 的第一次变化可以重写边框，但坐标不得改变。光标闪烁仅允许重写光标所在输入行。全屏恢复、resize、Ctrl+L 和确实的 foreign write 允许受控重绘，不能把这些例外用于解释每个思考 delta 都触发的擦屏。

## 四、接口设计与内存数据模型

下列是下游需要实现的内部契约，不是本节点交付的实现代码。命名的类型均使用 interface；不增加公共网络端点或 CLI 参数。

```ts
interface FrameBudgetInput {
  rows: number;
  cols: number;
  draftRows: number;
  popupRows: number;
  statusExpanded: boolean;
}
interface FrameBudget {
  rows: number;
  cols: number;
  inactive: boolean;
  frameRows: number;
  headerRows: number;
  statusRows: 0 | 1 | 2;
  composerRows: number; // C，仅边框和草稿
  composerSlotRows: number; // C+P，AppShell 的输入槽高度
  popupRows: number;
  popupMaxHeight: number;
  viewportRows: number;
  composerCols: number;
}
// buildFrameBudget(input: FrameBudgetInput): FrameBudget

interface DocumentLayoutInput {
  viewportRows: number;
  bodyRows: number;
  footerRows: number;
}
interface StatusFeedback {
  kind: 'confirm' | 'stopping' | 'force-stop' | 'exit' | 'copying'
    | 'copied' | 'copy-sent' | 'copy-cleanup' | 'copy-error' | 'notice';
  text: string;
  level: 'info' | 'warn' | 'error';
}
interface StatusLinePlan {
  fields: readonly StatusField[];
  separator: string;
  separatorCells: number;
  cells: number;
}
interface StatusPrimaryInput extends StatusLayoutInput {
  feedback?: StatusFeedback;
  escapeAction?: 'menu' | 'cancel-start' | 'confirm-stop' | 'force-stop';
  speedKnown: boolean;
}
interface StatusDetailInput {
  status: StatusPrimaryInput;
  hints: ActionHintInput;
  model: string;
  provider: string;
}
// planPrimaryStatusFields(input: StatusPrimaryInput): StatusLinePlan
// planStatusDetail(input: StatusDetailInput): StatusLinePlan
```

AppShellProps 将 toast/status 两个固定槽改为 composer、composerSlotRows、viewportRows、status、details、statusRows；status 是第一行，details 是第二行内容。header/rows/cols/inactive/placeholder 保留。statusRows=1 时不占用 details 高度，statusRows=2 时 details 高度严格为一行，inactive 时为 0。buildFrameBudget 为唯一公式入口；删除旧 chromeBudget/viewportRows 产品调用并迁移其测试，避免两套公式继续并存。PromptInput 如需计算本地 Pmax，复用 budget.ts 的同一纯容量函数，不能抄写公式。

StatusBarProps 新增 columns 和 feedback、speedKnown，显式使用与 FrameBudget 同一份终端宽度，避免 resize 时独立 stdout 读取造成宽度不一致。旧业务 props 可用于组装 StatusPrimaryInput/StatusDetailInput；planStatusFields 原调用迁移到 planPrimaryStatusFields，不保留两套竞争布局。BottomStatusRow 改为接收已经规划的详细字段，不自己决定行数。

App 内新增 `statusExpanded=false`，仅进程内持有；/clear、/reset、/resume 和运行起止均不改变该偏好，重启恢复紧凑。Ctrl+G 用 Ink `key.ctrl && input.toLowerCase()==='g'` 识别；现有 stdin-filter 传输该控制键，真实输入集成测试使用 0x07 验证。新增分支放在原 Ctrl+C 复制/服务/退出梯级之后，分支内显式判断最新 tooSmall 或 stateRef.current.overlay，任一为真立即返回；不得假设原 App 已存在全局 tooSmall 早退或 overlay 会拦截所有按键。补全打开时允许，PromptInput 已有忽略未知 Ctrl 的路径，不插入字符。tooSmall 禁止草稿输入、提交和新增详情切换，Ctrl+C 退出梯级仍可用；不扩改 Ctrl+O、Ctrl+T、Ctrl+P 和 Esc 的既有职责。弹层自己的输入禁用按 §3.3 接线。

新增 UI 内部 run-metrics.ts，以主 controller.subscribe 已通过 runGeneration 守卫的事件更新局部统计，禁止额外订阅导致双计数。agent_start 重置 runId/startAt/outputTokens/usageKnown，turn_end 仅消费一次其有限非负 outputTokens；usage/message_update 不重复累加。没有有效上报时 usageKnown=false；显式 0 是已知值。speedKnown=running && elapsedMs>500 && usageKnown；team/fast/compaction 的独立订阅不得写该累加器。

elapsedMs 在有效运行开始时归零，以原 200ms tick 刷新；agent_end/错误终止/软停止完成时保存 endAt-startAt，移除旧“idle 自动置 0”。强停在现有 generation 失效点冻结统计，后续旧事件不能改变本轮终态。连续自动续跑在下一个 agent_start 重置，即使 React 没渲染中间 idle 也应工作；同 tick 起止仍保存非负最终耗时。/clear 仅清屏不清运行统计，空闲 /reset 和 /resume 不沿用旧会话统计，statusExpanded 则保持。

空闲手动压缩以当前 live compaction entry.startedAt 为时间源（沿用 compactionClock 更新）；完成时冻结其耗时，速度固定 --，不冒充 Agent 生成。运行内自动压缩继续显示本轮总耗时，速度只统计主 Agent 已上报用量。不得用 compaction enabled/live 配置代替实际在途状态；snapshot.inFlight 与 compactionEntryId 过渡期间按实际 busy/entry 投影。不修改 reducer/Core/持久化，只在 UI 层记录必要的运行指标；新增模块与 fake-clock 测试列入实施计划。

## 五、文件与模块变更计划

本评审节点实际只修改 `docs/plans/tui-stable-composer-status/spec.md`。下面列的是后续实施节点需要修改或新增的完整计划，路径均相对项目根目录；同一行中的文件承担同类明确职责。

| 文件 | 操作 | 目的 |
| --- | --- | --- |
| `packages/cli/src/ui/layout/budget.ts` | 修改 | 统一 buildFrameBudget，替换旧固定三行公式 |
| `packages/cli/src/ui/layout/AppShell.tsx` | 修改 | 独立输入槽位与一/两行状态槽 |
| `packages/cli/src/ui/layout/document-layout.ts` | 修改 | 接受真实 viewportRows，移除反推终端高度 |
| `packages/cli/src/ui/layout/ScrollViewport.tsx` | 修改 | 消息与面板滚动，剥离输入可见性生产依赖 |
| `packages/cli/src/ui/layout/status-layout.ts` | 修改 | 五字段六概念、短格式、统一字段消毒测宽 |
| `packages/cli/src/ui/layout/status-detail-layout.ts` | 新增 | 第二行字段优先级与反馈规划 |
| `packages/cli/src/ui/status-feedback.ts` | 新增 | 结构化复制/退出/中断反馈及真实 Esc 优先级投影 |
| `packages/cli/src/ui/run-metrics.ts` | 新增 | 主 Agent 用量隔离与起止耗时投影，保持 generation 隔离 |
| `packages/cli/src/ui/layout/OverlayFrame.tsx` | 修改 | 短高度去边框/留白，严格分配标题、正文、操作行 |
| `packages/cli/src/ui/overlays/ConfirmDialog.tsx`、`packages/cli/src/ui/overlays/QuestionOverlay.tsx`、`packages/cli/src/ui/overlays/ModelPicker.tsx`、`packages/cli/src/ui/overlays/PlanReviewOverlay.tsx` | 修改 | 短高度正文窗口与活动项可见，小屏按键禁用 |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx`、`packages/cli/src/ui/overlays/ModelProfilePicker.tsx`、`packages/cli/src/ui/overlays/ModelProfileEditor.tsx` | 修改 | 设置及其嵌套编辑页沿用短高度预算、焦点可见与 inactive 输入守卫 |
| `packages/cli/src/ui/StatusBar.tsx` | 修改 | 单行核心状态渲染与唯一活动动画 |
| `packages/cli/src/ui/BottomStatusRow.tsx` | 修改 | 仅渲染规划后的详细行 |
| `packages/cli/src/ui/Header.tsx` | 修改 | 固定宽度滚动提示和 Ctrl+G 入口 |
| `packages/cli/src/ui/App.tsx` | 修改 | 接线预算、Ctrl+G、反馈、稳定 Composer、overlay 与面板尺寸 |
| `packages/cli/src/ui/Composer.tsx` | 修改 | 更新固定输入区接口注释，停止向草稿传历史占宽提示 |
| `packages/cli/src/ui/PromptInput.tsx` | 修改 | 产品路径移除 scrollChip 占宽，保持菜单在输入框上方 |
| `packages/cli/src/ui/interaction-copy.ts` | 修改 | 完整英文默认文案与新状态短文案 |
| `packages/cli/src/ui/interaction-hints.ts` | 修改 | 英文操作提示复用，保持真实按键归属 |
| `packages/cli/src/ui/layout/queue-layout.ts` | 修改 | 队列内置文案英文，预算调用使用 V |
| `packages/cli/src/ui/overlays/QueueOverlay.tsx` | 修改 | 队列标题和空态英文 |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | 修改 | Ctrl+G、滚动新语义、字段口径说明 |
| `packages/cli/README.md` | 修改 | 更新交互文档及手动验收步骤 |
| `packages/cli/src/__tests__/budget.test.ts` | 修改 | 高度守恒与最小屏幕预算 |
| `packages/cli/src/__tests__/document-layout.test.ts` | 修改 | 显式 viewport 公式和 padding 边界 |
| `packages/cli/src/__tests__/status-layout.test.ts` | 修改 | 核心字段、窄屏、异常数值和宽度边界 |
| `packages/cli/src/__tests__/status-detail-layout.test.ts` | 新增 | 第二行优先级及反馈不吞操作提示 |
| `packages/cli/src/__tests__/status-feedback.test.ts`、`packages/cli/src/__tests__/run-metrics.test.ts` | 新增 | 反馈真假与到期、运行时钟及主 Agent 用量隔离 |
| `packages/cli/src/__tests__/overlay-frame.test.tsx`、`packages/cli/src/__tests__/overlay-window.test.ts`、`packages/cli/src/__tests__/question-overlay.test.tsx`、`packages/cli/src/__tests__/model-profile-settings.test.tsx` | 修改 | V=3 的弹层正文、提示和焦点可达性 |
| `packages/cli/src/__tests__/stable-composer-streaming.test.tsx` | 新增 | 真实 Ink 流式事件逐帧固定输入坐标 |
| `packages/cli/src/__tests__/status-toggle.test.tsx` | 新增 | 真实 Ctrl+G 输入与草稿状态保留 |
| `packages/cli/src/__tests__/interaction-copy.test.ts` | 新增 | 导出内置文案为英文，用户内容不被翻译 |
| `packages/cli/src/__tests__/unified-scroll-layout.test.tsx` | 修改 | 将输入一起滚动旧断言替换为固定输入新契约 |
| `packages/cli/src/__tests__/todo-responsive.test.tsx` | 修改 | rail 出现不重排草稿，消息高度使用 V |
| `packages/cli/src/__tests__/todo-app-layout.test.tsx` | 修改 | App 中 TODO、菜单和输入尺寸一致 |
| `packages/cli/src/__tests__/bottom-status-row.test.tsx` | 修改 | 详细行仅按用户展开占位 |
| `packages/cli/src/__tests__/update-bottom-row.test.tsx` | 修改 | 更新通知不新增底部行 |
| `packages/cli/src/__tests__/status-bar-context.test.tsx` | 修改 | 百分比及未知/估算语义 |
| `packages/cli/src/__tests__/status-bar-scroll.test.tsx` | 修改 | 历史提示迁移至 header |
| `packages/cli/src/__tests__/interaction-hints.test.ts` | 修改 | 英文交互反馈及 Esc 保留 |
| `packages/cli/src/__tests__/queue-panel.test.tsx` | 修改 | 队列英文内置文案 |
| `packages/cli/src/__tests__/queue-overlay.test.tsx` | 修改 | 英文队列空态与保留 Unicode 消息 |
| `packages/cli/src/__tests__/frame-writer-ink-integration.test.ts` | 修改 | 固定高度切换与流式帧不擦除输入 |
| `packages/cli/src/__tests__/helpers/terminal-harness.tsx`、`packages/cli/src/__tests__/helpers/vt-screen.ts` | 按需扩展测试接口 | 帧边界记录、ANSI 写入触及行观测；不改变生产写入器 |

不计划修改 frame-differ、stdout-frame-writer、Core、config/schema 或会话存储。全量测试若发现其他直接依赖旧产品文案或旧 AppShell 签名的测试，需要只迁移该断言/夹具，并在实施报告列明实际文件；不得用放宽宽度或删掉选择/输入回归测试来适配新布局。新增复杂格式逻辑放独立模块，App 仅做接线，遵守 CLAUDE.md 的函数尺寸约束。

## 六、测试与验收标准

### 6.1 自动化方式

使用现有 `__tests__/helpers/terminal-harness.tsx` 的真实 Ink/Yoga 测试捕获布局帧；不要仅检查最终 lastFrame。该 helper 的 frames 实际为 stdout data chunks，不能把每个非空 chunk 或 React commit 直接当成完整布局帧：过滤控制序列并按 Ink 完整输出边界记录帧，debug=true 仅用于完整文本坐标检查。新增测试记录所有完整输出帧中输入框首尾行坐标和草稿所在行；固定场景至少生成 300 次 delta，覆盖不换行、逐字符换行、超长思考、Markdown 高度估算修正及 tool progress。另设逐事件驱动用例，每次推进现有刷新窗口并捕获正文确实变化的新帧，共至少 300 个可观测变化帧，避免 300 个同步事件被合并为一次渲染的空洞通过。突发合并用例另保留，并验证最终文本完整。首帧挂载初始化单独断言；其后所有帧都检查，不能跳过“尚未收敛”的输出帧。

ANSI 层复用 frame-writer-ink-integration.test.ts 的生产 stdout 包装与 `helpers/vt-screen.ts`，debug=false，并使用实际 AppShell/Composer；现有测试自造 Frame 只能保留作写入器基线，不能代替产品集成。冻结光标动画、使用 reducedMotion=true、固定状态时间与数字，变更正文；扩展测试侧 VT 观测记录每次字符写入/擦除触及的行，assert 未变化的输入行没有被写入，并验证没有新的整屏清除或 fallbacks。仅比较最终屏幕相等不能证明没有重写；首次合法帧之后建立计数基线，后续不遗漏任何写入。另开动画用例只允许图标状态行与光标所在行更新。不得把 debug=true 的整帧字符串误当成真实终端擦屏证据；两种 pending-wrap 模型均覆盖。

使用表驱动覆盖列宽 40、48、60、80、120、200，行高 12、19、24、50、200。对极端读数、控制符、双宽字符和组合 emoji 断言 `stringWidth(line)<=cols`、根帧行数=R-1、状态区恰好 S 行。没有真实 provider 凭证依赖：使用现有 scripted-provider 夹具生成 thinking_delta、text_delta、工具事件和终态。

### 6.2 验收矩阵

| 编号 | 场景 | 必须满足 |
| --- | --- | --- |
| A01 | 80×24 首次启动 | 输入框下只有一行，英文 Idle，六概念均有显示 |
| A02 | 300 次纯 thinking delta | 每帧输入上下边界和草稿坐标不变 |
| A03 | 300 次 text delta、跨行及代码块 | 每帧输入坐标不变，正文可见且无丢失 |
| A04 | 等待、思考、工具准备、工具执行交替 | 状态更新，输入不位移 |
| A05 | 工具输出换行、长路径、异常 ANSI | 输入不动，状态工具名不注入新行或控制序列 |
| A06 | 短会话变成长会话、补白耗尽 | 输入不出现一帧上移/下移 |
| A07 | 160/400 条 Markdown 高度修正 | 无 Maximum update depth，输入固定，滚动最终收敛 |
| A08 | 在历史中继续接收输出 | 历史保持既有 follow 契约，输入始终可见 |
| A09 | PgUp/PgDn、滚轮和 scrollbar 拖动 | 仅移动消息，轨道不覆盖输入和状态栏 |
| A10 | 在历史位置输入与发送 | 输入时消息可回到底部，草稿与光标位置正确 |
| A11 | TODO 从无到有再清空 | 只改消息列宽，同一草稿不换行、不改变输入高度 |
| A12 | 队列入队、回执、取消及暂停 | 面板更新不移动输入，不丢重复回执保护 |
| A13 | 团队启动/结束、服务活动 | 输入不位移，详情仍可查看 |
| A14 | Ctrl+G 开启/关闭 | 一行与两行互切，输入恰好移动一行，根帧高度不变 |
| A15 | 运行中 Ctrl+G | 不打断运行，不提交草稿，不切换思考可见性 |
| A16 | 真实输入 0x07 | 恰好切换一次，草稿不含控制字符 |
| A17 | Ctrl+O/T/P、Shift+Tab | 各自原有作用保留，与 Ctrl+G 无冲突 |
| A18 | overlay 打开时 Ctrl+G | 忽略切换，关闭 overlay 后草稿和偏好仍在 |
| A19 | slash/@ 补全时 Ctrl+G | 模式切换一次，补全状态保留并按新预算限制高度 |
| A20 | 补全菜单出现/消失 | 输入框上下边界不变，仅消息高度变化 |
| A21 | 中文、emoji、多行及大粘贴草稿 | caret 正确，折叠 token 原文和提交内容完整 |
| A22 | copy 成功、失败、清理中 | 默认仍一行，短反馈可见，Esc 含义真实 |
| A23 | 普通 toast 和更新通知 | 不自动展开，不额外占行，不挤掉核心字段 |
| A24 | Esc 二次停止及强停 | 紧凑状态有提示，原取消时序和队列语义不变 |
| A25 | Ctrl+C 复制/停止服务/退出 | 原有优先级不变，退出确认可见 |
| A26 | thinking off、缺失速度、未开始 | 字段仍显示 off/--/0s，不静默隐藏 |
| A27 | context 已知、估算、未知窗口、NaN | 保留估算标志；未知显示 ?，不使用会话总 tokens 替代 |
| A28 | 40 列极端读数组合 | 六概念均存在，无换行，宽度不超过预算 |
| A29 | 12 行、最多草稿、展开状态 | 至少一行正文，菜单按容量退化，没有负高度 |
| A30 | 缩小至 39×11 再恢复 | 小屏提示，输入不接受操作；恢复后原草稿与状态模式仍在 |
| A31 | 连续 resize 及最后一列字符 | 无终端滚屏漂移，已有 frame writer 测试仍通过 |
| A32 | steady-state 正文变化 | 输入静态行未重写，整屏清除和 fallback 不增长 |
| A33 | spinner、reducedMotion、无 Unicode | 单个全局图标，ASCII 后备等宽，无额外高度 |
| A34 | 选择后 Ctrl+G 或菜单/草稿增高 | 清除过期高亮并取消捕获，无错误复制或永久 hold |
| A35 | /clear、/reset、/resume | 紧凑/展开偏好保持；输入生命周期遵循现有命令语义 |
| A36 | 新进程启动 | 永远默认紧凑英文，不从会话恢复展开状态 |
| A37 | 产品默认文案审计 | 状态、占位、操作、队列和 TODO 内置标签无中文残留 |
| A38 | 用户中文消息及旧会话 | 保留原文，不受英文 UI 影响 |
| A39 | 空闲 /compact 与运行中自动压缩 | Compacting 状态和计时仍可见，输入区不跳动 |
| A40 | 模式为 plan 或 pendingMode | 边框保留现有模式表达，第二行可读当前/待切换模式 |
| A41 | 草稿 1→3→1 行、补全异步到达、Ctrl+G 和 resize 交错 | C/P/输入槽总高区分正确；同步预算无过期收缩覆盖，无输入下边框/caret 被裁 |
| A42 | 40 列短格式的真实 StatusBar 帧 | 分隔符实际占一列，含 carrier 总宽<=40；各字段与 spinner 均可见 |
| A43 | 复制 confirmed/sent/失败/cleanup 四种结果 | 分别显示 Copied/Copy sent/Copy err/清理；未确认发送不显示成功 |
| A44 | 退出 armed 在空闲下自然到期、复制重置和服务出现 | 原 1500ms 到期及时移除退出提示；提示始终匹配下一次 Ctrl+C 行为 |
| A45 | copy error+stopping、复制中开补全、hints=false | 错误与可执行操作可见，Esc menu 不误报停止；关键反馈和 Ctrl+G 入口保留 |
| A46 | 主 Agent 100 output token，同时 team/fast/compaction 各上报用量 | 速度分子仅 100；session totals 按原逻辑累加，不重复计 turn_end 与 usage |
| A47 | 同 tick 起止、自动连续运行、软停/强停及迟到旧事件 | 冻结真实最终耗时；下一次 agent_start 重置，旧 generation 不污染新统计 |
| A48 | 主运行有效零用量、非法用量，空闲手动压缩起止 | 零与未知区分；压缩用自己的起止时钟且速度 --，无残留 tick |
| A49 | 40×12/80×12，三行草稿、展开模式下所有弹层 | V=3 时标题/正文/操作各一行，正文可遍历、焦点可见，确认内容及结果正确 |
| A50 | 弹层打开后缩至 39×11，输入 y/Enter/0x07，再恢复 | 不批准、不提交、不切换详情，恢复原弹层状态；Ctrl+C 梯级仍可退出 |
| A51 | 拖动 scrollbar 或保留选区时菜单、状态、rail 改变几何 | 先清理选择和 capture 再接受新几何；无旧坐标命中或永久 hold |
| A52 | 流式测量证据自检 | 逐事件用例至少 300 个正文变化帧且坐标全部检查；突发事件另验内容；ANSI 观测能检出输入行重写 |
| A53 | rows/cols 缺失、NaN、Infinity、0、分数与真实 1 行 | 归一化一致，真实小屏不放大，inactive 所有槽为 0，frameRows<R |
| A54 | mini/bar header、负 pct/deltaTokens、估算超 999% | 两种 header 都有入口，非法 context 为 ?，估算上界保留 ~ |

### 6.3 执行命令与人工门槛

实施节点先新增 A02/A06/A11 的回归，确认旧结构会失败，再改布局。命令在项目根目录逐条执行，检查每条退出码；以下仅是下游计划，本设计节点不运行构建或产品测试。

```powershell
npm run test -w packages/cli -- src/__tests__/budget.test.ts src/__tests__/document-layout.test.ts src/__tests__/status-layout.test.ts src/__tests__/status-detail-layout.test.ts
npm run test -w packages/cli -- src/__tests__/stable-composer-streaming.test.tsx src/__tests__/status-toggle.test.tsx src/__tests__/unified-scroll-layout.test.tsx src/__tests__/frame-writer-ink-integration.test.ts
npm run typecheck
npm run build
npm test
```

最后在 Windows Terminal/PowerShell、Windows VS Code 集成终端及至少一个 macOS/Linux 终端进行实际观看：保持草稿不变，开启思考输出，持续运行文本/工具交替 fixture，录制 30 秒并查看输入边界；分别检查 40×12、80×24、120×40、缩放、鼠标和 Ctrl+G。产物记录尺寸、终端版本、用例、逐帧坐标结果及 frame writer 计数。自动测量通过才能称“布局稳定”；未做人工终端检查不得宣称已完成跨终端视觉验收，必须作为明确未通过项报告。

## 七、风险与缓解

| 风险 | 缓解与发布门槛 |
| --- | --- |
| 旧测试明确要求输入一起滚动 | 仅更换已被本需求取代的断言，保留正文跟随、选择和草稿状态回归 |
| 仅把 Composer 移出仍受宽度影响 | Composer 固定 cols-1，scrollChip 移至 header，A11 必须通过 |
| 双份预算导致 popup、overlay、rail 不一致 | 单一 buildFrameBudget，各消费者使用同一 V；去掉 viewport+4 隐含常数 |
| React 中间帧仍受测量影响 | 固定输入槽位与底部对齐，逐帧断言而非只看稳定帧 |
| 详情隐藏导致用户看不到复制失败或退出确认 | 紧凑 phase 承载短反馈，第二行和现有通知保留全文 |
| 极窄状态栏无法显示完整工具名 | 使用短状态标签与单字符思考等级；详名放详情/工具卡 |
| 上下文与速度看似精确但数据缺失 | 沿用 ContextUsageSnapshot 真值；~/?/-- 显式表示不确定性 |
| 默认英文误伤用户中文 | 只改内置字符串，不增加用户内容翻译及系统提示限制 |
| frame-differ 被“优化”破坏 | 本方案不修改写入器生产代码；首帧、resize、最后一列回归为门槛 |
| 工作区存在并行改动 | 实施前重新读 App、压缩相关逻辑和 git diff，禁止恢复或覆盖已有文件 |
| 小消息区裁掉弹层确认内容 | A49–A50 为发布门槛，所有 self-managed 弹层必须适配预算和输入启用状态 |
| 运行计量跨来源污染或终态计时归零 | 独立 UI 投影消费主事件，A46–A48 覆盖用量、零值、强停和压缩 |

发布采用 CLI 内部一次性原子变更，固定输入槽、高度消费者、状态行计划和短高度弹层必须一起交付，不分批启用，也不新增实验配置。任一布局/输入/确认回归失败即阻止发布；回退只撤销本功能的提交或可识别差异，保留当前工作区的压缩及其他并行改动，禁止整文件覆盖或 reset 工作区。无需数据迁移，旧会话保持可读；跨终端人工验收未完成时仅能报告已验证平台，不得宣称完整发布门槛通过。

已知限制：40 列使用英文缩写；两行不足以同时显示所有统计字段；上游 provider 不连续报告 outputTokens 时平均速度可能长期为 --。这些是明确的信息密度和数据来源限制，不允许以伪造数字或自动增加状态行解决。

## 八、实施顺序与交付检查

1. 记录实施前 git status 与相关文件差异，读取本设计及当前输入/压缩测试。添加真实 Ink 的固定草稿流式回归，取得旧结构失败证据。
2. 实现 buildFrameBudget 与显式 document-layout 输入，完成预算矩阵测试。迁移 AppShell 固定槽位，在最小界面夹具验证高度守恒。
3. 移出 Composer，设置独立宽度，移除输入 scrollChip，迁移 viewportBudget 消费者、面板和选择失效处理，同步完成短高度弹层和输入禁用适配。跑 A02–A13、A20–A21、A41、A49–A51。
4. 实现 primary/detail 格式规划器，测试所有核心字段、极端数值与窄屏；接入 StatusBar、BottomStatusRow 和 header 辅助栏。
5. 接入 Ctrl+G、结构化反馈与 UI 运行指标投影，保持 overlay 和 tooSmall 的按键所有权。用真实 stdin 验证草稿与补全不会收到 0x07，执行 A42–A48。
6. 替换内置英文文案，更新 HelpOverlay 和 CLI README，保留 Unicode 用户内容夹具。逐项检查 A22–A40、A52–A54。
7. 跑针对性测试、typecheck、build 和完整测试，执行真实终端验收。任何已有失败均需列出命令、错误和基线证据，不以历史黑板的测试数代替本次结果。
8. 实施报告附实际改动文件、测试结果、未验证平台及残余问题，并按节点要求登记机制记录；本设计节点只登记“未改代码”的逻辑说明。

设计评审交付检查：本文已明确概述、技术设计、文件计划、内部接口、内存模型、54 项测试验收及风险；运行时实现与测试尚待后续节点执行。文档必须在 git status 中可见，不提交 git commit。

## 评审结论

**通过。** 文档已升级为 v2。未发现 P0，9 项 P1 与 3 项 P2 已在设计正文修正，未解决 P0/P1 为 0。固定输入槽方案符合现有 React/Ink/Yoga 和帧差分架构；高度、状态渲染、反馈语义、主 Agent 计量、短高度弹层与验证方式已有明确实施契约。

此为设计评审结论；54 项验收、构建、类型检查、完整测试和真实终端检查属于后续实施发布门槛，本节点没有执行或声称通过这些产品验证。本节点仅修改本 spec.md，无源代码改动，无 git commit。

## 实施过程发现的方案缺陷

1. **帧观察器仍假设旧轨道高度。** `ui/frame-observer.ts::summarizeFrame` 将轨道写死为 `rows-4`，并要求输入区也具有末列轨道字符。固定输入槽落地后，真实非 debug Ink 拖动回归失败，`frameReady` 永远为 false。补充修改该模块：从完整帧顶部之后连续的最右列轨道行推导实际 V，再与 ScrollViewport 发布的几何逐项匹配；保留 resize 时失效及就绪确认，不修改 frame-differ 或 stdout-frame-writer。直接关联的 frame-observer 测试允许同步更新。
2. **输入列数必须约束 Yoga 容器。** 只传 `Composer.cols=cols-1` 不能限制父容器默认 stretch；同时将 Composer 根 Box 的 width 设置为同一 cols，确保真实边框不占安全列，草稿测量和实际绘制一致。
3. **本地主机异步等待探针不可用。** `wait_async --probe-kind file_exists` 返回 `probe_template_not_supported_on_host`。长测试写入 `.agentmesh/` 日志，以短轮询和 progress 报告观察。不声称完成不可用的跨终端人工视觉验收。
4. **浮层正文不能依赖横向裁剪保持字素完整。** 实施后最小复现发现，新增正文/compact 根 Box 的 `overflow="hidden"` 触发 Ink 内部显示宽度与 ANSI 切片的不一致，可能裁掉组合重音或 ZWJ emoji 后面的正文。纯字符串规划测试无法检出，必须用真实 Ink 检查原始完整输出。改为仅纵向裁剪 `overflowY="hidden"`，保留已有逐行包装和 Text 横向截断；补充三行及六行浮层复杂字素回归。
5. **窄屏 rail 的自定义 borderStyle 需要稳定引用。** 连续更新浮层时，新建 borderStyle 对象会进入 Ink 增量样式更新，未在该次差异中重复传入的 borderTop/borderBottom=false 被忽略，隐式新增上下边框行。HEAD 基线也能复现，但固定 V 后会裁掉动作提示，必须在本功能中修正。按 rail 字符 memoize 样式对象，保留既有边框开关；真实连续更新回归同时检查浮层总高、动作提示与输入位置。

## 实施交付记录

代码与自动化实施完成，未执行 git commit。固定 Composer、统一帧预算、英文单行主状态、Ctrl+G 详情、主运行指标、结构化反馈、短屏浮层及选择几何失效处理已落地；文件计划逐项核对均已更新或新增。保留工作区原有及并行压缩改动，不将其归为本功能。

最终冻结版本验证：`npm run typecheck`、`npm run build`、CLI `--version`（0.6.14）和差异格式检查均通过。`npm test` 退出 0：CLI 251 文件、3675 项通过、6 项跳过；Core 32 文件、549 项通过。真实流式文本和思考各至少 300 个正文变化帧，输入边界固定；两种 pending-wrap ANSI 模型均确认未变化的输入行没有被写入。复杂字素及窄屏连续更新动作行的新增回归已通过。

完整实施报告、实际 74 个文件清单和日志索引位于 `.agentmesh/implementation-report.md`，五份机制说明位于 `.agentmesh/logic-notes/` 并已通过节点工具登记。

**尚未通过的发布门槛：** Windows Terminal、Windows VS Code 集成终端与 macOS/Linux 的人工视觉观看和录制未执行。当前仅完成 Windows 主机上真实 Ink/Yoga 与 ANSI 模型的自动化验证，不宣称 54 项中所有人工组合场景或跨终端发布验收已通过。

## 最终代码审查记录

本轮修复短屏确认正文的 Unicode 显示列换行缺陷，以及退出／中断确认过期后详情残留旧提示的问题，均先取得失败回归再验证修复。最新完整测试为 CLI 3681 项通过、6 跳过，Core 549 项通过；类型检查、构建、CLI 启动和差异检查通过。覆盖核对、失败证据与验收限制见同目录 `code-review.md`。提交范围为本功能 78 个文件，版本文件、锁文件及无关工作区改动保留。
