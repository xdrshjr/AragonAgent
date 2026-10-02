# Paste handling in the composer — design specification

> Feature slug: `tui-paste-handling`
> Target: `@aragon-agent/cli` only (`packages/cli`, v0.6.3). `@aragon-agent/core` is **untouched** — no engine, provider, tool, skill or event change.
> Version: **v2** (design-review node; v1 authored by the solution-architect node)
> Status: design reviewed; every P0 / P1 raised in `## 评审记录` is fixed in this body. Implementation not started.
> Builds on: `docs/plans/mouse-wheel-region-routing/spec.md` (the stdin filter and invariant I-8), `docs/plans/tui-selection-and-scroll-follow/spec.md` (the foreign-write door, the composer chip), `docs/plans/tui-input-flicker-fix/spec.md` (the one-dispatch-per-key rule), `docs/plans/tui-render-performance/spec.md` (viewport virtualisation). Nothing in those documents is retracted. `ui/layout/budget.ts::viewportRows` and `input/stdin-mouse-filter.ts` are **amended** here, and each amendment is called out where it occurs.
>
> Requirement (原文):
> 这个项目，当前是一个 TUI/CLI，并且具有开发包的项目，现在需要进行功能开发和完善。
> 当前 TUI 软件，打开以后，输入内容的时候，如果向其中粘贴剪贴板的大量内容的时候，会出现混乱的情况，需要优化改进。
> 复制大量超长内容的时候，应该显示为类似 `[Pasted text #1 +15 lines]` 这样的效果；
> 如果内容短的话，在几行内的话，要能够正确整齐地显示在输入框内。
>
> 相关注意：Anthropic 的顶级产品；美观、优雅、顶级设计，符合人机交互最佳实践；稳健、可靠、顶级。

---

## 评审记录 (Review Notes)

> 评审节点：design-review（Anthropic 工程团队高级评审）
> 评审对象：本文档 v1（solution-architect 节点产出）
> 复核基准：工作树 `packages/cli@0.6.3`、`node_modules/ink@5.2.1`。下列每一条都读过源码原文，不是从文档推断的。
> 处置：**全部 P0 / P1 已在本 v2 正文中就地修复**，每条末尾标注「⇒ 已修复于 §x」。P2 逐条注明是「已顺手修入正文」还是「记录待办」。

### 总评

方向是对的，诊断本身也比多数同类文档更硬：§2 的三个缺陷（A 提交、B 控制字节、C 高度失账）我逐条复核过，**全部属实**，`parseKeypress` / `use-input.js` / `isControlSeq` / `chromeBudget` 的引用位置也都对得上。D-1（识别下沉到 Ink 之前）、D-3（同流 NUL 封帧而非旁路通道）、D-15（按显示列硬折行而不是 `wrapToRows`）三条是这份设计里最有价值的判断，评审不动它们。

问题集中在**同一个盲点**：文档把「装了过滤器」和「开了鼠标」当成同一件事，也把「`PromptInput` 是唯一的输入消费者」当成前提。这两个前提在 v0.6.3 的代码里都不成立，而且不成立的方式都是**静默的**——一个让 `--no-mouse` 用户被重新打开鼠标上报，一个让用户粘贴的 API Key 带着 NUL 存进配置。两条都是本特性**引入的回归**而非既有缺陷，因此定 P0。

### P0

**P0-1 · 放宽过滤器闸门会静默地把鼠标上报重新打开，`--no-mouse` 就此失效。**

D-13 把闸门改成 `stdin.isTTY && (wantMouse || config.paste)`，但 `cli.tsx` 里 **`mouseFilter !== null` 被当作「鼠标已开」读了五处**，而不是一处：

| 位置 | 表达式 | 后果 |
| --- | --- | --- |
| `cli.tsx:704` | `enterAltScreen(…, { mouse: mouseFilter !== null, … })` | 写出 `\x1b[?1000h\x1b[?1006h` |
| `cli.tsx:614` | `wantSelect = mouseFilter !== null && config.mouseSelect` | 再写出 `\x1b[?1002h`，并建 selection controller |
| `cli.tsx:790` | `mouseCaptured = mouseFilter !== null` | `/mouse` 的运行期真值 |
| `cli.tsx:872` | `mouseSource={mouseFilter?.source}` | 喂给 `App.tsx:1032` 的 `enabled: !!mouseSource` |
| `App.tsx:186-188` | `mouseSource` 的契约注释 | 「`--no-mouse`、inline、非 TTY 时必须缺席」 |

`paste` 默认 `true`，所以 **`aragon --no-mouse` 会得到一个非 null 的 filter**，于是上面五处全部翻真：终端原生选中被 `?1000h` 夺走（这正是用户敲 `--no-mouse` 的唯一理由），`?1002h` 跟着开，`App` 还会向用户播报一个他刚刚关掉的模式的使用建议——`App.tsx:1025-1027` 的注释逐字写着这件事「必须永不发生」。inline 模式同理：`wantMouse` 含 `mode === 'fullscreen'`，放宽后 inline 会拿到 `mouseSource`，而 `?1000h` 从未写出，于是订阅了一条永远不会有事件的通道，正是 `cli.tsx:574-583` 那段注释警告的「app claims a capability it does not have」。

D-13 只复述了 I-5，没有意识到 I-5 的载体（`mouseFilter !== null`）同时也是另外四个判断的载体。⇒ **已修复于 §5.1.1 / D-13 / D-17 / I-11 / §6 行 15（`cli.tsx`）/ AC-11 / T-29。**

**P0-2 · NUL 封帧的粘贴会原样打进 `SettingsScreen` 的 API Key 字段并被持久化。**

`splitPasteFrames` 只加在 `PromptInput` 上，但 Ink 的 `useInput` 是**广播**的：`use-input.js` 把 `'input'` 事件发给每一个挂载中的 handler。本仓库有 6 个 `useInput` 调用点，其中两个会把 `input` 原样当文本吃掉：

- `ui/overlays/SettingsScreen.tsx:467` — `if (input && !key.ctrl && !key.meta) setValues(… + input)`
- `ui/overlays/QuestionOverlay.tsx:158` — `if (input && !key.ctrl && !key.meta && !key.tab) setDraft(draft + input)`

一个 100 字符的 API Key 没有换行，命中 Tier 2 次规则（≥ 25 字符）⇒ 被封帧 ⇒ 存进去的值是 `\u0000[sk-ant-…\u0000]`。而且这条路径**没有任何一处会暴露它**：secret 字段用 `maskDot` 打码（`SettingsScreen.tsx:473-480`），`String.prototype.trim()` 不去 NUL（U+0000 既不是 WhiteSpace 也不是 LineTerminator），`App.tsx:1492-1500` 直接 `registerSecret(key)` + `controller.setApiKey(...)` 落盘。用户看到「保存成功」，然后每一次调用返回 401，屏幕上没有任何线索。

这不是理论边界：`App.tsx:1477-1479` 的注释**逐字写着** "the same Enter press is often carrying a freshly pasted API key"——粘贴进这个字段是密钥进入本进程的**主要方式**，而本特性恰好会破坏它。相对 v0.6.3 是纯回归。⇒ **已修复于 G9 / §5.4.1 / I-12 / §6 行 19-20（`SettingsScreen.tsx` / `QuestionOverlay.tsx`）/ AC-12 / T-30。**

### P1

**P1-1 · 一个帧可以和相邻的按键字节合并进同一个 `input`，而帧外文本被原样 splice 回缓冲区——缺陷 B 从后门回来。**

`App.js:114` 对交给 Ink 的流调用 `setEncoding('utf8')`，`App.js:135` 的 `read()` 不带 size 参数，因此**一次 drain 会把 `PassThrough` 里已缓冲的所有 write 拼成一个字符串**。这正是 §5.1「一个粘贴不会被拆成两个 input 事件」所依赖的性质，但它反过来也成立：过滤器先 `wrapper.write(frame)`、随后 `wrapper.write('\r')`（用户粘完立刻回车），若 Ink 在这两次之间没有 drain（Ink 有 32 ms 节流，大 transcript 的一次 Yoga 布局轻松超过 15 ms 的 burst 窗口），到达的就是 `"\0[…\0]\r"`。`splitPasteFrames` 把尾部 `\r` 归成 text 段，而 §5.3 的 reducer 对 text 段是「splice text at cursor」——**裸 CR 进缓冲区**，正是 §2.2 那个缺陷。合并进来的方向键 `\x1b[A` 同理。⇒ **已修复于 §5.4（text 段过 `sanitiseTyped`）/ I-14 / T-31。**

**P1-2 · `UserEntry` 封顶 40 行，但 `estimateEntryRows` 仍按全量行数估高——I-8 的同型错误，只是搬到了 transcript。**

`ui/layout/virtual-window.ts` 的 `case 'user'` 返回 `separation + wrappedRows(entry.text, usable)`。§5.6 只改渲染端不改估高端，于是一条 5 000 行的用户消息在虚拟窗口眼里仍然是 5 000 行高。该文件自己的注释写明了这类错误的后果：「an entry estimated at 400 rows is exactly the one that never gets mounted」——不被 mount 就永远拿不到真实测量，估值也就永远不会自我纠正。文档在 I-8 里把「渲染行数与账面行数必须是同一个数」提升为不变量，却在 §5.6 漏掉了它，§6 的改动清单里也没有 `virtual-window.ts`。⇒ **已修复于 §5.6 / I-13 / §6 行 21（`virtual-window.ts`）/ T-32。**

**P1-3 · D-11 / AC-9 要求弹 toast，但从过滤器到 `App` 没有任何通道。**

过滤器在 `cli.tsx` 里 `render()` **之前**构造，今天它唯一的出口是 `tryCreateMouseFilter(process.stdin, (reason) => logger.warn(...))`——一个日志回调。`dispatch({type:'notice'})` 在 `App` 内部。按 v1 的写法，「超限被拒」只会写进日志文件，用户看到的是「粘贴了但什么都没发生」，比静默截断好不了多少。本仓有现成范式（`selectionBridge` / `updateBridge` / `terminalBridge`），文档必须点名其一。⇒ **已修复于 §5.1.2 / §6 行 3 与行 13（`input/limits.ts` / `App.tsx`）/ I-15。**

**P1-4 · `PASTE_DRAFT_MAX_BYTES` 与 `PASTE_MAX_BLOCKS` 没有生效点。**

§8 写了这两个上限「above ⇒ rejected」，但过滤器不知道 draft 状态，而 reducer 是纯函数、既不能弹 toast 也不能让用户知道自己被拒了。两个常量因此在 v1 里是**写下来但无人执行**的。⇒ **已修复于 §5.3「三道上限的生效点」/ AC-9。**

**P1-5 · `nextPasteId` 在 reducer 内部自增，reducer 因此不纯——与本包自己的教条冲突。**

§8 的理由写反了：把计数器放模块级**并不能**让 reducer 变纯，真正让它不纯的正是「在 reducer 里读写模块状态」。React 允许对同一个 action 多次调用 reducer（`dispatchSetState` 的 eager 求值、bailout 后的 base-queue 重放、StrictMode 双调用），此时 id 会跳号，两次求得的 state 还会因为 token 文本不同而互不相等。即便一次都不重放，把 id 的分配时机放在 reduce 而不是 dispatch，也让 token 字符串对单测不可预期。正确做法是在 handler 里分配、随 action 传入。⇒ **已修复于 §5.3 / §8。**

**P1-6 · I-7 说「每一个改缓冲区的 action 都要剪枝」，§5.3 只在 `input` 一个分支里剪。**

`replace`（`Ctrl+U` / `Ctrl+K` / `Ctrl+W` 都走它）、`backspace`、`recall` 全都能删掉 token，却都不释放 payload。一条正文与不变量互相打脸的规则，比没有这条规则更糟：后来的人会照正文写，然后以为 I-7 成立。⇒ **已修复于 §5.3（`withPrune` 包住所有改缓冲区的分支）。**

**P1-7 · Tier 2 的载荷会被鼠标解析吃掉字节；I-3 只保护了 Tier 1。**

§5.1 的扫描顺序里，鼠标切分（step 2）在 Tier 2 分类（step 3）**之前**，`burst` 状态下到达的后续 chunk 也要先过 step 2。于是在没有 bracketed paste 的终端上（正是 Tier 2 的目标人群），粘贴一段**终端日志**——对一个 TUI 开发工具来说最典型的粘贴内容——其中形如 `\x1b[<0;12;5M` 的字节会被 `splitMouseEvents` 静默吃掉。I-3 用整整一条不变量说明这件事在 Tier 1 有多不可接受，却没有覆盖 Tier 2。另外，`--no-mouse` 会话里过滤器根本不该跑鼠标解析（没写 `?1000h`，不会有真报文）。⇒ **已修复于 §5.1（step 0 的 `mouse` 开关与 burst 抑制）/ I-3。**

**P1-8 · AC-7 声称「恢复到进入前的状态」，但设计写的是无条件 `?2004l`；且未解释为何偏离本模块自己的 XTSAVE 纪律。**

`screen.ts` 对 DEC 1007 明确采用 XTSAVE/XTRESTORE，理由写得很清楚：「global terminal state this app does not own」。DEC 2004 是**同一类**全局状态，v1 却直接强关，两者不一致且没有一个字解释。我复核后认为**强关是对的**（终端若忽略 `?2004r` 会把 2004 留在开态，此时不处理 bracketed paste 的 shell 会显示字面 `[200~`，比强关更糟；而 bash / zsh / fish / PSReadLine 都会在下一个提示符自行重开），但「对的选择 + 缺席的理由 + 过度承诺的 AC」这个组合，会诱导下一个维护者把它「修」成保存/恢复。⇒ **已修复于 §5.2（写明理由）/ AC-7（改成诚实措辞）。**

**P1-9 · `budget.ts` 的 A-4 注释明令「不要把动态量加回来」，D-12 没有回应它；而且草稿变高会实时改变 viewport，滚动偏移的后果无人讨论。**

`layout/budget.ts` 逐字写着 "Note what is NOT a parameter … Do not add it back."。`draftRows` 与 A-4 说的「transcript 是否为空」确实不是同一个量，但这处注释是一个强信号，文档必须显式区分而不是绕开。更实际的是后果：viewport 现在会在用户敲 `Shift+Enter` 时缩一行，而 `viewportBudget` 同时喂给 `overlayMaxRows`(`App.tsx:1873`)、`todoRailRows`(`:1883`)、`ScrollViewport`(`:2054`)、`popupMaxRows`(`:2177`)。跟随态与滚动偏移会在打字过程中被反复 clamp——这不是 §5.5 排除掉的那个反馈环，但它是抖动。⇒ **已修复于 D-12 / §5.5（`draftRows` 的迟滞与 clamp 规则）/ R-12。**

### P2

| # | 问题 | 处置 |
| --- | --- | --- |
| P2-1 | `sanitisePaste` 只剥 C0，**C1（U+0080–U+009F，含 U+009B CSI）与 DEL 会活下来**并原样进入 `<Text>`，G2 因此有个窄口子。 | 已修入 §5.1 的 sanitise 步骤。 |
| P2-2 | `PASTE_TOKEN_RE` 以 `/g` 导出。带 `g` 的模块级正则有 `lastIndex` 状态，任何 `.test()` / `.exec()` 调用都会**隔次返回 false**。 | 已修入 §5.3：改导出工厂 `pasteTokenRe()`，并写明只允许 `matchAll` / `replace`。 |
| P2-3 | N5 写「inline 模式不支持 bracketed paste」，读起来像「inline 下不解析 `\x1b[200~`」。实际上过滤器**必须始终**消费这两个标记（`?2004h` 可能是别人开的），只有「写 `?2004h`」是全屏专属。 | 已改写 N5 并补 I-16。 |
| P2-4 | `burst` 状态中途到达 `\x1b[200~` 时的处置顺序未定义。 | 已修入 §5.1 step 2（先冲刷 burst，再进 bracketed）。 |
| P2-5 | 「flush ceiling becomes `max(MAX_PENDING_MOUSE_CHARS, PASTE_BEGIN_MARK.length)`」是空操作：`MAX_PENDING_MOUSE_CHARS` 是 32（`input/mouse-events.ts`），标记长 6。留着它会让实现者以为要动这个常量。 | 已改写为「无需改动，32 已覆盖」。 |
| P2-6 | AC-8 说 `aragon exec` / `-p` / `config set`「执行零行 paste 代码」。`resolvePaste` 在 `loadConfig` 里对每个子命令都会跑，字面上不成立。 | 已把 AC-8 改成「输入路径上零行」。 |
| P2-7 | `screen.ts::setMouseCapture`（`/mouse` 的运行期开关）不得触碰 DEC 2004——粘贴与鼠标捕获是两件正交的事。 | 已修入 §5.2 与 I-16。 |
| P2-8 | R-2 只谈「打字」。中文用户的 **IME 一次上屏**同样可能是一个 ≥ 25 字符的单 chunk，而这份需求本身就是中文写的。 | 已在 R-2 里点名 IME 并给出结论（落在 verbatim 区间，行为与今天相同）。 |
| P2-9 | 收起后的 token 无法再看到原文（N4 / Q-3），而 `[Pasted text #1 +218 lines]` 是**不可逆**的显示——用户想确认自己粘对了没有，只能发出去再看 transcript。 | **记录待办**，不在本轮修：D-9 已把它与 Q-3 绑在一起，单独加一个展开入口会造出第二个真相源。 |

---

## 1. Overview

Pasting into `aragon`'s composer today is not merely ugly — it is **lossy, and it
submits messages the user never asked to send**. The composer has no concept of
a paste at all. Every byte the terminal delivers on stdin is treated as a
keystroke, and a clipboard block is thousands of bytes delivered in an
unpredictable number of chunks. Three independent defects fall out of that one
omission, and each of them produces a different flavour of the "混乱" the
requirement describes: a carriage return that lands alone in a chunk **sends the
half-finished message**; a carriage return that lands in the middle of a chunk is
inserted into the buffer as a literal `\r`, which the terminal obeys by
**overwriting the line it is drawn on**; and a paste that survives both of those
grows the composer to the height of the pasted text, pushing the transcript out
of a frame whose row accounting still believes the composer is three rows tall.
None of the three is visible in a unit test today, because all three live below
Ink, in the layer where nothing in this package looks.

This specification fixes the cause rather than the three symptoms. It gives the
CLI a **paste-aware input layer**: a stream-level filter that recognises a paste
before Ink's key parser can misread it, a terminal mode (`DECSET 2004`,
bracketed paste) that makes that recognition exact rather than heuristic on every
terminal that supports it, and a composer that treats a paste as a *value* rather
than as a very fast typist. Small pastes — the overwhelmingly common case, a
stack trace of four lines, a path, a JSON fragment — are inserted verbatim and
render exactly as typed text renders, which is what "正确整齐地显示在输入框内"
asks for. Large pastes are **collapsed into a placeholder token**,
`[Pasted text #1 +15 lines]`, which occupies one line of the composer, carries
its own size in its label, deletes as a single unit, and expands back to the full
text at the moment the message is sent. The model receives every byte the user
pasted; the composer never has to draw them.

The third piece is the one that makes the first two safe. The composer's height
becomes **bounded and self-scrolling**: a draft of any length occupies at most a
fixed number of rows, keeps the cursor line visible, and reports its true height
to `layout/budget.ts` so the viewport arithmetic is right instead of
approximately right. Without that bound, a paste of 400 lines that we correctly
inserted would still destroy the frame — and so would 400 presses of
`Shift+Enter`, which is a bug the package already has and has never noticed. The
feature is therefore three layers deep on purpose, and each layer is
independently switchable so that a failure in one degrades to the rung below it
rather than to a broken terminal.

---

## 2. Root-cause analysis

Every claim below was read out of the working tree at `packages/cli@0.6.3` and
`node_modules/ink@5.2.1`, not inferred.

### 2.1 Defect A — a pasted newline submits the message

`ink/build/components/App.js:131-138` reads stdin with
`while ((chunk = this.props.stdin.read()) !== null)` on the `'readable'` event
and emits each chunk as one `'input'` event. `ink/build/hooks/use-input.js:44`
hands that whole chunk to `parseKeypress`, and
`ink/build/parse-keypress.js:145-148` maps the exact string `'\r'` to
`name: 'return'`, which `use-input.js:57` turns into `key.return === true`.

`ui/PromptInput.tsx`'s handler then reaches:

```ts
if (key.return) {
  if (key.meta || key.shift) { insert('\n'); return; }
  if (buffer.trim().length === 0) return;
  submit(buffer);        // <-- the message is sent
  return;
}
```

Terminals send **CR, not LF**, for a newline in pasted text — that is what a
typed newline looks like on a tty in raw mode, and xterm and its descendants
normalise pasted newlines to match. So the question is only whether a given CR
lands alone in a `read()`. On a Windows console the answer is routinely *yes*:
input arrives as `KEY_EVENT` records and libuv forwards them a few at a time, so
a 15-line paste can produce a dozen chunks that are exactly `"\r"`. Each one
**submits the draft as it stood at that instant**. The user sees their paste
arrive as five, ten, fifteen separate messages, interleaved with the agent's
replies. This is the single worst thing in this document and it is the first
thing a user hits.

The complementary case is just as bad and completely silent: `parseKeypress`
maps `'\n'` to `name: 'enter'`, which Ink does **not** map to `key.return`
(`use-input.js:52` tests `=== 'return'` only), so a lone LF falls through to
`PromptInput`'s last branch and is dropped by `isControlSeq` — a pasted line
break that simply vanishes, joining two lines of the user's text together with
nothing to indicate it happened.

### 2.2 Defect B — a multi-character chunk is inserted raw, control bytes and all

When a chunk is longer than one character and is not a recognised escape
sequence, `parseKeypress` falls through every branch: `key.name` stays `''` and
`key.sequence` is the **entire chunk**. `use-input.js:65` therefore sets
`input` to the whole chunk, `nonAlphanumericKeys.includes('')` is false, and
`PromptInput`'s final branch runs:

```ts
if (input && !key.tab && !isControlSeq(input)) insert(input);
```

`isControlSeq` inspects **only `input.charCodeAt(0)`**. A chunk that begins with
a printable character is inserted *in full*, including every embedded `\r`,
`\x1b`, `\x07` and NUL it contains. The buffer now holds carriage returns;
`renderWithCursor` splits on `'\n'` only, so each `\r` reaches the terminal
inside a `<Text>` and is executed as a carriage return — the row is overwritten
by whatever follows it. That is the visual corruption in the report. A pasted
ANSI-coloured log is worse still: its SGR sequences repaint the composer's
colours and can leave the rest of the frame inverted or coloured.

### 2.3 Defect C — the composer has no height bound, and the frame's arithmetic says it does

`ui/PromptInput.tsx` renders one `<Text>` per buffer line inside a
`flexShrink={0}` box. `ui/layout/AppShell.tsx` puts the bottom chrome in a
`flexShrink={0}` box and gives the middle band `flexGrow={1} flexShrink={1}
overflow="hidden"` inside a root of fixed `height={frameHeight(rows)}`. So a tall
composer does not make the frame taller — **Yoga takes the rows out of the
transcript, and the transcript is then clipped by `overflow: hidden`**.

Meanwhile `ui/layout/budget.ts::chromeBudget` returns a *constant* `composer: 3`
or `4` (border 2 + input 1 + optional hint 1), and `viewportRows(rows)` subtracts
that constant. `ui/App.tsx:1872` feeds the result to `ScrollViewport`,
`selectWindow`'s spacers, `overlayMaxRows`, `popupMaxRows` and `todoRailRows`.
`ui/BottomStatusRow.tsx:5-27` already documents this exact trap in full — an
extra chrome row that `viewportRows()` does not know about makes "the transcript
draw one row shorter than every consumer believes". A pasted 200-line draft makes
it *197* rows shorter than every consumer believes. Scroll offsets, the virtual
window's spacers and the follow-state maths are all computed against a viewport
that does not exist.

This defect is **pre-existing and reachable without pasting** (200 presses of
`Shift+Enter` do it), which is why fixing it is in scope: a paste feature that
inserts text correctly and then hands it to a composer with no ceiling has not
fixed the user's problem.

### 2.4 Why the fix cannot live in `PromptInput`

Both A and B are decided **before** `PromptInput`'s handler is called — by
`parseKeypress`, on a chunk whose boundaries the component cannot see and cannot
influence. A component-level heuristic ("this `input` looks like a paste") cannot
recover the `key.return` that already fired on a `"\r"` chunk, and cannot
reassemble a paste that arrived as forty chunks. The recognition has to happen on
the byte stream, in front of Ink.

The package has already learned this lesson once and written it down.
`input/stdin-mouse-filter.ts:1-22` exists because Ink 5.2.1 has no mouse branch
and an unfiltered mouse report is "not ignored — it is TYPED INTO THE USER'S
MESSAGE". A paste marker is the same class of byte in the same place, and it gets
the same treatment.

---

## 3. Goals and non-goals

### 3.1 Goals

| G | Goal | Requirement |
| --- | --- | --- |
| G1 | A paste never submits the message. Pasted line breaks become buffer newlines, exactly one per source line break, `CRLF` and lone `CR` included. | 混乱 |
| G2 | No pasted byte is ever executed as a terminal control: no raw `\r`, no `\x1b`, no NUL reaches the rendered draft. | 混乱 |
| G3 | A paste at or below the inline threshold (≤ 6 lines **and** ≤ 400 characters) is inserted verbatim and renders as ordinary multi-line text. | 短内容整齐显示 |
| G4 | A paste above the threshold is replaced in the buffer by `[Pasted text #N +L lines]`, one line tall, and the full text is sent when the message is sent. | `[Pasted text #1 +15 lines]` |
| G5 | The placeholder is a single editable unit: one `Backspace` removes it whole; typing cannot land inside it. | 顶级 HCI |
| G6 | The composer occupies a bounded number of rows whatever the draft contains, scrolls internally to keep the cursor visible, and reports its true height to `layout/budget.ts`. | 整齐 / 稳健 |
| G7 | A submitted message of any size cannot make the transcript unresponsive. | 稳健 |
| G8 | Every layer is switchable, and with the feature fully off the input path is byte-for-byte what it is today. | 可靠 |
| G9 | Every OTHER `useInput` consumer in the package keeps working across a paste: the framed bytes never reach a text field as literal characters, and never reach the config file. | 稳健 (P0-2) |
| G10 | Turning paste on never turns anything else on. In particular `--no-mouse` still writes no mouse sequence and still reports no mouse capability. | 可靠 (P0-1) |

### 3.2 Non-goals

| N | Non-goal | Why |
| --- | --- | --- |
| N1 | Image / file pastes (`iTerm2` OSC 1337, drag-and-drop paths). | A separate feature with its own transport and its own model-side representation. |
| N2 | Re-collapsing a *recalled* prompt-history entry into tokens. | History stores the expanded message (one source of truth). G6's height bound is what keeps a recalled 500-line prompt tidy; re-tokenising it would guess at boundaries the user never drew. Recorded as Q-2. |
| N3 | Showing the collapsed form in the **transcript** after submit. | Considered and rejected — see D-9. |
| N4 | A `/paste` command to inspect or re-open a collapsed block. | Q-3. The token's label already carries the line count; nothing in the requirement asks for more. |
| N5 | **Requesting** bracketed paste (`?2004h`) in **inline** mode (`--no-fullscreen`). | D-6. Inline mode gets the heuristic tier, which needs no terminal-mode change and therefore has no way to leave the user's shell in `?2004h`. **This is a non-goal about WRITING the mode, not about PARSING it**: the filter consumes `[200~` / `[201~` unconditionally in every mode, because something else (the user's shell, `tmux`, a wrapper script) may have left DEC 2004 on — and an unconsumed marker is literal `[200~` in the draft, the exact failure I-1 exists to prevent. See I-16. |
| N6 | Changing what the model receives. | The expanded text is sent verbatim; the placeholder is a rendering concern only. |

---

## 4. Decisions

| D | Decision | Rationale |
| --- | --- | --- |
| **D-1** | Paste recognition lives in the **stdin filter**, in front of Ink, not in `PromptInput`. | §2.4. `parseKeypress` has already fired `key.return` by the time a component can look. |
| **D-2** | `input/stdin-mouse-filter.ts` is **extended and renamed** to `input/stdin-filter.ts`; it strips mouse reports *and* frames pastes. Two filters chained would need two `PassThrough`s and would reopen the ordering hazard the mouse module's "ONE CHANNEL, NOT TWO" note closes. | One reader of the real stdin, one wrapper handed to Ink, one ordering. |
| **D-3** | A paste is delivered to the composer **inline on the same stream**, wrapped in NUL-delimited markers — *not* on a side channel like mouse events. | Ordering. `wrapper.write(text)` is delivered asynchronously; a synchronous side-channel emit would apply the paste **before** text that preceded it in the same chunk. Framing preserves order by construction. NUL is chosen because no terminal ever sends it, and the filter strips every other NUL from ordinary input so the framing cannot be forged. |
| **D-4** | Two detection tiers. **Tier 1** = bracketed paste (`\x1b[200~ … \x1b[201~`), exact. **Tier 2** = a heuristic on chunk shape, used when the terminal ignored `?2004h`. | Tier 1 is unavailable on some terminals and in inline mode; Tier 2 alone already fixes A and B. Both feed the same framing, so the composer has one code path. |
| **D-5** | Tier 2's primary rule is **"a chunk longer than one character that contains a line break is a paste."** A human keystroke cannot produce that. Its secondary rule is "a chunk of ≥ 25 printable characters with no line break is a paste", which is safe because coalescing a keyboard burst into 25 characters within one event-loop turn requires roughly 1 500 WPM. | Both rules are about what a *keyboard* can physically emit, not about what text looks like. |
| **D-6** | `?2004h` is written **only in full-screen mode**, through `ui/screen.ts`, and **only when a filter is installed** — the exact discipline `AltScreenOptions.mouse` documents (I-8). | `screen.ts` is the one module with four proven restore paths (`process.on('exit')`, `setScreenRestore`, `setSignalTerminator`, `waitUntilExit`). A `?2004h` left set after a `kill` makes *every* subsequent paste in the user's shell arrive wrapped in literal `[200~`/`[201~` — strictly worse than the bug being fixed, and fixable only by `reset`. Inventing a second owner of terminal modes for the degraded rung is not worth that. |
| **D-7** | The placeholder is a **display token in the buffer** plus a payload map in editor state, expanded at submit — not an out-of-band attachment rendered above the input. | The requirement's example is inline, and inline tokens let the user place a paste relative to their own words ("explain this: `[Pasted text #1 +218 lines]` — why does it retry?"). |
| **D-8** | Tokens are atomic for **editing** (delete/kill ranges snap outward to cover a whole token; the caret snaps out of a token before an insert) but **not** for cursor movement (arrows step by character). | Atomic editing removes every realistic way to corrupt a token; atomic movement would mean re-deriving `moveVertical`, `home`/`end` and word jumps around a synthetic unit, for a case the user cannot notice. |
| **D-9** | The **transcript shows the expanded text**, not the token. | A collapsed entry with no expand affordance hides what the user sent. G7 (the entry row cap, §5.6) is what keeps a large entry cheap, and the cap names the number of hidden rows rather than hiding them silently. Revisit only together with an expand affordance (Q-3). |
| **D-10** | Structural bounds live in `input/limits.ts` and `ui/composer-limits.ts`; the only user-facing key is the boolean `paste`. | The package convention recorded in `.claude-index/index.md`: "`limits.ts` is structural, `config/schema.ts` is policy." A tunable threshold is a preference nobody has asked for; the kill switch is what a bug report needs. |
| **D-11** | A paste that exceeds `PASTE_MAX_BYTES` is **rejected with a toast naming the size and the limit**, leaving the buffer untouched — never silently truncated. | Truncation loses user data and looks like success. |
| **D-12** | `viewportRows` / `chromeBudget` gain an **optional** `draftRows` parameter defaulting to `1`, i.e. to today's constant. (v1 called it `composerRows` in this row and `draftRows` in §5.5; `draftRows` is the name.) | Every existing caller and every existing assertion in `budget.test.ts` stays byte-identical; the new call site passes the real number. **`budget.ts` carries an explicit "Do not add it back" note (A-4) about dynamic parameters, and this decision does not overrule it**: A-4 forbids making the budget depend on *transcript* content, so that the first submitted message cannot make the layout jump. `draftRows` depends only on what the user is typing, and its whole purpose is that the jump is already happening — silently, and without the budget knowing. §5.5 adds the hysteresis that keeps it from becoming a per-keystroke jitter. |
| **D-13** | The filter is installed whenever `stdin.isTTY` **and** at least one stream-level feature is on (mouse **or** paste). `--no-mouse --no-paste` restores the unwrapped `process.stdin`. | This restates, rather than deletes, `cli.tsx`'s I-5 ("with mouse support off the REAL stdin is handed over unwrapped"): the property that matters is *"with every stream feature off, nothing is wrapped"*, and that stays literally true and testable. |
| **D-17** | **The filter handle stops being the answer to "is the mouse on?".** `cli.tsx` gains one explicit boolean, `mouseOn = wantMouse && filter !== null`, and the five sites that read `mouseFilter !== null` today read *that* instead. The filter is told which features it is running (`{ mouse, paste }`) at construction. | Without this, D-13 is a **regression, not a widening** (P0-1): `paste` defaults to `true`, so `aragon --no-mouse` would build a filter, and `enterAltScreen` (`cli.tsx:704`), `wantSelect` (`:614`), `mouseCaptured` (`:790`) and `mouseSource` (`:872`) would all read it as "mouse support is on" — writing `?1000h`/`?1006h`/`?1002h` and advising the user about a mode they explicitly disabled. `App.tsx:186-188` documents `mouseSource`'s contract as "absent under `--no-mouse`, inline, or non-TTY"; only an explicit `mouseOn` keeps that true. |
| **D-14** | The paste id counter is **monotonic for the process**; the payload map is **per draft** and cleared by `clear`. | Two drafts never show `#1` for different content within one session, which is what makes a token in a scrolled-back transcript unambiguous. |
| **D-15** | Wrapping in the composer is a **hard wrap by display column** (`string-width`), never `layout/wrap-rows.ts::wrapToRows`. | `wrapToRows` is a *prose* wrapper: it splits on `/\s+/` and rejoins with single spaces, so it destroys indentation and makes the character-index-to-screen-cell mapping the cursor depends on impossible. |
| **D-16** | `input/` is added to `glyphs.test.ts::inScope`. | The scanner is a hardcoded directory list and `input/` has never been in it. This feature puts user-visible decisions there; a scanner that silently stops scanning is worse than no scanner (the package has paid for this nine times). All 29 existing non-ASCII lines under `input/` are inside comments, which `stripComments` blanks, so the scan is expected to pass unchanged — the implementer must confirm by running the suite. |

---

## 5. Technical design

### 5.0 Layer map

```
   terminal
      |  bytes (keystrokes, mouse reports, bracketed-paste markers, paste payload)
      v
+--------------------------------------------------------------+
| L1  input/stdin-filter.ts        (real stdin -> PassThrough)  |
|      - strips SGR/X10 mouse reports   [only if features.mouse]|
|      - Tier 1: consumes \x1b[200~ ... \x1b[201~  (always)     |
|      - Tier 2: classifies chunk shape, coalesces bursts       |
|      - sanitises payload (CRLF->LF, CR->LF, strip C0/C1/DEL)  |
|      - emits  \0[  <payload>  \0]  inline, in order           |
|      - PasteBridge.notify(...) for a refused paste            |
+--------------------------------------------------------------+
      |  wrapper stream
      v
   ink  ->  parseKeypress  ->  useInput(input, key)
      |
      v
+--------------------------------------------------------------+
| L3  ui/PromptInput.tsx                                        |
|      - splitPasteFrames(input) -> ordered segments            |
|        (text runs already through sanitiseTyped -- I-14)      |
|      - draft-level limit check, then ONE dispatch             |
| L3  ui/paste-tokens.ts        (pure: format/find/snap/expand) |
| L3  ui/editor-reducer.ts      (+ pastes map, + input action)  |
+--------------------------------------------------------------+
| L3' every OTHER useInput consumer  (I-12)                     |
|      SettingsScreen / QuestionOverlay:                        |
|        value += stripPasteFrames(input)                       |
+--------------------------------------------------------------+
      |
      v
+--------------------------------------------------------------+
| L4  ui/composer-rows.ts       (pure: hard wrap, window, caret)|
| L4  ui/layout/budget.ts       (+ draftRows parameter)         |
+--------------------------------------------------------------+
      |
      v  submit: expandPastes(buffer, pastes) -> onSubmit(full)
```

`L2` is `ui/screen.ts`: it writes `?2004h` on entry and `?2004l` on every exit
path. It has no runtime interaction with the others beyond deciding whether Tier
1 can fire.

### 5.1 L1 — the stdin filter

`input/stdin-mouse-filter.ts` becomes `input/stdin-filter.ts`. Its existing
contract is preserved exactly: it reads the real stdin, forwards non-mouse bytes
into a `PassThrough` carrying the surface Ink requires (`isTTY` getter,
`setRawMode`, `ref`, `unref`), emits `MouseEvent`s to subscribers, and disposes
idempotently.

Two things are added.

**A paste state machine**, held alongside the existing `pending` tail:

```ts
type PasteState =
  | { kind: 'idle' }
  | { kind: 'bracketed'; body: string; startedAt: number }   // Tier 1, inside \x1b[200~
  | { kind: 'burst'; body: string; lastAt: number };         // Tier 2, coalescing
```

**`onData(chunk)` becomes an ordered scan**, and the order of the tests below is
the specification:

0. **Is mouse parsing running at all?** The filter is constructed with
   `{ mouse, paste }` (D-17) and `splitMouseEvents` runs **only when `mouse` is
   true**. A `--no-mouse` session never wrote `?1000h`, so no real report can
   arrive; running the parser anyway would only ever *eat* pasted bytes that
   happen to look like one. With `mouse: false` this step degenerates to "pass
   the text on", which is byte-identical to the unwrapped stream.
1. **If `state.kind === 'bracketed'`**: search the chunk for `PASTE_END_MARK`
   (`\x1b[201~`). Everything before it is appended to `body`. **No mouse parsing
   runs on paste payload** (I-3): a pasted terminal log legitimately contains
   `\x1b[<0;12;5M`, and eating those bytes would corrupt the user's data. On
   finding the end marker the paste is emitted (step 4) and the scan continues
   after it in state `idle`. If the marker is absent and `body` exceeds
   `PASTE_MAX_BYTES`, or `now - startedAt > PASTE_ASSEMBLY_MAX_MS`, the paste is
   force-emitted and a warning is logged — an unterminated paste must never
   wedge input, which is the rule `MAX_PENDING_MOUSE_CHARS` already encodes for
   mouse reports.
2. **Otherwise, scan for `PASTE_BEGIN_MARK` (`\x1b[200~`)** *and* - when step 0
   left mouse parsing on - for mouse reports, taking whichever occurs first.
   Text before the winner is passed through as today. A trailing strict prefix
   of either marker becomes `pending` and is retried with the next chunk, under
   the existing 12 ms flush timer. `isMousePrefix` is joined by `isPastePrefix`;
   the pending ceiling **needs no change** - `MAX_PENDING_MOUSE_CHARS` is 32 and
   the longest paste marker is 6, so 32 already covers both. (v1 said the ceiling
   "becomes `max(MAX_PENDING_MOUSE_CHARS, PASTE_BEGIN_MARK.length)`", which is
   the same number written in a way that invites someone to edit the constant — P2-5.)
   **If `PASTE_BEGIN_MARK` is found while `state.kind === 'burst'`, the burst is
   flushed FIRST** (step 4) and only then does the state become `bracketed`, so
   the two bodies can never be concatenated into one token out of order (P2-4).
3. **Tier 2** applies only to text that reached step 2's pass-through:
   `classifyChunk(text)` returns `'paste' | 'keys'`.
   - `'paste'` if `text.length > 1 && /[\r\n]/.test(text)`;
   - `'paste'` if `text.length >= PASTE_MIN_BURST_CHARS` and the text contains no
     C0 byte other than `\t`;
   - `'keys'` otherwise.

   A `'paste'` classification enters state `burst`, and any further chunk arriving
   within `PASTE_BURST_MS` is appended to the same body instead of being
   classified afresh. **While `burst` is open, mouse parsing is suspended for the
   appended chunks exactly as it is inside a `bracketed` body** (I-3): the Tier 2
   population is precisely the terminals with no bracketed paste, and the most
   likely thing such a user pastes into a TUI dev tool is a terminal log full of
   `\x1b[<0;12;5M`-shaped bytes. Suspending here is what makes I-3 a property of
   *pastes* rather than a property of *Tier 1*. A timer flushes the burst.
   **Ordinary typing never enters `burst`**, so it never pays the 15 ms latency.
4. **`emitPaste(body)`** runs `sanitisePaste`, drops the result if empty, and
   writes `PASTE_OPEN + payload + PASTE_CLOSE` into the wrapper in **one**
   `wrapper.write()` call, at the position the paste occupied in the stream.

`sanitisePaste(raw)` is pure and exported for test:

```
1. \r\n        -> \n    (CRLF, Windows clipboards)
2. \r          -> \n    (lone CR, the xterm paste convention)
3. strip \x00
4. strip every other C0 byte except \n and \t   (ESC, BEL, backspace, ...)
5. strip \x7f (DEL) and every C1 byte U+0080..U+009F
6. \t          -> kept  (indentation is content)
```

Steps 3-5 are what make G2 true for *pasted* bytes; they are applied to payload
only, never to keystrokes, so `Ctrl+A` and the Escape key keep working.

**Step 5 is not padding** (P2-1). U+009B is the single-byte CSI and U+0085 is NEL;
a terminal that decodes them acts on them exactly as it acts on `\x1b[`. The
payload's only defence is this function - Ink writes `<Text>` children through to
the terminal without escaping anything - so "strip C0" alone leaves a hole that a
file pasted out of a non-UTF-8 editor walks straight through.

Framing constants:

```ts
export const PASTE_OPEN  = '\u0000[';   // NUL + '['
export const PASTE_CLOSE = '\u0000]';   // NUL + ']'
```

They are unforgeable because step 3 removes every NUL from every payload and
because a terminal does not deliver NUL for any key.

**Backpressure, and the coalescing that comes with it.** `wrapper.write()` may
return `false` for a large payload; the filter ignores the return value exactly
as it does today. Data is buffered, Ink calls `setEncoding('utf8')` on the stream
it is handed (`App.js:114`) and drains with a size-less `read()` (`App.js:135`),
which returns the **whole** buffered string. So a paste is never split across two
`'input'` events by the stream itself.

That same property runs in the other direction and it is **not** a detail: two
`wrapper.write()` calls that land before Ink drains arrive as **one** `input`
string. A frame can therefore be concatenated with whatever keystroke bytes
follow it - most obviously the `\r` of a user who pastes and immediately presses
Enter, since Ink's 32 ms render throttle and a large transcript's Yoga pass both
outlast the 15 ms burst window. §5.4 is where that is handled; the filter cannot
handle it, because it does not control when Ink drains.

#### 5.1.1 What the filter is told, and what `cli.tsx` stops inferring (D-17 / P0-1)

`createStdinFilter(real, features)` takes an explicit feature set:

```ts
export interface StdinFilterFeatures {
  /** Parse and strip SGR / X10 mouse reports, and emit `MouseEvent`s. */
  readonly mouse: boolean;
  /** Recognise pastes and deliver them framed. */
  readonly paste: boolean;
}
export function tryCreateStdinFilter(
  real: NodeJS.ReadStream,
  features: StdinFilterFeatures,
  onError?: (reason: string) => void,
): StdinFilter | null;
```

With `{ mouse: false, paste: true }` the filter emits no `MouseEvent` ever, and
`filter.source.subscribe` returns a working unsubscribe over a channel that stays
silent. With `{ mouse: true, paste: false }` it is byte-for-byte the v0.6.3 mouse
filter.

`cli.tsx` then reads:

```ts
const wantPaste = config.paste && !!process.stdin.isTTY;
const filter =
  wantMouse || wantPaste
    ? tryCreateStdinFilter(process.stdin, { mouse: wantMouse, paste: wantPaste }, onErr)
    : null;

/**
 * THE ONE EXPRESSION THE MOUSE SITES READ. `filter !== null` stopped being the
 * answer to "is the mouse on?" the moment paste could build a filter on its own.
 */
const mouseOn = wantMouse && filter !== null;
const pasteOn = wantPaste && filter !== null;
```

and every one of the five sites below is rewritten to read `mouseOn`:

| Site (v0.6.3) | v1 would have given it | v2 gives it |
| --- | --- | --- |
| `enterAltScreen(..., { mouse })` (`cli.tsx:704`) | `filter !== null` | `mouseOn` |
| `wantSelect` (`:614`) | `filter !== null && config.mouseSelect` | `mouseOn && config.mouseSelect` |
| `mouseCaptured` (`:790`) | `filter !== null` | `mouseOn` |
| `mouseSource` prop (`:872`) | `filter?.source` | `mouseOn ? filter?.source : undefined` |
| `stdin` handed to `render()` (`:891`) | `filter?.stdin ?? process.stdin` | unchanged - this one *is* about the filter |

The last row is the point: exactly one of the five is genuinely a question about
the stream, and it is the only one that keeps reading the handle.
`enterAltScreen` additionally gets `bracketedPaste: pasteOn && mode === 'fullscreen'`
(D-6).

#### 5.1.2 How a rejected paste reaches the user (P1-3)

The filter is built in `cli.tsx` **before** `render()`, so it has no `dispatch`.
Its only outlet today is the `onError` logger callback, and a limit that only
writes to a log file is indistinguishable, from the user's chair, from a paste
that did nothing. D-11 therefore needs a channel, and the package already has
three of the same shape (`selectionBridge`, `updateBridge`, `terminalBridge`):

```ts
export interface PasteBridge {
  /** Set by `App` on mount; read by the filter. Null until then. */
  notify: ((level: 'warn' | 'error', text: string) => void) | null;
}
```

`cli.tsx` creates the object, hands it to `tryCreateStdinFilter` and to `<App>`;
`App` assigns `bridge.notify = (level, text) => dispatch({ type: 'notice', level, text })`
in an effect and clears it on unmount. The filter calls `bridge.notify?.(...)`, so
a rejection that happens before mount (impossible in practice - nothing can be
pasted before the first frame) degrades to the log line it writes anyway.

This is also the channel §5.3's draft-level limits use, which is why it is a
bridge rather than a filter-only constructor argument.

### 5.2 L2 — bracketed paste mode

`ui/screen.ts` gains:

```ts
const ENABLE_BRACKETED_PASTE  = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

export interface AltScreenOptions {
  readonly mouse: boolean;
  readonly motion?: boolean;
  /**
   * TRUE MEANS "A FILTER THAT CONSUMES \x1b[200~ IS ALREADY INSTALLED", NOT
   * "the user wants paste support" -- the same discipline `mouse` carries (I-8).
   * Enabling DEC 2004 without a filter does not degrade the feature: it types
   * `[200~` and `[201~` into the user's message on every paste, which is
   * strictly worse than the bug being fixed.
   */
  readonly bracketedPaste?: boolean;
}
```

Optional and defaulting to `false`, so every existing caller and every assertion
in `screen.test.ts` emits exactly the bytes it emits today. `restore()` appends
`DISABLE_BRACKETED_PASTE` when, and only when, the session enabled it — placed
**before** `SHOW_CURSOR + LEAVE_ALT`, alongside the mouse disables, for the reason
I-2 already gives.

`cli.tsx` passes `bracketedPaste: pasteOn && mode === 'fullscreen'` (§5.1.1). It is
**not** `filter !== null && config.paste`, for the reason D-17 gives: after D-13 the
handle no longer answers any question except "is a stream wrapped?".

**Why `restore()` forces `?2004l` instead of saving and restoring it (P1-8).** This
module already treats one piece of unowned global terminal state with XTSAVE /
XTRESTORE - DEC 1007, alternate scroll - and says so at length. DEC 2004 is the same
class of state and gets the **opposite** treatment, so the reason has to be written
down or the next reader will "fix" the inconsistency:

- `\x1b[?2004r` on a terminal that does not implement XTSAVE is a **no-op**, which
  leaves 2004 **on**. A shell that does not itself speak bracketed paste then shows a
  literal `[200~` on every paste until the user runs `reset` - the exact I-1 failure,
  arriving from the restore path.
- Forcing `?2004l` has no such failure mode. Every shell that *does* use bracketed
  paste (bash >= 4.4 readline, zsh ZLE, fish, PSReadLine) re-arms it when it draws its
  next prompt, so the user-visible state after `aragon` exits is the state they had.
  Every shell that does not use it was already off.

So the asymmetry is deliberate: 1007 is saved because getting it wrong silently
changes a preference; 2004 is forced because getting it wrong visibly breaks pasting,
and the forced value is the one every consumer re-establishes for itself. AC-7 is
worded to match what this actually delivers.

**`setMouseCapture` must not touch DEC 2004** (P2-7 / I-16). `/mouse off` releases the
pointer; it says nothing about pasting, and a user who turns the mouse off mid-session
to select text with their terminal must not silently lose Tier 1 as well. The two
modes are written by different call sites and unwound by different flags in
`restore()`.

### 5.3 L3 — paste tokens

New pure module `ui/paste-tokens.ts`. No Ink, no React, no I/O.

```ts
export interface PasteRecord {
  readonly id: number;
  readonly text: string;     // sanitised payload, exactly what is sent
  readonly lines: number;    // text.split('\n').length
  readonly chars: number;    // [...text].length
}

/** `[Pasted text #3 +218 lines]` / `[Pasted text #4 +1204 chars]` */
export function formatPasteToken(record: PasteRecord): string;

/**
 * Strict, anchored, ASCII-only. Group 1 is the id.
 *
 * A FACTORY, NOT A SHARED CONSTANT (P2-2). A module-level `/g` RegExp carries
 * `lastIndex` between calls, so `re.test(x)` returns false on every second call
 * with the same input - a bug that shows up as "token detection works, then
 * randomly does not". Callers must use `matchAll` or `replace` (both of which
 * are safe) on a FRESH instance; nothing in this module may call `.test()` or
 * `.exec()` on a `/g` regex it did not just create.
 */
export function pasteTokenRe(): RegExp;   // /\[Pasted text #(\d+) \+\d+ (?:lines|chars)\]/g

/** The token containing or touching `index`, or null. */
export function tokenAt(
  buffer: string,
  index: number,
): { start: number; end: number; id: number } | null;

/** Move a caret that landed strictly inside a token to its nearer edge. */
export function snapOutOfToken(buffer: string, cursor: number): number;

/** Grow [from,to) so it covers every token it partially overlaps. */
export function expandRangeOverTokens(
  buffer: string,
  from: number,
  to: number,
): { from: number; to: number };

/** Replace every token whose id is present in `pastes`; leave the rest verbatim. */
export function expandPastes(
  buffer: string,
  pastes: ReadonlyMap<number, PasteRecord>,
): string;

/** Ids still referenced by the buffer — used to drop orphans on every edit. */
export function referencedIds(buffer: string): Set<number>;

export function shouldCollapse(text: string): boolean;   // > 6 lines || > 400 chars
```

`formatPasteToken` uses `+L lines` when `lines > 1` and `+C chars` when the paste
is a single long line, because "`+1 lines`" is not a sentence and the number the
user cares about for a one-liner is its length.

**Editor state.** `ui/editor-reducer.ts::EditorState` gains one field:

```ts
readonly pastes: ReadonlyMap<number, PasteRecord>;
```

and the action union gains one member:

```ts
| { type: 'input'; segments: InputSegment[] }
```

where `InputSegment = { kind: 'text'; text: string } | { kind: 'paste'; text: string; id: number }`.
This is the **only** new action, and it is what keeps the one-dispatch-per-key rule
(`editor-reducer.ts`'s "THE RULE A REVIEWER SHOULD CHECK LINE BY LINE") true for a
chunk that mixes typing and pasting.

**The paste id is allocated by the handler and travels in the action (P1-5).** v1 put
`nextPasteId++` inside the reducer and justified it with "a reducer must stay pure" -
which is exactly backwards: reading and writing module state *from inside the reducer*
is what makes it impure. React is explicitly allowed to call a reducer more than once
for a single action (`dispatchSetState`'s eager evaluation, base-queue replay after a
bailout, StrictMode double-invocation); when it does, the ids skip and the two
computed states differ in the token *text*, not just in identity. Even with no replay
at all, allocating at reduce time makes the rendered token unpredictable for a unit
test. So `PromptInput` calls `allocatePasteId()` while building the segments, and the
reducer is a pure function of `(state, action)` again.

Its reducer:

```
cursor := snapOutOfToken(buffer, cursor)             // D-8
for each segment, in order:
  text segment  -> splice sanitiseTyped(text) at cursor   // 5.4, P1-1
  paste segment -> if shouldCollapse(text):
                       splice formatPasteToken({id: seg.id, ...}) at cursor
                       pastes := pastes + record
                   else:
                       splice text at cursor         // verbatim, G3
apply DRAFT_FLAGS
```

**Pruning is a wrapper, not a line in one branch (P1-6).** I-7 says `pastes` is pruned
on *every* buffer-changing action; v1's body pruned only inside `input`, which leaves
`replace` (the action behind `Ctrl+U` / `Ctrl+K` / `Ctrl+W` and every `applyEdit`),
`backspace` and `recall` able to delete a token without releasing its payload. A rule
the body contradicts is worse than no rule, because the next reader trusts the
invariant. The reducer therefore ends with one helper applied at a single point:

```ts
const withPrune = (next: EditorState): EditorState => {
  const live = referencedIds(next.buffer);
  if (live.size === next.pastes.size) return next;       // fast path: nothing dropped
  const kept = new Map([...next.pastes].filter(([id]) => live.has(id)));
  return { ...next, pastes: kept };
};
```

wrapped around the return of `insert`, `replace`, `backspace`, `recall` and `input` -
i.e. exactly the actions that already reset `DRAFT_FLAGS`, plus `recall`. `moveCursor`,
`select` and `dismiss` do not change the buffer and are left alone, which keeps their
"return the same object so React bails out" property intact.

**The three size limits, and where each one is enforced (P1-4).** §8 lists three, and
v1 gave an enforcement point for only the first:

| Limit | Enforced in | On breach |
| --- | --- | --- |
| `PASTE_MAX_BYTES` (one paste) | `input/stdin-filter.ts`, at `emitPaste` | Drop the body, emit no frame, `bridge.notify('warn', ...)` (§5.1.2). The buffer never sees it. |
| `PASTE_DRAFT_MAX_BYTES` (all live payloads) | `PromptInput`, **before** `dispatch` | Build no segments, `notify`, leave the draft untouched. |
| `PASTE_MAX_BLOCKS` (tokens in one draft) | `PromptInput`, **before** `dispatch` | Same. |

The last two cannot live in the filter (it does not know the draft) and cannot live in
the reducer (it is pure, so it can neither raise a toast nor tell the caller why it
refused). The component is the only place that holds both facts, and it is on the
`useInput` path, so the check is a couple of additions against `editor.pastes` before
the single dispatch - the one-dispatch-per-key rule is unaffected because a refusal
dispatches nothing at all.

`backspace` and every `applyEdit` kill range are routed through
`expandRangeOverTokens`, which is what makes G5 true: `Backspace` immediately
after `…lines]` removes the whole token and its payload in one keystroke, and
`Ctrl+W` / `Ctrl+U` / `Ctrl+K` cannot leave a half-token behind.

`clear` resets `pastes` to an empty map, so submitting or `/clear` releases every
payload. Together with `withPrune` the map cannot outlive the buffer that
references it, which is the whole of the memory story inside the composer.

**Submit.** `PromptInput.submit` becomes:

```ts
const submit = (text: string) => {
  onSubmit(expandPastes(text, editor.pastes));
  dispatch({ type: 'clear' });
};
```

`onSubmit`'s signature is unchanged, so `Composer`, `App.handleSubmit`,
`runSlashInput` and `submitMessage` are all untouched (D-9). A slash command
therefore sees the expanded text, which is the correct behaviour for
`/skill foo <pasted body>`.

**Forgery.** A user who literally types `[Pasted text #3 +9 lines]` while paste
`#3` exists in the same draft will have it expanded. This is bounded (ids are
per-process, the map is per-draft), harmless (the user gets text that is already
in their own draft), and the alternative — an unguessable nonce in the label —
would trade a case nobody hits for a label nobody can read.

### 5.4 L3 — reading frames out of `input`

New pure module `ui/paste-frames.ts`:

```ts
export function splitPasteFrames(input: string): InputSegment[];
export function sanitiseTyped(text: string): string;
export function stripPasteFrames(input: string): string;
```

`splitPasteFrames` splits on `PASTE_OPEN` / `PASTE_CLOSE`, preserving order, and
returns text runs and paste runs interleaved. An unmatched `PASTE_OPEN` (impossible
from our own filter, but cheap to survive) yields its remainder as a paste segment.

**`sanitiseTyped` is the fix for the coalescing hazard (P1-1), and it is not optional.**
Ink drains its whole buffer in one `read()` (§5.1, Backpressure), so the `input` string
that carries a frame can also carry the keystroke bytes that arrived beside it - most
often the `\r` of a user who pastes and immediately presses Enter, sometimes an arrow
key's `\x1b[A`. v1 spliced those text runs into the buffer verbatim, which puts a raw
CR back into the draft and re-opens §2.2 through the very branch that was added to
close it. So every **text** segment is passed through:

```
sanitiseTyped(s) = s with every C0 byte, DEL and C1 byte removed
                   (NO CR -> LF conversion: see below)
```

Note what it does **not** do. It does not turn a coalesced `\r` into a newline and it
does not submit: a keystroke that merged with a frame has already lost its identity as
a key (`parseKeypress` saw the concatenation, not the key), so the only two honest
options are "insert something wrong" and "drop it". Dropping is recoverable and
silent-but-benign - the user presses Enter again - while inserting a control byte is
the corruption this whole feature exists to remove. Printable characters in a text
segment survive untouched, which is what keeps `abc` + paste in one chunk correct
(T-5).

`PromptInput`'s handler gains **one branch, placed immediately before the
existing `isControlSeq` guard and after every key branch**:

```ts
if (input.includes(PASTE_OPEN)) {
  const segments = splitPasteFrames(input);   // text runs already sanitised
  if (!withinDraftLimits(segments, editor)) { notify(...); return; }   // 5.3, P1-4
  dispatch({ type: 'input', segments });
  return;
}
```

It must sit after the key branches so a paste can never be shadowed by a key
test, and before `isControlSeq` because the framed string starts with NUL and
would otherwise be dropped.

#### 5.4.1 Every OTHER `useInput` consumer (P0-2)

`useInput` is a **broadcast**: `use-input.js` re-emits each `'input'` chunk to every
mounted handler. `PromptInput` is not the only one - there are six in this package,
and two of them append `input` to a text field verbatim:

| Consumer | Line | What it does with a framed paste in v1 |
| --- | --- | --- |
| `ui/overlays/SettingsScreen.tsx` | `:467` | `setValues(prev[field] + input)` - **stores `\u0000[...]\u0000]` into the API key field** |
| `ui/overlays/QuestionOverlay.tsx` | `:158` | `setDraft(draft + input)` - same, into a free-text answer |
| `ui/overlays/ConfirmDialog.tsx` | `:45` | compares against `'y'` / `'n'`; a frame matches neither, so it is inert |
| `ui/overlays/PlanReviewOverlay.tsx` | `:63` | key-driven only; inert |
| `ui/App.tsx` | `:1634` | global keys only; inert |

The `SettingsScreen` row is a **regression against v0.6.3 that corrupts a persisted
credential**, and it is not a corner case: `App.tsx:1477-1479` says in so many words
that "the same Enter press is often carrying a freshly pasted API key". An API key is
~100 characters with no line break, so it trips Tier 2's `PASTE_MIN_BURST_CHARS` rule
and gets framed. Nothing downstream removes the NULs - `String.prototype.trim()` does
not treat U+0000 as whitespace - the field is rendered through `maskDot` so the damage
is invisible, and `App.tsx:1492-1500` hands the value to `registerSecret()` and
`controller.setApiKey()`. The user is told the settings were saved, and every request
afterwards fails to authenticate with nothing on screen to explain it.

**The fix is one shared helper and two one-line call sites.** `sanitiseTyped` above is
paired with:

```ts
/**
 * Turn a possibly-framed `input` into plain text for a consumer that has no paste
 * model of its own: unwrap the frames, keep the payload, drop the markers, and run
 * BOTH halves through `sanitiseTyped`.
 *
 * Any `useInput` consumer that appends `input` to a string MUST call this. The list
 * is pinned by a test (T-30) rather than by discipline, because the failure is
 * invisible: NUL renders as nothing.
 */
export function stripPasteFrames(input: string): string;
```

so `SettingsScreen` becomes `... + stripPasteFrames(input)` and `QuestionOverlay` the
same. This is strictly better than v0.6.3 for both of them: a pasted key that contains
a stray CR or an ANSI sequence is now cleaned rather than stored raw.

Two alternatives were rejected. **Filtering per-consumer with `isActive`** does not
work: the overlays are exactly the consumers that are active when `PromptInput` is
not, so there is no configuration in which nobody sees the frame. **Emitting pastes
only while the composer is focused** would require the filter to know the React tree,
which is the coupling D-1 and D-3 exist to avoid.

### 5.5 L4 — a bounded, tidy composer

New pure module `ui/composer-rows.ts`:

```ts
export interface ComposerSegment { readonly text: string; readonly kind: 'text' | 'token'; }
export interface ComposerRow { readonly segments: ComposerSegment[]; }

export interface ComposerLayout {
  readonly rows: ComposerRow[];     // at most `maxRows`
  readonly cursorRow: number;       // index into `rows`, or -1 when inactive
  readonly cursorCol: number;       // display column within that row
  readonly totalRows: number;       // before the window was applied
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

export function layoutComposer(input: {
  buffer: string; cursor: number; cols: number; maxRows: number; active: boolean;
}): ComposerLayout;
```

It (a) splits the buffer on `\n`, (b) hard-wraps each logical line at `cols`
**display columns** measured with `string-width` (D-15), (c) marks the runs that
belong to a token so the renderer can dim them, (d) locates the caret's row and
column, and (e) selects a window of at most `maxRows` rows that contains the
caret, reporting how many rows are hidden above and below.

`PromptInput` renders `layout.rows` and, when `hiddenBelow > 0` or
`hiddenAbove > 0`, a right-aligned fixed-width indicator on the last row built
from `glyphs.arrowUp` / `glyphs.arrowDown` — the same fixed-cell discipline the
existing scroll chip uses (P2-4 of `tui-selection-and-scroll-follow`), so a
number gaining a digit cannot re-wrap the draft.

`maxRows` comes from a new export in `ui/composer-limits.ts`:

```ts
export function draftMaxRows(terminalRows: number): number {
  if (terminalRows >= 30) return 10;
  if (terminalRows >= HINT_MIN_ROWS) return 6;
  return 3;
}
```

Non-decreasing in `terminalRows`, which is what keeps `viewportRows` monotonic.

**Budget.** `ui/layout/budget.ts`:

```ts
export function chromeBudget(rows: number, draftRows = 1): ChromeBudget;
export function viewportRows(rows: number, draftRows = 1): number;
```

`composer` becomes `2 /* border */ + clamp(draftRows, 1, draftMaxRows(rows)) +
(rows >= HINT_MIN_ROWS ? 1 : 0)`. With `draftRows = 1` this is exactly today's
`3` / `4`, so `budget.test.ts` passes unchanged and D-12 holds.

`PromptInput` reports its row count upward through the existing draft callback,
widened from `(hasDraft: boolean)` to `(state: { hasDraft: boolean; rows: number })`
and still fired **only on change** — the row count changes far less often than a
keystroke, so `App` re-renders on a line break, not on a character. `Composer`
forwards it; `App` holds it in state and passes it to `computeViewportRows`.

There is **no feedback loop**: the composer's height depends on the buffer and on
`cols`, never on `viewportRows`.

**But there is jitter, and it needs a rule (P1-9).** `viewportBudget` is not consumed
by the transcript alone; `App.tsx` feeds the same number to `overlayMaxRows` (`:1873`),
`todoRailRows` (`:1883`), `ScrollViewport` (`:2054`) and `popupMaxRows` (`:2177`). Once
`draftRows` is real, every `Shift+Enter` re-clamps a scroll offset and re-sizes an open
overlay. Three rules keep that from being felt:

1. **Report on change only, and only the clamped value.** `PromptInput` emits
   `clamp(rows, 1, draftMaxRows(terminalRows))`, so a 218-line draft and a 400-line
   draft report the same number and the transcript stops moving once the composer is
   full.
2. **Growth is immediate, shrink is deferred by one render tick.** Growing must be
   instant or the composer overdraws the frame for a frame. Shrinking immediately, on
   the other hand, makes a `Backspace` that crosses a wrap boundary bounce the whole
   transcript; deferring it to the next scheduled render coalesces a run of deletions
   into one move.
3. **The scroll offset is re-clamped, never re-anchored.** `ScrollViewport` already
   clamps `offset` against its measured height; `draftRows` changes must go through
   that same path, so a user scrolled to the top stays at the top rather than being
   pulled toward the bottom by the arithmetic.

`budget.ts`'s A-4 note ("Note what is NOT a parameter ... Do not add it back") is about
making the budget depend on *transcript* content, so that the first submitted message
cannot make the layout jump. `draftRows` is not that: it depends only on what the user
is typing right now, and today the jump happens anyway - Yoga takes the rows out of the
transcript whether or not `viewportRows` was told. D-12 records the distinction; the
implementer should extend that comment rather than delete it.

### 5.6 L4 — the transcript entry cap (G7)

`ui/entries/UserEntry.tsx` renders one `<Text>` per line with no ceiling, so a
submitted 5 000-line paste asks Yoga to lay out 5 000 nodes inside a measured
entry. `ui/render-cache.ts:37` already records the same hazard for highlighting
("a multi-megabyte 'code block' is almost always a pasted log").

`UserEntry` gains a cap of `USER_ENTRY_MAX_ROWS = 40` rendered lines, followed by
one dim row reading `... +N more lines` built from `glyphs.ellipsis`. The full
text remains in `ViewState` and in the exit transcript — `ui/transcript-text.ts`
is **not** capped, because a replay the user pipes into an issue must be
complete.

**`estimateEntryRows` is capped in the same commit (P1-2).**
`ui/layout/virtual-window.ts`'s `case 'user'` returns
`separation + wrappedRows(entry.text, usable)`; capping the renderer alone would leave
the virtual window believing a 5 000-line message is 5 000 rows tall. That is I-8's
failure - a renderer and its accounting disagreeing - relocated from the composer to
the transcript, and it is worse here than a plain over-estimate: the file's own comment
records that "an entry estimated at 400 rows is exactly the one that never gets
mounted", and an unmounted entry is never measured, so the estimate never
self-corrects. The branch becomes

```ts
case 'user':
  // Mirrors `UserEntry`'s render cap (+1 for the `... +N more lines` tail).
  // THESE TWO NUMBERS ARE ONE NUMBER (I-13).
  return separation + Math.min(
    wrappedRows(entry.text, usable),
    USER_ENTRY_MAX_ROWS + 1,
  );
```

and `USER_ENTRY_MAX_ROWS` is imported from `ui/composer-limits.ts` rather than
duplicated - unlike `DIFF_COLLAPSED_LINES` / `TOOL_LIVE_TAIL_ROWS` next to it, which are
deliberately duplicated as numbers, this one has no import-cycle reason to be.

### 5.7 Sequence — pasting 218 lines into a draft that already says `explain `

```
terminal    filter (L1)                        ink            PromptInput (L3)
   |  \x1b[200~
   |------------->| state := bracketed              |                |
   |  "line1\r\nline2\r\n..."  (n chunks)           |                |
   |------------->| body += ...   (no mouse parse)  |                |
   |  \x1b[201~   |                                 |                |
   |------------->| sanitise: CRLF->LF, strip C0    |                |
   |              | write("\0[" + payload + "\0]")  |                |
   |              |-------------------------------->| read() drains  |
   |              |                                 |--------------->| splitPasteFrames
   |              |                                 |                | -> [{paste, 218 lines}]
   |              |                                 |                | shouldCollapse -> true
   |              |                                 |                | ONE dispatch
   |              |                                 |                |
draft: "explain [Pasted text #1 +218 lines]"     pastes: {1 -> 12.4 KB}
composer height: 1 draft row (+2 border +1 hint) = 4 rows, unchanged

Enter ->  expandPastes(...)  ->  onSubmit("explain line1\nline2\n...")
```

---

## 6. File / module change plan

| # | File | New? | Intent |
| --- | --- | --- | --- |
| 1 | `packages/cli/src/input/stdin-filter.ts` | renamed from `stdin-mouse-filter.ts` | Add the paste state machine, marker scanning, burst coalescing and inline framing to the existing mouse filter; keep the mouse contract byte-identical. **Take `StdinFilterFeatures { mouse, paste }` and skip `splitMouseEvents` entirely when `mouse` is false** (§5.1 step 0 / D-17). Suspend mouse parsing inside a `burst` body as well as a `bracketed` one (I-3). |
| 2 | `packages/cli/src/input/paste-parse.ts` | **new** | Pure: `PASTE_BEGIN_MARK` / `PASTE_END_MARK`, `isPastePrefix`, `classifyChunk`, `sanitisePaste`. No stream, no timers. |
| 3 | `packages/cli/src/input/limits.ts` | **new** | Structural bounds: `PASTE_MAX_BYTES`, `PASTE_MIN_BURST_CHARS`, `PASTE_BURST_MS`, `PASTE_ASSEMBLY_MAX_MS`, `PASTE_OPEN`, `PASTE_CLOSE`. Also `PasteBridge` (§5.1.2) — the one channel from the filter to `App`'s `notify`. |
| 4 | `packages/cli/src/ui/screen.ts` | no | `AltScreenOptions.bracketedPaste?`; write `?2004h` on entry and `?2004l` in `restore()`, gated exactly like the mouse sequences. |
| 5 | `packages/cli/src/ui/paste-tokens.ts` | **new** | Pure token vocabulary: `PasteRecord`, `formatPasteToken`, `pasteTokenRe()` (a **factory**, P2-2), `tokenAt`, `snapOutOfToken`, `expandRangeOverTokens`, `expandPastes`, `referencedIds`, `shouldCollapse`, `allocatePasteId()` (the module counter, called by the component and never by the reducer — P1-5). |
| 6 | `packages/cli/src/ui/paste-frames.ts` | **new** | Pure: `splitPasteFrames(input): InputSegment[]`, `sanitiseTyped(text)`, `stripPasteFrames(input)` (§5.4 / §5.4.1). |
| 7 | `packages/cli/src/ui/composer-limits.ts` | **new** | `PASTE_INLINE_MAX_LINES`, `PASTE_INLINE_MAX_CHARS`, `draftMaxRows(rows)`, `USER_ENTRY_MAX_ROWS`. |
| 8 | `packages/cli/src/ui/composer-rows.ts` | **new** | Pure: `layoutComposer` — hard wrap by display column, token segmentation, caret location, height window. |
| 9 | `packages/cli/src/ui/editor-reducer.ts` | no | Add `pastes` to `EditorState` (and to `INITIAL_EDITOR_STATE`); add the `input` action, whose paste segments carry an id allocated by the caller; route `backspace` through `expandRangeOverTokens`; wrap **every buffer-changing branch** in `withPrune` (I-7 / P1-6); clear `pastes` on `clear`. |
| 10 | `packages/cli/src/ui/PromptInput.tsx` | no | Add the paste branch to `useInput`; route `applyEdit` kill ranges through `expandRangeOverTokens`; replace `renderWithCursor` with `layoutComposer` + a row renderer; expand at submit; report `{hasDraft, rows}`; render the overflow indicator. |
| 11 | `packages/cli/src/ui/Composer.tsx` | no | Widen `onDraftChange` and forward the row count. |
| 12 | `packages/cli/src/ui/layout/budget.ts` | no | Optional `draftRows` parameter on `chromeBudget` / `viewportRows`; the composer term becomes a function of it. |
| 13 | `packages/cli/src/ui/App.tsx` | no | Hold `draftRows` (growth immediate, shrink deferred one tick — §5.5); pass it to `computeViewportRows`; **assign `pasteBridge.notify` in an effect and clear it on unmount** so the filter's rejections reach `dispatch({type:'notice'})` (§5.1.2 / P1-3). |
| 14 | `packages/cli/src/ui/entries/UserEntry.tsx` | no | Cap rendered rows at `USER_ENTRY_MAX_ROWS` with a `... +N more lines` tail. |
| 15 | `packages/cli/src/cli.tsx` | no | Widen the filter gate to `stdin.isTTY && (wantMouse \|\| config.paste)`; import from `stdin-filter.js`; **introduce `mouseOn = wantMouse && filter !== null` and repoint the four mouse sites (`:614`, `:704`, `:790`, `:872`) at it — without this the widening silently re-enables mouse reporting for `--no-mouse` users (P0-1 / D-17)**; construct the filter with `{ mouse: wantMouse, paste: wantPaste }` and the `PasteBridge`; pass `bracketedPaste: pasteOn && mode === 'fullscreen'` to `enterAltScreen`; add `--paste` / `--no-paste` (three sites: `.option()`, `CliFlags`, `toFlags`); add `paste` to `SETTABLE_KEYS` **and** to the `config set` switch. |
| 16 | `packages/cli/src/config/schema.ts` | no | `paste: boolean` on `PersistedConfig`, on `CliConfig`, and in `DEFAULT_CONFIG` (default `true`). |
| 17 | `packages/cli/src/config/load.ts` | no | `paste?: boolean` on `CliFlags`; `resolvePaste(flags, env, file)` shaped exactly like `resolveMouse`; wire into the returned `CliConfig`. |
| 18 | `packages/cli/src/config/env.ts` | no | `ARAGON_PASTE`, parsed exactly like `ARAGON_MOUSE_SELECT`. |
| 19 | `packages/cli/src/ui/overlays/SettingsScreen.tsx` | no | **`... + stripPasteFrames(input)` on the text-editing branch (`:467`)** — without it a pasted API key is stored with NUL framing and silently fails to authenticate (P0-2 / §5.4.1). |
| 20 | `packages/cli/src/ui/overlays/QuestionOverlay.tsx` | no | Same one-line change on the `typingOther` branch (`:158`). |
| 20b | `packages/cli/src/ui/overlays/PlanReviewOverlay.tsx` | no | Same one-line change on the revision-feedback branch (`:86`). **Added during implementation** — §5.4.1's table called this consumer "key-driven only; inert", which stopped being true when that field was added. Found by T-30's scan, not by review (IF-1). |
| 21 | `packages/cli/src/ui/layout/virtual-window.ts` | no | Cap `estimateEntryRows`'s `case 'user'` at `USER_ENTRY_MAX_ROWS + 1` so the estimate matches what `UserEntry` actually renders (P1-2 / I-13). |
| 22 | `packages/cli/src/ui/overlays/HelpOverlay.tsx` | no | One row: paste behaviour and the collapse threshold. |
| 23 | `packages/cli/src/__tests__/paste-parse.test.ts` | **new** | Classification, sanitisation, prefix handling. |
| 24 | `packages/cli/src/__tests__/paste-tokens.test.ts` | **new** | Format, find, snap, range growth, expansion, orphan collection. |
| 25 | `packages/cli/src/__tests__/composer-rows.test.ts` | **new** | Hard wrap incl. CJK, caret mapping, window selection, overflow counts. |
| 26 | `packages/cli/src/__tests__/stdin-filter.test.ts` | renamed + extended | Every existing mouse assertion, unchanged, plus the paste cases. |
| 27 | `packages/cli/src/__tests__/editor-reducer.test.ts` | no | The `input` action and token-atomic deletion. |
| 28 | `packages/cli/src/__tests__/input.test.ts` | no | The paste branch's position in the handler. |
| 29 | `packages/cli/src/__tests__/screen.test.ts` | no | `?2004h` / `?2004l` presence and absence. |
| 30 | `packages/cli/src/__tests__/budget.test.ts` | no | Default-argument identity plus the `draftRows` arithmetic. |
| 31 | `packages/cli/src/__tests__/config.test.ts` | no | The `--no-paste` three-site pin, matching the `--no-mouse` precedent. |
| 32 | `packages/cli/src/__tests__/glyphs.test.ts` | no | Add `input` to `inScope` and assert on the predicate (D-16). |
| 33 | `packages/cli/src/__tests__/paste-frames.test.ts` | **new** | `splitPasteFrames` ordering (T-5), `sanitiseTyped` on a coalesced tail (T-31), and the `stripPasteFrames` consumer scan (T-30). |
| 34 | `packages/cli/src/__tests__/cli-stream-gate.test.ts` | **new** | The `mouseOn` / `pasteOn` matrix (T-29): four gate combinations × what each of the five sites is handed. |
| 35 | `packages/cli/README.md` | no | Keybindings table row; the config table gets `paste`. |
| 36 | `packages/cli/CHANGELOG.md` | no | One entry. |
| 37 | `docs/plans/tui-paste-handling/manual-test.md` | **new** | The terminal matrix in §9.3. |

Nothing under `packages/core/` is touched. The machine-facing surfaces
(`exec/`, `session/`) are not touched either: `aragon exec` and `aragon -p` never
construct a composer.

---

## 7. Interface design

### 7.1 CLI flags

```
--paste        Collapse large pastes into a placeholder (the default)
--no-paste     Treat pasted bytes as keystrokes (v0.6.3 behaviour)
```

The positive form is declared **first**, for the tri-state reason
`--mouse-select` records: `paste` is persisted and defaults to `true`, so a lone
`--no-paste` would make commander default `opts.paste` to `true` —
indistinguishable from silence, and it would overwrite a stored `false` on every
run that passed no flag at all.

### 7.2 Environment

```
ARAGON_PASTE=0|1|true|false|on|off|yes|no
```

Parsed by `config/env.ts` with the same shape `ARAGON_MOUSE_SELECT` uses.

### 7.3 Config key

```bash
aragon config set paste false
aragon config get paste
```

`paste: boolean`, default `true`. It must be added to **both** `SETTABLE_KEYS`
and the `config set` switch in `cli.tsx` — membership in the list alone makes
`config set paste false` print `Set paste = false` and write nothing, which is
the failure `density` / `hints` / `mouse` have each already shipped once.

### 7.4 Resolution order

`flags › env › file › DEFAULT_CONFIG.paste`, i.e. `resolvePaste` is shaped
exactly like `resolveMouse` in `config/load.ts`. Reaching for the `hints` shape
(`flags.x !== undefined ? … : file.x ?? DEFAULT`) reads **no env at all** and
would ship `ARAGON_PASTE` documented-but-dead.

### 7.5 Module APIs

Given in §5.1 (`sanitisePaste`, `classifyChunk`, `isPastePrefix`), §5.3
(`ui/paste-tokens.ts`), §5.4 (`splitPasteFrames`) and §5.5 (`layoutComposer`,
`draftMaxRows`, `chromeBudget`, `viewportRows`). Every one is pure and exported
for direct unit test; no new API crosses a process or package boundary.

### 7.6 User-visible strings (all ASCII, no new glyph fields)

| Site | Text |
| --- | --- |
| Composer token, multi-line | `[Pasted text #1 +15 lines]` |
| Composer token, one long line | `[Pasted text #2 +1204 chars]` |
| Composer overflow indicator | `<arrowUp>3` / `<arrowDown>7` (fixed cell) |
| Transcript entry cap | `<ellipsis> +4960 more lines` |
| Over-limit reject toast | `Paste too large (4.1 MB); limit is 2.0 MB. Nothing was inserted.` |

`glyphs.ts` needs **no new field**: the token is pure ASCII by construction and
the two indicators reuse `arrowUp` / `arrowDown` / `ellipsis`.

---

## 8. Data model

Nothing is persisted. Every structure below is in-memory and dies with the
process.

**`input/stdin-filter.ts` (module-local, one per session)**

| Field | Type | Lifetime |
| --- | --- | --- |
| `pending` | `string` | ≤ 12 ms; a partial marker or mouse prefix |
| `pasteState` | `PasteState` (§5.1) | one paste |
| `pasteState.body` | `string` | ≤ `PASTE_MAX_BYTES` (2 MiB), released on emit |

**`ui/editor-reducer.ts::EditorState` (one per mounted `PromptInput`)**

| Field | Type | Notes |
| --- | --- | --- |
| `buffer` | `string` | unchanged; may now contain tokens |
| `cursor` | `number` | unchanged |
| `historyIndex` | `number \| null` | unchanged |
| `dismissed` | `boolean` | unchanged |
| `sel` | `number` | unchanged |
| `pastes` | `ReadonlyMap<number, PasteRecord>` | **new**; pruned to `referencedIds(buffer)` on every buffer-changing action; emptied by `clear` |

**Module-level counter**

`nextPasteId: number`, monotonic for the process (D-14), exposed only as
`allocatePasteId()` in `ui/paste-tokens.ts`. It is deliberately *not* in
`EditorState`, because an id must not be reused after a `clear`.

**It is called from `PromptInput`, never from the reducer (P1-5).** v1's note here
said the counter lives outside the state "because a reducer must stay pure" - but
moving the variable out of the state and then mutating it *inside* the reducer is
precisely what makes the reducer impure. React may run a reducer more than once for
one action (eager evaluation in `dispatchSetState`, base-queue replay after a
bailout, StrictMode), and the second run would allocate a second id and produce a
different token string for the same paste. Allocating in the handler also makes the
token text deterministic for `editor-reducer.test.ts`, which otherwise cannot
assert on it.

**Bounds**

| Constant | Value | Meaning |
| --- | --- | --- |
| `PASTE_INLINE_MAX_LINES` | 6 | at or below ⇒ inserted verbatim |
| `PASTE_INLINE_MAX_CHARS` | 400 | at or below ⇒ inserted verbatim |
| `PASTE_MAX_BYTES` | 2 MiB | a single paste; above ⇒ rejected with a toast (D-11) |
| `PASTE_DRAFT_MAX_BYTES` | 8 MiB | all live payloads in one draft; above ⇒ rejected |
| `PASTE_MAX_BLOCKS` | 32 | tokens in one draft; above ⇒ rejected |
| `PASTE_MIN_BURST_CHARS` | 25 | Tier 2's single-line rule |
| `PASTE_BURST_MS` | 15 | Tier 2 coalescing window |
| `PASTE_ASSEMBLY_MAX_MS` | 2 000 | unterminated Tier 1 paste force-flush |
| `draftMaxRows(rows)` | 3 / 6 / 10 | composer draft ceiling |
| `USER_ENTRY_MAX_ROWS` | 40 | transcript entry render ceiling |

---

## 9. Testing and acceptance criteria

### 9.1 Unit tests (pure, no Ink, no tty)

| T | Assertion |
| --- | --- |
| T-1 | `sanitisePaste('a\r\nb\rc')` === `'a\nb\nc'` — CRLF and lone CR both become exactly one `\n`. |
| T-2 | `sanitisePaste` removes `\x1b`, `\x07`, `\x00`, keeps `\t`, and keeps every non-ASCII character (CJK, emoji) unchanged. |
| T-3 | `classifyChunk('a')` is `'keys'`; `classifyChunk('\r')` is `'keys'`; `classifyChunk('ab\r')` is `'paste'`; a 24-character run is `'keys'`, a 25-character run is `'paste'`. |
| T-4 | `isPastePrefix` is true for every strict prefix of `\x1b[200~` and false for the whole marker. |
| T-5 | `splitPasteFrames('abc' + OPEN + 'X\nY' + CLOSE + 'def')` yields exactly `[text 'abc', paste 'X\nY', text 'def']`, **in that order** (the ordering guarantee D-3 buys). |
| T-6 | `formatPasteToken` renders `+N lines` for multi-line and `+N chars` for one line; the result matches `PASTE_TOKEN_RE` and contains no non-ASCII byte. |
| T-7 | `expandPastes` replaces a known id, leaves an unknown id verbatim, and handles two tokens on one line. |
| T-8 | `expandRangeOverTokens` grows a range that clips a token's tail out to the token's `start`; a range fully outside a token is returned unchanged. |
| T-9 | `snapOutOfToken` returns the nearer edge for an interior index and the input for an index at either edge or outside. |
| T-10 | `referencedIds` after deleting a token's text drops that id, and the reducer's prune releases the payload. |
| T-11 | `layoutComposer` hard-wraps at display columns: a row of 40 CJK characters at `cols: 40` produces 2 rows, not 1 (`string-width`, D-15). |
| T-12 | `layoutComposer` never returns more than `maxRows` rows, always includes `cursorRow`, and `hiddenAbove + rows.length + hiddenBelow === totalRows`. |
| T-13 | `layoutComposer` preserves leading whitespace verbatim (the regression `wrapToRows` would cause). |
| T-14 | `viewportRows(r)` === `viewportRows(r, 1)` for every `r` in `[1, 200]` — the D-12 identity that keeps `budget.test.ts` honest. |
| T-15 | `viewportRows(r, d)` is non-increasing in `d`, and `chromeBudget(r, d).composer` never exceeds `2 + draftMaxRows(r) + 1`. |

### 9.2 Integration tests

| T | Assertion |
| --- | --- |
| T-16 | Feeding `\x1b[200~a\r\nb\x1b[201~` to the filter yields exactly `OPEN + 'a\nb' + CLOSE` on the wrapper and **zero** mouse events. |
| T-17 | A bracketed paste split across five writes, one of them cutting `\x1b[201~` in half, produces one frame with the whole payload. |
| T-18 | A bracketed payload containing the literal bytes `\x1b[<0;12;5M` emerges **intact** inside the frame, and no `MouseEvent` is emitted (I-3). |
| T-19 | Without any marker, `'foo\r\nbar'` in one write yields one frame; `'f'`, `'o'`, `'o'` in three writes 100 ms apart yield three pass-through writes and no frame. |
| T-20 | Three writes 5 ms apart, the first classified as paste, produce **one** frame containing all three bodies (burst coalescing). |
| T-21 | An unterminated `\x1b[200~` followed by silence emits a frame after `PASTE_ASSEMBLY_MAX_MS` and leaves the filter in `idle` — input is never wedged. |
| T-22 | Every existing assertion in `stdin-mouse-filter.test.ts` passes verbatim against `stdin-filter.ts`. |
| T-23 | `enterAltScreen(stdout, { mouse: false })` writes exactly the bytes it writes today — no `?2004h` (the default-off proof). |
| T-24 | `enterAltScreen(stdout, { mouse: true, bracketedPaste: true })` then `restore()` writes `?2004l` before `LEAVE_ALT`, exactly once, and calling `restore()` twice still writes it once. |
| T-25 | Mounting `PromptInput` and dispatching a framed 218-line paste leaves the buffer at one token, the composer at one draft row, and `onSubmit` receiving all 218 lines. |
| T-26 | The same flow with a 4-line paste inserts the text verbatim and produces **no** token. |
| T-27 | `Backspace` with the caret immediately after a token removes the whole token in **one** dispatch (the `prompt-input-commits.test.tsx` shape). |
| T-28 | With `--no-paste --no-mouse`, `runInteractive` hands Ink `process.stdin` itself, unwrapped (D-13 / AC-6). |
| T-29 | **The gate matrix (P0-1).** For each of the four `(mouse, paste)` combinations, assert what each of the five sites receives. The load-bearing row is `(mouse: false, paste: true)`: `filter !== null` **and** `enterAltScreen` is called with `mouse: false`, `wantSelect` is false, `mouseCaptured` is false, and `mouseSource` is `undefined`. Asserting only that a filter exists is what would let the regression through. |
| T-30 | **The consumer scan (P0-2).** A source scan asserts that every `useInput` callback in `src/` that appends `input` to a string does so through `stripPasteFrames`. Plus a direct case: feeding `SettingsScreen`'s handler a framed 100-character key yields a stored value containing **no** NUL and equal to the payload. Written as a scan, not as two hand-written cases, because the failure is invisible on screen and a seventh consumer will be added by someone who never read this document. |
| T-31 | **Coalescing (P1-1).** `splitPasteFrames(OPEN + 'a\nb' + CLOSE + '\r')` yields a paste segment plus a text segment, and the text segment's sanitised form is `''` — no `\r` survives into the buffer. Same with a trailing `\x1b[A`. |
| T-32 | **Estimate parity (P1-2).** `estimateEntryRows` for a 5 000-line user entry is `<= USER_ENTRY_MAX_ROWS + 2` (cap + tail + separation), and equals the number of rows `UserEntry` actually renders for the same text. |

### 9.3 Manual matrix (`manual-test.md`)

Every row is "paste 218 lines of a log containing tabs, CJK, an ANSI colour
sequence and CRLF line endings, then press Enter".

| Terminal | Tier expected |
| --- | --- |
| Windows Terminal + PowerShell 7, Node 22 | 1 |
| Windows Terminal + PowerShell 5.1, Node 20 | 1 or 2 |
| legacy `conhost` `cmd.exe`, Node 20 | 2 |
| macOS Terminal.app | 1 |
| iTerm2 | 1 |
| VS Code integrated terminal | 1 |
| Linux `gnome-terminal` / `xterm` | 1 |
| `tmux` inside any of the above | 1 |
| ssh from Windows into Linux | 1 |
| `--no-fullscreen` (inline) anywhere | 2 |
| `--no-paste` anywhere | none (v0.6.3 behaviour) |
| `--no-mouse` anywhere (paste still on) | 2 — **and the terminal's own click-drag selection must still work** (AC-11) |
| a shell that leaves DEC 2004 on, inline mode | markers consumed anyway; no `[200~` in the draft (I-16) |

Each row asserts: exactly one message sent; no stray `[200~` / `[201~` in the
draft; no line overwritten; the token reads `[Pasted text #1 +218 lines]`; the
composer stayed within `draftMaxRows`; the agent's echo shows all 218 lines; and
`Ctrl+C`-ing out leaves the shell able to paste normally.

Two rows are run a second time with a variation that no unit test can reach:

- **paste, then press Enter within ~50 ms** (the coalescing case, P1-1). Assert the
  draft holds no overwritten row and the message is sent at most once.
- **paste an API key into Settings → API key, save, then make one request** (P0-2).
  Assert it authenticates. This one is the reason the feature cannot ship on unit
  tests alone: the failure is a masked field containing invisible bytes.

### 9.4 Acceptance criteria

| AC | Criterion |
| --- | --- |
| AC-1 | Pasting 15 lines produces **one** message, never more. |
| AC-2 | The draft after a large paste shows `[Pasted text #1 +15 lines]` and nothing else from that paste. |
| AC-3 | A paste of ≤ 6 lines and ≤ 400 characters appears verbatim, correctly indented, on its own lines. |
| AC-4 | No `\r`, `\x1b` or NUL ever reaches the rendered draft. |
| AC-5 | The composer never exceeds `2 + draftMaxRows(rows) + 1` rows, and `viewportRows` is given that same number. |
| AC-6 | With `--no-paste --no-mouse` the input path is byte-identical to v0.6.3: no wrapper stream, no `?2004h`, no new branch reached. |
| AC-7 | Leaving `aragon` by any of `Ctrl+C`×2, `kill`, closing the window, or a crash writes `?2004l` exactly once, before `LEAVE_ALT`, and leaves the shell **able to paste normally** — no literal `[200~`, and the shell's own bracketed paste working again on its next prompt. (v1 claimed "in the state it had before"; we force the mode off rather than saving it, for the reason §5.2 gives, so that stronger wording was not something the design delivered.) |
| AC-8 | `aragon exec`, `aragon -p`, `aragon config set` and `aragon --version` reach **zero paste code on the input path**: no filter is constructed, no `?2004h` is written, no token module is imported. (`resolvePaste` does run, inside `loadConfig`, for every subcommand — v1's "zero lines" was not literally satisfiable, P2-6.) |
| AC-9 | Each of the three limits rejects **with a visible toast naming the size and the limit**, and leaves the draft byte-for-byte unchanged: a 2 MiB single paste (filter), a paste that would push the draft past `PASTE_DRAFT_MAX_BYTES`, and a 33rd token (both in `PromptInput`). §5.3's table is the enforcement map. |
| AC-10 | `glyphs.test.ts::inScope('input/paste-parse.ts')` is `true`, and the scan reports zero violations. |
| AC-11 | `aragon --no-mouse` (with `paste` at its default `true`) writes **no** mouse sequence — no `?1000h`, no `?1006h`, no `?1002h` — shows no mouse startup notice, and reports `/mouse` as off. Pasting still works. |
| AC-12 | A ~100-character API key pasted into Settings → API key is stored **exactly**, with no NUL and no framing, and authenticates. Same for a pasted free-text answer in `QuestionOverlay`. |

### 9.5 Definition of done

1. `npm run build` and `npm test` green from the workspace root.
2. `npm run typecheck` green (both `tsconfig.json` and `tsconfig.test.json`).
3. Every T-* above written and passing. **T-14, T-22, T-29 and T-30 are the four
   that prove nothing regressed** — the first two cover the arithmetic and the mouse
   filter, the last two cover the two P0s found in review, both of which are silent
   in every other test.
4. The §9.3 matrix executed, with the result of every row recorded in
   `manual-test.md` — including the failures, if any. The two variation rows
   (paste-then-Enter; paste an API key into Settings and authenticate) are **not
   optional**: neither failure is reachable from a unit test.
5. README keybindings + config tables and `CHANGELOG.md` updated.
6. `## 评审记录` reconciled: every P0 / P1 either fixed in this document or
   explicitly re-argued and downgraded, with the argument written down.

---

## 10. Invariants

| I | Invariant | Consequence of breaking it |
| --- | --- | --- |
| **I-1** | `?2004h` is written **only** when a filter that consumes `\x1b[200~` is installed. `screen.ts` never derives this for itself. | Literal `[200~` and `[201~` typed into every message — strictly worse than today. |
| **I-2** | `?2004l` is written on every exit path, before `LEAVE_ALT`. | The user's shell shows `[200~` on every paste until they run `reset`. |
| **I-3** | Mouse parsing is **suspended for the duration of any paste body** — `bracketed` and `burst` alike — and does not run at all in a `{ mouse: false }` filter. | A pasted terminal log silently loses the bytes that look like SGR reports. v1 covered only Tier 1, which left the loss in place for exactly the terminals Tier 2 exists to serve (P1-7). |
| **I-4** | The filter never holds a partial paste for longer than `PASTE_ASSEMBLY_MAX_MS`, and never more than `PASTE_MAX_BYTES`. | An unterminated marker wedges all keyboard input, permanently and silently. |
| **I-5** | Paste payload reaches the composer **on the stream**, never on a side channel. | Text typed before the paste in the same chunk is applied after it. |
| **I-6** | Every branch of `useInput` still performs at most **one** `dispatch`. | The legacy React root is back to N commits, N Yoga layouts and two repaints per event — the flicker `tui-input-flicker-fix` removed. |
| **I-7** | `pastes` is pruned to `referencedIds(buffer)` on every buffer-changing action and emptied by `clear`. | Payloads outlive the drafts that referenced them, unbounded, for the session. |
| **I-8** | The composer's rendered row count and the `draftRows` handed to `viewportRows` are the same number. | The trap `BottomStatusRow.tsx:5-27` documents, at 200× the magnitude. |
| **I-9** | `layoutComposer` is the only place that maps a buffer index to a screen cell. | The caret is drawn on a cell that does not hold the character it is on. |
| **I-10** | With `paste: false` **and** `mouse: false`, `render()` receives `process.stdin`. | AC-6 becomes a claim about behaviour rather than about code. |
| **I-11** | **`filter !== null` answers exactly one question: "is a stream wrapped?"** (G10). Everything about the mouse reads `mouseOn = wantMouse && filter !== null`; everything about DEC 2004 reads `pasteOn`. | Turning paste on turns mouse reporting on for `--no-mouse` users (P0-1): terminal selection dies, `?1002h` is written, and `App` advises the user about a mode they disabled. |
| **I-12** | **Every `useInput` consumer that appends `input` to a string routes it through `stripPasteFrames`.** Pinned by a scan (T-30), not by review discipline. | A framed API key is stored with NUL bytes, masked on screen, and fails to authenticate with nothing on screen to explain it (P0-2). |
| **I-13** | `UserEntry`'s render cap and `estimateEntryRows`'s `case 'user'` are **the same number**. | I-8's failure relocated to the transcript, where it is worse: an over-estimated entry is never mounted, so it is never measured, so the estimate never self-corrects (P1-2). |
| **I-14** | Text runs that arrive **outside** a frame are sanitised before they touch the buffer. | Ink drains its buffer in one `read()`, so a keystroke that coalesced with a frame is spliced in raw and §2.2 comes back through the branch that was added to close it (P1-1). |
| **I-15** | The filter's user-visible refusals reach `App` through `PasteBridge`, never through the logger alone. | D-11 degrades to "the paste silently did nothing", which is what D-11 exists to rule out (P1-3). |
| **I-16** | The filter consumes `\x1b[200~` / `\x1b[201~` **in every mode, whether or not this process enabled DEC 2004**; and `setMouseCapture` never touches DEC 2004. | An externally-enabled DEC 2004 (a shell, `tmux`, a wrapper) types literal `[200~` into the draft — I-1's failure arriving from outside. And `/mouse off` silently downgrading Tier 1 to Tier 2 is a coupling nobody asked for (P2-3 / P2-7). |

---

## 11. Risks and mitigations

| R | Risk | Mitigation |
| --- | --- | --- |
| **R-1** | **A terminal honours `?2004h` but the filter has a bug**, so markers reach the draft. | The gate is one boolean (`bracketedPaste: mouseFilter !== null && config.paste`), Tier 2 catches the payload even if Tier 1 mis-fires, and `--no-paste` is a documented one-flag revert. T-16..T-18 cover the marker paths directly. |
| **R-2** | **Tier 2 misclassifies fast typing — or an IME commit — as a paste**, so a keystroke is delayed 15 ms or a newline is swallowed. | The primary rule requires a line break **in a multi-character chunk**, which a keyboard cannot emit; the secondary rule needs 25 characters in one chunk. A single `\r` — the Enter key — is explicitly `'keys'` (T-3). Only a chunk already classified as paste opens the burst window, so ordinary typing pays nothing. **The IME case is worth stating explicitly, because this feature's users write Chinese** (P2-8): a CJK input method commits a whole phrase in one chunk and can exceed 25 characters. The consequence is benign by construction — such a commit is far below `PASTE_INLINE_MAX_LINES` / `PASTE_INLINE_MAX_CHARS`, so `shouldCollapse` is false and the text is inserted **verbatim**, exactly as today. The only observable difference is that it is sanitised on the way in, which is an improvement. A single IME commit of more than 400 characters would collapse into a token; no input method produces one. |
| **R-3** | **A pasted block is misclassified as keys** on a terminal without bracketed paste, restoring defect A. | The primary rule is exactly the shape defect A needs (a chunk containing `\r`), so the two coincide: any chunk that could trigger defect A is classified as a paste. The residual case is a paste that arrives one character at a time with each `\r` alone, which requires the terminal to deliver below one character per event-loop turn — no ConPTY or pty does. Recorded, not eliminated. |
| **R-4** | **The `PassThrough` buffers a 2 MiB payload**, doubling peak memory and stalling a frame. | Bounded by `PASTE_MAX_BYTES`; `read()` drains in one call so there is no per-chunk React commit; the collapse means the 2 MiB is never laid out by Yoga. A paste bigger than the cap is rejected before it is written (D-11). |
| **R-5** | **A token is corrupted by an edit** and its payload is dropped, so the user silently sends the label instead of the text. | D-8's atomic delete plus `snapOutOfToken` remove every path that goes through the reducer. The residual — the user selecting and retyping the middle of a token — leaves the *visible* label in the message, so the loss is on screen rather than silent, and `referencedIds` releases the payload rather than leaking it. |
| **R-6** | **`draftRows` re-renders `App` too often.** | It is reported only when the number changes, i.e. on a line break or a wrap boundary, not per character. The existing `onDraftChange` already establishes this pattern and its comment explains why. |
| **R-7** | **Renaming `stdin-mouse-filter.ts` breaks an import** in a file nobody looked at. | TypeScript makes this a compile error, not a runtime one. The only importers today are `cli.tsx:100` and `__tests__/stdin-mouse-filter.test.ts`. |
| **R-8** | **The `?2004h` byte disturbs the frame differ's accounting.** | It is written by `screen.ts` before `render()` is called and by `restore()` after unmount, exactly like the mouse sequences — never through the differ proxy, so `fallbacks` is untouched (the P1-6 lesson of `tui-selection-and-scroll-follow`). |
| **R-9** | **Widening the filter gate changes behaviour for `--no-mouse` users.** | v1's answer here was incomplete and the gap was a P0. The stream itself is fine — the non-paste path is a pass-through that is byte-identical to the unwrapped stream, T-22 re-runs every existing filter assertion, and step 0 keeps `splitMouseEvents` from running at all. What v1 missed is that the *handle* was the mouse's on/off signal at five call sites; D-17 / I-11 replace it with an explicit `mouseOn`, and T-29 pins all four gate combinations. AC-6 / I-10 keep the fully-off configuration provably unwrapped. |
| **R-12** | **`draftRows` makes the transcript move while the user types**, and the same number feeds overlays, the todo rail, the popup and the scroll clamp. | §5.5's three rules: report the clamped value only (so the movement stops once the composer is full), grow immediately but defer shrink by one render tick (so a run of `Backspace` does not bounce the frame), and re-clamp rather than re-anchor the scroll offset. The movement is not new — Yoga already took the rows — it is only now accounted for. |
| **R-10** | **`USER_ENTRY_MAX_ROWS` hides content the user wants.** | The tail names the exact number of hidden rows, the exit transcript is uncapped, and 40 rows is above every non-paste message this CLI has ever produced. |
| **R-11** | **Windows consoles below `ENABLE_VIRTUAL_TERMINAL_INPUT` never deliver the markers.** | That is precisely the Tier 2 population, and Tier 2 needs no terminal cooperation at all. The existing `vtInputSupported` measurement is deliberately **not** reused as a paste gate — doing so would switch Tier 2 off on the machines that need it most. |

---

## 12. Staging and the fail-safe ladder

Each stage is useful alone, revertible alone, and leaves the one below it intact.

| Stage | Contents | Revert |
| --- | --- | --- |
| **S1** | L1 filter (Tier 2 only) + sanitisation + framing; the composer inserts frames verbatim with no token. Fixes defects A and B. **S1 also carries D-17 (`mouseOn`), §5.4's `sanitiseTyped` and §5.4.1's `stripPasteFrames`** — all three are properties of "a frame exists on the stream at all", so none of them can be deferred to a later stage without shipping a regression in between. | `--no-paste` |
| **S2** | L2 `?2004h` (Tier 1). Makes detection exact where the terminal cooperates. | `--no-paste`, or pass `bracketedPaste: false` |
| **S3** | L3 tokens + collapse. Delivers the requirement's `[Pasted text #1 +15 lines]`. | `PASTE_INLINE_MAX_LINES = Infinity` reduces S3 to S1 |
| **S4** | L4 composer height bound + budget wiring + entry cap. | `draftMaxRows` returning `Infinity`, and the default `draftRows = 1` |

Rungs, worst first: `--no-paste --no-mouse` ⇒ v0.6.3 exactly. `--no-paste` ⇒
v0.6.3 input with the mouse filter as today. Tier 1 unavailable ⇒ Tier 2. Tier 2
misses ⇒ the text is still sanitised on the way through, so defect B cannot come
back even on a missed classification.

---

## 13. Open questions

| Q | Question | Current answer |
| --- | --- | --- |
| **Q-1** | Should the inline threshold be user-tunable? | No (D-10). Revisit if a bug report asks for a specific number rather than for "less". |
| **Q-2** | Should recalling a prompt-history entry re-collapse it? | No (N2). The height bound already makes it tidy, and re-tokenising would invent boundaries the user never drew. |
| **Q-3** | Should the transcript show the token, with `/paste show <n>` to expand? | Not in this round (D-9). It is the natural follow-up, and it is the only thing that would justify reversing D-9. |
| **Q-4** | Should a paste that is *mostly* one long line (minified JSON, a base64 blob) be labelled in bytes rather than characters? | `+N chars` today. Revisit with real reports. |
| **Q-5** | Should `Ctrl+V` be bound as an explicit "paste from the clipboard" action, driving `ui/clipboard.ts` in reverse? | No. Terminals do not deliver `Ctrl+V` for paste on any platform this CLI targets, and a second paste path would need its own tier ladder. |

---

## 评审结论 (Review Verdict)

### **有条件通过**（approved with conditions）

这份设计的诊断是可信的，分层是对的，回退阶梯是真的能退。§2 的三个缺陷我逐条对着 `packages/cli@0.6.3` 与 `ink@5.2.1` 复核过，全部属实；D-1 / D-3 / D-15 三个判断值得原样保留。评审提出的 2 个 P0 与 9 个 P1 **已在本 v2 正文中全部修复**，因此不需要再走一轮方案评审。

但**通过是有条件的**，条件都不是「再想想」，而是「实现时必须做到、且必须能被验证」。它们之所以单列，是因为这份特性的失败模式有一个共同的形状：**出错的时候屏幕上什么都不会显示**。NUL 渲染成空、`?1000h` 没有提示音、估高错误只表现为「那条消息就是不显示」。这类缺陷不会被「跑一遍看看」抓到，只会被专门写的断言抓到。

### 放行条件

| # | 条件 | 验证方式 | 不满足的后果 |
| --- | --- | --- | --- |
| **C-1** | `mouseOn` 与 `pasteOn` 两个显式布尔落地，`cli.tsx` 的四个鼠标站点不再读 `filter !== null`（D-17 / I-11）。 | T-29 的四格矩阵，**`(mouse:false, paste:true)` 一行必须断言 `enterAltScreen` 收到 `mouse:false`**，而不只是断言 filter 非空。 | `--no-mouse` 用户被夺走终端原生选中，且没有任何提示。 |
| **C-2** | `stripPasteFrames` 接进 `SettingsScreen` 与 `QuestionOverlay`（I-12）。 | T-30 的**源码扫描**（不是两条手写用例）+ §9.3 的「粘 API Key 然后真发一次请求」手测。 | 用户粘贴的 API Key 带 NUL 落盘，界面显示保存成功，此后每次调用 401。这是相对 v0.6.3 的纯回归。 |
| **C-3** | 帧外文本段过 `sanitiseTyped`（I-14）。 | T-31，外加 §9.3 的「粘完 50 ms 内按回车」手测。 | 缺陷 B 从新增的那条分支原路返回。 |
| **C-4** | `estimateEntryRows` 与 `UserEntry` 的行数上限是同一个数（I-13）。 | T-32 断言两者相等，**不是**断言各自 ≤ 40。 | 大消息永远不被 mount，因此永远不被测量，估值永远不自纠。 |
| **C-5** | S1 一次性带上 C-1 / C-2 / C-3（§12）。 | 提交粒度检查：`stdin-filter.ts` 的改动不得先于这三项合入。 | 分阶段合入会在中间留下一个「已经封帧、但没人认帧」的版本，那个版本比不做更糟。 |
| **C-6** | §9.3 手测矩阵**实跑**，结果（含失败）写进 `manual-test.md`。特别是 `--no-mouse` 一行与两条变体行。 | `manual-test.md` 里有逐行结论，不是一张空表。 | Tier 判定、`?2004l` 归还、IME 上屏这三类行为在 CI 里没有任何覆盖。 |

### 明确不阻塞的事项

- **P2-9（收起的 token 无法就地展开）** 记录在 Q-3，本轮不做。D-9 已经把「transcript 显示展开后的原文」和「token 可展开」绑成一件事，单独加一个展开入口会造出第二个真相源。若用户反馈集中在「粘完看不到自己粘了什么」，那是下一轮的 Q-3，不是本轮的补丁。
- **`draftMaxRows` 的 3 / 6 / 10 三档取值**没有实测依据，但它单调、可回退（返回 `Infinity` 即退回 S3），且错了只是难看不是坏掉。按数字发布，按反馈调。
- **Tier 2 的残余漏判**（R-3：终端逐字符投递且每个 `\r` 单独成 chunk）保持「记录而不消除」。同意这个处置：真要消除只能靠时间窗口猜测，而猜错的代价是把用户敲的回车吞掉——比漏判更糟。

### 给实现者的一句话

这份文档现在最该被逐字读的不是 §5，是 **§10 的 I-11 到 I-16**。这六条不变量每一条对应一个「删掉之后测试照绿、用户照坏」的位置，而它们全都不在 §5 的主叙述线上——它们在别人的文件里。

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

> 实施节点记录。下列每一条都在实现时命中，并已按「记录 + 按修正后的做法实施」处理。
> 编号 IF-n 与 §0 的 P0/P1/P2 编号独立。

### IF-1 · `PlanReviewOverlay` 也把 `input` 直接拼进字符串 —— §5.4.1 的表把它列成了 "inert"（P0-2 的第三个消费者）

**发现方式：T-30 的源码扫描，第一次运行就红。** 这正是评审要求把 T-30 写成扫描而不是两条手写用例的理由，
而它兑现得比预期更早：不是"将来某个人加第七个消费者"，是**今天就已经有第三个**。

§5.4.1 的表逐行列了六个 `useInput` 消费者，把 `ui/overlays/PlanReviewOverlay.tsx:63` 判为
"key-driven only; inert"。那一行在写文档时是对的，但该组件后来加了**修订意见输入框**，
现在 `:86` 是逐字的 `setFeedback(feedback + input)` —— 与 `SettingsScreen:467` /
`QuestionOverlay:158` 同形。而它的内容恰恰是用户最可能粘贴的东西：一段失败的测试输出、一份堆栈。

**处置：** `PlanReviewOverlay` 一并接 `stripPasteFrames(input)`。§6 的改动清单相应多一行
（`ui/overlays/PlanReviewOverlay.tsx`），`manual-test.md` 的 V2 多一条断言。

**留给下一个人的教训**：I-12 的措辞（"Every `useInput` consumer that appends `input` to a string"）
是对的，那张**表**才是会过期的东西。扫描钉的是规则，表只是当时的快照 —— 不要把表当成清单来维护。

### IF-2 · `splitPasteFrames(input): InputSegment[]` 的签名与 P1-5 自相矛盾

§5.4 声明 `splitPasteFrames(input): InputSegment[]`，而 §5.3 把 `InputSegment` 的 paste 分支定义为
带 `id: number`，同时 P1-5 又要求 **id 由 handler 分配、不能在 reduce 期分配**。
三条放在一起无法同时成立：一个纯函数拿不到 `allocatePasteId()` 的结果而不变得不纯。

**处置：** 拆成两个类型。`paste-frames.ts` 导出 `FrameSegment`（`{kind:'text'|'paste'; text}`，**无 id**），
`editor-reducer.ts` 导出 `InputSegment`（paste 分支带 `id`）。`PromptInput` 在两者之间做一次 `.map`，
`allocatePasteId()` 就在那一行。T-5 断言的是 `FrameSegment[]`，逐字符合 §9.1 写下的期望值。

### IF-3 · `composer-limits.ts` 导入 `HINT_MIN_ROWS` 会与 `budget.ts` 形成 ESM 循环

§5.5 的 `draftMaxRows` 正文里写着 `if (terminalRows >= HINT_MIN_ROWS) return 6;`，而 `HINT_MIN_ROWS`
在 `ui/layout/budget.ts`；同时 §5.5 又要求 `chromeBudget` 用 `draftMaxRows` 夹逼 composer 项。
两边互相 import 就是一个环。

这个环**今天是安全的**（双方都只在函数体里引用对方，模块求值期谁也不读谁），但它的失败模式是
**运行期 TDZ 崩溃**，触发条件是将来有人把某一处引用提到模块作用域 —— 一个既看不出来、
也不会被类型检查拦住的编辑。

**处置：** 不建环。`composer-limits.ts` 持有自己的 `DRAFT_TIER_MIN_ROWS = 20` 并导出
`DRAFT_MAX_ROWS_HINT_TIER`，`budget.test.ts` 加一条断言把它与 `HINT_MIN_ROWS` 钉成相等，
两者因此不能静默漂移。这与 `virtual-window.ts` 里 `DIFF_COLLAPSED_LINES` / `TOOL_LIVE_TAIL_ROWS`
"刻意重复为数字"的先例同档 —— 区别只是这一处补了断言。
（`USER_ENTRY_MAX_ROWS` 仍按 §5.6 的要求**真的 import**，因为那个方向没有环。）

### IF-4 · 草稿级上限需要一条从 `PromptInput` 到 `App` 的通道，§5.1.2 只给了 filter 那一条

§5.3 把 `PASTE_DRAFT_MAX_BYTES` / `PASTE_MAX_BLOCKS` 的生效点定在 `PromptInput`，
§5.1.2 说"这也是 §5.3 的草稿级上限用的那条通道，所以它是 bridge 而不是 filter 的构造参数"。
但 `PromptInput` 手里并没有 `PasteBridge` —— 它在 `cli.tsx` 里创建，只传给了 filter 和 `<App>`。

**处置：** 走 React 的常规形状而不是把 bridge 往下传三层：`PromptInput` 新增可选 prop
`onNotice?(level, text)`，`Composer` 透传，`App` 传自己已有的 `notify` helper。
`PasteBridge` 仍然只服务 filter（它确实在 `render()` 之前构造，确实需要晚绑定）。
两条路最终汇到同一个 `dispatch({type:'notice'})`，I-15 的语义不变。

### IF-5 · `splitPasteFrames` 对 payload 也要跑一次 `sanitisePaste`（G2 从"filter 的性质"变成"composer 的性质"）

§5.4 写的是"paste runs are returned as the filter framed them, because `sanitisePaste` has already
run over them"。挂载态用例 AC-4 第一次运行即红：把一个含裸 `\r` 的帧直接喂给组件，`\r` 一路进了缓冲区。

生产链路上 filter 确实先跑了 `sanitisePaste`，所以这不是一个用户今天能碰到的缺陷。但**同一段正文
自己开了一个口子**：§5.4 规定"An unmatched `PASTE_OPEN` yields its remainder as a paste segment"——
那段 remainder 是任意字节，没有任何人 sanitise 过它。

**处置：** `splitPasteFrames` 对 paste 段跑 `sanitisePaste`。它是幂等的（`paste-parse.test.ts` 有一条
专门断言），所以**正常路径逐字节不变**；买到的是 G2 成为 composer 自己的性质，而不是"取决于这一帧是谁造的"。

### IF-6 · 两处「行数上限」需要一个共享的函数，否则 I-13 只是注释

§5.6 要求 `UserEntry` 的渲染上限与 `estimateEntryRows` 的 `case 'user'` 是**同一个数**，
并给了 `USER_ENTRY_MAX_ROWS + 1` 的表达式。但 T-32 要求断言的是**两者相等**，而不是各自 ≤ 40 ——
两个各自"至多 40"的数完全可以互不相等，而互不相等正是缺陷本身。

**处置：** `UserEntry.tsx` 导出纯函数 `userEntryRenderedRows(lineCount)`，
`virtual-window.test.ts` 的 T-32 断言 `estimateEntryRows(...) === userEntryRenderedRows(...)`。
`estimateEntryRows` 仍按 §5.6 的表达式实现（没有反向依赖组件），函数只是给测试一个可断言的真值。

### IF-7 · `UserEntry` 必须接收 `caps`

§5.6 要求行数上限后面跟一行 `... +N more lines`，§7.6 指定它用 `glyphs.ellipsis`。
`UserEntry` 的文件注释当时明确写着"这也是它不接 `caps` 的原因：它没有自己的 glyph 需要降级"。
加了这一行之后那句话不再成立。

**处置：** `UserEntry` 接 `caps`（唯一调用点 `Transcript.tsx:230` 已有 `caps` 在作用域里），
并就地改写那句注释说明为什么它变了。硬编码 `'...'` 虽然能过 ASCII 扫描，但会在这个包里
留下唯一一个不走 `pickGlyphs` 的用户可见字符。

### IF-8 · `pending` 的拼接顺序：两个前缀家族可以同时命中

§5.1 step 2 说"a trailing strict prefix of either marker becomes `pending`"，把鼠标前缀与粘贴前缀
当成一件事。它们不是：`isMousePrefix` **不匹配** `\x1b[2`（那是两个粘贴标记的公共前缀），
所以必须分别度量、取较长者。

更要紧的是**顺序**：一个 chunk 可以同时以鼠标前缀结尾（在 `splitMouseEvents` 的 `pending` 里）
和以粘贴前缀结尾（我们自己截下的尾巴），此时前者在流里更靠前。天真的 `pending = tail + pending`
会把两段接反，下一个 chunk 到达时拼出一段既不是鼠标报文也不是粘贴标记的垃圾，**并原样打进草稿**。

**处置：** `handleOutsidePaste(text, holdTail)` 显式区分"这段后面还有本 chunk 的字节吗"。
`holdTail=false`（后面紧跟一个标记，任何前缀都不可能再补全）时把鼠标 pending 当普通文本写出去；
`holdTail=true` 时 `pending += split.pending`，随后调用方再 `pending += tail` —— 永远追加，永不前插。

### IF-9 · 光标在整行填满时确实要多占一行

`layoutComposer` 的 T-11 用例（40 个 CJK 字符 / `cols: 40`）在光标位于缓冲区末尾时返回 **3** 行而不是 2：
第二行恰好被填满，光标那一格只能落到第三行行首。

**这是对的**（终端就是这么放光标的，而 composer 必须为它留出预算），但它意味着
`totalRows` 不等于"文本占的行数"。用例改为把光标放在 0 —— 那一条测的是**折行**，不是光标。
记录在这里，是因为下一个人多半会先怀疑是折行算错了。
