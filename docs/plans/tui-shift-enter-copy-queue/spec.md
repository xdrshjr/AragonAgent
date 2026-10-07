# TUI 换行输入、选区复制与排队反馈设计规格

> 版本：v2（设计评审修订版）；日期：2026-10-06；阶段：设计（本节点只产出设计文档，不含实现）。
> v1 → v2：设计评审修复 1 项 P0、3 项 P1，并就地修正评审发现的全部 P2 事实性偏差
> （明细见下方"评审记录"）；三个子特性的架构、边界与"明确不做"清单未变。
> 需求来源：主任务描述 —— ① 支持 Shift+Enter 在输入框内换行；② 选中文本后按 Ctrl+C 复制，
> 取消"选中即复制"；③ Agent 运行期间用户发送的消息在执行界面上持续显示
> `Queue: <用户消息>` 提示，直到该消息被 Agent 接受处理后才消失。

## 评审记录（v2）

评审对象：v1 全文。方法：逐节对照代码库核实 —— Ink 5.2 实装源码
（`parse-keypress.js` / `use-input.js`）逐行核验并以 Node 实测各序列的解析输出；
`input/`、`ui/`（含 `selection/`、`overlays/`、`entries/`）、`agent/`、
`core/src/engine/`、`commands/`、既有测试与两份 README 逐点比对。评估维度：
可行性 / 完备性 / 一致性 / 规模适度。

v1 的关键技术论断绝大多数**属实**（经实装源码与实测确认）：Ink 对整块 chunk 单次
`parseKeypress`、`\r` 恒 `shift:false`、`\x1b[13;2u` 因 `fnKeyRe` 不匹配而以
`'[13;2u'` 落入可打印分支、裸 `\n` 解析为 `name:'enter'`（不在
`nonAlphanumericKeys` 中，`input='\n'` 可送达组件）、`keep = max(...)` 家族前缀
保持、释放即复制、App 全局 useInput 的清选区首段与 Ctrl+C 阶梯行号、
`turn_start` 权威信号（循环顶 + 两处中途排空均回环）、`mapEntry`/`entryRevision`
先例、`EntryView` switch + `default → null`、glyphs 双表与静态扫描、
`packages/` 恰为 cli/core 两个 workspace —— 全部与代码一致。

发现的问题与处置（P0/P1 已全部修复进正文；P2 为事实性偏差，一并就地修正）：

| 编号 | 级别 | 位置 | 问题 | 处置 |
| --- | --- | --- | --- | --- |
| R1 | P0 | §3.5 | **Enter 帧污染 useInput 广播的其他消费者**。`useInput` 是广播（`use-input.js:89`），粘贴帧为此建立了 I-12 不变量（所有把 `input` 累积为文本的消费者必须 strip）；新帧 `'\u0000n'` 不被 `stripPasteFrames` 剥除，`SettingsScreen`（文本/密钥字段，`SettingsScreen.tsx:468-480`）、`QuestionOverlay`（答案草稿，`:162`）、`PlanReviewOverlay`（反馈文本，`:94`）会把 NUL 直接追加进字段 —— API key 被 NUL 污染后静默认证失败，正是 `SettingsScreen` 注释自述过的事故类别 | 已修复：`enter-frames.ts` 新增 `stripEnterFrames`，三个 overlay 接入（§3.5 / §6 / §7.2 / §9 / AC-9） |
| R2 | P1 | §4.2.4 ↔ §6 | **文档自相矛盾**：§4.2.4 要求从 selection 构造参数移除 `options.copy`，必然要删 `cli.tsx:818` 的 `copy:` 注入行，但 §6 把 `cli.tsx` 列入"不触碰"；照 §6 执行会因对象字面量多余属性直接 TS 编译失败 | 已修复：`cli.tsx` 移入 §6 变更表（仅删一行），"不触碰"清单同步改写 |
| R3 | P1 | §5.2.3 | **引用不存在的符号** `computeSettledCount`（全仓库无此函数）；真实机制是 Transcript 按条目位置推进的 MONOTONIC settled 边界 + `React.memo` 判等 + `entryRevision`。结论方向成立但依据错误，会误导实现者 | 已修复：改写为真实机制表述，结论保留 |
| R4 | P1 | §4.3 | **复制失败路径缺失**：`copyText` 可返回 `'none'`（OSC 52 超限且平台 helper 缺失）；样本代码中 `takeSelection` 已无条件消费选区，复制失败后用户既无选区、也未进入停服务/退出阶梯，行为未定义 | 已修复：§4.3 增加失败路径规定（沿用 `onCopied('none')` 既有失败提示并 `return`） |
| R5 | P2 | §2 | "README:436" 指代不明（根 README 无 Keybindings 表，该表在 `packages/cli/README.md:431-449`） | 已修正为 `packages/cli/README.md:436` |
| R6 | P2 | §3.4 | "在任何前缀上都不相交"措辞不准：三家族共享 `\x1b` / `\x1b[` 头部前缀，准确的性质是**完整序列互不嵌套**，共享前缀由 `keep = max(...)` 统一保持 | 已修正措辞 |
| R7 | P2 | §4.3 | 未说明 OSC 52 经 `writeForeign` 写终端会触发 differ `onInvalidate` → `setImmediate(() => controller.clear())`（`cli.tsx:696-699`）；设计的 take-先于-copy 顺序天然兼容，但顺序约束未写明，实现者调换顺序会引入"复制即闪灭"回归 | 已补充顺序约束及理由 |
| R8 | P2 | §5.2 | `/clear`、`/reset` 与 queued 条目的交互未定义（`/clear` 清屏但不清队列；`/reset` 两者全清）；fast reviewer 拆除路径 `clearAllQueues()` 的 D-21 守卫（`userSteerCount()===0`，绝不销毁用户消息）也未提及 | 已补充 §5.2 第 7 点 |
| R9 | P2 | §5.3 | "FastWiring 直调 controller.steer" 缺文件路径 | 已补 `fast/wiring.ts` / `fast/reviewer.ts:771` / `controller.ts:822` |
| R10 | P2 | §7.2 | 新增面签名清单缺 `ENTER_SEQUENCES`（§3.3 已定义）与 `mergeWithPasteRuns`（§3.5 已定义） | 已补齐（含 R1 的 `stripEnterFrames`） |
| R11 | P2 | §8 | "既有容错路径"表述含糊：实际是 `normalizeLoadedEntries` 对未知 kind 原样透传 + `EntryView` `default → null` 静默不渲染（不崩溃但不可见） | 已精确化 |

规模评估：**无过度设计、无欠设计** —— 换行复用 NUL 帧与 `keep = max` 既有机制而非
新造状态机（实测确认 NUL 帧经 Ink 解析后 `input='\u0000n'` 完整送达，且 `\x1b[13u`
会被 Ink 解析出 `ctrl+meta` 的怪形状，在过滤器层归一化确属必要）；排队条目复用
`appendEntry`/`mapEntry` 既有路径；复制复用 `copyText` 单一权威；"明确不做"两处
（不 push 键盘增强模式、不加 `copyOnSelect` 开关）判断正确。零 Core 改动经核属实
（`turn_start`、steering 队列跨运行存活、`clearAllQueues` 均为现成行为）。

---

**目标：** 让"多行输入、复制、运行中追加消息"这三个日常手势与用户在桌面应用中养成的
直觉一致：换行有专键、复制有确认键、排队的消息在界面上有持续、诚实、可消失的反馈。

**架构基线：** 全部改动收敛在 `@aragon-agent/cli` 包内，遵守现有分层 ——
`input/`（stdin 字节流层，纯函数）、`ui/`（React/Ink 渲染层）、`agent/`（视图状态归约层）、
`commands/`（斜杠命令）。不触碰 `packages/core/`（其公共 API 由 `public-api.test.ts`
冻结），不新增运行时依赖。

**技术栈：** npm workspaces、TypeScript strict / NodeNext、React 18、Ink 5.2.x（实际安装版）、
Vitest、ink-testing-library。所有新 UI 字面量必须经 `pickGlyphs(caps)` 取自 `ui/glyphs.ts`
（`glyphs.test.ts` 静态扫描强制 ASCII），所有结构上限放各子系统 `limits.ts`，用户可调键放
`config/schema.ts`。

---

## 1. 概述

AragonAgent 的全屏 TUI 已经是一个成熟的多行编辑器：草稿可跨行、粘贴会折叠成原子
token、行数会被 `layout/budget.ts` 计入视口预算。但三个高频手势仍与主流桌面终端工具
（Claude Code、Codex CLI）的体验有差距。第一，**换行实际上不可用**：`PromptInput.tsx`
里 `if (key.return) { if (key.meta || key.shift) insert('\n') }` 这个分支是死代码 ——
Ink 5 的 `parse-keypress.js` 对整块 stdin chunk 调用一次 `parseKeypress(s)`，`s === '\r'`
时硬编码 `shift: false`；而绝大多数终端对 Shift+Enter 要么原样发 `\r`（Windows Terminal、
conhost 默认），要么发 Ink 正则根本不认识的 CSI-u 序列 `\x1b[13;2u`（kitty/WezTerm 键盘
增强模式、以及手工绑定过 sendInput 的终端），后者会被当作可打印文本插进草稿， literally
打出 `[13;2u`。第二，**复制即选即得**：`selection-controller.ts::finishSelection` 在鼠标
释放的一瞬复制，用户想"选中看看、想清楚再复制"或"选中后用终端自己的右键复制"时无法
阻止剪贴板被污染。第三，**运行中追加的消息发出后凭空消失**：`App.submitMessage` 在
running 分支只调 `controller.steer(message)` 加一条 2.5 秒的 toast "Steering queued."，
消息本体既不进转录也不进任何持久 UI，用户无法确认自己说了什么、Agent 是否收到。

本设计以三个互相独立的子特性解决以上三点，命名统一为
`tui-shift-enter-copy-queue`。子特性 A（换行）在 stdin 过滤器这一"终端方言翻译层"
新增 Enter 族序列的识别与归一化，复用粘贴特性已经建立的 NUL 内联帧（inline frame）
机制把"换行意图"按字节顺序送达编辑器，使 Shift+Enter / Alt+Enter / Ctrl+J 在所有能表达
它们的终端上行为一致；配套 `/terminal-setup` 命令给出各终端的一键绑定说明。子特性 B
（选区复制）把"选中"与"复制"解耦：释放鼠标后高亮保留、不写剪贴板，Ctrl+C 成为唯一
确认键，且该 Ctrl+C 明确不进入既有的"停服务/退出"阶梯。子特性 C（排队反馈）把运行中
提交的消息变成转录中的一等公民 —— 新的 `queued` 条目以 `Queue: <消息>` 形式持续显示，
在 Core 循环于下一轮 `turn_start` 排空 steering 队列（即消息被接受进入对话）的同一提交
内原位转写为普通用户消息。

三个子特性都不改变现有公共契约：Core 的 `AgentEvent` 联合、`saveSession` 的引擎消息
格式、`ToolResult` 形状、配置键集合（本设计不新增任何用户配置键）全部保持不变；
`--no-mouse`、`--no-paste`、plan 模式、行数预算、渲染治理器（governor）等既有退化路径
按原样继承。

---

## 2. 现状与根因（技术依据）

实现者应先读这些代码事实，它们是每条设计决策的依据：

| 事实 | 位置 | 含义 |
| --- | --- | --- |
| Ink 对整块 chunk 只调一次 `parseKeypress`；`\r` 恒为 `{name:'return', shift:false}` | `node_modules/ink/build/hooks/use-input.js:45-67`、`parse-keypress.js:145-149` | 组件层永远收不到 `key.return && key.shift`，现分支是死代码 |
| `\x1b[13;2u` 不匹配 Ink 的 `fnKeyRe`（终止符只认 `~^$` 或字母且结构不同） | `parse-keypress.js:4, 201-221` | CSI-u 序列以 `input='[13;2u'`（ESC 被 use-input 剥掉）进入组件，落入可打印插入分支 |
| stdin 过滤器已在 Ink 之前拥有字节流：剥鼠标报告、框粘贴、其余写入 PassThrough | `input/stdin-filter.ts::createStdinFilter` | 翻译 Enter 族序列的正确层已存在 |
| 粘贴用 NUL 内联帧 `PASTE_OPEN='\u0000['` / `PASTE_CLOSE='\u0000]'` 保持顺序 | `input/limits.ts:61-62` | `sanitisePaste` 剥掉所有 NUL，故载荷无法伪造帧边界 —— 同一保证可复用 |
| 鼠标前缀/粘贴前缀各自测尾、取更长保留 | `stdin-filter.ts::feed` 的 `keep = max(...)` | 序列跨 chunk 断裂的防漏机制有先例，Enter 族前缀需加入 |
| 释放即复制 | `ui/selection/selection-controller.ts::finishSelection`（`options.copy(text)` + `onCopied`） | 子特性 B 的改动点 |
| 任意按键先无条件清选区 | `ui/App.tsx:1820-1831`（`selectionController?.clear()` 是全局 useInput 第一段） | Ctrl+C 分支必须排在它之前 |
| Ctrl+C 阶梯：有活服务→停服务；否则 arm 退出 | `ui/App.tsx:1833-1865` | 复制语义插在最前，不触碰后续阶梯 |
| running 时 Enter → `controller.steer` + toast | `ui/App.tsx::submitMessage:1586-1589` | 子特性 C 的改动点；`dispatch({type:'submit'})` 只走非 running 分支 |
| Core 在循环顶排空 steering、随后发 `turn_start` | `core/src/engine/agent-loop.ts:377-405`（另有两处中途排空，均 `continue` 回循环顶） | `turn_start` = "消息已被接受进入对话"的权威信号；工具间排空路径最终也经过它 |
| 控制器以 `turn_start` 复位 `userSteerCount` | `agent/controller.ts:837-839` | 同一推断已有先例，UI 侧采用相同判据 |
| `reduceEvent('turn_start') → {type:'turnStart'}`，`turnStart` 追加流式 assistant 条目 | `agent/reducer.ts:678-679, 1005-1016` | 转写动作要并入该 case，保证同批原子 |
| `mapEntry` 按 id 原位改写条目（retry/compaction 卡片先例） | `agent/reducer.ts:843-845` | `queued → user` 原位转写有既有模式 |
| 转录提示行已承诺 `shift+enter newline` | `ui/Composer.tsx::hintText:187`、`packages/cli/README.md:436` | 本设计是兑现承诺，不是新增文案 |

---

## 3. 子特性 A：Shift+Enter 换行输入

### 3.1 原则

在**字节流层**（stdin 过滤器）识别"终端方言"，在**编辑器层**只认一种归一化记号。
不在 React 层猜测 `[13;2u` 子串：Ink 按整块 chunk 派发，序列与相邻击键可能合并、也可能
被 ESC 剥离规则改形，组件层看到的字符串不可靠；过滤器层有跨 chunk 前缀保持（pending
hold）与确定性的扫描顺序，且粘贴特性已经证明该层可以无歧义地做这件事（设计文档
D-2/D-3：内联传输，不做旁路 emit）。

### 3.2 归一化记号（数据契约）

在 `input/limits.ts` 新增（与 `PASTE_OPEN` 同居一处，理由同其注释"唯一跨层字节"）：

```ts
/** 换行意图的内联帧（tui-shift-enter-copy-queue §3.2）。 */
export const ENTER_NEWLINE_FRAME = '\u0000n';
```

性质与 `PASTE_OPEN` 相同：NUL 前缀使终端不可能从键盘产生（`sanitisePaste` 剥除粘贴
载荷中的全部 NUL，因此粘贴文本不能伪造该帧）；单帧原子的、无载荷，所以只需一个常量
而非 OPEN/CLOSE 一对。

### 3.3 序列识别与改写（新模块 `input/enter-sequences.ts`，纯函数）

```ts
/** 把 Enter 族转义序列改写为归一化帧的纯改写器。 */
export function rewriteEnterSequences(text: string): string;
/** 尾部是否是某个 Enter 族序列的严格前缀（跨 chunk 保持用）。 */
export function trailingEnterPrefixLength(text: string): number;
/** 上述判定用到的序列表（测试与 /terminal-setup 文案共用）。 */
export const ENTER_SEQUENCES: readonly { seq: string; meaning: string; to: string }[];
```

识别表（改写目标：`ENTER_NEWLINE_FRAME` 记为 `<NL>`，回车 `\r`）：

| 序列 | 含义 | 改写为 |
| --- | --- | --- |
| `\x1b[13;2u` … `\x1b[13;8u`（修饰符 2–8） | Shift/Ctrl/Alt 及组合的 Enter（CSI-u / kitty / modifyOtherKeys=2） | `<NL>` |
| `\x1b\r` | Alt+Enter（多数终端的默认编码） | `<NL>` |
| `\x1b\n` | Alt+Enter 的 LF 变体（部分 Linux 终端） | `<NL>` |
| `\x1b[13u` | 无修饰 CSI-u Enter（外部程序遗留 kitty 键盘模式） | `\r` |

实现要求：

- 用一个锚定正则（形如 `/\x1b\[13;(?:[2-8])?u/g` 与两个字面分支）在文本上做一次全局
  替换；不做逐字符状态机 —— 序列互不为前缀（`;2u` 与 `[13u` 的分歧点在 `;`），一次
  扫描无歧义。
- `trailingEnterPrefixLength` 返回尾部作为任一识别序列**严格前缀**的最长长度（1..5），
  语义与 `trailingMousePrefixLength` 对齐：完整序列不算前缀。
- 模块不 import 任何 node/React 依赖（可被任何测试环境直接调用）。

### 3.4 过滤器集成（`input/stdin-filter.ts`）

两处改动，顺序是规范：

1. **改写点**：`handleOutsidePaste` 内、`splitMouseEvents` 调用之前，对文本先过
   `rewriteEnterSequences`。Enter 族序列与鼠标报告（`\x1b[<` / `\x1b[M`）、粘贴标记
   （`\x1b[2`）的完整序列互不嵌套（无一完整序列是另一家族完整序列的前缀；三者共享
   的 `\x1b` / `\x1b[` 头部前缀由 `keep = max(...)` 家族机制统一保持，
   `trailingEnterPrefixLength` 的加入不改变该语义），改写与鼠标拆分的先后顺序因此
   无关；放在鼠标拆分前是因为拆分后的 `split.text` 会直接 `wrapper.write`，改写必须
   发生在写之前。已在 bracketed paste
   体内的字节不经过此函数（`feed` 的 `bracketed` 分支直接 `appendBracketed`），粘贴
   载荷中形似序列保持字面 —— 与 I-3"粘贴体内暂停鼠标解析"同一原则。
2. **前缀保持点**：`feed` 的 `first === -1` 分支中 `keep` 的计算加入
   `trailingEnterPrefixLength(rest)`，与现有两个家族取 max。序列跨 chunk 断裂（如
   先到 `\x1b[13;` 后到 `2u`）由既有 `PENDING_FLUSH_MS`(12ms)/`MAX_PENDING_CHARS`(32)
   机制兜底，不需要新定时器。

不做 feature 开关：这些序列只有在终端明确表达"修饰过的 Enter"时才会出现，翻译它们
在任何配置下都是strictly改进；`StdinFilterFeatures` 保持 `{mouse, paste}` 不变
（mouse/paste 有开关是因为存在"从未使能"的会话，Enter 族没有）。

### 3.5 编辑器消费（`ui/PromptInput.tsx` + 新 `ui/enter-frames.ts`）

新模块 `ui/enter-frames.ts`（镜像 `paste-frames.ts` 的职责与形状）：

```ts
export function hasEnterFrame(input: string): boolean;
/** 把一个 Ink input 字符串拆成有序段：文本段 + '\n' 段（帧与裸 '\n' 都产出 '\n'）。 */
export function splitEnterFrames(input: string): InputSegment[];
```

`splitEnterFrames` 同时处理两类来源，输出统一为
`{kind:'text'}` / 换行段（换行以 `{kind:'text', text:'\n'}` 产出，复用现有 reducer
`'input'` 动作对文本段的既有序列）：

- `ENTER_NEWLINE_FRAME`（`'\u0000n'`）出现处 → 一个 `'\n'` 段；
- **裸 `'\n'`**（Ctrl+J 直发，以及 ctrl+j 与后续击键合并成块的情况）→ 一个 `'\n'` 段。

`PromptInput` 的 `useInput` 改动（位置是规范，逐条）：

- 现有 `if (key.return)` 分支中 `key.meta || key.shift → insert('\n')` 保留不动（万一
  某终端/某 Ink 版本真能产出该组合，行为不回退）；`input === '\n'` 的裸 Ctrl+J 不在此
  分支，它没有 `key.return`。
- 在**粘贴帧分支之后、`isControlSeq` 丢弃之前**（与 `hasPasteFrame` 并列）新增：

```ts
if (hasEnterFrame(input) || input.includes('\n')) {
  const runs = splitEnterFrames(input);
  const segments = mergeWithPasteRuns(input, runs); // 见下
  if (segments.length === 0) return;
  onInteraction?.();
  dispatch({ type: 'input', segments });
  return;
}
```

- 一个 chunk 可能同时携带粘贴帧与换行帧（过滤器两次 `wrapper.write` 被 Ink 一次
  `read()` 合并）。`mergeWithPasteRuns` 是 `enter-frames.ts` 的第二个导出：以
  `splitPasteFrames(input)` 的结果为骨架，把换行段按其在原字符串中的偏移插进正确位置；
  纯函数，不分配 paste id（id 由调用方在需要时分配，遵守"reducer 外分配"的 P1-5 规则
  —— 本分支只有当骨架含 paste 段时才走 `allocatePasteId()`，复用现有粘贴分支的构造
  代码路径）。
- 草稿上限不受影响：`'\n'` 经 `layoutComposer` 参与既有换行/`USER_ENTRY_MAX_ROWS`
  预算；一次插入多个换行段不绕过任何上限（reducer 的 `input` 分支本就按段插入）。
- **广播消费者（I-12 同类义务，v2 评审 R1 修复）**：`useInput` 是广播
  （`use-input.js:89` 向所有 active handler 派发同一 input），粘贴帧为此建立了
  I-12 不变量 —— 任何把 `input` 累积为文本的消费者都必须先 strip。Enter 帧同样会被
  广播，而 `stripPasteFrames` 不会剥掉 `'\u0000n'`：`SettingsScreen` 的文本/密钥字段
  （`SettingsScreen.tsx:468-480` 直接追加 `input`）、`QuestionOverlay` 的答案草稿
  （`:162`）、`PlanReviewOverlay` 的反馈文本（`:94`）都会把 NUL 追加进字段 —— API key
  被污染后静默认证失败，正是 `SettingsScreen` 注释自述过的事故类别。因此
  `enter-frames.ts` 增加第三个导出：

```ts
/** 供 overlay 类消费者使用：剥掉 Enter 帧，帧位置以 '\n' 替代（无帧原样返回）。 */
export function stripEnterFrames(input: string): string;
```

  规则：`'\u0000n'` → `'\n'` —— 与裸 Ctrl+J 在这些 overlay 中的既有落点一致（它们
  今天对裸 `'\n'` 就是原样追加）；三个 overlay 在各自 `stripPasteFrames` 调用点外套
  一层（或封装一个组合 strip，实现二选一，但必须覆盖全部三处）。`ConfirmDialog`
  只认 y/n/Enter/Esc、无文本累积，天然免疫，不需要改。§9 含对应测试与验收。

### 3.6 `/terminal-setup` 命令（`commands/builtins.ts`）

新增只读命令，输出按平台/终端给出"让 Shift+Enter 发送 `\u001b[13;2u`"的绑定片段：
Windows Terminal（settings.json `actions` + `sendInput`）、VS Code 集成终端
（keybindings.json `terminal.sendSequence`）、iTerm2（Keys → Send Escape Sequence 的
`[13;2u`）、kitty/WezTerm/foot（键盘增强下原生生效）、Alacritty 与 macOS
Terminal.app 的绑定路径；conhost 无法自定义，明示用 Ctrl+J 或 Alt+Enter 替代。
文案全部 ASCII（`glyphs.test.ts` 覆盖 `commands/**`），不探测、不写终端模式字节。
README 增加同内容小节并从 Keybindings 表链接。

### 3.7 明确不做

- **不主动 push** `modifyOtherKeys=2` / kitty `\x1b[>1u`：mode 2 会把 Shift+字母等一切
  修饰键改为 CSI-u 上报，Ink 与本 CLI 的全部 Ctrl/Shift 组合键解析都会失明，需要整套
  反解码表；风险与收益不成比例（用户一次绑定即可达成同一效果）。列为未来工作。
- 不改 `keymap.ts`（它的职责是行内编辑意图，不是键位产生）。

---

## 4. 子特性 B：选中文本后 Ctrl+C 复制

### 4.1 原则

选中是浏览手势，复制是提交手势，二者必须可分离；同时 Ctrl+C 的既有语义阶梯
（停服务 → arm 退出 → 退出）不能被破坏，只是在其前插入最高优先级的一级。
"高亮是对将被复制内容的诚实承诺"（现有 I-4/I-9 不变量）全部保留：高亮与复制读取同一
镜像、行移动即失效。

### 4.2 `selection-controller.ts` 改动

1. `finishSelection()`（释放路径）不再调用 `options.copy` / `options.onCopied`：非空
   选区保留高亮，并把新的模块内状态 `settled = true`（表示"已释放、非空、待复制"）。
   空选区/纯点击的行为不变（清高亮、不碰剪贴板）。
2. 新增对外 API（加入 `SelectionController` 接口）：

```ts
/** 是否存在已释放、非空的待复制选区。 */
hasPendingSelection(): boolean;
/** 取走待复制选区：返回其文本与行数，并清除高亮与 settled 态；无则返回 null。 */
takeSelection(): { text: string; lines: number } | null;
```

   `takeSelection` 用与旧 `finishSelection` 完全相同的提取路径
   （`normalize` → `selectedText(mirror.plain, ...)`），保证"所见即所复制"不变。
3. **hold 语义延长**：`finishSelection` 保留选区后维持 `emitHold(true)`，使转录在
   "选区待复制"期间持续冻结（与拖拽期间同一 `selectionHold` 通道，App 的 Rule A 因此
   保持 `shiftUp` 恒定，选区不会被流式输出推走）。`clear()`、`takeSelection()`、
   `setEnabled(false)`、`dispose()` 都要落 `emitHold(false)`（若当前为 true）。
   30 秒静止 watchdog 不为 settled 态重新武装 —— 丢失 release 的风险不存在（release
   已发生），而冻结需要一个显式出口：Ctrl+C、任意其他键、resize、overlay 打开、
   `/mouse off`，全部已有清除路径。
4. `options.copy` 与 `options.onCopied` 回调从构造参数中**移除**（复制决策上移到 App，
   见 4.3），`SelectionBridge` 相应只保留 `onCopied`（toast 汇聚点不动）。这必然牵动
   装配处：`cli.tsx:818` 的 `copy:` 注入行删除、`:819` 的 `onCopied:` 保留（App 在
   §4.3 直接调用）—— 因此 `cli.tsx` 进入 §6 变更表（v2 修正：v1 误将其列入"不触碰"，
   照做会因对象字面量多余属性直接 TS 编译失败）。

### 4.3 `App.tsx` Ctrl+C 路由改动

全局 `useInput` 处理器内，**第一段无条件 `selectionController?.clear()` 改为**：

```ts
const pendingSel = selectionController?.hasPendingSelection() ?? false;
if (key.ctrl && (input === 'c' || input === 'C') && pendingSel) {
  const payload = selectionController!.takeSelection();
  if (payload) {
    const via = copyText(payload.text, terminal?.writeForeign);
    // 复用 selectionBridge.onCopied 同一 toast 文案（"Sent N lines …"）
    selectionBridge.onCopied?.(via, payload.lines, payload.text.length);
    return;                       // 不进入停服务/退出阶梯，也不 arm
  }
}
selectionController?.clear();      // 其余一切按键：维持现状（含 Ctrl+C 无选区时）
```

要点：

- **顺序**：该块必须仍是处理器内第一段逻辑（I-9 的"任何键清选区"精神），但 Ctrl+C
  在有选区时先"取"后"清"，其余键照旧直接清。
- **不 arm 退出**：复制成功后 `return`，`ctrlCArmed` 不受影响；用户复制后再按一次
  Ctrl+C 才开始走停服务/退出阶梯（此时选区已清，`pendingSel` 为 false）。
- `PromptInput` 的 `useInput` 对 `key.ctrl` 一律 `return`（现状），不会把这次 Ctrl+C
  当文本插入，无双重处理。
- `writeForeign` 取自 `terminalBridge`（`cli.tsx` 已注入），与 `/copy`、旧拖拽复制走
  **同一条**剪贴板路径（OSC 52 有限长度 + 平台 helper，`copyText` 单一权威）。
- **复制失败路径（v2 评审 R4 补充）**：`copyText` 可能返回 `'none'`（OSC 52 超限且
  平台 helper 缺失）。规定：仍调用 `onCopied(via='none', …)` 走既有失败提示通道并
  `return` —— 选区此时已被 `takeSelection` 消费（高亮已清），用户再按一次 Ctrl+C
  即进入原阶梯。剪贴板不可用不是中断运行的理由，把复制失败静默映射成停服务才是。
- **顺序不可倒置（v2 评审 R7 补充）**：`takeSelection()` 必须先于 `copyText()` 执行。
  OSC 52 经 `writeForeign` 写终端会触发 differ 的 `onInvalidate` →
  `setImmediate(() => controller.clear())`（`cli.tsx:696-699`）；`takeSelection` 先行
  清掉高亮后该回调是 no-op。若实现把复制提到取选区之前，复制自身的写字节会在下一拍
  异步擦掉刚保留的高亮与 hold 语义，形成"复制即闪灭"回归。

### 4.4 提示与文档

- `config/ui-state.ts` 的鼠标一次性通知版本号 +1，文案改为"拖选以选中，Ctrl+C 复制"
  （老用户会重新看到一次，这是有意的：他们学过的手势变了）。
- README 鼠标小节与 Keybindings 表同步：`Ctrl+C`（有选区时）= 复制选中内容。
- `/mouse status` 输出行 `drag-select` 的描述同步为 `select (ctrl+c to copy)`。

### 4.5 明确不做

- 不加 `copyOnSelect` 配置开关：需求明示"选中即复制"是错的，不为其保留偏好项
  （仓库惯例：不添加没人要过的可调项）。
- 不改 `/copy`（复制最近一条 assistant 回答）与右键行为。

---

## 5. 子特性 C：运行中排队的消息提示

### 5.1 原则

反馈必须**持久**（toast 2.5 秒即逝，不满足"直到被接受处理"）、**诚实**（只在消息
真正仍处于排队态时显示排队样式）、**原位消解**（被接受后不"跳变到别处"，而是同一条目
转写为它本来的样子 —— 一条用户消息）。判据只用一个：`turn_start`。Core 在循环顶排空
steering 队列后立刻发它（`agent-loop.ts:379-405`），工具间与 LLM 后的两处中途排空都会
`continue` 回循环顶、再经 `turn_start`，因此它覆盖全部三条接受路径；控制器自身也已用
它复位 `userSteerCount`（`controller.ts:839`），UI 采用同一判据不引入第二真相。

### 5.2 视图状态（`agent/reducer.ts`）

1. `Entry` 联合新增成员：

```ts
| { id: string; kind: 'queued'; text: string }
```

2. `ViewAction` 新增 `{ type: 'steerQueued'; text: string }`：以 `appendEntry` 追加
   `queued` 条目（复用环形裁剪与 live-target 断言路径）。
3. `turnStart` case 扩展（**同一动作内原子完成**，先转写后追加 assistant，顺序是渲染
   顺序的规范）：

```ts
case 'turnStart': {
  const converted = state.entries.map((e) =>
    e.kind === 'queued' ? { id: e.id, kind: 'user', text: e.text } as Entry : e,
  );
  // ……现有 assistant 流式条目追加逻辑，基于 converted 之上
}
```

   转写保留 id：`mapEntry`/`entryRevision` 的高度缓存以 id+revision 跟踪，原位换 kind
   不会把条目从 settled 前缀里"搬走"——Transcript 的 settled 边界是按条目**位置**推进
   的 MONOTONIC 游标（`persist.ts` / `proc/types.ts` 多处注释、`reducer.ts:258` 的
   行游标同族），原位改写不增删条目、不移动位置，边界与 `React.memo` 判等均不受影响
   （v2 更正：v1 此处误引了不存在的 `computeSettledCount` 符号）。多条排队消息一次
   全部转写：`drainSteering()` 是全量排空，逐条消解会造成"部分接受"的假象。
4. `runEnd` **不动** queued 条目：运行结束时队列里的消息仍然真实存在（Core 的
   steering 队列跨运行存活，下次 `prompt()` 循环顶排空），显示 `Queue: …` 依旧诚实。
   这也覆盖了"steering 恰好在运行收尾瞬间入队"的窗口。
5. 会话持久化：`saveSession` 照旧原样写 entries（含 `queued`）；
   `normalizeLoadedEntries`（加载侧）把 `queued` 映射为
   `{kind:'notice', level:'warn', text:'Queued but never sent: ' + 首行}` —— 重载后
   Core 队列为空，排队承诺已不可兑现，宁可降级为警示也不伪装成已发送的 user 条目。
6. `trimEntries` 环形裁剪对 `queued` 无特殊处理（它不是 live target：没有任何 id 指针
   指向它）。开发断言列表（`appendEntry` 内 `NODE_ENV !== 'production'` 检查）不需要
   加它。
7. **与清屏/重置命令及 fast 拆除路径的交互（v2 评审 R8 补充）**：`/clear` 派发
   `clearTranscript`（`reducer.ts:1300`，entries 清空）但**不清** steering 队列 ——
   `Queue: …` 条目随屏幕消失后，消息仍在队列，被接受时会以 user 条目"重现"。这是
   I-2"显式用户指令"例外的既有语义（清屏 ≠ 丢弃消息），本设计显式继承而非修正。
   `/reset` 连队列一起清（`commands/builtins.ts:1018` `clearAllQueues()`）且
   `resetConversation`（`reducer.ts:1341`）清空 entries，无残留。fast reviewer 拆除
   路径的 `clearAllQueues()` 有 `userSteerCount() === 0` 守卫
   （`fast/reviewer.ts:389-397`，D-21：绝不销毁用户消息），不会误删排队条目。

### 5.3 提交路径（`ui/App.tsx::submitMessage`）

```ts
if (interactionPhase.current === 'running') {
  controller.steer(message);
  dispatch({ type: 'steerQueued', text: message });
  return;                       // toast('info','Steering queued.') 删除
}
```

- 转录条目即反馈，删除原 toast（保留会让同一事件出现两个来源的确认）。
- `handleSubmit` 在进入前已 `setPinToBottomNonce(+1)`（§4.5 提交即钉底），排队条目出现
  时视口已在最新输出处，无需额外滚动逻辑。
- `interactionPhase === 'starting'` 分支（拒绝并提示）不变；fast reviewer 的 steer 不经
  此路径（`fast/wiring.ts` 注入依赖、`fast/reviewer.ts:771` 调 `this.deps.steer`、落到
  `controller.ts:822` 的 `this.steer`），不会产生用户可见的排队条目 —— 这是
  正确的：它不是用户消息。

### 5.4 渲染（新 `ui/entries/QueuedEntry.tsx`）

- 单行渲染：`<queued 字形> Queue: <首行>` + 多行时尾部 `+N lines`（`pickGlyphs` 新增
  `queued` 字形：Unicode `◷`，ASCII 回退 `*`；接入 `glyphs.ts` 两张表）。宽度策略与
  `run-status-row` 一致：`wrap="truncate"`，超宽截断不换行（高度估算的安全性，同
  DiffView 的教训）。
- 颜色：`theme.muted`（弱于用户消息、强于 notice 的存在感），复用 `EntryFrame` 的左轨
  （`railBranch` 起始），使它在时间线上"挂"在它插入的位置。
- `EntryView`（`ui/Transcript.tsx`）switch 增加 `case 'queued'`；`Transcript` 的
  settled 判定无需改动（见 5.2.3）。
- `agent/headless.ts`、`exec/runner.ts` 不感知该条目类型（reduceEvent 不产生它，只有
  App 的交互路径 dispatch）。

### 5.5 提示行措辞对齐

- `Composer.runningHintClauses` 首子句 `↵ steer` 改为 `↵ queue`（`planRunRow` 自动
  继承，`hintText` 聚合同步）；`AC-43` 相关测试断言随之更新 —— 这不是无关翻新：
  新 UI 已经把该手势的后果命名为 Queue，提示行继续叫 steer 会让同一行为有两个名字。
- `PromptInput` running 占位符 `Type to steer the run…` 改为
  `Type to queue a message, Esc twice to interrupt…`（`ellipsis` 字形规则不变）。
- README：Keybindings 表 `Enter (running)` 行改为 "queue a steering message — shown
  as `Queue: …` until the agent picks it up"，新增一小节配图说明排队转写时序。

---

## 6. 文件 / 模块变更计划

| 文件 | 动作 | 一句话意图 |
| --- | --- | --- |
| `packages/cli/src/input/enter-sequences.ts` | 新建 | Enter 族序列的纯识别/改写/前缀保持模块（§3.3） |
| `packages/cli/src/input/limits.ts` | 修改 | 新增 `ENTER_NEWLINE_FRAME` 帧常量（§3.2） |
| `packages/cli/src/input/stdin-filter.ts` | 修改 | 写前改写 + 前缀保持家族加入 Enter 族（§3.4） |
| `packages/cli/src/ui/enter-frames.ts` | 新建 | 组件侧帧/裸 `\n` 拆分与粘贴段合并（§3.5） |
| `packages/cli/src/ui/PromptInput.tsx` | 修改 | 换行帧消费分支 + running 占位符（§3.5/§5.5） |
| `packages/cli/src/commands/builtins.ts` | 修改 | 新增 `/terminal-setup`（§3.6）；`/mouse status` 文案（§4.4） |
| `packages/cli/src/ui/selection/selection-controller.ts` | 修改 | 释放不再复制；`hasPendingSelection`/`takeSelection`；hold 延长（§4.2） |
| `packages/cli/src/ui/App.tsx` | 修改 | Ctrl+C 选区优先路由（§4.3）；steer 分支 dispatch（§5.3） |
| `packages/cli/src/ui/clipboard.ts` | 不变 | 复制仍走 `copyText` 单一权威（列出以示边界） |
| `packages/cli/src/agent/reducer.ts` | 修改 | `queued` Entry、`steerQueued` 动作、`turnStart` 原位转写、加载降级（§5.2） |
| `packages/cli/src/ui/entries/QueuedEntry.tsx` | 新建 | `Queue: <文本>` 单行条目渲染（§5.4） |
| `packages/cli/src/ui/Transcript.tsx` | 修改 | `EntryView` 增加 `queued` 分支（§5.4） |
| `packages/cli/src/ui/Composer.tsx` | 修改 | `runningHintClauses` 首子句 `steer→queue`（§5.5） |
| `packages/cli/src/ui/glyphs.ts` | 修改 | 新增 `queued` 字形与 ASCII 回退（§5.4） |
| `packages/cli/src/config/ui-state.ts` | 修改 | 鼠标一次性通知版本 +1 与新文案（§4.4） |
| `packages/cli/src/session/persist.ts` | 修改 | 加载侧 `queued → notice` 降级（§5.2.5） |
| `packages/cli/README.md` | 修改 | Keybindings、复制手势、排队时序、terminal-setup（§3.6/§4.4/§5.5） |
| `packages/cli/src/cli.tsx` | 修改 | 仅删除 selection 构造的 `copy:` 注入行（§4.2.4，v2 新增；桥接形状不变） |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | 修改 | 文本/密钥字段接入 `stripEnterFrames`（§3.5，v2 新增） |
| `packages/cli/src/ui/overlays/QuestionOverlay.tsx` | 修改 | 答案草稿接入 `stripEnterFrames`（§3.5，v2 新增） |
| `packages/cli/src/ui/overlays/PlanReviewOverlay.tsx` | 修改 | 反馈文本接入 `stripEnterFrames`（§3.5，v2 新增） |
| 对应 `__tests__`（见 §9 清单） | 新建/修改 | 单测与组件测试 |

不触碰：`packages/core/**`（公共 API 冻结）、`config/schema.ts`（无新配置键）、
`exec/**`、`headless.ts`。`cli.tsx` 装配**仅允许** §4.2.4 规定的单行删除
（`copy:` 注入行），不得增改（v2 修正：v1 曾将其整体列入"不触碰"，与 §4.2.4 相悖）。

---

## 7. 接口设计（CLI / 组件 / 时序）

### 7.1 命令

```
/terminal-setup          # 只读；打印各终端让 Shift+Enter 发送 \u001b[13;2u 的绑定说明
/mouse status            # drag-select 行描述更新为 select (ctrl+c to copy)
```

### 7.2 组件/模块签名（新增面）

```ts
// input/enter-sequences.ts
export function rewriteEnterSequences(text: string): string;
export function trailingEnterPrefixLength(text: string): number;
export const ENTER_SEQUENCES: readonly { seq: string; meaning: string; to: string }[];

// ui/enter-frames.ts
export function hasEnterFrame(input: string): boolean;
export function splitEnterFrames(input: string): InputSegment[];
export function mergeWithPasteRuns(input: string, runs: InputSegment[]): InputSegment[];
export function stripEnterFrames(input: string): string;

// ui/selection/selection-controller.ts（SelectionController 接口新增）
hasPendingSelection(): boolean;
takeSelection(): { text: string; lines: number } | null;

// agent/reducer.ts
type Entry = … | { id: string; kind: 'queued'; text: string };
type ViewAction = … | { type: 'steerQueued'; text: string };
```

无 REST/WebSocket 面；无新配置键、无新环境变量、无持久化格式版本变化。

### 7.3 关键时序

**换行（子特性 A）**：终端发 `\x1b[13;2u` → `stdin-filter.feed`（若尾部为部分序列则入
`pending`，下 chunk 并回）→ `handleOutsidePaste` 内 `rewriteEnterSequences` →
`wrapper.write('\u0000n')` → Ink 整块派发 → `PromptInput.useInput` 命中
`hasEnterFrame` → `splitEnterFrames`/`mergeWithPasteRuns` → 一次 `dispatch({type:'input'})`
（一按键一 dispatch 规则保持）→ `layoutComposer` 重排行、`onDraftChange` 仅在行数
变化时上报。

**复制（子特性 B）**：拖选（hold=true，视口冻结）→ 释放（高亮保留、settled、hold 维持）
→ Ctrl+C → App 先 `takeSelection`（文本 + 清高亮 + hold=false）→ `copyText` →
`onCopied` toast → `return`。流式输出期间到达的输出不移动视口（hold 冻结），用户按
Ctrl+C 之外的任何键 → `clear()` → 冻结解除、"N new lines" 计数接管。

**排队（子特性 C）**：running 中 Enter → `submitMessage` → `controller.steer` +
`dispatch steerQueued` → 转录尾部出现 `◷ Queue: <首行>`（持续显示，无 TTL）→ Core
循环顶排空 steering → `turn_start` → `reduceEvent` → `turnStart` case：全部 `queued`
原位转写为 `user`，随后追加流式 assistant 条目 → 排队样式消失、消息以用户身份常驻。
异常路径：Esc×2 中断后消息仍在队列 → 条目保持 `queued`（诚实）；会话保存后重载 →
降级为 warn notice。

---

## 8. 数据模型（内存形状汇总）

本特性无数据库；以下为全部新增/变更的内存数据形状，实现不得超出此集合。

**字节层（`input/limits.ts` / `input/enter-sequences.ts`）**

```ts
export const ENTER_NEWLINE_FRAME = '\u0000n';            // 唯一新跨层字节记号
export interface EnterSequenceSpec {                      // 识别表元素（§3.3 的表）
  readonly seq: string;       // 如 '\x1b[13;2u'、'\x1b\r'
  readonly meaning: string;   // 'shift+enter' | 'alt+enter' | 'enter'
  readonly to: string;        // ENTER_NEWLINE_FRAME 或 '\r'
}
```

**编辑器层（复用，零形状变更）**：换行以现有
`InputSegment = { kind: 'text'; text: '\n' }` 表达；`EditorAction` 不新增成员
（走既有 `{type:'input'; segments}`）。

**视图层（`agent/reducer.ts`）**

```ts
type Entry = … | { id: string; kind: 'queued'; text: string };   // 新成员
type ViewAction = … | { type: 'steerQueued'; text: string };     // 新成员
// 'turnStart' 处理器内部：entries 数组原位逐条 map，queued → {id, kind:'user', text}
```

**选区控制器（`ui/selection/selection-controller.ts` 内部状态机）**

```
none ──press(left,enabled)──▶ dragging(hold=true)
dragging ──release(empty)──▶ none            （高亮清除，不复制）
dragging ──release(non-empty)──▶ settled(hold=true, 高亮保留)   // 新状态
settled ──takeSelection()──▶ none + 返回 {text, lines}          // Ctrl+C 消费
settled ──clear()/setEnabled(false)/dispose()──▶ none(hold=false)
```

**持久化**：`saveSession` 写出的 entries JSON 增加了 `kind:'queued'` 这一取值；
`loadSession` 归一时将其降级为 `notice`，落盘格式版本不变。旧版本程序读新文件时，
`normalizeLoadedEntries` 对未知 kind 原样透传、`EntryView` 的 `default → null` 使其
静默不渲染（不崩溃、不可见）——这是可接受的前向兼容边界，非本设计新增的义务。

## 9. 测试与验收标准

测试文件（Vitest，命名沿用 `src/__tests__/<topic>.test.ts(x)` 约定）：

- `enter-sequences.test.ts`（新）：表驱动覆盖每条序列与边界 —— 完整/部分前缀、
  序列与文本混排、`\x1b[13u`→`\r`、未知修饰符（`9`+）不改写、`rewriteEnterSequences`
  幂等。
- `stdin-filter` 既有测试文件扩展：`\x1b[13;2u` 单独成 chunk、与前导文本同 chunk、
  跨 chunk 断裂（`\x1b[13;` / `2u` 两段）、位于 bracketed paste 体内不改写、
  `--no-paste` 会话仍改写。
- `enter-frames.test.ts`（新）：帧拆分、裸 `\n` 拆分、与 paste 帧同串时的偏移合并顺序、
  `stripEnterFrames` 的帧→`\n` 替换与无帧原样返回。
- overlay 广播测试（v2 新增，对应 §3.5 广播消费者）：三个 overlay 的文本累积路径收到
  `'\u0000n'` / 混合串时经 `stripEnterFrames` 落为 `'\n'`，字段中不出现 NUL；可沿用
  `paste-frames.test.ts:166` 的源码静态断言模式确保三处调用点不被遗漏。
- `input.test.ts` 扩展：合成 useInput 调用 `( '\u0000n', {…} )` 与 `('a\u0000nb', …)`
  分别产出换行与有序插入；一次 dispatch。
- `selection-controller.test.ts` 扩展：释放后 `copy` 不被调用；`hasPendingSelection`
  状态机；`takeSelection` 返回镜像文本并清高亮/hold；`clear`/`setEnabled(false)`/
  `dispose` 落 hold=false。
- `app.test.tsx` 扩展：有选区时 Ctrl+C → 走复制、不 arm 退出、不清服务；无选区时
  Ctrl+C 阶梯行为与现状逐字一致；running 提交 → 转录出现 queued 条目且**无** toast；
  `turn_start` → 条目转写为 user 且 assistant 条目紧随其后；`agent_end` 后 queued
  保留。
- `reducer` 既有测试文件扩展：`steerQueued` 追加、`turnStart` 全量转写与 id 保持、
  `normalizeLoadedEntries` 的 `queued → notice` 降级。
- `hintTextForTest`/`planRunRow` 既有断言更新（`queue` 措辞）。

验收标准（AC）：

1. 在发送 `\x1b[13;2u` 的终端按 Shift+Enter，草稿插入换行、不提交；Enter 仍提交。
2. Ctrl+J 在所有终端插入换行；Alt+Enter（`\x1b\r`）插入换行。
3. CSI-u 序列不再以 `[13;2u` 字面进入草稿。
4. 拖选释放后剪贴板不被写入；高亮保留；Ctrl+C 复制该选区并 toast；再按 Ctrl+C 进入
   原阶梯。
5. 释放后的选区在流式输出下不漂移（视口冻结），任一其他键解除冻结并清选区。
6. running 中 Enter：转录出现 `Queue: <消息>`；消息被接受（下一 `turn_start`）后该条
   原位变为用户消息，排队提示消失；中断不提前清除它。
7. `npm run build`、`npm run typecheck`、两个 workspace 的 `npm test` 全绿；glyphs
   静态扫描（新增文件在扫描范围内或按规则加入其目录正则）通过。
8. 无新配置键、无 Core 变更、无新依赖（`git diff --stat packages/core` 为空）。
9. （v2 新增）`SettingsScreen` / `QuestionOverlay` / `PlanReviewOverlay` 打开时注入
   `'\u0000n'`（或其与文本的混合串），字段/草稿中不出现 NUL 字节，按 `'\n'` 语义
   处理（I-12 同类验收）；`ConfirmDialog` 行为不变。

---

## 10. 风险与缓解

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 用户终端（conhost 等）无法发送可区分的 Shift+Enter，特性"看起来没生效" | 高 | Ctrl+J / Alt+Enter 全终端可用作主路径；`/terminal-setup` 给出一键绑定；README 明示矩阵。验收以序列层为准，不承诺未配置终端的 Shift+Enter |
| `\x1b\r` 与"Esc 紧跟 Enter"字节级不可区分，快速 Esc+Enter 合并块会被译为换行 | 中 | 现状下该合并块本就被丢弃（Ink 剥 ESC 后 `\r` 无 return 标志、被 `isControlSeq` 拦截），翻译不劣化任何现可用行为；文档记录；双 Esc 中断手势不受影响（两次 ESC 不含 `\r`） |
| hold 延长（释放后冻结）让用户以为"卡住" | 中 | 冻结是既有拖拽语义的延续且有四个显式出口（Ctrl+C/任意键/resize/overlay）；"N new lines" chip 持续可见；一次性通知版本 +1 教新手势 |
| `turnStart` 判据把"接受"与"模型开始回复"合并，极早中断时消息已入 history 但无回复 | 低 | 此刻消息确已被 Core 接受（在 retained tail 内、下次继续会带上），转写为 user 是诚实的；比现状（消息完全不可见）严格更好 |
| 会话保存时含 queued 条目、重载后降级为 notice 造成"少了消息"观感 | 低 | 降级文案带消息首行；Core steering 队列本就不持久化，伪装成 user 才是谎言 |
| CSI-u 反解码缺失导致其他修饰键序列被当文本插入（如外部程序遗留 kitty 模式） | 低 | 仅覆盖 Enter 族；`\x1b[13u`→`\r` 兜底最常见遗留；未识别序列行为与现状完全一致（不是回归） |
| `queued` Entry 进入 settled 前缀后被原位改 kind，高度缓存失配 | 低 | `entryRevision` 以非追加变更计数，转写在 reducer 内走 `map` 重建该条目对象，revision 机制按现有 retry/compaction 同路径生效；测试断言转写后高度重估 |
| 措辞变更（steer→queue）破坏下游对提示行的字符串断言 | 低 | 属本仓库自身测试，随特性同批更新并在 AC-7 的全绿里验证 |
| Enter 帧被 useInput 广播进 overlay 文本字段（API key / 答案 / 反馈被 NUL 污染） | 高（v2 评审新增） | `stripEnterFrames` 接入三个文本累积消费者（§3.5），`ConfirmDialog` 无文本累积天然免疫；静态断言 + AC-9 验收 |

---

## 11. 交付边界

本节点仅交付本设计文档；实现、`/terminal-setup` 文案定稿、glyph 选形（`◷`/`*` 可在
实现评审中替换为同宽更优字形）与 README 图示由下游实现节点完成。实现须遵守 §6 文件
表边界（特别是 Core 零改动与无新配置键），并在完成后按仓库惯例提交 logic note。

---

## 评审结论

**通过**（基于 v2）。

四维评估结果：

- **可行性**：三个子特性引用的全部代码事实经实装源码核验与 Ink 解析器实测成立
  （含 `\x1b[13;2u` → `'[13;2u'` 落入可打印分支、裸 `\n` 以 `input='\n'` 送达、
  NUL 帧完整穿透 parseKeypress、`turn_start` 覆盖全部三条 steering 接受路径、
  steering 队列跨运行存活等关键前提）；复用机制（NUL 帧、`keep = max`、
  `appendEntry`/`mapEntry`、`copyText`、`EntryFrame`）均为现成代码路径，零 Core
  改动、零新依赖、零新配置键经核属实。
- **完备性**：v1 的 P0/P1 缺口（Enter 帧广播污染、cli.tsx 装配矛盾、settled 机制
  误引、复制失败路径）已在 v2 正文全部修复；异常路径（中断、runEnd、`/clear`、
  `/reset`、会话重载降级、fast reviewer 拆除、剪贴板不可用、OSC52 invalidate 交互）
  均有明确定义。
- **一致性**：与 CLAUDE.md 规范（命名动词/布尔前缀、`src/__tests__/<topic>` 测试
  约定、glyphs/limits/config 分层）、既有不变量（I-2/I-3/I-9/I-11/I-12）及退化路径
  （`--no-mouse`、`--no-paste`、`--no-diff-render`、plan 模式）无冲突；v1 内部的
  两处自相矛盾（§4.2.4↔§6、§7.2↔§3.3/§3.5）已消除。
- **规模适度**：改动收敛于 `@aragon-agent/cli`（§6 修订表为准确边界），无过度设计
  （未 push 键盘增强模式、未造新状态机、未加偏好开关），无欠设计（三个子特性的
  每条用户可见路径都有对应机制与测试）。

实现节点必须遵守的 v2 增补约束（均已写入正文，此处汇总）：① `stripEnterFrames`
必须覆盖 `SettingsScreen` / `QuestionOverlay` / `PlanReviewOverlay` 三处文本累积
（R1，AC-9 验收）；② `cli.tsx` 仅删除 `copy:` 注入行（R2）；③ `takeSelection()`
先于 `copyText()` 执行（R7）；④ `via === 'none'` 走既有失败提示并 `return`（R4）；
⑤ 文件边界以 §6 修订后的表格为准。


---

## 实施过程发现的方案缺陷

实现节点（v2 定稿后）逐条核对时发现的规格缺陷与采用的修正。所有修正都在 §6
文件边界与三条子特性架构之内，无范围扩张。

| # | 位置 | 缺陷 | 采用的修正 |
| --- | --- | --- | --- |
| I-1 | §3.5 ↔ §7.2 | `mergeWithPasteRuns(input, runs): InputSegment[]` 与 P1-5 自相矛盾：`InputSegment` 的 paste 段**必须**携带 `id`，而 §3.5 同时要求 merge 是纯函数、不分配 paste id | 以 `FrameSegment[]`（无 id 的 paste 段）为两侧货币；`PromptInput` 在构造 dispatch 时按段分配 `allocatePasteId()`，P1-5 语义完整保留 |
| I-2 | §4.2.4 ↔ §6 | "仅删除 `copy:` 注入行"不可编译：§4.2.4 要求 `options.copy` **与** `options.onCopied` 都从构造参数移除，保留 `cli.tsx:819` 的 `onCopied:` 行会成为对象字面量多余属性（正是 R2 指控 v1 的那类错误） | `cli.tsx` 的 `createSelectionController` 调用中 `copy:` 与 `onCopied:` 两行一并删除；`SelectionBridge` 形状不变（`onCopied` 仍是 App 侧 toast 汇聚点，§4.3 直接调用） |
| I-3 | §4.4 / §6 | 鼠标一次性通知的版本常量与文案都不在 `config/ui-state.ts`（该文件只存数值）；二者实际位于 `ui/use-startup-notices.ts`（`MOUSE_NOTICE_VERSION` / `mouseNoticeText`） | 在正确的文件把版本 bump 到 `2` 并改文案为 "drag to select, then Ctrl+C to copy"；`ui-state.ts` 零改动（gate 读的是常量对比） |
| I-4 | §3.3 | 示例正则 `/\x1b\[13;(?:[2-8])?u/g` 匹配不了 `\x1b[13u`（`;` 在可选组之外），而识别表要求该序列改写为 `\r`；且单一替换目标无法同时产出帧与 `\r` 两个改写值 | 正则为 `/\x1b\[13(?:;[2-8])?u/g` + replacer 函数按是否含 `;` 区分目标（修饰 → 帧，无修饰 → `\r`）；由 `enter-sequences.test.ts` 表驱动用例暴露并覆盖 |
| I-5 | §3.3 | `trailingEnterPrefixLength` 上限"（1..5）"算错：最长识别序列 7 字节，严格前缀最长可达 6（`\x1b[13;2`）；若按 5 截断，跨 chunk 断裂在最常见位置会漏保持 | 上限从识别表派生（`max(seq.length) - 1`），并要求**最长**匹配（CSI-u 家族只在末字节分叉，最短匹配会提前放行破坏序列） |
| I-6 | §3.4 | "改写点：`splitMouseEvents` 调用之前"不足以让 AC-2 成立：`\x1b\r` 含 CR，`classifyChunk` 主规则会把它归类为 Tier 2 粘贴体，`sanitisePaste` 剥掉 ESC 后该键被静默吞掉（粘贴特性默认开启时 Alt+Enter 完全失效） | 改写点放在 `handleOutsidePaste` **顶部**（burst 分支与分类之前）；代价是 Tier 2（无括号）粘贴体内字面的 ESC+CR 对会丢掉那一个换行（括号粘贴体不经过该函数，不受影响），代码注释已记录该取舍 |
| I-7 | §3.5 | "它们今天对裸 `'\n'` 就是原样追加"前提不实：三个 overlay 走 `stripPasteFrames`，其 `sanitiseTyped` 会剥掉包括 `\n` 在内的全部 C0，裸 Ctrl+J 今天就是被丢弃的 | `stripEnterFrames` 仍按规格定义（帧位替换为 `\n`，无帧原样返回）；overlay 采用 `stripPasteFrames(stripEnterFrames(input))` 组合，净效果是帧与裸 Ctrl+J 落点一致（对单行字段即丢弃——把换行写进 API key 才是污染）；AC-9 的"字段无 NUL"硬要求由 `enter-frames.test.ts` 组合用例与静态扫描双重钉住 |
| I-8 | §5.5 | 措辞联动不完整：`HelpOverlay` 的运行行（"steer / interrupt keys"）与拖选行（"releasing copies it"）未被列入，但保留即与新行为矛盾（同一手势两个名字 / 教已废除的手势） | 两行文案随特性同批更新，另补一行 `Ctrl+C (with a selection)`；`App.tsx`/`Composer.tsx` 相关注释同步 |
| I-9 | §9 | "`input.test.ts` 扩展：合成 useInput 调用"名不符实：该文件是纯函数 + 源码扫描风格，挂载 harness（含每键渲染计数）在 `prompt-input-commits.test.tsx` | 挂载用例（帧、混合 chunk、裸 `\n`、一次 dispatch/一帧渲染）落在 `prompt-input-commits.test.tsx`；`input.test.ts` 按其原有风格补新分支的位置与单 dispatch 源码扫描断言 |
| I-10 | §5.2.3 / §5.4 | （确认而非缺陷）`entryRevision` / `estimateEntryRows` / `separationRows` / `renderTranscriptText` 的 `default` 分支对新 kind 的行为已被规格判定正确：修订恒定 `'x'`（转写后变为 `'u'`，高度缓存自然失效重估）、估算 `separation + 1`（单行截断行）、退出转录静默不渲染——实测全部成立，未触碰这些文件 |

另：`mouse-routing.test.tsx` 中对旧通知文案的一处正向断言随 I-3 的新文案更新；
`MOUSE_NOTICE_VERSION` bump 到 2 会使所有老用户按设计重看一次通知（§4.4 的本意）。
