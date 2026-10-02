# TODO 右侧面板响应式可见性设计与实施计划

> 版本：v2；日期：2026-10-02；节点：方案评审与修复。
> 后续实施按 superpowers:executing-plans 的逐项验证方式执行，以本文件路径、范围与任务节点权限为准。

**目标：** 在全屏 TUI 中可靠显示已有 TODO，右栏目标宽度为终端的 15%，尤其修复 100×20 终端进入多 Agent 执行后面板消失的问题。

**架构：** 保留现有 TodoStore、事件、视图状态以及 AppShell 中间区域的左右结构。通过纯函数统一分配团队面板、补全菜单和 TODO 的行预算，以紧凑显示替代过早隐藏，不增加第二个滚动区域。

**技术栈：** npm workspaces、TypeScript strict / NodeNext、React 18、Ink 5、Vitest、ink-testing-library；复用已有 string-width、主题和 glyph 能力层，不新增依赖。

## 评审记录

本轮按可行性、完整性、一致性、范围适配逐节检查，并对照当前源码及本地已安装的 Ink 实现。下表的“已修复”指设计正文已修复，不表示生产代码已实现。共发现 **0 项 P0、6 项 P1、3 项 P2**，均已在本文处理，无遗留 P0/P1。

| 编号 | 级别 | 问题与核验依据 | 正文修正 / 状态 |
| --- | --- | --- | --- |
| RV-01 | P1 | §3.4 隐藏菜单却保持候选键盘规则；PromptInput 的 popupItems.length 分支会在 Enter 时提交不可见的 slash 候选，而非用户输入 | §3.4 用可见投影统一键盘与渲染门控；A17。已修复 |
| RV-02 | P1 | §7.1 声称 inactive 已关闭菜单，但现有 isActive 只停用输入，候选渲染不读取它；overlay 可继续占菜单高度 | §3.4 明确新增 inactive 隐藏与零行报告，保留草稿；A18。已修复 |
| RV-03 | P1 | wrap="truncate" 不删除显式换行；本地 Ink wrap-text 对短字符串 a\\nb 原样返回两行，菜单行投影可失真 | §3.4 仅对显示文本折叠空白，并保留原始补全值；A19。已修复 |
| RV-04 | P1 | §3.3 先拒绝无效 availableRows，却给旧调用传 Infinity；§3.5 对 NaN 直接 floor/min 会传播 NaN，且 teamRows 超预算时不变量无定义 | §3.3、§3.5、§五给出唯一规整规则与 Infinity 特例；A20。已修复 |
| RV-05 | P1 | popupRows 保存在 App，PromptInput 却会随小于 12 行的占位分支卸载；只写“变化时报告”未定义重挂、inactive、关闭的零行同步 | §3.4、§3.7 明确每次挂载报告与卸载清零、Hook 顺序；A21。已修复 |
| RV-06 | P1 | §7.2 的生产 helper harness 无法证明 App 真正传递投影和回调；最关键接线只有人工验证 | §四、§7.1–7.3 增加真实 App 自动集成覆盖，包含恢复、菜单、团队和滚动；A22。已修复 |
| RV-07 | P2 | §3.3 使用裸 20/3，§3.6 未明确保留进度条原有 8 行门槛，容易复制结构常量或改变装饰行占用 | 统一引用 TEAM_LIMITS.panelCollapseRows、TODO_LIMITS.panelMinRows，保留 gauge 的 8 行门槛。已修复 |
| RV-08 | P2 | 文档仍称“本节点仅创建”，完成核验指向节点 0；易使评审节点上报错误 | §一、§四、§九区分历史设计与本次评审职责；只上报节点 1。已修复 |
| RV-09 | P2 | §3.7、风险表把 overflow 裁剪当成首帧内容正确性保证；裁剪只能限制输出，不能证明锚点和状态栏保留 | §3.7、§7.2明确过渡帧验证及保守预算局限，禁止用最后帧或外层裁剪掩盖溢出。已修复 |

逐节结论：§一目标与非目标适当；§二根因算术与当前代码一致，旧测试仅为历史基线；§三修复上述交互和预算漏洞后可由现有栈实现；§四补齐测试文件且不扩展 Core；§五、§六消除边界歧义并限定不变量适用域；§七补齐真实接线与动态验收；§八明确过渡帧及回退风险；§九修正节点交付责任。补全总高度属于同一屏幕预算的必要修复，保留三个小型纯函数模块，不引入新的布局框架或滚动系统。

## 一、概述

TODO 是执行过程中的持续反馈：用户需要同时看见当前步骤、完成数量和尚未展示的任务。当前列表数据仍可能正常更新，但视图把“团队正在运行”直接转换成固定扣除 8 行，再要求右栏至少剩余 6 行。这种最坏情况预算会隐藏本可容纳紧凑列表的区域。用户看到的是整个列表消失，无法从界面判断任务是否仍在推进。本设计把“是否有计划”和“空间允许展示多少计划”分开处理，使常用终端尺寸下的任务进度持续可见。

右栏采用约 15% 的宽度，保留窄屏可读下限和正文最小宽度；高度充分时显示常规列表，高度不足时保留标题、计数、当前步骤和合并的隐藏项提示。团队名单、长输入和命令补全都是同一个屏幕中的真实占用，必须在同一套预算中计算，不能只降低隐藏阈值后任由 Ink 从底部裁掉关键内容。补全菜单的边框、更多提示和长文本也纳入行预算。

本评审节点只修订本方案，源代码修改、构建、交互验收由后续开发节点执行。本方案不改变模型是否生成计划、计划持久化、自动继续、Core API 或工具协议，不添加空列表占位，不引入可拖动分栏或新的设置项。未生成 TODO 时保持原有无右栏行为；用户显式关闭、模态界面接管、inline 模式和确实无法容纳的尺寸继续遵循清晰的降级规则。

## 二、现状核验与问题边界

已阅读根目录 README.md、CLAUDE.md、项目索引、CLI package.json 和 CLI README 的 TODO 章节。项目由独立 Core 引擎和 CLI 宿主组成，TODO 是 CLI 内部子系统。源代码 UI 字面量采用 ASCII；Unicode 图形由 pickGlyphs 提供。中文仅用于本设计说明，实施时界面文案延续现有英文习惯。当前工作区已有 capabilities.ts、theme.test.ts 等无关修改，后续节点必须保留，不可将其纳入本需求。

| 已核验代码路径 | 现有行为及影响 |
| --- | --- |
| packages/cli/src/ui/App.tsx::showRail，约 2163 行 | fullscreen、panel 开关、无 overlay、有 todos、宽度有效、剩余行数至少 6 才挂载 |
| packages/cli/src/ui/layout/rail.ts::todoRailWidth | 20% 比例，18–36 列，终端少于 80 列直接返回 0 |
| packages/cli/src/ui/layout/rail.ts::todoRailRows | teamActive 为真时固定扣 8 行，不读取实际团队列表 |
| packages/cli/src/ui/layout/budget.ts::viewportRows | 只扣静态 chrome 和输入行；20 行终端、单行输入时返回 12 |
| packages/cli/src/ui/TeamPanel.tsx::TeamPanel | 小于 20 行折叠为 1 行；否则实际为标题 + 最多 5 个任务 + 可选溢出行 + 可选邮件行 |
| packages/cli/src/ui/layout/AppShell.tsx::AppShell | TODO 在中间区域右侧；团队面板在底部 chrome；中间横向容器始终存在，避免重新挂载正文 |
| packages/cli/src/ui/TodoPanel.tsx::TodoPanel | 固定标题和空行，可能额外显示进度条；当前项可换行，但选行算法按每项一行计算 |
| packages/cli/src/ui/AutocompletePopup.tsx::AutocompletePopup | maxRows 限制建议条数，不包括上下边框及更多提示；建议文本目前可换行 |
| packages/cli/src/commands/builtins.ts::todo | /todo status 区分有无列表，但 Panel: on 仅指配置开启，不证明当前帧显示 |

确定可复现的算术路径为：20 行 → frameHeight=19 → 静态 chrome=7 → viewportBudget=12 → team 固定预留 8 → railRows=4 → 4<6 → 右栏消失。19 行时团队组件实际仅画一行，旧预算仍扣 8 行，说明预算与渲染已经分离。用户具体故障会话的实际尺寸未提供，本文不声称已经重放该会话；100×20 是必须覆盖的确定性回归场景。

设计阶段已执行以下现有基线测试，结果为 **4 个文件、53 项通过、0 失败**：

```powershell
npm run test -w packages/cli -- src/__tests__/todo-rail.test.ts src/__tests__/todo-panel-rows.test.ts src/__tests__/todo-panel.test.tsx src/__tests__/team-panel.test.tsx
```

其中旧测试显式要求扣除完整 8 行，并未证明新需求成立。开发时必须替换对应旧策略断言，保留锚点可见、显示宽度和结构稳定性等有效约束。

## 三、技术设计

### 3.1 方案选择

考虑三个方案。第一，仅降低 panelMinRows 并改 15%：改动小，但继续错误扣行，且长输入、补全和活动项换行仍可造成截断。第二，在右栏或 AppShell 再测量高度并回传父组件：接近实际布局，但需要覆盖子组件自行更新和首帧测量，容易增加渲染反馈环。第三，复用现有静态预算，准确描述动态组件实际占用，使用纯函数生成布局投影：各组件直接消费同一结果，方便穷举验证。本设计选择第三种。

ScrollViewport 继续拥有自己的测量和滚动状态；新的预算不接管 scroll offset、selection 或 wheel intent。AppShell 的 DOM 层级不变。新逻辑放在小模块中，App.tsx 只接线，避免在已有超大文件中堆叠算法。

### 3.2 宽度规则

在 ui/layout/rail.ts 中固定以下规则，不增加配置开关：

- RAIL_FRACTION 改为 0.15；TODO_RAIL_MIN_COLS=14；TODO_RAIL_MAX_COLS=36。
- 新增 TODO_TRANSCRIPT_MIN_COLS=62；TODO_RAIL_MIN_TOTAL_COLS=76，即 62+14。
- 输入不是有限数时返回 0；先向下取整终端列数，少于 76 列返回 0。
- 其余返回 min(36, max(14, round(cols×0.15)))，宽度包括左分隔线和一格内边距。
- TODO_RAIL_INDEX_MIN_COLS 保持 22；进度条仍要求宽度至少 20。

| 终端列数 | 75 | 76 | 80 | 100 | 120 | 160 | 200 | 240 | 300 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TODO 列数 | 0 | 14 | 14 | 15 | 18 | 24 | 30 | 36 | 36 |
| 正文列数 | 75 | 62 | 66 | 85 | 102 | 136 | 170 | 204 | 264 |

14 列下，减去分隔线、内边距和 3 列状态标记，正文尚有 9 列；足以展示当前步骤的片段。极窄与极宽终端偏离 15% 是有意的可读性约束。保持随终端增宽右栏不变窄、正文至少 62 列两个性质。

### 3.3 团队面板的实际行投影

新增 ui/layout/team-panel.ts，导出 buildTeamPanelLayout({ snapshot, terminalRows, availableRows })。snapshot 为 null 时返回 0 行。否则先用现有 selectPanelRows(snapshot.runs, TEAM_LIMITS.panelMaxRows) 获取按运行状态排序的列表，不复制排序逻辑。

自然展开高度为 1 + visible.length + (hiddenTotal>0 ? 1 : 0) + (snapshot.lastMessage ? 1 : 0)。messageCount 属于标题同一行，不另计高度。availableRows 先按 §五规整，唯独旧调用的正 Infinity 保留为无上限；其余无效或小于 1 时返回空投影，TeamPanel 在 rowCount=0 时返回 null。其余情况下，terminalRows<TEAM_LIMITS.panelCollapseRows（20），或者 availableRows−自然高度<TODO_LIMITS.panelMinRows（3）时，返回仅标题的折叠投影，rowCount=1；否则返回展开投影及自然高度。availableRows 是 viewportRows(rows,draftRows)，不包含补全菜单，防止打开菜单后团队反复展开折叠。

TeamPanel 增加可选 layout 属性。App 的全屏分支必须传入同一次计算的投影，TeamPanel 直接用其 visible、hiddenTotal、hiddenRunning、collapsed 渲染。inline 和独立旧调用未传 layout 时，调用同一 helper，以无限 availableRows 保留原有按 terminalRows 折叠的语义。可选 lastMessage 仅在展开投影里渲染。每条团队文本仍保持单行。

三行是共享中间区域的最低保留目标，既供正文也供紧凑 TODO，并不是分别为左右两边扣除三行。团队折叠时仍展示运行数量、完成数量和耗时，完整子 Agent 信息仍在原有团队记录中。极端情况下即使只剩团队标题也不能创造额外空间，后续可见性判定必须允许 TODO 隐藏。

### 3.4 补全菜单必须按总高度封顶

仅让 TODO 使用实际团队高度还不足以应对输入框下方的 / 和 @ 菜单。新增 ui/layout/autocomplete.ts::buildAutocompleteLayout，供 PromptInput 和 AutocompletePopup 共用。保留 maxRows 的“最多建议数”含义，新增 maxHeight 表示包括边框及溢出行在内的总高度；未传 maxHeight 的旧调用不增加新的高度限制。

算法如下，所有数量先规整为非负整数：

1. 无建议、显式 maxRows<=0，或有限 maxHeight<3，返回不显示、rowCount=0。显式传入 NaN 或非法负数同样降级为 0；仅未传 maxHeight 表示无上限。
2. 可容纳的建议数 k 为 min(items.length, maxRows，maxHeight−2)；无高度上限时只取前两项约束。maxRows 未传仍默认 6。
3. 用现有选中项窗口规则计算 start=max(0,min(selected−k+1,count−k))，选中位置先夹紧到合法索引。
4. k>=2、窗口后还有项且增加提示会超出 maxHeight 时，减少 k 一次并重新计算 start；k 不得降至 0。
5. 若存在后续项且 2+k+1<=maxHeight，显示原有 +N more；无高度上限也显示。否则保留建议项，省略该提示。3 行高度时恰好是上下边框和一个选中项。
6. rowCount=2+k+(showMore ? 1 : 0)。每个建议 Text 及更多提示均使用 wrap="truncate"；label 与 hint 的显示副本先用 /\s+/g 将换行、制表符等连续空白替换为一个空格。原始 items、label 和文件路径不改写，选择、补全及提交继续使用原始值；索引与 key 不以清洗后的显示文本重新匹配。菜单容器使用 flexShrink={0}，不得压缩已预算的边框或建议行。TODO 的生产数据已由 normalizeTodos 折叠空白，无需修改存储层。

PromptInput 根据 popupItems、clampedSel、popupMaxRows 和新增 popupMaxHeight 计算投影，传给 AutocompletePopup，避免渲染和报告各算一次。isActive=false 时使用零行空投影，隐藏菜单但保留草稿和选中状态；重新激活时按最新候选夹紧索引。这是本次新增规则，不能声称现有代码已关闭 inactive 菜单。

新增 onPopupRowsChange 可选回调，以 useLayoutEffect 在每次挂载以及 rowCount 或回调引用变化时报告；关闭、无候选、inactive、无可用高度均报告 0。另用只依赖回调的 layout effect 在卸载时清零，不在每次行数变化时执行清零 cleanup。禁止在 render 中 setState；StrictMode 重放必须幂等，不累加行数。Composer 原样透传这两个属性。App 用稳定回调接收，仅在数值变化时更新 popupRows；这和已有 onDraftRows 属于相同的布局报告模式。

全屏传入的 popupMaxHeight=max(0,viewportBudget−teamRows−TODO_LIMITS.panelMinRows)。保留 popupMaxRows 对建议数量的原有上限；maxHeight 才是最终的整体约束。inline 不传 maxHeight，不增加新的布局限制。未显示菜单不占行；高度不足 3 时菜单完全不挂载，不把 maxHeight=0 当作无限。菜单关闭后恢复列表高度。

候选数据可保留，但键盘候选分支与 JSX 必须共用 popupVisible=isActive && popupLayout.rowCount>0。隐藏时 Up/Down、Tab、Right、Enter、Esc 不得进入候选选择或提交分支，按现有无菜单编辑规则处理；Enter 只提交实际输入的 buffer，不把 `/c` 替换为不可见的第一个命令。可见时保留既有候选键位；Shift+Tab 的提前返回仍置于候选分支之前。isActive=false 时 useInput 仍完全停用。扩大窗口重新显示后，选中项必须在可见窗口中。

### 3.5 统一行预算和显示判断

新增 ui/layout/todo-layout.ts::buildTodoRailLayout，输入见接口章节。先按 §五规整输入：V=nonNegativeInt(viewportBudget)、T=min(V,nonNegativeInt(teamRows))，popupMaxHeight=max(0,V−T−TODO_LIMITS.panelMinRows)。当 popupMaxHeight<3 时 actualPopupRows=0，否则为 min(nonNegativeInt(popupRows),popupMaxHeight)。调用宽度函数，再计算 railRows=max(0,V−T−actualPopupRows)。T 的夹紧只是纯函数非法输入的降级；App 必须传入同一 V 生成的 teamLayout.rowCount，不能用夹紧掩盖真实组件超预算。这替代 todoRailRows(viewportBudget,teamActive) 的布尔扣除；旧函数及 TODO_LIMITS.railReservedRows 删除，所有引用和说明一并更新。

显示条件按顺序判断：非 fullscreen → inline；panel 配置关闭 → disabled；有 overlay → overlay；todos 为 null 或 items 为空 → empty；width=0 → narrow；railRows<3 → short；否则显示。cfg.todo.enabled 不作为额外条件，因为用户关闭后仍可查看现有计划，这与现有 panel 独立语义一致。

显示时 contentCols=cols−width；隐藏时 contentCols=cols。App 的正文、ScrollViewport、opener 和 transcript 继续使用同一个 contentCols；header、composer、status 和 overlay 仍是全宽。showStrip 保持原规则，不把它改成 !showRail，以免用户明确关闭后又出现替代显示。

popupMaxHeight 只由静态预算和团队投影决定，不读 popupRows 或 showRail。团队投影不读 popupRows。这个单向依赖消除“菜单增高→TODO 消失→菜单增高”的反馈环。菜单局部变化通过布局回调到达 App，不能依赖运行 ticker，因为 idle 输入和恢复会话也必须更新。一次回调允许产生一次父渲染，数值相同必须复用旧状态；无轮询、延迟定时器或新的测量循环。

### 3.6 TODO 的两级高度降级

把 TODO_LIMITS.panelMinRows 改为 3，新增 panelFullRows=6。右栏根 Box 明确 height={rows}、width={width}、flexShrink={0} 和 overflow="hidden"；隐藏由 App 决定，组件对空 items 或 rows<3 也返回 null。根高度从预算而来，不由内容撑开。

**常规形态（rows>=6）：** 标题一行、可选进度条一行（保持 width>=20 且 rows>=8 的现有门槛）、空白一行，然后调用现有 selectTodoRows(items, rows−2−gaugeRows)。每个任务都占一行，包括 in_progress；活动项仍显示 activeForm、强调颜色和受现有开关控制的 spinner。删除 clampWrapped、activeWrapRows 常量及相关过时注释；不允许使用字符串 .length 预算终端显示宽度。完整文本可在正文 TodoCard 查看，TodoCard 的呈现行为不变。每项一行使选行预算与真实布局一致，两个溢出提示均不会被活动项挤掉。

**紧凑形态（3<=rows<6）：** 标题一行，不显示进度条、空白或编号。新增 selectCompactTodoRows(items,maxItemRows)，复用 todoAnchorIndex 和 windowFor；不为两个独立溢出标记扣槽，直接选取连续锚点窗口。若 count<=rows−1，则显示全部项目、不画 footer；否则用 rows−2 个项目槽，最后一行合并显示 `-A +B`：负号侧表示上方隐藏 A 项，正号侧表示下方隐藏 B 项，零值也显示。例如 3 行可展示标题、当前项、`-9 +10`，表示前面 9 项、后面 10 项未展开。该 ASCII 格式最多 7 列，能放入 14 列右栏的 12 列内容区；README 必须解释其含义。选择器遇到空列表返回空窗口，maxItemRows<=0 时返回 visible=[]、hiddenAbove=0、hiddenBelow=count；其余夹紧槽数后调用 windowFor，保持数量守恒。

标题使用固定宽度计数单元和可截断 TODO 标签，计数永远优先保留。完成状态仍可在宽度足够时添加 done：只有内宽>=4+1+计数字符数+5 时追加，否则只显示 doneCount/total。14 列右栏可完整显示 TODO 20/20。完成态停止 spinner，活动态仅在 running && !reducedMotion && caps.unicode 时动画。

列表选择的守恒条件是 hiddenAbove+visible.length+hiddenBelow=items.length；非空列表且槽数至少为 1 时锚点在 visible 中。紧凑态不能调用旧 selectTodoRows 的低于 3 行路径后指望 overflow 隐藏标记，该路径明确允许超预算，正是此处要避免的行为。

### 3.7 事件与布局时序

1. todo_write 更新 TodoStore，经现有 TodoEvent/reducer 到 state.todos；保留数据链路。
2. App 读取终端尺寸、draftRows、当前配置和 team snapshot，获得静态 V 和团队投影。
3. 计算补全整体上限，读取最近报告的菜单实际占用，生成唯一 TODO 布局投影。
4. 渲染 AppShell、TeamPanel、TodoPanel 和 Composer；视口树始终保持相同的父层级。
5. PromptInput 的候选变化通过 layout effect 报告实际菜单高度；必要时 App 重新计算一次，直到高度稳定。
6. resize、team 结束、输入缩回单行、菜单关闭时重新计算，自动恢复常规形态；无需重启、刷新列表或再次调用 todo_write。

已有 draftRows 的报告/收缩节奏保留。新增状态及 Hook 必须置于 App 的“小于 MIN_FULLSCREEN_ROWS”提前返回之前，禁止按 fullscreen、overlay 或尺寸条件调用 Hook。小于 12 行时沿用现有占位屏，不渲染 Composer；其卸载清零菜单行数，恢复尺寸后的首次挂载必须报告实际行数（包括 0），不能沿用上次菜单高度。

父容器 overflow 仅限制输出边界，不能证明过渡帧的状态栏或当前项完整。验收除收敛后的完整帧外还须捕获打开菜单、输入增长、resize 的过渡输出；稳定尺寸下菜单变化不得裁掉底部状态栏。旧菜单高度可能在一个布局提交内暂时保守地减少 TODO 行数，必须在下一次布局报告后恢复，不得持续隐藏或无限更新。若出现底部内容被裁，必须修正预算传播，不能以最后帧正常判通过。不能为了瞬时测量不足清空 todos、重建 TodoStore 或在正常尺寸下重挂 ScrollViewport；小于 12 行的既有占位分支卸载属于明确例外。

## 四、文件 / 模块变更计划

以下是后续开发节点的完整清单。本评审节点仅修订本 spec；新模块不从 Core 导出，不增加依赖、配置文件或持久化迁移。

| 操作 | 文件 | 一句话意图 |
| --- | --- | --- |
| 已修订 | docs/plans/todo-panel-responsive-visibility/spec.md | 本设计、实施步骤、验证及交接依据 |
| 修改 | packages/cli/src/ui/layout/rail.ts | 15% 宽度及最小正文约束，移除固定扣团队行数函数 |
| 新建 | packages/cli/src/ui/layout/team-panel.ts | 根据实际团队快照生成可复用行投影与折叠策略 |
| 新建 | packages/cli/src/ui/layout/autocomplete.ts | 计算建议窗口和含边框的实际菜单高度 |
| 新建 | packages/cli/src/ui/layout/todo-layout.ts | 统一 TODO 显示原因、行预算和正文宽度 |
| 修改 | packages/cli/src/ui/TeamPanel.tsx | 消费共享团队投影，保持原有状态及排序呈现 |
| 修改 | packages/cli/src/todo/limits.ts | 三行紧凑阈值、六行常规阈值，删除无用固定预留与活动项换行参数 |
| 修改 | packages/cli/src/todo/panel-rows.ts | 新增不单独占溢出提示行的紧凑窗口选择器并更新注释 |
| 修改 | packages/cli/src/ui/TodoPanel.tsx | 两级形态、单行任务、可读计数与严格高度约束 |
| 修改 | packages/cli/src/ui/AutocompletePopup.tsx | 消费菜单投影，所有文本单行，允许整体不显示 |
| 修改 | packages/cli/src/ui/PromptInput.tsx | 根据候选算菜单投影，报告实际行数并接收总高度上限 |
| 修改 | packages/cli/src/ui/Composer.tsx | 透传菜单高度限制和报告回调 |
| 修改 | packages/cli/src/ui/App.tsx | 一处接线共享布局、菜单行状态和现有正文宽度传播 |
| 修改 | packages/cli/src/ui/BottomStatusRow.tsx | 将过时 todoRailRows 注释改指统一布局模块 |
| 修改 | packages/cli/src/ui/UpdateLine.tsx | 同步预算消费者注释，避免保留已删除 API 的说明 |
| 修改 | packages/cli/src/ui/layout/ScrollViewport.tsx | 仅把“一段五分之一宽度”说明改成响应式右栏，滚动逻辑不变 |
| 修改 | packages/cli/src/__tests__/todo-rail.test.ts | 更新宽度矩阵，删除锁定旧 8 行扣除的断言 |
| 新建 | packages/cli/src/__tests__/todo-layout.test.ts | 验证统一预算、优先级、团队折叠及菜单夹紧 |
| 修改 | packages/cli/src/__tests__/todo-panel-rows.test.ts | 穷举紧凑窗口锚点和隐藏数量守恒 |
| 修改 | packages/cli/src/__tests__/todo-panel.test.tsx | 验证 14–36 列、3–12 行、宽字符及单行活动项 |
| 修改 | packages/cli/src/__tests__/team-panel.test.tsx | 验证投影高度与实际行数一致，保留排序与状态语义 |
| 新建 | packages/cli/src/__tests__/autocomplete-layout.test.tsx | 验证边框、提示、长文本及选中窗口的总高度 |
| 新建 | packages/cli/src/__tests__/todo-responsive.test.tsx | 挂载真实 AppShell / 面板 / Composer，覆盖动态 resize 和菜单回调 |
| 新建 | packages/cli/src/__tests__/todo-app-layout.test.tsx | 挂载真实 App，验证生产接线、菜单键盘门控与小窗口恢复 |
| 修改 | packages/cli/README.md | 更新 15%、76 列门槛、紧凑 footer、短屏回退和诊断含义 |

AppShell.tsx、budget.ts、Core、controller、reducer、todo store、config schema 和命令实现均无需修改。旧常规选择器保留公开签名；仅清理它关于“低于 3 行不可达”的说明，明确常规调用仍保证足够槽位，紧凑调用走新的选择器。

## 五、接口设计

没有 REST / WebSocket 新接口，todo_write 输入输出和 session JSON 完全不变。CLI 命令继续支持 /todo status、/todo panel on|off、/todo clear 等现有语法；不新增强制显示开关。README 明确 Panel: on 是配置状态，实际可见性还受窗口、overlay 和数据影响。本次不将瞬态几何写入 controller 或扩展命令上下文。

新增的 TypeScript 接口按以下签名实施，均为 CLI 内部接口：

```typescript
interface TeamPanelLayout {
  collapsed: boolean;
  rowCount: number;
  visible: SubagentRun[];
  hiddenTotal: number;
  hiddenRunning: number;
}
interface TeamPanelLayoutInput {
  snapshot: TeamSnapshot | null;
  terminalRows: number;
  availableRows: number;
}
interface AutocompleteLayoutInput {
  itemCount: number;
  selected: number;
  maxRows?: number;
  maxHeight?: number;
}
interface AutocompleteLayout {
  start: number;
  count: number;
  moreBelow: number;
  showMore: boolean;
  rowCount: number;
}
interface TodoRailLayoutInput {
  mode: RenderMode;
  cols: number;
  panelEnabled: boolean;
  overlayOpen: boolean;
  itemCount: number;
  viewportBudget: number;
  teamRows: number;
  popupRows: number;
}
interface TodoRailLayout {
  visible: boolean;
  reason: 'visible' | 'inline' | 'disabled' | 'overlay' | 'empty' | 'narrow' | 'short';
  width: number;
  rows: number;
  contentCols: number;
  popupMaxHeight: number;
}
```

buildTeamPanelLayout(input)、buildAutocompleteLayout(input)、buildTodoRailLayout(input) 分别返回对应接口；selectCompactTodoRows(items,maxItemRows) 返回已有 TodoRowSelection。隐藏时 width 保留候选宽度供测试判断，contentCols 则必须是完整终端宽度；禁止通过 width>0 替代 visible 挂载。

TeamPanelProps 新增 layout?: TeamPanelLayout。PromptInputProps 和 ComposerProps 新增 popupMaxHeight?: number、onPopupRowsChange?: (rows:number)=>void。AutocompletePopupProps 新增 layout?: AutocompleteLayout，未传则用 helper 按旧 maxRows 默认计算。TodoPanelProps 的字段不变，但 rows 注释指向新的统一布局投影。TeamPanel、TodoPanel 因新增空渲染分支，返回类型改为 React.ReactElement | null。

新增公开 helper 提供说明、参数单位和异常策略；不因非法几何数字抛异常。统一 nonNegativeInt(n)=Number.isFinite(n) ? Math.max(0,Math.floor(n)) : 0，在 helper 边界规整一次，禁止 NaN 经 min/max 向外传播。cols、terminalRows、viewportBudget、teamRows、popupRows、itemCount、selected 和紧凑选择器槽数均遵守该规则；selected 随后夹紧至实际候选范围。maxRows 未传默认 6，显式非法值归 0；maxHeight 仅 undefined 表示无额外限制，显式 NaN、正负 Infinity、负数归 0。唯一正 Infinity 特例是 TeamPanel 旧调用的 availableRows，在有限数校验前识别；负 Infinity 不适用。规整后的 cols 同时用于宽度及 contentCols，保证有限、非负整数输出；无需为此另建公共数字工具模块。

空菜单投影所有数字为 0、showMore=false；空团队投影为 collapsed=true、rowCount=0、visible=[]、hiddenTotal=0、hiddenRunning=0。折叠投影保留排序器的列表及统计字段但只渲染标题，不能同时渲染邮件或项目。同一实际快照、同一预算生成的投影只读使用，不另作持久化。

## 六、数据模型与不变量

TodoItem 与 TodoSnapshot 完整保留：items、total、doneCount、activeIndex、updatedAt 都不迁移。TeamPanelLayout、AutocompleteLayout 和 TodoRailLayout 只是每帧推导值，不保存到 session、配置或数据库。App 仅新增 popupRows 数字状态（初值 0）；不把布局投影重复写入 reducer，不缓存一份可失配的 TODO 数据。

以下不变量必须写进测试：

1. railVisible 时 contentCols+railWidth=terminalCols，且 contentCols>=62。
2. 可见 TODO 使用的同一个 rows 同时决定形态、选行和组件高度，不分别计算挂载门槛。
3. 实际团队高度等于 teamLayout.rowCount；实际菜单高度等于 popupLayout.rowCount，任何建议不得换行。
4. 对同一 V 生成的生产投影，团队、菜单和右栏行预算之和不超过 viewportBudget；静态预算对可选提示行保持保守，允许实际剩余更多，不允许更少。
5. 可见面板且项目槽数至少为 1 时锚点可见；零槽选择器只保证隐藏计数守恒，任何列表文字不超过分配的终端列宽。
6. 数据更新不改变正文父节点形状；宽度变化允许正常重排，不允许重置滚动 intent 或 offset。
7. 配置关闭、空列表、overlay 与 inline 语义保持；恢复窗口尺寸即恢复面板，无持久化副作用。

## 七、实施顺序与测试验收

### 7.1 下游实施步骤

1. 在 todo-layout.test.ts 和 todo-responsive.test.tsx 写 100×20、有 20 项 TODO、团队实际占 8 行的回归：期望右栏 15 列、4 行、当前项及计数可见。先确认旧门控下失败，不能用只检查代码字符串的测试替代渲染。
2. 完成宽度 helper、团队投影和预算 helper 的测试与实现。团队分别构造 0、1、5、8 个 run，有无 lastMessage；验证空 snapshot 与空 runs 的区别。
3. 补齐紧凑窗口穷举测试，再实现 TodoPanel 降级。迁移旧活动项换行断言，保留 TodoCard 未截断的全文验证。
4. 实现菜单投影、总高度上限和回调。分别验证 / 命令、@ 文件建议、上下切换、候选缩减到零、清空输入，以及本次新增的 inactive 零行投影和隐藏候选键盘门控。
5. App 接入共享结果和稳定回调。使用现有 draftRows，不新增第二份输入高度状态；render 内只推导布局，状态写入在回调/effect 中完成。
6. 运行定向、类型及完整测试，完成终端人工验收；更新 README 中的宽度、隐藏条件、紧凑提示和示意图。清理本清单指出的过时注释。

### 7.2 必须通过的验收矩阵

| 编号 | 场景 | 预期 |
| --- | --- | --- |
| A01 | 100×20，单行输入，无团队，无菜单 | 15 列右栏，保守高度 12；显示常规列表 |
| A02 | 100×20，团队 5 个可见 run、另有溢出和邮件 | 团队 8 行，TODO 4 行紧凑显示；标题、当前项、隐藏计数可见 |
| A03 | 100×20，团队 1 个 run、无邮件 | 团队 2 行，TODO 10 行；不能仍扣 8 行 |
| A04 | 100×19，任意团队 | 团队仅标题 1 行，单行输入时 TODO 保守 11 行 |
| A05 | 100×20，多行输入致 V=8，团队自然 8 行 | 团队折叠 1 行，中间剩 7 行；正文与 TODO 可见 |
| A06 | V=12、团队 8 行、补全候选很多 | 菜单最多整体 1 行，因不足 3 行而不挂载；TODO 仍有 4 行 |
| A07 | V=12、无团队、候选很多 | 菜单整体不超过 9 行；打开后 TODO 至少 3 行，关闭后恢复 |
| A08 | 75→76→100→200 列 resize | 右栏 0→14→15→30，正文按同一宽度重排，无滚动组件重挂载 |
| A09 | 可用高度 2→3→5→6→8 | 依次隐藏、紧凑、紧凑、常规、常规；无负高度或被裁掉的锚点 |
| A10 | 1–20 项，锚点位于首、中、末；全完成 | 当前/首个未完成/最后项按规则可见，隐藏计数守恒 |
| A11 | 14、15、18、22、30 列，中英文、emoji、组合字符 | 按 string-width 验证每行宽度；活动项一行，无半个替代字符或越界 |
| A12 | running/idle、reducedMotion、ASCII 终端 | spinner 仅在合法条件动画；计数和状态不只靠颜色表达 |
| A13 | /todo panel off、空列表、/clear、/resume | 配置优先；清空后正文恢复全宽；恢复已有列表立即重算 |
| A14 | 打开/关闭 help、settings；inline；headless | overlay 保持全宽；inline 仍使用 TodoStrip；headless 输出无变化 |
| A15 | idle 时打开 / 菜单、输入变长、关闭菜单 | 不借助 agent ticker 即更新高度；无无限 setState 或布局抖动 |
| A16 | 模拟连续 team 开始/结束并滚动正文 | 状态栏、输入框始终可见；TODO 不清空；滚动 intent 不被重放 |
| A17 | 有 slash/file 候选，菜单高度 0、1、2，再恢复到 3 | 隐藏时 Enter 提交原始 buffer，方向键与 Tab 不接受隐藏候选；恢复后选中项可见；Shift+Tab 不改写草稿 |
| A18 | 菜单打开时打开 overlay，再关闭 overlay | inactive 菜单及行报告为 0，输入停用、草稿保留；恢复后按最新候选报告高度，无残留扣行 |
| A19 | 候选 label/hint 含短换行、CRLF、制表符、中文及 emoji | 显示空白折叠且每项一行；rowCount 等于实际菜单高度；选择仍返回原始值 |
| A20 | 几何输入为 NaN、正负 Infinity、负数、小数；teamRows>V | 输出有限非负整数且 T+菜单+右栏不超 V；仅团队旧调用的 availableRows=正 Infinity 保留自然展开；非法菜单上限不显示 |
| A21 | 开着菜单执行 20→11→20 行 resize，另测 StrictMode 重放 | 11 行显示既有占位屏；重挂报告含 0，恢复后无旧菜单扣行，无 Hook 顺序错误或更新循环 |
| A22 | 真实 App 上恢复已有 TODO，再触发团队事件、菜单、resize | 100×20 右栏 15 列、团队最坏 8 行时 TODO 4 行；关闭菜单恢复预算；正常尺寸滚动视口不重挂 |

布局测试使用 Ink render 配合可控的 stdout（columns、rows、EventEmitter 的 resize），stdin 使用项目已有可控输入模式；不要使用 ink-testing-library 固定 100 列输出假装覆盖全部尺寸。组件集成测试必须挂载真实 AppShell、TodoPanel、TeamPanel 和 Composer，harness 调用生产预算函数，不复制公式。另在 todo-app-layout.test.tsx 挂载真实 App，参考 app.test.tsx / app-follow-through.test.tsx 的 controller/event fixture，仅替代外部模型与 I/O；不得 mock 预算 helper、PromptInput、Composer 或面板，也不得在测试中重写 App 接线。通过可控终端 resize、真实 stdin 和 reducer 事件覆盖 A02、A13、A15、A17、A18、A21、A22。核心 smoke 再经真实 aragon 启动入口人工验证。

全部输出先 stripAnsi，再逐行 stringWidth 检查列数；检查包含底部状态栏和输入框的完整帧，高度不超过 frameHeight(rows)=rows−1。对各行数与列数边界穷举；对窗口伸缩使用 rerender/resize，再等待 layout effect 收敛，断言过渡帧、最后帧及有限更新次数；停止 spinner/ticker 后，同一输入不再持续触发布局回调。应记录 resize 前后的视口 mount 数及滚动 intent 行为，不能仅断言 TODO 单词存在。

### 7.3 下游验证命令

逐条执行，上一条失败先定位，不使用 PowerShell 5.1 不支持的 &&。以下命令是后续实施验收要求，不是本设计节点已经执行的结果：

```powershell
npm run test -w packages/cli -- src/__tests__/todo-rail.test.ts src/__tests__/todo-layout.test.ts src/__tests__/todo-panel-rows.test.ts src/__tests__/todo-panel.test.tsx src/__tests__/team-panel.test.tsx src/__tests__/autocomplete-layout.test.tsx src/__tests__/todo-responsive.test.tsx src/__tests__/todo-app-layout.test.tsx src/__tests__/prompt-input-commits.test.tsx
npm run typecheck
npm run build
npm test
git diff --check
```

人工验收使用构建后的 node packages/cli/dist/cli.js --fullscreen，避免全局安装版本和工作区不同。先生成或恢复包含至少 8 项且当前项居中的计划；在 100×20 启动多 Agent，记录面板可见性，再检查 100×19、80×20、76×20、75×20、120×30。开关补全、输入多行、切换 overlay、完成任务及恢复 session 后验证上述矩阵。Windows Terminal/PowerShell 必测，ASCII 能力通过既有测试 caps fixture 覆盖；不需要连接真实模型才能运行自动化布局测试。

## 八、风险与缓解

| 风险 | 缓解与明确边界 |
| --- | --- |
| 比例降低使任务描述过短 | 14 列下限、窄屏去编号、每项单行、正文 TodoCard 保留全文；100 列精确使用 15 列 |
| 只降低门槛导致底部提示被截断 | 同一份行投影供 gate 和 renderer 使用；紧凑态合并提示，常规态取消活动项换行 |
| 团队算法复制后与渲染漂移 | TeamPanel 必须消费 helper 的同一投影；邮件和溢出都计入；用真实组件校验 rowCount |
| 菜单边框或说明长文本偷占行 | 总高度上限与建议条数分离，强制单行，报告 helper 的完整高度 |
| 菜单局部更新未被 App 感知 | 显式高度回调覆盖 idle；同值不更新；无需等待下一次模型事件 |
| 布局反馈环和首帧失配 | 上限不读实际菜单高度，团队不读菜单状态；每次挂载含零值报告、卸载清零，layout effect 单向收敛；裁剪只限边界，过渡帧另验底部状态可见 |
| 小终端无法同时承载所有内容 | 优先保留输入、状态和团队摘要，TODO 少于 3 行时隐藏；原状态计数和正文卡片仍可查看进度 |
| 变更布局重置正文滚动 | 保留 AppShell 无条件中间横向容器；不修改 ScrollViewport 状态逻辑，并做挂载次数及 intent 回归 |
| UI 源码出现中文或生硬新符号 | 源码文案保持 ASCII，图形继续 pickGlyphs，执行 glyphs 现有回归 |
| 历史文档或旧测试继续表达 20% / 8 行规则 | 更新本清单所列生产注释、CLI README 与相关断言；历史方案归档不重写 |
| 无关工作区修改被覆盖或混入提交 | 本评审节点仅修改指定 spec.md；后续按文件清单审查差异，不批量还原或 git add -A |

回退时整体恢复本需求的布局及组件修改，不改 TODO 数据，不需数据库迁移。用户也可以即时 /todo panel off 隐藏右栏；该开关不代替正确的布局验收。发布前的风险判断以实施节点的测试和人工终端记录为依据，不能把上游设计节点的旧实现 53 项通过当作修复完成证据。

## 九、交付与完成标准

上游设计节点已交付 v1；本评审节点交付 v2，检查 UTF-8、评审记录、正文修正、评审结论和章节完整性，确认无未解决 P0/P1。不修改实现、不执行 git commit。通过任务工具记录本轮 feature 和文档路径，声明未修改源码，再报告 complete 并用 status 核验第 1 节点为 completed。若工具失败，严格按任务提示重试及回退，仅更新看板第 1 节点；不能将历史 context-usage-gauge-accuracy 记录当成本轮结论。

开发节点完成标准为本文件清单逐项落实、A01–A22 通过、类型/构建/全量测试通过或明确记录与本改动无关的既有失败。若实施时发现既有组件尺寸与本文公式不符，应先以真实渲染证据修订本文对应条款，补回归测试，再继续实施，不可用额外魔法预留行掩盖差异。

## 评审结论

**通过。** 本方案升级为 v2，6 项 P1 和 3 项 P2 已全部在正文修正，无 P0/P1 遗留。约 15% 宽度、团队实际占用、三行紧凑显示及共享预算可由现有 React/Ink 栈实现；范围限制在 CLI 布局、相关测试和文档，不改变 Core、TODO 数据协议或持久化。

本结论批准设计进入实施，并非生产修复或发布验收。下游必须完成 A01–A22、真实 App 接线回归、类型检查、构建、全量测试与 Windows 终端人工验收。本评审仅修改本 spec.md，未修改源代码、未执行 git commit；评审证据为当前代码路径核验、已安装 Ink 的换行行为探针及文档结构/引用检查，未将上游 53 项旧基线测试计为本轮修复通过。

## 实施过程发现的方案缺陷

- IF-03：真实 App 在 PgUp 后从 100 列缩到 76 列，滚动提示占据输入行右端，空草稿的 placeholder 自动换成两行，而 draftRows 仍正确报告空草稿为一行。中间区域因此少一行，四行 TODO 的 footer 与团队标题重叠。将 PromptInput 的纯提示文本改为单行 truncate（不改变草稿编辑或行数计算）；新增真实 App 滚动后连续缩放回归，确保右栏四行和滚动意图同时保留。

- IF-02：真实 App 与独立 12→4 行 rerender 均复现标题下移、当前项高度变为零、footer 覆盖下一项。Yoga 树证实根节点虽然仍为四行，但每帧新建的 `borderStyle` 触发 Ink 重设四边宽度，未变化的 `borderTop/Bottom/Right=false` 不会重新应用，隐形上下边框侵占了两行。TodoPanel 按 rail glyph 缓存边框对象，颜色独立更新；能力层 glyph 变化时只重建右栏根节点，正文视口保持原实例。补充常规→紧凑的真实 rerender 回归，不以裁剪掩盖此问题。

- IF-01：宽字符回归实际输出 `│ ✔  Step 9 c…` 在 14 列右栏占 15 个显示列。已安装 Ink 5 的输出 tokenizer 将无变体选择符的 `✔` 当一列，而 `string-width` 将其计为两列；固定 marker Box 不能消除输出层补空格差异。局部修正为 Unicode 完成标记追加显式 emoji presentation selector（源码转义），使输出 tokenizer 与显示宽度一致；ASCII 标记保持不变。不修改 glyph 能力表或依赖，以宽字符逐行验证约束此修正。

## 实施结果与验证记录

2026-10-02，开发节点已落实第四节全部 25 个文件条目（含本方案）。新增三个 CLI 内部布局模块及四个测试文件，未新增依赖、Core API、配置或持久化字段，未执行 git commit。工作区进入任务时已有父项目修改、运行日志和本方案目录；这些既有变更均保留，未混入源码修复。

- `npm run typecheck`：CLI 与 Core 的生产及测试类型检查均通过。
- `npm run build`：两个 workspace 均通过，CLI 入口 shebang 生成成功。
- 最终 `npm test`：CLI 200 个文件通过，2972 项通过、6 项跳过、1 项失败；Core 29 个文件、466 项全部通过。本需求的 9 个定向测试文件共 78 项在最终全量运行中全部通过。
- 唯一失败为 `proc-supervisor.test.ts::AC-14`，6000ms 等待 URL 就绪超时，单独重跑同样失败。该 fixture 只打印 `http://localhost:3000`，不监听端口，而现有 `ReadinessWatcher` 要求 TCP 连接确认。测试、supervisor、readiness 三个文件与 HEAD 文本一致，未引用本次布局模块；作为独立既有失败保留，未扩大本次修复范围。
- `git diff --check -- .` 通过；变更范围与第四节清单一致。Git 的 LF→CRLF 提示是工作区转换提示，不是空白检查失败。

验收证据对应关系：A01–A07、A09、A20 由纯布局和团队组件测试验证；A08、A13、A15–A18、A21–A22 由真实 App / AppShell / Composer / PromptInput 的 stdin、事件和 resize 回归验证；A10 由紧凑窗口穷举验证；A11–A12 由 14–36 列、3–12 行的 Unicode/ASCII 面板输出验证；A19 验证含 CRLF、制表符、中文、emoji 的菜单文本及原始文件名补全；A14 的 inline/headless 原有回归随全量测试运行。动态回归覆盖常规→紧凑、菜单开关、长草稿触发团队折叠、PgUp 后缩放的滚动状态，以及逐帧底栏和高度检查。

Windows 终端验证通过真实 ConPTY 启动构建后的 `node packages/cli/dist/cli.js --fullscreen`，使用工作区内隔离的 `ARAGON_HOME`、本地 session 与无模型请求流程。恢复 20 项任务、100×20、100×19、80×20、76×20、75×20、120×30、help 开关、panel 开关共 10 项通过；75 列隐藏后扩大窗口恢复。运行记录位于 `.agentmesh/todo-smoke-home/results.json` 及同目录帧文本，逻辑说明位于 `.agentmesh/logic-notes/todo-responsive-budget.md`，均属运行期记录。

验证边界：未人工操作 Windows Terminal GUI，也未调用真实模型启动多 Agent；团队最坏八行场景由真实 App 事件回归验证，ConPTY 检查真实入口与终端缩放。全量测试未宣称全绿，独立就绪测试失败如上明确保留。

## 最终代码审查与提交验证

2026-10-02，最终审查节点已逐项核对第四节全部 25 个文件、A01–A22 的实现与测试，重点检查共享预算、真实 App 接线、输入交互、滚动实例稳定性及小终端恢复。独立审查覆盖纯布局与面板渲染；主审查覆盖 App、Composer、PromptInput 与补全菜单。未增加依赖，未改变 Core、配置和存储协议。

审查发现并修复两项问题：

- CR-01（P1）：团队描述与邮件主题允许显式换行，`wrap="truncate"` 不会删除换行，导致投影三行实际五行；八个任务的真实 App 回归中四行 TODO 被完全挤掉。仅在显示副本折叠空白，保留原始数据；补充 CRLF、Tab、中文、数据不变与真实 App 多行团队回归。
- CR-02（P2）：完成标题遗留固定 20 列门槛，不符合 §3.6 的内宽规则。按 TODO 标签、间隔、计数及 done 后缀计算所需宽度，新增 14/15、16/17 列边界验证。同步清理不再准确的字符宽度注释。

两项修复均先运行失败回归：3 个文件共 4 项失败（团队实际 5 行而预算 3 行、真实 App 两项右栏 0 行而应为 4 行、窄栏完成提示缺失）；修复后同一组 45 项全部通过。独立复核确认显示数据不被修改，完成标题符合设计，无新增问题。

最终验证结果：

- `npm run typecheck` 与 `npm run build` 均通过。
- `npm test`：CLI 200 个文件通过、1 个失败，2974 项通过、6 项跳过、1 项失败；Core 29 个文件、466 项全部通过。本功能测试及相邻输入、滚动、glyph 回归均通过。
- 唯一失败仍为 `proc-supervisor.test.ts::AC-14` 的 URL 就绪等待。检查确认测试、supervisor、readiness 与 HEAD 无差异；fixture 只打印 URL 而未监听 TCP 端口，与当前就绪判定不符。该既有独立失败不纳入本功能提交，不宣称全量测试全绿。
- 构建后重新执行 `.agentmesh/todo-terminal-smoke.cjs`：真实 Windows ConPTY 入口的恢复、尺寸矩阵、help、panel 开关共 10 项全部通过；验证边界与上文一致。
- `git diff --check -- .` 通过；提交范围为第四节 25 个文件。父项目改动、运行期记录与构建产物均排除。

审查结论：本功能通过，CR-01、CR-02 已修复，无本功能遗留 P0/P1。按当前节点授权使用 `feat:` 前缀提交，保留正常 Git hooks；具体提交哈希由最终任务回报记录。
