# Transcript selection, scroll-follow pause, and the composer-side scroll hint — design specification

> Feature slug: `tui-selection-and-scroll-follow`
> Target: `@aragon-agent/cli` only (`packages/cli`). `@aragon-agent/core` is **untouched** — no engine, provider, tool or event change.
> Version: **v2** (design-review node; v1 was the solution-architect node)
> Status: design reviewed and amended; implementation not started
> Builds on: `docs/plans/mouse-wheel-region-routing/spec.md`, `docs/plans/wheel-scrolls-transcript-only/spec.md`, `docs/plans/tui-input-flicker-fix/spec.md`. Nothing in those documents is retracted; §4.5 of `mouse-wheel-region-routing` (the hint row) and the `ENABLE_MOUSE` constant of `ui/screen.ts` are **amended** here, and the amendments are called out where they occur.
> Requirement (原文):
> 这个项目，现在的 TUI，有一些问题，需要修复完善。TUI 界面，开启进行 Agent 执行的时候，Agent 的执行过程记录和结果显示，显示在了对应的 TUI 界面上。
> - 用户无法进行鼠标选中进行复制，需要能够支持用户进行选中复制
> - 尽管向下自动跳到 Agent 最新返回的内容的地方，但当用户滚动鼠标查看之前的结果的时候，应该停止滚动，除非超过一定时间用户没动，再跳到最新的地方
> - `new lines, PgDn for the latest` 的显示，应该显示在输入框内部即可，不要专门占一行
>
> 相关注意：Anthropic 的顶级产品；美观、优雅、顶级设计，符合人机交互最佳实践；稳健、可靠、顶级。

---

## 0. 评审记录（Review Notes）

Reviewed against the working tree at `packages/cli@0.6.2` — every finding below
was checked in source, not inferred from the document. Severity: **P0** = ships a
silent defect or breaks a documented invariant of an existing subsystem; **P1** =
correctness, testability or acceptance-gate problem that must be resolved before
implementation starts; **P2** = recorded, non-blocking.

Verified sound and left alone: the three root-cause readings in §3 (all line
citations check out), the staging argument (S2 really is what makes S3's
screen-anchored selection safe), the `offset`-from-the-bottom decision (D-2),
`?1002` over `?1003` (D-10), copy-on-release with no modifier (D-5), G6's
"resume only when there is something to resume *to*" (D-3), the dependency
argument (R-6 — `slice-ansi@7.1.2`, `string-width@7.2.0`, `strip-ansi@7.2.0` are
all present in the tree, all MIT, all ESM), and the no-`CONFIG_VERSION`-bump call
(D-11).

### P0

| # | Concern | Where | Resolution in v2 |
| --- | --- | --- | --- |
| **P0-1** | **Rule A is measured against the wrong number and silently breaks viewport virtualisation.** The transcript has been virtualised since `tui-render-performance` (`ui/layout/virtual-window.ts`, `Transcript.tsx:496-508`): entries outside the visible band are replaced by spacers sized from a height cache, and **`selectWindow` takes `offset` as an input**. Three consequences, none of them mentioned in v1. (a) `virtual-window.ts:17-22` (invariant **V-4**) states in as many words that offset-from-the-bottom is what makes virtualisation safe *without a scroll-anchoring compensation pass*, and closes with "Do NOT 'simplify' `offset` to count from the top". Rule A **is** a scroll-anchoring compensation pass, applied indiscriminately, and it converts every above-the-window height change from self-compensating into a jump: Ctrl+T, Ctrl+O, and a first-time measurement of an entry the user just scrolled into all move the reading position. (b) `measureElement(inner).height` is not "new output": it also moves when the scroll horizon drops entries off the *front* (`Transcript.tsx:460`, `entries.slice(-size)`), so `newLinesWhilePaused` counts front-drops as new lines and the idle timer fires on a transcript that produced nothing — the exact failure G6 exists to prevent. (c) R-8's convergence argument, "changing the offset cannot change the content height", **is false here**: offset → `selectWindow` → which entries are mounted → measured-vs-estimated heights → content height → offset. | §4.3.1, R-8, I-7, §5.3 | Rule A now anchors on a **tail-scoped row delta published by the transcript**, not on `measureElement` deltas. §4.3.1 rewritten; new §4.3.1a defines the `tailRowsSink` contract; `Transcript.tsx` moves out of §5.3 into the change plan; R-8 replaced; I-7 restated; T-15/T-16 respecified and T-26/T-27 added. |

### P1

| # | Concern | Where | Resolution in v2 |
| --- | --- | --- | --- |
| **P1-1** | **`/mouse off` re-arms the bug `mouse-wheel-region-routing` was built to fix, and can leave terminal state unbalanced.** `screen.ts:37-53` documents that DEC mode 1007 (alternate scroll) is only left alone *because* `?1000h` suppresses it, and that with reporting off the CLI must `XTSAVE`+disable 1007 so the wheel is inert rather than destructive. `setMouseCapture(false)` as specified writes only `DISABLE_MOUSE`, so the wheel starts emitting arrow keys again and `PromptInput` reads them as prompt-history recall — the draft-clobbering defect, back, on demand. Separately, `restore()` closes over the immutable startup `mouse` boolean, so after a run-time toggle it unwinds the wrong branch. §4.4.6 ("the terminal's own … wheel come back") and manual row 8 ("wheel is inert") also contradict each other. | §4.4.6, §8.3 row 8 | `setMouseCapture` now moves 1007 in strictly paired save/restore with the capture state, `restore()` unwinds the *current* state, and both the §4.4.6 copy and manual row 8 say "inert". New I-10 + AC-14. |
| **P1-2** | **AC-8 cannot pass as written.** §4.4.1 adds `?1002h` to `ENABLE_MOUSE` unconditionally, so a `mouseSelect: false` session writes one more escape sequence than today — while AC-8 requires the wheel-only byte stream to be *identical*. An acceptance criterion that cannot pass gets relaxed rather than met. | §4.4.1, AC-8 | `?1002h` is now gated on `mouseSelect`; `ENABLE_MOUSE` becomes a function of the resolved capability. AC-8 holds literally, and the idle cost for wheel-only users is provably zero rather than argued to be. |
| **P1-3** | **A press with no matching release freezes the viewport permanently, in silence.** `hold` is only cleared by a `release` report. Three ways to never get one: the button is released while the terminal does not have focus; the emulator drops the release; or the terminal ignored `?1006` and fell back to X10, whose reports **cannot express a release at all** (`matchX10` hard-codes `final = 'M'`, `mouse-events.ts:114`) — and under the new decode order an X10 release decodes as `press` with `button = 3`, which the `0 \| 1 \| 2` type says cannot happen. Stuck `hold` ⇒ content anchoring never releases, the resume timer's condition 3 never clears, and the transcript is frozen for the rest of the session with no error and no key that fixes it. | §4.4.2, §4.4.6 | Button events are now emitted **only** from the SGR path (X10 stays wheel-only, as it is today); `clear()` drops the drag as well as the selection; and a `HOLD_MAX_MS` watchdog releases a hold that has seen no motion. New I-11, T-28, T-29. |
| **P1-4** | **The selection is not cleared when the viewport moves by itself.** I-9 enumerates wheel / key / resize / overlay / `/clear` — and misses the two movements this very feature adds: the idle auto-resume jump, and `pinToBottomNonce`. After a 5 s resume the highlight is still painted over rows that now hold completely different text, which is exactly the "false promise about what would be copied" I-9 exists to forbid. | I-9, §4.4.6 | The clear condition is restated as the thing it was always approximating: **the selection is cleared whenever `shiftUp` changes**, i.e. whenever the rows on screen move. That subsumes the enumeration, covers auto-resume and the pin, and — because Rule A holds `shiftUp` constant during a drag — correctly leaves a selection alive while content streams in below it. |
| **P1-5** | **The painter and the extractor slice in different units, so I-4 does not hold on CJK or emoji rows.** `rowSpan` returns *screen columns* (the mouse reports columns). `highlight.ts` feeds them to `sliceAnsi`, whose unit is `visibleCount += isFullWidth ? 2 : character.length` (`slice-ansi/index.js:97`) — columns for CJK, UTF-16 code units for everything else. `selectedText(plainRows, …)` is specified with no slicing unit at all, and the obvious `String.slice` is code units. Two different mappings from the same column range means the copied text is not the highlighted text — silently, which is the one failure mode I-4 names. `pad` compounds it by mixing in `stringWidth`, a third width oracle. | §4.4.4 | A single width-aware `sliceColumns(text, from, to)` is now the only column→character mapping in the feature; both the painter and the extractor call it, `stringWidth` is its single width oracle, and T-30 asserts painter/extractor agreement on a mixed CJK + emoji row rather than testing them apart. |
| **P1-6** | **The first copy of every session prints a diagnostic warning at the user.** Sending OSC 52 through the frame-writer proxy reaches `differ.transform`, which does not recognise it, which is `passThrough(true)` — `fallbacks += 1` and `onFirstFallback()`, wired at `cli.tsx:603` to `console.warn(FRAME_FALLBACK_NOTICE)`. `fallbacks` is documented (`frame-differ.ts:127-136`) to mean "something wrote to stdout behind Ink's back", so the counter `/perf` reports also stops being true. | §4.4.5 | The writer gains an explicit `writeForeign(text)` door: `differ.invalidate()` then a write to the **real** stream, with no fallback accounting. The invalidation the design wanted is kept; the warning and the metric corruption are not. New AC-15. |
| **P1-7** | **A pass-through frame wipes the highlight off the screen and leaves the mirror stale.** `transform` returns `passThrough` on a foreign write, on `log.clear()`-shaped writes, and on the I-9 geometry stand-down. In every one of those the raw Ink frame is written verbatim — no highlight — while the controller still believes a selection is painted, and `mirror` still holds rows from the last decorated frame. A release then copies text that is not on screen. | §4.4.3 | `invalidate()` now notifies the controller, which clears the selection. This is the one hole in I-4's "by construction" argument, and closing it costs one callback. |
| **P1-8** | **"Bump the mouse-notice one-shot key" is under-specified in a way whose obvious reading destroys user state.** `ui-state.ts:45-77` carries a long comment on exactly this: `mouseNoticeSeen` is a boolean, its whole audience already has it `true`, and bumping `UI_STATE_SCHEMA` — the nearest thing to "bump the key" — makes `readFromDisk` discard the object and reset **everyone's** `submitCount` (which un-fades the composer hint for every existing user) *and* re-show the mouse notice. The file already prescribes the right shape and it is not the one v1 asked for. | §5.2 row 31 | Follow the precedent the file documents: add `mouseNoticeVersion: number` alongside (the old boolean deliberately unread), leave `UI_STATE_SCHEMA` untouched. New AC-16. |
| **P1-9** | **Rule A's `setScroll` updater is impure and unclamped.** It mutates `newLinesWhilePaused.current` inside the updater — React may invoke an updater more than once, and this one double-counts when it does. It also accumulates onto `prev.offset`, which is the *raw* state, while everything the user sees derives from `clampScroll(scroll.offset, overflowLines)`; the two diverge after any content shrink (`/clear`, the retain ring, a re-wrap), and the next growth then yanks a pinned viewport upward with a phantom "↓N new lines". | §4.3.1 | The counter is updated outside the updater, and the updater clamps against the metrics it was computed from. |
| **P1-10** | **T-15..T-21 are not writable against `ScrollViewport` as specified.** `ink-testing-library`'s stdout stub reports no `rows` and no height (`__tests__/render-at-width.ts:1-13`, `budget.test.ts` records the same gap), so a mounted `ScrollViewport` measures `viewport === content`, `overflowLines === 0`, and neither rule ever engages. This package already solved that once: `transcript-virtual.test.tsx:1-9` mounts under an explicit geometry context precisely to keep the cases "about the window selection rather than about yoga's measurement of a box the test never sized". The same shape applies here, and it is the shape the rest of the package uses anyway — pure core (`scroll.ts`, `virtual-window.ts`, `frame-differ.ts`) plus a thin adapter. | §4.3, §5.1, §8.1, R-10 | The follow rules move into a pure `ui/layout/follow-state.ts` (`reduceFollow`), tested directly; `ScrollViewport` becomes the adapter. R-10's "extract it if the file gets long" contingency becomes the plan. |

### P2 (recorded; not blocking)

| # | Concern | Disposition |
| --- | --- | --- |
| P2-1 | §3.1 cited `ui/mouse-events.ts:82`; the file is `src/input/mouse-events.ts` (§5.2 row 20 had it right). R-3 cited "(I-5)" meaning `frame-differ.ts`'s I-5, which collides with this document's own I-5. | Both corrected in v2. |
| P2-2 | `Theme.hintFg` is a **required** field (`theme.ts:59`), so `theme.hintFg ?? theme.muted` in the chip is dead defensiveness — kept anyway, because `ScrollViewport.tsx:185` writes it that way today and consistency beats a drive-by. Adding `selectionBg`/`selectionFg` also touches `palettes.ts` (three palettes) and `palettes.test.ts`'s contrast pins, which §5.2 did not list. | File plan corrected; the `??` left as-is. |
| P2-3 | `ARAGON_SCROLL_RESUME_MS` appears in §6.1 but was missing from the §5.2 `env.ts` row, and `--mouse-select` / `--no-mouse-select` need three-place wiring (commander option, `CliFlags`, `toFlags`) that `config.test.ts:676` shows this repo has already been bitten by once. | Both added to the file plan. |
| P2-4 | §1 and §3.3 claim moving the chip "removes" the measurement feedback loop. It removes the *row-count* loop; the chip still consumes columns on the input row, so a draft that fills the line can re-wrap when the chip appears or gains a digit. | Overclaim softened; the chip now renders in a fixed-width cell so the number changing digits cannot re-wrap the draft. |
| P2-5 | Tail-scoped anchoring (P0-1's fix) still treats an entry that grows *between* the reading position and the tail as an above-change. That is the same behaviour as today, and unlike v1's rule it is at least stable. | Documented in §4.3.1a as a bounded limitation. |
| P2-6 | `repaint()` should carry the DEC 2026 sync envelope like every other batch, and must not inflate `framesTotal`/`framesDiffed` — `/perf`'s "frames" would stop meaning "frames Ink produced". | Both specified in §4.4.3. |
| P2-7 | The §4.4.6 lifecycle table did not say what a wheel notch during a held button does, nor what happens to a drag whose coordinates fall outside the frame. | Rows added. |
| P2-8 | N2 (double/triple click) and Q-3 are the same deferral stated twice. Harmless. | Left as-is. |

---

## 1. Overview（概述）

Three complaints, one root cause each, and they are not independent — the fix
for the second is what makes the fix for the first *possible*. Today the CLI
takes the alternate screen, turns on SGR mouse reporting so the wheel can scroll
a transcript that the terminal no longer knows how to scroll, and draws every
row of that screen itself. Each of those three decisions is right. Together they
took three affordances away from the user and only gave two of them back:
the terminal's own drag-to-select is suppressed by `\x1b[?1000h` and nothing
replaced it; the viewport follows the tail *by holding a fixed distance from the
bottom*, which means scrolling up does not actually stop the content moving; and
the "N new lines" hint, having nowhere else to live, took a row out of the very
region it exists to advertise.

This specification restores all three, in the order they can be safely shipped.
**Stage 1** moves the scroll hint out of the viewport and into the composer's
bordered input box, where it costs zero rows and no longer feeds back into the
row count that produced it (it still costs columns on the input row — see §4.2
and P2-4 — but columns are not what the hint's own number is derived from).
**Stage 2** replaces "follow at a fixed distance
from the bottom" with a proper follow state machine: while the user is reading,
the transcript is anchored to the *content*, so incoming output lands below the
window instead of dragging the window along with it; after a configurable idle
period — and only if new output actually arrived while they were paused — the
viewport snaps back to the newest line. **Stage 3** gives the CLI its own text
selection: press-drag-release over the frame highlights exactly the cells the
user dragged across, releasing copies them to the system clipboard (OSC 52
first, so it works over SSH, with the platform clipboard binary as a fallback),
and a toast confirms what was taken.

The staging is deliberate and load-bearing rather than administrative. A
screen-anchored selection is only stable while the rows under it hold still, and
Stage 2 is what makes them hold still: pressing the mouse button *holds* the
viewport, exactly as scrolling does, so the transcript freezes for the duration
of the drag and the highlight the user sees is the text they get. Shipping
Stage 3 without Stage 2 would produce a selection that slides out from under the
pointer during a streaming run — which is when users most want to copy output.
Each stage is independently revertible behind its own switch, and each one is
useful on its own if the next never lands.

---

## 2. Goals and non-goals

### 2.1 Goals

| G | Goal | Requirement |
| --- | --- | --- |
| G1 | Drag with the left mouse button selects text on screen, with live highlight. | #1 |
| G2 | Releasing the button copies the selection to the system clipboard and says so. | #1 |
| G3 | A user who prefers their terminal's own selection can get the mouse back, at run time, without restarting. | #1 |
| G4 | Scrolling up stops the transcript moving; new output accumulates below the window instead of pushing the reading position off the top. | #2 |
| G5 | After a configurable idle period with new output pending, the viewport returns to the newest line by itself. | #2 |
| G6 | A user reading a *static* transcript is never yanked to the bottom. | #2 (correct reading of "除非超过一定时间用户没动") |
| G7 | The "N new lines · PgDn" hint occupies zero dedicated rows and renders inside the input box. | #3 |
| G8 | Every existing keyboard and wheel binding keeps its current meaning. | 稳健 |

### 2.2 Non-goals (and why)

| N | Non-goal | Reason |
| --- | --- | --- |
| N1 | Selecting content that is **off screen** (drag past the top edge to auto-scroll and keep extending). | The selection model is screen-anchored (§4.4.4). Content-anchored selection needs a stable identity per transcript row, which the renderer does not have. Mitigation: scroll first with the wheel/PgUp, then select; the user loses one gesture, not the capability. |
| N2 | Double-click word select / triple-click line select. | Needs click timing and word-boundary rules; a strictly additive follow-up on top of the same event stream. Recorded in §11 Q-3. |
| N3 | Right-click paste, middle-click primary-selection paste. | Platform conventions disagree (X11 vs Windows vs macOS) and there is no way to detect which one the user expects. `?1002h` already delivers the events, so this stays available later. |
| N4 | Selection inside overlays (help, settings, plan review). | Overlays replace the viewport and are short-lived. The mechanism is frame-level and would work; the *value* is low and the highlight over a bordered overlay needs its own visual pass. |
| N5 | Any change to inline (non-full-screen) mode. | Inline mode leaves the transcript in the terminal's native scrollback, where the terminal's own selection already works and the wheel is never captured. Every change here is gated on `fullscreen`. |
| N6 | Persisting the selection across a resize. | A resize re-wraps every line; the screen coordinates stop meaning anything. Selection is cleared on `'resize'`, deliberately and visibly. |

---

## 3. Current behaviour, as measured (not inferred)

Every claim below was read out of the working tree at `packages/cli@0.6.2`.

### 3.1 Why the mouse cannot select (#1)

* `ui/screen.ts:34` — `const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h'`, written on
  entry to the alternate screen whenever a mouse filter was built
  (`cli.tsx:642`).
* Mode 1000 makes the terminal deliver button presses to the application. Every
  mainstream emulator suppresses its own drag-selection while an application is
  tracking the mouse; the bypass modifier is **not portable** (Shift on
  xterm/VTE/Windows Terminal, Fn on macOS Terminal, a preference elsewhere).
* `src/input/mouse-events.ts:82` — `decodeWheel` returns `null` for every
  non-wheel report, and `splitMouseEvents` **consumes and discards** it. The CLI
  therefore receives presses and releases today and throws all of them away.
  (Drags it does *not* receive: motion reporting is off until §4.4.1 turns it
  on.)
* The only mitigation shipped is a one-time startup notice
  (`ui/use-startup-notices.ts:31`): *"Hold Shift to select text, or turn it off
  with `aragon config set mouse false`."* That is a workaround told once, in a
  line that scrolls away, naming a key that does not work everywhere. The user's
  report is the evidence that it is not enough.

### 3.2 Why scrolling up does not stop the content (#2)

`ui/layout/scroll.ts:1-13` defines `offset` as **lines from the bottom**, and
`ui/layout/ScrollViewport.tsx:123-125` derives the paint from it:

```
overflowLines = content - viewport
offset        = rows hidden BELOW the window     (state)
shiftUp       = overflowLines - offset           (rows hidden ABOVE; the margin)
```

Auto-follow at `offset === 0` is free, exactly as the header claims. But the
same arithmetic says that when the user has scrolled up (`offset = 5`, say) and
the agent emits 12 more rows, `overflowLines` grows by 12 while `offset` stays
5 — so `shiftUp` grows by 12 and **the window moves down 12 rows**. The
viewport does not stop; it keeps pace with the stream at a fixed distance from
the tail. What the user is reading slides off the top. There is no idle timer
and no concept of "paused" anywhere in the module.

### 3.3 Why the hint takes a row (#3)

`ui/layout/ScrollViewport.tsx:175-193` renders the hint as the **last row of the
viewport**, with a comment that states the trade honestly: *"This takes the
viewport's last row, trading one line of content for a hint that cannot drift."*
`ui/layout/budget.ts:15-18` records the same thing from the other side — the
hint is one of two consumers deliberately left out of the row budget.

Two costs follow. One row of the user's content is spent on chrome exactly when
the transcript is longest, and the hint's own presence shrinks the viewport,
which changes `overflowLines`, which is the number the hint displays — the
feedback loop that `BOTTOM_SNAP_TOLERANCE` (`scroll.ts:41`) exists to damp.
Moving the hint into the composer removes *that* loop instead of damping it: the
composer's height is fixed by `chromeBudget` (`budget.ts:35-42`) and does not
move when the number does. What the chip still costs is **columns on the input
row**, which can re-wrap a draft that fills the line; §4.2 spends a fixed-width
cell to make that transition happen at most once rather than once per digit.

---

## 4. Technical design

### 4.1 Stage map

| Stage | Delivers | Switch | Depends on |
| --- | --- | --- | --- |
| S1 | Hint relocated into the input box | none (unconditional; it removes a row rather than adding one) | — |
| S2 | Follow state machine: content anchor + idle resume | `scrollResumeMs` (`0` = never resume) | S1 (the hint number changes meaning) |
| S3a | Selection, highlight, copy | `mouseSelect` (default `true`) | S2 (`hold`) |
| S3b | Run-time mouse release (`/mouse`), help + notice copy | — | S3a |

### 4.2 S1 — the hint moves into the input box

**Delete** the hint block from `ScrollViewport` (`ScrollViewport.tsx:175-193`)
and the `TERSE_HINT_COLS` constant. `ScrollViewport` already publishes the
number through `onScrolledLinesChange(offset)` and `App` already holds it in
`scrolledLines` for the status bar's `↑N` — so the data is in place and no new
state is introduced.

**Thread** `scrolledLines` from `App` → `Composer` → `PromptInput`, and render
it as a right-aligned chip on the **input row, inside the border**:

```tsx
// PromptInput.tsx — inputRow
<Box flexDirection="row">
  <Text color={markerColor} bold>{marker}{' '}</Text>
  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
    {/* placeholder / buffer lines, unchanged */}
  </Box>
  {chip !== null && (
    <Box flexShrink={0} alignSelf="flex-start" marginLeft={1} width={chipCells} justifyContent="flex-end">
      <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>{chip}</Text>
    </Box>
  )}
</Box>
```

Five properties of that snippet are load-bearing:

* `flexShrink={0}` on the chip and `flexShrink={1}` on the text column: under
  pressure the *draft* wraps, never the chip. A half-truncated `↓ 12 new li` is
  worse than no chip.
* `alignSelf="flex-start"` pins the chip to the first row of a multi-line draft.
  Yoga's default `stretch` would size the chip box to the full height of the
  editor; it renders on the top row either way today, and relying on that is how
  a later `justifyContent` edit moves it without failing anything.
* The chip is rendered **only when `bordered` is set**, i.e. full-screen mode.
  Inline mode has no self-drawn viewport and `scrolledLines` is always 0 there
  (`StatusBar.tsx:38-42` already documents this), so the branch is unreachable
  rather than merely unused — but the guard is explicit so it stays that way.
* The chip does **not** consult `showHint` / `hintsEnabled`. Those govern the
  *teaching* row below the box (`Composer.tsx:156`), which fades away with
  experience and is dropped on short terminals. "You are 12 rows behind the
  newest output" is state, not a tutorial, and must survive both.
* `width={chipCells}` is a **fixed** cell, not the chip's natural width (P2-4).
  The chip is the only thing on this row whose width changes while the user is
  typing — `↓ 9` becomes `↓ 10` becomes `↓ 100` — and every change re-wraps a
  draft that fills the line. A cell wide enough for the longest form the current
  branch can produce makes that transition happen once, when the chip appears,
  instead of once per digit. `justifyContent="flex-end"` keeps it right-aligned
  inside the cell.

Chip text, built from `pickGlyphs(caps)` and never from a literal (§4.6 I-5).
`n` is clamped to `CHIP_MAX_N` (999) with a `+` suffix beyond it, so `chipCells`
is a constant per branch rather than a function of how far behind the user is:

| Terminal width | Chip | `chipCells` |
| --- | --- | --- |
| `cols >= CHIP_FULL_MIN_COLS` (64) | `↓ 12 new lines · PgDn` (`line` when `n === 1`) | 24 |
| below | `↓12` | 5 |

`budget.ts` needs **no arithmetic change** — the hint was never in the budget.
Its §15-19 scope comment must lose the hint bullet, or it becomes a false
statement about a row that no longer exists (this repo has paid for stale
comments before: `wheel-scrolls-transcript-only` RV-3).

### 4.3 S2 — the follow state machine

#### 4.3.1 The two rules

`ScrollViewport` stays the single owner of the offset (its header's P1-7). Two
rules are added around the existing arithmetic; `scroll.ts` itself is
**unchanged**, so every existing scroll test keeps passing. Both rules are pure
and live in `ui/layout/follow-state.ts` (P1-10); `ScrollViewport` is the adapter
that feeds them and applies the result.

**Rule A — tail anchoring.** When rows are appended **at the tail** while the
user is *not* pinned to the bottom, grow the offset by the same amount.
`shiftUp = overflowLines - offset` is then constant, and the rows on screen do
not move.

The input is `tailRows` — a monotonic count of rows the transcript has produced
at its tail — and **not** `measureElement(inner).height` (P0-1). The distinction
is the whole of Rule A's correctness, so it gets its own section below.

```ts
// follow-state.ts — pure
export interface FollowInput {
  offset: number;          // current raw offset (already clamped by the caller)
  overflowLines: number;
  tailDelta: number;       // signed; rows appended at (or removed from) the tail
  hold: boolean;
  newLinesWhilePaused: number;
}
export interface FollowOutput {
  offset: number;
  newLinesWhilePaused: number;
}

export function reduceFollow(input: FollowInput): FollowOutput {
  const { offset, overflowLines, tailDelta, hold } = input;
  // Pinned and not holding: anchoring is free — `offset` stays 0 and the
  // existing arithmetic keeps showing the tail. `hold` lifts the precondition
  // because a drag that starts while pinned must still freeze the rows under
  // the pointer (S3), and freezing means the pin becomes an anchor for the
  // duration of the drag.
  if (offset === 0 && !hold) return { offset, newLinesWhilePaused: 0 };
  if (tailDelta === 0) return { offset, newLinesWhilePaused: input.newLinesWhilePaused };
  const next = clampScroll(offset + tailDelta, overflowLines);
  return {
    offset: next,
    // Only real arrivals arm the resume timer, and reaching the bottom by any
    // route resets the count (§4.3.1 Rule B, condition 2 / G6).
    newLinesWhilePaused:
      next === 0 ? 0 : Math.max(0, input.newLinesWhilePaused + tailDelta),
  };
}
```

```ts
// ScrollViewport.tsx — the adapter
const prevTail = useRef(0);
useLayoutEffect(() => {
  const viewport = clipRef.current ? measureElement(clipRef.current).height : 0;
  const content  = innerRef.current ? measureElement(innerRef.current).height : 0;
  setMetrics(prev => (prev.viewport === viewport && prev.content === content ? prev : { viewport, content }));

  const tail = tailRowsRef.current;            // §4.3.1a
  const tailDelta = tail - prevTail.current;
  prevTail.current = tail;
  if (tailDelta === 0) return;

  const overflow = Math.max(0, content - viewport);
  // P1-9: the decision is taken OUTSIDE the updater and against the CLAMPED
  // offset. Outside, because React is free to invoke an updater more than once
  // and a `newLinesWhilePaused += grew` inside one double-counts when it does.
  // Clamped, because `scroll.offset` is raw state while everything on screen
  // derives from `clampScroll(...)`; the two diverge after any content shrink
  // (`/clear`, the retain ring, a re-wrap), and an unclamped accumulation then
  // yanks a viewport the user believes is pinned and shows a phantom chip.
  // `offsetRef` carries the rendered value, assigned during render (§7).
  const out = reduceFollow({
    offset: clampScroll(offsetRef.current, overflow),
    overflowLines: overflow,
    tailDelta,
    hold: holdRef.current,
    newLinesWhilePaused: newLinesRef.current,
  });
  newLinesRef.current = out.newLinesWhilePaused;
  if (out.offset !== offsetRef.current) setScroll({ offset: out.offset });
  armResume();
});
```

Signed, not growth-only. A tail *shrink* is rows that no longer exist below the
reading position, so shrinking the offset by the same amount is what keeps the
screen still — and it is self-correcting when the source of the delta was an
upper-bound height estimate that a later measurement brings down (§4.3.1a). A
change that is **not** at the tail leaves the offset alone, which is exactly
what `virtual-window.ts`'s V-4 requires (see below).

#### 4.3.1a Where `tailRows` comes from, and why it is not `content`

`measureElement(inner).height` is the height of everything the transcript is
currently drawing. Four different things move it, and only one of them is "the
agent produced output":

1. rows appended at the tail — what Rule A must react to;
2. an entry **above** the reading position changing height — Ctrl+T
   (`thinkingVisible`), Ctrl+O (`expandedToolIds`), or the first real
   measurement of an entry that was standing on an estimate;
3. the scroll horizon dropping entries off the **front**
   (`Transcript.tsx:460`, `entries.slice(-size)`);
4. a re-wrap after a resize.

For (2) and (3) the offset must **not** move. `virtual-window.ts:17-22`
(invariant **V-4**) is explicit about why: counting the offset from the bottom
makes an above-the-viewport height change self-compensating — the content and
the rows hidden above move by the same δ, so the same text stays under the same
row — and that is what buys virtualisation its "no scroll-anchoring
compensation pass required". Reacting to total content growth would make Rule A
that compensation pass, applied to changes that never needed compensating, and
V-4's closing line ("Do NOT 'simplify' `offset` to count from the top") is a
warning against precisely this class of edit. It would also make (3) look like
new output and arm the idle timer on a transcript that produced nothing — the
failure G6 exists to prevent.

There is a second, sharper reason. `selectWindow` **takes `offset` as an input**
(`virtual-window.ts:293-302`), so the mounted set — and therefore which entries
are measured rather than estimated — is a function of the offset. An offset that
is in turn a function of the measured height closes a loop: offset → mounted set
→ measured heights → content height → offset. R-8's "changing the offset cannot
change the content height" does not hold in this package, and the convergence it
argued for is not available.

So the number Rule A consumes is published by the component that already knows
it. `TranscriptList` builds a per-entry height table on every frame
(`Transcript.tsx:496-506`, `selectWindow`'s `heightOf` loop); computing rows
appended at the tail from that table is one more pass over an array it has
already walked:

```ts
// Transcript.tsx — written during render, alongside `mountedSink`
export interface TailSink { current: { rows: number; lastId: string | null } }

// rows appended since the previous frame =
//   heights of entries after the previously-last entry
//   + the delta of that entry's own height (a streaming entry grows in place)
```

The sink is a **ref written during render**, not a `setState`: `mountedSink`
(`Transcript.tsx:452-457`, `if (mountedSink) mountedSink.current = slice.length`)
is the same pattern, introduced for the same reason — "a `setState` here would
make observing the render budget cost a render".

Three properties of the tail counter matter:

* **It is offset-independent.** It reads the height table, never the geometry
  context, so the loop above is broken by construction rather than by a
  convergence argument.
* **It is signed and self-correcting.** While paused, a streaming tail entry may
  be a spacer standing on `estimateEntryRows`, which is deliberately an *upper*
  bound (`virtual-window.ts:167-175`); when it is finally measured the tail total
  comes down, `tailDelta` is negative, and the offset follows it back. An
  unsigned rule would over-count once and never correct.
* **Its identity anchor is the last entry's `id`.** When the horizon drops the
  entry the counter was anchored on, the counter re-anchors on the new last
  entry and contributes a delta of 0 for that frame. Losing one frame of
  anchoring is a row of drift at worst; treating a front-drop as tail motion is
  a visible jump.

**Known limitation (P2-5).** An entry that grows *between* the reading position
and the tail — a tool card that keeps streaming after a later entry exists — is
attributed to (2) and moves the screen by its delta. That is what happens today
as well; the difference is that it is now the only case left, and it is stable
rather than intermittent. Fixing it needs per-row content identity, which is the
same thing N1 declines for the selection model.

**Rule B — idle resume.** A timer, armed only when *all three* hold:

1. `offset > 0` — there is somewhere to return from;
2. `newLinesWhilePaused > 0` — something arrived that is worth returning **to**
   (this is G6: a user reading a finished transcript is never yanked);
3. `!hold` — no selection drag is in progress (§4.4).

The timer is `scrollResumeMs` long (default 5000, `0` disables), reset by every
applied scroll intent, and on fire it does exactly `setScroll({ offset: 0 })` —
a jump, not an animation. Animated catch-up in a 30 fps terminal is jank
pretending to be polish; the hint chip disappearing is the feedback.

```ts
const resumeTimer = useRef<NodeJS.Timeout | null>(null);
const armResume = useCallback(() => {
  if (resumeTimer.current) { clearTimeout(resumeTimer.current); resumeTimer.current = null; }
  if (!resumeMs || resumeMs <= 0) return;
  if (offsetRef.current === 0) return;
  if (newLinesRef.current === 0) return;
  if (holdRef.current) return;
  resumeTimer.current = setTimeout(() => {
    resumeTimer.current = null;
    if (holdRef.current) return;              // re-checked at FIRE time, not only at ARM time
    setScroll({ offset: 0 });
  }, resumeMs);
  resumeTimer.current.unref?.();
}, [resumeMs]);
```

`armResume()` is called from three places and no others: the intent effect
(after applying a scroll), the anchoring effect (after a non-zero `tailDelta`),
and the `hold` falling edge. `newLinesWhilePaused` resets to 0 whenever the
offset reaches 0 by any route — timer, `pinToBottomNonce`, PgDn, or the bottom
snap — and `reduceFollow` is where that reset is expressed for the anchoring
route, so there is one rule and not two.

The re-check inside the callback is the same class of bug the wheel router's
flush already guards (`use-wheel-routing.ts:96-102`): the decision that goes
stale is the one taken when the timer was armed, and 5 seconds is an eternity
next to a 16 ms coalescing window.

#### 4.3.2 What the number means now

Before this change, `offset` while paused meant "how far the window sits above
the tail", and it stayed put while the tail ran away. After it, `offset` is
literally "rows of new output below your reading position" — which is what the
chip has always claimed to say and what `PgDn` traverses. The status bar's `↑N`
(`StatusBar.tsx:276`) gains the same improvement for free and needs no edit.

#### 4.3.3 Interaction with what already exists

| Existing behaviour | After S2 |
| --- | --- |
| `pinToBottomNonce` bumped on submit (`App.tsx:1182`) | Unchanged, and it also clears `newLinesWhilePaused`. Submitting is still an unconditional "take me to the newest output". |
| `applyScroll` bottom snap within 2 rows | Unchanged. Reaching offset 0 by any route resets the paused counters. |
| Overlay open ⇒ `ScrollViewport` unmounts | Unchanged; the timer dies with the component. Reopening starts pinned, as today. |
| Wheel coalescing (16 ms) | Unchanged. One coalesced burst = one intent = one timer reset. |
| Nothing published `shiftUp` | `ScrollViewport` now also calls `onViewportShiftChange(shiftUp)` — same publish-not-lift shape as `onScrolledLinesChange`, no second owner. It is what S3 clears the selection on (I-9 / P1-4): `shiftUp` changes exactly when the rows on screen move, which is the property the enumerated clear-list was approximating. During a drag Rule A holds it constant, so a selection survives streaming output below it — and only that. |

### 4.4 S3 — selection and copy

#### 4.4.1 Mouse protocol change

`ui/screen.ts` turns two constants into functions of one capability
(**P1-2** — `?1002h` is added *only* when drag-select is on):

```ts
const enableMouse  = (motion: boolean): string =>
  '\x1b[?1000h' + (motion ? '\x1b[?1002h' : '') + '\x1b[?1006h';
const disableMouse = (motion: boolean): string =>
  '\x1b[?1006l' + (motion ? '\x1b[?1002l' : '') + '\x1b[?1000l';   // exact reverse
```

`AltScreenOptions` gains `readonly motion: boolean`, carrying the same "already
decided elsewhere" discipline its `mouse` field documents: `cli.tsx` passes
`mouseFilter !== null && cfg.mouseSelect`, and `screen.ts` still derives nothing
for itself.

Gating rather than always-on is what makes AC-8 an assertion instead of an
aspiration: with `mouseSelect: false` the byte stream is *identical* to today's,
so S3 is revertible at run time with nothing left behind on the wire. An
unconditional `?1002h` would have made AC-8 fail on day one, and a failing
acceptance criterion gets relaxed rather than met.

`?1002` is **button-event tracking**: motion is reported *only while a button is
held*. The current comment at `screen.ts:27-33` lumps it with `?1003`
(any-event) and dismisses both as "floods stdin on every pointer move" — true of
1003, false of 1002, and that sentence must be corrected in the same commit or
it becomes a documented reason not to do what we just did. Idle cost of 1002 is
zero reports; drag cost is bounded further by the 16 ms motion coalescer
(§4.4.3).

#### 4.4.2 Event model

`src/input/mouse-events.ts` stops discarding non-wheel reports:

```ts
export interface WheelEvent  { kind: 'wheel'; dir: 'up' | 'down'; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean; }
export interface ButtonEvent { kind: 'press' | 'drag' | 'release'; button: 0 | 1 | 2; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean; }
export type MouseEvent = WheelEvent | ButtonEvent;
```

Decode order in `decodeReport(b, x, y, final)` — **order is the specification**,
as the existing header already says of the horizontal-wheel test:

1. `b & 64` → wheel. Existing branch verbatim, including the `b & 3 >= 2`
   horizontal drop and the press-only `final === 'M'` rule.
2. `b & 32` → `drag`, `button = (b & 3)`; `3` (no button) is dropped.
3. `final === 'm'` → `release`.
4. otherwise → `press`, `button = (b & 3)`; `3` is dropped.

**Button events come from the SGR path only** (P1-3). `matchX10`
(`mouse-events.ts:109-115`) reconstructs a legacy report and hard-codes
`final = 'M'`, because X10 has no separate release form at all — it encodes
release as button 3 of a press. Feeding that through the table above yields a
`press` that is never followed by a `release`, whose `button` is `3` while the
type says `0 | 1 | 2`, and whose consequence is a `hold` that is set and never
cleared: content anchoring never lets go, the resume timer's condition 3 never
clears, and the transcript is frozen for the rest of the session with nothing
raised anywhere. X10 therefore keeps its current contract — wheel events or
nothing — and `decodeReport` takes an `encoding: 'sgr' | 'x10'` argument so that
rule is expressed in the code rather than remembered. This costs nothing real:
we never request X10, and a terminal that ignores `?1006` also has no drag
coordinates past column 223 (R-2).

`MouseSource.subscribe` widens from `(e: WheelEvent) => void` to
`(e: MouseEvent) => void`. `use-wheel-routing.ts` gains one line at the top of
`route()` — `if (event.kind !== 'wheel') return;` — and is otherwise untouched.
Widening the single channel rather than adding a second is what keeps arrival
order intact between a wheel notch and a press; two channels would let a press
overtake the notch that preceded it.

#### 4.4.3 The frame pipeline: mirror, highlight, repaint

The selection must (a) know what text is on every screen row, and (b) repaint a
highlight without a React commit. Both fall out of one hook on the frame differ,
which already sees every frame Ink produces and already owns the line cache.

```
Ink commit ──► stdout proxy ──► differ.transform(chunk)
                                    │  split into raw lines
                                    ▼
                              decorate(rawLines)  ◄── SelectionController
                                    │   • mirror.set(rawLines)
                                    │   • paint highlight for the current selection
                                    ▼
                              diff vs painted cache ──► only changed rows ──► real stdout

drag event ──► SelectionController.update() ──► writer.repaint()
                                                    │ decorate(rawPrev) again
                                                    ▼ diff vs painted cache
                                              1–3 changed rows ──► real stdout
```

`frame-differ.ts` changes, and nothing else about it moves:

```ts
export interface FrameDifferOptions {
  sync: boolean;
  rows: () => number | undefined;
  onFirstFallback?: () => void;
  /** Raw frame lines in, lines to paint out. Identity when absent. */
  decorate?: (lines: string[]) => string[];
  /**
   * Raised whenever the cache is dropped — a foreign write, a resize, a
   * geometry stand-down, an explicit `invalidate()`.
   *
   * P1-7: on every one of those paths the raw Ink frame reaches the screen
   * verbatim, so the highlight is wiped off the terminal while the controller
   * still believes it is painted and `mirror` still holds the rows of the last
   * decorated frame. A release then copies text that is not on screen. I-4's
   * "by construction" argument has exactly this hole, and one callback closes
   * it: the controller clears the selection.
   */
  onInvalidate?: () => void;
}
export interface FrameDiffer {
  transform(chunk: string): string | null;
  invalidate(): void;
  stats(): FrameWriterStats;
  /** Re-run `decorate` over the last frame; '' when there is nothing safe to do. */
  repaint(): string;
}
```

* Two caches instead of one: `rawPrev` (undecorated) and `prev` (painted — what
  is actually on the screen). The diff continues to compare **painted** lines, so
  invariants I-4 / I-5 / I-6 hold verbatim and the cache still equals the screen.
* `decorate` is called after the `lines.length + 1 > rows` guard and before the
  cache comparison, so a stood-down frame never reaches the selection layer.
* `repaint()` returns `''` when `prev === null` (invalidated) or when geometry
  stood down. That is a real state — a `/copy`, an OSC 52 write, or a resize will
  produce it — and the fallback is `App`'s existing `redrawNonce` (`App.tsx:1394`,
  the Ctrl+L carrier): the controller asks for a React redraw, the next commit
  runs `decorate`, and the highlight appears one frame later instead of never.
* `repaint()`'s payload carries the same DEC 2026 sync envelope as every other
  batch and parks on row `H + 1` (`frame-differ.ts`'s I-5), because it is
  addressed exactly like a diff frame and a half-applied highlight tears the
  same way a half-applied frame does.
* `repaint()` does **not** touch `framesTotal` / `framesDiffed` (P2-6). Those
  count frames *Ink produced*; folding self-initiated repaints in would make
  `/perf`'s frame rate a function of how much the user drags. It gets its own
  `repaints` counter, or none at all.

`stdout-frame-writer.ts` gains two methods on the handle:

| Method | Writes | Accounting |
| --- | --- | --- |
| `repaint(): void` | `differ.repaint()` to the **real** stream when non-empty. | Not a frame. |
| `writeForeign(text: string): void` | `differ.invalidate()`, then `text` to the **real** stream. | Not a fallback (P1-6). |

Neither may go through the proxy. For `repaint()` the reason is the obvious one:
the proxy's `write` would hand it back to `transform`, which would not recognise
it and would `invalidate()` — turning every drag frame into a full repaint. For
`writeForeign` the reason is subtler and cost the review a finding: a
`transform` that does not recognise a chunk takes `passThrough(true)`, which
increments `fallbacks` and, on the first one, calls `onFirstFallback` — wired at
`cli.tsx:603` to `console.warn(FRAME_FALLBACK_NOTICE)`. Sending OSC 52 through
the proxy (§4.4.5) therefore prints a diagnostic warning at the user the first
time they copy anything, and permanently corrupts a counter documented
(`frame-differ.ts:127-136`) to mean "something wrote to stdout behind Ink's
back". `writeForeign` keeps the invalidation the design wants and drops the
accusation it does not.

Motion coalescing: the controller keeps at most one pending `drag` and flushes
on a 16 ms timer, the same window and the same reasoning as
`use-wheel-routing.ts:46` (*"this one is in the direct path of a hand
gesture"*). A fast drag across 40 columns therefore costs ~3 repaints of ~2 rows
each, not 40 full frames.

#### 4.4.4 Selection model and text extraction

Pure module `ui/selection/selection.ts`, no React, no I/O:

```ts
export interface Cell { row: number; col: number; }              // 0-based, screen coords
export interface Selection { anchor: Cell; focus: Cell; }
export interface NormalSelection { start: Cell; end: Cell; }      // start <= end in reading order

export function normalize(sel: Selection): NormalSelection;
export function isEmpty(sel: NormalSelection): boolean;           // start === end
export function selectedText(plainRows: string[], sel: NormalSelection): string;
export function rowSpan(sel: NormalSelection, row: number): { from: number; to: number } | null;

/**
 * The ONE column→character mapping in this feature (P1-5). `from`/`to` are
 * SCREEN COLUMNS, half-open, and `stringWidth` is the single width oracle.
 */
export function sliceColumns(text: string, from: number, to?: number): string;
```

`selectedText` is linear (not rectangular), which is what every terminal does:
first row from `start.col` to end of line, whole middle rows, last row up to
`end.col`, each `trimEnd()`ed, joined with `\n`. `rowSpan` returns the half-open
column range to highlight on a given row, or `null` when the row is outside the
selection.

**`rowSpan` alone is not enough to make the highlight and the clipboard agree**,
and v1 said it was. It settles *which columns* are selected; what breaks I-4 is
the second step, turning columns into characters, which v1 left to two different
tools. The painter's `sliceAnsi(line, from, to)` advances its cursor by
`isFullWidth ? 2 : character.length` (`slice-ansi/index.js:86-98`) — display
columns for CJK, but UTF-16 code units for everything else, so a combining mark
costs it a column that occupies none and an astral code point costs two. The
extractor was specified against `plainRows` with no unit named at all, and the
obvious `String.slice(from, to)` is code units throughout. Two mappings from one
range means the copied text is not the highlighted text on any row containing
CJK, emoji or an accent built from a combining mark — silently, which is the one
failure mode I-4 exists to name.

So both call `sliceColumns`, which walks grapheme clusters and charges each one
`stringWidth(cluster)` columns. `stringWidth` is then the only width authority in
the feature, and `pad = (to - from) - stringWidth(mid)` stops mixing oracles.
T-30 asserts the two agree on a mixed CJK + emoji + combining-mark row, because
asserting them separately is what let the mismatch through.

Screen ↔ event coordinates: SGR reports are 1-based, frame line `i` is terminal
row `i + 1`, so `row = y - 1`, `col = x - 1`. Out-of-frame rows are clamped into
`[0, frameLines - 1]`.

**Why screen coordinates are safe here.** They are only safe because the rows
hold still, and holding them still is Stage 2's job. `press` sets `hold = true`,
which anchors the content (Rule A, precondition lifted) and suspends the resume
timer (Rule B condition 3). During the drag the transcript rows are frozen; the
only rows that keep changing are the chrome — status bar, activity line,
composer — which the user is not selecting. And because the highlight and the
copy both read the **same mirror**, whatever *does* change under the selection is
simultaneously what is highlighted and what is copied. What you see is what you
get, by construction, rather than by a staleness check that can be wrong.

Painting a row (`ui/selection/highlight.ts`):

```
head = sliceColumns(line, 0, from)                     // ANSI-aware, column-indexed
mid  = stripAnsi(sliceColumns(line, from, to))         // SGR stripped, then repainted
pad  = ' '.repeat(max(0, (to - from) - stringWidth(mid)))
out  = head + SEL_ON + mid + pad + SGR_RESET + sliceColumns(line, to)
```

(`sliceColumns` is `slice-ansi` re-indexed on `stringWidth` — the escape-code
bookkeeping is the part worth taking from that package, and the column
arithmetic is the part that has to be ours, §4.4.4.)

Stripping SGR inside the selection is not laziness: an inner `\x1b[0m` — which
`Markdown` and `cli-highlight` emit constantly — would cancel the inverse
attribute mid-selection and leave holes in the highlight. Terminals repaint
selected text in the selection's own colours for exactly this reason. `SEL_ON`
is `theme.selectionBg`/`selectionFg` when `caps.colorLevel > 0`, and plain
reverse video `\x1b[7m` when it is 0. `pad` is what gives a multi-row selection
a straight right edge over short lines.

#### 4.4.5 Clipboard

New `ui/clipboard.ts`, and `/copy` (`commands/builtins.ts:1143`) is refactored
onto it — the duplicate disappears and `/copy` gains SSH support on the way:

(signature below — it takes a write *door*, not a stream, for the reason in the
paragraph after the list)

1. **OSC 52** (`\x1b]52;c;<base64>\x07`) when
   `Buffer.byteLength(text) <= MAX_OSC52_BYTES` (56 000; xterm's default limit is
   ~100 000 *base64* characters and tmux/screen are stricter). It reaches the
   clipboard of the machine the *user* is sitting at, which is the only correct
   target over SSH, and it is the only mechanism that works with no helper binary
   installed.
2. **Platform binary** (`clip` / `pbcopy` / `xclip -selection clipboard`), the
   existing best-effort spawn, moved here unchanged.

Both are attempted; the return value names the better one for the toast. Neither
is detectable, so the toast says what was *sent*, never "copied successfully" on
a guess.

The OSC 52 write goes out through `writeForeign` (§4.4.3), **not** through the
frame-writer proxy. The instinct v1 recorded is right — it is a foreign write,
the differ must invalidate, and one full repaint after a copy is the correct
price — but the proxy charges a second price that was not on the receipt: an
unrecognised chunk is `passThrough(true)`, which raises `onFirstFallback`, which
is `console.warn(FRAME_FALLBACK_NOTICE)`. The first copy of every session would
print a diagnostic at a user who did nothing wrong (P1-6). `copyText` therefore
takes a `write: (text: string) => void` rather than a `NodeJS.WriteStream`, so
the caller supplies the right door and the module cannot pick the wrong one:

```ts
export type CopyVia = 'osc52' | 'native' | 'none';
export function copyText(text: string, write?: (chunk: string) => void): CopyVia;
```

`/copy` passes the same door. In inline mode, where there is no frame writer,
`write` is `stdout.write.bind(stdout)` and nothing needs invalidating.

#### 4.4.6 Lifecycle, and the escape hatch

| Event | Effect |
| --- | --- |
| `press` (button 0, full-screen, `mouseSelect`, no overlay) | `anchor = focus = cell`; `hold = true`; repaint. |
| `press` (any other button, or an overlay is open) | Clear any selection; do nothing else. |
| `drag` (button 0) | `focus = cell` (coalesced 16 ms); repaint. |
| `release` | `hold = false`; if the normalized selection is non-empty → `copyText(selectedText(mirror.plain, sel))` + toast; keep the highlight; arm the resume timer. |
| `release` with an empty selection (a plain click) | Clear the selection, no toast, no clipboard write. A stray click must never leave a one-cell highlight or clobber the clipboard. |
| **`shiftUp` changed** (wheel, key, PgDn, bottom snap, `pinToBottomNonce`, **idle auto-resume**, a height correction above the reading position) | Clear the selection and repaint. Screen coordinates stop meaning anything the moment the rows move — and this is the *derived* form of the rule, so a new way to move the viewport cannot forget to join the list. Rule A holds `shiftUp` constant while `hold` is set, which is why a drag survives output streaming in below it. |
| Any key, `'resize'`, overlay open, `/clear`, `differ.invalidate()` | Clear the selection. Kept as an explicit list *as well* because three of them (a key that scrolls nothing, an overlay swap, a pass-through frame) can leave `shiftUp` untouched while the screen changes anyway (P1-7). |
| Wheel notch **while a button is held** | Clear the selection and drop the drag, then let the notch scroll normally. A wheel during a drag is a user changing their mind, not extending a selection; N1 already declines auto-scroll-while-dragging. |
| `drag` / `press` whose coordinates fall outside the frame | Clamp into `[0, frameLines - 1]` × `[0, cols - 1]`. A report from a terminal that resized mid-drag must not index past the mirror. |
| No `release` for `HOLD_MAX_MS` (default 30 s) with no intervening `drag` | Drop `hold` and the drag; keep whatever was selected. **The escape hatch for a lost release** (P1-3): focus moves to another window mid-drag, the emulator swallows the button-up, or a terminal misreports one. Without it `hold` never clears — content anchoring never releases, the resume timer's condition 3 never passes, and the transcript is frozen for the rest of the session with nothing raised anywhere. `clear()` drops the drag too, so any key is also a way out. |

`Esc` is deliberately **not** bound to "clear selection". `Esc` aborts a run, and
a second meaning that silently absorbs the first press is the last thing an
emergency exit needs (`Composer.tsx:63-72` makes the same argument about the
abort hint). Clearing is already covered by "any key".

**G3, the escape hatch.** `screen.ts`'s handle gains
`setMouseCapture(on: boolean): void`. It is a no-op when the session never had a
filter — and it moves **two** modes, not one (P1-1):

```ts
// on  → RESTORE_ALT_SCROLL (if we had saved it) + enableMouse(motion)
// off → disableMouse(motion) + SAVE_ALT_SCROLL_OFF
```

DEC mode 1007 (*alternate scroll*) is the half v1 dropped, and dropping it
re-arms the defect `mouse-wheel-region-routing` was built to remove.
`screen.ts:37-53` states the rule in full: with reporting **on**, 1007 is left
alone because `?1000h` already suppresses it; with reporting **off**, 1007 is
saved and disabled so the wheel is *inert* rather than translated into a burst
of arrow keys — which `PromptInput` reads as prompt-history recall, replacing
the user's draft with an old prompt. A `/mouse off` that writes only
`DISABLE_MOUSE` therefore hands that bug back to the user on request, in the
one command whose entire purpose is to make things better.

Two further consequences of 1007 being terminal state this app does not own:

* The save/restore must stay **strictly paired**. `XTSAVE` has one slot per
  mode, so an `off` that saves while our own disable is already in effect would
  save *our* value and `restore()` would hand the user the wrong preference
  permanently. Pairing every `off` with a preceding `on` that restores keeps the
  saved value the user's own, always.
* `restore()` must unwind whichever state is **current**, not the one the
  session started in. Today it closes over an immutable `mouse` boolean
  (`screen.ts:89-108`); after S3b that boolean is no longer the truth, and the
  exit path is the one place where being wrong leaves the user's shell broken
  until they run `reset`. The handle keeps a mutable `captured` flag and
  `restore()` reads it.

Surfaced as `/mouse [on|off]`:

* `off` → capture released. The terminal's own drag-selection comes back and the
  wheel goes inert. Toast: *"Mouse released to the terminal — the wheel will not
  scroll. `/mouse on` gives it back."* Naming the cost is the honest thing to do
  and it is one clause.
* `on` → recaptured, with `?1002h` present only if `mouseSelect` is on (§4.4.1).
* no argument → report the current state.

This is the honest answer to "a user who wants their terminal's selection", and
it is reversible in one command instead of a restart plus a config edit. The
existing permanent switches (`--no-mouse`, `ARAGON_MOUSE=0`, `mouse: false`) are
unchanged. `mouseSelect: false` is the third rung: keep wheel scrolling, leave
drag-select off.

### 4.5 Sequence — a copy during a live run

```
run streaming, viewport pinned (offset 0)
  │
  ├─ user presses LMB on row 14, col 8
  │     SelectionController: anchor=focus=(13,7), hold=true
  │     App:  hold → ScrollViewport `hold` prop
  │     ScrollViewport: tail growth now increments offset  → shiftUp constant → rows FREEZE
  │     writer.repaint() → 1 row painted (the anchor cell)
  │
  ├─ user drags to row 17, col 60  (≈12 motion reports, coalesced to ~3)
  │     focus=(16,59); repaint → 4 rows painted per flush
  │     meanwhile the agent emits 9 rows → offset 0→9, chip shows "↓ 9 new lines · PgDn"
  │
  ├─ user releases
  │     text = selectedText(mirror.plain, normalize(sel))   ← same mirror the highlight used
  │     copyText(text) → OSC 52 + native
  │     toast "Copied 4 lines (213 chars)."
  │     hold=false → resume timer armed (offset 9 > 0, newLines 9 > 0)
  │
  └─ 5 s of no scrolling, no drag
        setScroll({offset: 0}) → back to the newest line, chip disappears
```

### 4.6 Invariants

| I | Invariant | Failure mode if dropped |
| --- | --- | --- |
| I-1 | `?1002h` is enabled **only** together with `?1000h` + `?1006h`, and disabled in exact reverse order before leaving the alternate screen. | Reporting left on prints `[<0;12;5M` in the user's shell forever (the existing I-2 of `screen.ts`, now with one more mode to unwind). |
| I-2 | The differ diffs **painted** lines and caches **both** painted and raw. | Diffing raw against a painted screen leaves the highlight burned into rows that were never repainted. |
| I-3 | `writer.repaint()` writes to the **real** stream, never through the proxy. | Every drag frame becomes a foreign write → `invalidate()` → full repaint → the flicker `tui-input-flicker-fix` removed. |
| I-4 | The highlight and the copy both read `mirror.plain`, produced by the same `decorate` call. | The user copies something other than what is highlighted — silently. |
| I-5 | No file under `src/ui/**` gains a non-ASCII literal; every glyph comes from `pickGlyphs`. | `glyphs.test.ts`'s static scan fails the build (by design), or on a legacy console the chip renders mojibake. |
| I-6 | `hold` is re-read at resume-timer **fire** time, not only at arm time. | A drag that starts 4.9 s into the countdown gets the viewport yanked out from under it mid-selection. |
| I-7 | Anchoring reacts to the **tail** delta, signed, and never to total content height. | Reacting to total height counts front-drops and above-the-viewport height corrections as new output: it breaks `virtual-window.ts`'s V-4 self-compensation, arms the idle timer on a transcript that produced nothing, and closes an offset → mounted-set → measured-height → offset loop (P0-1). Restricting it to growth-only instead of signed leaves an upper-bound height estimate over-counted with no path back. |
| I-8 | The composer chip never shrinks; the draft column does. | A truncated chip (`↓ 12 new li`) reads as a rendering bug and the number it exists to show is the part that gets cut. |
| I-9 | Selection is cleared whenever `shiftUp` changes, and additionally on key, resize, overlay, `/clear` and `differ.invalidate()`. | A highlight that survives content movement is a lie about what would be copied. The `shiftUp` form is the one that matters: an enumerated list forgets the movements the feature itself adds — v1's list omitted the idle auto-resume and `pinToBottomNonce`, so a 5-second-old highlight would sit over rows that had scrolled out from under it (P1-4). |
| I-10 | `setMouseCapture` moves DEC 1007 in strict save/restore pairing with the capture state, and `restore()` unwinds the state that is *current*. | `/mouse off` without it turns the wheel back into arrow keys and prompt-history recall — the defect `mouse-wheel-region-routing` exists to fix. An unpaired save hands the user back someone else's alternate-scroll preference; a `restore()` that reads the startup value leaves the wrong modes set in the user's shell. |
| I-11 | `hold` is released by a `release` report, by `clear()`, **or** by the `HOLD_MAX_MS` watchdog — and button events are decoded only from SGR reports. | A press with no matching release (lost focus, a swallowed button-up, X10's release-as-press) freezes the viewport for the rest of the session, silently, with no key that recovers it (P1-3). |
| I-12 | Every column→character mapping in the feature goes through `sliceColumns`, and `stringWidth` is its only width oracle. | The painter and the extractor disagree on any row with CJK, emoji or a combining mark, and the user copies something other than what is highlighted — which is I-4's failure mode arriving through the back door (P1-5). |
| I-13 | `writeForeign` / `repaint` write to the real stream and are excluded from `fallbacks` and from the frame counters. | `fallbacks > 0` is documented to mean "something wrote to stdout behind Ink's back" and raises a user-visible notice; routing our own writes through the proxy makes the first copy of every session print a warning and makes `/perf` lie (P1-6, P2-6). |

---

## 5. File / module change plan

### 5.1 New files

| # | File | Intent |
| --- | --- | --- |
| 1 | `src/ui/selection/selection.ts` | Pure selection model: `normalize`, `isEmpty`, `rowSpan`, `selectedText`. |
| 2 | `src/ui/selection/highlight.ts` | Pure row painter: apply the selection colours to a column range of one ANSI line. |
| 3 | `src/ui/selection/screen-mirror.ts` | Holds the last frame's raw + ANSI-stripped rows; the single source of screen text. |
| 4 | `src/ui/selection/selection-controller.ts` | Non-React controller: mouse lifecycle, 16 ms drag coalescer, `decorate` hook, copy on release, subscriber list. |
| 5 | `src/ui/clipboard.ts` | `copyText` — OSC 52 with the platform binary as fallback; the single clipboard path. Takes a write *door*, not a stream (§4.4.5). |
| 5a | `src/ui/layout/follow-state.ts` | **Pure** follow rules: `reduceFollow` (Rule A) and `shouldArmResume` (Rule B's three conditions). React-free, so the state machine is testable without a sized terminal — the shape `scroll.ts` / `virtual-window.ts` / `frame-differ.ts` all already use, and the answer to P1-10. |
| 5b | `src/__tests__/follow-state.test.ts` | T-15..T-21, T-26, T-27 against the pure reducer. |
| 6 | `src/__tests__/selection-model.test.ts` | `normalize` / `rowSpan` / `selectedText`, incl. multi-row and CJK widths. |
| 7 | `src/__tests__/selection-highlight.test.ts` | Column slicing preserves surrounding SGR; inner resets do not punch holes. |
| 8 | `src/__tests__/selection-controller.test.ts` | Press→drag→release→copy; plain click clears; overlay/wheel/key invalidation. |
| 9 | `src/__tests__/scroll-follow.test.tsx` | Adapter-level smoke only: `ScrollViewport` forwards a `tailRows` delta into `reduceFollow` and applies the result. The behavioural cases live in #5b — `ink-testing-library`'s stdout stub reports no height, so a mounted viewport measures `content === viewport` and neither rule ever engages (P1-10; `render-at-width.ts:1-13` and `transcript-virtual.test.tsx:1-9` record the same limitation and the same workaround). |
| 10 | `src/__tests__/clipboard.test.ts` | OSC 52 payload shape, size ceiling, native fallback, `CopyVia` reporting. |
| 11 | `docs/plans/tui-selection-and-scroll-follow/manual-test.md` | Per-terminal manual matrix (§8.3). |

### 5.2 Modified files

| # | File | Intent |
| --- | --- | --- |
| 12 | `src/ui/layout/ScrollViewport.tsx` | Delete the hint row + `TERSE_HINT_COLS`; adapt `follow-state.ts` (feed it the `tailRows` delta, apply the result, own the resume timer); add the `hold` / `resumeMs` / `tailRowsRef` props and the `onViewportShiftChange` publication. |
| 12a | `src/ui/Transcript.tsx` | Publish rows appended at the tail through a ref sink written during render, exactly as `mountedSink` already is (`Transcript.tsx:452-457`). **This is P0-1's fix**: it is the only place that can tell "the agent produced output" apart from "an entry above changed height" or "the horizon dropped an entry off the front", because it is the only place that holds the per-entry height table. Moved here out of §5.3. |
| 13 | `src/ui/layout/budget.ts` | Comment only: the scope note must stop listing a hint row that no longer exists. |
| 14 | `src/ui/PromptInput.tsx` | Accept `scrolledLines`; render the right-aligned chip inside the bordered input row. |
| 15 | `src/ui/Composer.tsx` | Pass `scrolledLines` through; note in the header that the chip is state, not a fadeable hint. |
| 16 | `src/ui/App.tsx` | Pass `scrolledLines` to `Composer`; own `selectionActive` → `hold`; wire `resumeMs` from config; register the toast sink and the `redrawNonce` fallback; clear the selection on key/resize/overlay. |
| 17 | `src/ui/screen.ts` | `enableMouse(motion)` / `disableMouse(motion)`; `AltScreenOptions.motion`; correct the 1002-vs-1003 comment; add `setMouseCapture` to `ScreenHandle`, moving DEC 1007 in pairing with it and making `restore()` read the current state (I-10). |
| 18 | `src/ui/frame-differ.ts` | `decorate` + `onInvalidate` options, `repaint()`, dual raw/painted cache. `repaint` carries the sync envelope and stays out of the frame counters. |
| 19 | `src/ui/stdout-frame-writer.ts` | Expose `repaint()` and `writeForeign()`; document that both write to the real stream and neither counts as a fallback (I-3 / I-13). |
| 20 | `src/input/mouse-events.ts` | Emit press/drag/release from the SGR path only (X10 stays wheel-only, I-11); export the `MouseEvent` union. |
| 21 | `src/input/stdin-mouse-filter.ts` | Widen `MouseSource.subscribe` to `MouseEvent`. |
| 22 | `src/ui/use-wheel-routing.ts` | One-line kind guard at the top of `route()`. |
| 23 | `src/cli.tsx` | Build the `SelectionController`; pass `decorate` + `onInvalidate` into the differ; pass `motion: mouseFilter !== null && cfg.mouseSelect` to `enterAltScreen`; register `--mouse-select` / `--no-mouse-select` on the program (beside `--no-mouse`, `cli.tsx:1398`) **and** in `toFlags` (`cli.tsx:222` is the line whose absence made `--no-mouse` inert once already — `config.test.ts:676` is the regression pin); pass `setMouseCapture` and the controller into `<App>`; dispose on every exit path. |
| 24 | `src/config/schema.ts` | Add `mouseSelect: boolean` (default `true`) and `scrollResumeMs: number` (default `5000`) to `PersistedConfig` + `DEFAULT_CONFIG` + `ResolvedConfig`; `CliFlags` gains `mouseSelect?: boolean`. |
| 25 | `src/config/load.ts` | `resolveMouseSelect` / `resolveScrollResumeMs`, shaped exactly like `resolveMouse` (`load.ts:268`). |
| 26 | `src/config/env.ts` | `ARAGON_MOUSE_SELECT` **and** `ARAGON_SCROLL_RESUME_MS`, alongside the existing `ARAGON_MOUSE` (`env.ts:148`). §6.1 promised the second one and v1's plan omitted it, which is how a key ships documented-but-dead — the failure `load.ts:255-262` already records for `ARAGON_MOUSE`. |
| 27 | `src/commands/builtins.ts` | New `/mouse [on\|off]`; `/copy` refactored onto `ui/clipboard.ts`; `BUILTIN_COMMAND_NAMES` picks the new name up automatically. |
| 28 | `src/ui/overlays/HelpOverlay.tsx` | Rows for drag-select, `/mouse`, and the fact that releasing copies. |
| 29 | `src/ui/use-startup-notices.ts` | Notice text: stop teaching the Shift workaround, name drag-select and `/mouse`. |
| 30 | `src/ui/theme.ts` | `selectionBg` / `selectionFg` (fallback: reverse video). |
| 30a | `src/ui/palettes.ts` + `src/__tests__/palettes.test.ts` | The two new colours per palette, and the WCAG-AA contrast pin `palettes.ts:46` records `palettes.test.ts` as applying to every foreground it knows about. `Theme`'s colour fields are required, so theme.ts cannot be edited alone. |
| 31 | `src/config/ui-state.ts` | Add `mouseNoticeVersion: number` (default `0`); leave the old `mouseNoticeSeen` boolean in the file unread, and **do not touch `UI_STATE_SCHEMA`**. This is the shape `ui-state.ts:51-77` already prescribes, in a comment written about this exact situation: the audience for a corrected notice is precisely the set of users who already have the old boolean `true`, and bumping the schema makes `readFromDisk` discard the whole object — resetting every user's `submitCount` and un-fading the composer hint for all of them (P1-8). |
| 32 | `packages/cli/package.json` | Add `slice-ansi`, `strip-ansi`, `string-width` as direct dependencies (§9 R-6). |
| 33 | `packages/cli/CHANGELOG.md` | One entry per stage. |
| 34 | `src/__tests__/mouse-events.test.ts` (existing) | Extend for the press/drag/release decode table; the existing wheel cases stay byte-identical. |
| 35 | `src/__tests__/frame-differ.test.ts` (existing) | Extend for `decorate` + `repaint`; the existing cases stay byte-identical. |

### 5.3 Deliberately **not** changed

| File | Why |
| --- | --- |
| `src/ui/layout/scroll.ts` | The pure arithmetic is correct. Anchoring is a policy layer above it; changing `applyScroll` would give the wheel and the keyboard different notions of "pinned". |
| `src/ui/layout/scroll-indicator.ts`, `ScrollIndicator.tsx` | The thumb already derives from `offset`; anchoring makes it *more* accurate for free. |
| `src/ui/layout/budget.ts` arithmetic | The hint was never budgeted. Only its comment changes. |
| `src/ui/layout/virtual-window.ts` | Untouched, and deliberately: V-4 stays true because Rule A now reacts only to tail motion (§4.3.1a). Anything that makes the offset a function of total measured height belongs in this row instead, as a change to V-4 — with V-4's own argument rewritten, not silently invalidated. |
| `src/ui/entries/**` | Selection is frame-level. Not one entry component learns about it — which is exactly why it works on tool output, thinking, diffs and team cards without touching any of them. (`Transcript.tsx` itself does change, but only to publish a row count — no entry rendering moves.) |
| `@aragon-agent/core` | No engine surface is involved. |

---

## 6. Interface design

### 6.1 Configuration

| Key | Type | Default | Resolution order | Meaning |
| --- | --- | --- | --- | --- |
| `mouse` | boolean | `true` | flag › env › file › default (unchanged) | Capture the mouse at all. |
| `mouseSelect` | boolean | `true` | `--mouse-select` / `--no-mouse-select` › `ARAGON_MOUSE_SELECT` › file › default | Drag-select + copy. Ignored when `mouse` is false. Also decides whether `?1002h` is written at all (§4.4.1), so `false` is byte-identical to today (AC-8). |
| `scrollResumeMs` | number | `5000` | `ARAGON_SCROLL_RESUME_MS` › file › default | Idle delay before returning to the newest line. Clamped to `[0, 120000]`; `0` disables auto-resume entirely. |

`scrollResumeMs` gets **no CLI flag**. It is a comfort preference, set once
(`aragon config set scrollResumeMs 8000`) and then forgotten — the same argument
`schema.ts` already makes for `historyEnabled`. Adding a flag for every scalar is
how a CLI ends up with sixty of them.

### 6.2 Commands

| Command | Behaviour |
| --- | --- |
| `/mouse` | Report: capture on/off, drag-select on/off, and how to change each. |
| `/mouse off` | Release the mouse to the terminal for this session. |
| `/mouse on` | Recapture. |
| `/copy` | Unchanged surface; now routed through `ui/clipboard.ts`, so it works over SSH. |

### 6.3 Module APIs

```ts
// ui/selection/selection-controller.ts
export interface SelectionController {
  /** Feed to `createFrameDiffer({ decorate })`. Mirrors, then paints. */
  decorate(lines: string[]): string[];
  /** Subscribe to `hold` transitions; `App` mirrors this into React state. */
  onHoldChange(listener: (hold: boolean) => void): () => void;
  /** Called by `App` for key / resize / overlay / clear. Idempotent. */
  clear(): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}
export interface SelectionControllerOptions {
  source: MouseSource;
  repaint: () => void;                       // frame writer
  requestRedraw: () => void;                 // App's redrawNonce, for the invalidated case
  copy: (text: string) => CopyVia;
  onCopied: (via: CopyVia, lines: number, chars: number) => void;   // toast sink
  theme: () => Theme;
  caps: TermCapabilities;
  isSelectable: () => boolean;               // full-screen && mouseSelect && no overlay
  /** I-11. Default 30_000; `0` disables the watchdog (tests). */
  holdMaxMs?: number;
}
```

`onCopied` is a callback rather than a direct `dispatch`, and `App` registers it
on mount — the same shape as `setFrameStatsProvider` (`commands/perf.ts:79`),
which is this package's existing answer to "a non-React module needs to reach the
React tree".

---

## 7. Data model (in-memory only — no persistence, no schema migration)

```ts
// ui/selection/screen-mirror.ts
interface ScreenMirror {
  raw: string[];      // last frame, ANSI intact — what `decorate` paints over
  plain: string[];    // same rows, ANSI stripped — what `selectedText` reads
  set(lines: string[]): void;
}

// ui/selection/selection-controller.ts (module-private)
interface ControllerState {
  sel: Selection | null;       // null = nothing selected
  dragging: boolean;           // button down
  pendingFocus: Cell | null;   // 16 ms motion coalescer
  flushTimer: NodeJS.Timeout | null;
  holdWatchdog: NodeJS.Timeout | null;   // I-11
}

// ui/Transcript.tsx (written during render, like `mountedSink`)
interface TailSink { current: { rows: number; lastId: string | null } }

// ui/layout/ScrollViewport.tsx (component-private, in addition to today's two)
prevTail:     React.MutableRefObject<number>;             // last tail row count (§4.3.1a)
newLinesRef:  React.MutableRefObject<number>;             // resets to 0 whenever offset hits 0
resumeTimer:  React.MutableRefObject<NodeJS.Timeout | null>;
holdRef:      React.MutableRefObject<boolean>;            // read at timer FIRE time (I-6)
offsetRef:    React.MutableRefObject<number>;             // the RENDERED (clamped) offset,
                                                          // assigned during render (P1-9)
```

Nothing is written to `config.json` beyond the two new scalars in §6.1, nothing
is written to `state.json`, and no on-disk format changes. `CONFIG_VERSION` does
**not** need a bump: both keys are additive scalars with defaults, which is the
case `loadConfig`'s partial merge already handles.

---

## 8. Testing and acceptance criteria

### 8.1 Unit and component tests (vitest; `npm test -w packages/cli`)

| T | Test | Asserts |
| --- | --- | --- |
| T-1 | `mouse-events`: decode table for press / drag / release / wheel, `M` vs `m`, buttons 0-2, modifiers. | §4.4.2 order; every existing wheel case unchanged. |
| T-2 | `mouse-events`: a drag report split across two chunks reassembles via `pending`. | R-6 of the original parser still holds for the new kinds. |
| T-3 | `selection.normalize` for all four drag directions. | `start <= end` in reading order. |
| T-4 | `selection.selectedText` single-row, multi-row, and full-row middle. | Linear (not rectangular) semantics; `trimEnd` per row. |
| T-5 | `selection.selectedText` over CJK / emoji rows. | Column arithmetic uses display width, not code units. |
| T-6 | `highlight`: a row containing `\x1b[0m` mid-selection. | No hole in the highlight; text outside the range keeps its original SGR. |
| T-7 | `highlight`: short line inside a multi-row selection. | Right edge padded to `to`. |
| T-8 | `frame-differ`: `decorate` runs before the diff; `repaint()` emits only rows whose paint changed. | I-2; drag cost is O(changed rows). |
| T-9 | `frame-differ`: `repaint()` returns `''` after `invalidate()`. | No absolute-addressed write against an unknown screen. |
| T-10 | `selection-controller`: press → drag → release copies the dragged text once. | G1/G2. |
| T-11 | `selection-controller`: press → release with no motion copies nothing and clears. | Stray click does not clobber the clipboard. |
| T-12 | `selection-controller`: wheel / key / resize / overlay each clear an active selection. | I-9. |
| T-13 | `selection-controller`: `isSelectable() === false` makes press a no-op. | `mouseSelect: false` and overlay gating. |
| T-14 | `clipboard`: OSC 52 payload is `\x1b]52;c;<base64>\x07`; over the ceiling it is skipped and `native` is reported. | §4.4.5. |
| T-15 | `reduceFollow`: `tailDelta = +12` while `offset = 5` → `offset = 17`, `shiftUp` unchanged. | G4 / Rule A. |
| T-16 | `reduceFollow`: `tailDelta > 0` while `offset = 0`, `hold = false` → `offset` stays 0. | Auto-follow stays free. |
| T-17 | `shouldArmResume` + `ScrollViewport`: `offset > 0` + new lines + `resumeMs` elapsed → `offset = 0` (fake timers). | G5 / Rule B. |
| T-18 | `offset > 0`, **no** new lines, timer elapsed → `offset` unchanged. | G6 — the one that stops the fix becoming a new complaint. |
| T-19 | `hold = true` suppresses resume, including when it is set *during* the countdown. | I-6. |
| T-20 | `reduceFollow`: `hold = true` anchors even from `offset = 0`. | A selection started while pinned still freezes. |
| T-21 | A scroll intent resets the countdown. | "用户没动" means since the last gesture. |
| T-22 | `PromptInput`: `scrolledLines = 12` renders the chip inside the border; `0` renders nothing. | G7. |
| T-23 | `PromptInput`: the chip renders with `hints: false` and with `showHint: false`, and its cell width does not change between `9`, `99` and `999`. | The chip is state, not a fadeable hint (and P2-4). |
| T-24 | `budget.test.ts` (existing) is unchanged and passes. | The row budget did not move. |
| T-25 | `glyphs.test.ts` (existing) passes with the new files present. | I-5. |
| T-26 | `reduceFollow`: `tailDelta = 0` with a large *content* change → `offset` unchanged. | **P0-1.** The regression that says Rule A reacts to the tail and not to measured height. Written against the reducer, so it cannot be satisfied by accident. |
| T-27 | `reduceFollow`: a negative `tailDelta` walks the offset back, clamped at 0. | I-7's signed half; an upper-bound estimate corrected downward must not strand the offset. |
| T-28 | `mouse-events`: an X10 report yields wheel events only — never `press` / `drag` / `release`. | I-11. The stuck-`hold` freeze has no other guard at the parser. |
| T-29 | `selection-controller`: a `press` with no `release` releases `hold` after `holdMaxMs` (fake timers) and leaves the selection intact. | I-11. |
| T-30 | `selectedText` and the painted row agree, character for character, on a row mixing ASCII, CJK, an emoji and a combining mark. | I-12 / P1-5. Testing the two apart is what let the unit mismatch through. |
| T-31 | `frame-differ`: `onInvalidate` fires on a foreign write, on resize and on the geometry stand-down; `repaint()` after it returns `''`. | I-9 / P1-7. |
| T-32 | `frame-differ` / writer: `writeForeign` and `repaint` leave `fallbacks`, `framesTotal` and `framesDiffed` untouched. | I-13 / P1-6 / P2-6. |
| T-33 | `screen.test.ts`: `setMouseCapture(false)` then `(true)` emits mouse **and** 1007 sequences in exact reverse pairs, and `restore()` after a toggle unwinds the current state. | I-10. |
| T-34 | `screen.test.ts`: with `motion: false` the emitted bytes are byte-equal to the pre-change constants. | AC-8's unit-level twin. |

### 8.2 Acceptance criteria

| AC | Criterion | Gate |
| --- | --- | --- |
| AC-1 | `npm run typecheck -w packages/cli` clean (both tsconfigs). | CI |
| AC-2 | `npm test -w packages/cli` green, including every pre-existing suite. | CI |
| AC-3 | `grep -rn "PgDn for the latest" packages/cli/src/ui/layout` returns nothing. | The hint really left the viewport. |
| AC-4 | `grep -rn "new lines" packages/cli/src/ui/PromptInput.tsx` returns the chip. | It really arrived in the box. |
| AC-5 | `viewportRows(r)` returns the same value for every `r` in `[12, 200]` as before the change. | The budget is untouched. |
| AC-6 | No non-ASCII literal under `src/ui/**` outside `glyphs.ts` / `Logo.tsx`. | `glyphs.test.ts` |
| AC-7 | `enableMouse(m)` and `disableMouse(m)` are exact reverses for both values of `m`, and `screen.test.ts` asserts it. | I-1 |
| AC-8 | With `mouseSelect: false`, the byte stream written for a wheel-only session is **byte-identical** to today's — including the absence of `?1002h`. | Revertibility of S3 (P1-2). |
| AC-9 | With `scrollResumeMs: 0`, no timer is ever created. | Revertibility of S2's resume half. |
| AC-10 | `/mouse off` then `/mouse on` leaves the terminal in the same reporting state as at startup. | No leaked mode. |
| AC-11 | The `screen.ts` comment no longer claims `?1002` floods stdin. | No stale rationale (the `wheel-scrolls-transcript-only` RV-3 lesson). |
| AC-12 | `budget.ts`'s scope comment no longer lists the hint row. | Same. |
| AC-13 | `git status` shows no `dist/`, no `node_modules/`, and no unrelated file. | Repo hygiene. |
| AC-14 | `/mouse off` leaves the wheel inert (1007 saved and disabled), and `/mouse on` restores it; a session that never toggles writes exactly the 1007 sequences it writes today. | I-10 / P1-1. |
| AC-15 | A full session that copies twice reports `fallbacks === 0` in `/perf`, and `FRAME_FALLBACK_NOTICE` is never printed. | I-13 / P1-6. |
| AC-16 | `UI_STATE_SCHEMA` is unchanged by this feature, and a `state.json` written by 0.6.2 keeps its `submitCount` after the upgrade. | P1-8. |
| AC-17 | `grep -rn "measureElement" packages/cli/src/ui/layout/follow-state.ts` returns nothing — the follow rules never touch a measurement. | P0-1 / P1-10, stated as something a grep can check rather than a habit. |

### 8.3 Manual matrix (`manual-test.md`)

Run each row in: Windows Terminal (pwsh), VS Code integrated terminal, iTerm2,
GNOME Terminal, `cmd.exe` (ASCII fallback), and one `ssh` session.

1. Drag over three lines of tool output mid-run → highlight tracks the pointer,
   release copies, paste elsewhere matches exactly.
2. Same, over a `cli-highlight`ed code block → copied text has no escape codes.
3. Same, over CJK text → no half-character corruption.
4. Drag while the agent is streaming → the rows under the pointer do not move.
5. Scroll up mid-run, wait 10 s without touching anything → returns to the tail.
6. Scroll up on a *finished* transcript, wait 60 s → does not move. (G6)
7. Scroll up, keep scrolling every 2 s → never snaps back while you are moving.
8. `/mouse off` → terminal-native selection works and the wheel is **inert**
   (it must not recall prompt history — that is P1-1's regression); `/mouse on`
   restores both, and the transcript scrolls again.
9. `--no-mouse` session → chip, anchoring and resume still work via PgUp/PgDn.
10. `cmd.exe` → chip renders as `v12`, no mojibake, no crash.
11. Resize the window mid-selection → highlight clears, nothing is copied.
12. Ctrl+C twice during a drag → exits cleanly, shell prompt has no stray
    `[<0;…M` on subsequent clicks. (I-1)
13. Press and hold the left button, then click into another window and release
    there → within `HOLD_MAX_MS` the transcript resumes following. (I-11 — the
    freeze this catches is silent and permanent.)
14. Scroll up mid-run, then press Ctrl+T (or Ctrl+O on a card above the
    viewport) → the rows under the cursor do not move. (P0-1 / V-4.)
15. Scroll up and hold there through a long run until the scroll horizon starts
    dropping entries → no jump, and the chip's number keeps matching the rows
    PgDn actually traverses.
16. Select, wait for the 5 s auto-resume → the highlight is gone, not stranded
    over whatever scrolled into its place. (P1-4.)
17. `/copy` on a fresh session → no "frame fallback" warning appears, and
    `/perf` still reports `fallbacks 0`. (P1-6.)

---

## 9. Risks and mitigations

| R | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R-1 | `?1002h` motion reports flood stdin on a terminal that mis-implements it (reports motion with no button held). | Low | Input latency, CPU | The 16 ms coalescer bounds repaints regardless of report rate; the parser drops non-left-button drags before they reach the controller; `mouseSelect: false` and `/mouse off` are two independent kill switches. |
| R-2 | A terminal that ignores `?1006` falls back to X10 encoding, whose coordinates break past column 223. | Low | Wrong selection on wide terminals | `matchX10` already exists and already validates byte plausibility; a drag whose coordinates fail validation is dropped rather than acted on. |
| R-3 | `repaint()` racing a genuine Ink commit produces interleaved writes. | Medium | Torn frame | Both paths are synchronous on the same thread and both end parked on row `H+1` (`frame-differ.ts`'s own I-5 — not this document's, which is the glyph rule); the differ's cache is updated inside `emit` before either returns. |
| R-4 | The highlight is painted over rows that changed between press and release. | Medium | User copies something they did not intend | I-4: highlight and copy read the same mirror, so the highlight *is* the promise. Stage 2's `hold` makes the transcript rows static for the drag's duration. |
| R-5 | Auto-resume fires while the user is mid-thought and yanks the view. | Medium | Annoyance — the exact complaint being fixed, inverted | Three-condition arm (§4.3.1), re-check at fire time, reset on every gesture, `scrollResumeMs: 0` to disable, default 5 s chosen to be longer than a glance and shorter than a read. |
| R-6 | Three new direct dependencies (`slice-ansi`, `strip-ansi`, `string-width`). | Low | Supply chain / size | All three are already in the tree as `ink@5` dependencies, all MIT, all ESM, zero new transitive weight; declaring them directly is correctness (we import them), not addition. Alternative considered and rejected: hand-rolling a column slicer, which means hand-rolling a Unicode width table. |
| R-7 | OSC 52 is silently ignored (tmux without `set -g set-clipboard on`). | Medium | User thinks the copy failed | The native binary is attempted in the same call, and the toast names the mechanism rather than claiming success. `/mouse off` + terminal-native selection remains as the last resort. |
| R-8 | Anchoring loops: `setScroll` inside a layout effect that runs on every render, in a tree where the offset feeds `selectWindow`. | Low | Wasted frames, or oscillation | v1 argued "changing the offset cannot change the content height", which **is false in this package** — offset → mounted set → measured-vs-estimated heights → content height (P0-1). The loop is now broken by the input rather than by the argument: `tailRows` is computed from the height table and never reads the geometry context, so it cannot move in response to the offset it produces. The effect is additionally guarded by `tailDelta === 0`, which is the steady state. |
| R-9 | A resize while paused shifts the anchor by the re-wrap delta. | Medium | Reading position moves once | Accepted and documented: the resize *is* a content change, `clampScroll` keeps it in range, and the next gesture or the resume timer settles it. Chasing this needs content-anchored line identity (N1). |
| R-10 | `ScrollViewport` grows past a comfortable size for one component. | Medium | Maintainability | Resolved up front rather than left as a threshold (P1-10): both rules live in the pure `follow-state.ts` and `ScrollViewport` keeps only the adapter — measure, compute a delta, apply, arm a timer. The offset still has exactly one owner (its P1-7 rule); what moved out is the *policy*, the same split `scroll.ts` / `ScrollViewport` and `virtual-window.ts` / `Transcript` already use. |
| R-11 | The `tailRows` sink and `ScrollViewport` disagree about which entries exist for one frame — e.g. the horizon drops an entry in the same commit that the tail grows. | Medium | One row of drift, once | The sink re-anchors on the new last entry and contributes `0` for that frame (§4.3.1a), so the error is bounded by one frame's tail growth and self-corrects on the next. The alternative — trusting a delta computed across an entry set that changed identity — is unbounded and silent. |
| R-12 | `HOLD_MAX_MS` fires during a genuinely slow drag (a user holding still mid-selection for 30 s). | Low | The drag stops extending | The watchdog is reset by every motion report, so it only fires when the pointer has been *motionless* for the whole window while a button is nominally held — which is indistinguishable from a lost release, and the failure it prevents (a permanently frozen transcript, I-11) is unrecoverable while this one costs a re-drag. |
| R-13 | `sliceColumns` is a hand-rolled slicer where v1 used a library call. | Low | New code on a hot path | It is `slice-ansi`'s escape bookkeeping re-indexed on `stringWidth` — roughly thirty lines, exercised by T-30 on the input class that breaks the library's own indexing. R-6's "do not hand-roll a Unicode width table" still holds: the width table is still `string-width`'s. What is ours is only the column arithmetic, which has to be ours for I-12 to mean anything. |

---

## 10. Decisions

| D | Decision | Rejected alternative and why |
| --- | --- | --- |
| D-1 | In-app selection is the primary answer to #1. | "Teach Shift-drag better." The bypass key is not portable, it is not discoverable, it collides with our own Shift+wheel binding, and a notice that scrolls away is not an affordance. |
| D-2 | Keep `offset`-from-the-bottom and add a growth adjustment. | Re-basing the state on `shiftUp` inverts the documented invariant of `scroll.ts` and every one of its call sites and tests, for the same on-screen result. |
| D-3 | Auto-resume requires new content (G6). | Timing alone. A user reading a finished transcript would be yanked to the bottom every 5 s — a new bug wearing the fix's clothes. |
| D-4 | Resume jumps, it does not animate. | Smooth catch-up at 30 fps in a diffed terminal frame is visible stepping, and it fights the render governor. |
| D-5 | Copy on release, no modifier. | Ctrl+C is the abort/exit key and cannot be overloaded; a modifier would be as undiscoverable as the Shift-bypass we are replacing. iTerm2's default ("copy on selection") is the same choice. |
| D-6 | The highlight is painted in the frame pipeline, not in React. | A React re-render per drag event goes through the governor and the whole tree; the pipeline repaints 1-3 rows with no commit at all. |
| D-7 | Selection lives in screen coordinates. | Content coordinates need a stable per-row identity the renderer does not have. Stage 2's `hold` makes screen coordinates sound for the duration of a drag, which is the only window in which they must be sound. |
| D-8 | The chip is inside the border, not on the hint row below it. | The requirement says 输入框内部, and the hint row is the wrong home regardless: it is dropped on short terminals and faded by `submitCount`, while the chip is live state. |
| D-9 | `/mouse` toggles at run time. | Config + restart. The user who wants their terminal's selection wants it *now*, for one paste. |
| D-10 | `?1002` (button-event) rather than `?1003` (any-event). | `?1003` reports every pointer move over the window, forever, for no additional capability here. |
| D-11 | No `CONFIG_VERSION` bump. | Both new keys are additive scalars with defaults; the partial merge in `loadConfig` already covers a file that lacks them. |
| D-12 | The scroll hint keeps showing `offset`, not "new lines since you paused". | `offset` is what `PgDn` traverses and what the status bar's `↑N` shows. Two numbers with one name is how a UI stops being trustworthy. |
| D-13 | Anchoring reacts to a **tail row count published by the transcript**, not to `measureElement`. | "Just use the measured content height" is what v1 did, and it silently converts `virtual-window.ts`'s V-4 from true to false — every above-the-viewport height correction becomes a jump, front-drops read as new output, and the offset closes a loop through `selectWindow`. The alternative that *would* be more general — full entry-anchored scroll anchoring (record the entry at the top and re-derive the offset from it every frame) — is strictly more code for the same on-screen result in every case the tail counter already covers, and its extra generality only buys P2-5. |
| D-14 | The selection clears on `shiftUp` change, not on an enumerated list of gestures. | The list was already incomplete on the day it was written (it missed this feature's own auto-resume). A derived condition cannot be forgotten by the next person who adds a way to move the viewport. |
| D-15 | `?1002h` is gated on `mouseSelect` rather than always on. | Always-on costs nothing at run time but makes AC-8 unprovable, and an acceptance criterion that cannot be met is one that gets edited. Gating makes "S3 is revertible" a byte-level fact. |
| D-16 | X10 reports stay wheel-only. | Decoding buttons from a 6-byte legacy report that cannot express a release trades a rare, degraded selection for a permanently frozen viewport on the same terminals (I-11). We never request X10; it exists in the parser only so a stray report cannot reach the draft. |

---

## 11. Questions closed

* **Q-1 — Should typing reset the idle-resume countdown?** No. The countdown
  tracks *reading position* gestures (wheel, PgUp/PgDn, Shift+arrows). A user
  typing a message while parked mid-transcript is composing, not reading, and
  snapping to the newest output is what they will want when they submit
  (`App.tsx:1182` already forces it there). Closed as D-3's sibling.
* **Q-2 — Should the selection survive a scroll?** No (I-9). A screen-anchored
  highlight over moved content is a false promise about what will be copied.
* **Q-3 — Double/triple click?** Deferred (N2). The event stream after S3a
  already carries everything needed; it is additive and needs its own timing
  rules, which is a second round's worth of decisions.
* **Q-4 — Should `/copy` gain a "copy the last N entries" form?** Out of scope.
  Named here only so the next reader does not assume it was overlooked.

---

## 12. Rollout and revert

| Stage | Ship gate | Revert |
| --- | --- | --- |
| S1 | T-22..T-25 + AC-3/AC-4/AC-5 | Single commit; restore the deleted block in `ScrollViewport`. |
| S2 | T-15..T-21, T-26, T-27 + AC-9/AC-17 + manual rows 5-7, 14, 15 | `scrollResumeMs: 0` disables the resume half immediately; the anchoring half reverts with one commit. Rows 14-15 are not optional: they are the only manual evidence that P0-1 stayed fixed, and the failure they catch is a silent jump rather than an error. |
| S3a | T-1..T-14, T-28, T-30..T-32, T-34 + AC-7/AC-8/AC-15 + manual rows 1-4, 11-13, 16-17 | `mouseSelect: false` disables it at run time for everyone, and with it `?1002h` disappears from the wire (AC-8); `--no-mouse` remains the total kill switch. |
| S3b | T-33 + AC-10/AC-14/AC-16 + manual row 8 | Command removal only; no behaviour depends on it. Note that `setMouseCapture`'s 1007 pairing (I-10) ships **with** the command — reverting the command must revert the pairing, not leave a half-toggled mode behind. |

Each stage is one commit with a `CHANGELOG.md` entry, per the repository's
`git add <path>` discipline — no `git add -A`, no `dist/`, no lockfile churn
beyond the three dependencies of R-6.

---

## 13. 评审结论（Review Verdict）

**有条件通过 — approved with conditions.**

The design is sound in its shape and unusually well grounded: the three
root-cause readings in §3 all hold against the source, the staging is genuinely
load-bearing rather than administrative (S2 is what makes S3's screen-anchored
selection honest), and the hard calls — offset-from-the-bottom, `?1002` over
`?1003`, copy-on-release, resume-only-if-something-arrived, no
`CONFIG_VERSION` bump — are the right ones and are argued from this codebase
rather than from general principle. Nothing in §1–§12 needed to be thrown away.

What it missed was one subsystem and a set of edges. The subsystem is viewport
virtualisation: `tui-render-performance` made the offset an *input* to what gets
mounted and measured, and v1's Rule A read the output of that as if it were "new
output". That is P0-1, and it is fixed above by anchoring on a tail row count the
transcript already has the data to publish. The edges are the places where a
mechanism fails without saying so — a press that never gets its release, a
`/mouse off` that hands back the wheel-as-arrow-keys bug, a highlight left
stranded by the feature's own auto-resume, two column-slicing units that agree on
ASCII and diverge on CJK, and an OSC 52 write that makes the CLI accuse itself of
a foreign write in front of the user.

All P0 and P1 items are resolved in the body of this document. The conditions
below are on the *implementation*, not on the design:

1. **T-26 lands with Rule A, not after it.** It is the only automated statement
   that anchoring reads tail motion rather than measured height. Without it, the
   next person to "simplify" `tailRowsRef` back into `metrics.content` gets a
   green suite — and `virtual-window.ts`'s V-4 fails silently, which is the exact
   failure mode that file's header warns about in capital letters.
2. **`virtual-window.ts`'s V-4 comment gains a sentence** pointing at §4.3.1a.
   V-4 currently reads "no scroll-anchoring compensation pass is required"; after
   S2 there *is* one, deliberately restricted to the tail. Leaving V-4 as-is
   makes it a true statement about a system that no longer matches it, which this
   repo has already paid for twice (`wheel-scrolls-transcript-only` RV-3, and the
   `?1002` comment this feature has to correct).
3. **Manual rows 13 and 14 are run on a real terminal before S2 and S3a ship.**
   Both catch permanent, silent freezes; neither is reachable from a unit test.
4. **`screen.ts`'s 1002-vs-1003 comment and `budget.ts`'s scope comment are
   corrected in the same commits that invalidate them** (AC-11, AC-12 — already
   in the document; restated here because they are the two easiest things to
   defer and the whole cost of deferring them is paid by the next reader).
5. **If the tail sink turns out to need more from `Transcript.tsx` than a ref
   written during render, stop and re-review.** The moment it needs a `setState`,
   or the geometry context, the loop P0-1 closed is open again — and the correct
   response is D-13's rejected alternative (full entry anchoring), not a larger
   sink.

No P0 or P1 concern remains unresolved in this document. Implementation may
start with S1, which is independent of every finding above.
