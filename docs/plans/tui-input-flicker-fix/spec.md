# TUI composer flicker — design specification

- **Feature slug**: `tui-input-flicker-fix`
- **Version**: **v2** (reviewed; P0/P1 resolved in the body — see §0)
- **Date**: 2026-07-31 (v1) · 2026-07-31 (v2, design review)
- **Scope**: `packages/cli` only. No change to `packages/core`, no change to the
  host application, no protocol, no persisted state beyond two config booleans.
- **Requirement being served**: 在 TUI 执行任务的过程中，用户在底部输入区打字时，
  输入区会跟随输入不断闪烁；需要彻底消除该闪烁。

---

## 0. 评审记录（Review Notes）

Reviewed 2026-07-31 against the checked-in tree and the **resolved** `node_modules`
of this repository (`ink@5.2.1`, `ansi-escapes`, `cli-cursor`), not against
upstream docs.

**Verification result on §2.** Every source anchor the root-cause analysis cites
was opened and confirmed: `log-update.js:17`, `ansi-escapes/base.js` `eraseLines`
/ `cursorLeft = CSI G`, `ink.js:39-42` (32 ms throttle, leading+trailing),
`ink.js:59-61` (`createContainer(…, 0, …)` — LegacyRoot), `ink.js:121`
(`outputHeight >= rows` ⇒ `clearTerminal` path), `ink.js:132-134`,
`output.js:38-52,135-145` (fixed `height` rows, per-line `trimEnd`, `height:
output.length`), `frame.ts:40-43`, `screen.ts:90-93`, `cli.tsx:501` / `:504` /
`:697-701` / `:885`, `App.tsx:479` / `:770` / `:817-819` / `:1347-1355`,
`PromptInput.tsx:265-275` / `:346`, `ActivityLine.tsx:77`,
`Transcript.tsx:398-410`, `useTerminalSize.ts:57-62`, `render-governor.ts:23`,
`env.ts:143-150`. R1–R4 stand as written; I-1/I-2/I-3 hold. The diagnosis is
correct and the chosen insertion point is the right one.

Three facts found during review that **strengthen** the design and are now
recorded in the body so nobody re-derives them:

- `cliCursor.hide()` / `.show()` default to **`process.stderr`**
  (`cli-cursor/index.js`), so Ink's cursor management is *not* a foreign stdout
  write and cannot desync absolute addressing.
- `render()` at `cli.tsx:485` currently passes **no** `stdout`, so supplying one
  is a pure addition, and `render.js`'s `getOptions` returns a non-`Stream`
  options object untouched. Ink keys its instance `WeakMap` on the stdout object;
  a `Proxy` is a valid key.
- `ink-testing-library@^4.0.0` and `vitest@^4.1.0` are already devDependencies of
  `packages/cli`, so §4.3's test plan is buildable exactly as written.

### Findings

| # | Sev | Area | Concern | Resolution in v2 |
|---|---|---|---|---|
| **P0-1** | P0 | §3.2.3 step 8, §7.1 AC-2 | **The emitted changed line still blanks-then-paints.** `cursorTo + SGR_RESET + CSI 2K + text` narrows R1's erase window from H rows to one row — but that one row is the composer, the row the user is looking at while typing, and the design's own §3.3/§7.3 nominate legacy `conhost.exe` (no DEC 2026) as the terminal F1 must carry **alone**. Reducing the tearing window is not the stated goal; AC-1 says "no visible flicker". | Emit **paint-then-clear-tail**: `cursorTo(row) + SGR_RESET + text + SGR_RESET + CSI K`. New text overwrites old text in place; `CSI K` removes only the residue of a longer previous line. No cell is ever blank-then-filled. §3.2.2, §3.2.3, §3.2.5 I-4, §7.1 AC-2 updated. |
| **P0-2** | P0 | §3.2.3 step 7 | **Nothing invalidates on resize.** Ink's `resized` handler (`ink.js:83-86`) renders **synchronously** on SIGWINCH, but the frame's *height* comes from `useTerminalSize`, which debounces `RESIZE_THROTTLE_MS = 50` (`useTerminalSize.ts:20,50`). For ~50 ms after every step of a window drag, Ink re-renders at the **new width and the old height** — the line count is unchanged, so the step-7 guard does not fire and the differ emits a partial diff into a screen the emulator has just re-flowed. Rows it believes unchanged stay stale for the rest of the drag. Today this self-corrects because every repaint is a full frame. AC-7 would fail intermittently. | The writer subscribes `'resize'` on the **real** stream and calls `differ.invalidate()`. Three lines; same signal Ink already subscribes to; turns the whole window into "one full repaint per resize event". §3.2.5 I-8, §4.1, §4.3, §7.1 AC-13. |
| **P1-1** | P1 | §3.2.3 step 3 | **First-frame seeding rests on a heuristic**, `looksLikeFrame(chunk) = endsWith('\n') && !includes(CSI ?)`, and on `splitFrame`, which §3.2.2 never defines. A wrong guess seeds `prev` from a non-frame and every later diff is computed against fiction; the only backstop is step 7's line-count test, which passes silently whenever the counts happen to agree. The seeding buys exactly **one** avoided full repaint per session. | Delete both helpers. On `prev === null` with no erase prefix: pass through, leave `prev === null`. The next chunk carries an erase prefix, hits step 7, and does one full repaint. Strictly safer, strictly simpler, one 6 KB write per session. |
| **P1-2** | P1 | §4.2, §5.4 | **`/perf` wiring contradicts the module's own documented convention.** v1 threads the counters in as a new optional `App` prop and extends `PerfSnapshot` assembly. `commands/perf.ts`'s header states the opposite rule verbatim: "The snapshot crosses the React boundary through a module-level single slot, the shape `ui/exit-snapshot.ts` already uses". The writer is built in `runInteractive`, entirely outside React, and its counters never render — the prop buys nothing and costs a change to a 1944-line component plus `app.test.tsx`. | `setFrameStatsProvider(fn \| null)` in `commands/perf.ts`, beside `setPerfSnapshotProvider`. `cli.tsx` registers it after building the writer and clears it on the exit path. **`App.tsx` is untouched by this package.** |
| **P1-3** | P1 | §3.2 (whole) | **Degenerate geometry is unspecified.** `frameHeight` clamps to **0** for `rows ≤ 1`, and `frame.ts:30-38` states that range **is reachable** — a resize below `MIN_FULLSCREEN_ROWS` keeps the alt screen and renders a placeholder sized by the same function. At H = 0 the frame body is `'\n'`, so `lines = ['']` and step 11 addresses row 2 on a 1-row terminal. Terminals clamp CUP rather than corrupt, but the behaviour is undefined and lands exactly in the regime `frame.ts` exists to warn about. | Explicit bail-out: if `rows` is unknown, or `lines.length + 1 > rows`, or `rows < MIN_FULLSCREEN_ROWS`, `invalidate()` and pass through — hand the tiny-terminal placeholder back to Ink unmodified. §3.2.5 I-9, §7.1 AC-14. |
| **P1-4** | P1 | §3.2.3 step 1 vs §5.5 | **Contradictory `transform` contract.** §5.5 types the parameter `string`; step 1 handles `typeof chunk !== 'string'`. Both cannot be the contract. Separately, `write(chunk, encoding, cb)` can deliver a string with a non-UTF-8 encoding (`'latin1'`, `'hex'`), in which case the bytes on the wire are not the string that was diffed. | `transform(chunk: string)` stays typed; the untyped boundary moves to the writer, which is where untyped input actually arrives. The writer treats a `Uint8Array` chunk **and** any present `encoding` other than `'utf8'`/`'utf-8'` as foreign: `invalidate()`, pass through. §3.2.3, §5.5. |
| **P1-5** | P1 | §12 Q3 | **The feature's characteristic failure is silent, and v1 defers the decision on surfacing it.** `fallbacks > 0` means absolute addressing lost its origin; the user sees a subtly wrong screen and has no path to `--no-diff-render`. Deferring an observability decision on the one failure mode that presents as "my terminal looks broken" is not a deferral a reviewer can grant. | Answered: **yes**. One-shot notice on the first fallback of a session, naming `--no-diff-render`. Rate-limited to once per session (a notice per fallback would itself be a repaint storm). §5.6, §7.1 AC-15. All three open questions are answered in §12. |
| **P2-1** | P2 | §5.4 | Sample `/perf` line uses `·` separators; `formatPerfReport` is ASCII-only (`  -  `) by convention, for the same non-Unicode terminals `glyphs.ts` tiers for. | Rewritten in the existing ASCII shape. |
| **P2-2** | P2 | §4.1 vs §5.5 | `stats()` is described as living on the writer (§4.1) and on the differ (§5.5); `FrameWriterStats.framesFull` exists in the interface but is missing from §4.2's counter list. | `stats()` is owned by the differ and re-exported by the writer; counter list unified. |
| **P2-3** | P2 | §3.2.2 | `ERASE_PREFIX_RE` is a nested quantifier. Not catastrophic in practice (the inner optional is unambiguous with the outer loop), but the differ already knows the expected erase count from `prev.length + 1`, so it can compare against an exact constructed prefix instead of scanning. | Documented as the preferred implementation, regex retained as the `prev === null` fallback. |
| **P2-4** | P2 | §3.2.3 step 10 | `out.length === 0` is **unreachable**: log-update returns early on an identical frame (`log-update.js:13-15`), so a chunk that reaches the differ always differs by at least one line. Writing a test that treats it as a live path documents a fiction. | Kept as a defensive guard, labelled as such; the test asserts the guard, not a reachable behaviour. |
| **P2-5** | P2 | §3.3 | No statement about a process dying between BSU and ESU. | The envelope is built as one string and handed to a **single** `write`, and terminals implement a BSU safety timeout; recorded so nobody splits the envelope across two writes later. |
| **P2-6** | P2 | §7.3 | 13 scenarios × 4 terminals = 52 runs with no gating subset named. | Merge-gating subset marked. |

**Right-sizing.** Scope is proportionate. F1 is ~150 lines of pure logic plus a
~40-line `Proxy`; F2 is two constants; F3 is a mechanical refactor behind an
existing, untouched test (`input.test.ts`). The three rejected alternatives in
§10 are rejected for the right reasons. One scope note carried into §11: **F3 is
independently shippable and must land as its own change** — it is the only part
that can regress input semantics (K-7, Medium), and F1+F2 already close the
reported bug at step 4.

**Consistency.** No conflict with `CLAUDE.md` or `.claude-index/config.md`: env
vars use the `ARAGON_*` prefix mandated by `aragon-agent-core-rename`; config
plumbing follows the `mouse` precedent including the settable-key **and**
`switch` double-registration trap `cli.tsx:697-701` documents; new files are well
under the 1000-line ceiling and every new function under 60 lines; public
interfaces are `interface`, not `type` (the `EditorAction` union is necessarily a
`type`). After P1-2, `App.tsx` is no longer touched at all.

---

## 1. Overview（概述）

The Aragon CLI runs its interactive UI as an Ink (React) application inside the
alternate screen buffer. `AppShell` pins the root box to `frameHeight(rows) =
rows - 1` and puts the composer in the `flexShrink={0}` bottom chrome, so the
input row is physically the last thing on the screen
(`packages/cli/src/ui/layout/AppShell.tsx:98-129`). That layout is correct and
is not what this document changes.

What this document changes is **how a frame reaches the terminal**. Ink 5.2.1
has exactly one repaint strategy: on every commit it serialises the *whole*
frame and hands it to `log-update`, which writes
`eraseLines(previousLineCount) + frame` in a single `stdout.write`
(`node_modules/ink/build/log-update.js:17`). `ansiEscapes.eraseLines` walks
**bottom-up** — erase the current line, cursor up, erase, cursor up, … — so the
first thing erased on every single repaint is the row the cursor is parked on,
i.e. the row directly under the composer, and the composer itself is erased one
step later (`node_modules/ansi-escapes/base.js:77-89`). The composer is then
the *last* region rewritten, because the frame is written top-down. The input
area therefore spends the longest fraction of every repaint cycle blank. While a
run is in flight the frame repaints 15–30 times per second — the `dots` spinner
alone ticks at 80 ms, the elapsed clock at 200 ms
(`packages/cli/src/ui/App.tsx:770`, `packages/cli/src/ui/ActivityLine.tsx:77`) —
and every one of those repaints erases and redraws a composer whose text did not
change. That is the flicker the user is reporting, and it is worst exactly where
they report it: while typing during a running task, because keystrokes add their
own repaints on top of the animation ones.

The fix is to stop repainting what did not change. This package introduces a
**frame differ** that sits between Ink and `process.stdout` in full-screen mode:
it recognises the `eraseLines + frame` write Ink produces, diffs the new frame
against the previous one line by line, and emits only the lines that actually
changed, each addressed absolutely (`CSI <row>;1H`). A keystroke that only
changes the composer's text becomes a one-line write; a spinner tick becomes a
one-line write; the composer's rows are not touched at all unless the composer
changed. And when a row *is* rewritten it is **overwritten in place and then
tail-cleared** (`CSI K`), never blanked first — so no cell on the screen is ever
presentably empty, which is the difference between making R1's window 39× rarer
and closing it (§3.2.3, P0-1). On top of that, every batch is wrapped in **DEC
private mode 2026 (synchronized output)** so terminals that support it composite
the batch atomically and cannot present a half-written frame. Finally, `PromptInput`'s per-key state fan-out
(five `setState` calls per printable character, unbatched because Ink mounts a
*legacy* React root — `node_modules/ink/build/ink.js:59-61`) is collapsed into a
single reducer dispatch, so one keystroke costs one commit instead of up to
five.

Three properties are non-negotiable and shape every decision below. **(1) The
change is additive and reversible**: `--no-diff-render` restores today's byte
stream exactly, so a regression on an exotic terminal is one flag away from
being neutralised. **(2) It is full-screen only**: inline mode prints settled
entries through Ink's `<Static>`, has no fixed frame and no stable origin, and
is left byte-identical. **(3) It is self-healing**: any write the differ does not
recognise invalidates the cache and passes through untouched, which degrades to
today's behaviour rather than to a corrupted screen — and the two events that can
invalidate the *geometry* rather than the content, a resize and a viewport too
small to address, invalidate explicitly rather than being inferred (I-8, I-9).

---

## 2. Root-cause analysis（根因分析，逐条对源码校验）

Every claim below was verified against the checked-in sources and the resolved
`node_modules` of this repository, not against upstream documentation.

### R1 · Every repaint erases the whole frame, bottom-up, composer first

`log-update.js:17`:

```js
stream.write(ansiEscapes.eraseLines(previousLineCount) + output);
previousLineCount = output.split('\n').length;
```

`ansi-escapes/base.js:77-89`:

```js
export const eraseLines = count => {
  let clear = '';
  for (let i = 0; i < count; i++) {
    clear += eraseLine + (i < count - 1 ? cursorUp() : '');
  }
  if (count) clear += cursorLeft;
  return clear;
};
```

`eraseLine` is `CSI 2K` (erase the whole line), `cursorUp()` is `CSI 1A`. The
sequence therefore erases the row the cursor sits on, walks up one row at a time
erasing as it goes, and lands the cursor at column 1 of the top frame row. The
cursor sits **below the composer** (log-update appends a trailing `\n`), so the
erase order is: blank row → status bar → composer → hint row → … → header. The
write order is the exact opposite. For a 40-row terminal the composer is dark
for roughly 90 % of the repaint's duty cycle.

This is a *tearing* window, not a logical bug: the erase and the redraw are one
`write()` call. But one `write()` is not one *presentation*. A large frame
(4–12 KB with SGR) crosses the ConPTY/console boundary in chunks on Windows and
crosses a PTY in 64 KB-max but scheduler-interleaved chunks on POSIX, and the
terminal's renderer paints on its own vsync (~60 Hz) regardless of where the
byte stream happens to be. At 30 repaints/s the probability that at least one
presentation lands inside an erase window approaches certainty, and the eye
integrates it as flicker localised to the bottom of the screen.

### R2 · While a run is in flight the frame repaints 15–30×/s with an unchanged composer

Three independent clocks drive repaints during a run, none of which touches the
composer:

| Source | Rate | Evidence |
|---|---|---|
| `ink-spinner` `dots` in `ActivityLine` | 12.5 Hz (80 ms) | `ui/ActivityLine.tsx:77`, `cli-spinners` `dots.interval = 80` |
| Elapsed clock / tokens-per-sec | 5 Hz (200 ms) | `ui/App.tsx:770` |
| Streaming delta coalescer | up to 30 Hz (governor rung 0 = 33 ms) | `ui/App.tsx:479`, `ui/render-governor.ts:23` |

Ink throttles `onRender` to 32 ms with `leading: true, trailing: true`
(`ink.js:39-42`), so the ceiling is ~30 full-frame erase/redraw cycles per
second. The composer's bytes are identical across all of them. Every one of
those cycles nonetheless erases it.

### R3 · One keystroke produces up to five React commits

Ink creates its container with tag `0` — `LegacyRoot`
(`ink.js:59-61`). In a legacy root, `setState` called outside a React event
handler is **not** batched: each call schedules and immediately flushes a
synchronous render. `useInput`'s callback runs from a `stdin` `'data'` listener,
which is outside React entirely. `PromptInput.insert`
(`ui/PromptInput.tsx:271-275`) does:

```ts
setBuffer(...); setCursor(...); resetDraftFlags(); // = setHistoryIndex + setDismissed + setSel
```

That is five state updates ⇒ five commits ⇒ five `resetAfterCommit` calls, each
running `onComputeLayout()` (a full Yoga layout of the whole tree) and
`onRender()` (`node_modules/ink/build/reconciler.js:69-83`). `onRender` is
throttled to 32 ms, so of those five commits one writes immediately and one
writes on the trailing edge — i.e. **two full-frame erase/redraw cycles per
character**, on top of R2's animation cycles, plus five whole-tree Yoga passes
of pure waste. The visible consequence is that the flicker gets *worse* the
faster the user types, which matches the report ("随着用户的输入进行").

### R4 · Nothing tells the terminal the frame is a single unit

The CLI never emits DEC private mode 2026 (Begin/End Synchronized Update).
`ui/screen.ts` manages `?1049` (alt screen), `?1000`/`?1006` (mouse) and `?1007`
(alternate scroll) and nothing else. Without BSU/ESU the terminal is free — and
on Windows Terminal, WezTerm, kitty and xterm.js it does — to present whatever
state the screen buffer is in when its frame timer fires, including the
mid-erase state R1 creates.

### R5 · Contributing but not causal (recorded so nobody "fixes" the wrong thing)

- **`ScrollViewport`'s measure pass** (`ui/layout/ScrollViewport.tsx:90-94`)
  runs a `useLayoutEffect` on every commit but short-circuits `setMetrics` when
  nothing moved, so in steady-state typing it adds zero commits.
- **`frameHeight(rows) = rows - 1`** (`ui/layout/frame.ts:40-43`) already keeps
  the app off `ink.js:121`'s `clearTerminal + fullStaticOutput + output` path,
  which would be a strictly worse full-screen clear on every frame. **Do not
  "simplify" that clamp while implementing this package.**
- **The render governor** (L4 of `tui-render-performance`) lowers the repaint
  *rate* under load. It cannot help here: it makes flicker rarer, not absent,
  and paying latency to reduce a visual defect is the wrong trade.

### Summary table

| # | Root cause | Fixed by |
|---|---|---|
| R1 | Whole-frame bottom-up erase on every repaint; composer erased first, redrawn last | **F1** frame differ |
| R2 | 15–30 repaints/s during a run with an unchanged composer | **F1** (unchanged lines are never written) |
| R3 | Up to 5 unbatched commits + 2 frame writes per keystroke | **F3** single-dispatch editor reducer |
| R4 | No atomic-presentation hint to the terminal | **F2** DEC 2026 envelope |

---

## 3. Technical design（技术方案）

### 3.1 Where the fix goes, and why there

Ink offers no hook for "how to write a frame": `Ink#log` is constructed
internally (`ink.js:44`) and `log-update` is a private module. The three
candidate insertion points are:

1. **Patch `node_modules/ink` via `patch-package`.** Rejected: the CLI ships to
   npm, the patch would have to be re-verified on every Ink bump, and the logic
   is identical either way.
2. **Fork Ink.** Rejected as wildly disproportionate.
3. **Interpose on the `stdout` object Ink writes to.** Chosen. `render()`
   accepts `stdout` in its options (`node_modules/ink/build/render.js`), the CLI
   already passes a custom `stdin` for the mouse filter
   (`packages/cli/src/cli.tsx:504`), and the interposer is a pure string→string
   function plus a thin `Proxy`, both trivially unit-testable without a TTY.

The interposer is installed **only** when `mode === 'fullscreen'`. Three facts
make the full-screen frame stream parseable and its geometry knowable, and each
one is an invariant this design depends on:

- **I-1 — In full-screen there is no `<Static>` output.** The full-screen
  viewport renders `TranscriptList`, which is documented as "the same entry
  renderers with NO `<Static>`" (`ui/Transcript.tsx:399-408`). Therefore
  `hasStaticOutput` is always false and `ink.js:132-134`'s `throttledLog(output)`
  is the *only* write path.
- **I-2 — The frame is exactly `frameHeight(rows)` lines.** Ink's
  `Output.get()` pre-initialises `height` rows and returns `height:
  output.length` (`node_modules/ink/build/output.js:38-52,134-143`), and the
  root box's height is `frameHeight(rows)`. Trailing spaces are trimmed per
  line; the *number of lines* is constant between resizes.
- **I-3 — The frame's origin is absolute row 1.** `enterAltScreen` writes
  `?1049h` + `2J` + `CSI H` (`ui/screen.ts:90-93`), and the frame is `rows - 1`
  tall with a trailing `\n` that parks the cursor on row `rows` — the last row —
  so the alternate screen **never scrolls**. Row *k* of the frame is absolute
  row *k*, for the whole session.

### 3.2 F1 — The frame differ（核心修复）

Two new modules. `frame-differ.ts` is pure (no I/O, no Node globals beyond
`RegExp`) and holds all the logic; `stdout-frame-writer.ts` is the `Proxy` that
binds it to a real stream.

#### 3.2.1 The write shape it recognises

```
<eraseLines(H+1)><line_1>\n<line_2>\n…<line_H>\n
```

where `H = frameHeight(rows)`, and `eraseLines(n)` expands to
`(CSI 2K [CSI 1A])×n CSI G`. The very first write of a session has
`previousLineCount === 0`, so `eraseLines(0)` is the empty string and the write
carries no prefix at all. v1 tried to recognise that write and seed the cache
from it; v2 does not (P1-1) — a prefix-less chunk is simply passed through with
the cache left empty, and the *next* chunk, which always has a prefix, becomes a
full repaint. The parser therefore never has to guess whether an unprefixed write
is a frame.

#### 3.2.2 Constants (exact, no derivations at call sites)

```ts
const ESC          = '[';
const ERASE_LINE   = `${ESC}2K`;  // CSI 2K — erase the whole line. Ink uses this; we do not.
const ERASE_TO_EOL = `${ESC}K`;   // CSI K  — erase cursor→end of line. This is what we emit.
const CURSOR_UP_1  = `${ESC}1A`;
const CURSOR_LEFT  = `${ESC}G`;
const SGR_RESET    = `${ESC}0m`;
const SYNC_BEGIN   = `${ESC}?2026h`;
const SYNC_END     = `${ESC}?2026l`;
/**
 * `eraseLines(n)` for any n ≥ 1, anchored at the start of the chunk.
 *
 * FALLBACK ONLY (P2-3). Whenever `prev !== null` the differ already knows the
 * exact prefix it expects — `eraseLines(prev.length + 1)` is a deterministic
 * string — so the hot path is `chunk.startsWith(expected)`: linear, unambiguous,
 * and it collapses step 7's `erased !== prev.length + 1` test into the same
 * comparison. This regex is reached only on the first diffable chunk after a
 * session start or an `invalidate()`, where no expectation exists yet.
 */
const ERASE_PREFIX_RE = /^(?:\[2K(?:\[1A)?)+\[G/;
const cursorTo = (row: number): string => `${ESC}${row};1H`;
```

#### 3.2.3 Algorithm — `transform(chunk: string): string | null`

Return value contract: a **string** to write instead of `chunk`, `''` to write
nothing at all, or **`null`** meaning "I do not understand this; write `chunk`
verbatim". `null` is the only failure mode and it is exactly today's behaviour.

`transform` is typed `(chunk: string)` and stays that way (P1-4). The untyped
boundary is the **writer**, because the writer is where untyped input actually
arrives: a `Uint8Array` chunk, and any `write` whose `encoding` argument is
present and is not `'utf8'` / `'utf-8'`, never reaches `transform` at all — the
writer calls `invalidate()` and passes it straight through. In both cases the
bytes that reach the terminal are not the string a differ could reason about,
and pretending otherwise would diff one encoding while writing another.

```
 0. if (!geometryUsable())                → invalidate(); return null   // I-9
 1. const m = matchErasePrefix(chunk)     // startsWith(expected) | ERASE_PREFIX_RE
 2. if (m === null)                       → invalidate(); return null
                                          // session's first write, OR foreign (I-6)
 3. const erased = countErases(m)         // = H_prev + 1
    const body   = chunk.slice(m.length)
 4. if (!body.endsWith('\n'))             → invalidate(); return null   // log.clear() etc.
 5. const lines = body.slice(0, -1).split('\n')                         // H lines
 6. if (lines.length + 1 > rows())        → invalidate(); return null   // I-9
 7. if (prev === null || prev.length !== lines.length || erased !== prev.length + 1)
        → FULL REPAINT (§3.2.4); prev = lines; return payload
 8. const out: string[] = []
    for (let i = 0; i < lines.length; i++)
        if (lines[i] !== prev[i])
            out.push(cursorTo(i + 1) + SGR_RESET + lines[i] + SGR_RESET + ERASE_TO_EOL)
 9. prev = lines
10. if (out.length === 0) return ''       // defensive only — see below
11. out.push(cursorTo(lines.length + 1))  // park the cursor — see I-5
12. return wrapSync(out.join(''))
```

`countErases(prefix)` counts occurrences of `ERASE_LINE` in the matched prefix.

**Step 2 no longer seeds the cache (P1-1).** v1 tried to recognise the session's
first write — which has `previousLineCount === 0` and therefore no erase prefix —
with a heuristic (`looksLikeFrame`) and to seed `prev` from it. A wrong guess
seeds the cache from a non-frame, after which every diff is computed against
fiction, with nothing but step 7's line-count test to catch it — and that test
passes silently whenever the counts happen to agree. The seeding bought exactly
one avoided full repaint per session. It is gone: the first write passes through
untouched, `prev` stays `null`, and the second write — which always carries an
erase prefix — takes the step-7 full-repaint path, whose `CSI H` + `CSI J` opening
re-establishes the origin from scratch. Cost: one ~6 KB write per session.
`looksLikeFrame` and `splitFrame` do not exist.

**Step 8 paints, then clears the tail; it never blanks first (P0-1).** v1 emitted
`cursorTo + SGR_RESET + CSI 2K + text`, which is R1's erase-then-redraw shape
narrowed from H rows to one row. That one row is the composer — the row the user
is watching while they type — and on a terminal without DEC 2026 (legacy
`conhost.exe`, which §3.3 and §7.3 both nominate as the case F1 must carry alone)
the blank is presentable. Overwriting in place and erasing only the residue means
no cell is ever blanked and refilled: a cell either keeps its glyph, or is
overwritten with the new one, or is cleared because the new line is shorter.
The **trailing** `SGR_RESET` before `ERASE_TO_EOL` is load-bearing for the same
BCE reason I-4 gives for the leading one — without it a line ending inside an
open background colour would paint its own tail in that colour.

**Step 10 is unreachable, and is kept as a guard rather than a behaviour
(P2-4).** `log-update.js:13-15` returns early when `output === previousOutput`,
so a chunk that reaches the differ differs from the previous one by at least one
line. The only way to observe `out.length === 0` is a cache that disagrees with
the screen, which is exactly the state `invalidate()` exists to prevent. Its test
asserts the guard; it must not be written as though it described a live path.

#### 3.2.4 Full repaint path

Used on the first **diffable** frame of a session (the session's very first write
is passed through un-diffed and does not seed the cache — P1-1), after any
invalidation including the resize invalidation of I-8, and on any line-count
change:

```ts
const payload =
  cursorTo(1) + SGR_RESET + `${ESC}J` +           // erase from cursor to end of screen
  lines.join('\r\n') + '\r\n' +
  cursorTo(lines.length + 1);
return wrapSync(payload);
```

`CSI J` (erase-down) replaces the `H+1` individual `CSI 2K` erases with one
sequence, and the alt screen is exactly the region being erased. `\r\n` rather
than `\n` is deliberate: Ink relies on the tty's `ONLCR` post-processing to turn
`\n` into CRLF and that dependency is invisible until it is not there; the
explicit form costs one byte per line and removes it.

The blank-then-paint objection of P0-1 does **not** apply here, and the asymmetry
with §3.2.3 step 8 is deliberate. A full repaint rewrites every row, so there is
no "unchanged content that must survive"; `CSI J` + top-down rewrite is byte-for-
byte the shape Ink itself uses today, inside a `wrapSync` envelope Ink does not
have. Full repaints are also rare by construction — one per session, one per
resize, one per invalidation — so their duty cycle is irrelevant, which is the
whole point of §3.2.3 existing.

#### 3.2.5 Invariants

- **I-4 — An emitted line is `SGR_RESET · text · SGR_RESET · ERASE_TO_EOL`, in
  that order, and it never contains `ERASE_LINE`.** Three separate silent
  failures live in this one line, so all three are named:
  1. *Order — paint before erase (P0-1).* `CSI 2K` first would blank the row and
     refill it, which is R1's defect at 1/H the scale but on the one row the user
     is actually watching. Overwriting in place means a cell is never presentably
     empty. `CSI K` afterwards removes only what a longer previous line left
     behind — the exact residue `trimEnd()` in `output.js:139` creates.
  2. *Leading reset.* Ink lines are self-contained only as long as no producer
     ever leaks an unbalanced SGR; the reset makes that a fact rather than an
     assumption.
  3. *Trailing reset.* Terminals implementing BCE paint `CSI K` with the
     **current** background, so a line ending inside an open background colour
     would paint its own tail in that colour — a coloured bar from the end of the
     text to the right margin, on exactly the rows that change most often.
- **I-8 — The writer invalidates on `'resize'` (P0-2).** Ink renders
  *synchronously* from its own `'resize'` handler (`ink.js:83-86`) while the
  frame's height is still the pre-resize one — `useTerminalSize` debounces by
  `RESIZE_THROTTLE_MS = 50` (`useTerminalSize.ts:20,50`). The line count is
  therefore **unchanged** across that window and §3.2.3 step 7 cannot see the
  resize; meanwhile the emulator has re-flowed, truncated or cleared the
  alternate screen, so `prev` no longer describes what is on it. Every row the
  differ believes unchanged is a row it will not repaint — for the rest of the
  drag. The subscription must be on the **real** stream, not the `Proxy`, and it
  must be removed when the writer is torn down. This is the one invariant whose
  absence produces visible corruption during an ordinary window drag rather than
  on an exotic terminal.
- **I-9 — The differ stands down on degenerate geometry (P1-3).** It bails out —
  `invalidate()` and pass through — when `stdout.rows` is missing, when
  `rows < MIN_FULLSCREEN_ROWS`, or when `lines.length + 1 > rows`. `frameHeight`
  clamps to **0** for `rows ≤ 1`, and `frame.ts:30-38` records that this range is
  *reachable*: a resize below `MIN_FULLSCREEN_ROWS` keeps the alternate screen and
  renders a "terminal too small" placeholder sized by the same function. In that
  regime `H = 0` makes the frame body a bare `'\n'` (so `lines = ['']`, one empty
  row, not zero) and step 11 would address row 2 on a one-row terminal. Terminals
  clamp CUP rather than corrupt, so the cost of the guard being absent is a
  *probably* harmless write into an undefined regime — which is precisely the kind
  of bug that ships. Handing the placeholder back to Ink costs nothing: nobody
  types into a two-row window.
- **I-5 — Every emitted batch ends by parking the cursor on row `H+1`.** This is
  what makes the fallback path safe. Ink's `previousLineCount` is computed from
  the string *it* produced and is unaffected by what we actually wrote, so if a
  later chunk falls through to `return null`, its `eraseLines(H+1)` must find the
  cursor exactly where log-update left it last time. Drop this line and a single
  fallback shifts the whole frame up by one row for the rest of the session.
- **I-6 — Any unrecognised write invalidates the cache.** Absolute addressing is
  only valid while nothing else writes to stdout. Full-screen mode already
  forbids that (`patchConsole: false` at `cli.tsx:501`, the console bridge routes
  through `dispatch({type:'notice'})` at `App.tsx:817-819`, Ctrl+L bumps
  `redrawNonce` instead of writing escapes at `App.tsx:1347-1355`), but
  "forbidden" is not "impossible". Invalidation makes the *next* frame a full
  repaint, which re-establishes the origin. The failure mode of the guard being
  absent is a permanently misaligned screen; the failure mode of the guard firing
  spuriously is one extra full repaint.
- **I-7 — The differ never changes what Ink believes it wrote.** It has no back
  channel into `log-update`'s `previousOutput` / `previousLineCount`. Ink's own
  identical-frame dedupe (`log-update.js:13-15`) and `lastOutput` dedupe
  (`ink.js:132`) both still run, upstream of us, unmodified.

### 3.3 F2 — Synchronized output envelope (DEC 2026)

`wrapSync(payload)` returns `SYNC_BEGIN + payload + SYNC_END` when enabled and
`payload` otherwise. Terminals that implement mode 2026 (Windows Terminal ≥
1.16, WezTerm, kitty, iTerm2 ≥ 3.5, Ghostty, foot, contour, recent Alacritty,
xterm.js ≥ 5.1) buffer everything between the two markers and present it in one
composition. Terminals that do not implement it parse the CSI sequence, find an
unknown private mode, and discard it — a documented no-op, not garbage on
screen.

Gating: enabled by default, disabled by `syncOutput: false` / `--no-sync-output`
/ `ARAGON_SYNC_OUTPUT=0`, and forced off when `TERM === 'dumb'`. **No DECRQM
probe.** Querying `CSI ? 2026 $ p` and waiting for the reply means owning stdin
in raw mode before Ink and the mouse filter do, racing both, for a capability
whose absence costs nothing (F1 already removed the flicker) and whose false
positive costs nothing either. That trade is not worth a stdin state machine.

**F2 is an enhancement, not the fix.** If a reviewer proposes shipping F2 alone
because it is 20 lines, the answer is that it makes each repaint atomic but
still repaints the composer 30×/s, so on any terminal without mode 2026 —
including legacy `conhost.exe`, which is reachable on the user's platform — the
bug is entirely unfixed.

**The envelope is never split across two `write` calls (P2-5).** `wrapSync`
returns one string and that string is handed to one `write`, so there is no
reachable interleaving in which `SYNC_BEGIN` is on the wire and `SYNC_END` is
not — no `await`, no chunking we control, no second call site. Terminals also
implement a BSU safety timeout for the case where a process dies mid-batch, so
even a `SIGKILL` between the two markers thaws on its own. Both facts are recorded
here because a later refactor that emits the markers separately (say, to wrap a
whole React commit rather than a single batch) would silently take on a
freeze-the-terminal failure mode that this design does not have.

### 3.4 F3 — One commit per keystroke

`PromptInput` keeps six pieces of state today (`buffer`, `cursor`,
`historyIndex`, `dismissed`, `sel`, `fileMatches`). The first five always change
together and are collapsed into one `useReducer`. `fileMatches` stays a separate
`useState` because it is written from the debounced async glob effect, not from
the key handler.

```ts
export interface EditorState {
  buffer: string;
  cursor: number;
  historyIndex: number | null;
  dismissed: boolean;
  sel: number;
}

export type EditorAction =
  | { type: 'insert'; text: string }                                   // resets draft flags
  | { type: 'replace'; buffer: string; cursor: number }                // applyEdit / completion
  | { type: 'backspace' }
  | { type: 'moveCursor'; cursor: number }                             // ←/→/vertical
  | { type: 'recall'; buffer: string; cursor: number; historyIndex: number | null }
  | { type: 'select'; sel: number }
  | { type: 'dismiss' }
  | { type: 'clear' };                                                 // after submit

export function editorReducer(state: EditorState, action: EditorAction): EditorState;
export const INITIAL_EDITOR_STATE: EditorState;
```

**The rule the implementation must satisfy, and the one a reviewer should check
line by line: every branch of the `useInput` callback performs at most one
`dispatch` and then returns.** `applyEdit` and `moveVertical` stay exactly as
they are — pure, exported, and covered by `__tests__/input.test.ts`, which must
not need a single edit.

Ordering that must not move: the `if (key.tab && key.shift) return;` guard stays
the first statement (`PromptInput.tsx:346`), and the popup-navigation block stays
above the `key.escape` early return. Both carry comments explaining a bug they
already cost this project once.

Secondary effect worth naming: this removes four whole-tree Yoga layout passes
per character (R3), which lowers `lastCommitMs` and therefore makes the render
governor *less* likely to step up a rung while the user types.

### 3.5 Fail-safe ladder

| Rung | State | Behaviour |
|---|---|---|
| 0 | `diffRender: true`, `syncOutput: true` (default) | Per-line diff inside a 2026 envelope. |
| 1 | `--no-sync-output` | Per-line diff, no envelope. Still flicker-free, and after P0-1 that no longer rests on "terminals repaint per line atomically, in practice": an overwrite-then-tail-clear leaves no blank interval to present, so there is nothing for a badly-timed vsync to catch. This is the rung §7.3 item 1 exercises on `conhost`. |
| 2 | `--no-diff-render` | Interposer not installed at all. **Byte-identical to today.** |
| 3 | `--no-fullscreen` | Inline mode; the interposer never existed there. |

F3 has no flag: it is a pure refactor with identical observable input semantics,
and a config switch between "one commit" and "five commits" would be a switch
between "correct" and "correct but slower".

### 3.6 Sequence — one keystroke during a running task

**Before** (per printable character, ~40-row terminal, ~6 KB frame):

```
stdin 'data' → useInput
  ├ setBuffer        → commit 1 → Yoga layout → onRender (leading)  → write 6 KB
  │                                                                   [39 erases + full frame]
  ├ setCursor        → commit 2 → Yoga layout → onRender (throttled)
  ├ setHistoryIndex  → commit 3 → Yoga layout → onRender (throttled)
  ├ setDismissed     → commit 4 → Yoga layout → onRender (throttled)
  └ setSel           → commit 5 → Yoga layout → onRender (trailing)  → write 6 KB
                                                                      [39 erases + full frame]
… interleaved with a spinner tick every 80 ms and an elapsed tick every 200 ms,
   each of which also writes 6 KB [39 erases + full frame].
```

**After**:

```
stdin 'data' → useInput
  └ dispatch(action) → commit 1 → Yoga layout → onRender (leading) → differ
                                                                      → 1 changed line
                                                                      → write ~40 bytes
                                                                        [BSU, CSI 21;1H, SGR0,
                                                                         text, SGR0, CSI K,
                                                                         CSI 41;1H, ESU]
… spinner tick → 1 changed line (the activity row) → ~40 bytes.
   elapsed tick → 1–2 changed lines (status bar)   → ~80 bytes.
   The composer's rows are not written at all unless the composer changed.
```

---

## 4. File / module change plan（文件与模块变更计划）

### 4.1 New files

| Path | Intent |
|---|---|
| `packages/cli/src/ui/frame-differ.ts` | Pure `createFrameDiffer(opts)` — parse the Ink write shape, diff against the previous frame, emit absolutely-addressed changed lines, own invalidation and the DEC 2026 envelope. Zero I/O. |
| `packages/cli/src/ui/stdout-frame-writer.ts` | `wrapStdoutForFrames(stdout, differ)` — a `Proxy` over `NodeJS.WriteStream` that routes `write` through the differ, binds every other member to the real stream, owns the **untyped boundary** (`Uint8Array` chunks and non-UTF-8 `encoding` arguments ⇒ `invalidate()` + pass through, P1-4), subscribes `'resize'` on the **real** stream to `differ.invalidate()` (I-8, P0-2), and re-exports the differ's `stats()`. Returns `{ stdout, stats, dispose }` — `dispose()` removes the resize listener. |
| `packages/cli/src/ui/editor-reducer.ts` | `EditorState` / `EditorAction` / `editorReducer` / `INITIAL_EDITOR_STATE`, extracted so it is unit-testable without mounting Ink. |
| `docs/plans/tui-input-flicker-fix/spec.md` | This document. |
| `docs/plans/tui-input-flicker-fix/manual-test.md` | The manual matrix of §7.3, as a checklist. |

### 4.2 Modified files

| Path | Intent |
|---|---|
| `packages/cli/src/cli.tsx` | Build the differ + writer in `runInteractive` when `mode === 'fullscreen'` and `config.diffRender`; pass it as `render(…, { stdout })` (that call currently passes **no** `stdout`, so this is a pure addition). Call `setFrameStatsProvider(writer.stats)` immediately after, and `setFrameStatsProvider(null)` + `writer.dispose()` on **both** exit branches, beside `disposeMouse()` — the same both-branches discipline `controller.dispose()` and `updateService?.dispose()` already follow at :558-584. Register `--diff-render` / `--no-diff-render` / `--sync-output` / `--no-sync-output`, thread them into `CliFlags` (the trap the file already documents six times: a flag absent from that mapping is silently inert), add both keys to the settable-key array beside `'mouse'` (:701) **and** to the `switch` at :885. |
| `packages/cli/src/config/schema.ts` | `PersistedConfig.diffRender` / `.syncOutput` (+ `CliConfig` mirrors), `DEFAULT_DIFF_RENDER = true`, `DEFAULT_SYNC_OUTPUT = true`, entries in `DEFAULT_CONFIG`. |
| `packages/cli/src/config/env.ts` | `ARAGON_DIFF_RENDER` / `ARAGON_SYNC_OUTPUT`, parsed with the **positive** list (`'1' \| 'true' \| 'on' \| 'yes'`) exactly as `ARAGON_MOUSE` is at :147-150 — not with `envBool`, whose negative list disagrees on values like `disable`. Update the recognised-keys comment at the top. |
| `packages/cli/src/config/load.ts` | Carry the two keys through resolution/precedence like `mouse`. |
| `packages/cli/src/ui/PromptInput.tsx` | Replace the five `useState`s with `useReducer(editorReducer, INITIAL_EDITOR_STATE)`; rewrite each key branch to a single dispatch. `applyEdit` / `moveVertical` / `slashSuggestions` / `fileTokenAt` / `renderWithCursor` unchanged. |
| `packages/cli/src/ui/App.tsx` | **No change (P1-2).** v1 proposed a new optional prop `frameStats?: () => FrameWriterStats`. `commands/perf.ts`'s own header states the convention it violates: *"The snapshot crosses the React boundary through a module-level single slot, the shape `ui/exit-snapshot.ts` already uses … a command runs outside the render pass and has no other way to reach `App`'s refs."* The writer is built in `runInteractive`, lives entirely outside React, and its counters never render — so routing them through a 1944-line component's props buys nothing and costs `App.tsx` + `app.test.tsx` churn. |
| `packages/cli/src/commands/perf.ts` | Add `setFrameStatsProvider(fn: (() => FrameWriterStats) \| null)` beside `setPerfSnapshotProvider`, and one `writer …` line in `formatPerfReport`. No provider registered ⇒ print `writer     full  -  diff render off` and nothing else, so "the flag is off" and "the writer crashed" never look alike. |
| `packages/cli/src/ui/screen.ts` | **No change.** Recorded explicitly: mode 2026 is per-batch, not session state, so it does not belong in the enter/restore pair. |

### 4.3 New tests

| Path | Covers |
|---|---|
| `packages/cli/src/__tests__/frame-differ.test.ts` | The session's first write passes through and does **not** seed (P1-1), and the second write is therefore a full repaint; a one-line change emits exactly one addressed line; a line-count change forces the full-repaint form; an unrecognised chunk returns `null` and invalidates; the batch always ends parked on `H+1`; **the emitted line is `CUP · SGR0 · text · SGR0 · CSI K` and contains no `CSI 2K`** (P0-1 — assert the absence, not just the presence, or the next refactor puts the erase back); the degenerate-geometry bail-out at `rows = 1` and at `lines.length + 1 > rows` (P1-3); sync envelope present/absent per flag; `out.length === 0` returns `''` **labelled as a defensive guard, not a reachable path** (P2-4). |
| `packages/cli/src/__tests__/frame-differ-ink-shape.test.ts` | **The upgrade tripwire.** Drives the real `ink/build/log-update.js` against a fake stream, captures the chunk, and asserts both that `ERASE_PREFIX_RE` matches it **and** that the exact-prefix fast path (`eraseLines(n)` reconstructed from `prev.length + 1`) is byte-equal to what log-update produced. If a future Ink changes its write shape, this fails loudly instead of the differ silently falling back to pass-through forever. |
| `packages/cli/src/__tests__/stdout-frame-writer.test.ts` | `columns`/`rows` read through; `on`/`off` register on the real stream and the listener is removable (the bind trap of §5.5); `write(Buffer)` passes through and invalidates; `write(str, 'latin1', cb)` passes through and invalidates (P1-4); the `write(chunk, cb)` and `write(chunk, enc, cb)` overloads both still invoke the callback, **including when the differ returns `''`**; return value follows the real stream's backpressure boolean; **a `'resize'` event on the real stream invalidates the differ, and `dispose()` removes that listener** (P0-2). |
| `packages/cli/src/__tests__/editor-reducer.test.ts` | Every action's transform; draft-flag reset semantics; history recall at both edges. |
| `packages/cli/src/__tests__/prompt-input-commits.test.tsx` | With `ink-testing-library`, a render counter proves one printable character ⇒ **one** `PromptInput` render (regression guard for R3). |
| `packages/cli/src/__tests__/config.test.ts` (extend) | The two new keys round-trip through file → env → flag precedence. |

---

## 5. Interface design（接口设计）

### 5.1 Configuration keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `diffRender` | `boolean` | `true` | Repaint only the frame lines that changed (full-screen only). |
| `syncOutput` | `boolean` | `true` | Wrap each repaint batch in DEC 2026 begin/end synchronized update. |

Both are settable with `aragon config set diffRender false` and are listed in
`aragon config list`. Neither appears on the settings overlay: they are
troubleshooting switches, in the same class as `historyEnabled`.

### 5.2 CLI flags

```
--diff-render          Repaint only changed rows (default)
--no-diff-render       Repaint the whole frame every time (pre-fix behaviour)
--sync-output          Ask the terminal to present each repaint atomically (default)
--no-sync-output       Do not emit DEC 2026 begin/end synchronized update
```

### 5.3 Environment overrides

```
ARAGON_DIFF_RENDER=0|1     ARAGON_SYNC_OUTPUT=0|1
```

Positive-list parsing (`1|true|on|yes` ⇒ enabled, anything else non-empty ⇒
disabled), matching `ARAGON_MOUSE` / `ARAGON_FULLSCREEN` / `ARAGON_PLAN`.

### 5.4 `/perf` additions

One line, appended to the five `formatPerfReport` already emits, in that
function's existing **ASCII** separator shape (P2-1 — v1's sample used `·`, but
`/perf` renders on the same terminals `glyphs.ts` tiers ASCII fallbacks for, and
every other line in that function uses `  -  `):

```
writer     diff  -  frames 1842 (diffed 1839, full 3)  -  lines/frame 1.4  -  bytes/frame 61  -  fallbacks 0
```

With no provider registered:

```
writer     full  -  diff render off
```

`fallbacks > 0` on a healthy session is the single most useful diagnostic this
feature can emit: it means something wrote to stdout behind Ink's back.

### 5.5 Internal TypeScript contracts

```ts
// ui/frame-differ.ts
export interface FrameDifferOptions {
  /** Emit the DEC 2026 envelope around each batch. */
  sync: boolean;
  /**
   * Live terminal height. Read on every `transform`, never cached: it is the
   * only input to the I-9 geometry guard and it changes under the differ's feet
   * on resize. `undefined` ⇒ stand down and pass through.
   */
  rows: () => number | undefined;
  /** Raised once, on the 0→1 edge of `fallbacks`. See §5.6. */
  onFirstFallback?: () => void;
}

export interface FrameWriterStats {
  framesTotal: number;
  framesDiffed: number;
  framesFull: number;
  linesWritten: number;
  bytesWritten: number;
  fallbacks: number;
}

export interface FrameDiffer {
  /**
   * Bytes to write instead of `chunk`; `''` = write nothing; `null` = write
   * `chunk`. The parameter is `string` and only `string` (P1-4): decoding and
   * the decision about what is even diffable belong to the writer, which is the
   * only place untyped input arrives.
   */
  transform(chunk: string): string | null;
  /** Force the next frame to be a full repaint. */
  invalidate(): void;
  /** Single owner of the counters (P2-2); the writer re-exports this, it does not duplicate it. */
  stats(): FrameWriterStats;
}

export function createFrameDiffer(options: FrameDifferOptions): FrameDiffer;

// ui/stdout-frame-writer.ts
export interface FrameWriterHandle {
  /** Hand this to `render(…, { stdout })`. */
  stdout: NodeJS.WriteStream;
  /** Hand this to `setFrameStatsProvider`. */
  stats(): FrameWriterStats;
  /** Removes the `'resize'` subscription of I-8. Idempotent; called on both exit branches. */
  dispose(): void;
}

export function wrapStdoutForFrames(
  stdout: NodeJS.WriteStream,
  differ: FrameDiffer,
): FrameWriterHandle;
```

The `Proxy`'s `get` trap **must bind non-`write` function members to the real
stream** (`const v = Reflect.get(target, prop); return typeof v === 'function' ?
v.bind(target) : v;`). Without the bind, `stdout.on('resize', …)` executes with
`this === proxy`, and `useTerminalSize`
(`ui/layout/useTerminalSize.ts:57-62`) registers and removes its listener
against a different `_events` object than the one Node emits on — the frame
stops resizing and nothing reports why. Bound methods are cached in a `Map`
keyed by property name so repeated access does not allocate.

`write` must honour all three Node overloads:

```ts
write(chunk: string | Uint8Array, encoding?, cb?): boolean
```

`Uint8Array` chunks are passed straight through **after** `invalidate()` (Ink
never writes Buffers, so a Buffer is by definition foreign), and so is any call
whose `encoding` argument is present and is neither `'utf8'` nor `'utf-8'`
(P1-4): in that case the bytes that reach the terminal are not the string the
differ would have diffed, and diffing one encoding while writing another is the
kind of bug that only shows up on someone else's machine. Neither case reaches
`transform`. The callback is always invoked by the underlying `write`; when the
differ returns `''` the wrapper must still call `cb?.()` and return `true` rather
than skipping the callback.

The `'resize'` subscription of I-8 goes on the **real** stream, in
`wrapStdoutForFrames`, not on the `Proxy` and not in `frame-differ.ts` — the
differ is pure by contract (§4.1) and must stay unit-testable with plain string
literals and no event emitter. `dispose()` removes it; forgetting to call
`dispose()` leaks one listener on a stream that outlives the process by nothing,
so this is hygiene rather than a defect, but it is also what keeps
`stdout-frame-writer.test.ts` able to assert listener removal.

### 5.6 First-fallback notice（P1-5，回答 §12 Q3）

The first time `fallbacks` goes from 0 to 1 in a session, the writer raises one
notice through the same channel the console bridge uses
(`dispatch({type:'notice', level:'warn'})`), worded so it names the escape hatch:

> Frame diffing lost sync with the terminal and fell back to a full repaint.
> If the display looks wrong, restart with `--no-diff-render`.

Three constraints on it, each of which is the reason it is specified rather than
left to the implementer:

- **Once per session, latched on the 0→1 edge.** A notice per fallback would be
  a repaint storm triggered by a repaint problem.
- **`warn`, not `error`.** A single fallback is self-healing by construction
  (I-6); it is worth telling the user about only because the *pattern* is not.
- **The writer cannot import `App`.** It receives an optional
  `onFirstFallback?: () => void` in `FrameDifferOptions`; `cli.tsx` supplies a
  closure that goes through the notice bridge, and supplies nothing in tests.

v1 left this open (§12 Q3). It is closed here because the feature's
characteristic failure is *silent*, and a silent failure whose remedy is a flag
the user has never heard of is not an acceptable end state for a fix whose whole
premise is "the user should not have to notice the renderer".

---

## 6. Data model（数据模型）

No database, no schema migration, no persisted state beyond the two booleans of
§5.1. All runtime state is process-local and lives in the differ closure:

```ts
let prev: string[] | null;      // last frame, one entry per row; null = no cache
let stats: FrameWriterStats;    // counters for /perf
```

`prev` is bounded by the terminal height (≤ a few hundred short strings); it is
replaced, never appended to, so it cannot grow. It is dropped on `invalidate()`
and on line-count change. There is deliberately **no** cache of per-line widths
or SGR state: everything the differ needs is recomputed from the two frame
strings, which is what keeps it a pure function of `(prev, chunk)` and testable
with plain string literals.

---

## 7. Testing & acceptance criteria（测试与验收标准）

### 7.1 Acceptance criteria

- **AC-1** With a task running and the user typing continuously, the composer
  region shows no visible flicker on Windows Terminal, VS Code's integrated
  terminal, and the AragonMesh embedded xterm.js pane.
- **AC-2** A frame in which only the composer's text changed produces a write
  containing exactly one `CSI <row>;1H` line payload, and that payload is
  `CUP · SGR0 · text · SGR0 · CSI K` — it contains **no `CSI 2K`** anywhere
  (P0-1). The negative half of the assertion is the load-bearing half: a
  refactor that reinstates the erase would still satisfy "exactly one addressed
  line" while reintroducing the defect. (Unit test.)
- **AC-3** A spinner tick produces a write that does **not** address any composer
  row. (Unit test with two synthetic frames.)
- **AC-4** One printable character produces exactly one `PromptInput` render.
  (Unit test.)
- **AC-5** `--no-diff-render` produces a byte stream identical to the pre-change
  build for the same event sequence. (Unit test on the writer being absent +
  manual A/B.)
- **AC-6** Inline mode (`--no-fullscreen`), `aragon -p`, `aragon config …`,
  `aragon --version` are byte-identical. (No interposer is constructed on those
  paths; asserted by the wiring test.)
- **AC-7** Resizing the window mid-run repaints correctly with no leftover rows,
  and `/perf` shows `framesFull` incremented by at least one.
- **AC-8** Opening and closing every overlay (help, settings, confirm, question,
  plan) leaves no residue on the rows the overlay covered.
- **AC-9** Ctrl+L still forces a visible repaint (it bumps `redrawNonce`, the
  status bar changes by one zero-width byte, the differ emits that one line).
- **AC-10** On exit — normal, `Ctrl+C ×2`, `SIGTERM`, and a crash — the alternate
  screen is restored, the cursor is visible, and `--exit-transcript` replay is
  unchanged.
- **AC-11** `fallbacks === 0` after a 10-minute session that includes a run, a
  resize, three overlays and heavy typing. This is only meaningful because
  `fallbacks` counts **pass-throughs** (`transform` returned `null`) and *not*
  invalidations: a resize legitimately invalidates (I-8) and shows up as
  `framesFull`, so counting invalidations here would put AC-11 and AC-7 in
  direct contradiction and one of them would end up quietly relaxed.
- **AC-12** `input.test.ts` passes **unmodified**.
- **AC-13** Dragging the window continuously for five seconds during a run leaves
  no stale rows at any point of the drag, and `/perf` shows `framesFull` roughly
  tracking the number of resize events. (Manual, §7.3 #7 — this is the P0-2
  regression and the 50 ms `useTerminalSize` debounce means a single-step resize
  will not reproduce it; the drag has to be continuous.)
- **AC-14** Shrinking the terminal below `MIN_FULLSCREEN_ROWS` shows the
  "terminal too small" placeholder exactly as it does today, and growing back
  restores a correct frame. (Manual + unit test of the I-9 guard at `rows = 1`.)
- **AC-15** A synthetic foreign write during a full-screen session raises exactly
  **one** notice naming `--no-diff-render`, no matter how many further fallbacks
  follow. (Unit test on the 0→1 latch; §5.6.)

### 7.2 Performance targets

| Metric | Before | Target |
|---|---|---|
| Bytes written per keystroke (40×120 terminal, mid-session) | ~12 KB (2 frames) | < 200 B |
| Bytes written per spinner tick | ~6 KB | < 120 B |
| React commits per printable character | 5 | 1 |
| Whole-tree Yoga layouts per printable character | 5 | 1 |

### 7.3 Manual test plan

Run each on **Windows Terminal**, **legacy `conhost.exe`**, **VS Code terminal**
and the **AragonMesh embedded terminal**; `conhost` is the one with no mode 2026,
so it is the proof that F1 carries the fix on its own.

**Merge gate (P2-6).** 13 scenarios × 4 terminals is 52 runs, which is a matrix
nobody completes before a merge and everybody signs off anyway. Items **1, 7, 10,
12** on **all four** terminals are the gate; the rest are on Windows Terminal
only for the merge and completed on the remaining three before the release that
carries this. Item 1 on `conhost` is the single result that decides whether the
fix works at all; item 7 is the P0-2 regression; items 10 and 12 are where an
absolute-addressing bug leaves visible debris.

1. Start a long task; type a full sentence while it streams. Composer must be
   rock steady. Repeat with `--no-sync-output` (must still be steady — this is
   what proves F1 carries the fix without F2) and with `--no-diff-render`
   (flicker must return — this is the control that proves the diagnosis).
2. Type into an empty idle session — border colour flips on the first character;
   no flash of the frame.
3. Open the `/` palette, arrow through it, accept with Tab; then `@` file
   completion with a large repo (the 120 ms debounce lands mid-typing).
4. Shift+Tab mode toggle with a popup open (the AC-P3 regression).
5. Multi-line editing: Shift+Enter, arrow up/down inside the buffer, Home/End,
   Ctrl+W / Ctrl+U / Ctrl+K.
6. Prompt-history recall at both edges of an empty buffer.
7. Drag-resize the window **continuously for ~5 s** while a task streams, in
   both directions, including a shrink below `MIN_FULLSCREEN_ROWS` and back
   (AC-13 / AC-14). A single-step resize does **not** exercise P0-2 — the
   50 ms `useTerminalSize` debounce closes the window before you can see it.
8. PgUp / PgDn / Shift+↑↓ / mouse wheel scrolling during a run.
9. Ctrl+L; Ctrl+T; Ctrl+O.
10. Every overlay open → close → confirm the covered rows are clean.
11. `Esc` abort mid-run, then immediately type.
12. Exit paths: `/exit`, `Ctrl+C` twice, `kill <pid>`, closing the window.
13. `--no-fullscreen` full session — appearance unchanged from today.

---

## 8. Risks & mitigations（风险与缓解）

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| K-1 | Something writes to stdout behind Ink's back and desyncs absolute addressing | Low | I-6 self-healing invalidation; `/perf`'s `fallbacks` counter surfaces it; full-screen already routes `console.*` through the notice bridge and Ctrl+L through a nonce |
| K-2 | A future Ink changes the `eraseLines + frame` write shape; the differ silently degrades to pass-through forever | Medium (on upgrade) | `frame-differ-ink-shape.test.ts` drives the real `log-update` and fails the build on a shape change |
| K-3 | A terminal implements mode 2026 badly (frames never present, or a stuck buffer) | Low | `--no-sync-output`; F1 alone is already sufficient |
| K-4 | BCE terminals paint erased cells with a stale background | Low | I-4: `SGR_RESET` both **before** the text and **before** `ERASE_TO_EOL`. The trailing one is the one that is easy to drop and the one that produces the visible artefact (a coloured bar from the end of the text to the right margin) |
| K-5 | A frame line's display width equals `cols`, setting the pending-wrap flag | Low | Every line is preceded by an absolute `CUP`, which cancels the pending-wrap state |
| K-6 | Wide characters (CJK) / emoji split across a diff boundary | None | Diffs are whole-line; a line is written or it is not |
| K-7 | The `PromptInput` refactor changes input semantics | Medium | `input.test.ts` untouched and must pass; new `editor-reducer.test.ts`; the two ordering comments (Shift+Tab first, popup block before `key.escape`) are carried over verbatim |
| K-8 | `\n` vs `\r\n` on a terminal without `ONLCR` | Low | Explicit `\r\n` in every path we emit (§3.2.4) |
| K-9 | Proxy overhead on a hot path | Very low | One `Map` lookup per property access; `write` is the only trapped behaviour, and it replaces a 6 KB write with a 60 B one |
| K-10 | Someone "simplifies" `frameHeight(rows) = rows - 1` while touching layout, re-enabling `ink.js:121` | Low | `frame.test.ts` already asserts `frameHeight(r) < r` for r ∈ [1,200]; §2 R5 records why |
| K-11 | Stale rows during a continuous window drag: Ink renders synchronously from `'resize'` at the **old** height while `useTerminalSize` debounces 50 ms, so the line-count guard cannot see the resize | **Medium** — an ordinary window drag, not an exotic terminal | I-8: the writer invalidates on `'resize'` from the real stream. AC-13 + manual §7.3 #7 (continuous drag; a single step will not reproduce it) |
| K-12 | Absolute addressing in a degenerate viewport (`frameHeight → 0` at `rows ≤ 1`, a state `frame.ts:30-38` documents as reachable) | Low | I-9: stand down and pass through below `MIN_FULLSCREEN_ROWS` or when `lines.length + 1 > rows`. AC-14 |
| K-13 | Someone later wraps a whole React commit (rather than one batch) in the DEC 2026 envelope and splits `SYNC_BEGIN` / `SYNC_END` across two writes, so a mid-batch death freezes the terminal until its BSU timeout | Low | §3.3 records the single-write invariant and why it exists; `wrapSync` returns one string and has exactly one call site per path |
| K-14 | `fallbacks` is implemented as "invalidations" rather than "pass-throughs", putting AC-7 and AC-11 in contradiction and getting one of them relaxed | Medium (it is a natural mis-read) | AC-11 states the distinction; the counter list in §5.5 keeps `framesFull` and `fallbacks` as separate fields for exactly this reason |

---

## 9. Non-goals（非目标）

1. **Inline mode.** No fixed frame, no stable origin, `<Static>` interleaving —
   the differ is not installed and inline output stays byte-identical.
2. **Replacing or forking Ink**, and no `patch-package` entry against it.
3. **Changing repaint frequency.** The spinner keeps its 80 ms, the elapsed
   clock its 200 ms, the governor its ladder. Once unchanged rows are not
   written, those rates cost a few dozen bytes each and are no longer worth
   trading against responsiveness.
4. **A terminal capability probe (DECRQM) or a `TERM` allow-list.** §3.3.
5. **True double buffering / a hand-written renderer.** Out of proportion.
6. **Cursor-shape or hardware-cursor work.** The caret stays the inverse-video
   block `renderWithCursor` already draws.
7. **Touching `packages/core`.** Nothing in this package leaves the CLI.

---

## 10. Alternatives considered（备选方案）

- **Lower the repaint rate (pin the governor to a high rung while typing).**
  Rejected: trades an input-latency regression for a *reduction* in flicker,
  never elimination, and makes the UI feel worse in the exact moment the user is
  interacting with it.
- **Move the composer to the top of the frame** so it is erased last and
  redrawn first. Rejected: it relocates the flicker to the transcript, inverts a
  layout every other decision in `AppShell` depends on, and fixes nothing.
- **Emit mode 2026 only (F2 alone).** Rejected: leaves legacy `conhost` — a
  reachable terminal on the reporting user's platform — completely unfixed.
  §3.3.
- **Render the composer outside Ink**, writing it directly with absolute
  addressing. Rejected: two owners of the same screen region, and every layout
  invariant `AppShell` provides would have to be duplicated by hand.
- **Bump to Ink 6.** Investigated: the write strategy is unchanged, so it does
  not address R1, and it would drag a React 19 / API migration into a bug fix.

---

## 11. Implementation order（实施顺序）

1. `frame-differ.ts` + `frame-differ.test.ts` + `frame-differ-ink-shape.test.ts`
   — pure, no wiring, fully verifiable before anything is plugged in.
2. `stdout-frame-writer.ts` + its test (Proxy semantics, especially `on`/`off`
   binding and the `write` overloads).
3. Config plumbing: `schema.ts` → `env.ts` → `load.ts` → `cli.tsx` flags +
   settable-key array + `switch` case. Verify `aragon config set diffRender
   false` actually persists **and takes effect** — the trap `cli.tsx` documents
   at :697-701 is a key that is accepted, prints `Set …`, and writes nothing.
4. Wire the writer into `runInteractive` behind `mode === 'fullscreen' &&
   config.diffRender`, including the `'resize'` subscription (I-8) and both
   `dispose()` call sites. Run §7.3 item 1 on `conhost` **here**, before anything
   else is built: it is the single result that decides whether the diagnosis was
   right, and every later step is wasted if it is not.
5. `/perf` counters (`setFrameStatsProvider`) and the §5.6 first-fallback notice.
   Deliberately before F3: they are what makes the F1 soak in step 6 legible.
   **F1 + F2 close the reported bug and ship at the end of this step.**
6. **Separate change.** `editor-reducer.ts` + tests, then the `PromptInput`
   refactor and `prompt-input-commits.test.tsx`. F3 must not ride along with
   F1/F2 (review, right-sizing): it is the only part of this package that can
   regress input semantics (K-7, Medium), it is a pure performance refactor that
   the user cannot see once F1 has landed, and bundling it means a flicker
   regression and a "Shift+Tab eats my draft" regression share one revert.
7. Run the §7.3 matrix — the merge-gate subset first, the remainder before the
   release; record results in `manual-test.md`.

---

## 12. Open questions — answered by the review node（评审待决问题 · 已答复）

All three are closed. None remains open against v2.

1. **Should `syncOutput` default to `true` with no probe?** — **Yes, as
   specified.** Agreed, and for a reason worth recording beyond the one v1 gives:
   the DECRQM probe is not merely invasive, it is *unimplementable here without a
   regression*. It would need stdin in raw mode before Ink and before the mouse
   filter (`cli.tsx:404`), and `cli.tsx:395-401` already documents why that
   ordering is delicate — the filter exists because reports come back on stdin
   and a wrapper that owns stdin first swallows them. Paying that for a
   capability whose absence costs nothing (F1 carries the fix; §7.3 item 1 on
   `conhost` proves it) and whose false positive also costs nothing (unknown
   private modes are discarded) is a bad trade in both directions.
2. **Should the differ also install in inline mode when the session happens to
   have no `<Static>` output yet?** — **No, as specified.** Reinforced: I-3's
   stable origin does not exist inline at all. Inline output starts wherever the
   shell's cursor happened to be and scrolls; row *k* of the frame is not
   absolute row *k*, and it changes every time the buffer scrolls. The `<Static>`
   condition is the *lesser* of the two obstacles, and v1's reasoning would still
   hold even if it were not.
3. **Is `/perf` the right home for the writer counters, or should `fallbacks > 0`
   also raise a one-shot notice?** — **Both.** `/perf` keeps the counters
   (§5.4); a one-shot `warn` notice on the 0→1 edge names `--no-diff-render`
   (§5.6, AC-15). See P1-5: the characteristic failure of this feature is
   *silent*, so leaving its only signal behind a slash command the affected user
   has no reason to run is not a state a review can approve. The rate limit is
   part of the answer, not a detail — a notice per fallback would be a repaint
   storm triggered by a repaint problem.

---

## 13. 评审结论（Review Verdict）

### 有条件通过（Approved with conditions）

The diagnosis is correct and independently reproducible from the sources: every
one of the ~20 anchors in §2 was opened and matched, and R1's mechanism —
`log-update.js:17` writing `eraseLines(previousLineCount) + frame` on every
commit, with `ansi-escapes`' bottom-up erase reaching the composer first and the
top-down rewrite reaching it last, 15–30 times a second while a run streams — is
exactly the reported symptom. The insertion point is right: Ink exposes no frame
hook, `render()` at `cli.tsx:485` currently passes no `stdout`, and a `Proxy` over
it makes the whole thing a pure string→string function that unit-tests without a
TTY. Scope is proportionate and the fail-safe ladder is real, not decorative.

Two P0s were found and are fixed in the body: the changed-line emit still
blanked-then-painted the one row the user watches (P0-1), and nothing invalidated
the cache on resize, where Ink's synchronous re-render at the pre-debounce height
makes the line-count guard blind (P0-2). Five P1s and six P2s are likewise
resolved in place. **No P0 or P1 remains open.**

Approval is conditional on five things, all of which are now written into the
document and none of which is discretionary:

1. **§7.3 item 1 on legacy `conhost.exe`, run at step 4 of §11, before anything
   further is built.** F2 is inert there by construction, so this is the only
   observation that distinguishes "F1 fixes the bug" from "F1 makes the bug 39×
   rarer". If the composer is not rock steady on `conhost` with
   `--no-sync-output`, stop and re-open the design rather than shipping F2 as
   cover.
2. **The emitted line contains no `CSI 2K`, and the test asserts its absence**
   (AC-2, P0-1). The positive assertion alone would survive a refactor that puts
   the erase back.
3. **The `'resize'` invalidation exists, sits on the real stream, and is
   exercised by a *continuous* drag** (I-8, AC-13, §7.3 #7). A single-step resize
   closes the 50 ms window before it can be seen; a matrix run that only clicks
   "maximise" will report a pass on the one defect most likely to reach users.
4. **F3 lands as its own change** (§11 step 6). It is the only part of this
   package that can regress input semantics, and it is invisible to the user once
   F1 has landed — bundling it means one revert undoes both.
5. **`fallbacks` counts pass-throughs, not invalidations** (AC-11, K-14). Getting
   this backwards puts AC-7 and AC-11 in direct contradiction, and the way that
   is usually resolved is by quietly relaxing AC-11 — which is the assertion that
   the whole absolute-addressing scheme is still sound.

Two notes carried forward for the implementer, neither blocking:

- `ink.js:121`'s `clearTerminal` path bypasses `log-update` entirely and does not
  update `previousLineCount`. It is unreachable while `frameHeight(rows) = rows-1`
  and `AppShell` keeps `overflow="hidden"` (§2 R5, K-10), and if it ever is
  reached the differ passes it through and self-heals — but the *pre-existing*
  Ink misalignment it causes is not something this package fixes, so do not read
  a `fallbacks` spike there as a differ bug.
- `cliCursor.hide()` writes to **stderr**, and `enterAltScreen` / `restore()` /
  `replayTranscript()` all write to the **real** `process.stdout` strictly before
  `render()` or strictly after `waitUntilExit()` resolves (`cli.tsx:437`, `:558-584`).
  None of them is a mid-session foreign write, which is why I-6's premise holds
  today. It holds *by circumstance*, not by enforcement — a future direct
  `process.stdout.write` inside a full-screen code path would be invisible to the
  proxy and would not even increment `fallbacks`.

---

## 14. 实施过程发现的方案缺陷（Issues Found During Implementation）

Five things the design does not say, found while building it. Each one is
recorded here with the corrected approach that was actually implemented, rather
than being resolved silently in code.

### IF-1 · `fallbacks` would have fired the §5.6 notice on **every** launch

**The gap.** §3.2.3 step 2 folds two very different chunks into one branch:
"the session's first write, OR foreign (I-6)". §5.4 and §5.6 then define
`fallbacks` as meaning "something wrote to stdout behind Ink's back", and AC-11
asserts `fallbacks === 0` after a healthy ten-minute session. But the session's
first write **always** takes step 2 — `previousLineCount` starts at 0, so
`eraseLines(0)` is the empty string and the chunk carries no prefix (this is
exactly what P1-1 relies on). Counting it makes `fallbacks` 1 on every launch,
which breaks AC-11 by construction and raises the one-shot "your terminal may
look broken" notice at the start of every single session — on a healthy build,
for a chunk the design deliberately expects.

**Implemented.** The differ carries a `seenAnyChunk` flag. A prefix-less chunk
that is the **first** chunk of the session is passed through **uncounted**;
after that, every chunk Ink produces carries a prefix, so a prefix-less chunk
really is foreign and is counted. `frame-differ-ink-shape.test.ts` pins the
premise (first `render()` writes no prefix; the second always does), and
`frame-differ.test.ts` asserts `fallbacks === 0` after the seed write.

### IF-2 · The I-9 geometry stand-down must not count as a fallback either

**The gap.** §3.2.3 steps 0 and 6 `return null`, and §13 condition 5 says
`fallbacks` counts pass-throughs. Read literally, shrinking the window below
`MIN_FULLSCREEN_ROWS` — an ordinary window drag, and a state `frame.ts:30-38`
documents as reachable — increments `fallbacks` and raises the §5.6 notice
telling the user their display may be wrong and to restart with
`--no-diff-render`. Nothing wrote behind Ink's back; the viewport is simply too
small to address. That is a false alarm on the one message whose entire value is
precision, and it lands during the manual case (§7.3 #7) that also covers AC-14.

**Implemented.** `passThrough(counted: boolean)`. Both I-9 exits pass `false`;
every genuine "I do not understand this write" exit passes `true`. The counter
therefore keeps the meaning §5.4 gives it. §13 condition 5's intent is preserved
exactly: `fallbacks` still counts **pass-throughs and not invalidations**, so a
resize shows up as `framesFull` (AC-7) with `fallbacks` untouched (AC-11).

### IF-3 · `framesTotal` is `framesDiffed + framesFull`, not "chunks seen"

**The gap.** §5.5 lists the three counters without saying how they relate.
§5.4's sample line — `frames 1842 (diffed 1839, full 3)` — settles it
arithmetically, and it is the *sample*, not the prose, that is authoritative:
1839 + 3 = 1842 exactly, so pass-throughs are **not** in `framesTotal`. They are
reported separately as `fallbacks`, which is the whole point of keeping the two
fields apart (K-14).

**Implemented.** `framesTotal` is incremented only in `emit()`, alongside
`framesDiffed` / `framesFull`. A regression test asserts the identity directly,
so a later refactor that starts counting chunks cannot drift the `lines/frame`
and `bytes/frame` denominators without failing.

### IF-4 · The §5.6 notice channel is `console.warn`, and it needs no new wiring

**The gap.** §5.6 says the notice goes "through the same channel the console
bridge uses (`dispatch({type:'notice', level:'warn'})`)" and that "`cli.tsx`
supplies a closure that goes through the notice bridge" — while §4.2 states
`App.tsx` is untouched. There is no existing bridge object from `cli.tsx` into
`App`'s dispatch, so read one way the two statements conflict.

**Implemented.** They do not conflict, because in full-screen mode the console
bridge **is** the channel: `App.tsx:817-820` installs `installConsoleBridge`,
which routes `console.*` into `dispatch({type:'notice', level, text})`. The
closure is therefore `() => console.warn(FRAME_FALLBACK_NOTICE)` and `App.tsx`
needs no change at all, exactly as P1-2 requires. One bounded caveat, recorded
rather than fixed: a fallback raised *before* the App's effect has run would
reach the real `console.warn` (stderr). It is not reachable in practice — a
fallback needs at least one frame to have been diffed, and the bridge is
installed on the first commit — and the cost if it ever were would be one line
of text, not a corrupted frame.

### IF-5 · Eleven existing test fixtures build `CliConfig` by hand

**The gap.** §4.3 lists one test to extend (`config.test.ts`). In fact adding
two **required** keys to `CliConfig` breaks every hand-rolled fixture in the
package — fourteen files, each with its own local `config()` helper. `npm test`
stays **green** while this is broken, because vitest transpiles without
typechecking; only `tsc -p tsconfig.test.json --noEmit` catches it, which is
precisely the hole that config file's own header says it exists to close.

**Implemented.** All fourteen fixtures gained `diffRender: true` /
`syncOutput: true` (two lines each, no other change). Also unlisted in §4.3 but
required: `perf-command.test.ts` asserted `formatPerfReport` returns exactly
five lines, which the §5.4 `writer` line makes six; it now asserts six, plus the
attached-writer and `diff render off` forms.

**Process note.** `npm run build` is not a typecheck of the test tree. Both
`tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit` were
run to green, in addition to the 142-file suite.

### Scope note carried from §11 step 6

§11 step 6 requires F3 (`editor-reducer.ts` + the `PromptInput` refactor) to
land as **its own change**, separate from F1+F2. This node implements the full
§4 change plan in one working tree because committing is explicitly the next
node's responsibility, so the split cannot be made here. **The commit node
should produce two commits from this tree**, in this order:

1. **F1 + F2 + config + `/perf`** — `ui/frame-differ.ts`,
   `ui/stdout-frame-writer.ts`, `config/{schema,env,load}.ts`, `cli.tsx`,
   `commands/perf.ts`, the fourteen fixture files, `perf-command.test.ts`,
   `config.test.ts`, `__tests__/frame-differ*.test.ts`,
   `__tests__/stdout-frame-writer.test.ts`, and both documents.
2. **F3** — `ui/editor-reducer.ts`, `ui/PromptInput.tsx`,
   `__tests__/editor-reducer.test.ts`,
   `__tests__/prompt-input-commits.test.tsx`.

The reason is unchanged from §13 condition 4: F3 is the only part of the package
that can regress input semantics (K-7), it is invisible to the user once F1 has
landed, and bundling them means one revert undoes both.
