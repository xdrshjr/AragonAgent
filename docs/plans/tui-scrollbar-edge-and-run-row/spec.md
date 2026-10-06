# TUI 右缘滚动条可靠显示与「运行状态行」上移设计

版本：v2（设计评审后修订）；日期：2026-10-06；节点：设计（architect）→ 评审（reviewer）。

## 评审记录

评审方式：逐节对照 `packages/cli` 当前源码（`ui/frame-differ.ts`、`ui/Composer.tsx`、`ui/App.tsx`、
`ui/BottomStatusRow.tsx`、`ui/ActivityLine.tsx`、`ui/layout/{ScrollViewport,budget}.tsx`、`__tests__/spinner-census.test.ts`）
复核规格里的每一条事实断言，再按可行性 / 完整性 / 一致性 / 适度三个维度找缺口。
已核对为**属实**的关键断言：`fullRepaint` 不发 `CSI K`、`diffRepaint`/`repaint` 两处各发一次（`frame-differ.ts:342/377`）；
`cli.tsx:670` 是唯一的差分器构造点；`string-width`/`strip-ansi` 已是 `packages/cli` 依赖（无新增依赖）；
`ModeChip` 宽度 = `label + 3` 成立；§3.3.3 表中 120/79/53/39/长工具名五行的算术全部复算无误；`spinner-census` AC-11 的四条文本断言与规格引用一致；
`createTerminalHarness`、`unified-scroll-layout`、`perf-command`、`activity-line` 等测试文件均存在。

| 编号 | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| RV-1 | P1 | **完成定义不可达**：§9 的 DoD 要求在 PowerShell 5.1 / 7 真终端通过 M-1/M-3/M-5/M-6，而实施节点是无头自动化环境，没有任何 Windows 真终端；照字面执行只会出现「卡死」或「谎报通过」两种结局 | 已修：DoD 拆为「自动化门禁（实施节点必须全绿）」与「人工发布门禁（交接清单，实施节点只负责产出手测脚本与待办，不得宣称已通过）」；§7.2、§7.3、§9 同步 |
| RV-2 | P1 | **窄屏下上移行比旧提示行更早截断紧急操作**：原 `hintText(running)` 独占整行宽度（38 列时能显示 `⏎ steer · esc×2 interrupt · ctrl+c×2 ex…`）；v1 的 §3.3.3 档 2 把标签保到最多 `inner/2`，提示被压到 21 列，`interrupt` 被**词中截断**成 `esc×2 inter…`。`Composer.hintText` 的头注释明确规定运行态提示「NEVER abbreviated」，这是对既有不变量的退化（StatusBar 虽有 `Esc x2 interrupt`，但输入区在视口内时它是冗余信息，不能当作放宽理由） | 已修：`planRunRow` 改为**按子句**分配——先丢尾部子句（`exit`，再 `ctrl+c stop N`），标签最先让位到 `MIN_LABEL`，`steer · interrupt` 两个子句保证整句可见，**只有标签允许被省略号截断**；§3.3.3 表、§3.3.4、§5、T6 同步；`hintText` 拆出 `runningHintClauses()`，`hintText` 输出逐字不变 |
| RV-3 | P1 | **矮终端 / `--no-hints` 下上移行是净增一行**：v1 §3.3.2 规定运行中该行「无条件存在」，于是 `rows < 20`（`budget.ts` 明确为买回一行而丢掉提示行）或 `--no-hints` 时，开始运行 footer +1、转写区被吃掉一行，而旧的固定底行是**零成本**的；这要靠 `footerDelta` 补偿，还新增了 `composerBaseRowCount` 与 R5 一整套只为这条支路服务的机制 | 已修：上移行**仅在 `rows >= HINT_MIN_ROWS && cfg.hints` 时启用**（即「提示行本来就存在」的条件）；其余配置保持旧的固定底行形态，**任何配置下开始/结束运行 footer 高度都不变**。随之删除 `composerBaseRowCount`、`budget.ts` 改动与 R5（T9 改为断言「未启用即旧布局」），`composerBaseRows` 表达式**不动**；dock 回退判据改为 `runRowShown = runRowEnabled && activityRowVisible`（`elementVisible(null)` 返回 `true`，不能单看可见布尔量，否则未挂载上移行时 dock 会被误压制） |
| RV-4 | P2 | §7.1 T4 写的 `cols+0` 与 `cols` 重复，应为 `cols+1`（溢出行；规则 `>=` 同样不发 EL） | 已修 |
| RV-5 | P2 | §3.1.3 的 `stringWidth(stripAnsi(...))` 对每个变化行每帧执行，规格未说明代价 | 已补：只测**变化行**（≤ 视口行数）、与 Ink 同一度量；`perf` 手测里观察 `/perf` 帧耗时无退化即可，不需要缓存；若实测退化再加「同一行串不重复测宽」的单项缓存 |
| RV-6 | P2 | §8 R2 的「对满足条件的宿主改用 ASCII 轨道」条件未定义 | 已补：条件 = M-8 实测确认末列单元占 2 列的宿主，经 `AGENT_ASCII_SCROLLBAR=1`（env）显式开启；不做自动探测（无可靠探测手段） |
| RV-7 | P2 | 上移行把 `ModeChip` 从提示行**行首**挪到**行尾右对齐**，与闲置态提示行的 chip 位置不一致 | 保留（用户要求「动画与提示在最前面」，行首要留给动画）；已在 §3.3.1 标注为刻意差异 |
| RV-8 | P2 | §4 文件表里 `App.tsx` 行把 `.claude-index/config.md` 的登记混写进「意图」栏，与下一行重复；`composerVisible` 泛化后应保留旧名别名，避免既有测试 import 断裂 | 已修（表格整理；§3.3.5 增加别名说明） |

**无 P0。** 三个 P1 均已在正文修复并升版至 v2。

## 0. 阅读须知

本节点只产出设计文档，**不修改任何源码、不提交**。下文的“新增”“修改”均指后续实施节点的工作；
“已验证”仅指本节点在本机用 `dist/` 渲染或阅读源码得到的事实，“待实机验证”必须在 Windows PowerShell 上完成，
本机没有 PowerShell 真终端，不能替代。实施范围为 `packages/cli`，不改变 Core、会话持久化、模型调用协议，不新增依赖。

## 1. 概述

用户本轮提出五项要求：① PowerShell 里看不到最右侧拖动条，导致无法拖动；② 拖动查看历史时底部输入区要一起滚动，
给历史留出更大空间；③ 在最右侧上下拖动滑块查看历史；④ 流畅、稳健；⑤ 底部「运行中」小动画与提示要和 `steer`
同处一行，显示在最前面，并位于输入区上方。

**仓库现状不是从零开始。** 提交 `8ab504999`（`tui-unified-scrollbar`，见 `docs/plans/tui-unified-scrollbar/spec.md`）
已经把输入区并入滚动文档、新增终端末列滚动条、拖动控制器、鼠标路由与帧观察器；其后 `a7ca04619` 删除了 inline 模式，
全屏是唯一交互形态。本节点用当前 `master`（`c3445fce7`）逐项复核，结论分三类：

1. **需求②③已在布局层成立**。本节点用已构建的 `dist/` 在真实 Ink/Yoga 下渲染 60×14 帧：每个视口行宽恰为 60，
   末列为轨道 `│` 或滑块 `█`（ASCII 层为 `|`/`#`），输入框与消息共用一个偏移。但前序规格第 §8 节列出的 Windows 真终端手测
   **从未执行**（`CHANGELOG`/README 无记录），因此「PowerShell 里能看到、能拖」从未被证明。
2. **需求①仍有一条确定的代码级缺陷，且与用户症状吻合**：`ui/frame-differ.ts` 的逐行差分在每个变化行末尾无条件追加 `CSI K`
   （擦除到行尾），而滚动条把每个视口行写满到最后一列。在“写满末列后光标处于延迟换行状态、且 `CSI K` 会擦除光标所在列”的终端实现里
   （基于 Windows 控制台的 conhost / Windows Terminal 属于这一类，详见 §3.1），**每个被重写的行会把刚画好的滚动条单元擦掉**。
   流式输出时几乎每个视口行都在重写，滚动条随之整列消失；`--no-diff-render` 走 Ink 原生路径则不受影响。
   这是本轮的主修复（WP-S）。该机制的**代码事实已验证**，**终端侧擦除行为待实机验证**（§3.1.3）。
3. **需求⑤尚未实现**：运行动画与阶段短语（`ActivityLine`）住在固定的底部状态行（`BottomStatusRow`，位于视口之下、`StatusBar` 之上），
   `steer` 提示住在 `Composer` 的提示行（输入框**下方**）。二者既不同行，也不在输入框上方，更不会随输入区一起滚动（WP-R）。

因此本设计由三个工作包组成：**WP-S** 末列安全（修复差分器、建立可回归的终端模型测试）；**WP-O** 可观测性（让“看不到/拖不动”
可被一条命令定位）；**WP-R** 运行状态行上移到输入框上方并与 `steer` 合并为一行，同时保持「全帧恒只有一个动画」「更新提示在运行期静默」
「行预算恒定」等既有不变量。拒绝的路线与理由见 §3.4。

## 2. 需求对照与现状审计

| 需求 | HEAD 现状（已读源码/已渲染） | 缺口 | 处理 |
| --- | --- | --- | --- |
| ① 最右侧拖动条在 PowerShell 可见 | `ScrollViewport` 渲染 `ScrollIndicator`，宽 1 列、`flexShrink=0`、所有可用全屏尺寸常驻；`AppShell` 宽 `cols`，条在终端最后一列（本机帧验证）。**但**差分器对变化行追加 `CSI K` | 差分路径在末列擦除条；真终端从未验收 | WP-S + WP-O + 手测 M-1/M-2 |
| ② 拖动时输入区随消息一起滚 | `App.tsx` 把 `{team}{composer}` 作为 `ScrollViewport.footer`，与消息共用 `offsetFromBottom`，输入框逐行滚出；编辑动作经 `onInteraction` 回底 | 新增的运行状态行必须同样随 footer 滚动 | WP-R 的行预算与位置 |
| ③ 右缘上下拖滑块 | `scrollbar-controller.ts` + `pointer-router.ts` + `frame-observer.ts`；`--no-mouse-select` 仍可拖；`frameReady` 在输出确认后才放行命中 | 命中依赖“帧观察器确认”；观察不到时静默不可拖，缺少诊断 | WP-O |
| ④ 流畅稳健 | 16 ms 合并、30 s watchdog、虚拟化窗口、单偏移 | 无新增缺口；需回归保护 | §7 回归项 |
| ⑤ 运行动画+提示与 `steer` 同行、最前、输入区上方 | `ActivityLine` 在固定底行；`steer` 在 `Composer` 提示行（输入框下方） | 位置、合并、滚动行为全部不符 | WP-R |

不改变的既有契约（实施时必须保持，违反即回归）：`frameHeight(rows) < rows`；`viewportRows = frameHeight - 3`；一个滚动偏移所有者
（`ScrollViewport`）；字形层 ASCII 门禁（`glyphs.test.ts`）；Agent/用户可见的产品字符串为英文且 ASCII 优先；
`single-spinner-while-running` 的「活动行存在期间全帧只有一个动画」；`cli-auto-update` 的「运行期不显示更新提示」；
`hintText()` 与 `hintTextForTest` 的输出逐字不变（`interrupt-ladder.test.tsx` AC-43 钉死）。

## 3. 技术设计

### 3.1 WP-S：末列安全（差分器不得在写满末列后擦行尾）

#### 3.1.1 缺陷机制（代码事实）

`createFrameDiffer.diffRepaint`（以及选择高亮重绘的 `repaint`）把每个变化行发为
`CUP(row;1) · SGR0 · <line> · SGR0 · CSI K`。前序规格 I-4 要求「先画后清尾」，`CSI K` 的职责是清掉“上一版更长的行”留下的残余。
`fullRepaint` 用 `\r\n` 连接行、不发 `CSI K`，所以首帧与 resize 后的整屏重绘滚动条完好；**只有增量路径有问题**。

统一滚动条上线后，所有视口行的宽度恒为 `cols` 且最后一个单元是轨道/滑块。对这类行，`CSI K` 是**多余**的（整行已被新内容完全覆盖，
没有残余可清），却恰好作用在刚写入的末列单元上。

#### 3.1.2 各终端的差异（为什么只在部分终端出现）

写入终端最后一列后，终端进入“延迟换行（pending wrap）”状态。随后的 `CSI K`（EL 0，擦除“光标列到行尾”）：

- 把光标记为“逻辑上在第 N+1 列”的实现（xterm.js 系，如 VS Code 终端）：EL 擦除范围为空，无影响；
- 光标仍停在第 N 列、另置延迟换行标志的实现（基于 Windows 控制台的 conhost / Windows Terminal 的 VT 适配层，以及部分传统终端）：
  EL 从第 N 列开始，**擦掉刚写入的末列单元**。

上述差异来自对实现的已知认识，**本节点无法在本机复现**，列为 §8 风险 R1 与手测 M-1。修复对两类终端都无害，所以不依赖这条判断是否精确。

#### 3.1.3 修复规则

**当且仅当一行的显示宽度小于终端列数时才发 `CSI K`。** 显示宽度已写满 `cols` 的行没有可清的尾部，省略 EL；
宽度小于 `cols` 的行光标不在末列，EL 行为在所有终端一致，保持 I-4 原语义。

1. `FrameDifferOptions` 新增可选 `cols?: () => number | undefined`，每次 `transform`/`repaint` 现读，不缓存（与既有 `rows` 同纪律）。
   缺省或返回非有限数 ⇒ 沿用旧行为（每行都发 `CSI K`），因此既有差分单测与外部调用方零变化。
2. 抽出内部纯函数 `paintLine(row: number, painted: string, cols: number | undefined): string`，`diffRepaint` 与 `repaint` 共用；
   宽度用 `stringWidth(stripAnsi(painted))`（与 Ink 同一度量）。`painted >= cols` ⇒ 返回 `CUP · SGR0 · line · SGR0`（无 EL）。
   测宽只发生在**变化行**上（每帧 ≤ 视口行数），不做缓存；若 `/perf` 帧耗时出现可测退化，再加「同一行串不重复测宽」的单项缓存（评审 RV-5）。
3. `decorate`（文字选择高亮）只增加 SGR，不改变显示宽度，规则对其透明；`repaint` 与 `diffRepaint` 必须走同一个 `paintLine`，
   否则选择高亮重绘会重新擦掉滚动条。
4. 批尾仍以 `cursorTo(lines.length + 1)` 收束（I-5 不变）。`fullRepaint` 不改。
5. `cli.tsx` 创建差分器处新增一行 `cols: () => process.stdout.columns`。
6. 更新文件头 I-4 的措辞：「`CSI K` 仅在行宽 < 终端列数时发出；写满末列的行不得跟 `CSI K`，否则在延迟换行即擦除末列的终端上会擦掉该行最后一个单元」。

#### 3.1.4 把假设变成可回归的测试：终端模型

新增测试夹具 `__tests__/helpers/vt-screen.ts`：一个最小 VT 屏幕模型，只实现差分器与 Ink 会发出的子集——
`CUP(r;c)`、`SGR`（忽略样式）、`EL 0`、`ED 0`、`\r`、`\n`、可打印字符（宽度用 `string-width`）、`?2026h/l`（忽略）。
构造参数 `pendingWrap: 'at-last-column' | 'virtual-column'` 选择两类行为：前者 EL 会擦除末列单元，后者 EL 在待换行时为空操作。
测试把真实 `createFrameDiffer` 的输出喂给两种模型，断言**所有视口行的末列字符在整屏重绘与随后的若干次增量重绘后都仍是轨道/滑块字符**。
这个测试对修复前代码在 `'at-last-column'` 模型下必须红（记入实施偏差：先红后绿），这是本设计把“推断”变成“护栏”的方式。

### 3.2 WP-O：可观测性

「看不到/拖不动」目前没有任何一处可自查。新增一行 `/perf` 输出（`commands/perf.ts` 的 `PerfSnapshot` 增加可选 `scrollbar`）：

```
scrollbar: col=<trackCol> rows=<trackRows> mouse=<on|off> frameReady=<yes|no> thumb=<start>+<size>|none glyphs=<unicode|ascii> edge-el=<skipped|always>
```

- `mouse` 取 `mouseCaptured`（`/mouse off`、`--no-mouse`、VT 输入不可用时为 off，此时条仍可见但不可拖——这是预期降级，不是故障）。
- `frameReady=no` 且 `mouse=on` 时输出一句固定英文原因：`waiting for a full frame matching <cols>x<rows>`，把「观察器没确认」与「鼠标没送达」区分开。
- `edge-el` 报告差分器当前是否启用 §3.1.3 规则（`cols` 已接线 ⇒ `skipped`；`--no-diff-render` 时显示 `n/a`）。

数据来源是 `App` 已持有的 `terminal.scrollbar`（`ScrollbarBridge`：`geometry`、`frameReady`、`isEnabled`）与 `perfRef`，不新增状态源，
不触发重绘；与 `/perf` 其余字段同为只读快照。

### 3.3 WP-R：运行状态行上移并与 `steer` 合并

#### 3.3.1 目标布局

**启用条件** `runRowEnabled = running && rows >= HINT_MIN_ROWS && cfg.hints`（即「提示行本来就会显示」的同一条件，评审 RV-3）。
启用时，运行中输入框上方多出的一行**取代**原先输入框**下方**的提示行；闲置态不变。
未启用（矮终端、`--no-hints`）时保持**今天的形态**：活动行留在固定底行、`Composer` 不传 `runRow`，footer 高度与行为逐字不变。

```
闲置（提示行在输入框下方，与现状逐字相同）
  ╭──────────────────────────────────────────────╮
  │ > Send a message (/ for commands, @ for …    │
  ╰──────────────────────────────────────────────╯
   [Plan] ⏎ send · ⇧⏎ newline · / commands · @ files · shift+tab plan · ? help

运行中（80 列，滚动条另占最右列）
   ⠋ Percolating… · ⏎ steer · esc×2 interrupt · ctrl+c×2 exit            [Plan]
  ╭──────────────────────────────────────────────╮
  │ ⇢ Type to steer the run, Esc twice to inter… │
  ╰──────────────────────────────────────────────╯

运行中、输入区已滚出视口（固定底行接管，沿用现状形态）
   ⠋ Percolating…
   <StatusBar: running · … · Esc x2 interrupt | PgDn down>
```

- 行首是动画图标与阶段短语（`ActivityLine` 既有四档标签：`Compacting context…` > `Running <tool>` > 轮换短语），其后是 `hintText(running)` 的原文
  （`⏎ steer · esc×2 interrupt · ctrl+c×2 exit`，有后台服务时含 `ctrl+c stop N`），行尾右对齐 `ModeChip`（仅 plan 模式存在，宽度不够时先丢）。
- 该行位于 `Composer` 外层盒内、`PromptInput` 之前，**属于滚动文档的 footer**，随输入框一同滚出视口。
- 图标与短语的颜色沿用 `theme.thinking`；提示沿用 `theme.hintFg ?? theme.muted`；ASCII 层用 `glyphs.spinnerStill`、`glyphs.midDot`（`-`）、`Enter`，
  无新字形常量。
- 行首动画与提示子句之间、以及 chip 的位置是刻意与闲置态提示行不同的：闲置态 chip 在行首，运行态行首要留给动画（评审 RV-7）。

#### 3.3.2 行预算：运行中该行**替换**提示行，footer 总高度在任何配置下恒定

`runRowEnabled` 的条件**与闲置态提示行的显示条件逐字相同**（`rows >= HINT_MIN_ROWS && cfg.hints`），且两行互斥：
启用时，开始/结束一次运行 footer 高度不变（闲置时 1 行提示在输入框下方，运行时 1 行上移行在输入框上方），`ScrollViewport` 的 `footerDelta` 恒为 0，
**不产生“提交时画面跳一行”**——这正是 `BottomStatusRow.tsx` 头注释要避免的失败模式。
未启用时 `Composer` 不渲染任何新行，旧的固定底行照常承载活动行，footer 同样不变。因此**无需**改动 `composerBaseRows` 表达式、
`budget.ts`，也不需要新的行预算函数；v1 设想的「运行态无条件占一行 + `footerDelta` 补偿」被评审 RV-3 否决：它在矮终端 / `--no-hints` 下
把一条原本零成本的生命信号变成净增一行，并为此引入一整套只服务于该支路的机制。

`App.tsx` 里 `runRowEnabled` 与传给 `Composer` 的 `showHint`/`hintsEnabled` 必须由**同一个局部常量**派生（避免两处各算一遍后漂移）：
`const hintRowEnabled = rows >= HINT_MIN_ROWS && cfg.hints;`，`composerBaseRows` 里的 `Number(rows >= HINT_MIN_ROWS && cfg.hints)` 可原样保留或改读该常量（二选一，行为等价）。

#### 3.3.3 宽度梯度（纯函数 `planRunRow`，按子句分配）

行宽 = `Composer` 的 `cols`（`contentCols`，已扣滚动条与 TODO 侧栏）。提示由 `runningHintClauses()` 给出的**子句数组**表示
（顺序即紧急程度：`⏎ steer`、`esc×2 interrupt`、[`ctrl+c stop N`]、`ctrl+c×2 exit`），`hintText(running)` 是它们用分隔符 join 的结果，输出逐字不变。

**不变量（评审 RV-2）：窄屏下只允许标签被省略号截断；提示只能按整句从尾部丢弃，`steer` 与 `interrupt` 两个子句只要上移行启用就必须整句可见。**
否则上移行会比它取代的旧提示行更早、且词中截断紧急操作（旧行独占整行宽度），退化 `Composer.hintText` 头注释的「运行态提示 NEVER abbreviated」。

常量：`LEAD=1`（行首空格）、`SPINNER=2`（图标+空格）、`MIN_LABEL_COLS=10`（`SPINNER + 8`）、`REQUIRED_CLAUSES=2`、`CHIP_GAP=2`；
分隔符 ` · `（ASCII 为 ` - `）宽 `sep=3`。令 `inner = max(0, floor(cols) - LEAD)`，`natural` 为 `SPINNER + 标签宽度`，
`H(k)` 为前 `k` 个子句宽度之和加 `sep * (k - 1)`，`n` 为子句总数。

1. 若 `natural + sep + H(n) <= inner`：显示标签与全部子句；再若 `+ CHIP_GAP + chip <= inner` 则显示右对齐 chip（chip 先于任何子句被丢弃）。
2. 否则从 `k = n - 1` 递减到 `REQUIRED_CLAUSES`，取第一个满足 `avail = inner - sep - H(k) >= MIN_LABEL_COLS` 的 `k`：
   显示前 `k` 个子句，标签宽 `min(natural, avail)`（超出部分以 `wrap="truncate"` 省略号截断），chip 隐藏。
3. 否则（`inner < MIN_LABEL_COLS + sep + H(REQUIRED_CLAUSES)`，常量下为 `inner < 38`，仅在低于 40 列终端或极窄侧栏时可达，属防御档）：
   只显示标签，宽 `min(natural, inner)`；`inner = 0`、`NaN`、`n < 2` 均落在此档且不抛。`StatusBar` 的 `Esc x2 interrupt` 在该档承担紧急提示。

标签与提示均按**显示宽度**度量（`string-width`），中文工具名/短语不会错位。示例（标签 `Percolating…`，子句宽 7 / 15 / 13，`H(3) = 41`，`H(2) = 25`）：

| Composer 列宽 | inner | 结果 |
| --- | --- | --- |
| 120 | 119 | 全部显示 + chip（plan 模式） |
| 79（80 列终端，无 TODO 侧栏） | 78 | 全部显示；plan chip 也显示（`58 + 2 + 7 = 67 <= 78`） |
| 53（80 列 + TODO 侧栏） | 52 | 档 2：`k=2`，`avail = 52-3-25 = 24`，标签完整 14；`exit` 整句丢弃：`⠋ Percolating… · ⏎ steer · esc×2 interrupt`（42 列） |
| 39（40 列终端） | 38 | 档 2：`k=2`，`avail = 10`，标签截到 10：`⠋ Percola… · ⏎ steer · esc×2 interrupt`；`interrupt` 整句可见 |
| 长工具名 `Running mcp__playwright__browser_navigate`（43） | 52 | 档 2：`k=2`，标签截到 24，`steer` 与 `interrupt` 整句可见 |
| 有后台服务（4 个子句，`H(4) = 59`），80 列 | 78 | 全部显示（`14 + 3 + 59 = 76`）；chip 放不下（`76 + 2 + 7 > 78`）被丢弃 |

#### 3.3.4 组件拆分（保持 `ActivityLine` 外部契约不变）

- `ui/ActivityLine.tsx`：拆出并导出两个纯/展示单元——`resolveActivityLabel(activity, glyphs): string`（既有三档标签的唯一实现）与
  `ActivityLabel`（一个 `<Text wrap="truncate">`，含图标与标签）。原 `ActivityLine` 内部改为使用它们，**渲染输出逐字节不变**
  （`activity-line.test.tsx`、`activity-tool-label.test.tsx`、`bottom-status-row.test.tsx` 保持绿）。
  新增可选 `spinnerLive?: boolean`（缺省 `true`）：为 `false` 时图标改用 `glyphs.spinnerStill`（无定时器），短语轮换仍用原始 `reducedMotion`。
  `liveSpinner(reducedMotion, caps)` 工厂保持原样，`ink-spinner` 仍只被本文件 import（`spinner-census` AC-9 不变）。
- `ui/ModeChip.tsx`：导出 `modeChipCols(mode, caps): number`（plan ⇒ `label + 3`，其余 0），供 `planRunRow` 取宽。
- `ui/run-status-row.ts`（新增，纯函数）：`RunActivity` 类型与 `planRunRow`（按子句分配，§3.3.3）。不依赖 React。
- `ui/Composer.tsx`：新增可选 `runRow?: RunRowProps | null`。渲染规则：
  - `running && runRow`：在 `PromptInput` **之前**渲染上移行（`Box ref={runRow.rowRef}`，`flexDirection="row"`，高 1）；输入框下方的提示行**不渲染**；
  - `running && !runRow`（Composer 被单独使用的单测）：保持现状，提示行仍在输入框下方——向后兼容；
  - `!running`：完全不变。
  - `hintText()`、`hintTextForTest` 的**输出**不改：把运行态分支抽成 `runningHintClauses(opts): string[]`，`hintText` 的 running 分支返回它的 `join(dot)`，
    上移行直接消费同一个子句数组，保证与 AC-43 同一来源（评审 RV-2：`planRunRow` 需要按子句丢弃，不能拿 join 后的整串截断）。
  - 只有 `runRowEnabled`（§3.3.1）为真时 `App` 才传 `runRow`，所以 `Composer` 内无需再判 `showHint`/`hintsEnabled`；上移行恒含子句。

#### 3.3.5 可见性与「固定底行回退」状态机

输入区滚出视口后，原先“活动行常驻底部”提供的**生命信号**会随之消失；单动画规格的原话是「绝不拿一个重复去换一个缺席」。因此：

| 状态 | 上移行（footer 内） | 固定底行 `BottomStatusRow` |
| --- | --- | --- |
| 运行中且上移行在视口内 | 渲染，图标动画（`spinnerLive=true`） | 只显示 toast/空白预算行；**无** `ActivityLine`、**无** toast 旁小图标 |
| 运行中且上移行已滚出视口 | 仍占位（高 1），图标改静态（`spinnerLive=false`，不跑定时器） | `ActivityLine` 接管（即今天的样子）；toast 旁小图标逻辑沿用 |
| 覆盖层打开 / 终端过小 | 聊天分支 `display=none`；`spinnerLive=false` | 无生命信号（沿用 `activityVisible = running && !overlayNode`） |
| 闲置 | 无 | 同今天 |

可见性由 `ScrollViewport` 测得：行高恒为 1，所以“完全可见”与“部分可见”等价于“可见/不可见”，**不存在行被切一半**。
实现上把现有 `composerVisible(composer, clip)` 泛化为 `elementVisible(el, clip)`（el 为空返回 `true`，沿用 Yoga 祖先 `getComputedTop` 求和、计入负 `marginTop`；
保留 `composerVisible` 作为 `elementVisible` 的别名以免既有 import 断裂，评审 RV-8），
**因 `el` 为空返回 `true`，上移行未挂载时 `activityRowVisible` 恒为 `true`——所以任何消费它的判据必须先与「上移行已启用」做与运算**（评审 RV-3，见 §3.3.6 第 5 项），
新增 props `activityRef`、`onActivityVisibilityChange`；在同一个布局 effect 里与 `onComposerVisibilityChange` 同法发布，仅布尔值变化时回调。

边界：滚动一帧内测量→`setState`→重渲染存在最多一个输出周期（≤32 ms）的滞后，期间可能出现“零个或两个静态/动态图标各一帧”。
这是可接受的瞬态：census 与 `single-spinner` 断言的是稳态帧；回退不依赖同步，且状态只在两个布尔量上，不会振荡
（上移行位置只由偏移决定，而 dock 的出现不改变 footer 高度）。

#### 3.3.6 `App.tsx` 接线（唯一的装配点）

1. 新增 `activityRef = useRef<DOMElement>(null)` 与 `const [activityRowVisible, setActivityRowVisible] = useState(true)`。
2. 仅此一处构造 `const runActivity: RunActivity = { startedAt: runStartedAt.current, elapsedMs, reducedMotion, runningTool, compacting: state.compaction?.inFlight === true }`
   —— 原始 `reducedMotion` 配置标志的唯一落点（D-5：`ActivityLine` 读它两次，不能拿被拓宽的值）。
3. `const runRowEnabled = running && rows >= HINT_MIN_ROWS && cfg.hints;`（§3.3.1），`Composer` 传
   `runRow={runRowEnabled ? { activity: runActivity, live: activityRowVisible && !overlayNode, rowRef: activityRef } : null}`。
   用 `running` 而非 `activityVisible`，避免打开覆盖层时 `Composer` 在两种布局间来回切换。
4. `ScrollViewport` 传 `activityRef`、`onActivityVisibilityChange={setActivityRowVisible}`。
5. `const runRowShown = runRowEnabled && activityRowVisible;`，`BottomStatusRow.activity` 改为 `activityVisible && !runRowShown ? <ActivityLine {...runActivity} theme caps /> : null`；
   未启用上移行（矮终端 / `--no-hints`）时 `runRowShown` 恒为假 ⇒ 与今天逐字相同；
   `activityGlyph` 照旧无条件传（组件只在 `activity` 非空时读取）。
6. **更新提示在运行期必须继续静默**：`update` 的挂载条件由 `updateSnapshot && !overlayNode && shouldRenderUpdateLine(...)`
   改为再加 `&& !running`。原先靠「活动行优先于更新行」的行内优先级保证这一点；活动行搬走后该保证消失，若不显式加条件，
   用户在工作时会看到更新通知，违反 `cli-auto-update` D-2。`BottomStatusRow` 组件本身的优先级（toast > activity > update > 空白）**不改**，
   `update-bottom-row.test.tsx` 的组件级用例保持绿。
7. `composerBaseRows` 表达式**不改**（§3.3.2：启用条件与闲置态提示行相同，footer 高度恒定）。
8. `StatusBar` 不改：它仍显示 `Esc x2 interrupt | Ctrl+C stop N | PgDn down`。输入区在视口内时 `esc×2 interrupt` 会在两处出现；
   这是刻意保留的冗余——输入区滚走后紧急操作必须仍然可见（前序规格 R09 / §3.6），去重要引入基于滚动位置的显隐，得不偿失。

#### 3.3.7 与既有测试/不变量的接触点（实施时必须同步，不得削弱）

- `spinner-census.test.ts` AC-11：断言 `reducedMotion={reducedMotion}` 恰好一次、`activity={ activityVisible ? (` 的模式。装配变化后，
  前者改为断言「`const runActivity` 对象字面量里恰有一个原始 `reducedMotion`，且 App 其它位置没有把它交给除 `ActivityLine`/`Composer.runRow` 外的组件」，
  后者改为 `activity={ activityVisible && !runRowShown ? (`；`const activityVisible = running && !overlayNode;` 与
  `const viewReducedMotion = reducedMotion || activityVisible;` 两行**逐字保留**，`reducedMotion={viewReducedMotion}` 仍恰 3 次。意图不变，只是承认第二个挂载点。
- AC-9（`ink-spinner` 的 importer 都接收 `reducedMotion`）不变：`Composer` 只 import `ActivityLabel`，不 import `ink-spinner`。
- `bottom-status-row.test.tsx`「运行中不丢行」与 `viewportRows` 同值断言不变（`budget.ts` **整个文件不改**）。
- `app.test.tsx`、`single-spinner.test.tsx`、`interrupt-ladder.test.tsx` 中若有按「活动行在最底部」定位的断言，改为「在输入框上方一行」，并保留“全帧恰一个盲文动画”。

### 3.4 备选方案与拒绝理由

| 方案 | 为什么不选 |
| --- | --- |
| 给滚动条让出右侧一列空白（`edgeInset`），绕开末列 | 治标：改变所有行宽、`trackCol`、帧观察器与命中几何，且用户明确要“最右侧”。保留为 §8 R1 的**条件性后备**：仅当 M-1 在 `--no-diff-render` 下仍看不到末列时启用 |
| 全程关闭差分器或改用整屏重绘 | 会重引入 `tui-input-flicker-fix` 修掉的闪烁，代价远大于收益 |
| 在行尾改发 `ECH`/先 `CSI K` 再画内容 | 先擦后画违反 I-4（行有一瞬空白）；`ECH` 同样受待换行状态影响，不如直接省略无意义的 EL |
| 把活动行留在固定底行，只往里加 `steer` | 底行在输入框**下方**且不随滚动，同时违反“上方”和“随输入区一起拖动”两条要求 |
| 上移行与提示行并存（输入框上下各一行） | footer 多一行，开始/结束运行时画面跳动；且 `steer` 重复出现 |
| 在 `StatusBar` 里隐藏与上移行重复的子句 | 需要把滚动可见性接进 `StatusBar`，且输入区滚走瞬间会短暂缺失紧急提示 |
| 上移行不做滚出回退（运行中滚走就没有动画） | 与 `single-spinner-while-running` 的「不要缺席」原则冲突，长任务中用户看历史时无法判断是否卡死 |

## 4. 文件/模块变更计划

路径相对 `packages/cli/src/`。**本节点只新增 `docs/plans/tui-scrollbar-edge-and-run-row/spec.md`**，下表全部是实施节点的工作。

| 文件 | 操作 | 意图 |
| --- | --- | --- |
| `ui/frame-differ.ts` | 修改 | 新增 `cols?` 选项与 `paintLine`；写满末列的行不发 `CSI K`；更新 I-4 注释 |
| `cli.tsx` | 修改 | 差分器传入 `cols: () => process.stdout.columns`；`/perf` 数据接线（净增 ≤ 10 行） |
| `commands/perf.ts` | 修改 | `PerfSnapshot.scrollbar?` 与一行输出 |
| `ui/run-status-row.ts` | 新增 | `RunActivity`、`planRunRow`（纯函数、无 React、按子句分配） |
| `ui/ActivityLine.tsx` | 修改 | 导出 `resolveActivityLabel`/`ActivityLabel`，`spinnerLive` 可选属性；`ActivityLine` 输出不变 |
| `ui/ModeChip.tsx` | 修改 | 导出 `modeChipCols` |
| `ui/Composer.tsx` | 修改 | `runRow` 属性；运行态上移行；提示行互斥渲染；抽出 `runningHintClauses()`（`hintText` 输出不变） |
| `ui/layout/ScrollViewport.tsx` | 修改 | `elementVisible` 泛化（保留 `composerVisible` 别名）；`activityRef`/`onActivityVisibilityChange` |
| `ui/App.tsx` | 修改 | 装配（§3.3.6），净增 ≤ 40 行；`ui/layout/budget.ts` **不改** |
| `ui/overlays/HelpOverlay.tsx` | 修改 | 核对并补一行：右缘滚动条拖动、运行行位置（英文） |
| `.claude-index/config.md` | 修改 | 追加「本功能历史文件例外」：`App.tsx` 基线 2582 行（`c3445fce7`）、`cli.tsx` 2016 行，净增上限 40/10 行，理由=仅装配 |
| `README.md`（`packages/cli`）、`CHANGELOG.md` | 修改 | 说明滚动条在差分渲染下的末列修复、运行状态行位置；清除与新布局矛盾的旧叙述 |
| `__tests__/helpers/vt-screen.ts` | 新增 | 最小 VT 屏幕模型（两种待换行语义） |
| `__tests__/frame-differ-last-column.test.ts` | 新增 | §3.1.4 的终端模型回归，含「修复前必红」基线 |
| `__tests__/frame-differ.test.ts` | 修改 | `cols` 缺省保持旧行为；`cols` 给定时的字节级断言 |
| `__tests__/run-status-row.test.ts` | 新增 | `planRunRow` 梯度表、非法输入、中文宽度 |
| `__tests__/composer-run-row.test.tsx` | 新增 | 上移行/提示行互斥、行数恒定、向后兼容、`runningHintClauses` join 等于 `hintText` |
| `__tests__/activity-line.test.tsx` | 修改 | `spinnerLive=false`、`resolveActivityLabel` 三档、`ActivityLine` 输出不变 |
| `__tests__/unified-scroll-layout.test.tsx` | 修改 | 真实 Ink：上移行位置、随输入框滚出、dock 回退、动画恰一个 |
| `__tests__/spinner-census.test.ts`、`single-spinner.test.tsx`、`update-bottom-row.test.tsx` | 修改 | §3.3.7 的同步；新增 App 级「运行期无更新提示」用例 |
| `__tests__/budget.test.ts` | 不改 | 作为「`budget.ts` 未被触碰」的回归哨兵照常运行 |
| `__tests__/perf-command.test.ts` | 修改 | `scrollbar` 行格式 |

## 5. 接口设计

无 REST/WebSocket/CLI 参数/配置项/公共 Core 导出变化。以下为 `packages/cli` 内部 TypeScript 契约（导入后缀 `.js`；公共形状优先 `interface`）。

```ts
// ui/frame-differ.ts
export interface FrameDifferOptions {
  /* 既有字段不变 */
  /** 现读终端列数；缺省/非有限 => 每个变化行都发 CSI K（旧行为）。 */
  cols?: () => number | undefined;
}

// ui/run-status-row.ts
export interface RunActivity {
  startedAt: number;
  elapsedMs: number;
  reducedMotion: boolean;          // 原始配置标志，不是被拓宽的值
  runningTool?: string;
  compacting?: boolean;
}
export interface RunRowPlanInput {
  cols: number;
  labelCols: number;               // SPINNER + 标签显示宽度（natural）
  hintClauseCols: readonly number[]; // 各提示子句的显示宽度，按紧急程度排序
  separatorCols: number;
  chipCols: number;                // 0 = 无 chip
}
export interface RunRowPlan {
  labelCols: number;               // 标签允许占用的列数（可能小于 natural => 省略号截断）
  hintClauses: number;             // 显示前几个子句；0 = 不显示提示（防御档）
  chip: boolean;
}
export function planRunRow(input: RunRowPlanInput): RunRowPlan;

// ui/ActivityLine.tsx
export function resolveActivityLabel(activity: RunActivity, glyphs: ReturnType<typeof pickGlyphs>): string;
export interface ActivityLabelProps extends RunActivity { spinnerLive?: boolean; theme: Theme; caps: TermCapabilities }
// ActivityLineProps = ActivityLabelProps 的既有形状（向后兼容，字段名不变）

// ui/Composer.tsx
export function runningHintClauses(opts: { glyphs: ReturnType<typeof pickGlyphs>; services: number }): string[];
// hintText({ running: true, ... }) === runningHintClauses(...).join(` ${glyphs.midDot} `)  —— AC-43 逐字不变
export interface RunRowProps {
  activity: RunActivity;
  live: boolean;                     // 上移行在视口内且无覆盖层
  rowRef?: React.RefObject<DOMElement>;
}
// ComposerProps 新增： runRow?: RunRowProps | null

// ui/layout/ScrollViewport.tsx（ScrollViewportProps 新增）
activityRef?: React.RefObject<DOMElement>;
onActivityVisibilityChange?: (visible: boolean) => void;

// ui/layout/budget.ts —— 不改（评审 RV-3：无 composerBaseRowCount）

// commands/perf.ts
export interface PerfSnapshot { /* 既有 */ scrollbar?: { trackCol: number; trackRows: number; mouseOn: boolean;
  frameReady: boolean; thumb: { start: number; size: number } | null; unicode: boolean; edgeEl: 'skipped' | 'always' | 'n/a' } }
```

产品字符串（英文、ASCII 优先）：上移行沿用 `ActivityLine` 既有标签与 `hintText` 既有子句，无新增文案；`/perf` 的 `scrollbar:` 行与等待原因为新增英文诊断文本。

## 6. 数据模型与状态

无数据库、配置或会话 schema 变更。新增内存状态仅两项，均在渲染进程 TUI 生命周期内：

| 状态 | 所有者 | 语义 |
| --- | --- | --- |
| `activityRowVisible: boolean` | `App`（`useState`，默认 `true`） | 上移行当前是否在视口内；仅由 `ScrollViewport` 回调写入，不反馈成第二份偏移 |
| `lastActivityVisible` ref | `ScrollViewport` | 仅用于“值变化才回调”，与既有 `lastVisible` 同构 |

不变量：

1. 偏移唯一所有者仍是 `ScrollViewport`；`activityRowVisible` 只影响“谁画生命信号”，不影响滚动。
2. 稳态全帧至多一个 `<Spinner>` 在跑：上移行 `live` 与固定底行 `ActivityLine` 互斥，由同一个布尔量 `runRowShown = runRowEnabled && activityRowVisible` 派生，不存在“两处各自判断”；
   `activityRowVisible` 在上移行未挂载时恒为 `true`，**不得单独作为判据**。
3. **任何配置下**运行开始/结束 footer 高度都不变：`runRowEnabled` 与闲置态提示行同一启用条件、两行互斥；未启用时不渲染任何新行。
4. 差分器：凡 `cols` 已知且行宽 ≥ `cols` 的行，输出里不得出现紧随该行内容的 `CSI K`。
5. `hintText()` 的输出逐字不变，上移行与 `Composer` 提示行取自同一个子句数组 `runningHintClauses()`。
6a. 上移行启用时，`steer` 与 `interrupt` 两个子句整句可见（窄屏只允许标签被截断）。
6. 更新提示在 `running` 为真时永不挂载。

## 7. 测试与验收标准

### 7.1 自动化（实施节点必须新增/更新并全绿）

| 编号 | 场景 | 必须观察到 |
| --- | --- | --- |
| T1 | `vt-screen` 的 `'at-last-column'` 模型：整屏重绘 → 5 次不同的增量重绘（文字行变化 + 滑块移动），修复前代码 | **红**：视口行末列被擦成空格（记入实施偏差，证明测试有牙） |
| T2 | 同上，修复后，两种模型 | 所有视口行末列始终是 `│`/`█`；Header/Toast/Status 行内容正确；批尾光标仍在第 `H+1` 行 |
| T3 | 差分器 `cols` 缺省 | 每个变化行仍以 `CSI K` 结尾（既有 `frame-differ.test.ts` 断言不改） |
| T4 | 行宽 = `cols`、`cols-1`、`cols+1`（溢出行），并含 CJK 宽字符（字符数 < 列数但显示宽度恰满） | `cols` 与 `cols+1` 无 EL；`cols-1` 有 EL；宽字符按显示宽度而非字符数判定 |
| T5 | 选择高亮 `repaint()` 与 `diffRepaint` | 两条路径对满宽行同样不发 EL（防止选择动作擦掉滚动条） |
| T6 | `planRunRow`：§3.3.3 表的六行（含 4 子句的后台服务行）、含/不含 chip、`inner=0`、NaN、`n<2`、`inner` 恰为 37/38 的边界 | 与 §3.3.3 表一致；**档 2 内 `hintClauses >= 2` 恒成立（`steer`/`interrupt` 整句保留）**；任一输入不抛、不返回负数；`labelCols + sep + H(k) <= inner` 恒成立 |
| T7 | `Composer` `running && runRow` | 上移行在输入框上方恰一行；输入框下方无提示行；总行数与同条件闲置态相同；行文 = 标签 + `runningHintClauses` 的 join（与 `hintText` 同源）；38 列下 `esc×2 interrupt` 整句可见、不出现 `inter…` |
| T8 | `Composer` `running && !runRow`、`!running` | 与改动前逐字相同（向后兼容） |
| T9 | App 级：`rows<20` 或 `cfg.hints=false` 且运行 | **不启用上移行**（`runRowEnabled=false`）：`Composer` 不收到 `runRow`、活动行仍在固定底行（与今天逐字相同）；开始/结束运行 footer 高度不变；`runRowShown` 恒假，dock 不因 `elementVisible(null)=true` 被误压制 |
| T10 | 真实 Ink（`createTerminalHarness`）：滚动文档含上移行，偏移 0 | 上移行紧贴输入框上沿；全帧盲文计数 = 1；`spinnerLive=true` |
| T11 | 同上，`scrollUp` 直到上移行离开视口 | 视口内无上移行；固定底行出现 `ActivityLine`（盲文计数仍 = 1）；回到底部后底行无 `ActivityLine` |
| T12 | 滚动过程中逐行扫描 | 任一稳态帧盲文计数恒为 1；上移行不会出现“被切一半” |
| T13 | App 级：`running` 且有可用更新 | 底行不显示更新提示；运行结束后显示 |
| T14 | toast 与运行并存（上移行可见 / 不可见两种） | 可见时 toast 旁无小图标、不丢字；不可见时 toast 旁小图标沿用 |
| T15 | `ActivityLine` 回归 | 既有四档标签与 `spinnerLive` 缺省输出逐字不变；`spinnerLive=false` 无 `Spinner` |
| T16 | `/perf` | 输出含 `scrollbar:` 行；`mouse=off` 或 `frameReady=no` 的原因文本存在 |
| T17 | 回归套件 | 前序规格 T01–T17 / A01–A15、`spinner-census`、`bottom-status-row`、`update-bottom-row`、`interrupt-ladder` AC-43 全绿；`npm run typecheck`、`npm test`、`npm run build` 通过 |

规模约束：新增函数 ≤ 60 行、参数 ≤ 5、圈复杂度 ≤ 10、行宽 ≤ 100；`App.tsx`/`cli.tsx` 净增不超过 §4 记录的额度，超出则把装配抽成独立模块而不是放宽规范。

### 7.2 Windows 真终端手测（人工发布门禁，实施节点不可替代、也不得宣称已通过）

**归属（评审 RV-1）**：实施节点是无头自动化环境，没有 Windows 真终端。它的职责是**交付可执行的手测脚本与待办清单**（把本表落成 `docs/plans/tui-scrollbar-edge-and-run-row/manual-test.md`，
每条含步骤、预期、结果栏），并在「实施偏差」里把所有 M 项登记为「待人工执行」；**绝不能**把 M 项标成通过。M 项结果由人工回填。

在**同一台机器**依次覆盖：Windows PowerShell 5.1（conhost 窗口）、PowerShell 7（Windows Terminal）、VS Code 集成终端，各取 120×30 与 40×12
（40×12 低于 `HINT_MIN_ROWS`，上移行不启用，应观察到旧的固定底行形态、footer 无变化）；并至少一次中文区域设置。每条结果记入 manual-test.md（通过/失败/现象）。

| 编号 | 步骤 | 通过标准 |
| --- | --- | --- |
| M-1 | 默认差分渲染，发一条会流式输出 200 行的任务，期间与结束后观察最右列 | 轨道与滑块全程可见，不出现整列消失或逐行闪断 |
| M-2 | `aragon --no-diff-render` 重复 M-1 | 若 M-1 失败而 M-2 通过 ⇒ 差分器即根因，T2 的 `'at-last-column'` 模型成立；若两者都失败 ⇒ 启用 §8 R1 后备并回报 |
| M-3 | 在滑块上按下→上下拖→松开；点轨道上/下方；拖动中按住 Shift | 滑块跟手、松手不跳；点击翻一页；拖动不被文字选择抢走 |
| M-4 | 历史足够长时拖到顶部，再看底部输入框 | 输入框随消息逐行滚出，历史可占满视口；按任意字符编辑后回到底部且字符不丢 |
| M-5 | 提交一条长任务 | 输入框**上方**一行：动画图标 + 阶段短语在最前，其后 `steer · interrupt · exit`；输入框下方无提示行；提交瞬间画面不跳行 |
| M-6 | 运行中把历史拖到输入框滚出视口 | 固定底行出现动画与短语；回底后底行恢复空白；任一时刻画面里只有一个旋转图标 |
| M-7 | 40×24（`rows >= 20` 才启用上移行）+ 有 TODO 侧栏 + plan 模式运行 | 行内按 §3.3.3 退化：标签先省略、`exit` 整句先丢、`steer`/`interrupt` 整句可见，无换行、无抖动 |
| M-8 | 中文区域设置下观察 `│`/`█` 与最右列 | 末列单元宽 1 且不换行；否则回报并走 §8 R2 |
| M-9 | 运行期间有 npm 更新可用 | 运行期不见更新提示；结束后才出现 |
| M-10 | 窗口 resize、`/mouse off`、`--no-mouse`、`--no-mouse-select` | 条始终可见；`/mouse off` 后不可拖但仍可见；`--no-mouse-select` 仍可拖；`/perf` 的 `scrollbar:` 行与现象一致 |

### 7.3 需求验收映射

| 需求 | 判定 |
| --- | --- |
| ① PowerShell 可见 | 自动化：T1/T2（终端模型）；人工：M-1/M-2/M-8 |
| ② 输入区随拖动一起滚 | T10–T12 + M-4（既有 A02 保持绿） |
| ③ 右缘拖滑块 | 自动化：既有 `scrollbar-controller` 套件；人工：M-3 |
| ④ 流畅稳健 | T17 回归 + M-10；拖动期间 `render-budget` 虚拟化上限不退化 |
| ⑤ 运行图标与提示同行、最前、输入区上方 | 自动化：T7/T10；人工：M-5/M-6 |

## 8. 风险与缓解

| 编号 | 风险 | 缓解 / 触发条件 |
| --- | --- | --- |
| R1 | §3.1 的终端侧擦除行为是已知认识而非本机实测；修复后若 M-2 显示 `--no-diff-render` 仍看不到末列，说明宿主在末列另有问题 | 先完成 M-1/M-2 再下结论。后备（仅此时启用，作为单独提交）：增加 `edgeInset`（默认 0，环境变量覆盖，上限 2），让 `AppShell` 宽度、`trackCol`、帧观察器的列匹配统一减去 inset；此时“最右侧”变为“最右侧向内一列”，需向用户说明 |
| R2 | 中文区域下 `│`（U+2502）、`█`（U+2588）属东亚歧义宽度，个别控制台字体渲染为 2 列，滚动条会把末列顶出或换行 | M-8 实测；确认受影响的宿主经显式 env `AGENT_ASCII_SCROLLBAR=1` 改用 ASCII 轨道（复用 `pickGlyphs` 的 ASCII 层），不新增字形常量，不做自动探测（无可靠探测手段，评审 RV-6）；判定逻辑独立成小函数并加单测 |
| R3 | `elementVisible` 依赖 Yoga 内部 `getComputedTop`，上移行位置判断错误会导致 dock 与上移行同时/都不显示 | 行高恒为 1、与 `composerVisible` 同法同源；T11/T12 在真实 Ink 布局下逐行扫描滚动位置；失败表现为“多/少一个静态图标”，不影响滚动与输入 |
| R4 | 一帧测量滞后可能出现一次性双/零图标 | 已在 §3.3.5 说明；断言只针对稳态帧，不要把它写成逐帧不变量 |
| R5 | （v1 风险，已消除）`--no-hints`/矮终端下运行起止 footer 增减一行 | 评审 RV-3：上移行与闲置提示行同一启用条件，未启用配置保持旧固定底行形态，任何配置 footer 高度恒定；由 T9 钉死 |
| R6 | `spinner-census` 是文本扫描，装配改动后容易“为过测试而削弱断言” | §3.3.7 规定意图不变、两条 `const` 行逐字保留、`reducedMotion={viewReducedMotion}` 仍恰 3 次；评审时对比断言强度 |
| R7 | `App.tsx` 已超千行，继续堆接线会放大回归面 | 装配只放在 §3.3.6 的 8 项里（`runRowEnabled`/`runRowShown` 两个局部常量 + 既有 props），逻辑全部落在新纯函数与组件；`config.md` 登记限额，超额即抽模块 |
| R8 | 差分器改动影响所有帧输出 | `cols` 缺省即旧行为；T3/T5 与既有 `frame-differ` 套件、`frame-differ-ink-shape` 升级哨兵共同兜底；回退只需去掉 `cli.tsx` 里那一行 `cols` |

回退路径：WP-S 以删除 `cols` 接线单行回退；WP-R 以令 `runRowEnabled` 恒为 `false`（此时 `Composer` 不收 `runRow`、`runRowShown` 恒假，即旧布局）一处回退，
`BottomStatusRow.activity` 的 `!runRowShown` 在该状态下与 `activityVisible ? … : null` 等价；WP-O 为只读诊断，可独立删除。三者互相独立，可分开提交与回滚。

## 9. 实施顺序与完成定义

1. 先写 T1（`vt-screen` + 修复前必红）与 T6/T7 的失败用例，记录基线；在 `.claude-index/config.md` 登记历史文件例外。
2. WP-S：`paintLine` + `cols` 选项 + 接线 + 注释；T2–T5 转绿。
3. WP-R 纯逻辑：`planRunRow`（按子句）、`runningHintClauses`、`ActivityLabel` 拆分；T6、T8、T15 转绿。
4. WP-R 组件与装配：`Composer.runRow`、`ScrollViewport` 可见性、`App` 装配（`runRowEnabled`/`runRowShown`）、`update` 门控；同步 §3.3.7 的既有测试；T7、T9–T14 转绿。
5. WP-O：`/perf` 行；T16。
6. 文档与帮助：README、CHANGELOG、`HelpOverlay`；运行 `npm run typecheck`、`npm test`、`npm run build`。
7. 产出 `manual-test.md`（§7.2），并在本文件追加「实施偏差」小节：登记先红后绿的 T1 证据、所有与本规格的偏差，以及「M-1…M-10 待人工执行」。

**完成定义分两道门（评审 RV-1）：**

- **自动化门禁（实施节点必须全部满足）**：§7.1 的 T1–T17 全部通过；`npm run typecheck`、`npm test`、`npm run build` 通过；`manual-test.md` 已交付；
  `git status` 只含相关文件（遵循仓库的精确提交规则）；交付说明里**明确写出**「需求①的真终端验证尚未执行」。
- **人工发布门禁（不属于实施节点，发布前由人完成）**：§7.2 的 M-1、M-3、M-5、M-6 在 PowerShell 5.1 与 PowerShell 7 上通过；失败项按 §8 处理，
  不得以「自动化全绿」宣称需求①已完成。

## 评审结论

**有条件通过（approved with conditions）。** 设计方向正确且已对照源码核实：右缘滚动条与输入区统一滚动在 `8ab504999` 已落地；
差分器在写满末列的行后追加 `CSI K` 是确定的代码级缺陷，修复规则简单、可回退、且被终端模型测试钉死；运行状态行上移的行预算、
单动画不变量、更新提示静默三条既有约束都被显式保留。三个 P1（DoD 不可达、窄屏词中截断紧急操作、矮终端/`--no-hints` 净增一行）已在 v2 正文修复，**无未解决的 P0/P1**。

通过的条件（实施与发布阶段必须满足，均不改变设计）：

1. **终端侧擦除行为仍是「已知认识」而非本机实测**（R1）。实施节点只能证明「差分器不再对满宽行发 `CSI K`」与「终端模型下末列保留」；
   「PowerShell 里滚动条可见」必须由人工按 `manual-test.md` 的 M-1/M-2/M-8 确认。M-2 若 `--no-diff-render` 仍不可见，启用 R1 后备（`edgeInset`，单独提交）。
2. 实施节点**不得**把任何 M 项标为通过；交付说明必须写明真终端验证待人工执行。
3. T1「修复前必红」必须真的先红后绿并记入「实施偏差」；`spinner-census` 的断言改写必须保持意图（两条 `const` 行逐字保留、`reducedMotion={viewReducedMotion}` 仍恰 3 次），评审时对比断言强度。
4. 实施时若发现 §3.3.3 的子句分配与 `Composer` 现有 `hintText` 的服务子句顺序（`steer, interrupt, stop N, exit`）不一致，以 `hintText` 为准并回填本文件，不得改动 `hintText` 的输出。

## 实施过程发现的方案缺陷

实施节点（2026-10-06）逐项落地 §4 文件表后的记录。结论：方案方向无误，未偏离设计意图；下列条目是文档与现实的小差异、
测试前提的变化，以及**刻意未实现**的条件性后备。

### 一、T1「先红后绿」证据（评审结论条件 3）

- **修复前**：`frame-differ-last-column.test.ts` 在 `'at-last-column'` 终端模型下**红**：
  `step 1 row 1: expected ' ' to match /[│█]/`（增量重绘后视口行末列被 `CSI K` 擦成空格）。
  同一用例对 `'virtual-column'` 模型本来就绿，与 §3.1.2 的「只在部分终端出现」一致。
- **修复后**：两种模型全绿；另有一条「不带 `cols` 时旧行为仍会擦掉末列」的基线用例常驻，证明上面两条能红。
- 为让测试能在修复前运行，测试向差分器传入尚不存在的 `cols` 选项（修复前被忽略）——这是红的来源，不是测试缺陷。

### 二、与规格的偏差与勘误

1. **§3.3.3 表中 4 子句行的 `H(4)` 算术有误**：规格写 `H(4) = 59`、`14 + 3 + 59 = 76`；
   按其自身给出的子句宽度（7 / 15 / 13 / 13，分隔符 3）应为 `H(4) = 57`、`14 + 3 + 57 = 74`。
   结论不变（全部显示；`74 + 2 + 7 > 78` 故 chip 被丢弃）。`run-status-row.test.ts` 以真实宽度断言。
2. **`composerVisible` 别名未保留**：该函数从未导出、仓内无任何 import，§3.3.5 / RV-8 担心的「既有 import 断裂」不存在，
   保留别名只是死代码。已直接重命名为 `elementVisible`。
3. **`planRunRow` 第二档从 `k = n - 1` 起**，按 §3.3.3 字面实现：标签宽度够用时先丢 `exit` 整句，而不是先把标签压到 10 列
   再保留 `exit`。这是规格的取舍，未改动；记录于此，若人工手测（M-7）觉得标签被压得太窄，再回头调。
4. **T14 的「上移行不可见」半边未在 App 级自动化**：在 App 里滚走后再触发 toast 需要键盘输入，而任何经 `Composer` 的按键都会
   `returnToComposer` 把视口拉回底部，使场景自毁。该半边由两处覆盖：`BottomStatusRow` 既有组件用例（未改）与
   `single-spinner` AC-12 / AC-13（改在 `hints: false` 即「上移行未启用、固定底行承载生命信号」的配置下跑，行为与改动前逐字相同）。
   「上移行可见」半边是新增的 `AC-12b` 与 `app.test.tsx` 的 T14。
5. **T9 的「footer 高度恒定」不能用「最后一条转写行的行号」判定**：本仓 `agent_end` 之后转写区本身会多出两行（与本特性无关，
   `hints:false` 的旧布局下同样发生）。改为比较「输入框上边框所在行」：启用时 `上移行行号 === 闲置态 ╭ 行号` 且整帧行数相等；
   未启用时 `╭` 行号运行 / 闲置一致。
6. **T10–T12 用「App 装配的缩影」而非整个 `App`**：`unified-scroll-layout.test.tsx` 里的 `Frame` 用真实 Ink / Yoga 复刻
   `activityRef` + 共享可见布尔 + 固定底行的接线；整 `App` 的同类断言在 `app.test.tsx` 的 T9a。
7. **`spinner-census` AC-11 的断言改写**（意图不变，强度不降）：原先两条文本断言改为
   ① `runActivity` 对象字面量里恰有一个 `reducedMotion`，且 `reducedMotion={reducedMotion}` 在 `App.tsx` 里**零次**出现、
   `{...runActivity}` 与 `activity: runActivity` 各恰一次；② `activity={ activityVisible && !runRowShown ? (` 与
   `const runRowShown = runRowEnabled && activityRowVisible;` 各恰一次。`const activityVisible…` / `const viewReducedMotion…`
   两行逐字保留，`reducedMotion={viewReducedMotion}` 仍恰 3 次，AC-9（`ink-spinner` 的 importer 清单）未动。
8. **`/perf` 的 `scrollbar` 以对象字面量里的 getter 提供**（`perfRef.current` 每次渲染重建，但 `frameReady` / `geometry`
   在渲染之外变化，快照式取值会过期）。等待原因行里的尺寸取 `trackCol x (trackRows + 4)`，即 `ScrollViewport` 里
   `rows = viewport + 4` 的反推。

### 三、刻意未实现（条件性后备）

- **§8 R1 `edgeInset`**：仅当 M-2 证明 `--no-diff-render` 下末列仍不可见才启用，需人工手测结论，本轮不做。
- **§8 R2 `AGENT_ASCII_SCROLLBAR=1`**：仅当 M-8 实测确认东亚歧义宽度字符占 2 列才做，本轮不做。
- 两者都不影响本轮的自动化门禁，也都未被任何代码引用。

### 四、人工发布门禁

**M-1 … M-10 全部「待人工执行」**，脚本已落在 `docs/plans/tui-scrollbar-edge-and-run-row/manual-test.md`。
需求①（PowerShell 里右侧拖动条可见）的真终端验证**尚未执行**；本节点只能证明差分器不再对写满末列的行发 `CSI K`，
以及在两种终端模型里末列保留。不得以「自动化全绿」宣称需求①已完成。

### 五、验证记录

`npm run typecheck`（两份 tsconfig）通过；`npm run build` 通过，`node dist/cli.js --version` 输出 `0.6.8`；
`npm test`：210 个文件、3090 通过 / 6 跳过 / 0 失败。`budget.test.ts` 与 `budget.ts` 未被触碰；
`App.tsx` 净增 36 行（上限 40）、`cli.tsx` 净增 3 行（上限 10），已在 `.claude-index/config.md` 登记。
