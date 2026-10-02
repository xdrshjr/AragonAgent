# TUI render performance — design specification

> Feature slug: `tui-render-performance`
> Target: `@aragon-agent/cli` only (`packages/cli`). `@aragon-agent/core` is **untouched** — no engine, provider, tool or event change.
> Version: **v1** — solution-architect first draft
> Status: draft, pending design review
> Author: solution-architect node
> Requirement: 长任务 / 长输出下 TUI 卡顿，极端情况直接卡死；要求对齐 Claude Code 的观感与稳健度。

---

## 1. Overview（概述）

`aragon` renders its whole conversation through Ink 5 (React reconciler → Yoga
layout → an ANSI frame written to stdout). That architecture is correct and it is
what gives the product its identity: a fixed frame, a bottom-anchored composer, a
live status bar, a todo rail. It has one property that the current code does not
account for: **Ink has no output caching.** Every frame re-walks the entire Ink
DOM, re-measures every text node, and re-serialises the frame. There is no
`shouldComponentUpdate` at the Ink layer, and `overflow: hidden` clips output but
does not skip the work that produced it.

The consequence is that the per-frame cost of the TUI is proportional to **the
total number of characters currently mounted in the transcript**, not to the
number of characters actually visible. During a long agent run the transcript
grows monotonically, the frame budget (33 ms, from `COALESCE_MS` in `App.tsx:163`
and Ink's own `throttle(onRender, 32)` in `ink.js:38`) is exceeded, renders start
queueing behind each other on Node's single thread, and keystrokes queue behind
the renders. That is the 卡顿. Past a threshold the process spends essentially all
of its time in layout and serialisation and stops making progress at all. That is
the 卡死. In inline mode there is a second, sharper failure mode: a single live
entry taller than the terminal trips `ink.js:121`, after which Ink writes
`clearTerminal + <the entire session's static history> + output` **on every
frame** — a write amplification that grows without bound for the rest of the
session.

This specification makes the per-frame cost of the transcript **bounded and
independent of session length**. It does so in five layers that are individually
revertible: bound the view state (L1), memoise the expensive pure work (L2),
virtualise the viewport so off-screen entries are not mounted at all (L3), add an
adaptive render governor so the terminal stays responsive even when a frame is
genuinely expensive (L4), and remove the inline-mode cliff structurally rather
than statistically (L5). L3 is the structural fix; L1/L2 are the cheap wins that
make L3's constants comfortable; L4 is the safety net that turns any residual
pathology from a freeze into a visibly slower — but still interactive — UI; L5
closes a reachable hard-hang.

The aesthetic half of the requirement is served by the same work rather than by a
redesign. Claude Code feels fast for one structural reason: its history is
committed once and only a small live region is repainted. L3 gives this codebase
the same property while keeping the full-screen frame the product already has.
Two small additions make the new behaviour legible instead of mysterious: a
discreet `eco` chip in the status bar whenever the governor has stepped down, and
a `/perf` command that reports exactly what the renderer is doing. Silent
degradation is the one thing a "顶级 / 稳健" claim cannot afford.

---

## 2. Root-cause analysis（根因分析，逐条对源码校验）

Every claim below was checked against the tree at `master` and against
`node_modules/ink@5.2.1`.

### R1 · The whole windowed transcript is a live React + Yoga + Output tree

`TranscriptList` (`ui/Transcript.tsx:237`) renders the last `transcriptWindow`
entries — default **300** (`config/schema.ts:137`) — as real components. The file
already documents *why* the window exists ("yoga lays out every child even when
`overflow: hidden` clips it"), but a count of 300 entries is not a bound on work:
one entry can be fifty thousand lines.

Downstream, `renderNodeToOutput` (`ink/build/render-node-to-output.js`) has **no
early-out for clipped subtrees**. For every `ink-text` node it runs
`squashTextNodes(node)`, `widestLine(text)`, `getMaxWidth(...)` and possibly
`wrapText(...)` — all O(chars) — and only then pushes a write operation.
`Output.get()` (`ink/build/output.js`) then evaluates `widestLine(text)` *again*
before it is allowed to `continue` past an out-of-clip operation. So a clipped
50 000-character entry costs two full string scans per frame and buys nothing.

**Per-frame cost is O(Σ characters mounted), 30×/s.**

### R2 · Markdown is re-parsed and re-highlighted on every render

`Markdown` (`ui/Markdown.tsx:40`) splits the text, regex-parses each line, and
allocates **one React element per line**, on every render. Worse, `CodeBlock`
(`ui/Markdown.tsx:120`) calls `cli-highlight`'s `highlight()` **inside the render
body, unmemoised** — a complete highlight.js tokenise of the whole code block,
every frame, for every code block in the window. A handful of 200-line code
blocks in a session is enough to exceed 33 ms on its own. This is the single
largest constant factor in the current renderer.

The file header claims "the grammar lives in `markdown-blocks.ts`; this file only
renders". That is currently false — the block grammar (fences, tables) is in
`Markdown.tsx`. Fixing R2 also restores the stated separation.

### R3 · No memoisation boundary anywhere in the transcript

`EntryView`, `AssistantEntry`, `ToolCard`, `TeamCard`, `TodoCard` and
`ToolPreview` are plain function components. React re-invokes all of them on
every dispatch — even though `mapEntry` (`agent/reducer.ts:425`) already
**preserves object identity for untouched entries**, which is precisely the input
a `React.memo` comparator needs. The material for cheap memoisation exists and is
unused. Each invocation additionally re-runs `pickGlyphs(caps)` (per entry, per
frame) and `preview.split('\n')` (`ui/entries/ToolCard.tsx:120`).

### R4 · Two full render + layout passes per streaming frame

`ScrollViewport`'s `useLayoutEffect` (`ui/layout/ScrollViewport.tsx:89`) measures
both boxes on **every commit** and calls `setMetrics` whenever the content height
changed — which, while text streams, is every frame. The sequence is therefore
render → Yoga layout → `setState` → render → Yoga layout. The
`onScrolledLinesChange` → `setScrolledLines` path (`App.tsx:1320`) is a third
route into a full `App` re-render. The frame cost established in R1 is paid
roughly twice.

### R5 · The view state is unbounded

`ViewState.entries` is never trimmed. `argsRaw` (`reducer.ts:531`), assistant
`text` (`reducer.ts:506`) and `thinking` (`reducer.ts:495`) concatenate with no
ceiling. A long run therefore grows heap, `/save` payload size, the O(N) cost of
every `mapEntry`, and — because `transcriptWindow` bounds entry *count* only —
the mounted character total from R1. A model that emits a 5 MB answer makes every
subsequent frame a 5 MB scan.

### R6 · Inline mode has a reachable hard-hang

`frame.ts:40` deliberately keeps `frameHeight(r) < r` so the **full-screen** frame
can never trip `ink.js:121`; `frame.test.ts` pins it. Inline mode has no frame at
all. `Transcript` (`ui/Transcript.tsx:277`) keeps `LIVE_TAIL = 1` entry outside
`<Static>`. If that one live entry is taller than the terminal then
`outputHeight >= stdout.rows` and Ink takes the branch at `ink.js:118-123`:

```js
if (outputHeight >= this.options.stdout.rows) {
  this.options.stdout.write(ansiEscapes.clearTerminal + this.fullStaticOutput + output);
  ...
}
```

`fullStaticOutput` accumulates **every `<Static>` frame of the whole session** and
is never trimmed. Once the branch is taken it is taken on every subsequent frame,
bypassing both the `output !== this.lastOutput` dedupe and `throttledLog`. The
terminal then receives the entire session history 30×/s. This is a genuine hard
freeze and it is reachable today by any user in inline mode (`--no-fullscreen`,
`TERM=dumb`, `CI`, a terminal under 12 rows or 40 columns) whose model writes a
long answer.

### R7 · No backpressure anywhere

Neither the coalescer nor Ink adapts when a frame overruns its budget. The
coalescer keeps its 33 ms timer, Ink keeps its 32 ms throttle, and the event loop
saturates. Input handling is not prioritised over rendering because there is
nothing in the system that knows rendering has become expensive.

### Summary table

| # | Location | Cost | Fixed by |
|---|---|---|---|
| R1 | `Transcript.tsx`, ink render pipeline | O(Σ chars mounted) / frame | **L3** |
| R2 | `Markdown.tsx`, `cli-highlight` | O(chars) re-parse + re-highlight / frame | **L2** |
| R3 | all entry components | O(entries) React work / frame | **L2** |
| R4 | `ScrollViewport.tsx` | ×2 render + layout / frame | **L3** |
| R5 | `reducer.ts` | unbounded heap + O(N) maps | **L1** |
| R6 | inline `Transcript` + `ink.js:121` | O(session bytes) written / frame | **L5** |
| R7 | `App.tsx` coalescer | no adaptation under load | **L4** |

---

## 3. Technical design（技术方案）

### 3.1 L1 — Bounded view state

New pure module `agent/entry-limits.ts`:

```ts
export interface EntryLimits {
  /** Assistant answer text ceiling, in characters. */
  text: number;          // 262_144
  /** Assistant thinking ceiling. */
  thinking: number;      //  65_536
  /** Streamed tool-argument JSON ceiling. */
  argsRaw: number;       //  16_384
}
export const ENTRY_LIMITS: EntryLimits;

/** Marker inserted at the elision point. ASCII — produced outside `src/ui/**`. */
export const ELISION_MARK_PREFIX = '\n[... ';
export const ELISION_MARK_SUFFIX = ' characters elided ...]\n';

/**
 * Append `delta` to `prev`, keeping the result at or below `cap` by eliding the
 * MIDDLE. Head and tail are both preserved: the head is the answer's opening,
 * the tail is where the cursor is. Idempotent — re-eliding an already elided
 * string collapses the two markers into one.
 */
export function appendBounded(prev: string, delta: string, cap: number): string;

/** Ring-trim to `retain` entries; returns the same array reference when no-op. */
export function trimEntries(entries: Entry[], retain: number): {
  entries: Entry[];
  dropped: number;
};
```

`reducer.ts` changes:

- `textDelta` / `thinkingDelta` / `toolCallDelta` route through `appendBounded`.
- Every action that **appends** an entry (`submit`, `turnStart`, `toolCallStart`,
  `notice`, `teamStart`, `todoUpdate`'s append branch) applies `trimEntries` and
  accumulates into a new `ViewState.droppedEntries: number`.
- Trimming happens **only at append points**. A mid-turn trim triggered by an
  update action could drop the entry that `streamingId` / `teamEntryId` /
  `todoEntryId` points at while it is still being written to. Appending is the
  only moment at which the tail is by definition the newest thing.

**I-L1-1** — `trimEntries` must never drop an entry whose id is currently held in
`streamingId`, `teamEntryId` or `todoEntryId`. With `retain >= 200` and a trim
that only ever removes from the head this is structurally true, but the reducer
asserts it in development (`if (process.env.NODE_ENV !== 'production')`) because a
future `retain` clamp change would break it silently.

### 3.2 L2 — Memoisation

New module `ui/render-cache.ts` — a small bounded LRU plus four typed accessors.
All caches are **module-level** (shared across component instances and across
mount/unmount cycles) and all are bounded by both entry count and an approximate
byte budget:

```ts
export const RENDER_CACHE_LIMITS = {
  highlightEntries: 128,
  highlightBytes: 2 * 1024 * 1024,
  /** Above this, skip highlighting entirely: highlight.js is superlinear. */
  highlightMaxChars: 20_000,
  markdownEntries: 256,
  markdownBytes: 4 * 1024 * 1024,
  linesEntries: 512,
} as const;

export function highlightCached(code: string, lang: string): string;
export function parseMarkdownCached(text: string): MdBlock[];
export function splitLinesCached(text: string): readonly string[];
export function glyphsFor(caps: TermCapabilities): Glyphs;
export function clearRenderCaches(): void;
export function renderCacheStats(): RenderCacheStats;   // for `/perf`
```

`markdown-blocks.ts` gains the block grammar that currently lives in
`Markdown.tsx` and exports it as a pure function:

```ts
export type MdBlock =
  | { kind: 'code'; code: string; lang: string }
  | { kind: 'table'; rows: string[][]; align: Align[] }
  | { kind: 'line'; text: string };

export function parseMarkdownBlocks(text: string): MdBlock[];
```

`Markdown.tsx` is reduced to `parseMarkdownCached(text).map(renderBlock)`.
`CodeBlock` calls `highlightCached`. **Theme and glyphs are applied at render
time, never cached** — caching a themed React element would make `/theme` a
no-op until the cache evicted, which is exactly the class of silent bug this
codebase writes comments to avoid.

`React.memo` boundaries with explicit comparators:

| Component | Comparator |
|---|---|
| `EntryView` | `prev.entry === next.entry && prev.prev === next.prev && prev.expanded === next.expanded && prev.thinkingVisible === … && prev.reducedMotion === … && prev.density === … && prev.theme === … && prev.caps === …` |
| `ToolCard`, `TeamCard`, `TodoCard`, `AssistantEntry`, `UserEntry` | default shallow compare (all props are scalars or stable references) |

**I-L2-1** — `theme` and `caps` are `useMemo`d in `App.tsx:214-222` and are
therefore referentially stable across frames. If a future change makes either a
fresh object per render, every memo boundary in the table above becomes a no-op
*and nothing fails*. `render-memo.test.tsx` asserts referential stability of both
across a re-render, so the trap is a red test rather than a silent regression.

### 3.3 L3 — Viewport virtualisation（核心结构性修复）

The goal: entries outside the visible window are **not mounted**. They are
replaced by two spacer boxes whose heights come from a height cache.

#### 3.3.1 Height model

```ts
// ui/layout/virtual-window.ts — pure, React-free, unit-tested
export type HeightKey = string;   // `${id}|${rev}|${cols}|${expanded}|${density}`

/** Cheap content version: changes exactly when rendered content changes. */
export function entryRevision(entry: Entry): string;

export function heightKey(
  entry: Entry, cols: number, expanded: boolean, density: DensityMode,
): HeightKey;

/** Pure upper-bound estimate, used until a real measurement exists. */
export function estimateEntryRows(
  entry: Entry, cols: number, density: DensityMode, expanded: boolean,
): number;

export interface WindowSelection {
  startIndex: number;      // inclusive
  endIndex: number;        // exclusive
  leadingRows: number;     // spacer above
  trailingRows: number;    // spacer below
  totalRows: number;
}

export function selectWindow(input: {
  entries: Entry[];
  heightOf: (index: number) => number;
  viewportRows: number;
  /** Rows hidden BELOW the viewport — the existing `scroll.ts` semantic. */
  offset: number;
  overscan: number;
}): WindowSelection;
```

`entryRevision` is derived, not hashed — hashing a 256 KiB string per frame would
recreate the problem it exists to solve:

| kind | revision |
|---|---|
| `user` | `'u'` (immutable after creation) |
| `notice` | `'n'` |
| `assistant` | `` `a${text.length}.${thinking?.length ?? 0}.${streaming?1:0}.${aborted?1:0}` `` |
| `tool` | `` `t${status}.${argsRaw.length}.${preview?.length ?? 0}.${durationMs ?? -1}` `` |
| `team` | `` `m${active?1:0}.${runs.length}.${runs.map(r=>r.phase[0]).join('')}.${runs.reduce((a,r)=>a+r.toolCalls,0)}` `` |
| `todo` | `` `d${live?1:0}.${doneCount}.${total}.${items.length}` `` |

**I-L3-1** — `entryRevision` must change whenever the rendered output changes.
The only lossy case is a same-length text replacement, which the reducer cannot
produce (all text fields are append-only). A future non-append mutation **must**
extend the revision. `virtual-window.test.ts` enumerates every `Entry` kind and
asserts that each mutating reducer action changes the revision.

#### 3.3.2 Where the numbers come from

`ScrollViewport` already owns `viewport`, `content` and `offset` and its header
documents (P1-7) why that ownership must not be duplicated in the parent. So it
*publishes* rather than lifts:

```ts
export interface ViewportGeometry { viewportRows: number; offset: number; contentRows: number; }
export const ViewportGeometryContext: React.Context<ViewportGeometry>;
```

`ScrollViewport` provides a `useMemo`d value; `TranscriptList` consumes it. No
new state, no new owner, no measure→setState→measure loop added.

#### 3.3.3 Render shape

```tsx
<Box flexDirection="column" flexShrink={0}>
  {collapsedNotice}
  {leadingRows > 0 && <Box flexShrink={0} height={leadingRows} />}
  {slice.map(entry => (
    <MeasuredEntry key={entry.id} heightKey={…} onMeasure={report}>
      <EntryView … />
    </MeasuredEntry>
  ))}
  {trailingRows > 0 && <Box flexShrink={0} height={trailingRows} />}
</Box>
```

`MeasuredEntry` (`ui/layout/MeasuredEntry.tsx`) is a `<Box flexDirection="column"
flexShrink={0} ref={…}>` plus a `useLayoutEffect` that calls
`measureElement(ref.current).height` and reports it. It **must not** constrain
height — the natural height is the value being measured.

`useHeightStore` (`ui/use-height-store.ts`) holds the map in a **ref**, and bumps
a `useState` version at most once per frame (coalesced through
`queueMicrotask`) and only when a value actually changed. Steady state — settled
entries at a fixed width — produces zero extra renders.

#### 3.3.4 Invariants

- **V-1** A spacer is exactly one `ink-box` with `height` and `flexShrink={0}`
  and **no children**. A child re-introduces the per-frame cost the spacer
  exists to remove.
- **V-2** `overscan >= 2` entries on each side, so a one-row scroll can never
  expose an unmeasured entry at the edge.
- **V-3** While `offset === 0` the **last** entry is always inside the window,
  whatever its height. The live tail must be real content, never a spacer —
  otherwise a streaming answer would render as a growing blank rectangle.
- **V-4** `offset` counts rows **from the bottom** (`layout/scroll.ts:1-13`).
  This is what makes virtualisation safe here for free: a height correction on an
  entry *above* the viewport changes `content` and therefore `overflowLines`,
  while `offset` — and hence what the user is looking at — is unchanged. No
  scroll-anchoring compensation pass is required. Do not "simplify" `offset` to
  count from the top.
- **V-5** A `cols` change invalidates every height key (`cols` is part of the
  key). The frame after a resize renders from estimates and re-measures lazily.
  One reflow, no crash, no stale layout.
- **V-6** The *measured* content height is authoritative for scrolling:
  `measureElement(innerRef)` sees `leadingRows + Σ natural heights of the slice +
  trailingRows`. When a cached estimate for an off-screen entry is wrong, the
  discrepancy is bounded by that entry's estimation error and resolves the frame
  after it is measured. This is ordinary virtualisation jitter and is
  acceptable; it is called out here so nobody "fixes" it by forcing rendered
  entries to their cached height (which would clip real content).

#### 3.3.5 What `transcriptWindow` now means

Unchanged in kind, changed in scale. It remains the **scroll horizon**: entries
older than it are not reachable inside the app and the existing "N earlier
entries collapsed (/save exports the full session)" line remains their boundary.
Because they are no longer laid out, the default rises **300 → 1000** and the
clamp ceiling **2000 → 20000**. No config migration is required: an existing
persisted `300` is still valid and still clamps.

### 3.4 L4 — Adaptive render governor

`ui/render-governor.ts` — pure:

```ts
export const GOVERNOR_LADDER = [33, 50, 80, 125, 200, 320] as const;
/** Step up when a commit costs more than this fraction of the interval. */
export const GOVERNOR_UP_RATIO = 0.7;
/** Consecutive cheap frames required before stepping back down. */
export const GOVERNOR_DOWN_STREAK = 8;

export interface GovernorState { rung: number; cheapStreak: number; }
export function initialGovernor(): GovernorState;
export function stepGovernor(
  state: GovernorState, lastCommitMs: number, maxIntervalMs: number,
): GovernorState;
export function intervalOf(state: GovernorState, maxIntervalMs: number): number;
```

`ui/use-render-governor.ts` measures commit cost with `performance.now()` taken
at the top of the `App` render body and again in a `useLayoutEffect` at the
bottom. That span covers React reconciliation **and** Ink's Yoga layout, because
Ink computes layout in `onRender`, which React runs before layout effects — the
same mechanism `ScrollViewport.tsx:87-88` and `AppShell.tsx:100-102` already
document and rely on. It does **not** cover Ink's serialisation and the stdout
write, which happen after; the doc must not claim otherwise. In practice layout
dominates, and the ladder's job is direction, not accuracy.

`App.tsx`'s coalescer replaces the `COALESCE_MS` constant with
`governorRef.current.intervalMs`.

**I-L4-1** — The governor changes **only how often** the view updates, never what
is dispatched, never the order, never the final state. `mergeDeltas`
(`agent/coalesce.ts:22`) already guarantees that a longer window is simply a
larger merge and that non-delta actions flush first. `render-governor.test.ts`
asserts that the same event sequence produces the same final `ViewState` at every
rung.

**I-L4-2** — The governor is user-visible. At any rung above 0 the status bar
shows a muted `eco` chip. Degrading silently is not acceptable: a user who cannot
see why the stream got chunkier will conclude the model got slower.

Kill switches: `renderGovernor: false` in config, `--no-render-governor`, or
`ARAGON_RENDER_GOVERNOR=0`. `maxRenderIntervalMs = 33` also flattens the ladder.

### 3.5 L5 — Removing the inline cliff

`ui/live-clamp.ts`:

```ts
export interface LiveClamp { text: string; hiddenRows: number; }
/** Keep the LAST `maxRows` rows of `text`; report how many were dropped. */
export function clampLiveText(text: string, maxRows: number): LiveClamp;
```

`Transcript` (inline branch) computes `liveClampRows = Math.max(4, rows - 4)` and
passes it to the entries it renders **outside** `<Static>`. `AssistantEntry` and
`ToolCard` accept `liveClampRows?: number`; `undefined` means no clamp, which is
what the full-screen branch passes, so full-screen output is byte-identical.
A clamped entry shows one head marker: `... N earlier lines · shown in full when
this entry finishes`. When the entry settles it moves into `<Static>` and is
printed **in full** — nothing is lost, only deferred.

**I-L5-1** — In inline mode, the height of the live (non-`Static`) region must
stay strictly below `stdout.rows`. This makes `ink.js:121` unreachable, which
makes the O(session-bytes)-per-frame write structurally impossible rather than
statistically unlikely. This is the inline analogue of `frame.ts`'s
`frameHeight(r) < r` and deserves the same standing. `inline-live-clamp.test.tsx`
renders a 5 000-line entry into an 24-row inline transcript and asserts the live
region height.

We cannot bound Ink's `fullStaticOutput` growth — it is private and append-only.
Preventing the branch that *writes* it is the entire mitigation, and this
document says so plainly rather than implying the memory is bounded.

### 3.6 Sequence — one streaming frame, after the change

```
provider SSE  ─▶ core Agent ─▶ controller.subscribe callback
                                   │
                                   ├─ delta?  → pending.push(action)          (no render)
                                   │            arm timer at governor interval
                                   └─ other?  → flushPending(); dispatch(action)

timer fires (33 … 320 ms)
  └─ mergeDeltas(pending) → 1 dispatch
       └─ viewReducer: appendBounded + trimEntries         O(entries) once
            └─ React render:
                 EntryView memo skips every settled entry  O(1) each
                 TranscriptList: selectWindow(...)          O(entries) arithmetic
                   → 2 spacers + ~viewportRows worth of real entries
                 Markdown: parseMarkdownCached hit          O(1) for settled text
                 CodeBlock: highlightCached hit             O(1) for settled code
            └─ Ink: Yoga layout over the mounted tree only  O(visible)
            └─ renderNodeToOutput + Output.get              O(visible)
            └─ log-update eraseLines + write                O(frame)
  └─ useLayoutEffect: commit ms → stepGovernor
  └─ MeasuredEntry layout effects → height store (ref) → at most one extra render
```

---

## 4. File / module change plan（文件与模块变更计划）

### 4.1 New files

| File | Intent |
|---|---|
| `packages/cli/src/agent/entry-limits.ts` | `ENTRY_LIMITS`, `appendBounded`, `trimEntries` — pure state bounds (L1). |
| `packages/cli/src/ui/render-cache.ts` | Bounded LRU + `highlightCached` / `parseMarkdownCached` / `splitLinesCached` / `glyphsFor` / `renderCacheStats` (L2). |
| `packages/cli/src/ui/layout/virtual-window.ts` | Pure `entryRevision` / `heightKey` / `estimateEntryRows` / `selectWindow` + `VIRTUAL_LIMITS` (L3). |
| `packages/cli/src/ui/layout/MeasuredEntry.tsx` | Height-reporting wrapper around one `EntryView` (L3). |
| `packages/cli/src/ui/use-height-store.ts` | Ref-backed height map with a once-per-frame version bump (L3). |
| `packages/cli/src/ui/layout/viewport-geometry.ts` | `ViewportGeometryContext` + `useViewportGeometry()` (L3). |
| `packages/cli/src/ui/render-governor.ts` | Pure ladder: `stepGovernor` / `intervalOf` / constants (L4). |
| `packages/cli/src/ui/use-render-governor.ts` | Commit timing hook; owns the interval used by the coalescer (L4). |
| `packages/cli/src/ui/live-clamp.ts` | `clampLiveText` for the inline live region (L5). |
| `packages/cli/src/commands/perf.ts` | `/perf` and `/perf reset` implementation. |

### 4.2 Modified files

| File | Intent |
|---|---|
| `packages/cli/src/agent/reducer.ts` | Route delta appends through `appendBounded`; ring-trim on append; add `droppedEntries` to `ViewState` and `initialViewState()`. |
| `packages/cli/src/ui/Transcript.tsx` | `EntryView` becomes `React.memo` + exported; `TranscriptList` virtualises through `selectWindow` + spacers + `MeasuredEntry`; inline `Transcript` passes `liveClampRows`. |
| `packages/cli/src/ui/Markdown.tsx` | Parse via `parseMarkdownCached`; highlight via `highlightCached`; block grammar removed (moved to `markdown-blocks.ts`). |
| `packages/cli/src/ui/markdown-blocks.ts` | Gains `MdBlock` + `parseMarkdownBlocks` (fences, tables, lines) — restores the separation its own header claims. |
| `packages/cli/src/ui/entries/AssistantEntry.tsx` | `React.memo`; `splitLinesCached` for thinking; `liveClampRows` support; clamp the thinking block to its tail while streaming. |
| `packages/cli/src/ui/entries/ToolCard.tsx` | `React.memo`; `splitLinesCached` for `preview`; `liveClampRows` support. |
| `packages/cli/src/ui/entries/ToolPreview.tsx` | Accept pre-split `readonly string[]`; no behaviour change. |
| `packages/cli/src/ui/entries/TeamCard.tsx`, `TodoCard.tsx`, `UserEntry.tsx` | `React.memo` (default comparator). |
| `packages/cli/src/ui/layout/ScrollViewport.tsx` | Provide `ViewportGeometryContext`; skip the content `measureElement` when neither the height-store version nor `cols` changed (kills R4's second pass). |
| `packages/cli/src/ui/App.tsx` | Wire `useRenderGovernor` into the coalescer; own the height store; pass `ecoRung` to `StatusBar`; expose perf stats to `/perf`. |
| `packages/cli/src/ui/StatusBar.tsx` | Muted `eco` chip when `ecoRung > 0`; suppressed on narrow terminals. |
| `packages/cli/src/ui/transcript-text.ts` | Emit a leading `N earlier entries dropped by transcriptRetain` line when `droppedEntries > 0`, so `/save` and the exit transcript stay honest. |
| `packages/cli/src/commands/builtins.ts` | Register `/perf`. |
| `packages/cli/src/config/schema.ts` | `transcriptRetain`, `renderGovernor`, `maxRenderIntervalMs` + clamps; raise `DEFAULT_TRANSCRIPT_WINDOW` to 1000 and `MAX_TRANSCRIPT_WINDOW` to 20000. |
| `packages/cli/src/config/load.ts` | Resolve the three new keys through the existing merge order. |
| `packages/cli/src/config/env.ts` | `ARAGON_TRANSCRIPT_RETAIN`, `ARAGON_RENDER_GOVERNOR`, `ARAGON_MAX_RENDER_INTERVAL_MS`. |
| `packages/cli/src/cli.tsx` | `--transcript-retain`, `--no-render-governor`, `--max-render-interval` flags; add the three keys to the `config set` allow-list. |
| `packages/cli/README.md` | Document the three keys, `/perf`, and the `eco` chip. |
| `packages/cli/CHANGELOG.md` | Release note. |

### 4.3 New tests

| File | Covers |
|---|---|
| `__tests__/entry-limits.test.ts` | `appendBounded` head/tail retention, idempotent re-elision, cap boundaries; `trimEntries` identity return on no-op. |
| `__tests__/render-cache.test.ts` | LRU eviction by count and by bytes; `highlightMaxChars` bypass; `clearRenderCaches`; identical input ⇒ identical reference. |
| `__tests__/virtual-window.test.ts` | `entryRevision` changes for every mutating action on every kind (I-L3-1); `selectWindow` boundaries, overscan, V-3 pinning; `estimateEntryRows` monotone in `cols`. |
| `__tests__/transcript-virtual.test.tsx` | 5 000-entry transcript mounts `<= viewportRows + 2·overscan` entries; spacers are childless (V-1); the last entry is always mounted when pinned (V-3). |
| `__tests__/render-budget.test.tsx` | Ink DOM `ink-text` node count is bounded and does **not** grow with entry count — the regression gate for R1. |
| `__tests__/render-memo.test.tsx` | `theme` / `caps` referential stability (I-L2-1); a `textDelta` re-renders exactly one `EntryView`. |
| `__tests__/render-governor.test.ts` | Ladder up/down with hysteresis; clamp to `maxRenderIntervalMs`; identical final `ViewState` at every rung (I-L4-1). |
| `__tests__/live-clamp.test.ts` + `__tests__/inline-live-clamp.test.tsx` | `clampLiveText` row accounting; inline live region height `< rows` (I-L5-1). |
| `__tests__/perf-command.test.ts` | `/perf` output shape; `/perf reset` clears caches and the governor. |

Existing tests expected to need updates: `transcript-static.test.ts` (settled
boundary unchanged, but `EntryView` is now memoised), `reducer.test.ts` (new
`droppedEntries` field in `initialViewState`), `config.test.ts` and
`config-purity.test.ts` (three new keys), `scroll.test.ts` (unchanged — the
scroll model is deliberately untouched).

---

## 5. Interface design（接口设计）

### 5.1 Configuration keys

| Key | Type | Default | Clamp | Meaning |
|---|---|---|---|---|
| `transcriptWindow` | number | **1000** (was 300) | [50, **20000**] | Entries reachable by scrolling; older ones show the "collapsed" line. |
| `transcriptRetain` | number | 1000 | [200, 20000] | Entries kept in `ViewState`; older ones are dropped and counted. |
| `renderGovernor` | boolean | `true` | — | Adaptive coalescing under load. |
| `maxRenderIntervalMs` | number | 320 | [33, 1000] | Ceiling of the governor ladder; `33` flattens it. |

`transcriptRetain` is clamped to be `>= transcriptWindow` at resolve time —
retaining fewer entries than the window can scroll to would silently make the
window unreachable. Reported once as a startup notice when the user's own values
conflict.

### 5.2 CLI flags

```
--transcript-retain <n>        # ViewState ring cap
--no-render-governor           # disable adaptive coalescing
--max-render-interval <ms>     # governor ceiling
```

### 5.3 Environment overrides

`ARAGON_TRANSCRIPT_RETAIN`, `ARAGON_RENDER_GOVERNOR`,
`ARAGON_MAX_RENDER_INTERVAL_MS` — same precedence as the existing 21
`ARAGON_*` overrides (flags > env > file > defaults).

### 5.4 Slash command

```
/perf            render stats
/perf reset      clear render caches + reset the governor to rung 0
```

Output (one block, `theme.muted`, no colour dependency):

```
render     rung 2  ·  interval 80ms  ·  last commit 61ms  ·  eco
transcript 4213 entries  ·  1000 retained  ·  3213 dropped  ·  38 mounted
heights    412 cached  ·  6 estimated  ·  cols 132
caches     md 178/256 (1.9MB)  ·  hl 96/128 (1.4MB)  ·  lines 340/512
mode       fullscreen  ·  viewport 44 rows  ·  offset 0
```

`/perf` is read-only and allocation-light; it must not itself be a source of
render cost (it renders as a notice entry, not a live panel).

### 5.5 Internal TypeScript contracts

Full signatures are given inline in §3.1 – §3.5. Two are load-bearing enough to
restate as public contracts of this feature:

```ts
// virtual-window.ts — the only place window arithmetic lives.
export function selectWindow(input: {
  entries: Entry[];
  heightOf: (index: number) => number;   // measured, else estimated; never 0
  viewportRows: number;
  offset: number;                         // rows hidden BELOW the viewport
  overscan: number;                       // >= 2
}): WindowSelection;

// render-governor.ts — the only place the frame interval is decided.
export function stepGovernor(
  state: GovernorState, lastCommitMs: number, maxIntervalMs: number,
): GovernorState;
```

No REST, WebSocket or IPC surface exists in this package; there is nothing to
version.

---

## 6. Data model（数据模型）

No database, no persisted schema change beyond three scalar config keys.

### 6.1 `ViewState` delta

```ts
export interface ViewState {
  // … unchanged …
  /** Entries removed by `transcriptRetain`. Rendered by transcript-text; never persisted. */
  droppedEntries: number;
}
```

`droppedEntries` is **not** written to session files. `SavedSession` keeps
`{ model, messages, entries, todos }` exactly as it is today, so `/save` and
`/resume` need no format change and old session files load unchanged.

### 6.2 In-memory shapes (all process-local, none persisted)

```ts
// use-height-store.ts
interface HeightStore {
  map: Map<HeightKey, number>;   // bounded to VIRTUAL_LIMITS.heightEntries (4096, LRU)
  version: number;               // bumped ≤ 1× per frame, only on a real change
}

// render-cache.ts
interface LruCache<V> { map: Map<string, V>; bytes: number; }   // insertion-ordered LRU

// use-render-governor.ts
interface GovernorRuntime { rung: number; cheapStreak: number; intervalMs: number; lastCommitMs: number; }
```

**Memory ceiling, stated explicitly** (default config, 132 columns):
`transcriptRetain` 1000 entries × `ENTRY_LIMITS` worst case is a theoretical
upper bound nobody reaches; the practical bound that matters is that a single
entry can no longer exceed 256 KiB + 64 KiB + 16 KiB, and the caches are capped
at 2 MiB (highlight) + 4 MiB (markdown) + 4096 height numbers. The renderer's
working set is therefore bounded by construction, which is the property R5
removed.

---

## 7. Testing & acceptance criteria（测试与验收标准）

### 7.1 Acceptance criteria

| # | Criterion | How it is verified |
|---|---|---|
| AC-1 | Mounted `ink-text` node count does not grow with transcript length. | `render-budget.test.tsx`: 100 vs 5 000 entries, node count within ±10 %. |
| AC-2 | A `textDelta` re-renders exactly one `EntryView`. | `render-memo.test.tsx` with a render counter per entry. |
| AC-3 | `highlight()` is called once per distinct `(code, lang)`, not once per frame. | `render-cache.test.ts` with a spied `cli-highlight`. |
| AC-4 | Scroll behaviour is unchanged: `scroll.test.ts` and `scroll-indicator.test.ts` pass **without modification**. | CI. |
| AC-5 | In inline mode the live region is strictly shorter than `stdout.rows` for a 5 000-line entry. | `inline-live-clamp.test.tsx` (I-L5-1). |
| AC-6 | Governor rungs do not change the final `ViewState` for a fixed event sequence. | `render-governor.test.ts` (I-L4-1). |
| AC-7 | `appendBounded` never exceeds its cap and never loses the tail. | `entry-limits.test.ts`. |
| AC-8 | A default-config session with `transcriptWindow` unset behaves identically to today except for the raised horizon. | `config.test.ts` + manual test #1. |
| AC-9 | `/perf` reports the same `mounted` count that `render-budget.test.tsx` asserts. | `perf-command.test.ts`. |
| AC-10 | `--no-render-governor` + `transcriptRetain=20000` reproduces pre-change *semantics* (not performance). | manual test #8. |
| AC-11 | Every existing CLI test passes, `npm run typecheck` clean on both tsconfigs. | CI. |
| AC-12 | ASCII-only rule for `src/ui/**` still holds; every new glyph comes from `pickGlyphs`. | `glyphs.test.ts` (existing gate). |

### 7.2 Performance targets

Measured on the reference workload — a scripted session replayed through the
existing `ink-testing-library` harness: **400 entries, 2 of them 3 000-line bash
outputs, 6 fenced code blocks of 200 lines each, one 40 000-character assistant
answer**, at 120 columns × 45 rows.

| Metric | Before (measured baseline) | Target |
|---|---|---|
| Median commit time while streaming | to be recorded in the review pass | **< 16 ms** |
| p99 commit time | — | **< 50 ms** |
| Commit time at 5 000 entries ÷ commit time at 100 entries | — | **< 1.2×** |
| Keystroke → echo latency while streaming | — | **< 100 ms** |
| RSS growth over a 2-hour synthetic run | — | **bounded** (no monotonic trend) |

The baseline column is deliberately empty: it is the **first task of the
implementation node** to record it with `/perf` before touching anything, because
a performance spec whose "before" numbers were guessed cannot prove it succeeded.

### 7.3 Manual test plan

Lives in `docs/plans/tui-render-performance/manual-test.md` (authored alongside
implementation). Minimum set:

1. 300-turn session, scroll to top and back — smooth, no jump, `↑N` correct.
2. `cat` a 50 000-line file through `bash` — no freeze; card collapses to 8 lines;
   `Ctrl+O` expands without stalling.
3. Ask for a 3 000-line code answer — streaming stays responsive; `eco` chip
   appears; typing in the composer echoes immediately.
4. Same as 3 in `--no-fullscreen` — no full-screen clear/flicker, no hang.
5. Resize the terminal mid-stream — one reflow, correct geometry, no crash.
6. `/theme` switch with a long transcript — colours change immediately (proves
   the caches are not theme-poisoned).
7. `Ctrl+C` during the worst frame — abort is honoured within one frame.
8. `--no-render-governor` — identical output, just heavier.
9. `/save` then `/resume` a session longer than `transcriptRetain` — the dropped
   count is reported and nothing is silently missing.
10. `TERM=dumb` and a 10-row terminal — inline path, no cliff.

---

## 8. Risks & mitigations（风险与缓解）

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| K-1 | **Virtualisation jitter**: a wrong height estimate makes the transcript shift when an old entry scrolls into view. | High (UX) | V-4 makes `offset` bottom-anchored so the visible content does not move; `estimateEntryRows` is near-exact for plain text; overscan ≥ 2 hides the correction frame. Manual test #1. |
| K-2 | **Measure → setState loop** in the height store never converges. | High (hang) | Heights change only on content or `cols` change; the version bump is coalesced to once per frame and fires only on a real delta; `transcript-virtual.test.tsx` asserts a bounded render count for a static transcript. |
| K-3 | **Memo comparator drift**: a future change makes `theme`/`caps` unstable and every memo silently no-ops. | High (silent) | I-L2-1 + `render-memo.test.tsx` assert referential stability directly. |
| K-4 | **`entryRevision` misses a mutation**, freezing a stale height and a stale rendered subtree. | High (silent) | I-L3-1 + a test that enumerates every `Entry` kind × every mutating action. |
| K-5 | **Cache poisoning across themes** — a themed element cached and reused after `/theme`. | Medium | Only the *AST* and the *highlighted string* are cached; theme is applied at render time. Manual test #6. `cli-highlight` output does embed colour, but it is chalk-level ANSI independent of `theme.*`, exactly as today. |
| K-6 | **`transcriptRetain` drops history a user wanted**, and `/save` then writes a truncated session. | Medium | Default 1000 ≫ a typical session; the drop is *counted and reported* in `/perf` and in the exported transcript; raisable to 20000. Never silent. |
| K-7 | **Governor makes the UI feel laggy** rather than merely chunky. | Medium | Ceiling 320 ms; `GOVERNOR_DOWN_STREAK` returns to 33 ms within ~1 s of the load ending; visible `eco` chip; single-flag kill switch. |
| K-8 | **Inline clamp hides output** the user needed to see live. | Medium | Nothing is lost — the entry prints in full into `<Static>` the moment it settles; the head marker states the count and the rule. |
| K-9 | **Ink upgrade changes the render pipeline** and invalidates the analysis in §2. | Medium | `ink` is pinned by `package-lock.json`; `render-budget.test.tsx` is a behavioural gate that fails on any regression regardless of cause; §2 cites file:line so the next reader can re-verify in minutes. |
| K-10 | **Scope creep into a UI redesign.** | Medium | Non-goals in §9 are explicit; the only visual additions are the `eco` chip, the inline clamp marker, and `/perf`. |
| K-11 | Spacer boxes interact badly with `Gutter`'s `flexShrink={0}` invariant (I-2) and break content measurement. | Medium | Spacers are siblings of entries, not children of `Gutter`; `transcript-virtual.test.tsx` asserts `overflowLines > 0` for an overflowing transcript — the exact symptom I-2 exists to catch. |
| K-12 | **Full-screen frame invariant** `frameHeight(r) < r` accidentally broken by the new spacers. | High | Spacers live **inside** `ScrollViewport`, which is inside a fixed-height `overflow: hidden` box; the root output height is unchanged. `frame.test.ts` still pins the invariant. |

---

## 9. Non-goals（非目标）

1. No change to `@aragon-agent/core` — the engine, the providers, the tool
   executor and the event stream are out of scope.
2. No replacement of Ink, no custom terminal renderer, no rewrite of the entry
   components into a string rasteriser. Both were considered (§10) and rejected
   for this iteration.
3. No visual redesign: palettes, glyphs, densities, the rail, the header and the
   composer are untouched.
4. No change to the scroll model, the wheel routing, or the overlay system.
5. No change to session file format, and no config migration.
6. No search / find-in-transcript, no transcript persistence to disk beyond the
   existing `/save`.

---

## 10. Alternatives considered（备选方案）

**A. Do only L1 + L2 (bounds + memoisation).** Cheapest and safest. Rejected as
insufficient: React memoisation does not stop `renderNodeToOutput` from walking
the Ink DOM, so a single 3 000-line entry still costs a full string scan per
frame. It fixes the common case and leaves the reported failure mode intact.

**B. Rasterise entries to ANSI rows and render one `<Text>` per visible row.**
The theoretically ideal answer: per-frame cost becomes exactly O(viewport rows).
Rejected for this iteration because it requires reimplementing `ToolCard`,
`TeamCard`, `TodoCard`, `Markdown` and `EntryFrame` outside React — a rewrite of
the entire presentation layer, with wrapping, ANSI slicing and glyph-width
handling re-derived by hand. L3 achieves the same asymptotics with the existing
components. B remains the right escalation if L3's constants prove too large.

**C. Adopt Claude Code's model wholesale: inline `<Static>` only, drop the
full-screen frame.** Structurally the simplest and the most robust — the terminal
owns scrollback. Rejected because the fixed frame, the status bar and the todo
rail are the product's identity, and the codebase has already paid for them
(`frame.ts`, `budget.ts`, `AppShell.tsx`, the wheel router). L3 buys the same
per-frame boundedness without giving them up. The *lesson* from Claude Code —
never re-render what is already settled — is exactly what L2 and L3 implement.

**D. Move rendering off the main thread (worker).** Ink, Yoga and stdout all live
on the main thread; a worker would have to own the whole UI. Disproportionate.

---

## 11. Implementation order（实施顺序）

Each step is independently shippable and independently revertible.

1. **L1** `entry-limits.ts` + reducer bounds + tests. No visual change.
2. **Baseline measurement** — record §7.2's "before" column with a temporary
   `/perf`. This must happen after L1 (so the harness is stable) and before L3.
3. **L2** `render-cache.ts`, `markdown-blocks.ts` grammar move, memo boundaries.
   Expected to be the largest single constant-factor win; measure again.
4. **L5** `live-clamp.ts` + inline clamp. Small, and it closes a hard-hang, so it
   should not wait behind the largest change.
5. **L3** `virtual-window.ts`, `MeasuredEntry`, `use-height-store`,
   `viewport-geometry`, `TranscriptList` rewrite, `ScrollViewport` measure
   short-circuit. The one step that needs the full manual test pass.
6. **L4** governor + `eco` chip.
7. Config keys, flags, env, `/perf`, README, CHANGELOG.
8. Final measurement against §7.2; record the result in this document.

---

## 12. Open questions for the review node（评审待决问题）

1. Is raising `DEFAULT_TRANSCRIPT_WINDOW` 300 → 1000 in the same change as the
   virtualisation acceptable, or should it ship one release later so a
   virtualisation regression is not confounded with a horizon change?
2. `GOVERNOR_LADDER`'s top rung is 320 ms. Is a 3 fps worst case the right
   trade against "always interactive", or should the ceiling be 200 ms?
3. Should `transcriptRetain` dropping entries also drop the corresponding
   `messages` in the controller (keeping the model's context and the visible
   transcript in step), or must they stay independent as they are today?
   The current answer in this design is **independent** — `/clear` already
   establishes that the transcript and the conversation are separable — but it is
   worth an explicit ruling.
4. `/perf` as a notice entry vs. a proper overlay. This design chooses the
   notice for cost reasons; an overlay would be prettier.

---

## 13. 实施过程发现的方案缺陷（Issues Found During Implementation）

Recorded by the implementation node, per its constraint not to deviate silently.
Each entry states the design's claim, what the code showed, and what was built
instead. All five are implemented as described here; the surrounding sections
above are left as they were written.

### IF-1 · §4.2's `ScrollViewport` measure short-circuit is unsafe, and its premise is wrong

**The design says**: "skip the content `measureElement` when neither the
height-store version nor `cols` changed (kills R4's second pass)".

**What the code shows**: R4's second pass is `measure → setState → render →
layout`, and the expensive half is the *render*, not the measure.
`measureElement` reads `yogaNode.getComputedHeight()` on a layout Ink has
**already** computed in `onRender`; it is O(1) and allocates one object. Skipping
it therefore saves two property reads per commit and does not remove a single
render — `setMetrics` already returns `prev` unchanged when nothing moved, which
is what actually suppresses the second pass in steady state.

Worse, the proposed gate cannot be made correct as specified. `useHeightStore`
coalesces its version bump through `queueMicrotask`, and `MeasuredEntry`'s layout
effect runs *before* `ScrollViewport`'s (children first). The version a parent
layout effect can observe is therefore always one commit behind the measurement
that caused it, so a gate keyed on it either lags by a frame or — for any content
change that resolves to the same measured height set — never fires at all. A
stale `metrics.content` means a permanently wrong `overflowLines`, i.e. scrolling
silently stops working: exactly the failure mode `Gutter`'s I-2 comment exists to
prevent, and the one AC-4 is written to protect.

**Built instead**: `ScrollViewport` keeps measuring both boxes on every commit
and keeps the existing `setMetrics` identity check. It gains only the
`ViewportGeometryContext` provider §3.3.2 calls for. R4's cost is addressed where
it is actually paid — the content height now changes because *one* measured entry
changed rather than because the whole transcript was re-laid-out, so the second
pass is over a bounded tree.

### IF-2 · `heightKey` needs a fifth input: `thinkingVisible`

**The design says**: `HeightKey = ${id}|${rev}|${cols}|${expanded}|${density}`.

**What the code shows**: `Ctrl+T` toggles `thinkingVisible` globally, and
`AssistantEntry` renders or omits the whole thinking block on it. None of the
five listed components change, so every cached height for every assistant entry
would survive a toggle unchanged. The visible band re-measures immediately (those
entries are mounted), but the spacers would keep the pre-toggle totals for every
entry above and below, so the scroll extent would be wrong until the user
scrolled each one back into view.

**Built instead**: `heightKey(entry, cols, expanded, density, flags = '')`, with
`TranscriptList` passing `thinkingVisible ? 't' : ''`. A parameter rather than a
sixth positional scalar so the next render-affecting switch costs one character
at the call site. `reducedMotion` deliberately does **not** join it: it changes a
spinner glyph, never a row count.

### IF-3 · I-L5-1 does not hold with a flat per-entry clamp

**The design says**: `liveClampRows = Math.max(4, rows - 4)`, justified by
`LIVE_TAIL = 1`.

**What the code shows**: `computeSettledCount` stops at the *first* unsettled
entry, and five separate conditions hold it back — an expanded card, a streaming
assistant, a running tool, an active dispatch, a live todo card. `LIVE_TAIL` is
the *floor* on the live region, not a bound on it. With six live entries a flat
`rows - 4` ceiling yields `6 × (rows - 4)` rows and I-L5-1 fails by a factor of
six, which was reproduced directly (30 rows in a 24-row terminal).

**Built instead**: `liveClampRows = max(1, floor(liveBudget / liveCount) - 1)`,
where `liveBudget = max(4, rows - 4)`. The `- 1` pays for each clamped entry's
own marker row. With one live entry this reduces to `rows - 5`, i.e. the design's
number less its marker. **Residual, stated rather than hidden**: an entry
contributes at least its header row whatever the clamp says, so the bound holds
while the live region holds fewer than about `rows / 2` entries. Making it
unconditional would mean refusing to draw a live entry at all, which is worse
than a tall frame. `inline-live-clamp.test.tsx` pins both the one-entry and the
six-entry case.

### IF-4 · `ToolCard`'s collapsed view must stay head-first

The clamp was first implemented as "keep the last N lines", matching
`clampLiveText`. That is right for a streaming answer and wrong for a tool card:
the collapsed card has shown the **first** 8 lines since v0.4.0, and `read_file`
/ `list_dir` / `glob` previews are useless from the tail. The inline clamp now
only *lowers the ceiling* and never changes which end is kept, so a full-screen
card (`liveClampRows === undefined`) is byte-identical to before.

### IF-5 · `transcriptRetain` needs a channel into a pure reducer

§3.1 routes every append through `trimEntries(entries, retain)` but §6.1 adds
only `droppedEntries` to `ViewState`, so nothing in the design says where
`retain` comes from. `viewReducer` is pure and takes no config.

**Built instead**: a module-level singleton in `agent/entry-limits.ts`
(`setEntryRetain` / `entryRetain`), written once from `load.ts` next to the
existing `setHistoryEnabled(historyEnabled)` call. That is the shape
`config/prompt-history.ts` already uses for exactly this problem, so it adds no
new idiom. `restoreEntries` also trims — a session file can be longer than the
ring, and that is the one non-append path where the bound still has to hold.

### Not deviations, but worth recording

- **Open question 1** was answered by shipping: `DEFAULT_TRANSCRIPT_WINDOW`
  rises 300 → 1000 in the same change. `render-budget.test.tsx` gates the
  virtualisation independently of the horizon, so a regression in one cannot be
  confounded with the other.
- **Open question 4** was answered as the design proposed: `/perf` is a notice
  entry. It reaches `App`'s refs through a module-level single slot, the same
  channel `ui/exit-snapshot.ts` uses and for the same reason — a slash command
  runs outside the render pass.
- **§7.2's baseline column stays empty.** Recording it needs a real terminal, a
  real provider and a stopwatch; the four `CANNOT BE SKIPPED` cases in
  `manual-test.md` are where those numbers come from. What *is* recorded
  automatically is the property the numbers were meant to prove:
  `render-budget.test.tsx` fails if the rendered text volume at 5 000 entries
  exceeds the volume at 100 entries by more than 10 %.
