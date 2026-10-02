# Agent activity presentation — quiet thinking, a live working line, and real diffs

Version: **v2** (round 1 design + round 1 review)
Status: design — implementation not started
Scope: `packages/cli` only. `packages/core` is not touched.

---

## 评审记录 (Review Notes) — round 1

Reviewer pass over v1, section by section, against feasibility / completeness /
consistency / right-sizing. Every claim below was checked against the tree at
`packages/cli/src`; the file:line citations are the reviewer's, not v1's.

**Two P0s and seven P1s were found and are fixed in the body of this v2.** The
P2s are recorded here as notes; the ones that change a sentence are fixed too,
the ones that are only observations are left for the implementer.

### P0 — must fix before implementation

| ID | Section | Concern |
|---|---|---|
| **P0-1** | §3.2.3, §6 | **The activity row is an unbudgeted, conditional row inside a fixed-height frame.** `viewportRows()` (`ui/layout/budget.ts:55`) is the *one* function that says how many rows the viewport gets, and it enumerates exactly `header + toast + composer + status`. `AppShell`'s full-screen root is `height={frameHeight(rows)}` with `overflow="hidden"`, and the viewport box is its only `flexShrink={1}` child. An extra bottom-chrome row therefore does not grow the frame — it **silently steals a row from the transcript** that `ScrollViewport`, `selectWindow`, `overlayMaxRows`, `popupMaxRows` and `todoRailRows` all still believe they have. Worse, it appears on submit and disappears on `agent_end`, so the transcript jumps by a row on **every run**. `ToastStack.tsx:5-10` states this exact rule for itself: *"in `fullscreen` this ALWAYS occupies exactly one row — an empty row when there is nothing to say. Rendering conditionally would make the viewport height (and therefore the whole transcript) jump every time a toast appears or expires."* v1 proposes the row that comment forbids, and AC-8 pins only the **idle** frame, so §7 cannot catch it. Fixed in §3.2.3 (share the already-budgeted toast row in full-screen; keep the conditional row in inline, which has no frame) + AC-8a. |
| **P0-2** | §3.1.3, §7.2 | **In inline mode the collapsed marker instructs the user to press a key that cannot work.** A settled entry is printed once into Ink's `<Static>` and is never re-rendered — `Transcript.tsx:9-10` says so outright, and the settled boundary is deliberately monotonic. Today that is harmless because thinking is visible by default, so the body is already in the terminal's scrollback. After the flip the body is **never printed at all**, and `ctrl+t to show` cannot reveal it: `toggleThinking` changes `ViewState`, and `<Static>` cannot un-print or re-print. So AC-3 ("for **every entry already in the transcript**") is unimplementable in inline mode, manual row 2 fails there, and the honesty argument of §1.2 — the single stated reason the marker exists — inverts into a UI element that lies. Fixed in §3.1.3 (mode-aware marker copy), §4.2, AC-3, manual row 2. |

### P1 — fixed in this v2

| ID | Section | Concern |
|---|---|---|
| **P1-1** | §1.2, §3.2.2 | **The activity row duplicates the status bar one row away.** `StatusBar.tsx:294-298` renders `formatDuration(elapsedMs)` **only while running**, and `:292` renders the token cluster at the **same `cols >= 72`** breakpoint v1 picks. The status bar sits directly below the composer, the activity row directly above it. v1 forbids repeating `esc abort` on adjacent rows (D-5) and cites the v0.4.0 removal of the status bar's hint cluster as precedent — then adds a second clock and a second token counter at the same breakpoint. `StatusBar.tsx:299-306` records the original removal: *"It duplicated the composer's hint row — on a 110x24 terminal both were on screen at once."* Fixed in §3.2.2: the row carries the phrase and nothing else, which also deletes the three-tier width ladder. |
| **P1-2** | §4.1, §6 | **`config/load.ts` is missing from the change plan, and `CliConfig` is missing from the data model.** `load.ts` is the only place `pick(flags, env, file)` resolves into the effective config (`load.ts:510-512` for the sibling `thinkingLevel`, returned at `:644`), and `App` reads `cfg.showThinking` — where `cfg` is a `CliConfig` (`schema.ts:1176`), not a `PersistedConfig`. Without both, `--show-thinking` and `ARAGON_SHOW_THINKING` are parsed and then dropped on the floor, and `showThinking` never reaches `initialViewState`. DoD #1 forbids touching a file outside §6, so the plan as written blocks its own implementation. Fixed in §4.1 and §6. |
| **P1-3** | §3.3.5, §6 | **The store's ownership is unbuildable as written, and contradicts §6.** `createBuiltinTools` is called from `agent/controller.ts:335` and `team/subagent.ts:152` — **never from `cli.tsx`**, so "created in `cli.tsx` beside `createBuiltinTools`" describes a place that does not exist. Separately, §6 lists `team/**` as *explicitly not touched*, which means subagents never receive `recordChange`, which means a child's write can never enter the store — so D-13's owner segment and R-5's "leak from subagent writes" both describe a situation this round cannot produce. Fixed in §3.3.5 (the controller owns the store), D-13 and R-5 (re-scoped to what is actually built), and a note that `recordChange` must be added to `BuiltinToolsOptions` **and** `ToolDeps`, since `tools/index.ts:364` builds the latter from the former. |
| **P1-4** | §3.3.4, AC-17 | **AC-17 is false for the most common input.** `renderUnifiedDiff` runs at `CONTEXT_LINES = 2` (`tools/diff.ts:10`) and `fs-tools.ts:168` passes no `context` override, while `PATCH_LIMITS.context` is 3. A single-region edit — the overwhelmingly common case — would therefore gain **two context rows plus one `@@` header**, i.e. the model-facing text *grows*. "less than or equal to ... for every input" is not a criterion this design meets. Fixed in §3.3.2/§3.3.4 (the text renderer honours `options.context`, default 2, so the single-hunk case is today's rows plus one header) and in a restated AC-17. |
| **P1-5** | §5.3 | **The on-disk arithmetic is off by roughly an order of magnitude, and the mitigation is the wrong one.** `DEFAULT_TRANSCRIPT_RETAIN = 1000` (`schema.ts:162`). At v1's own ~20 KB per saturated patch that is **~20 MB**, not "low single-digit megabytes" — and `saveSession` also writes `messages`, which already carries the diff a third time. The real observation v1 missed is cheaper than any budget change: when a patch is present, `ToolCard` renders `DiffView` and **never reads `preview`**, and for `edit_file` the preview *is* the same diff as text. Fixed in §3.3.7/§5.3: a tool entry carries a patch **or** a full preview, not both. |
| **P1-6** | §3.1.4, §6 | **Two call sites the plan does not name, both silent when missed.** (a) `Transcript.tsx:405` calls `estimateEntryRows(entry, cols, density, expanded)` with four arguments. Left alone it takes the new `thinkingVisible = true` default while thinking is hidden, over-estimating **every** assistant entry by `1 + wrappedRows(thinking)` — hundreds of rows at `thinkingLevel: high`. "An over-estimate is the safe direction" is a statement about *small* errors; at this magnitude the spacers, `totalRows` and the `↑N` off-bottom counter are all wrong and `selectWindow` mounts almost nothing. (b) `EntryViewImpl` (`Transcript.tsx:191-201`) hands `AssistantEntry` explicit scalar props, so the marker cannot see `thinkingMs` unless `Transcript.tsx` passes it — and §6's intent line for that file mentions only `patch`. Fixed in §3.1.4, §3.3.7 and §6. |
| **P1-7** | §3.2.3 | **`runStartedAt.current` is read one frame before it is written.** The elapsed effect runs *after* the render that first sees `status === 'running'`, so the first frame of every run reads a stale (or zero) ref, picks a phrase from the wrong seed, and jumps on the next tick — a visible flicker at the start of every single run. `Transcript.tsx:478-487` is this tree's own precedent for the render-phase ref update that fixes it. Fixed in §3.2.3. |

### P2 — noted; the ones that change a sentence are fixed, the rest are for the implementer

| ID | Section | Note |
|---|---|---|
| P2-1 | §6 | `SettingsValues` already has **twelve** keys (`SettingsScreen.tsx:31-59`), so `showThinking` is the thirteenth, not "a sixth". The ripple is real; the count was wrong. *Fixed in §6.* |
| P2-2 | §3.4 | `ToolCard`'s body is gated on `showBody = previewLines.length > 0 && (...)` (`ToolCard.tsx:147`). The patch branch sits **inside** that box, so the guard has to widen to `(previewLines.length > 0 || !!patch)` or a patch with a suppressed preview (P1-5) renders nothing. *Fixed in §3.4.* |
| P2-3 | AC-8 | "byte-identical" cannot be literally true once a settled turn grows a `thought for Ns` row. It means *no activity row and no extra blank row*. *Fixed in AC-8.* |
| P2-4 | AC-15, §7.3 | `Ctrl+O` toggles **only the most recent** `tool`/`team` entry (`App.tsx:1226-1229`, and `README.md:143` says so). AC-15 and manual row 5 should name that, or they will be read as a per-card affordance. *Fixed.* |
| P2-5 | §3.2.3 | `!overlayNode` is justified by the full-screen branch replacing the viewport (`App.tsx:1487-1491`). Inline overlays are part of the document flow (`App.tsx:1530`), so the suppression is unmotivated there — harmless, but the stated reason only covers one of the two branches. |
| P2-6 | §3.2.1 | `Math.floor(startedAt / 1000)` gives two runs starting inside the same second the same opening word, so "two consecutive runs do not both open on the same word" holds only for runs more than a second apart. Acceptable; the sentence overstates it. |
| P2-7 | §3.3.3 | Stripping a trailing `\r` from `PatchLine.text` also changes the **model-facing** text, because §3.3.4 renders the same rows. So "a single-region edit produces the same rows it does today" is exact only for LF files. Harmless (it removes control characters), but it is a second change to the model's input, not zero. |
| P2-8 | D-5 | The `esc abort` affordance exists in **both** branches — `Composer.tsx:68` in full-screen and `PromptInput.tsx:442-443` (`Type to steer the run, Esc to abort…`) in inline. D-5's premise is sound in both; its citation covers one. *Fixed in D-5.* |
| P2-9 | §3.3.7 | `ToolCard` is `React.memo` with the **default** comparator (`ToolCard.tsx:201-206`), so a `patch` prop is only free while the object is referentially stable. It is, because the reducer writes it once at `toolExecEnd` and `mapEntry` preserves identity for untouched entries — but that is now a load-bearing invariant and should be written down. *Fixed in §3.3.7.* |
| P2-10 | §4.1 | `config/env.ts:7-14` carries a header comment enumerating every `ARAGON_*` variable. It is documentation the file maintains by hand, so it needs the new name too. *Fixed in §4.1.* |
| P2-11 | §3.3.1 | The ASCII scan in `glyphs.test.ts` walks **all** of `src/` (`walk(SRC)`, skipping only `__tests__/`), not just `src/ui/**`. v1 reaches the right conclusion for `patch.ts` by a narrower argument than the guard actually uses. *Fixed in §3.3.1.* |

---

## 0. What this round is, and what it is not

The requirement is a presentation change to what a user watches while the agent
works:

1. **Thinking is not shown** unless the user turns it on in settings.
2. **Tool execution and file modification are always shown.**
3. **File modifications show a diff.**
4. **While the model is thinking, show a short, characterful status line**
   instead of the raw reasoning.
5. Beautiful, calm, and robust — no regressions in the layout engine, the render
   governor, or the session format.

This round changes **what the terminal draws**. It does not change the engine,
the provider adapters, the tool contracts in `@aragon-agent/core`, the
WebSocket-free architecture, or the shape of a saved session file. Every change
below is additive, defaults are chosen so that a feature that is off costs zero
rows and zero allocations, and each of the four workstreams can be reverted on
its own.

Four workstreams, in dependency order:

| ID | Workstream | One-line intent |
|----|------------|-----------------|
| **W1** | Quiet thinking | `showThinking` config key, default off, with an in-place reveal affordance |
| **W2** | Activity line | One row above the composer while a run is in flight: phrase, elapsed, tokens |
| **W3** | Patch model | A structured `FilePatch` produced by `write_file` / `edit_file`, carried to the UI on a CLI-local side channel |
| **W4** | Diff rendering | `DiffView` — line-numbered, colored, hunk-aware, collapsible |

W1 and W2 are independent of each other. W4 depends on W3. Nothing depends on W1.

---

## 1. Overview

### 1.1 The shape of the problem

The CLI already renders a competent transcript: per-tool cards with status
badges and durations (`ui/entries/ToolCard.tsx`), a colored diff renderer for
`edit_file` (`ui/entries/ToolPreview.tsx:152`), a status bar with a context
gauge, and a virtualized transcript with a measured-height cache. What it gets
wrong is **the ratio of noise to signal during a run**, in three specific
places.

**Thinking dominates the screen.** `initialViewState()` seeds
`thinkingVisible: true` (`agent/reducer.ts:301`), so every reasoning token the
provider emits is streamed into the transcript, clamped only to the last 24 rows
while streaming (`ui/entries/AssistantEntry.tsx:122`). On a model with
`thinkingLevel: high` this is the majority of everything the user ever sees, and
it scrolls the actual answer and the actual tool calls off the top of the
viewport. The user's real question during a run is "what is it doing and is it
stuck", and raw chain-of-thought answers that question badly: it is long,
repetitive, and written for the model rather than for a person.

**There is nothing to look at while the model thinks.** Between `turn_start` and
the first `text_delta` or `tool_call_start` there can be twenty seconds of
silence. Today the only motion is a braille spinner used as the assistant's role
marker (`ui/Transcript.tsx`, `animate` branch) and an elapsed counter in the
right cluster of the status bar. Take thinking off the screen — which W1 does —
and that gap becomes *completely* blank. Removing the reasoning firehose without
putting something honest in its place would make the tool feel dead, which is a
worse failure than the noise it fixes. The two changes are one change.

**A file modification does not look like a file modification.** `edit_file`
renders a diff, but the diff comes from `renderUnifiedDiff`
(`tools/diff.ts:19`), which is explicitly "not a full Myers diff": it trims the
common prefix and suffix and renders *everything in between* as one removed
block followed by one added block. For a `replace_all` that touches line 40 and
line 900, that is 860 lines of "removed" followed by 860 lines of "added",
almost all of them identical. There are no line numbers, no hunks, and no `+N
-M` summary. `write_file` is worse: its preview is a single line, `+ wrote
<path> (<n> B)` (`ui/entries/ToolPreview.tsx:160`), so creating a 300-line file
— the single most consequential thing an agent does — is reported as a byte
count. And because the diff text is also the *model-facing* tool result
(`tools/fs-tools.ts:169`), the only bound on it is the executor's 100 KB
truncation backstop (`core/src/tools/executor.ts:35`): a wide `replace_all` can
spend roughly 25k tokens describing a change in the least informative possible
layout.

### 1.2 The shape of the fix

**W1 — thinking becomes opt-in, and leaves a footprint.** A new top-level
config key `showThinking` (default `false`) seeds `ViewState.thinkingVisible`.
`Ctrl+T` keeps working exactly as it does today, as the session-scoped toggle.
Crucially, a settled assistant entry that *had* thinking renders one muted row
in its place — `* thought for 12s - ctrl+t to show` — so the user always knows
reasoning happened, how long it took, and how to see it. Hiding information
without saying that it exists is how a "clean" UI becomes a dishonest one; this
row is the whole difference.

**W2 — one row of live status, and not one word more.** While
`state.status === 'running'`, a new `ActivityLine` renders immediately above the
composer:

```
  * Percolating...
```

The phrase rotates every four seconds from a fixed ASCII list. It is driven by
the **existing** 200 ms elapsed ticker (`ui/App.tsx:666`), which already runs
only while a run is in flight — no new timer, no new state, and an idle frame
that is unchanged from today.

**The row carries the phrase and nothing else, and that is the whole of its
design (P1-1).** Everything a numeric cluster there would say is already on
screen, one row below the composer and updated by the same ticker:
`StatusBar.tsx:294-298` renders `formatDuration(elapsedMs)` *only while running*,
and `:292` renders the token cluster at `cols >= 72` — the very breakpoint v1
picked for its own. Two clocks two rows apart is the failure `StatusBar.tsx:299`
records the fix for: the keybinding cluster that used to live in the bar was
deleted in v0.4.0 because *"it duplicated the composer's hint row — on a 110x24
terminal both were on screen at once"*. The line also does **not** repeat
`esc abort`, which both composers already carry while running (`Composer.tsx:68`
in full-screen, `PromptInput.tsx:442-443` in inline).

What is left is the one thing the bar cannot say: **that the silence is
work**. The bar shows *state*; this row shows *life*.

**W3 — the diff becomes data, and the data has an owner.** `edit_file` and
`write_file` build a `FilePatch`: a real hunk list with old/new line numbers,
add/remove counts, and explicit budgets. The patch travels to the UI on a
CLI-local, bounded, owner-scoped `FileChangeStore` keyed by tool call id — not
through the tool result text — so **the number of tokens the model spends does
not grow at all**. It shrinks: the model-facing text gets a `MODEL_DIFF_MAX_CHARS`
budget it does not have today.

**W4 — the patch renders like a diff.** `DiffView` draws a `+6 -5` summary, then
hunk-separated rows with a right-aligned line-number gutter, `+`/`-`/space sign
column, and `theme.diff` colors. It collapses at 12 rows behind the *existing*
`Ctrl+O` expansion (`ui/App.tsx:1222`) — no new keybinding. When a patch is
absent (a resumed session written by an older build, or an evicted store entry)
the current text renderer is the fallback, so nothing ever renders blank.

### 1.3 Non-goals

- **Streaming tool output.** A `bash` card still shows its result when the
  command finishes. Core's `ToolExecutionContext.onProgress` exists, but no
  builtin tool emits progress, and wiring live stdout into a virtualized,
  height-cached transcript is a separate round with its own governor risk.
- **Syntax highlighting inside diffs.** `theme.code` exists and `Markdown.tsx`
  uses it, but per-language tokenization inside a diff row is a large dependency
  or a large regex, and neither belongs in this round.
- **Word-level (intra-line) diff highlighting.** Line granularity only.
- **Changing headless/print mode.** `agent/headless.ts` never printed thinking
  and prints no cards; it is untouched.
- **Changing the engine's event stream.** No new `AgentEvent`, no `StreamEvent`,
  no change to `packages/core`.
- **A second reveal surface for thinking.** No `/thinking show` subcommand — see
  D-3.

---

## 2. Evidence — what the tree contains today

Read these before implementing; several of them are load-bearing constraints
rather than context.

| Fact | Where | Why it constrains this round |
|---|---|---|
| `thinkingVisible: true` is hard-coded in the initial state | `agent/reducer.ts:301` | W1's seed must be a parameter, not a post-mount dispatch, or `/resume` flashes a restored thinking block on frame 1 |
| `Ctrl+T` dispatches `toggleThinking` and nothing else | `ui/App.tsx:1217` | The key already exists and is already documented (`HelpOverlay.tsx:30`, `README.md:142`); W1 changes its *starting position*, not its meaning |
| `AssistantEntry` returns `null` when there is no text, no thinking, and no streaming | `ui/entries/AssistantEntry.tsx:63` | The collapsed marker must live inside the existing `hasThinking` branch so that guard stays correct |
| Every non-ASCII character under `src/ui/**` must come from `pickGlyphs` | `ui/glyphs.ts` header; enforced by `glyphs.test.ts` | New glyphs go in **both** tables. A literal in `ActivityLine.tsx` fails the build — correctly |
| `entryRevision` must change whenever rendered output changes (I-L3-1) | `ui/layout/virtual-window.ts:59` | Adding `patch` to a tool entry and `thinkingMs` to an assistant entry means both switches change |
| `estimateEntryRows` and `entryRevision` are two switches in one file; updating one and not the other yields scroll drift with no error (RV-13) | `ui/layout/virtual-window.ts:195` | Both switches, every time |
| The elapsed ticker already runs at 200 ms and only while running | `ui/App.tsx:658-668` | W2 needs no timer of its own |
| The ref the effect assigns is written AFTER the first running frame renders; `Transcript` already updates refs during render for exactly this reason | `ui/App.tsx:664`, `ui/Transcript.tsx:478-487` | `runStartedAt` must be seeded in render scope, or every run opens on the wrong phrase for one frame (P1-7) |
| The composer's running hint already says `esc abort`, in both branches | `ui/Composer.tsx:68`, `ui/PromptInput.tsx:442-443` | W2 must not repeat it |
| **`viewportRows()` is the ONE function that says how many rows the viewport gets, and it enumerates `header + toast + composer + status`** | `ui/layout/budget.ts:26-59` | A new bottom-chrome row that is not in this function is a row stolen from the transcript with nothing reporting it (P0-1) |
| The full-screen root is `height={frameHeight(rows)}` + `overflow="hidden"`, and the viewport box is its only `flexShrink={1}` child | `ui/layout/AppShell.tsx:98-129` | Extra chrome does not grow the frame; it shrinks the transcript |
| **`ToastStack` occupies exactly one row in full-screen, always, an empty one when idle — "rendering conditionally would make the viewport height jump every time a toast appears or expires"** | `ui/ToastStack.tsx:5-10, 60-76` | The rule W2 must obey, and the already-budgeted row W2 can share (P0-1) |
| The status bar already renders the elapsed clock **only while running**, and the token cluster at `cols >= 72` | `ui/StatusBar.tsx:292, 294-298` | The activity row must not carry a second clock or a second token count (P1-1) |
| The status bar's hint cluster was deleted in v0.4.0 for being on screen at the same time as the composer's | `ui/StatusBar.tsx:299-306` | The precedent D-5 invokes — and the one P1-1 applies to W2's own numbers |
| **`<Static>` cannot un-print or re-print a settled entry, and the settled boundary is held monotonic** | `ui/Transcript.tsx:9-10, 478-487` | In inline mode `Ctrl+T` cannot reach a settled entry, so the collapsed marker's copy must be mode-aware (P0-2) |
| `createBuiltinTools` is called from the controller and from `buildSubagentTools` — never from `cli.tsx` — and builds `ToolDeps` itself from its options bag | `agent/controller.ts:335`, `team/subagent.ts:152`, `tools/index.ts:364` | The store's owner is `AgentController`; `recordChange` needs a field in `BuiltinToolsOptions` *and* in `ToolDeps` (P1-3) |
| `renderUnifiedDiff` defaults to **2** context lines and `edit_file` passes no override | `tools/diff.ts:10, 24`, `tools/fs-tools.ts:168` | `PATCH_LIMITS.context = 3` would silently widen the model-facing diff; the text renderer must honour `options.context` (P1-4) |
| `pick(flags, env, file)` resolves into `CliConfig` in `config/load.ts`, and `App` reads `cfg.*` | `config/load.ts:510-512, 644-647`, `config/schema.ts:1176+` | `showThinking` needs `CliConfig` and `load.ts`, not only `PersistedConfig` (P1-2) |
| `DEFAULT_TRANSCRIPT_RETAIN` is **1000** | `config/schema.ts:162` | §5.3's footprint arithmetic is bounded by this number, not by a small one (P1-5) |
| `ToolCard` renders its body only when the stored preview is non-empty, and is `React.memo`'d with the DEFAULT comparator | `ui/entries/ToolCard.tsx:147, 201-206` | The patch branch must widen that guard, and the patch object must be referentially stable (P2-2 / P2-9) |
| `glyphs.test.ts`'s ASCII scan walks **all** of `src/`, skipping only `__tests__/` | `__tests__/glyphs.test.ts` (`walk(SRC)`) | `tools/patch.ts` is in scope for the scan too, not merely by analogy (P2-11) |
| A key in `CONFIG_SET_KEYS` but missing from the `switch` writes nothing and still prints `Set <key> = <value>` (P1-2) | `cli.tsx:559` and the switch below it | `showThinking` must be added in **both** places |
| A new `SettingsValues` key forces `max-tokens-ui.test.tsx` to change (IF-H2) | `packages/cli/src/__tests__/max-tokens-ui.test.tsx` | Budget it into the change plan |
| The settings label column is `.padEnd(18)`; a longer label silently pushes its own value out of the column (IF-H7) | `ui/overlays/SettingsScreen.tsx` | `Show thinking` is 13 characters |
| `classifyDiffLine` already treats a leading `@@` as `meta` | `ui/entries/ToolPreview.tsx:29` | The text fallback renders hunk headers correctly the day W3 starts emitting them |
| Tool results are truncated at 100 KB by the executor, and nowhere earlier | `core/src/tools/executor.ts:35` | The model-facing diff is effectively unbounded today |
| `buildToolPreview` caps the stored preview at 8000 chars / 200 lines | `agent/reducer.ts:407` | The patch budget is set to match, so a patch cannot cost more than the preview beside it |
| `normalizeLoadedEntries` forces every "live" flag off on load | `session/persist.ts:94` | A `FilePatch` is immutable and settled by construction, so it needs no clause there — see D-9 |

---

## 3. Technical design

### 3.1 W1 — thinking is hidden by default, and says so

#### 3.1.1 The seed

`initialViewState` gains an optional seed:

```ts
export interface ViewStateSeed {
  /** Start with thinking blocks expanded. Defaults to FALSE, the product default. */
  thinkingVisible?: boolean;
}

export function initialViewState(seed: ViewStateSeed = {}): ViewState {
  return {
    // ...
    thinkingVisible: seed.thinkingVisible ?? false,
    // ...
  };
}
```

**The default is `false`, not `true`, and that is the whole safety argument.**
There is exactly one production call site (`App`'s `useReducer`), and it passes
`cfg.showThinking`. Every other caller is a test. If a future call site forgets
the seed it fails *closed* — the user sees the product default — rather than
silently restoring the firehose for one code path with nothing reporting it.

The existing tests that assert a thinking block renders must pass
`initialViewState({ thinkingVisible: true })` or dispatch `toggleThinking`.
That is a deliberate, one-time, mechanical cost, and it is the cheapest place in
the system to pay it.

#### 3.1.2 Thinking duration

`Entry(kind: 'assistant')` gains two optional fields:

```ts
thinkingStartedAt?: number;  // epoch ms, set by `thinkingStart`
thinkingMs?: number;         // wall-clock, sealed once
```

Reducer changes, all in `viewReducer`:

- `thinkingStart` — additionally sets `thinkingStartedAt: Date.now()` when the
  entry does not already have one. The reducer already calls `Date.now()` for
  the retry card's `startedAt` (`reducer.ts:1288`), so this introduces no new
  impurity class.
- `textDelta` — when the target entry has `thinkingStartedAt` and no
  `thinkingMs`, seal `thinkingMs = Date.now() - thinkingStartedAt`. **First text
  delta only**: thinking is over the moment the answer starts, and re-sealing on
  every delta would make the number climb with the answer's length.
- `turnEnd` and `runEnd` — seal `thinkingMs` the same way if it is still unset,
  which is the case for a turn that thought and then called a tool without
  emitting any text.
- `streamRestart` — clears both fields alongside `thinking` and `text`, which it
  already resets (`reducer.ts:1339`). A restarted stream re-thinks from scratch;
  carrying the old clock forward would report a duration for reasoning that was
  discarded.

#### 3.1.3 The collapsed marker

`AssistantEntry` gains one branch and one prop pair (`thinkingMs`, `revealable`).
In full:

```tsx
{hasThinking && thinkingVisible && ( /* ...existing expanded block, unchanged... */ )}

{hasThinking && !thinkingVisible && !streaming && (
  <Text wrap="truncate" color={theme.muted}>
    {glyphs.thinking} thought{thinkingMs !== undefined ? ` for ${formatDuration(thinkingMs)}` : ''}
    {revealable ? ` ${glyphs.midDot} ctrl+t to show` : ''}
  </Text>
)}
```

Four rules, each of which is a decision rather than a detail:

1. **`!streaming` is required.** While the run is live, the activity line (W2)
   is the live surface. A second live marker inside the transcript would
   duplicate it and would also keep the entry off `<Static>`.
2. **The duration is omitted when unknown** rather than printed as `0s`. A
   restored session written by an older build has no `thinkingMs`, and `thought
   for 0s` is a lie where `thought` is merely terse.
3. **`ctrl+t` is spelled in the row** *when pressing it would do something*.
   This replaces the discoverability the visible block provided for free, and it
   is why W1 needs no one-shot startup notice (D-4).
4. **`revealable` is `mode === 'fullscreen'`, and the reason is `<Static>`
   (P0-2 / D-16).** In inline mode a settled entry has already been printed into
   Ink's `<Static>`, which *cannot un-print or re-print* — `Transcript.tsx:9-10`
   states it, and the settled boundary is held monotonic precisely so an entry
   never flows back out. `toggleThinking` updates `ViewState`, `<Static>` ignores
   it, and the printed row stands. Today that costs nothing, because thinking is
   visible by default and the body is already in the terminal's scrollback; after
   the flip the body is never printed there **at all**, so a row reading
   `ctrl+t to show` would be an instruction that provably does nothing.

   The row therefore degrades in inline mode to `* thought for 12s` — still
   honest that reasoning happened and how long it took, which is the whole
   argument of §1.2, and silent about a key that cannot deliver. Full-screen —
   the default whenever the terminal is a TTY of a workable size
   (`layout/frame.ts:70-83`) — keeps the full row and the full promise, because
   `TranscriptList` has no `<Static>` at all and re-renders from `entries` on
   every toggle.

   `Ctrl+T` still works in inline mode for the **live** entry and for every
   entry produced after the toggle; what it cannot do is rewrite scrollback.
   §4.2 makes the toast say which of the two happened.

#### 3.1.4 Height accounting

Both switches in `ui/layout/virtual-window.ts` change:

```ts
// entryRevision, case 'assistant' — `thinkingMs` is O(1) and changes the row.
return `a${entry.text.length}.${entry.thinking?.length ?? 0}.${entry.streaming ? 1 : 0}.${
  entry.aborted ? 1 : 0}.${entry.thinkingMs ?? -1}`;

// estimateEntryRows — a fifth parameter, defaulting to the CONSERVATIVE value.
export function estimateEntryRows(
  entry: Entry, cols: number, density: DensityMode, expanded: boolean,
  thinkingVisible = true,
): number { /* ... */ }
```

In the `assistant` case the thinking term becomes:

```ts
const thinking = !entry.thinking
  ? 0
  : thinkingVisible
  ? 1 + wrappedRows(entry.thinking, usable)
  : entry.streaming ? 0 : 1;   // the collapsed marker is exactly one row
```

**The default is `true` because this function owes its caller an upper bound.**
The file states the asymmetry outright (`virtual-window.ts:152`): an
over-estimate makes the scroll position conservative and self-corrects on the
next measurement, while an under-estimate can put the newest output below the
bottom of a viewport the user believes is pinned. A forgotten call site must
therefore land on the over-estimating side. `thinkingVisible` is already carried
into `heightKey` through `flags` (`virtual-window.ts:114`), so the cache key
needs no change.

**THE DEFAULT IS THE FAIL-SAFE, NOT THE PLAN (P1-6a).** There is exactly one
production call site — `Transcript.tsx:405`, inside `TranscriptList`'s
`heightOf` — and it **must** pass `thinkingVisible`, which it already holds as a
prop. Leaving it at four arguments is not "safely conservative": with thinking
hidden by default, the estimate for *every* assistant entry that thought would
be inflated by `1 + wrappedRows(entry.thinking, usable)`, which at
`thinkingLevel: high` is hundreds of rows against a real height of one. The
self-correction argument does not rescue it, because an entry is only ever
measured once `selectWindow` mounts it, and an entry estimated at 400 rows is
exactly the one that never gets mounted. `totalRows`, both spacers, the scroll
horizon and the status bar's `↑N` off-bottom counter would all be wrong for the
rest of the session, and nothing anywhere would report it. The direction of the
error is safe; this magnitude of it is not. `virtual-window.test.ts` gets a case
that fixes the collapsed marker's estimate at one row (AC-19).

---

### 3.2 W2 — the activity line

#### 3.2.1 The phrases

New pure module `src/ui/activity-phrases.ts`. No React, no Ink, no clock.

```ts
/** Rotation cadence. Long enough to read, short enough to prove liveness. */
export const PHRASE_ROTATE_MS = 4_000;

/**
 * ASCII ONLY, by the rule this tree is under (`glyphs.ts` header). Present
 * participles, so the line reads as an action in progress; 12 characters or
 * fewer so the row never fights the elapsed and token clusters for columns.
 */
export const ACTIVITY_PHRASES: readonly string[] = [
  'Assembling', 'Brewing', 'Calibrating', 'Cogitating', 'Composing',
  'Computing', 'Concocting', 'Conjuring', 'Considering', 'Crunching',
  'Distilling', 'Divining', 'Drafting', 'Excavating', 'Fathoming',
  'Fermenting', 'Finessing', 'Foraging', 'Germinating', 'Herding',
  'Incubating', 'Inferring', 'Marinating', 'Meandering', 'Mulling',
  'Musing', 'Noodling', 'Percolating', 'Pondering', 'Puzzling',
  'Ruminating', 'Scheming', 'Sculpting', 'Simmering', 'Sketching',
  'Spelunking', 'Steeping', 'Stitching', 'Summoning', 'Tinkering',
  'Unfurling', 'Untangling', 'Weaving', 'Whittling', 'Wrangling',
];

/**
 * The phrase for a run at a moment. PURE and TOTAL: same inputs, same word,
 * for any finite numbers, including a `now` before `startedAt`.
 *
 * The run's start seeds the sequence so two consecutive runs do not both open
 * on the same word — which is what makes the line read as alive rather than as
 * a fixed label.
 */
export function pickActivityPhrase(
  startedAt: number, now: number, rotate = true,
): string {
  const seed = Math.floor(startedAt / 1000);
  const step = rotate ? Math.floor(Math.max(0, now - startedAt) / PHRASE_ROTATE_MS) : 0;
  const n = ACTIVITY_PHRASES.length;
  return ACTIVITY_PHRASES[(((seed + step) % n) + n) % n]!;
}
```

`rotate = false` is the reduced-motion path: the phrase is chosen once for the
run and then holds. Rotating text is motion, and a user who asked for
`reducedMotion` asked for the screen to stop changing under them; degrading only
the spinner and leaving a word that swaps every four seconds would honor the
letter of the setting and not its point.

#### 3.2.2 The component

New `src/ui/ActivityLine.tsx`. Exactly one row, `wrap="truncate"`, `flexShrink={0}`.

```tsx
export interface ActivityLineProps {
  /** Epoch ms the current run began — the phrase sequence's seed. */
  startedAt: number;
  /** `Date.now() - startedAt`, already computed by App's 200 ms ticker. */
  elapsedMs: number;
  reducedMotion: boolean;
  theme: Theme;
  caps: TermCapabilities;
}
```

Rendered, at every width:

```
  <spin> <Phrase>...
```

- **No `elapsed` cluster and no token cluster, at any width (P1-1).** Both are
  already on screen while running, two rows away, driven by the same ticker:
  `StatusBar.tsx:294-298` renders `formatDuration(elapsedMs)` under exactly the
  `running` condition that mounts this row, and `:292` renders the token cluster
  at `cols >= 72` — the same breakpoint v1 chose for its own. Repeating them is
  the failure the v0.4.0 hint-cluster removal was for, recorded in that file at
  `:299-306`, and the failure D-5 invokes to keep `esc abort` off this row. A
  design cannot cite a rule for one string and break it for two numbers.
- Because there are no clusters there is **no width ladder**: one row, one
  truncating `<Text>`, identical at 200 columns and at 40. The narrow-terminal
  acceptance criterion (AC-10) becomes trivially true instead of being pinned by
  three breakpoints.
- `<spin>` is `<Spinner type="dots" />` when `caps.unicode && !reducedMotion`,
  otherwise `glyphs.spinnerStill`. This is the identical branch
  `ui/Transcript.tsx:187` uses for the assistant role marker, and it must stay
  identical — braille dots are both an animation *and* a Unicode-only glyph.
- `...` is `glyphs.ellipsis`, not a literal.
- The phrase is `theme.thinking`, the only non-muted thing on the row, because
  it is the only thing on it.
- `cols` is **not** a prop. Nothing on the row depends on width, and a prop that
  changes on every resize but is never read would be a false dependency on a
  memo boundary.

#### 3.2.3 Mounting

**The row is not a new slot in the full-screen frame. It shares the toast row
(P0-1 / D-17).**

The naive design — a new `activity` slot above `toast` in both branches — is
wrong in the branch that has a frame, and wrong in a way nothing reports. In
full-screen, `AppShell`'s root is `height={frameHeight(rows)}` with
`overflow="hidden"`, the bottom chrome box is `flexShrink={0}` and the viewport
box is the **only** `flexShrink={1}` child (`AppShell.tsx:98-129`). An extra
chrome row therefore does not make the frame taller; Yoga takes the row out of
the transcript. Meanwhile `viewportRows()` — which `budget.ts:1-19` names as
*"the ONE function that says how many rows the viewport gets"* — still returns
the old number, and `ScrollViewport`, `selectWindow`'s spacers, `overlayMaxRows`,
`popupMaxRows` and `todoRailRows` all still size against it. The transcript would
draw one row shorter than every consumer believes, **only while a run is in
flight**, so the layout would shift on submit and shift back on `agent_end`.

`ToastStack.tsx:5-10` already legislates this, for itself, in the general form:

> In `fullscreen` this ALWAYS occupies exactly one row — an empty row when there
> is nothing to say. Rendering conditionally would make the viewport height (and
> therefore the whole transcript) jump every time a toast appears or expires.
> There is deliberately no `rows` threshold: jitter is a layout property, not a
> space property.

A run starts and ends far more often than a toast appears and expires, so the
activity line is the *stronger* case for that rule, not an exception to it.

So `toast` becomes the **bottom status row**, and the two occupants are mutually
exclusive with a stated precedence:

```tsx
// AppShell: unchanged. No new slot, no new prop, no change to `budget.ts`.
// App:
toast={
  <BottomStatusRow
    mode={mode}
    toasts={state.toasts}
    activity={showActivity ? <ActivityLine {...} /> : null}
    theme={theme}
  />
}
```

- **Full-screen**: exactly one row, always, as today. A toast wins it (a
  transient ack is a *response to the user*, and v1 already argued the row
  nearest the input belongs to it); otherwise the activity line; otherwise the
  blank `<Text> </Text>` that is there today. `chromeBudget` is untouched,
  `viewportRows` returns the same number it does now, and the frame height is
  invariant across the whole run lifecycle. **`budget.ts` is therefore not in the
  change plan, and that is the point.**
- **Inline**: no frame, no budget, so nothing to protect — `ToastStack`'s inline
  branch is already a conditional 0–3 row stack, and the activity line is simply
  one more conditional row above it, rendered when there is no toast.

`showActivity` is `state.status === 'running' && !overlayNode`. `!overlayNode`
suppresses the line while an overlay owns the screen: the full-screen branch
replaces the whole viewport with the overlay (`App.tsx:1487-1491`), and a working
line under a settings screen is noise attached to a surface the run is not
visible on. (In inline mode overlays are part of the document flow, so the
suppression is conservative rather than necessary — P2-5.)

**`runStartedAt` is seeded in render scope, not in the effect (P1-7).**

```tsx
// Render scope, immediately before the `activity` node is built.
// The effect at App.tsx:658 runs AFTER this render, so a ref it assigns is one
// frame late — and the first frame of a run is exactly when the phrase is
// chosen. `Transcript.tsx:478-487` updates `highWater` / `prevLen` during
// render for the same reason: a value derived from a transition is needed by
// the very render that observes the transition.
const running = state.status === 'running';
if (running && runStartedAt.current === 0) runStartedAt.current = Date.now();
if (!running && runStartedAt.current !== 0) runStartedAt.current = 0;
```

Without this the ref holds `0` on the first run (seed `0`, an arbitrary word) and
the *previous* run's start on every run after, so every run opens on a wrong
phrase for one frame and then jumps — a flicker at the start of every single
turn, which is the one moment this feature exists to make feel calm.

That is the entire wiring: no new effect, no new interval, no new reducer
action, no new `ViewState` field, and no new `AppShell` prop.

**Idle cost is zero rows and zero renders.** When `status !== 'running'` the
`activity` node is `null`, the elapsed effect has torn its interval down, and the
emitted frame is what it is today — in full-screen literally so, because the row
it would have added was already there and already blank.

---

### 3.3 W3 — the patch model, and where it comes from

#### 3.3.1 Types

New module `src/tools/patch.ts`. Pure, no I/O, no React, ASCII-only markers.
The ASCII rule is not an analogy to `PREVIEW_TRUNCATION_MARK` — `glyphs.test.ts`'s
static scan walks **all** of `src/` (`walk(SRC)`, skipping only `__tests__/` and
two exempt files), so this module is inside the guard rail directly (P2-11). The
substantive reason is the same one `reducer.ts:410-418` gives: strings produced
outside `src/ui/**` have no `TermCapabilities` in scope and must be safe on a
legacy `cmd.exe`.

```ts
export type PatchLineKind = 'ctx' | 'add' | 'del';

export interface PatchLine {
  kind: PatchLineKind;
  /** 1-based line number in the OLD file; absent on an `add`. */
  oldLine?: number;
  /** 1-based line number in the NEW file; absent on a `del`. */
  newLine?: number;
  /** Rendered text. A trailing CR is stripped; long lines are truncated. */
  text: string;
}

export interface PatchHunk {
  oldStart: number; oldCount: number;
  newStart: number; newCount: number;
  lines: PatchLine[];
}

export interface FilePatch {
  /** As the model wrote it — relative when the call was relative. */
  path: string;
  kind: 'create' | 'update';
  added: number;
  removed: number;
  hunks: PatchHunk[];
  /** Budget was hit; the tail of the change is not in `hunks`. */
  truncated: boolean;
  /**
   * Total rendered rows across every hunk (summary and separators excluded).
   *
   * PRECOMPUTED so `entryRevision` stays O(1) (I-L3-1 forbids hashing, and
   * summing `hunks[].lines.length` per entry per frame is the cost the height
   * cache exists to remove).
   */
  lineCount: number;
  /** Set when the old side could not be read: too large, binary, or unreadable. */
  degraded?: 'binary' | 'too-large' | 'unreadable';
}
```

#### 3.3.2 Budgets

`PATCH_LIMITS` lives in `src/tools/patch.ts` — the subsystem's own structural
authority, separate from `config/schema.ts`'s user-facing keys, which is the
convention every other subsystem here follows (`TEAM_LIMITS`, `TODO_LIMITS`,
`FAST_LIMITS`).

```ts
export const PATCH_LIMITS = {
  /**
   * Context rows kept either side of a change, FOR THE UI.
   *
   * The text renderer does NOT use this (P1-4): `renderUnifiedDiff` keeps its
   * own `CONTEXT_LINES = 2` default so the model-facing diff does not silently
   * widen. See §3.3.4.
   */
  context: 3,
  /** Hunks closer than this many context rows are merged into one. */
  mergeGap: 6,            // 2 * context
  /** Rendered rows a patch may carry, across all hunks. */
  maxLines: 200,
  /** Total characters across all `PatchLine.text`. Mirrors STORED_PREVIEW_CHARS. */
  maxChars: 8_000,
  /** A single row is truncated past this, with PREVIEW_TRUNCATION_MARK. */
  maxLineChars: 500,
  /** Above this cell count the LCS leaf is refused; the segment becomes a block replace. */
  lcsCellBudget: 160_000, // 400 x 400
  /** Recursion depth ceiling for the anchor split. */
  maxDepth: 32,
  /** Old-side bytes above which `write_file` does not read for a diff. */
  readMaxBytes: 2 * 1024 * 1024,
  /** Model-facing diff text ceiling — a bound `edit_file` does not have today. */
  modelDiffMaxChars: 4_000,
} as const;
```

`maxChars: 8000` is not an arbitrary round number: it is exactly
`STORED_PREVIEW_CHARS` (`agent/reducer.ts:407`). A patch therefore cannot make a
tool entry more than twice as expensive as it already is, in memory or in a
session file, and the two budgets move together if either is ever revisited.

#### 3.3.3 The algorithm

`buildPatch(oldText: string | null, newText: string, opts): FilePatch`

**Step 0 — split and normalize.** Split both sides on `\n`. If a side ends with
`\n`, drop the resulting trailing `''` (otherwise every file ends with a phantom
blank line). Record `oldEndsWithNewline` / `newEndsWithNewline`; when they differ,
append a final `ctx` line whose text is `(no newline at end of file)`. Comparison
uses the raw string including any `\r`; only `PatchLine.text` has a trailing
`\r` stripped, for rendering. A CRLF-to-LF conversion is therefore reported as a
change, which it is, and does not print control characters, which it must not.

**Step 1 — `oldText === null`** (`write_file` on a path that does not exist):
emit a single hunk of all-`add` lines, `kind: 'create'`, `removed: 0`. Skip
steps 2-4.

**Step 2 — trim.** Advance a common-prefix index and retreat a common-suffix
index. Everything outside becomes context candidates; only the differing middle
is diffed. Identical files short-circuit to zero hunks
(`added === removed === 0`).

**Step 3 — anchored split (patience).** On the middle range `(aLo,aHi,bLo,bHi)`:

```
diffRange(aLo, aHi, bLo, bHi, depth):
  if aLo > aHi and bLo > bHi:            return []
  if aLo > aHi:                          return all adds
  if bLo > bHi:                          return all dels
  if depth >= maxDepth:                  return blockReplace()

  anchors = lines occurring EXACTLY ONCE in a[aLo..aHi] and EXACTLY ONCE
            in b[bLo..bHi], paired by identity
  keep    = longest strictly-increasing subsequence of anchors by b-index
            (patience: binary-searched piles, O(k log k))

  if keep is empty:
      if (aHi-aLo+1) * (bHi-bLo+1) <= lcsCellBudget: return lcsDiff(...)
      return blockReplace()

  out = []
  for each consecutive pair of kept anchors (with virtual bounds at both ends):
      out += diffRange(<gap between them>, depth + 1)
      out += ctx(anchor)
  return out
```

`lcsDiff` is a textbook `O(n*m)` DP over the small leaf, back-tracked into
`ctx`/`del`/`add` rows. `blockReplace` is today's behavior — every old row as
`del`, then every new row as `add` — retained as the explicit, bounded fallback
so a pathological input degrades to what the tool already does rather than
hanging. **Every recursion path terminates in one of the three leaf returns**;
there is no path that recurses without shrinking the range.

**Step 4 — hunks.** Walk the resulting row list maintaining `oldLine` /
`newLine` counters. Open a hunk `context` rows before the first non-`ctx` row,
close it `context` rows after the last, and merge two hunks whose gap is
`<= mergeGap`. Fill each hunk's `oldStart/oldCount/newStart/newCount`.

**Step 5 — budgets.** Truncate any `text` longer than `maxLineChars`, appending
`PREVIEW_TRUNCATION_MARK`. Then drop whole hunks from the **tail** until both
`maxLines` and `maxChars` hold, setting `truncated: true` if anything was
dropped. Tail-first, because the top of a change is where a reader starts.
Finally compute `lineCount` and the `added` / `removed` totals — which are
counted **before** truncation, so the `+6 -5` summary always describes the real
change even when the body is clipped.

#### 3.3.4 `renderUnifiedDiff` is re-expressed on top of the patch

`tools/diff.ts` keeps its exported signature
(`renderUnifiedDiff(oldStr, newStr, options): string`), its `CONTEXT_LINES = 2`
default and its call site (`fs-tools.ts:168`), but is reimplemented as
`buildPatch` plus a text renderer:

```
--- <path>
+++ <path>
@@ -12,7 +12,8 @@
  unchanged
- old
+ new
```

The `---` / `+++` headers and the `  ` / `- ` / `+ ` row prefixes are exactly
what it emits today, so the fallback renderer needs no change: `classifyDiffLine`
already routes `@@`, `---` and `+++` to `meta` (`ToolPreview.tsx:29`), which is
direct evidence that hunk headers were anticipated when that function was
written. Output is capped at `modelDiffMaxChars` with a trailing
`... (diff truncated)` line.

**`buildPatch` takes the context width as an argument, and this renderer passes
`options.context ?? CONTEXT_LINES` — i.e. 2 (P1-4).** The UI passes
`PATCH_LIMITS.context` (3). One algorithm, two widths, chosen by the caller.
Collapsing them to a single constant is the tempting simplification and it is
wrong: `fs-tools.ts:168` passes no override, so `PATCH_LIMITS.context = 3` would
add two context rows to **every** model-facing diff, which is the direction v1's
own AC-17 forbids and which no test in §7 would have noticed.

**This is the one place the model's input changes, and the shape of the change
is now stated exactly.** For a single-region edit — the common case — the rows
are byte-identical to today's plus **one** `@@` header line, because the context
width is unchanged and step 2's trim already produced the same span. For a
multi-region edit the output is several small hunks instead of one span covering
everything between the first and last change: strictly less text, strictly more
information. The only other difference is that a trailing `\r` is stripped from
each rendered row, so a CRLF file's diff no longer carries control characters
into the prompt (P2-7). AC-17 is restated against those two allowances rather
than as an unconditional "never larger", which was not true.

#### 3.3.5 The side channel

New module `src/tools/file-change-store.ts`.

```ts
export interface FileChangeStore {
  record(owner: string, toolCallId: string, patch: FilePatch): void;
  /** Returns and REMOVES the patch. A patch is consumed exactly once. */
  take(owner: string, toolCallId: string): FilePatch | undefined;
  size(): number;
}

export function createFileChangeStore(cap = 64): FileChangeStore;
```

- **Keyed by `${owner}:${toolCallId}`.** `owner` is `'lead'` for the lead
  agent's toolset. See D-13 below for what this round does and does not do about
  subagents — the short version is that the segment is cheap insurance for a
  hazard the *next* round can create, not a fix for one this round has.
- **Bounded, FIFO.** At `cap` entries the oldest key is evicted. The cap is a
  ring, not a leak detector: nothing is ever retained longer than 64 writes, so
  a patch that is somehow never taken cannot accumulate.
- **Take-once.** `toolExecEnd` fires exactly once per call, and a patch that is
  not consumed there will never be consumed. Removal on read is what keeps a
  long session's store at a constant size regardless of how many files are
  edited. Note this makes `reduceEvent` *consume-once* rather than pure when a
  `PatchSource` is supplied; that is safe because `App.tsx:390-413` calls it
  exactly once per event and `mergeDeltas` only ever merges `textDelta` /
  `thinkingDelta`, never `toolExecEnd`.

**Ownership: `AgentController` creates and owns the store (P1-3).** v1 said
"created in `cli.tsx` beside `createBuiltinTools`", and there is no such place —
`createBuiltinTools` is called from `agent/controller.ts:335` and from
`team/subagent.ts:152`, and `cli.tsx:279` only constructs the controller. Putting
the store where the tools are built also removes a parameter from `cli.tsx`
entirely:

```ts
// AgentController constructor, beside the existing TeamRuntime / TodoStore wiring.
private readonly fileChanges = createFileChangeStore();

this.tools = createBuiltinTools({
  getCwd: () => this.cwd,
  // Pre-bound to the owner, so `fs-tools.ts` never learns what an owner is.
  recordChange: (id, patch) => this.fileChanges.record('lead', id, patch),
  // ...
});

/** Consumed once, by `reduceEvent` on `tool_execution_end`. */
takeFilePatch(toolCallId: string): FilePatch | undefined {
  return this.fileChanges.take('lead', toolCallId);
}
```

**`recordChange` needs a field in TWO interfaces, not one.** `BuiltinToolsOptions`
(`tools/index.ts:44`) is the factory's option bag; `ToolDeps` (`fs-tools.ts:20`)
is what the `make*` functions receive, and `tools/index.ts:364` builds it as
`const deps: ToolDeps = { getCwd: options.getCwd }`. Adding the field to
`ToolDeps` alone type-checks and forwards nothing — the tools would simply never
record, and every card would fall back to `ToolPreview` with no error anywhere.
Both files are already in §6's change plan; this note is why.

Omitting `recordChange` — every existing test, every headless run, and every
subagent this round — leaves the tools byte-identical to today, which is the
same opt-in shape `skillTools` / `planTools` / `todoTools` already use.

#### 3.3.6 Tool changes

**`edit_file`** (`fs-tools.ts:118`): after the successful `writeFile`, build the
patch from the `original` and `updated` strings it already holds, `record` it,
and return `Applied edit to ${path}:\n${renderUnifiedDiff(...)}` — the same
sentence, from the same data.

**`write_file`** (`fs-tools.ts:84`): before the write, best-effort read the old
content:

```
stat(target)
  ENOENT               -> oldText = null,  kind 'create'
  size > readMaxBytes  -> oldText = null,  degraded 'too-large'
  binary sniff fails   -> oldText = null,  degraded 'binary'
  otherwise            -> oldText = read,  kind 'update'
any throw              -> oldText = null,  degraded 'unreadable'
```

The binary sniff is the one `read_file` already uses (`fs-tools.ts:60`). **The
read is wrapped so that no failure can prevent or delay the write** — a
presentation feature must never be able to break the operation it presents. The
model-facing result stays exactly `Wrote ${bytes} bytes to ${path}`: zero extra
tokens.

#### 3.3.7 Carrying the patch into the view

`reduceEvent` gains an optional third parameter:

```ts
export interface PatchSource { take(toolCallId: string): FilePatch | undefined }

export function reduceEvent(
  event: AgentEvent, cost?: ModelCost, patches?: PatchSource,
): ViewAction[]
```

On `tool_execution_end` it attaches `patch: patches?.take(event.toolCallId)` to
the `toolExecEnd` action when one exists. `viewReducer` writes it onto the entry.
Omitting the parameter — every existing test, and headless mode — produces
byte-identical actions.

`App`'s subscription passes `{ take: (id) => controller.takeFilePatch(id) }`
(memoized once, beside the existing `cost` lookup at `App.tsx:391`).

The `toolExecEnd` action carries a **fully-built, immutable** patch, so the
reducer stays pure: it does no I/O, no diffing, and no allocation beyond the
entry spread it already performs.

**A tool entry carries a patch OR a full preview, never both (P1-5).** When a
patch is attached, `buildToolPreview`'s output is stored **truncated to its first
line** rather than in full:

```ts
// reducer.ts, `tool_execution_end`
const patch = patches?.take(event.toolCallId);
const preview = buildToolPreview(event.result);
return [{
  type: 'toolExecEnd',
  // ...
  patch,
  preview: patch ? firstLine(preview) : preview,
}];
```

This is not a budget compromise; it is deleting a duplicate. `ToolCard` renders
`DiffView` **instead of** `ToolPreview` whenever a patch is present (§3.4), so
the stored preview is never drawn on that card — and for `edit_file` it is
literally the same diff, in text, that the patch already holds structurally. Two
copies of one diff would ride in `ViewState`, in every `/save` file, and in
Ink's props. Keeping the first line (`Applied edit to <path>:`, or
`Wrote <n> bytes to <path>`) preserves the one thing outside `DiffView` that
reads it — `entryRevision`'s `preview?.length` term, and the fallback text if a
future renderer wants a one-line summary.

The fallback in §3.4 is unaffected: eviction happens in the **store**, before
attachment. An entry either got its patch at `toolExecEnd` and keeps it for
life, or never had one and therefore still has its full preview.

**`Transcript.tsx` must pass three new things, not one (P1-6b).**
`EntryViewImpl` hands each renderer explicit scalar props, so nothing on the
entry reaches a component by itself:

```tsx
// case 'assistant'
<AssistantEntry ... thinkingMs={entry.thinkingMs} revealable={mode === 'fullscreen'} />
// case 'tool'
<ToolCard ... patch={entry.patch} />
```

`mode` is threaded into `Transcript` / `TranscriptList` as a prop from `App`
(both already receive six presentation props; this is a seventh scalar). It is
**not** read from a module-level singleton, because `render-memo.test.tsx`
asserts prop stability across frames and a hidden read would be invisible to it.

**The patch object must stay referentially stable (P2-9).** `ToolCard` is
`React.memo`'d with the **default** comparator (`ToolCard.tsx:201-206`), whose
own doc comment enumerates which props are objects and why each is stable. A
`FilePatch` qualifies only because the reducer writes it once, at `toolExecEnd`,
and never rebuilds it — `mapEntry` preserves object identity for untouched
entries. A future action that recomputes or normalizes a patch would turn that
memo boundary into a no-op **with nothing failing**, which is the same trap
I-L2-1 exists to catch for `theme` and `caps`. Add the patch to that comment.

---

### 3.4 W4 — rendering the patch

New `src/ui/entries/DiffView.tsx`.

```
  +6 -5
  1163   top level of the file where the section never takes effect. It
  1164 - `applyFastConfigSet` (`:259`). A key missing from the list is
  1164 + `applyFastConfigSet` (`:252`). A key missing from the list is
  1165   `Unknown config key`; a key in the list but missing from the switch
  ...
  1189   @@ -1189,4 +1190,4 @@
```

Layout rules:

- **Summary row.** `+{added}` in `theme.diff.add`, `-{removed}` in
  `theme.diff.remove`, then ` (truncated)` in `theme.muted` when
  `patch.truncated`, then the `degraded` reason when present
  (`old side not read: binary`). The path is **not** repeated — `ToolCard`'s
  header already renders `edit_file <path>` from `summarizeArgs`
  (`ToolCard.tsx:167`), and the v0.4.0 removal of the status bar's hint cluster
  is the precedent for not saying a thing twice on adjacent rows.
- **Gutter.** Right-aligned line number, width
  `clamp(String(maxLineNumber).length, 3, 6)`, `theme.muted`. An `add` row shows
  its `newLine`; a `del` row shows its `oldLine`; a `ctx` row shows its
  `newLine`.
- **Sign column.** One character: `+`, `-`, or a space. Plain ASCII, no glyph
  lookup — these three are the diff's own vocabulary, and `-` is already spelled
  literally by `renderUnifiedDiff`.
- **Colors.** `theme.diff.add` / `.remove` / `.context` per row;
  `theme.diff.meta` for a hunk separator.
- **Hunk separators.** Between hunks, one `meta` row `@@ -a,b +c,d @@`. None
  before the first.
- **`wrap="truncate"` on every row.** This is a correctness requirement, not a
  taste one: `estimateEntryRows` computes a tool entry's height by counting
  rendered rows, and a wrapped diff line would occupy two rows while the
  estimate charged one — an under-estimate, which is the direction
  `virtual-window.ts:152` names as unsafe. One patch line is one terminal row,
  always.
- **Collapse.** `DIFF_COLLAPSED_LINES = 12` (higher than the generic preview's
  8: a diff's rows are half as tall in information terms, and 8 rows of a
  3-context hunk is barely one change). Footer `+{n} lines (Ctrl+O)`, identical
  in wording to the existing one. Expansion is the existing `expandedToolIds`
  mechanism and the existing `Ctrl+O` handler (`App.tsx:1222`) — **no new
  keybinding, no new state.**

`ToolCard` selects it:

```tsx
const showPatch = !!patch && (status === 'done' || status === 'error');
// THE OUTER GUARD WIDENS TOO (P2-2). It is `previewLines.length > 0 && ...`
// today (ToolCard.tsx:147), and §3.3.7 truncates the stored preview to one line
// when a patch exists — so a card whose preview were ever empty would render
// its header and swallow the diff, silently.
const showBody = (previewLines.length > 0 || showPatch) && (status === 'done' || status === 'error');

// in the rail-bordered body:
{showPatch
  ? <DiffView patch={patch} expanded={expanded} liveClampRows={liveClampRows} theme={theme} />
  : <ToolPreview name={name} lines={visibleLines} theme={theme} isError={isError} />}
```

The existing `+N lines (Ctrl+O)` / `(Ctrl+O to collapse)` footers are computed
from `previewLines`, so they move behind the same branch: `DiffView` owns its own
footer arithmetic (patch rows, not preview rows), and the preview footers render
only on the `ToolPreview` side.

When `patch` is absent, `ToolPreview`'s existing `edit_file` / `write_file`
branches render exactly what they render today. That covers three real cases:
sessions saved by an older build, a store entry evicted under a 64-write burst,
and a card from a toolset built without `recordChange`. **Nothing ever renders
blank.**

**One caveat on the expansion affordance (P2-4).** `Ctrl+O` toggles *the most
recent* `tool` or `team` entry, not the focused one — `App.tsx:1226-1229` finds
the last such entry and `README.md:143` documents it as "Expand / collapse the
most recent tool card". A diff further back in the transcript cannot be expanded
without new navigation, which this round does not add. That is pre-existing
behaviour and unchanged by W4; it is recorded here so AC-15 and manual row 5 are
read as "the newest diff", which is what they can pin.

Height accounting, both switches again:

```ts
// entryRevision, case 'tool' — O(1) thanks to the precomputed lineCount.
return `t${entry.status}.${entry.argsRaw.length}.${entry.preview?.length ?? 0}.${
  entry.durationMs ?? -1}.${entry.patch?.lineCount ?? -1}`;

// estimateEntryRows, case 'tool' — when a patch is present it, not the preview,
// is what draws. Summary row + separators + rows + footer.
if (entry.patch) {
  const rows = entry.patch.lineCount + Math.max(0, entry.patch.hunks.length - 1);
  const shown = expanded ? rows : Math.min(rows, DIFF_COLLAPSED_LINES);
  return separation + 1 /* card header */ + 1 /* summary */ + shown + 1 /* footer */;
}
```

`DIFF_COLLAPSED_LINES` is duplicated into `virtual-window.ts` as a number rather
than imported, matching the existing `TOOL_COLLAPSED_LINES = 8` and the comment
that justifies it (`virtual-window.ts:144`).

---

### 3.5 Sequence — one edit, end to end

```
model              CLI tools                store         reducer            UI
 |                    |                       |              |                |
 |-- tool_call_start ------------------------------------->  |  toolCallStart |-- card: `edit_file` queued
 |-- tool_call_end (args) ---------------------------------> |  toolCallEnd   |-- card: path in header
 |                    |                       |              |                |
 |            tool_execution_start ------------------------> |  toolExecStart |-- card: spinner "running"
 |                    |                       |              |                |
 |             read old  -> apply -> write     |             |                |
 |             buildPatch(old,new) ----------> record()      |                |
 |             renderUnifiedDiff(<=4000 chars) |             |                |
 |<-- result: "Applied edit to X:\n@@..."      |             |                |
 |                    |                       |              |                |
 |            tool_execution_end --> reduceEvent(ev,cost,patches)             |
 |                    |               take() --|             |                |
 |                    |                       |  toolExecEnd{patch}           |
 |                    |                       |              |--> entry.patch |-- card: `+6 -5` + hunks
```

Meanwhile, from `agent_start` until `agent_end`, `ActivityLine` occupies one row
above the composer, and any thinking the turn produced is folded into a single
`* thought for 4s - ctrl+t to show` row when the assistant entry settles.

---

## 4. Interface design

### 4.1 Config — one new key

```jsonc
{
  "showThinking": false
}
```

| | |
|---|---|
| Type | `boolean` |
| Default | `false` |
| Location | **Top-level in BOTH `PersistedConfig` and `CliConfig`**, immediately after `thinkingLevel` |
| Resolution | `pick(flags.showThinking, env.partial.showThinking, file.showThinking)` in `config/load.ts`, beside the sibling `thinkingLevel` at `:510` |
| Env | `ARAGON_SHOW_THINKING` (`1`/`true`/`on` → true), parsed in `config/env.ts`, **and added to that file's header inventory at `:7-14`** |
| Flag | `--show-thinking` / `--no-show-thinking`, mirroring `--hints` / `--no-hints` |
| `config set` | `aragon config set showThinking true` |

**Three files, and missing any one of them fails silently (P1-2).**
`PersistedConfig` (`schema.ts:1009`) is the file on disk; `CliConfig`
(`schema.ts:1176`) is *"the effective in-memory config consumed by the controller
and the UI"* and is what `App` holds as `cfg`; `load.ts` is the only place the
two are joined to the flags and the environment. A key added to `PersistedConfig`
and `DEFAULT_CONFIG` alone would persist correctly, survive a round trip through
`config set`, appear in `config list` — and never reach `initialViewState`,
because `cfg.showThinking` would not exist. `--show-thinking` and
`ARAGON_SHOW_THINKING` would parse and be discarded. Nothing would fail; thinking
would simply always be hidden, and the setting would appear to do nothing.

**Adjacent to `thinkingLevel` and deliberately named differently.**
`thinkingLevel` is effort the provider is asked to spend; `showThinking` is
whether the terminal draws what came back. They are one word apart in the config
file and must never be confused, which is why the flag is `--show-thinking`
rather than the shorter `--thinking` the existing key already resembles.

**Both halves of `CONFIG_SET_KEYS`.** The key goes in the `Set` at
`cli.tsx:559` *and* gets a `case` in the switch below it. The file's own comment
records the failure mode of doing only the first: the command writes nothing and
still prints `Set showThinking = true` (P1-2).

### 4.2 Keybindings and commands

| Surface | Change |
|---|---|
| `Ctrl+T` | Unchanged behavior, new starting position. `App.tsx:1217` additionally pushes a toast — see below |
| `HelpOverlay.tsx:30` | `Toggle thinking blocks` → `Show/hide thinking (off by default)` |
| `Ctrl+O` | Unchanged. Now also expands a diff, because a diff lives inside a tool card. Still targets the most recent tool card only (P2-4) |
| `/thinking` | **Unchanged.** It sets the level and keeps doing only that (D-3) |

No new slash command and no new keybinding. Every surface this round needs
already exists.

**The `Ctrl+T` toast is mode-aware, for the same reason the marker is (P0-2).**

| Mode | Toast on reveal | Toast on hide |
|---|---|---|
| full-screen | `Thinking shown.` | `Thinking hidden.` |
| inline | `Thinking shown for new output.` | `Thinking hidden.` |

In inline mode the toggle genuinely cannot repaint what `<Static>` has already
printed, so the ack says what it did rather than what the user hoped. The hide
direction needs no qualifier: hiding applies to everything drawn from here on,
and nothing is claimed about scrollback either way.

### 4.3 Settings screen

One row, inserted after `Thinking` so the two live together:

```ts
{ key: 'thinkingLevel', label: 'Thinking',      kind: 'enum', options: THINKING_LEVELS },
{ key: 'showThinking',  label: 'Show thinking', kind: 'enum', options: ['off', 'on'] },
{ key: 'maxTokens',     label: 'Max tokens',    kind: 'text' },
```

`Show thinking` is 13 characters, inside the 18-column label budget that
`.padEnd(18)` enforces (`SettingsScreen.tsx:377`) and that IF-H7 records as
silently overflowing. The row is seeded in the screen's `initial` values and read
back on save, in the same two places `fastSettingsFrom` / `readFastSettings`
occupy — the omission of either is the documented silent half of adding a row.

`showThinking` is the **thirteenth** key in `SettingsValues`
(`SettingsScreen.tsx:31-59` already has twelve), not the sixth (P2-1). The
ripple IF-H2 documents is real either way; the count in v1's change plan was
simply stale.

### 4.4 No network surface

This package has no REST or WebSocket layer; the CLI talks to providers and to
the terminal. This round adds no process boundary, no file format, and no
protocol version.

---

## 5. Data model

### 5.1 `ViewState` deltas

| Field | Change |
|---|---|
| `thinkingVisible` | Now seeded from `showThinking`; default `false` |
| `Entry(assistant).thinkingStartedAt?: number` | New. Epoch ms |
| `Entry(assistant).thinkingMs?: number` | New. Sealed once, at the first text delta or at turn/run end |
| `Entry(tool).patch?: FilePatch` | New. Immutable, set once by `toolExecEnd` |

All four are JSON-serializable scalars or plain objects, so `SavedSession` needs
no format change and no version bump. An older file simply has none of them and
renders through the fallbacks.

### 5.2 `ViewAction` deltas

| Action | Change |
|---|---|
| `toolExecEnd` | Gains `patch?: FilePatch` |
| everything else | Unchanged |

No new action type. `toggleThinking` already exists.

### 5.3 On-disk and in-memory footprint

**v1's arithmetic was wrong by roughly an order of magnitude, and the fix is not
a smaller budget (P1-5).**

The numbers. A saturated patch is `maxChars` (8 000) of line text plus per-line
structure — `{"kind":"ctx","oldLine":1163,"newLine":1164,"text":"…"}` is about
45–50 bytes of JSON scaffolding per row, and `maxLines` is 200 — so **≈ 18–20 KB
serialized**, which v1 got right. What it then did with that number was not:
`DEFAULT_TRANSCRIPT_RETAIN` is **1000** (`schema.ts:162`), so an adversarial
session of saturated edits is **≈ 20 MB**, not "low single-digit megabytes". And
`saveSession` writes `messages` as well as `entries`, so the same diff is already
on disk once as the model-facing tool result.

The fix is §3.3.7's, and it costs nothing: **an entry carries a patch or a full
preview, never both.** When `DiffView` draws, `preview` is never read, and for
`edit_file` it holds the identical diff as text. Suppressing it to one line
means a patch-bearing entry is *no larger than it is today* — 8 KB of preview
becomes ~18 KB of patch, against ~8 KB of preview plus ~18 KB of patch if both
were kept. The honest ceiling after that change:

| | Per saturated `edit_file` entry | 1000 such entries |
|---|---|---|
| today | ~8 KB (preview) | ~8 MB |
| v1 as written | ~26 KB (preview + patch) | ~26 MB |
| **v2** | ~19 KB (patch + one preview line) | ~19 MB |

Still more than today, and stated plainly rather than rounded away. Three things
bound it in practice: no real session is 1000 saturated 200-row diffs; `maxLines`
and `maxChars` are hard caps, not averages (AC-14); and the same numbers bound
`ViewState` in memory, which is the constraint `transcriptRetain` exists to serve
and which is unchanged in shape.

**AC-14a** pins the new invariant directly: no entry ever holds both a `patch`
and a preview longer than one line.

---

## 6. File / module change plan

### New files

| File | Intent |
|---|---|
| `packages/cli/src/tools/patch.ts` | `FilePatch` types, `PATCH_LIMITS`, `buildPatch` (anchored split + bounded LCS + block-replace fallback), hunk assembly, budget truncation |
| `packages/cli/src/tools/file-change-store.ts` | Bounded, owner-scoped, take-once `FileChangeStore` |
| `packages/cli/src/ui/entries/DiffView.tsx` | Line-numbered, colored, hunk-separated, collapsible patch renderer |
| `packages/cli/src/ui/ActivityLine.tsx` | The one-row live working line (phrase only — P1-1) |
| `packages/cli/src/ui/BottomStatusRow.tsx` | The shared bottom row: toast wins, else activity, else the blank row that is there today. **This is what keeps `chromeBudget` unchanged** (P0-1) |
| `packages/cli/src/ui/activity-phrases.ts` | `ACTIVITY_PHRASES`, `PHRASE_ROTATE_MS`, pure `pickActivityPhrase` |
| `packages/cli/src/__tests__/patch.test.ts` | Diff algorithm: hunks, numbering, budgets, fallbacks, newline and CRLF edges |
| `packages/cli/src/__tests__/file-change-store.test.ts` | Take-once, FIFO eviction, owner scoping |
| `packages/cli/src/__tests__/activity-phrases.test.ts` | Determinism, rotation, ASCII, bounds |
| `packages/cli/src/__tests__/activity-line.test.tsx` | Mount/unmount, width degradation, reduced motion, ASCII tier |
| `packages/cli/src/__tests__/diff-view.test.tsx` | Gutter alignment, colors, collapse footer, truncation notice, fallback |
| `packages/cli/src/__tests__/thinking-visibility.test.tsx` | Default hidden, marker text, `Ctrl+T` reveal, settings round-trip |
| `docs/plans/agent-activity-presentation/manual-test.md` | The manual rows in §7.3 |

### Modified files

| File | Intent |
|---|---|
| `packages/cli/src/tools/fs-tools.ts` | `edit_file` records a patch; `write_file` best-effort reads the old side, records a patch, and keeps its result text unchanged |
| `packages/cli/src/tools/diff.ts` | Re-expressed on `buildPatch`; emits `@@` hunk headers; capped at `modelDiffMaxChars` |
| `packages/cli/src/tools/index.ts` | Adds `recordChange` to `BuiltinToolsOptions` **and** forwards it into the `ToolDeps` built at `:364` — both, or it forwards nothing (P1-3) |
| `packages/cli/src/agent/reducer.ts` | `initialViewState(seed)`; thinking timing on 4 actions; `PatchSource` param on `reduceEvent`; `patch` on the tool entry; **preview truncated to one line when a patch is attached** (P1-5) |
| `packages/cli/src/agent/controller.ts` | **Creates and owns** the `FileChangeStore`, passes an owner-bound `recordChange` into `createBuiltinTools` at `:335`, exposes `takeFilePatch(toolCallId)` (P1-3) |
| `packages/cli/src/ui/App.tsx` | Seeds `thinkingVisible` from `cfg.showThinking`; `runStartedAt` ref updated **in render scope** (P1-7); builds `BottomStatusRow` for the `toast` slot; passes `mode` to the transcript; passes `PatchSource`; mode-aware `Ctrl+T` toast |
| `packages/cli/src/ui/ToastStack.tsx` | Absorbed by `BottomStatusRow`, or left in place and composed by it. **Its one-row full-screen contract is preserved either way** (P0-1) |
| `packages/cli/src/ui/layout/virtual-window.ts` | `entryRevision` for `thinkingMs` and `patch.lineCount`; `estimateEntryRows` gains `thinkingVisible` and a patch branch |
| `packages/cli/src/ui/entries/AssistantEntry.tsx` | The collapsed `thought for Ns` row, with `ctrl+t to show` only when `revealable` (P0-2) |
| `packages/cli/src/ui/entries/ToolCard.tsx` | Renders `DiffView` when a patch is present, `ToolPreview` otherwise; **widens the `showBody` guard** (P2-2); records the patch in the memo comment (P2-9) |
| `packages/cli/src/ui/Transcript.tsx` | Passes `entry.patch`, `entry.thinkingMs` and `revealable` through `EntryView`; takes a `mode` prop; **passes `thinkingVisible` to `estimateEntryRows` at `:405`** (P1-6) |
| `packages/cli/src/ui/glyphs.ts` | Nothing new is expected; if `DiffView` or `ActivityLine` needs a mark, it is added to **both** tables here |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | The `Show thinking` row, seeded and read back (13th `SettingsValues` key — P2-1) |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | `Ctrl+T` wording |
| `packages/cli/src/config/schema.ts` | `showThinking` in `PersistedConfig`, **`CliConfig`**, and `DEFAULT_CONFIG` (P1-2) |
| `packages/cli/src/config/load.ts` | **`pick(flags, env, file)` for `showThinking`, beside `thinkingLevel` at `:510`, and the field on the returned `CliConfig` (P1-2)** |
| `packages/cli/src/config/env.ts` | `ARAGON_SHOW_THINKING`, plus the name in the header inventory at `:7-14` (P2-10) |
| `packages/cli/src/cli.tsx` | `--show-thinking` / `--no-show-thinking`; `CONFIG_SET_KEYS` entry **and** switch case. **It does not create the store** — the controller does (P1-3) |
| `packages/cli/src/__tests__/max-tokens-ui.test.tsx` | A thirteenth `SettingsValues` key (IF-H2's documented ripple) |
| `packages/cli/src/__tests__/virtual-window.test.ts` | New revision and estimate cases (RV-13's two switches) |
| `packages/cli/src/__tests__/reducer.test.ts` | Seeded initial state; thinking timing; patch attachment; preview suppression |
| `packages/cli/src/__tests__/tool-preview.test.ts` | `renderUnifiedDiff` now emits `@@` and still defaults to 2 context rows; fallback rendering still classifies the header as meta |
| `packages/cli/src/__tests__/budget.test.ts` | `viewportRows(rows)` is unchanged by this round, asserted rather than assumed (AC-8a) |
| `packages/cli/README.md` | Keybinding table, config table, a short "what you see while it runs" section |
| `packages/cli/CHANGELOG.md` | One entry at the top, naming the default flip explicitly |

### Explicitly not touched

`packages/core/**` (no engine, event, or tool-contract change), `agent/headless.ts`
(print mode never rendered thinking or cards), `session/persist.ts` (D-9),
`todo/**`, `ui/render-governor.ts` and `ui/use-render-governor.ts` (W2 adds no
render frequency of its own).

Three of these are load-bearing rather than incidental, and v2 states why:

- **`ui/layout/budget.ts` and `ui/layout/AppShell.tsx`.** v1 planned a new
  `activity` slot in `AppShell`; v2 does not, because a new bottom-chrome row
  that `chromeBudget` does not know about takes its row from the transcript
  (P0-1). Sharing the already-budgeted toast row means the layout primitives are
  untouched — and `budget.test.ts` gains an assertion that they stayed that way.
- **`ui/StatusBar.tsx`.** Unchanged, and now for a second reason: it already
  owns the elapsed clock and the token cluster, and W2 stops duplicating them
  (P1-1).
- **`team/**`.** Subagents therefore never receive `recordChange` and never
  record a patch, which is a deliberate scope line rather than an oversight —
  see D-13 and R-5, both re-scoped in v2 to describe what this round actually
  builds.

---

## 7. Testing & acceptance criteria

### 7.1 Unit tests (Vitest, offline, no network)

**`patch.test.ts`** — the largest surface, and the one where a bug is silent:

1. A one-line change in a 500-line file yields **one** hunk of 7 rows, not 500.
2. Two changes 800 lines apart yield **two** hunks (today's renderer yields one
   spanning both — assert the count, so a regression to `blockReplace` fails).
3. Two changes 4 lines apart merge into one hunk (`mergeGap`).
4. `oldLine` / `newLine` are correct on every row of a multi-hunk patch, verified
   by reconstructing both files from the patch.
5. `oldText === null` yields `kind: 'create'`, `removed: 0`, all-`add`.
6. Identical inputs yield zero hunks and `added === removed === 0`.
7. A file with no trailing newline against one with a trailing newline emits the
   `(no newline at end of file)` context row and no phantom blank line.
8. CRLF input renders no `\r` in any `PatchLine.text`, and a pure CRLF→LF
   conversion is still reported as a change.
9. A 5000-line rewrite is truncated to `maxLines` / `maxChars`, sets
   `truncated: true`, and still reports the **untruncated** `added`/`removed`.
10. A pathological input above `lcsCellBudget` returns a block replace and
    completes in under 100 ms.
11. `lineCount` equals the summed `hunks[].lines.length` (the invariant
    `entryRevision` depends on).
12. `buildPatch` never throws, for any pair of strings, including empty ones.

**`file-change-store.test.ts`** — `take` returns then removes; a second `take`
is `undefined`; the 65th record evicts the first; the same `toolCallId` under
two owners does not collide.

**`activity-phrases.test.ts`** — every phrase is ASCII and ≤ 12 characters and
the list has no duplicates; `pickActivityPhrase` is deterministic; the word
changes at `PHRASE_ROTATE_MS` and not before; `rotate: false` holds one word;
`now < startedAt` does not throw and does not return `undefined`.

**`diff-view.test.tsx`** (`ink-testing-library`, `stripAnsi`) — the summary row
reads `+6 -5`; every rendered row begins at the same column after the gutter; a
25-row patch collapses to 12 with a `+13 lines (Ctrl+O)` footer; `expanded`
shows all; `truncated` renders the notice; both glyph tiers render.

**`activity-line.test.tsx`** — idle renders nothing; running renders exactly one
row; the row is one row at 200 columns and at 40; `reducedMotion` renders the
static glyph and a stable phrase; **the row contains no digits and no `esc`**,
which is the machine-checkable form of the anti-duplication rule of §3.2.2 (a
clock, a token count and the abort hint all fail it).

**`bottom-status-row.test.tsx`** (new, P0-1) — in full-screen the row is exactly
one row in all four states (idle / running / toast / toast-while-running); a
toast wins over the activity line; `viewportRows(rows)` returns the same number
whether or not a run is in flight; in inline the row is absent when there is
neither a toast nor a run.

**`thinking-visibility.test.tsx`** — with `showThinking: false` a streamed
thinking block is not in the frame; after settle, `thought for` appears exactly
once; `Ctrl+T` reveals the body and hides the marker **in full-screen**; the
marker omits `ctrl+t to show` in inline and keeps it in full-screen (P0-2); with
`showThinking: true` the first frame already shows the body (no
flash-then-hide); `estimateEntryRows` returns 1 for a collapsed marker and the
expanded height when `thinkingVisible` is passed as `true`; the settings row
round-trips and an untouched save does not flip it.

**Amended existing tests** — `reducer.test.ts`, `virtual-window.test.ts`,
`max-tokens-ui.test.tsx`, `tool-preview.test.ts`, `render-memo.test.tsx`,
`glyphs.test.ts` (scan must still pass).

### 7.2 Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | A fresh install renders no thinking text at any point in a turn |
| AC-2 | A settled turn that thought shows exactly one muted row naming the duration and `ctrl+t` |
| AC-3 | In **full-screen**, `Ctrl+T` reveals the full thinking body for every entry already in the transcript, and toasts what it did. In **inline**, it reveals the live entry and everything drawn after it, the marker on a settled entry never offered `ctrl+t`, and the toast says `Thinking shown for new output.` (P0-2) |
| AC-4 | `showThinking: true` in `config.json` shows thinking from the first frame, with no visible flash of the collapsed marker |
| AC-5 | `aragon config set showThinking true` persists, and `aragon config list` reports it |
| AC-6 | While a run is in flight exactly one activity row is on screen, immediately above the composer, carrying **only** a spinner and a phrase (P1-1) |
| AC-7 | The phrase changes at most once every 4 s, is stable within that window, and **does not change between the first and second frame of a run** (P1-7) |
| AC-8 | An idle frame draws no activity row and no extra blank row; apart from the collapsed thinking marker on turns that thought, it is unchanged from the pre-feature build (P2-3) |
| **AC-8a** | **`viewportRows(rows)` returns the same value before, during and after a run, and `chromeBudget` is unchanged by this round. In full-screen the bottom status row is exactly one row in every state** (P0-1) |
| AC-9 | With `reducedMotion: true` the activity row has no spinner and one fixed phrase |
| AC-10 | On a 40-column terminal the activity row is exactly one row and is not truncated mid-word into gibberish |
| AC-11 | `edit_file` on two regions 800 lines apart renders two hunks; total rows ≤ `DIFF_COLLAPSED_LINES` before expansion |
| AC-12 | `write_file` to a new path renders a `create` diff with `+N -0` and add-colored rows, not a byte count |
| AC-13 | `write_file` over an existing file renders a real `update` diff |
| AC-14 | A patch never exceeds `maxLines` rows or `maxChars` characters, and a clipped one says `(truncated)` while its `+N -M` still describes the whole change |
| **AC-14a** | **No entry ever holds both a `patch` and a preview longer than one line; a patch-bearing entry serializes no larger than the same entry does today** (P1-5) |
| AC-15 | `Ctrl+O` expands and re-collapses the **most recent** diff card, with no new keybinding (P2-4) |
| AC-16 | A session saved with patches reloads and renders them; a session saved by an older build renders through `ToolPreview` and never blank |
| AC-17 | For a **single-region** edit the model-facing diff is today's rows plus one `@@` header (and no `\r`); for a **multi-region** edit it is strictly smaller than today's. `renderUnifiedDiff` still defaults to 2 context rows, and `write_file`'s result text is byte-identical (P1-4) |
| AC-18 | An unreadable, binary, or oversized old side never prevents or delays the write; the card shows the degraded reason |
| AC-19 | `estimateEntryRows` is never lower than the rendered height, for a diff card and for both thinking states; **and `Transcript.tsx` passes `thinkingVisible`, so a hidden thinking block estimates as one row rather than as its wrapped length** (P1-6) |
| **AC-21** | **`--show-thinking`, `ARAGON_SHOW_THINKING=1` and `config set showThinking true` each independently reach `cfg.showThinking` and therefore the first rendered frame** (P1-2) |
| AC-20 | `npm test` and both `tsc --noEmit` passes are green; `glyphs.test.ts`'s scan finds no new non-ASCII literal outside `glyphs.ts` |

### 7.3 Manual test rows (`manual-test.md`)

1. Fresh config, `thinkingLevel: high`, ask a question that provokes long
   reasoning. **Pass:** no reasoning text; one activity row that changes word;
   one `thought for Ns` row when the answer lands. **Watch the first frame of
   the run specifically:** the word must not change between the first and second
   frame (P1-7).
2. **Full-screen.** Press `Ctrl+T` mid-run and after. **Pass:** the body appears
   both times; the marker disappears; a toast reads `Thinking shown.`
2b. **Inline** (`--no-fullscreen`). Same two presses. **Pass:** the settled
   entry's marker reads `* thought for Ns` with **no** `ctrl+t` hint; the toast
   reads `Thinking shown for new output.`; the next turn's thinking is visible.
   **Fail:** a settled marker offering `ctrl+t to show` that does nothing when
   pressed — the P0-2 regression (`<Static>` cannot re-print).
3. `/settings` → `Show thinking` → `on`, save, new turn. **Pass:** thinking is
   visible from the first frame. Reopen `/settings`. **Pass:** the row still
   reads `on`.
4. Ask for an edit that changes two far-apart regions. **Pass:** two hunks with
   correct line numbers; `+N -M` matches `git diff --stat`.
5. Ask for a new 200-line file. **Pass:** an add-colored diff with a
   `+13 lines (Ctrl+O)` style footer; `Ctrl+O` expands it; `Ctrl+O` collapses it.
6. Overwrite a 5 MB file with `write_file`. **Pass:** the write succeeds
   promptly and the card says the old side was not read.
7. Resize to 40 columns mid-run. **Pass:** the activity row stays one row; the
   composer and status bar are intact.
7b. **Full-screen, ~24 rows. Note the transcript's bottom line, then submit.**
   **Pass:** the transcript does not shift by a row when the run starts, and does
   not shift back when it ends; the status bar stays on the last line. Repeat
   with a toast firing mid-run (`Ctrl+T` twice): **Pass:** the toast replaces the
   activity row for its TTL and the frame height never changes. **Fail:** any
   one-row jump — that is P0-1, and it is the row this design deliberately does
   not add.
8. `--no-unicode`-equivalent terminal (legacy `cmd.exe`). **Pass:** no mojibake
   anywhere in the activity row or the diff.
9. `/save` a session with three edits, restart, `/resume`. **Pass:** all three
   diffs render; the thinking markers are still collapsed.
10. Interrupt with `esc` during a long think. **Pass:** the activity row
    disappears immediately; the entry settles with `[aborted]`.

---

## 8. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **A default flip hides information users relied on.** Someone reading thinking daily loses it on upgrade | The collapsed marker names the duration *and* the key, exactly where the content used to be; the CHANGELOG entry leads with the flip; one config key restores the old behavior permanently |
| R-2 | **The diff algorithm is the largest new surface and a bug there is silent** — a wrong line number looks plausible | Twelve unit tests including a reconstruct-both-files round trip; a total `buildPatch` that cannot throw; a block-replace fallback that is exactly today's behavior |
| R-3 | **Scroll drift.** A patch or a collapsed marker whose estimated height disagrees with what was drawn | Both switches in `virtual-window.ts` are in the change plan and in AC-19; `wrap="truncate"` makes one patch line one row by construction; `estimateEntryRows`'s new parameter defaults to the conservative value |
| R-4 | **Session-file growth** from stored patches | `PATCH_LIMITS.maxChars` is set equal to `STORED_PREVIEW_CHARS`, so a patch can at most double an entry; AC-14 |
| R-5 | **Store leak** from a recorded patch nobody consumes | 64-entry FIFO ring plus take-on-read; `size()` asserted in tests. *Re-scoped in v2 (P1-3): subagents get no `recordChange` this round, so the "child writes nobody consumes" case cannot arise. The ring guards the case that can — a `tool_execution_end` that never reaches the reducer* |
| R-6 | **Extra I/O in `write_file`** slows or breaks a write | Size- and type-guarded, wrapped so no failure reaches the write path; manual row 6 |
| R-7 | **Model behavior changes** because the diff text changed shape | The change is a strict reduction plus `@@` headers, a format the fallback classifier already understands; AC-17 pins spend as non-increasing; `write_file`'s model text is byte-identical |
| R-8 | **Render cost** of a new row at 5 Hz | The activity row is one `<Text wrap="truncate">` driven by a ticker that already exists and already re-renders the status bar at the same rate; no new interval, no new state, nothing at all when idle |
| R-9 | **Two live surfaces disagree** — the activity row and a per-entry marker both claiming to be live | The marker is gated on `!streaming`, so exactly one of them is ever on screen |
| R-10 | **ASCII regression.** A literal in a new UI file ships mojibake to `cmd.exe` | `glyphs.test.ts`'s static scan fails the build; it walks all of `src/`, so every new file this round adds is in it; AC-20 |
| **R-11** | **Frame-height regression.** A future round adds the bottom chrome row this one declined to add, and the transcript silently loses a row while running | The row is shared with `toast`, so `chromeBudget` never learned about it; AC-8a asserts `viewportRows` is unchanged and `budget.test.ts` owns that assertion. `budget.ts:1-19` already records what happens when this number is "computed nowhere and assumed in three places" (P0-1) |
| **R-12** | **`<Static>` honesty.** A future change makes the inline marker offer `ctrl+t` again, and it silently does nothing | `revealable` is a prop, not a constant, and `thinking-visibility.test.tsx` asserts both spellings against both modes (P0-2) |
| **R-13** | **The duplicate creeps back.** Someone adds an elapsed cluster to the activity row because it "looks empty" | `activity-line.test.tsx` asserts the row contains no digits — a clock, a token count and a percentage all fail it, and the test names `StatusBar.tsx:294-298` as the reason (P1-1) |

---

## 9. Decisions

| ID | Decision | Why |
|---|---|---|
| **D-1** | Thinking is hidden by **default**, not merely collapsible | The requirement says so, and a collapsed-by-default block still costs a row and an interaction per turn |
| **D-2** | `initialViewState`'s own default is `false` | One production call site; a forgotten seed must fail closed, toward the product default, not toward the firehose |
| **D-3** | No `/thinking show` subcommand | `/thinking`'s argument is a *level* (`off\|low\|medium\|high`). Adding `show`/`hide` to the same argument position creates a command where `off` is ambiguous. `Ctrl+T` + the settings row + `config set` are three surfaces already |
| **D-4** | No one-shot startup notice about the flip | The `mouseNoticeSeen` precedent exists, but the collapsed marker is a better affordance: it appears exactly when there is something to reveal, points at the key, and needs no state in `state.json` |
| **D-5** | The activity line does **not** repeat `esc abort` — **nor the elapsed clock, nor the token count** (amended in v2 / P1-1) | Both composers already carry the abort hint while running (`Composer.tsx:68` in full-screen, `PromptInput.tsx:442-443` in inline — P2-8), and the status bar already carries the clock and the tokens under the same `running` condition and the same `cols >= 72` breakpoint (`StatusBar.tsx:292, 294-298`). Duplicated rows are precisely what §4.6 of v0.4.0 removed, and that rule does not distinguish between a duplicated string and a duplicated number |
| **D-6** | The activity line is not a `StatusBar` chip | The bar is one row, `flexShrink={0}` on the left, and already degrades three chips under width pressure; a rotating word there would cost the context gauge the columns it cannot spare |
| **D-17** | **It is also not a new `AppShell` slot. It shares the toast row** (v2 / P0-1) | A conditional bottom-chrome row inside a `height={frameHeight(rows)}` frame does not grow the frame — it shrinks the only `flexShrink={1}` child, the transcript — while `viewportRows()` keeps returning the old number to five consumers. `ToastStack.tsx:5-10` legislates exactly this for itself, and a run starts and ends far more often than a toast does. Sharing the already-budgeted row means `budget.ts` and `AppShell.tsx` are untouched, the idle frame is literally unchanged, and the precedence (toast wins) is the one v1 already argued for |
| **D-16** | **The collapsed marker offers `ctrl+t` only in full-screen** (v2 / P0-2) | Inline mode prints settled entries into Ink's `<Static>`, which cannot un-print or re-print (`Transcript.tsx:9-10`); with thinking hidden by default the body is never printed there at all, so the key provably cannot do what the row says. A shorter honest row beats a longer false one, and it is the same argument §1.2 makes for having a marker in the first place |
| **D-7** | The phrase does not rotate under `reducedMotion` | Rotating text is motion. Honoring the setting for the spinner only would honor its letter and not its purpose |
| **D-8** | The patch travels on a CLI-local side channel, not in the tool result | It is the only way to make the display richer while making the model's input smaller. `ToolResult` has no metadata channel and `packages/core`'s surface is frozen by `public-api.test.ts` |
| **D-9** | `FilePatch` needs no clause in `normalizeLoadedEntries` | The four existing clauses all exist because a *live* flag would never settle and would pin `Transcript`'s monotonic boundary. A patch is immutable and is written only on `toolExecEnd`, i.e. at settle. There is no live state to normalize |
| **D-10** | `renderUnifiedDiff` keeps its name, signature, and row prefixes; it gains `@@` headers | The call site does not change, the fallback classifier already routes `@@` to `meta`, and the diff the model reads and the diff the user reads are then provably the same change |
| **D-11** | `DIFF_COLLAPSED_LINES` is 12, not the preview's 8 | With 3 rows of context, 8 rows is barely one change; 12 shows a change and its surroundings |
| **D-12** | The patch is stored on the entry and persisted | `/resume` then renders real diffs instead of degrading, at a bounded and measured cost (§5.3) |
| **D-13** | The store key carries an owner segment, and **only `'lead'` is ever written this round** (amended in v2 / P1-3) | `team/**` is out of scope, so `buildSubagentTools` passes no `recordChange` and a child's write cannot reach the store at all. The segment is not fixing a live hazard; it is making the *next* round's decision cheap — subagents build tools from the same factory (`team/subagent.ts:152`), so the day one gets a recorder, a child's tool-call id must not be able to land on a lead card. One string concatenation, spent now, at a moment when it is obvious why |
| **D-18** | **The `FileChangeStore` is owned by `AgentController`, not by `cli.tsx`** (v2 / P1-3) | `createBuiltinTools` is called from `controller.ts:335` and `team/subagent.ts:152`; `cli.tsx` only constructs the controller. Owning it where the tools are built keeps `recordChange` pre-bound to its owner (so `fs-tools.ts` never learns what an owner is), keeps `takeFilePatch` beside the store it reads, and removes a constructor parameter from `cli.tsx` entirely |
| **D-19** | **A tool entry carries a patch or a full preview, never both** (v2 / P1-5) | `ToolCard` renders `DiffView` *instead of* `ToolPreview` when a patch exists, so the stored preview is never drawn on that card — and for `edit_file` it is the same diff as text. Truncating it to its first line makes a patch-bearing entry no larger than it is today, which is a better answer than the smaller budget §5.3's real arithmetic would otherwise have forced |
| **D-20** | **`renderUnifiedDiff` keeps 2 context rows; the UI uses 3** (v2 / P1-4) | `fs-tools.ts:168` passes no override, so a single shared constant of 3 would widen every model-facing diff by two rows — the direction AC-17 forbids, in the most common case, with nothing in §7 watching. One algorithm, two widths, chosen by the caller: the model gets precision it did not have, and not one row it did not ask for |
| **D-14** | `write_file` reads the old side before writing, guarded and best-effort | It is the only way to show a real diff on overwrite; the guards mean the presentation feature can never break the operation |
| **D-15** | Streaming tool output is out of scope | No builtin tool emits `onProgress`, and live output in a height-cached virtualized transcript is a round of its own |

---

## 10. Definition of done

1. Every file in §6's change plan is created or modified, and no file outside it
   is touched.
2. `npm test` is green at the workspace root; both `tsc --noEmit` passes
   (`tsconfig.json` and `tsconfig.test.json`) are clean for `packages/cli`.
3. Every AC in §7.2 is satisfied, with AC-8, AC-8a, AC-14, AC-14a, AC-17,
   AC-19 and AC-21 each pinned by a named test. AC-8a and AC-14a are the two
   added by this review that guard a *silent* failure, and neither is optional.
4. `glyphs.test.ts` passes unchanged — no new non-ASCII literal outside
   `glyphs.ts`.
5. All twelve manual rows in §7.3 pass on Windows PowerShell and on one POSIX
   terminal; rows 1, 2b, 4, 5, 7b and 8 are not skippable. **Row 7b must be run
   in full-screen at a short terminal and row 2b in inline** — those are the two
   modes the P0s live in, and neither is the mode a developer happens to be
   sitting in.
6. `packages/cli/README.md` documents `showThinking`, the amended `Ctrl+T`
   entry, and what the activity row shows; `CHANGELOG.md` leads its entry with
   the default flip.
7. No file introduced or grown by this round exceeds 1000 lines; no new function
   exceeds 60 lines or 5 parameters. `buildPatch`'s recursion is split across
   named helpers (`diffRange`, `lcsDiff`, `blockReplace`, `assembleHunks`,
   `applyBudgets`) rather than living in one function.
8. `ui/layout/budget.ts` and `ui/layout/AppShell.tsx` are **unmodified**, and
   `budget.test.ts` says so. If either had to change, P0-1 was reintroduced and
   the frame's row accounting is back to being asserted in three places.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Six findings. Each states what §-of-this-document said, what the tree or the
implementation actually required, what was done, and — where it matters — why the
alternative fails **silently**. The design was implemented as approved; these are
the seams it did not reach.

### IF-1 — §3.3.3 step 5 renders a 300-line create as nothing at all

**What the design said.** Step 5: *"drop whole hunks from the **tail** until both
`maxLines` and `maxChars` hold, setting `truncated: true` if anything was
dropped."*

**What that produces.** A `write_file` of a new 300-line file is ONE hunk of 300
`add` rows against a 200-row ceiling. Dropping whole hunks from the tail drops
the only one, so `hunks` is empty, `lineCount` is 0, and `DiffView` renders a
`+300 -0 (truncated)` summary over an empty body. §1.1 names creating a 300-line
file as *"the single most consequential thing an agent does"* and reports its
current treatment — a byte count — as the defect this round exists to fix; a
summary line over nothing is the same defect with better typography. AC-12
("renders a `create` diff with `+N -0` **and add-colored rows**") is not met by
the literal reading of its own step 5.

**What was done.** `applyBudgets` keeps the first hunk unconditionally and clips
its ROWS from the tail instead, re-deriving the `@@` header numbers from what
survives (`clipHunkRows`). Whole-hunk tail dropping is unchanged for every case
where more than one hunk exists. `patch.test.ts` pins both halves: the 5000-line
rewrite still truncates and still reports the untruncated `+5000 -5000`, and the
300-line create keeps exactly `maxLines` rows rather than zero.

### IF-2 — `PATCH_LIMITS.mergeGap` is a constraint on `context`, not a free number

**What the design said.** §3.3.2 gives `mergeGap: 6, // 2 * context` and §3.3.4
gives the algorithm two context widths chosen by the caller (2 for the model, 3
for the UI).

**What the tree required.** The two are not independent. Two groups survive as
separate hunks only when MORE than `mergeGap` context rows separate them, and
each is then expanded by `context` rows from its own side. At
`context > mergeGap / 2` the expansions overlap, and the same source row is
emitted twice — under two different line numbers, in two different hunks, with
nothing reporting it. Both real callers (2 and 3) are safe; a third caller
passing 4 would not be, and `renderUnifiedDiff` takes `options.context` from
outside this module.

**What was done.** `clampContext` clamps to `floor(mergeGap / 2)` and says why.
The invariant is now structural rather than a property of the two call sites that
happen to exist, and `PATCH_LIMITS.mergeGap`'s doc comment states it.

### IF-3 — `estimateEntryRows` reaches five parameters, which is the ceiling

**What the design said.** §3.1.4 adds `thinkingVisible` as a fifth parameter.

**What the tree required.** `CLAUDE.md` caps a function at five parameters, so
this is the last one that fits. It was taken rather than restructured because the
alternative — an options object — would touch the four existing call sites for no
behavioural gain, and §0 asks for a diff that changes nothing it does not have
to. **The next flag this function needs must convert the tail to an options bag,
not add a sixth positional.** Recorded here so that decision is made deliberately
rather than by exceeding the threshold quietly.

### IF-4 — §4.3's settings row must be seeded from `ViewState`, not from `cfg`

**What the design said.** §4.3: *"The row is seeded in the screen's `initial`
values and read back on save, in the same two places `fastSettingsFrom` /
`readFastSettings` occupy."*

**What the tree required.** Those two functions round-trip through `cfg`, and
that works because `controller.setFastConfig()` updates the config the controller
holds. `showThinking` has no such setter: the live value is
`ViewState.thinkingVisible`, which `Ctrl+T` also writes, and `persistConfig()`
only reaches disk. Seeding the row from `cfg.showThinking` would therefore show
the LAUNCH value under a transcript that has been toggled since — and an
untouched save would then quietly toggle it back, which is precisely the failure
§4.3 cites `fastSettingsFrom` to avoid.

**What was done.** The row is seeded from `state.thinkingVisible` and the save
handler does both halves: `persistConfig` for next launch, and a `toggleThinking`
dispatch when the row disagrees with the live state. Manual row 3 gained the
`Ctrl+T`-then-reopen check.

### IF-5 — the change plan omits the test fixtures a required key forces

**What the design said.** §6 budgets `max-tokens-ui.test.tsx` for the thirteenth
`SettingsValues` key (IF-H2's documented ripple) and lists five other test files.

**What the tree contained.** `showThinking` is REQUIRED on `CliConfig`, and
thirteen test files build a full `CliConfig` literal; `TranscriptProps.mode` is
required, and four more build transcript props. Seventeen files therefore had to
change mechanically, and `app.test.tsx`'s `FakeController` needed
`takeFilePatch()` — that class is handed over as `fc as unknown as
AgentController`, so its absence is **not** a compile error but
`controller.takeFilePatch is not a function` at the first `tool_execution_end`.

**What was done.** All seventeen were updated (one field or one prop each) and
the fake gained the method with a comment naming the cast. Making either key
optional was considered and rejected: `CliConfig.showThinking?: boolean` would
weaken the P1-2 argument that the key must exist in all three places, and an
optional `mode` would let a future renderer default to `fullscreen` in inline and
re-open P0-2.

### IF-6 — `ink-testing-library` cannot vary the terminal width, so AC-10's obvious test is vacuous

**What the design said.** AC-10 and §7.1's `activity-line.test.tsx` / 
`diff-view.test.tsx` rows ask for assertions "at 200 columns and at 40".

**What the tree contained.** `ink-testing-library`'s `render` takes the tree and
nothing else, and its stdout stub is `get columns() { return 100 }`. So
`render(tree, { columns: 40 })` is silently ignored: the assertion runs twice at
100 columns and passes forever while looking exactly like a real width sweep.
(`budget.test.ts`'s header records the same stub's missing `rows` for the same
reason, which is why that file is pure-function assertions.)

**What was done.** `src/__tests__/render-at-width.ts` is that library's `render`
with the one number made a parameter, and both width sweeps go through it. The
40-column rows now genuinely render at 40 columns and additionally assert that no
row exceeds the width.

---

## 评审结论 (Review Verdict)

**有条件通过 — Approved with conditions.**

The design is sound in its architecture and unusually well-grounded in the tree:
it reuses the existing 200 ms ticker rather than adding a timer, it reuses
`Ctrl+O` and `expandedToolIds` rather than adding a keybinding, it keeps
`packages/core` frozen, and W3's decision to move the diff off the tool result
and onto a CLI-local channel is the right call for exactly the reason it gives —
it is the only shape that makes the display richer and the model's input smaller
at the same time. `buildPatch`'s anchored-split-then-bounded-LCS-then-block-replace
ladder terminates on every path and degrades to today's behavior rather than
hanging. The scope is right-sized: four workstreams, each independently
revertible, nothing speculative.

What v1 got wrong was **not the design, but the seams** — three of the four
defects that matter are places where a correct-looking change lands in a
subsystem that keeps its invariant somewhere else, and fails without an error:
the frame's row budget (`budget.ts`), `<Static>`'s one-way print, and the effect
ordering behind a ref. All are fixed above.

**Conditions of approval.** All of these are already written into the v2 body;
they are restated here because they are what the approval is contingent on, and
because four of them fail silently if skipped.

1. **The activity row shares the toast row in full-screen (P0-1 / D-17).**
   `chromeBudget` and `AppShell` must come out of this round unmodified, and
   `budget.test.ts` must assert it (AC-8a, DoD #8). If implementation finds a
   reason the shared row will not work, that is a **return to review**, not a
   local decision — the alternative is a permanent extra row, which trades AC-8
   away and needs to be argued, not absorbed.
2. **The inline collapsed marker must not offer `ctrl+t` (P0-2 / D-16).** Pinned
   by `thinking-visibility.test.tsx` in both modes and by manual row 2b.
3. **The activity row carries no digits (P1-1 / D-5).** Pinned by
   `activity-line.test.tsx`. This is the condition most likely to erode later,
   which is why the test is written as a property rather than as a string match.
4. **`config/load.ts` and `CliConfig` are in the change plan (P1-2).** Verified
   end to end by AC-21, which exercises all three input channels separately —
   a config-file-only test would pass with the flag and the env var both dead.
5. **`Transcript.tsx:405` passes `thinkingVisible` to `estimateEntryRows`
   (P1-6).** The parameter's `true` default is a fail-safe for a *forgotten*
   caller, not the plan for the only one.
6. **An entry never carries both a patch and a full preview (P1-5 / D-19),**
   pinned by AC-14a.
7. **`renderUnifiedDiff` keeps its 2-row context default (P1-4 / D-20),** pinned
   by the restated AC-17 and by `tool-preview.test.ts`.
8. **`runStartedAt` is seeded in render scope (P1-7),** pinned by AC-7's
   first-two-frames clause.

**Not blocking, and left to the implementer's judgement:** every P2 in the
Review Notes that is not already fixed in the body — P2-5 (the `!overlayNode`
suppression is conservative in inline), P2-6 (one-second phrase-seed
granularity), and P2-7 (`\r` stripping is a second, benign change to the model's
input). None of them can produce a wrong frame or a wrong number; each is a
sentence that claims slightly more than the code will do.

**Re-review is required only if** condition 1 cannot be met as written, or if
implementation finds that `team/**` must be touched after all — that would
reopen D-13's scope and R-5's risk statement together.

*Reviewed against `packages/cli/src` at round-1 HEAD. Every file:line citation in
§2 and in the Review Notes was read, not inferred.*
