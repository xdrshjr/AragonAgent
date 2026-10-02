# Agent activity presentation, round 2 — live tool output, sanitised, and an activity row that tells the truth

Version: **v2** (round 2 design + round 2 review)
**Status:** design — implementation not started.
**Predecessor:** `docs/plans/agent-activity-presentation/spec.md` v2, shipped as
commit `91a026f5` (57 files, +5199/-90).
**Numbering is continuous with round 1**: decisions resume at **D-21**, acceptance
criteria at **AC-22**, so a reviewer can cite either document without collision.

---

## 评审记录 (Review Notes) — round 2

Reviewer pass over v1, section by section, against feasibility / completeness /
consistency / right-sizing. Every claim below was checked against the tree at
`packages/cli/src` at commit `91a026f5`; the file:line citations are the
reviewer's, not v1's, and where they disagree with v1's the reviewer's were
re-read in the file.

**Two P0s and eight P1s were found and are fixed in the body of this v2.** The
P2s are recorded here as notes; the ones that change a sentence are fixed too,
the ones that are only observations are left for the implementer.

The design's architecture survives review intact: the CLI-local side channel is
the right shape, `packages/core` should stay frozen, and D-22's insistence that
live rows are reducer state rather than a store read during render is correct
and is the load-bearing decision in the document. What v1 got wrong is, again,
**the seams** — the two P0s are both places where a correct-looking rule lands in
a subsystem that keeps its invariant somewhere else and then fails with nothing
reporting it.

### P0 — must fix before implementation

| ID | Section | Concern |
|---|---|---|
| **P0-1** | §3.2, §7.1, §7.3 | **The `\r` collapse never runs on the one output shape this round exists for, and the tail of a progress bar is either empty or full of raw `\r`.** §3.2's algorithm splits on `\n` (step 3), keeps the trailing incomplete piece as `carry`, and applies the `\r` rewrite **only to lines the split produced** (step 4). But a progress bar — npm, pip, curl, docker, and every `\r`-only writer §0 names — emits **no `\n` at all** until it finishes. Every rewrite therefore accumulates in `carry`, step 4 never sees any of it, and two things go wrong at once, both silent. (a) Nothing is emitted, so `entry.live` stays empty, so `showLive` is false (§3.3.4), so the card is the same single `running` row it is today — for the exact case §0 uses to justify the round and §7.3 row 3 marks *not skippable*. (b) When `carry` crosses step 7's `LIVE_ROW_MAX_CHARS * 2` bound — about four rewrites of an 80-column bar — step 7 says "flush it as a clipped row" with **no collapse**, so the row that finally reaches `<Text>` contains raw `\r` bytes, violating AC-24 and AC-25 in the same instant. A `\r` inside an Ink frame is precisely the live cursor write §1.1 says the tree cannot survive. Fixed in §3.2 (the rewrite is applied to **every** piece including the incomplete tail; the collapsed carry is emitted as a **provisional last row** so a still-running bar is visible; the step-7 flush is re-scoped to the genuinely-long single line it was written for), in §3.1.1 (`append` returns completed rows **plus** the provisional row), AC-25, AC-39, and §7.1 suite 1 + §7.3 row 3. |
| **P0-2** | §3.3.2, §1.2, §6 | **`toolOutputDelta` cannot reach `mergeDeltas` on the transport v1 chose, so R-1's second bound does not exist.** §3.3.2 states the action "is dispatched through the same buffered path as every other action, so the render governor's ladder (E-19) applies unchanged". `App.tsx:432-447` says the opposite in code: **only** `textDelta` and `thinkingDelta` are pushed into `pending.current`; the `else` branch calls `flushPending(); dispatch(action)` **immediately**. There is no buffered path for "every other action" — the buffer *is* the two text deltas. Worse, §1.2 instructs the implementer that `subscribeToolOutput` "follows `subscribeFast`'s written contract exactly", and all three existing CLI-local subscriptions dispatch directly with comments that say so deliberately (`App.tsx:551-553` team, `:623-626` todos, `:653-657` fast: *"NOT ROUTED THROUGH THE STREAMING COALESCER"*). An implementer following v1 gets **one React commit per stdout chunk** from the highest-frequency producer in the CLI, `mergeDeltas`'s new clause is dead code, `coalesce.ts` in §6 is an unreachable edit, and R-1's mitigation table lists a bound that is not wired. Fixed in §3.3.2 (the effect pushes into `pending.current` and arms `flushTimer` exactly as the two text deltas do, and the section now states why this fourth subscription is the one that *does* belong in the coalescer — it is a stream, not a discrete act), §1.2, §6, R-1, and AC-38. |

### P1 — fixed in this v2

| ID | Section | Concern |
|---|---|---|
| **P1-1** | §3.1.2, §6 | **`tools/index.ts` is missing from the change plan, and the file it omits carries a written warning about this exact omission.** `createBuiltinTools` owns its own options bag (`tools/index.ts:62`) and builds `ToolDeps` from it by an explicit conditional spread (`:380-384`). The comment at `:50-61` is in capitals about the sibling field: *"THE FIELD IS NEEDED IN TWO INTERFACES, NOT ONE. This bag is the factory's; `ToolDeps` is what the `make*` functions receive… Adding it to `ToolDeps` alone type-checks and forwards nothing — the tools simply never record, and every card falls back to `ToolPreview` with no error anywhere (P1-3)."* v1 names only `fs-tools.ts`, and DoD #1 forbids touching a file outside §6 — so the plan as written blocks its own implementation, on the identical defect round 1 already recorded as its P1-3. Fixed in §3.1.2 and §6. |
| **P1-2** | §5.3, §6, AC-34 | **AC-34 is unimplementable inside the change plan: the serializer is in `session/persist.ts`, which is not listed.** `saveSession` writes `entries` **verbatim** (`persist.ts:61-72`, and the module's own doc at `:82` says so), and `agent/reducer.ts` — the file §6 charges with "strip on serialize" — contains no serializer at all. `/save` during a run would therefore capture `live` / `liveSeq` / `lastOutputAt` and AC-34 could not hold however carefully the reducer were written. Fixed in §5.3 and §6. |
| **P1-3** | §3.3.4, §6 | **`nowSec` cannot reach `ToolCard`: `EntryView`'s memo comparator is a closed list and would drop it.** `Transcript.tsx:342-355` memoizes `EntryView` with an **explicit** comparator enumerating exactly ten `===` terms. A prop absent from that list changes without invalidating the boundary, so `ToolCard` is never re-rendered and the stall row freezes at whatever second it first drew — AC-26's *"and the seconds advance"* fails, silently, and AC-26 is not in v1's must-pin list. This is the same trap the file documents one comment above as I-L2-1 (*"EVERY boundary below becomes a no-op AND NOTHING FAILS"*). Fixed in §3.3.4 (the comparator gains `a.nowSec === b.nowSec`, free because the prop is `undefined` on every non-running entry), §6, and a new AC-38. |
| **P1-4** | §3.3.3 | **The `estimateEntryRows` replacement drops the `!entry.preview` guard, and the fall-through crashes.** v1 says its `if (!settled) { … }` block "replaces the blanket one-row charge", i.e. `virtual-window.ts:217-219`'s `if (!entry.preview || !settled) return separation + 1`. Taken literally, a **settled entry with no preview** — an aborted tool call, a tool that returned an empty string — falls past the new block into `wrappedRows(entry.preview, usable)` with `undefined`. Fixed in §3.3.3 with the exact three-branch shape. |
| **P1-5** | §3.3.2, §6 | **`mergeDeltas` cannot "gain a third merged kind" without an ordering rule, and its accumulator is a string.** `coalesce.ts:15-45`: `isDelta` narrows to `{ type: DeltaType; delta: string }` and the pending state is `pendingType` plus `pendingDelta: string`. A `toolOutputDelta` carries `{ toolCallId, rows, at }`, so the merge needs a second shape — and if it is given a *second, independent* pending slot it can overtake a pending `textDelta` and reorder the two streams, which is exactly what I-L4-1 (`render-governor.ts:14-19`) forbids: *"the governor changes only HOW OFTEN the view updates. Never what is dispatched, never the order."* Fixed in §3.3.2 with the explicit rule: **one** pending slot, discriminated, flushed on kind change, on `toolCallId` change, and on any non-delta. |
| **P1-6** | §3.1.3, §4.1, AC-31 | **AC-31 contradicts the design's own pseudocode.** §3.1.3 declares `private readonly toolOutputs: ToolOutputStore = createToolOutputStore();` — a field initializer, which allocates on **every** construction. §4.1 and AC-31 both promise that with `liveToolOutput: false` "the store is never allocated". One of the two has to give. Fixed in §3.1.3 by making the field nullable and constructing it only when the key is on, which is the shape `this.fast` already uses in the same class (`controller.ts:1277`) and which makes AC-31 checkable rather than aspirational. |
| **P1-7** | §3.3.1, §6 | **No clause settles `live` when a run ends without `tool_execution_end`, and this codebase legislates that class of clause in two places.** `runEnd` finalizes only the streaming *assistant* entry (`reducer.ts:984-990`) and `abortMark` maps only assistant entries (`:1059-1066`); neither touches a tool entry left at `status: 'running'`. Today that costs one spinner row. After this round it costs a permanent multi-row live tail with a stall counter frozen at its last value — and because `computeSettledCount` breaks on a non-settled tool entry (`Transcript.tsx:85`), that card **pins the monotonic settled boundary and re-renders the tail every frame for the rest of the session**. That sentence is not the reviewer's: it is `settleRetryCard`'s own doc (`reducer.ts:744-748`), which states the rule as *"every path that reaches `status: 'idle'` settles the card"*, and it is the same reasoning behind all four clauses of `normalizeLoadedEntries` — the lineage D-24 explicitly invokes while adding a new live field with no settle clause. Fixed in §3.3.1, §6, D-24 and AC-40. |
| **P1-8** | §7.3 | **Manual row 3 cannot reproduce the case it is marked not-skippable for.** `bash` spawns with piped stdio (`bash-tool.ts:77-82`), so the child's stdout is not a TTY — and `npm`, `pip` and `docker` all *suppress* their progress bars in exactly that situation. The row can therefore pass green while emitting no `\r` at all, which is a **false pass on the P0-1 path**: the one manual check standing behind the round's motivating case would confirm nothing. Fixed in §7.3 row 3 (a command that emits `\r` unconditionally, with the byte named) and §7.1 suite 1 (a carry-only `\r` corpus, no `\n` anywhere). |

### P2 — noted; the ones that change a sentence are fixed, the rest are for the implementer

| ID | Section | Note |
|---|---|---|
| P2-1 | §2 | Citation drift, all small and all in the safe direction: E-12's data handlers are `bash-tool.ts:119-124` (not `:118-121`), E-15's ticker is `App.tsx:695-706`, and E-11's App effects are at `:554 / :626 / :659` as stated but the fast one's no-op contract is at `:1283-1291`. E-9's `controller.ts:348-355` is right — the call opens at `:348` and `recordChange` is bound at `:355`. *Fixed in §2.* |
| P2-2 | §3.1.1 | `peek()` has **no consumer** in this design: rows travel to the view by listener, and the reducer holds them thereafter. It is a public method with no caller — either drop it or state that it exists for the tests, which is what suite 2 actually uses it for. *Fixed in §3.1.1 (kept, with the reason named).* |
| P2-3 | §3.4 | `runningTool` is computed in App's render scope over `state.entries`, which is bounded by `transcriptRetain` — **1000** by default (`schema.ts:162`). A `.filter(…).pop()` there is a 1000-element scan per frame at up to 30 fps, which is the exact class of cost `tui-render-performance` exists to remove. It must be a reverse loop with an early exit. *Fixed in §3.4.* |
| P2-4 | §3.3.4, §6 | The prop must be `live={entry.live}` and never `live={entry.live ?? []}`: `ToolCard` is `React.memo` with the **default** comparator (`ToolCard.tsx:235-246`) and a fresh `[]` per render defeats it. The file already keeps `EMPTY_LINES` (`:34-35`) for precisely this. *Fixed in §3.3.4.* |
| P2-5 | AC-32 | "no digits in either branch" is a property of **today's tool-name set**, not of the code: the label is `Running ${entry.name}` and `name` comes from the model's tool call, so a hallucinated or future name containing a digit would put one on the row. Harmless (the row is `wrap="truncate"`), but the AC should say it asserts the rendered row for the builtin names rather than a universal property. *Fixed in AC-32.* |
| P2-6 | AC-24 | "No ANSI escape … can reach a rendered row" reads as a statement about the whole card. The settled path is unchanged and still unsanitised — E-13/E-14 say so, and D-27 keeps it that way deliberately. The AC means *live* rows. *Fixed in AC-24.* |
| P2-7 | §3.3.4, AC-36 | Inline: a live card's **floor** rises from 1 row to 2 (header + the always-present footer). The bound still holds — `liveClampRows` already subtracts 1 per live entry for exactly this marker row (`Transcript.tsx:534-538`), and a clamped *preview* card already draws its own `+N lines` footer — but AC-36's "exactly as it does for a preview card" is carrying an arithmetic claim it does not state. *Fixed in §3.3.4 and AC-36.* |
| P2-8 | §3.1.1 | `LIVE_TAIL_ROWS` and `TOOL_OUTPUT_STORE_CAP` are both `8` and mean unrelated things (rows per call; concurrent calls retained). Two bounds sharing a literal is how a later edit conflates them. *Fixed in §3.1.1 — the cap is 16, and the comment says why the two numbers are not the same number.* |
| P2-9 | §3.3.4 | `STALL_AFTER_MS` is used by §3.3.4 and AC-26 but never declared anywhere. *Fixed in §3.3.4.* |
| P2-10 | §3.6 | The sequence diagram narrates "(60 s of silence)" and then draws `no output for 45s`. Cosmetic, but the diagram is the one artefact a reader trusts without checking. *Fixed in §3.6.* |
| P2-11 | §7.3 | Row 6's `yes \| head -c 400000000` has no `yes` and no `head` under `cmd.exe`, which is what `shell:true` selects on Windows (`bash-tool.ts:4-5`). Row 9 asks for rows 1–5 on both platforms, so row 6 is POSIX-only by implication — worth saying, since a Windows-only reviewer would otherwise record it as a failure. *Fixed in §7.3.* |
| P2-12 | §3.3.3 | `entryRevision`'s tool branch is a template literal of six terms after this change. It is still O(1) per entry per frame, which is the property I-L3-1 actually requires, but it is now the longest revision in the file — worth a comment at the site rather than only here, since the next field will be the seventh. |

---

## 0. What this round is, and what it is not

Round 1 answered three of the requirement's four clauses. Reasoning is hidden
behind `showThinking` and leaves an honest `thought for 12s` marker; a rotating
working line proves the process is alive; `write_file` and `edit_file` produce a
structured `FilePatch` that renders as a real, line-numbered, `+N -M` diff. The
clause it did **not** answer is the one it named and deferred:

> **D-15** — *Streaming tool output is out of scope. No builtin tool emits
> `onProgress`, and live output in a height-cached virtualized transcript is a
> round of its own.*

This is that round. It is scoped to the gap that deferral leaves on the screen,
and to two robustness defects that gap conceals.

The gap is not cosmetic. `bash` is the only tool in this CLI that can run for
minutes — `npm test`, `npm run build`, a `git clone`, a training job — and while
it runs, `ToolCard` draws its header and a `running` badge and **nothing else**:
the card's whole body is behind `settled` (`ToolCard.tsx:164`), and
`estimateEntryRows` charges a running tool exactly one row
(`virtual-window.ts:217`). For the entire duration of the most expensive thing
the agent does, the screen is one line of text that never changes. The
requirement's second clause — 工具执行…需要显示 — is met for tools that finish
instantly and unmet for the only tool where it matters, and the failure mode is
the precise one round 1 §1.1 identified for thinking: **the user cannot tell work
from a hang.** Round 1 put a rotating word on the screen to answer "is it stuck".
That word is now the *only* answer available during a ten-minute build, and it is
a guess, not an observation: it rotates identically whether the child process is
compiling or deadlocked on a password prompt.

The two concealed defects are consequences of that same silence. First, **no
component in this tree strips ANSI**: a grep of `src/**` finds escape sequences
only in `input/keymap.ts` and `input/mouse-events.ts`, both *parsers* of input,
never a sanitiser of output. Today `bash`'s raw stdout reaches Ink's `<Text>`
verbatim (`ToolPreview.tsx:180`), and it survives only because it is printed once,
at settle, after the command has stopped writing. Redraw that same text every
frame while the child is still emitting `\r`-rewritten progress bars and
`\x1b[A` cursor moves and it stops being survivable — the terminal honours cursor
motion that Ink does not know it emitted, and `wrappedRows` measures escape bytes
as if they were columns. Second, a `\r`-driven progress bar (npm, pip, curl,
docker) is *one* logical line rewritten a thousand times; unsanitised, a live tail
of it is a thousand rows of the same string.

So: four workstreams, in dependency order. Each is additive, each is revertible on
its own, and `packages/core` is again untouched.

| ID | Workstream | One-line intent |
|----|------------|-----------------|
| **L1** | The side channel | `bash` streams its output to a CLI-local, bounded, owner-scoped `ToolOutputStore`; a fourth controller emitter carries it to the view |
| **L2** | Sanitising | One pure module turns a raw child-process chunk into terminal-safe rows: ANSI stripped, `\r` rewrites collapsed, tabs expanded, rows clipped |
| **L3** | The running card | A running `bash` card draws a bounded **tail** of that output, plus an honest stall row when the child goes quiet |
| **L4** | The activity row | The working line stops claiming the model is thinking while a tool is running, and names the tool instead |

L2 depends on nothing. L3 depends on L1 and L2. L4 depends on nothing and can
ship alone. A fifth, small item (**L5**) closes the one automated-test debt round
1 recorded rather than bought.

**Not in this round**, and each for a stated reason:

- **Progress for tools other than `bash`.** `read_file`, `list_dir`, `glob`,
  `grep`, `write_file` and `edit_file` are bounded local I/O that settle in
  milliseconds; a progress channel for them would be machinery with no observer.
  The channel is *general* (keyed by tool call id, not by tool name) so a future
  long-running tool costs one call site, but only `bash` gets one now.
- **Subagent tool output.** `team/**` remains out of scope, exactly as in round 1
  (D-13). The store key keeps its owner segment so the day a child gets a
  recorder its output cannot land on a lead's card, and the `TeamPanel` continues
  to be the surface that reports child liveness (`team/panel-rows.ts`).
- **Touching `packages/core`.** See D-21: the progress plumbing core already has
  is unreachable, and making it reachable is a public-surface change to a package
  the host application also consumes.
- **Interleaving live output into the model's context.** The tail is a *display*.
  The model's input is byte-for-byte what it is today. This is the same rule
  round 1 imposed on `FilePatch` (D-8), and it is what makes a richer display
  free.
- **Scrollback for a running command, or a second `Ctrl+O` target.** `Ctrl+O`
  keeps targeting the most recent tool card. Selecting an *older* card is a focus
  model this TUI does not have, and inventing one for a diff is a round of its
  own.
- **Background commands.** No `&`-style detach, no "running in the background"
  affordance. The agent loop is synchronous over tool calls; a detached command
  would need a lifecycle this CLI has no owner for.

---

## 1. Overview

### 1.1 The shape of the problem

**A running command is a blank card.** `ToolCard`'s body is gated on
`settled = status === 'done' || status === 'error'` (`ToolCard.tsx:158,164`), and
its preview comes from `entry.preview`, which the reducer writes once, at
`toolExecEnd`. `estimateEntryRows` agrees: `if (!entry.preview || !settled) return
separation + 1` (`virtual-window.ts:217`). The two are consistent, and they are
consistently wrong for the one tool that can take minutes. What the user sees for
ten minutes is:

```
  bash npm test   * running
```

and one rotating word above the composer. Nothing in that frame distinguishes a
test suite at 40% from a child process blocked forever on a prompt this CLI will
never show, because the only two things on screen — the badge and the phrase —
are both derived from *state*, and the state is `running` in both cases.

**The plumbing that should carry the fix is unreachable.** Core defines
`ToolProgressUpdate` and `ToolExecutionContext.onProgress`
(`core/src/tools/types.ts:67,81`), and `ToolExecutor.execute` accepts and forwards
an `onProgress` argument (`core/src/tools/executor.ts:89,166`). But the only
caller in the tree is `agent-loop.ts:242`, which passes **four** arguments and
stops at `ctx.signal`. So `ctx.onProgress` is `undefined` inside every tool, and
there is no `tool_progress` member of the `AgentEvent` union (`core/src/types.ts:74`)
for the CLI to subscribe to even if there were. Progress support in core is a
declared interface with no producer and no consumer.

**Raw child output is not terminal-safe, and nothing in this tree makes it so.**
`renderBash` (`ToolPreview.tsx:180`) dims a few line kinds and otherwise hands
each line to `<Text>` unmodified. A command that emits SGR colour is merely
untidy today; a command that emits `\x1b[2K\r` per progress tick, or `\x1b[A` to
redraw, is a live cursor writer inside a frame Ink believes it owns. Ink's
diffing has no idea the cursor moved, so the next partial redraw lands in the
wrong place and stays wrong until a full repaint. This is latent today and
becomes load-bearing the moment the tail is redrawn while the writer is still
writing.

**And the working line overclaims.** `ActivityLine` mounts on
`state.status === 'running'` and always says a *thinking* word — `Percolating`,
`Ruminating`, `Marinating` (`activity-phrases.ts:19`). `status === 'running'`
covers the whole turn, including the minutes the model is idle and a child
process is doing the work. Round 1 chose that vocabulary deliberately for the
gap before the first token, and it is right for that gap; it is a false statement
during a build. A UI that says "Pondering" while `npm test` runs is not calm, it
is wrong, and the requirement's fourth clause asks for a status line, not a
screensaver.

### 1.2 The shape of the fix

**L1 — output travels on a side channel, injected at construction.** Round 1
already solved this exact problem for `FilePatch` and its answer is reusable
verbatim. `ToolDeps` grows an optional `recordOutput?(toolCallId, chunk)`
alongside `recordChange?` (`fs-tools.ts:32`); `makeBash` calls it from the
`stdout`/`stderr` data handlers it already has (`bash-tool.ts:118`); the callback
is bound in `AgentController`'s `createBuiltinTools` call, pre-bound to `'lead'`,
at the identical site and for the identical reason as `recordChange`
(`controller.ts:348-355`). Chunks land in a `ToolOutputStore` — bounded, keyed
`${owner}:${toolCallId}`, holding only the last `LIVE_TAIL_ROWS` rows — and the
controller exposes `subscribeToolOutput(listener)`, a **fourth** CLI-local
emitter beside `subscribeTeam` / `subscribeTodos` / `subscribeFast`, returning a
no-op unsubscribe when disabled, which is the contract `controller.ts:1283-1291`
already sets in writing. No core change, no new `AgentEvent`, no new tool
parameter, and no token cost.

It follows `subscribeFast` in **shape** — an emitter on the controller, a no-op
unsubscribe when the feature is off, one `useEffect` in `App` — and departs from
it in exactly one place, which §3.3.2 states and P0-2 exists to keep stated: the
three existing subscriptions dispatch **directly**, each with a comment saying
so deliberately, because each carries a discrete act (a roster change, a
`todo_write`, a review verdict). This one carries a **stream**. It is the only
CLI-local emitter whose producer is a child process writing at pipe speed, so it
is the only one that belongs in the streaming coalescer alongside the text
deltas. Copying `subscribeFast` all the way down is the mistake this paragraph
is here to prevent.

**L2 — sanitising is a pure module, and it runs at the boundary.** A new
`tools/terminal-output.ts` exports `sanitizeChunk(carry, chunk)`: strip CSI/OSC
escapes, apply `\r` as the line rewrite it is, expand tabs, drop `\b`, clip each
row at `LIVE_ROW_MAX_CHARS`, and return `{ rows, carry }` so a chunk split
mid-escape or mid-line does not corrupt the next one. Pure, React-free, Ink-free,
and unit-testable without a terminal — the property that made `patch.ts` and
`activity-phrases.ts` testable. It runs **once**, in the store's `append`, so
every reader downstream is already safe and no render pass ever touches an escape
byte.

**L3 — the running card grows a bounded tail.** The live rows reach the view as
**reducer state**, not as a store read during render, and that distinction is the
single most important decision in this document (D-22). `entryRevision` is what
tells the height cache that an entry's rendered output changed
(`virtual-window.ts:59`); an entry whose text is mutated *outside* `ViewState`
keeps its revision, so it "freezes at a stale height AND a stale rendered subtree
with nothing anywhere reporting it" — the failure mode I-L3-1 is written to
prevent, quoted from the file itself. So: a `toolOutputDelta` action appends to a
new `live?: string` field on the tool entry, and `entryRevision`'s tool branch
gains **a monotonic counter**, because a fixed-size tail is a *non-append*
mutation and `live.length` can repeat exactly across a ring eviction — the one
lossy case I-L3-1 says the reducer cannot produce today, and which this round
introduces. `estimateEntryRows`'s running branch is widened to charge the rows
the card will actually draw. The card renders the **last** rows, not the first
(D-25), and when the child has been silent for a while it says so in one muted
row rather than pretending.

**L4 — the activity row names what is running.** While a tool is in flight the
row stops rotating thinking-words and shows `Running bash` — one row, still no
digits, still no `esc abort`, still ASCII, so round 1's D-5 and D-17 hold
unchanged. When no tool is in flight the row is byte-identical to today's.

### 1.3 Non-goals

Restated from §0 for the reviewer's convenience: no progress for non-`bash`
tools, no subagent output, no `packages/core` change, no live output in the
model's context, no new `Ctrl+O` target, no background commands, no syntax
highlighting, no change to headless/print mode (`agent/headless.ts` stays as it
is), and no change to the saved-session format beyond one optional field that is
deliberately **not** persisted (D-24).

---

## 2. Evidence — what the tree contains today

Every claim this design leans on, with the citation a reviewer can check. All
line numbers are at commit `91a026f5`.

| # | Claim | Where |
|---|---|---|
| E-1 | A tool card's body renders only when settled | `ui/entries/ToolCard.tsx:158,164` |
| E-2 | A running tool is charged exactly one row by the layout estimator | `ui/layout/virtual-window.ts:217-219` |
| E-3 | The height cache is keyed by a derived revision; a non-append mutation must extend it or the entry freezes silently | `ui/layout/virtual-window.ts:51-57` (I-L3-1), tool branch `:75-78` |
| E-4 | Core declares `ToolProgressUpdate` / `ToolExecutionContext.onProgress` | `core/src/tools/types.ts:67,81` |
| E-5 | `ToolExecutor.execute` accepts and forwards `onProgress` | `core/src/tools/executor.ts:89,166` |
| E-6 | The only caller passes four arguments and never supplies it, so `ctx.onProgress` is always `undefined` | `core/src/engine/agent-loop.ts:242-247` |
| E-7 | There is no `tool_progress` member of `AgentEvent` | `core/src/types.ts:74-84` |
| E-8 | `ToolDeps.recordChange` is the established construction-time side channel, optional and pre-bound to its owner | `tools/fs-tools.ts:21-33` |
| E-9 | The recorder is bound in the controller's `createBuiltinTools` call, pre-bound to `'lead'`; subagents get none | `agent/controller.ts:348-355` |
| E-10 | `FileChangeStore` is owner-scoped, take-once, bounded FIFO — the store shape to mirror | `tools/file-change-store.ts:13-23,38-68` |
| E-11 | Three CLI-local emitters already exist, each returning a no-op unsubscribe when its feature is off — and all three dispatch **directly**, each with a comment saying the coalescer is deliberately bypassed | `agent/controller.ts:956,1035,1283-1291`; App effects at `ui/App.tsx:554,626,659`, with the refusals at `:551-553,623-626,653-657` |
| E-11a | The streaming coalescer buffers **only** `textDelta` / `thinkingDelta`; every other action flushes and dispatches immediately | `ui/App.tsx:432-447` |
| E-12 | `bash` accumulates stdout/stderr into one string and already has the data handlers a recorder needs; `execute`'s first parameter is the tool-call id (today spelled `_id`) | `tools/bash-tool.ts:66,119-124` |
| E-12a | `bash` spawns with **piped** stdio, so the child's stdout is not a TTY | `tools/bash-tool.ts:77-82` |
| E-13 | Nothing in `src/**` strips ANSI; the only escape-sequence code is *input* parsing | `input/keymap.ts`, `input/mouse-events.ts` (grep for `\x1b`) |
| E-14 | `renderBash` hands each line to `<Text>` unmodified | `ui/entries/ToolPreview.tsx:180-196` |
| E-15 | The elapsed ticker runs at 200 ms and **only** while `status === 'running'`; it is torn down otherwise | `ui/App.tsx:695-706` |
| E-15a | `EntryView` is memoized with an **explicit** comparator — a closed list of ten `===` terms — under a comment stating that a boundary broken this way fails with nothing reporting it (I-L2-1) | `ui/Transcript.tsx:336-355` |
| E-15b | `createBuiltinTools` owns a second options interface and builds `ToolDeps` from it by conditional spread; the file says in capitals that the field is needed in **two** interfaces | `tools/index.ts:50-62,380-384` |
| E-15c | `saveSession` writes `entries` verbatim; the strip has nowhere else to go | `session/persist.ts:61-72,82` |
| E-15d | Neither `runEnd` nor `abortMark` settles a tool entry, and `settleRetryCard` states the rule that says one of them must release the tail | `agent/reducer.ts:744-748,984-990,1059-1066`; `ui/Transcript.tsx:85` |
| E-16 | The retry card is the precedent for a one-row card whose text changes on a clock while its revision deliberately does not | `ui/layout/virtual-window.ts:85-96` |
| E-17 | Inline mode already treats "a running tool" as a live entry that holds back the settled boundary, and already budgets it via `liveClampRows` | `ui/Transcript.tsx:523-538` |
| E-18 | `mergeDeltas` merges only `textDelta` / `thinkingDelta`, and any other action flushes the pending run | `agent/coalesce.ts:15-45` |
| E-19 | The render governor coalesces at 33→320 ms under load and may not change what is dispatched, only how often the view updates | `ui/render-governor.ts:17-23` |
| E-20 | The activity row is phrase-only by design, with no digits and no width ladder | `ui/ActivityLine.tsx:8-20` |
| E-21 | Collapsed previews show the **first** 8 lines, and the comment forbids reshuffling which end is kept | `ui/entries/ToolCard.tsx:32,146-154` |
| E-22 | Stored previews are capped at 8 000 chars with an ASCII truncation mark | `agent/reducer.ts:460,471,486-489` |
| E-23 | The executor already truncates a tool result at 100 KB, so the *model's* bound exists and is unrelated to the display's | `core/src/tools/executor.ts` (`maxOutputSize`) |

---

## 3. Technical design

### 3.1 L1 — the side channel

#### 3.1.1 `ToolOutputStore`

New file `tools/tool-output-store.ts`, mirroring `file-change-store.ts` in shape
and in its documented reasoning, with **one deliberate difference**: it is
*peek-and-clear*, not take-once, because a running command is read many times and
consumed once.

```ts
export const LIVE_TAIL_ROWS = 8;           // ROWS retained per tool call
export const TOOL_OUTPUT_STORE_CAP = 16;   // CONCURRENT CALLS retained

export interface ToolOutputStore {
  /**
   * Append a raw chunk. Sanitises (§3.2), then returns the display tail:
   * the last LIVE_TAIL_ROWS of `[...completedRows, carry]`, `carry` last
   * and included only when non-empty.
   */
  append(owner: string, toolCallId: string, chunk: string): readonly string[];
  /** Current tail, or `undefined`. Does NOT remove. Test-facing (P2-2). */
  peek(owner: string, toolCallId: string): readonly string[] | undefined;
  /** Drop the entry — called at `tool_execution_end`. */
  clear(owner: string, toolCallId: string): void;
  size(): number;
}
```

The two constants are deliberately **different numbers** (P2-8). They bound
unrelated things — rows inside one call, and calls inside one session — and a
shared literal is how a later edit collapses two bounds into one. `peek` has no
production caller by design: rows reach the view by listener and live in
`ViewState` thereafter (D-22). It exists so suite 2 can assert the ring without
subscribing, and that is the whole of its contract.

**The tail includes the in-progress line.** `append` returns
`[...completedRows, carry]` (carry last, omitted when empty) rather than
completed rows only, which is the display half of P0-1: a command whose output is
one continuously-rewritten line — every progress bar there is — has **no**
completed rows until it exits, and a tail built from completed rows alone would
be empty for its entire run. The row is provisional in the sense that the next
chunk replaces it; it is not provisional in any sense a consumer can observe,
because the whole tail is replaced on every append anyway.

Four properties, each load-bearing, and each with the failure it prevents:

- **Owner-scoped** (`${owner}:${toolCallId}`), for D-13's reason unchanged: only
  `'lead'` is written this round, but subagents build tools from the same factory,
  and a child's tool-call id must never be able to paint a lead's card.
- **Sanitised on write.** `append` calls `sanitizeChunk` (§3.2) before storing, so
  the store's contract is "terminal-safe rows" and no consumer can forget.
- **Bounded twice** — `LIVE_TAIL_ROWS` per call and `TOOL_OUTPUT_STORE_CAP`
  calls. A command emitting 400 MB to stdout costs a fixed number of retained
  rows. The per-call bound is what makes the *display* bounded; the cap is what
  makes a session that never settles a call bounded.
- **Cleared at settle, not at read.** The authoritative result arrives with
  `tool_execution_end`; from that instant the tail is superseded and must be
  released. Clearing there (rather than on read) is what keeps the store's size a
  function of *concurrent* calls instead of total calls.

The store carries a per-key `carry` string (the incomplete trailing line, already
sanitised and `\r`-collapsed by §3.2) so a chunk boundary that falls mid-line or
mid-escape does not emit a torn row — and so the line a command is *currently*
writing is something the card can draw.

#### 3.1.2 The producer

`ToolDeps` (`fs-tools.ts:21`) gains one optional member, documented in the same
voice as `recordChange`:

```ts
  /**
   * Hand a raw output chunk to the UI on the CLI-local side channel (§3.1).
   * PRE-BOUND TO ITS OWNER. OPTIONAL: omitting it leaves `bash` byte-identical
   * to the pre-feature build — not one extra allocation, not one extra call.
   */
  recordOutput?: (toolCallId: string, chunk: string) => void;
```

**THE FIELD IS NEEDED IN TWO INTERFACES, NOT ONE (P1-1).** `ToolDeps` is what
the `make*` functions receive; `BuiltinToolsOptions` (`tools/index.ts:62`) is the
factory's own bag, and `createBuiltinTools` builds the former from the latter by
an explicit conditional spread (`tools/index.ts:380-384`):

```ts
  const deps: ToolDeps = {
    getCwd: options.getCwd,
    ...(options.recordChange ? { recordChange: options.recordChange } : {}),
    // Added, in the same shape and for the same reason:
    ...(options.recordOutput ? { recordOutput: options.recordOutput } : {}),
  };
```

Adding it to `ToolDeps` alone **type-checks and forwards nothing** — `bash` never
records, every card falls back to a single `running` row, and nothing anywhere
errors. That sentence is not this document's: it is `tools/index.ts:50-61`,
written after round 1 made the identical mistake with `recordChange` (round 1
P1-3). The conditional spread is also what makes AC-31 true at this layer: with
the key off no property is added, so `deps` is the object it is today.

`makeBash` uses the tool-call id it already receives as `execute`'s first
parameter (today spelled `_id`, which becomes `id`), and calls the recorder from
the two data handlers it already has:

```ts
child.stdout?.on('data', (d) => {
  const s = d.toString();
  output += s;                       // unchanged — this is the model's result
  deps.recordOutput?.(id, s);        // added — display only
});
```

`stderr` is handled identically. **`output` is untouched**: the string the model
receives, its truncation, and the `[exit code N]` footer are all byte-identical,
which is what makes AC-30 checkable by comparison rather than by inspection.

Rate limiting lives in the **store**, not in the tool: `append` is O(chunk) and
allocation-light, and a per-chunk throttle in the tool would drop the *last*
chunk of a burst, which is the one that matters. What must be throttled is the
*view update*, and §3.3.2 does that where the existing machinery for it already
lives.

#### 3.1.3 The transport

`AgentController` gains, beside `fileChanges`:

```ts
/**
 * NULL WHEN THE FEATURE IS OFF (P1-6). `fileChanges` next door is declared with
 * an initializer because it is unconditional; this one cannot be, since a field
 * initializer cannot read a constructor parameter — and an unconditional
 * initializer would allocate on every construction and make AC-31's "no store
 * is allocated" false by construction. `private readonly fast: FastWiring | null`
 * (`controller.ts:237`) is the same declaration shape in the same class.
 */
private readonly toolOutputs: ToolOutputStore | null;
private readonly outputListeners = new Set<ToolOutputListener>();
```

**Assigned in the constructor body, ABOVE the `createBuiltinTools` call at
`controller.ts:348`** — not near `this.fast` at `:485`, which runs after it. This
is the ordering `fileChanges`'s own comment records (`controller.ts:217-220`:
*"DECLARED WITH AN INITIALIZER, so it exists before `createBuiltinTools` runs in
the constructor body and the recorder closure it hands over is valid from the
first tool call"*), and the reason it matters here is narrower and sharper: the
binding below is spread **conditionally on `this.toolOutputs`**, so an assignment
placed after the call would read `undefined`, add no property, and produce a
build in which the feature is silently off with the key on.

```ts
    this.toolOutputs = config.liveToolOutput ? createToolOutputStore() : null;
```

bound in the same `createBuiltinTools` call, immediately under `recordChange`,
and **only when the store exists** — so with the key off the options object has
no `recordOutput` property at all and the conditional spread in §3.1.2 yields
today's `deps` byte for byte:

```ts
...(this.toolOutputs
  ? { recordOutput: (id: string, chunk: string) => this.emitToolOutput('lead', id, chunk) }
  : {}),
```

`subscribeToolOutput` returns `() => {}` when `toolOutputs` is null, which is
`subscribeFast`'s written contract (`controller.ts:1283-1291`) and is what lets
`App` subscribe unconditionally.

`emitToolOutput` appends to the store and notifies listeners with
`{ toolCallId, rows }` — the sanitised tail, already bounded, as a **frozen
array**. `subscribeToolOutput(listener)` follows `subscribeFast`'s written
contract exactly, including the no-op unsubscribe. The controller also clears the
store entry when it sees `tool_execution_end` on the stream it already subscribes
to at `controller.ts:516`.

Two notes for the implementer. First, the listener set must be notified
**synchronously** inside the data handler: the alternative (queue + timer) adds a
second clock to a component that has one, and `App` already coalesces. Second,
`emitToolOutput` must be wrapped so that a throwing listener cannot kill the
child-process data handler — a `try/catch` per listener, logged at `debug`. A
render-side exception must not be able to break a build.

### 3.2 L2 — `tools/terminal-output.ts`

Pure, ASCII-only, no imports from `ui/**` or `ink`.

```ts
export const LIVE_ROW_MAX_CHARS = 200;
export const TAB_WIDTH = 8;

export interface SanitizeResult { rows: string[]; carry: string; }
export function sanitizeChunk(carry: string, chunk: string): SanitizeResult;
export function stripAnsi(text: string): string;   // exported for tests
```

The algorithm, in order — the order is the specification:

1. **Concatenate** `carry + chunk`.
2. **Strip escapes.** One regex covering CSI (`\x1b[` … final byte `@`–`~`), OSC
   (`\x1b]` … `\x07` or `\x1b\\`), and the two-byte forms (`\x1b` + a single
   char). Also drop the C1 range and every C0 control except `\t`, `\n`, `\r`.
   Rationale: a display that keeps colour would have to *validate* it — an
   unterminated SGR leaks its attribute into the rest of the frame — and this
   round is not buying a terminal emulator (D-27).
3. **Split on `\n`** into *n* pieces. The first *n-1* are complete rows; the last
   is the **incomplete tail**.
4. **Apply `\r` to EVERY piece, the incomplete tail included** (D-33). A piece
   containing `\r` is a sequence of *rewrites*: take the segment after the last
   `\r`, and if that segment is shorter than what precedes it, keep the longer
   prefix's tail — i.e. emulate a real overwrite rather than a truncation. The
   simple, correct-enough rule this design mandates:
   `segments.reduce((acc, s) => s + acc.slice(s.length), '')`. That turns 1 000
   progress-bar rewrites into **one** row showing the final state, which is both
   what the terminal would show and what makes the tail readable.

   **"Every piece, the tail included" is the whole of P0-1 and it is not an
   optimisation.** A progress bar emits no `\n` until it finishes, so *all* of
   its rewrites live in the incomplete tail and none of them is ever a "line".
   Collapsing only completed lines means the collapse never runs for npm, pip,
   curl, docker or any other `\r` writer — the tail stays empty, `showLive` is
   false, and the card is the single `running` row this round exists to replace.
   Applying the rewrite here is also what keeps the carry **bounded by
   construction**: a collapsed bar is one row wide however many times it is
   redrawn, so step 7 stops being the mechanism that bounds a progress bar and
   goes back to being what it was written for — one genuinely enormous line.
5. **Expand tabs** to the next multiple of `TAB_WIDTH`.
6. **Clip** each row *and the tail* to `LIVE_ROW_MAX_CHARS`, appending
   `PREVIEW_TRUNCATION_MARK` (`'...'`, spelled locally and asserted equal by test
   rather than imported — the same rule `patch.ts:96-101` states, so `tools/`
   keeps no runtime dependency on the view model).
7. **Bound the carry.** If the collapsed, clipped tail still exceeds
   `LIVE_ROW_MAX_CHARS * 2` — which after step 4 requires a single line that is
   genuinely that long, e.g. `cat` on a minified bundle — flush it as a clipped
   row and reset. Without this the carry is an unbounded accumulator; with step 4
   in front of it, it is a rare path rather than the progress-bar path.

The return is therefore:

```ts
export interface SanitizeResult {
  /** Complete rows, terminal-safe, in order. */
  rows: string[];
  /** The in-progress line: already stripped, `\r`-collapsed, tab-expanded and clipped. */
  carry: string;
}
```

`carry` is **display-ready**, not raw. That is what lets the store show it
(§3.1.1) without any consumer knowing there is such a thing as an incomplete
line, and it is the difference between "a running `curl -O` shows its bar" and
"a running `curl -O` shows nothing at all until it exits".

`sanitizeChunk` is **total**: it never throws, for any input including lone
surrogates, NUL bytes, a chunk consisting solely of `\x1b`, and a 4 MB chunk
containing no `\n` at all.

### 3.3 L3 — the running card

#### 3.3.1 Reducer state

The tool entry (`agent/reducer.ts:87-113`) gains two fields:

```ts
      /** Sanitised live tail rows while running. Cleared at settle (D-23). */
      live?: readonly string[];
      /** Monotonic counter — the revision term for a NON-APPEND mutation (D-22). */
      liveSeq?: number;
      /** Epoch ms of the last output row, for the stall row (§3.3.4). */
      lastOutputAt?: number;
```

One new action:

```ts
  | { type: 'toolOutputDelta'; toolCallId: string; rows: readonly string[]; at: number }
```

Its reducer clause finds the entry by `toolCallId` (the existing
`findToolEntryId` helper), and — **only if that entry's status is `running` or
`pending`** — writes `live: rows`, `liveSeq: (e.liveSeq ?? 0) + 1`,
`lastOutputAt: action.at`. The status guard is what makes a late chunk arriving
after `tool_execution_end` (possible: the child's last write and the process
`close` event race) unable to resurrect a settled card.

`toolExecEnd`'s existing clause additionally sets `live: undefined` and
`lastOutputAt: undefined`. **The tail is never merged into `preview`** — the
authoritative result already contains everything the tail held, in full, and
concatenating them would double the output and break `bashBadge`'s last-line
parse (`ToolPreview.tsx:35-54`).

**And two more clauses, for the paths where `tool_execution_end` never arrives
(P1-7).** `runEnd` (`reducer.ts:984-990`) finalizes only the streaming assistant
entry, and `abortMark` (`:1059-1066`) maps only assistant entries; neither
touches a tool entry stranded at `status: 'running'`. Both must additionally
clear `live` and `lastOutputAt` on **every** tool entry that is still `pending`
or `running`:

```ts
    // EVERY PATH THAT REACHES `status: 'idle'` RELEASES THE TAIL.
    entries = entries.map((e) =>
      e.kind === 'tool' && (e.status === 'running' || e.status === 'pending') && e.live
        ? { ...e, live: undefined, lastOutputAt: undefined }
        : e,
    );
```

The status is deliberately **not** changed — that is a different decision with
different consequences for `bashBadge` and for the run's own bookkeeping, and it
is not this round's to make. Only the tail is released. The rule and its stakes
are `settleRetryCard`'s, quoted from `reducer.ts:744-748`: *"every path that
reaches `status: 'idle'` settles the card, because a card left at `phase:
'waiting'` pins `Transcript`'s MONOTONIC settled boundary and re-renders the tail
every frame for the rest of the session"*. A stranded running tool card already
pins that boundary today (`Transcript.tsx:85`) and costs one spinner row; with a
live tail attached it would cost a permanent multi-row card whose stall counter
is frozen at its last value, because the 200 ms ticker that feeds `nowSec` is
torn down the instant `state.status` leaves `running` (E-15). Pinned by AC-40.

#### 3.3.2 Coalescing

**There is no such thing as "the buffered path for every other action" (P0-2).**
`App.tsx:432-447` buffers exactly two action types and dispatches everything else
immediately:

```ts
        if (action.type === 'textDelta' || action.type === 'thinkingDelta') {
          pending.current.push(action);
          if (!flushTimer.current) {
            flushTimer.current = setTimeout(() => flushPending(), governorInterval.current);
          }
        } else {
          flushPending();
          dispatch(action);
        }
```

So the `subscribeToolOutput` effect must **push into `pending.current` and arm
`flushTimer` itself**, in exactly that shape — `pending` and `flushPending` are
component-scope refs, reachable from any effect in `App`:

```ts
  useEffect(() => controller.subscribeToolOutput(({ toolCallId, rows }) => {
    pending.current.push({ type: 'toolOutputDelta', toolCallId, rows, at: Date.now() });
    if (!flushTimer.current) {
      // READ FROM THE REF AT ARM TIME, for the reason `App.tsx:438-440` records:
      // this effect's dependency list never changes, so a captured number would
      // be pinned to the mount render and the governor's ladder would move nothing.
      flushTimer.current = setTimeout(() => flushPending(), governorInterval.current);
    }
  }), [controller, flushPending, governorInterval]);
```

This is the **one** place this round departs from the three sibling
subscriptions, and it departs on purpose. `subscribeTeam`, `subscribeTodos` and
`subscribeFast` each carry a discrete act at human frequency and each has a
written comment refusing the coalescer for that reason (`App.tsx:551-553`,
`:623-626`, `:653-657`). This one carries a **stream at pipe speed**. Dispatching
per chunk is one React commit per `read()` from a child process — the saturation
R-1 names, with its second bound simply absent. `Date.now()` is read in the
listener, not in the reducer, so the reducer stays pure.

`mergeDeltas` (`coalesce.ts:15-45`) then gains a third merged kind — and it needs
an ordering rule, because its pending state today is a single `pendingType` plus
a single `pendingDelta: string` and the new payload is an object (P1-5). **One
pending slot, discriminated**, never two:

- a `toolOutputDelta` flushes a pending *text* run before becoming the pending
  action, and vice versa — a second, independent slot would let a chunk overtake
  a token and reorder the two streams, which is exactly what I-L4-1
  (`render-governor.ts:14-19`) forbids: *"never what is dispatched, never the
  order"*;
- consecutive `toolOutputDelta`s merge **only when their `toolCallId` matches**,
  and the merge keeps the **last** action's `rows` and `at` — the tail is
  cumulative, it *is* the store's whole state rather than an increment, so last
  wins. A differing id flushes and starts a new pending action; merging across
  ids would paint one command's output onto another's card;
- any non-delta still flushes first, so `toolExecEnd` can never be applied before
  a chunk that preceded it, exactly as E-18 requires.

Suite 6 asserts all four transitions, and `render-governor.test.ts`'s existing
"same final `ViewState` at every rung" property extends to cover the new kind.

#### 3.3.3 Height accounting — the part that must not be got wrong

Two changes, and both are in the *unsafe* direction if omitted.

**`entryRevision`, tool branch** (`virtual-window.ts:75-78`) appends `liveSeq`:

```ts
    case 'tool':
      return `t${entry.status}.${entry.argsRaw.length}.${entry.preview?.length ?? 0}.${
        entry.durationMs ?? -1
      }.${entry.patch?.lineCount ?? -1}.${entry.liveSeq ?? -1}`;
```

A counter and not `live.length`, and the file itself says why: I-L3-1 states the
revision is safe today because "all text fields are append-only … A future
NON-APPEND mutation MUST extend the revision". A fixed-size tail **is** that
mutation — evicting the oldest row while appending a new one of the same width
leaves the joined length unchanged — and the consequence is a card frozen at a
stale height *and* a stale subtree, reported by nothing.

**`estimateEntryRows`, tool branch** (`:217-219`) splits the blanket one-row
charge into three branches — and **the `!entry.preview` guard must survive the
split** (P1-4). Today's single line is `if (!entry.preview || !settled) return
separation + 1`, so it covers *two* cases: not settled, and settled with nothing
to draw (an aborted call, a tool that returned an empty string). Replacing it
with a `!settled` block alone drops a settled entry with no preview into
`wrappedRows(entry.preview, usable)` with `undefined`. The exact shape:

```ts
      if (!settled) {
        const live = entry.live?.length ?? 0;
        if (live === 0) return separation + 1;              // unchanged path
        // header + tail rows + the stall/`(running)` footer row
        return separation + 1 + Math.min(live, LIVE_TAIL_ROWS) + 1;
      }
      if (!entry.preview) {
        return separation + 1;                              // KEPT — settled, nothing to draw
      }
```

Rows are **counted, not wrapped**, which is only legitimate because every live
row is rendered `wrap="truncate"` and clipped at `LIVE_ROW_MAX_CHARS` — the same
argument `DiffView.tsx:6-11` makes for itself, and the same coupling: if a future
change lets a live row wrap, this estimate silently under-counts, which
`virtual-window.ts` names as the direction the layout cannot absorb.

#### 3.3.4 Rendering

`ToolCard` gains `live?: readonly string[]`, `lastOutputAt?: number` and
`nowSec?: number`, and its body gate widens:

```ts
const showLive = !settled && (live?.length ?? 0) > 0;
const showBody = ((previewLines.length > 0 || showPatch) && settled) || showLive;
```

The live branch renders, inside the same left rail:

```
  bash npm test   * running
  |  > tests/patch.test.ts (18 ok)
  |  > tests/diff-view.test.tsx (9 ok)
  |  no output for 45s
```

Three rules:

- **The tail is the LAST rows.** Settled previews keep their head-first slice
  (E-21) and its comment stands; a live tail head-first would freeze on the first
  eight lines a build ever printed and then never change again, which is worse
  than no tail at all. Two different ends, two different questions: "what did this
  command do" versus "what is it doing **now**" (D-25).
- **One footer row, always**, matching the arithmetic in §3.3.3 exactly. It reads
  `no output for Ns` once the child has been quiet for `STALL_AFTER_MS` (10 s),
  and otherwise `(running)`. A constant row count is what lets the estimate be
  exact rather than an upper bound.
- **`Ctrl+O` does not expand a live card.** `expanded` is ignored while
  `showLive`; the tail is `LIVE_TAIL_ROWS` in both states. Expansion is a promise
  about *stored* content, and the store deliberately does not have the rest.

`STALL_AFTER_MS = 10_000` lives beside `LIVE_TAIL_ROWS` in
`tools/tool-output-store.ts` (P2-9): it is the store's notion of "quiet", and the
card reads it rather than owning a second copy.

The stall row's clock is the reason `nowSec` is a prop and the reason it is
**seconds, not milliseconds**: `ToolCard` is `React.memo` with the default
comparator, and a prop that changes five times a second would defeat that
boundary for every card in the transcript. `App` therefore passes `nowSec` **only
to entries that are `running`** (an `undefined` for every other card keeps their
memo intact), computed as `Math.floor(Date.now() / 1000)` in render scope — the
existing 200 ms ticker (E-15) is what causes the render, so no timer is added,
but the *value* is wall-clock, because `lastOutputAt` is epoch ms and the stall
is their difference. This is the retry card's precedent (E-16) applied one level
up: the row's text changes on a clock, its height never does, and `liveSeq` — not
the clock — is what the height cache watches.

**`nowSec` must also be added to `EntryView`'s memo comparator (P1-3).**
`Transcript.tsx:342-355` memoizes `EntryView` with an **explicit** comparator
listing exactly ten `===` terms. A prop that is not in that list changes without
invalidating the boundary, so `ToolCard` is never re-rendered and the stall row
freezes at the second it first drew — AC-26's *"and the seconds advance"* fails
with nothing reporting it, which is I-L2-1's trap one comment above the
comparator. The added term is free: `undefined === undefined` for every entry
that is not a running tool. Both call sites need it — `Transcript` (inline) and
`TranscriptList` (full-screen) each map entries and each must decide per entry
whether to pass the prop at all.

Two prop-boundary rules that are cheap to state and expensive to rediscover:
`live={entry.live}` and **never** `live={entry.live ?? []}` (P2-4) — `ToolCard`'s
default comparator sees a fresh `[]` as a changed prop, which is why the file
already keeps a shared `EMPTY_LINES` at `ToolCard.tsx:34-35`; and the reducer
must write a **new** array on every tail update, which it does anyway because the
store hands it one.

Inline mode needs nothing new: E-17 shows a running tool already holds the
settled boundary and already receives `liveClampRows`, and the live branch honours
that ceiling the same way the preview branch does — the tail is sliced to
`min(LIVE_TAIL_ROWS, liveClampRows)`. One arithmetic note the reviewer asked be
written down rather than left implicit (P2-7): a live card's **floor** in the
inline live region is 2 rows, not 1, because the footer row is unconditional. The
bound still holds, for a reason already in the tree — `liveClampRows` subtracts
`1` per live entry precisely to pay for a marker row (`Transcript.tsx:534-538`),
and a clamped *preview* card already draws its own `+N lines (Ctrl+O)` footer, so
this is the existing shape rather than a new cost.

### 3.4 L4 — the activity row

`ActivityLine` gains one optional prop, `runningTool?: string`, and one branch:

```tsx
const label = runningTool ? `Running ${runningTool}` : `${phrase}${glyphs.ellipsis}`;
```

`App` computes `runningTool` as the `name` of the most recent tool entry whose
status is `running`, or `undefined` — **as a reverse loop with an early exit, not
a `filter().pop()`** (P2-3). `state.entries` is bounded by `transcriptRetain`,
which defaults to **1000** (`schema.ts:162`), and this runs in render scope at up
to 30 fps; an allocating full scan there is the exact cost
`tui-render-performance` exists to remove. The running tool, when there is one,
is within a few entries of the end.

Everything round 1 legislated for this row
survives: one row, no digits, no `esc abort`, no width ladder, ASCII only, and
the shared toast row (D-17) — so `budget.ts` and `AppShell.tsx` remain
**unmodified**, and `budget.test.ts` continues to say so.

Two details. The phrase must **not** keep rotating underneath: when a tool is
running the row shows the tool, and when it stops the phrase resumes from the
sequence position the clock implies — `pickActivityPhrase` is pure and derived
from `(startedAt, now)`, so this is automatic and needs no state. And the label
is `Running ${name}` rather than a per-tool verb table: a table would be a second
place to register a tool, and `toolGlyph` already exists as the one place that
knows tool names.

### 3.5 L5 — the AC-7 pin

Round 1's DoD recorded, rather than bought, an automated pin for AC-7
(`runStartedAt` is seeded in render scope, not read one frame before the effect
writes it). It costs one test: render `<App>` with a controller stub that emits
`turn_start`, assert the first frame's activity row is present and its phrase is
the one `pickActivityPhrase(seed, seed)` returns. It is included here because it
is the only remaining unpinned clause of the previous round, and this round is the
last one that will remember why it matters.

The other recorded debt — six files over 1 000 lines, all of which were already
over at their round-1 HEAD — is **not** bought here. Splitting `App.tsx` or
`reducer.ts` is a refactor whose blast radius is the whole test suite, it is
unrelated to this requirement, and doing it inside a presentation round is how
a presentation round becomes unreviewable. It is restated in §8 as accepted debt
with an owner, not silently dropped.

### 3.6 Sequence — one `npm test`, end to end

```
model                 bash tool          store/controller        App/reducer         screen
  |  tool_call bash        |                    |                    |                  |
  |----------------------->|                    |                    |                  |
  |                    spawn child          (tool_execution_start) --> toolCallStart --> "bash npm test  * running"
  |                        |                    |                    |                  |
  |                   stdout chunk ---------> append(): sanitize      |                  |
  |                        |               (strip ANSI, apply \r,     |                  |
  |                        |                clip, keep last 8) -----> toolOutputDelta -->|
  |                        |                    |               (mergeDeltas by id)      |
  |                        |                    |               entry.live = rows        |
  |                        |                    |               entry.liveSeq += 1 ----> tail redraws
  |                        |                    |                    |                  |
  |                    (45 s of silence)        |                    | nowSec ticks ---> "no output for 45s"
  |                        |                    |                    |                  |
  |                   child exits          (tool_execution_end) ----> toolExecEnd ------> full preview + exit badge
  |<---- result text ------|               store.clear()          live/lastOutputAt = undefined
```

The model's column is touched exactly twice, as it is today.

---

## 4. Interface design

### 4.1 Config — one new key

| Surface | Spelling |
|---|---|
| `config.json` | `"liveToolOutput": true` |
| Env | `ARAGON_LIVE_TOOL_OUTPUT=0\|1\|true\|false\|on\|off\|yes\|no` |
| Flag | `--live-tool-output` / `--no-live-tool-output` |
| `/config set` | `config set liveToolOutput false` |
| Settings screen | row `Live output`, `kind: 'enum'`, options `on` / `off` |

Default **`true`**: unlike `showThinking`, this feature *adds* information the
user asked for, and its cost is bounded by construction. The key exists as a kill
switch, because "a build's output redraws the transcript" is exactly the kind of
change a user on a slow SSH link may want off.

It must be threaded through **all three** layers — `config/schema.ts`
(`PersistedConfig` **and** `CliConfig` and `DEFAULT_CONFIG`), `config/env.ts`,
`config/load.ts`'s `pick(flags, env, file)`, and `cli.tsx`'s `KNOWN_SET_KEYS` +
its `switch`. Round 1's P1-2 and the fast tier's round-2 IF both record the same
failure: a key added to the persisted shape only will round-trip through
`config set`, be written to disk, and never reach the runtime — with nothing
failing. The label is `Live output` (11 chars), inside the settings screen's
18-column label budget that `fast-model-tier-hardening` IF-H7 pins.

When the key is `false`, `AgentController` constructs **no** store and passes
**no** `recordOutput` (§3.1.3), so `BuiltinToolsOptions` gains no property,
`ToolDeps` gains no property, and `bash` is byte-identical to the pre-feature
build — the same "off costs nothing" discipline round 1 applied to
`recordChange`, and now the same *shape*, since v1's field initializer would have
allocated the store regardless (P1-6).

### 4.2 Keybindings and commands

**None added.** `Ctrl+O` keeps its current target and semantics (§3.3.4 states
explicitly that it does not expand a live card), `Ctrl+T` is untouched, and no
slash command is introduced. `HelpOverlay` gains no row.

### 4.3 No network surface

No REST, no WebSocket, no IPC. Everything is in-process, and the only new
cross-module contract is `subscribeToolOutput`.

---

## 5. Data model

### 5.1 `ViewState` deltas

| Field | Shape | Lifetime |
|---|---|---|
| `Entry(tool).live` | `readonly string[]`, ≤ `LIVE_TAIL_ROWS` (8) rows, each ≤ 200 chars | Created on first chunk, **cleared at settle** |
| `Entry(tool).liveSeq` | `number`, monotonic | Same |
| `Entry(tool).lastOutputAt` | `number` (epoch ms) | Same |

Worst case per entry: 8 × 200 = 1 600 chars, and only for entries that are
*currently running* — in practice one, bounded above by the agent's parallel tool
fan-out.

### 5.2 `ViewAction` deltas

One new action, `toolOutputDelta` (§3.3.1). No action is removed or changed.

### 5.3 Persistence — the tail is not saved

`live`, `liveSeq` and `lastOutputAt` are **omitted from the session file** (D-24).
Three reasons, in order of weight: a resumed session's tail describes a process
that no longer exists; the settled `preview` supersedes it entirely, so it is
strictly redundant; and it is the *only* mutable-while-live field the tool entry
has, so persisting it would require a `normalizeLoadedEntries` clause — the very
class of clause round 1's D-9 explains exists for live flags that never settle.
Omission needs no clause: an entry loaded without `live` renders exactly as a
settled entry does, which is what it is.

**The serializer is `session/persist.ts`, and it is where the strip goes
(P1-2).** `saveSession` writes `entries` **verbatim** (`persist.ts:61-72`; the
module's own doc at `:82` says so in those words), and `agent/reducer.ts` — which
v1's change plan charged with "strip on serialize" — contains no serializer at
all. A `/save` issued *during* a run would therefore capture the tail however
carefully the reducer were written, and AC-34 could not hold. So `saveSession`
maps its `entries` through a strip before writing:

```ts
    entries: data.entries.map((e) =>
      e.kind === 'tool' && (e.live || e.liveSeq !== undefined || e.lastOutputAt !== undefined)
        ? { ...e, live: undefined, liveSeq: undefined, lastOutputAt: undefined }
        : e,
    ),
```

Stripping rather than trusting absence is also what keeps D-24's "omission needs
no clause" true on the **load** side. A tool entry saved mid-run keeps
`status: 'running'`, and `normalizeLoadedEntries` has no clause for that (it
never has — the four it carries are all about other kinds). With the tail
stripped, `showLive` is false and that resumed card is byte-identical to what
today's build draws for the same file: one `running` row. With the tail present
it would be a multi-row card describing a process that died with the last
session, counting seconds against a `lastOutputAt` from yesterday. The
`normalizeLoadedEntries` clause D-24 declines to write is only unnecessary
*because* the write path strips.

---

## 6. File / module change plan

### New files

| Path | Intent |
|---|---|
| `packages/cli/src/tools/terminal-output.ts` | `sanitizeChunk` / `stripAnsi` — pure, total, ASCII-only |
| `packages/cli/src/tools/tool-output-store.ts` | Owner-scoped, bounded, sanitise-on-write live tail store |
| `packages/cli/src/__tests__/terminal-output.test.ts` | Escapes, `\r` rewrites, tabs, clipping, carry, totality |
| `packages/cli/src/__tests__/tool-output-store.test.ts` | Ring bound, owner isolation, clear-at-settle, cap eviction |
| `packages/cli/src/__tests__/live-tool-output.test.tsx` | Card renders a tail; last-rows-not-first; stall row; `Ctrl+O` is inert while live |
| `packages/cli/src/__tests__/live-height.test.ts` | `entryRevision` changes on a same-length ring update; `estimateEntryRows` matches the rendered row count; a settled entry with **no** preview still charges one row (P1-4) |
| `packages/cli/src/__tests__/activity-tool-label.test.tsx` | Row says `Running bash`; still no digits; reverts to a phrase |
| `packages/cli/src/__tests__/live-session.test.ts` | A mid-run `/save` writes no `live` / `liveSeq` / `lastOutputAt`, and the file reloads as a one-row `running` card (AC-34). Named for the `retry-session` / `team-session` / `todo-session` convention |
| `docs/plans/agent-activity-presentation-live/manual-test.md` | The manual rows of §7.3 |

### Modified files

| Path | Change |
|---|---|
| `packages/cli/src/tools/fs-tools.ts` | `ToolDeps.recordOutput?` — one optional member + its doc comment |
| `packages/cli/src/tools/index.ts` | **(P1-1)** `BuiltinToolsOptions.recordOutput?` **and** the conditional-spread forward into `deps` at `:380-384`. The field is needed in TWO interfaces; `ToolDeps` alone type-checks and forwards nothing |
| `packages/cli/src/tools/bash-tool.ts` | Use `id`; call `deps.recordOutput?.(id, s)` from both data handlers (`:119-124`). `output` unchanged |
| `packages/cli/src/agent/controller.ts` | `toolOutputs` store (**nullable**, P1-6), `emitToolOutput`, `subscribeToolOutput`, conditional `recordOutput` binding, clear-on-`tool_execution_end` |
| `packages/cli/src/agent/reducer.ts` | Tool entry `live` / `liveSeq` / `lastOutputAt`; `toolOutputDelta` action + clause; clear in `toolExecEnd`; **release the tail in `runEnd` and `abortMark`** (P1-7) |
| `packages/cli/src/session/persist.ts` | **(P1-2)** `saveSession` strips `live` / `liveSeq` / `lastOutputAt` from tool entries. This is the serializer; the reducer has none |
| `packages/cli/src/agent/coalesce.ts` | Merge `toolOutputDelta` **by `toolCallId`**, keeping the last, from **one** discriminated pending slot (P1-5) |
| `packages/cli/src/ui/App.tsx` | `subscribeToolOutput` effect that pushes into `pending.current` and arms `flushTimer` (**not** a direct dispatch — P0-2); `nowSec` for running entries only; `runningTool` by reverse scan |
| `packages/cli/src/ui/Transcript.tsx` | Pass `live` / `lastOutputAt` / `nowSec` through `EntryView` to `ToolCard`, from **both** `Transcript` and `TranscriptList`; **add `a.nowSec === b.nowSec` to the `EntryView` memo comparator** (P1-3) |
| `packages/cli/src/ui/entries/ToolCard.tsx` | `showLive` branch, tail rendering, one footer row, `expanded` ignored while live |
| `packages/cli/src/ui/ActivityLine.tsx` | `runningTool?` prop and its one branch |
| `packages/cli/src/ui/layout/virtual-window.ts` | `liveSeq` in the tool revision; live branch in `estimateEntryRows` |
| `packages/cli/src/config/schema.ts` | `liveToolOutput` on `PersistedConfig`, `CliConfig`, `DEFAULT_CONFIG` |
| `packages/cli/src/config/env.ts` | `ARAGON_LIVE_TOOL_OUTPUT` |
| `packages/cli/src/config/load.ts` | `pick(flags, env, file)` + the returned config |
| `packages/cli/src/cli.tsx` | `--live-tool-output` / `--no-…`, `KNOWN_SET_KEYS`, the `config set` switch arm |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | One `Live output` enum row |
| `packages/cli/src/__tests__/config.test.ts` | The key resolves from **each** of the three layers separately |
| `packages/cli/src/__tests__/app.test.tsx`, `app-follow-through.test.tsx`, `mouse-routing.test.tsx` | The three files holding an `as unknown as AgentController` stub. Add `subscribeToolOutput` — see R-4 |
| `packages/cli/src/__tests__/render-governor.test.ts` | Extend the "same final `ViewState` at every rung" property to `toolOutputDelta` |
| `packages/cli/src/__tests__/activity-line.test.tsx` | Extend for the tool branch |
| `packages/cli/README.md` | `liveToolOutput`, what the live tail shows, and what it deliberately does not |
| `packages/cli/CHANGELOG.md` | Entry led by live output |

### Explicitly not touched

`packages/core/**` (D-21) · `ui/layout/budget.ts` · `ui/layout/AppShell.tsx`
(round-1 DoD #8 stands) · `ui/ToastStack.tsx` · `ui/glyphs.ts` ·
`tools/patch.ts` · `tools/file-change-store.ts` · `ui/entries/DiffView.tsx` ·
`team/**` · `agent/headless.ts` · `fast/**`.

---

## 7. Testing & acceptance criteria

### 7.1 Unit suites (Vitest, offline, no network, no real child processes except where stated)

1. **`terminal-output.test.ts`** — CSI/OSC/two-byte escapes removed; `\x1b[2K\r`
   progress bar collapses to one final row; **a carry-only corpus (P0-1): 200
   `\r` rewrites with NO `\n` anywhere yields exactly one row, that row is the
   latest state, and it contains no `\r`** — fed both as one chunk and as 200
   separate chunks, since the two paths differ; a chunk split mid-escape and one
   split mid-line both round-trip through `carry`; tabs expand to 8; a
   10 000-char line clips at 200 + `'...'`; a genuinely long single line flushes
   at 400; totality over a fuzz corpus including NUL, lone surrogates, CRLF, a
   lone `\x1b` and a 4 MB newline-free chunk (0 throws).
2. **`tool-output-store.test.ts`** — never exceeds `LIVE_TAIL_ROWS`; the returned
   tail ends with the in-progress line while one is open and does not once it is
   terminated; `'lead:x'` and `'sub:x'` are independent; `clear` releases; the
   17th concurrent call evicts the oldest; `peek` does not remove.
3. **`live-tool-output.test.tsx`** — a running card with a tail renders the tail;
   the rows are the **last** N, asserted against a 20-row feed; the stall row
   appears at `STALL_AFTER_MS` and not before; `Ctrl+O` changes nothing while
   live; at settle the tail is gone and the preview is the authoritative result.
4. **`live-height.test.ts`** — feed a tail whose joined length is **identical**
   before and after a ring eviction and assert `entryRevision` differs
   (the mutation test for D-22); and for 12 shapes assert
   `estimateEntryRows === ` the row count a recording `HeightStore` observes.
5. **`activity-tool-label.test.tsx`** — `Running bash` while a tool runs; a
   property assertion that the row contains no digit in either branch (round 1's
   AC-8a rule, extended); reverts to a phrase when the tool settles.
6. **`coalesce`** (extend the existing suite) — two `toolOutputDelta`s with the
   same id merge to the **last**; with different ids they do **not** merge; a
   `toolExecEnd` between them flushes; **and the four ordering transitions of
   P1-5**: `text → toolOutput` flushes the text first, `toolOutput → text`
   flushes the tail first, and neither can overtake the other.
7. **`config.test.ts`** (extend) — `liveToolOutput` resolves from flag, env and
   file **separately**, and reaches `CliConfig`.
8. **`live-session.test.ts`** — a `ViewState` carrying a running tool entry with
   a tail round-trips through `saveSession` / `loadSession` with no `live`,
   `liveSeq` or `lastOutputAt` on disk, and renders as a one-row `running` card
   on reload (AC-34).

### 7.2 Acceptance criteria

| ID | Criterion |
|---|---|
| **AC-22** | While `bash` runs, its card shows up to 8 sanitised rows of its most recent output |
| **AC-23** | Those rows are the **last** rows emitted, not the first |
| **AC-24** | No ANSI escape, `\r`, `\b` or C0/C1 control byte can reach a rendered **live** row. (The settled preview path is unchanged and still unsanitised — E-13/E-14, D-27 — so this AC is about the rows this round adds) |
| **AC-25** | A `\r` progress bar renders as **one** row, showing its latest state — **including a bar that emits no `\n` for its entire run**, which is the ordinary case (P0-1) |
| **AC-26** | After `STALL_AFTER_MS` of silence the card reads `no output for Ns`, and the seconds advance |
| **AC-27** | A live card contributes exactly `1 + min(rows, 8) + 1` rows, and `estimateEntryRows` returns that number |
| **AC-28** | `entryRevision` changes on **every** tail update, including a same-total-length one |
| **AC-29** | At settle, `live` is cleared and the card is byte-identical to what it renders today |
| **AC-30** | The tool result the model receives is **byte-identical** to the pre-round build, for the same command |
| **AC-31** | With `liveToolOutput: false`, no store is allocated, `recordOutput` is not passed, and `bash` is byte-identical to the pre-round build |
| **AC-32** | The activity row reads `Running <tool>` while a tool is in flight and a rotating phrase otherwise, with **no digit in the rendered row for any builtin tool name** in either branch (P2-5: the label interpolates a model-supplied name, so this is a property of the row plus today's tool set, not of the code) |
| **AC-33** | `budget.ts` and `AppShell.tsx` are unmodified, and `budget.test.ts` says so |
| **AC-34** | The session file contains no `live` / `liveSeq` / `lastOutputAt`, even when saved mid-run |
| **AC-35** | A listener that throws does not kill the child-process data handler nor the command |
| **AC-36** | Inline mode honours `liveClampRows` for a live card: the tail is sliced to `min(LIVE_TAIL_ROWS, liveClampRows)` and the card's floor is header + footer = 2 rows, which is the floor a clamped preview card already has (P2-7) |
| **AC-37** | AC-7 from round 1 is pinned by an automated test (L5) |
| **AC-38** | A burst of N chunks inside one governor interval produces **one** dispatch, not N: the action goes through `pending.current` and `mergeDeltas`, and the effect never calls `dispatch` directly (P0-2) |
| **AC-39** | A command that emits a `\r`-rewritten line and **never** emits `\n` still draws a tail, and that tail is one row (P0-1) |
| **AC-40** | A tool entry still `running` when the run ends — `runEnd` or `abortMark`, with no `tool_execution_end` — has no `live` and no `lastOutputAt` afterwards, and draws the single row it draws today (P1-7) |
| **AC-41** | The stall row's seconds advance **through `EntryView`**, i.e. rendered from `App` rather than by mounting `ToolCard` directly, so the memo comparator is exercised (P1-3) |

**Must be pinned by a named test:** AC-23, AC-24, AC-27, AC-28, AC-30, AC-31,
AC-32, AC-35, **AC-38, AC-39, AC-40, AC-41**. Those twelve are the ones whose
violation is **silent** — wrong rows, a corrupted frame, a frozen height, a
bigger bill, a feature that is not really off, a row that lies, a build killed by
a render bug, a coalescer that was never wired, an empty tail for the case the
round exists for, a card that pins the transcript forever, and a clock that
stopped.

Four of those twelve were added by review, and each replaces a claim v1 made in
prose. **AC-41 must render through `App`**: a test that mounts `ToolCard` with a
changing `nowSec` passes whether or not `EntryView`'s comparator carries the
term, which is precisely the shape of a passing test that cannot fail.

### 7.3 Manual rows (`manual-test.md`)

1. `npm test` in this repo, full-screen, 120×40 — the tail moves, the badge stays
   `running`, the transcript does not jump. **(not skippable)**
2. The same at 80×24 **inline** — the live region stays inside its clamp and the
   settled scrollback is not re-printed. **(not skippable)**
3. A command that emits `\r` **unconditionally**, because `bash` spawns with
   piped stdio (E-12a) and `npm` / `pip` / `docker` all suppress their progress
   bars when stdout is not a TTY — so the obvious commands would pass this row
   while emitting no `\r` at all, a false pass on the exact path P0-1 describes
   (P1-8). Use, verbatim:

   ```
   python -c "import sys,time;[(sys.stdout.write('\rdownloading [' + '#'*(i//5) + ' '*(20-i//5) + '] ' + str(i) + '%'), sys.stdout.flush(), time.sleep(0.05)) for i in range(101)]"
   ```

   One line on purpose: a multi-line `-c` string does not survive `cmd.exe`,
   which is what `shell:true` selects on Windows, and row 10 runs this on both
   platforms. The `\r` is Python's, not the shell's, so the byte reaches stdout
   identically either way. There is deliberately **no** trailing newline — the
   command exits with its bar still an incomplete line, which is the state the
   store's carry has to be able to draw.

   **Pass:** the card shows **one** row that counts up in place, no `\r`
   artefacts, no row-per-tick growth, and the transcript below it does not move.
   **(not skippable)**
4. A command emitting SGR colour (`ls --color=always -R /usr` or
   `npm test -- --reporter verbose`) — no stray colour, no cursor jump, no frame
   corruption. **(not skippable)**
5. `python -c "import time; time.sleep(60); print('done')"` — the stall row
   appears and counts, then the result replaces it.
6. A 400 MB emitter — RSS is flat and the UI stays interactive; the governor may
   step up, which is correct. **POSIX only** as written (`yes | head -c
   400000000`): `shell:true` selects `cmd.exe` on Windows, which has neither
   binary (P2-11). The Windows equivalent is
   `python -c "import sys;[sys.stdout.write('x'*8192) for _ in range(50000)]"`.
7. `Ctrl+O` during (1) — nothing happens; after settle — the preview expands.
8. `config set liveToolOutput false`, restart, repeat (1) — the card is a single
   `running` row again, exactly as before this round.
9. Abort (`Esc`) during (1) — the tail disappears with the run, the card does not
   keep a frozen `no output for Ns` row, and the transcript keeps scrolling
   normally afterwards (AC-40).
10. Windows PowerShell and one POSIX terminal for rows 1–5 and 9.

---

## 8. Risks & mitigations

| ID | Risk | Mitigation |
|---|---|---|
| **R-1** | A chatty command saturates the event loop | Three independent bounds: the store keeps 8 rows however many arrive; dispatch is pushed into `pending.current` **by the subscription itself** so the governor's 33→320 ms ladder applies (E-19, E-11a) — this is the bound P0-2 found missing, and AC-38 is its pin, because "the buffered path" is not something an action falls into by default; rows are `wrap="truncate"` so per-frame cost is O(8 × 200) |
| **R-2** | The height cache freezes on a same-length tail | `liveSeq` in the revision, **mutation-tested** by AC-28's suite — the test must be shown to fail with the term removed |
| **R-3** | The estimate under-counts and the viewport overflows | The estimate reproduces the render arithmetic exactly and is asserted against a recording `HeightStore` over 12 shapes; every live row is truncate-wrapped by construction |
| **R-4** | A stub cast `as unknown as AgentController` lacks `subscribeToolOutput` — a runtime `is not a function`, not a compile error | Exactly round 1's IF-5. All three stubs get the method **in the same commit**; the change plan lists them |
| **R-5** | A render-side throw kills a build | Per-listener `try/catch` in `emitToolOutput` (§3.1.3), pinned by AC-35 |
| **R-6** | `\r` collapsing hides real output (a command that legitimately ends lines with `\r` only, e.g. classic Mac tooling) | The rule keeps the *longest* overwritten prefix rather than the last segment, so content is not lost, only overwritten as the terminal would; row 3 of §7.3 checks the common case with a command that is guaranteed to produce it (P1-8) |
| **R-11** | The tail is empty for the whole class of commands the round was written for, and the card looks exactly as it does today | The collapse runs on the incomplete tail as well as on completed lines, and the store's tail carries the in-progress row (P0-1 / D-33). Two pins, because the two halves fail independently: AC-39 for the display, and suite 1's carry-only corpus for the sanitiser |
| **R-7** | The model's bill grows | Structurally impossible: the recorder is a second consumer of a string `bash` already builds, and `output` is untouched. AC-30 asserts byte-identity |
| **R-8** | Sanitising costs more than it saves on a hot path | `sanitizeChunk` is one regex pass plus a split over a chunk that is at most a pipe buffer (64 KB); it runs once per chunk, not once per frame |
| **R-9** | Scope creep into a terminal emulator | D-27 draws the line at "strip, do not interpret". Anything needing cursor addressing is out |
| **R-10** | Accepted debt: six files remain over 1 000 lines | Restated, not dropped (§3.5). This round adds ~30 lines to `App.tsx` and ~40 to `reducer.ts`; splitting them is a refactor round with its own spec |

---

## 9. Decisions

| ID | Decision | Why |
|---|---|---|
| **D-21** | `packages/core` is not touched; the channel is CLI-local and injected at construction | Core's `onProgress` is declared but never supplied (E-4…E-6), so using it means changing `agent-loop.ts` **and** adding an `AgentEvent` member — a widening of a public union that `public-api.test.ts` freezes and that the host application also switches on. `ToolDeps.recordChange` already proves the construction-time channel works, at zero cost when absent |
| **D-22** | Live rows live in `ViewState`, and the tool revision gains a **counter** | The alternative — a store read during render — leaves `entryRevision` unchanged, and I-L3-1 states the consequence in the file: a stale height *and* a stale subtree, "with nothing anywhere reporting it". A counter rather than a length because a ring eviction can preserve the total length exactly |
| **D-23** | The tail is cleared at settle and never merged into `preview` | The authoritative result contains it in full; concatenating would double the output and break `bashBadge`'s last-line footer parse |
| **D-24** | The tail is not persisted, and `saveSession` **strips** it rather than trusting it to be absent | It describes a dead process, it is strictly redundant with `preview`, and persisting the only mutable-while-live field would force a `normalizeLoadedEntries` clause (round 1's D-9). The strip is what makes declining that clause honest: a tool entry saved mid-run keeps `status: 'running'`, `normalizeLoadedEntries` has no clause for tool entries, and only an absent tail makes the resumed card identical to today's (§5.3, P1-2) |
| **D-25** | Live shows the **last** rows; settled keeps the **first** | Two different questions. Head-first while live would freeze on the first eight lines a build ever printed; `ToolCard.tsx:146-154` forbids changing the settled end, and this does not |
| **D-26** | `Ctrl+O` is inert on a live card | Expansion is a promise about stored content and the store deliberately holds 8 rows. A key that silently does nothing is better than a key that promises the rest of a 400 MB stream |
| **D-27** | Sanitising strips, it does not interpret | Keeping colour means validating it — an unterminated SGR leaks into the rest of the frame — and interpreting cursor motion means owning a screen buffer. Neither is a presentation round's job |
| **D-28** | `liveToolOutput` defaults to **`true`** | Unlike `showThinking`, this adds information the requirement asks for and its cost is bounded by construction. The key exists as a kill switch, not as an opt-in |
| **D-29** | The stall row's clock is a `nowSec` prop passed **only to running entries** | `ToolCard` is `React.memo` with the default comparator; a 200 ms prop on every card would defeat it transcript-wide. Seconds, not milliseconds, for the same reason the retry tick is 1 Hz |
| **D-30** | `toolOutputDelta` merges by `toolCallId` and keeps the **last** | The payload is the store's whole tail, not an increment, so the last one wins; merging across ids would paint one command's output onto another's card |
| **D-31** | The activity row names the tool rather than a per-tool verb | A verb table is a second registry of tool names. `Running bash` is honest, one row, no digits — round 1's D-5 survives intact |
| **D-32** | Only `bash` gets a recorder | Every other builtin settles in milliseconds. The channel is keyed by tool call id, not by tool name, so a future long tool costs one call site |
| **D-33** | The `\r` rewrite is applied to the **incomplete tail**, and the tail is displayed as a provisional row | *(review, P0-1)* A progress bar emits no `\n` for its whole run, so a rule that only collapses completed lines never runs on the case the round exists for — and the carry-flush fallback would then emit raw `\r` into an Ink frame. Applying it to every piece also makes the carry bounded by construction instead of by the 400-char escape hatch |
| **D-34** | This fourth CLI-local subscription **does** go through the streaming coalescer, unlike the other three | *(review, P0-2)* The other three carry discrete acts at human frequency and each documents its refusal of the buffer. This one carries a child process's stdout. `mergeDeltas` keeping the last tail per id is what turns a thousand chunks into one commit; without the routing, the merge is dead code and R-1 has one bound instead of two |
| **D-35** | Every path to `status: 'idle'` releases the tail, but **none of them changes the tool's status** | *(review, P1-7)* Releasing the tail is required — a stranded running card pins the monotonic settled boundary and would now pin a multi-row card with a frozen clock. Changing the *status* is a separate decision with consequences for `bashBadge` and the run's bookkeeping, and inventing one inside a presentation round is how a presentation round stops being reviewable |
| **D-36** | `nowSec` is wall-clock seconds computed in render scope, not the ticker's `elapsedMs` | *(review)* The stall is `now - lastOutputAt` and `lastOutputAt` is epoch ms, so an elapsed-since-run-start counter cannot produce it. The ticker's job is to cause the render; the value comes from `Date.now()`. Seconds, not ms, so `ToolCard`'s default comparator survives — and the term belongs in `EntryView`'s explicit comparator too, or nothing downstream ever sees it |

---

## 10. Definition of done

1. Every file in §6 is created or modified, and no file outside it is touched.
2. `npm test` is green at the workspace root; `tsc --noEmit` is clean for both
   `packages/cli` tsconfigs and for `packages/core`.
3. Every AC in §7.2 holds, with the **twelve** named in §7.2 each pinned by a
   named test, and **three pins mutation-checked** — a passing test that cannot
   fail is the exact shape of the defect each one guards:
   - **AC-28**: the test must be demonstrated to fail when `liveSeq` is removed
     from the revision;
   - **AC-41**: it must fail when `a.nowSec === b.nowSec` is removed from
     `EntryView`'s comparator (P1-3) — which is only possible if the test renders
     through `App`;
   - **AC-38**: it must fail when the subscription is changed to dispatch
     directly, i.e. when it is written the way its three siblings are (P0-2).
4. `glyphs.test.ts` passes unchanged — no new non-ASCII literal outside
   `glyphs.ts`. `terminal-output.ts` writes escape sequences as `\x1b` escapes in
   *regex* form, which the scanner permits, matching `input/mouse-events.ts`.
5. All ten manual rows pass on Windows PowerShell and one POSIX terminal (row 6
   in its per-platform form); rows 1, 2, 3 and 4 are **not skippable** — they are
   the four modes the risks live in, and row 3 must be run with the command §7.3
   names rather than a substitute, for the reason P1-8 gives.
6. `packages/core` shows **zero** changed lines (`git diff --stat` in the DoD
   evidence), and `budget.ts` / `AppShell.tsx` likewise.
7. `README.md` documents `liveToolOutput` and what the tail deliberately does not
   do; `CHANGELOG.md` leads its entry with live output.
8. No new file exceeds 1 000 lines; no new function exceeds 60 lines or 5
   parameters. `sanitizeChunk` is split across named helpers (`stripAnsi`,
   `applyCarriageReturns`, `expandTabs`, `clipRow`).
9. A measured note in the PR body: peak RSS and frame interval for §7.3 row 6,
   against the same command on the pre-round build. If the governor's top rung is
   reached, that is reported, not hidden.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Eight findings, each recorded with what the design said, what the tree
contained, and what was done instead. None of them changes the architecture; six
are places where a sentence in the design could not be implemented as written,
and two are consequences of the design's own field additions that the change plan
did not enumerate. Seven changed the source; **IF-8 changed only this document**,
because there the code was right and the acceptance criterion was not.

THREE OF THE EIGHT WERE FOUND BY A TEST RATHER THAN BY READING (IF-2, IF-6,
IF-7), and all three are in the class the review verdict named: a rule that reads
correctly in prose landing in a subsystem that keeps its invariant somewhere
else. None of them would have thrown.

### IF-1 — §3.2's steps 6 and 7 contradict each other, and the carry cannot be both display-ready and state

**What the design said.** Step 6: "**Clip** each row *and the tail* to
`LIVE_ROW_MAX_CHARS`, appending `PREVIEW_TRUNCATION_MARK`." Step 7: "If the
collapsed, clipped tail still exceeds `LIVE_ROW_MAX_CHARS * 2` … flush it as a
clipped row and reset." And §3.2 closes: "`carry` is **display-ready**, not raw."

**What that yields.** After step 6 the tail is at most 203 characters, so step 7's
`> 400` test can never fire and the carry bound does not exist. Worse, §7.1
suite 1 demands **both** observable behaviours — "a 10 000-char line clips at
200 + `'...'`" *and* "a genuinely long single line flushes at 400" — so the two
sentences are not merely redundant, they are jointly unimplementable.

Making the carry display-ready is what forces the contradiction: the carry is
**threaded back into the next call verbatim**, so clipping it is lossy. A line
that reached 250 characters would be stored as `<200 chars>...`, and the next
chunk would append after a `'...'` that is now part of the stream — visible
corruption in the middle of a row, and `\r` overwrite arithmetic applied to a
truncated prefix.

**What was done.** The two roles are separated, which is the only shape that
satisfies both of suite 1's requirements without losing data:

- `rows` are clipped at `LIVE_ROW_MAX_CHARS` (step 6, unchanged);
- `carry` is **state**: stripped, `\r`-collapsed and tab-expanded, but **not**
  clipped, and bounded by step 7 at `CARRY_MAX_CHARS` (400) as the design
  intended;
- a new exported `toDisplayRow(carry)` produces the render form, and
  `tool-output-store.ts` calls it when it builds the tail. The store's contract —
  "terminal-safe rows, each at most `LIVE_ROW_MAX_CHARS`" — is unchanged, and
  §5.1's "each ≤ 200 chars" holds for everything a consumer can see.

The flush test is on **both** the raw and the expanded tail length. Tab expansion
runs over a bounded prefix (every character occupies at least one column, so a
400-character prefix covers every column the clip can keep), and testing only the
expanded result would leave a megabyte-long line sitting at exactly the bound
forever, never flushing.

### IF-2 — `stripAnsi` alone cannot hide a half-written escape, and it fails in the visible direction

*(Found by the test written for §7.1 suite 1's "a chunk split mid-escape … round-trips through `carry`".)*

**What the design said.** §3.2 step 2 strips "CSI, OSC and the two-byte forms",
and the carry exists so "a chunk split mid-escape or mid-line does not corrupt
the next one".

**What the tree does.** Both are true and they are not enough together. An
incomplete CSI must be **held** for the next chunk to complete — so it lives at
the end of the carry — and the carry is also what the card draws (P0-1 / IF-1).
Running the ordinary strip over it does not remove the held bytes cleanly: the
two-byte rule consumes the `\x1b[` of an unfinished `\x1b[31m` and leaves the
**parameters** behind, so a chunk boundary inside a colour code renders as
`red 3`. That is an AC-24 violation produced by the sanitiser itself, and it was
caught by the test rather than by review.

**What was done.** `toDisplayRow` **cuts the trailing partial off** at its start
index rather than stripping it, and only then strips and clips. The lookback is
bounded (64 characters): a sequence that has run that far without a final byte is
a byte that happened to be `0x1b`, and holding it forever would pin the carry.
`terminal-output.test.ts` asserts the mid-escape and lone-`ESC` round trips in
both directions.

### IF-3 — a required `CliConfig` key touches eleven test files the change plan does not list

**What the design said.** §4.1: thread `liveToolOutput` through "`config/schema.ts`
(`PersistedConfig` **and** `CliConfig` and `DEFAULT_CONFIG`)". §6 lists three test
files (`app.test.tsx`, `app-follow-through.test.tsx`, `mouse-routing.test.tsx`),
and lists them for a different reason — R-4's stub method.

**What the tree contains.** Fourteen test files construct a `CliConfig` object
literal typed as `CliConfig`, and `tsconfig.test.json` typechecks them. A
required key is therefore a compile error in eleven files outside §6, plus two
more holding a `SettingsValues` literal for the settings screen. This is round 2's
instance of the fast tier's IF-H2, one key later.

**What was done.** The key is **required**, matching `showThinking` exactly, and
the fixtures were updated. Required rather than optional is the deliberate
choice: optional would mean the controller reading `config.liveToolOutput ?? true`,
which puts the default in two places — `DEFAULT_CONFIG` and the consumer — and
that is the drift `schema.ts` already warns about elsewhere. A compile error in
fourteen files is loud; a second spelling of the default is silent.

The fixtures are given `liveToolOutput: false`, not `true`. Those suites predate
this feature and none of them is about it, so "off" keeps each one byte-identical
to its pre-round behaviour: no store allocated, no `recordOutput` bound. The
suites that *are* about the feature set it explicitly.

Files touched beyond §6: `fast-budget`, `fast-registry`, `fast-resolve`,
`fast-task-tier`, `max-tokens-ui`, `skills-controller`, `team-activity`,
`team-retry`, `team-runtime`, `team-tool-gate`, `todo-session`.

### IF-4 — the tool entry's new `live` field breaks an unrelated reducer clause's type

**What the tree contained.** `reducer.ts`'s `todoUpdate` clause declares a local
`const entry = (id: string): Entry => ({ id, kind: 'todo', …, live: true })` and
then rewrites the card with `{ ...entry(known), live: e.live }`. The return type
is the whole `Entry` union, so that spread produces a union member for **every**
kind carrying `live: boolean` — including the tool member, which now declares
`live?: readonly string[]`.

**What was done.** The local helper is typed `Extract<Entry, { kind: 'todo' }>`.
It always constructed a todo entry; the union return type was incidental, and
narrowing it makes the `live` override honest rather than accidentally legal. No
behaviour change, and no other clause in the file has this shape.

### IF-5 — `runEnd` / `abortMark` must bump `liveSeq`, not merely clear `live`

**What the design said.** §3.3.1's release clause is written as
`{ ...e, live: undefined, lastOutputAt: undefined }`, and D-35 states — correctly
— that the tool's **status** must not change.

**What follows from that.** With the status unchanged, and `preview`,
`durationMs`, `argsRaw` and `patch` all unchanged, **nothing in the tool revision
moves**. `entryRevision`'s tool branch reads `entry.liveSeq ?? -1`, so clearing
`live` without touching `liveSeq` leaves the height cache serving the multi-row
measurement for a card that now draws one row. That is precisely the non-append
mutation I-L3-1 legislates against, arriving through the clause written to
prevent the *other* half of the same failure.

`toolExecEnd` is safe without the bump only because `status` moves there
(`running` → `done` / `error`), and `status` is itself a term.

**What was done.** `releaseLiveTails` writes `liveSeq: (e.liveSeq ?? 0) + 1`
alongside the two clears, and returns entries without a tail **by identity** so
the rest of the transcript's memo boundary is untouched. `live-height.test.ts`
pins the revision change, and the AC-28 mutation check turns it red along with
the two tail-update cases.

### IF-7 — Ink measures an empty `<Text>` as zero rows, and blank lines are ordinary build output

*(Found by the recording-`HeightStore` shapes written for AC-27.)*

**What the design said.** §3.3.4: "**One footer row, always**, matching the
arithmetic in §3.3.3 exactly. … A constant row count is what lets the estimate be
exact rather than an upper bound." §3.3.3 rests the whole live branch on that:
"Rows are **counted, not wrapped**."

**What the tree does.** Ink lays a `<Text>` with an empty string child out as
**zero** rows. `sanitizeChunk` produces empty rows for exactly the reason it
should — `"a

b
"` is three lines and the middle one is blank — and blank
separator lines are what `npm test`, `cargo`, `pytest` and every other build tool
print. A tail of `['', '', '']` was charged five rows and drew two.

The direction is safe (`virtual-window.ts` says an over-estimate self-corrects,
an under-estimate does not), so this is not a correctness defect. It is a defect
in the *claim*: the sentence the live branch's arithmetic is justified by would
have been false for most real `bash` output.

**What was done.** `ToolCard` renders `row.length > 0 ? row : ' '`. A space is
also what the terminal itself shows for a blank line, so this buys fidelity as
well as the exactness §3.3.4 asserts. Two shapes — mixed blanks and all-blank —
joined the recording-`HeightStore` table, which now runs fourteen rather than
twelve.

### IF-6 — AC-38 cannot be pinned on frame counts, and a synchronous burst cannot fail

**What the design said.** AC-38: "A burst of N chunks inside one governor
interval produces **one** dispatch, not N", mutation-checked against the
direct-dispatch form.

**What the obvious test does.** Two things defeat it. First, React 18 batches
updates issued in one synchronous burst, so emitting twelve chunks in a loop
produces one commit **either way** — a test that cannot fail, which is the shape
condition 2 exists to forbid. Second, frame count is not the observable: the
200 ms elapsed ticker and the spinner repaint on their own schedule, and a direct
dispatch landing inside one of their frames is invisible in the total. Measured
on the real tree, the same window gave 3 frames idle against 9 with chunks —
noisy in both directions and not a bound.

**What was done.** The chunks are emitted in **separate macrotasks**
(`setImmediate`), which is how `child.stdout` delivers them and what defeats
auto-batching, while keeping the whole burst inside one 33 ms governor interval.
The assertion is on **which tails ever reached the screen**: the buffered form
paints at most the last one per interval, the direct form paints every
intermediate one. Mutation-checked — rewriting the effect as `flushPending();
dispatch(action)` turns the case red.

### IF-8 — AC-36's "floor is header + footer = 2 rows" is unreachable, and the slice is right anyway

*(Found by the review node, recorded rather than fixed — the code is correct; the sentence is not.)*

**What the design said.** AC-36: "the tail is sliced to
`min(LIVE_TAIL_ROWS, liveClampRows)` and the card's floor is header + footer =
**2 rows**, which is the floor a clamped preview card already has (P2-7)."

**What the tree contains.** `liveClampRows` is
`Math.max(1, Math.floor(liveBudget / liveEntries.length) - 1)`
(`Transcript.tsx:580-583`) — it is **never** less than 1. So
`min(LIVE_TAIL_ROWS, liveClampRows)` is never 0, the tail always draws at least
one row, and a live card's floor is header + 1 + footer = **3**. A floor of 2
would require a clamp that slices the tail away entirely, which is the one thing
that clamp is written not to do: the comment above it says refusing to draw a
live entry at all "is worse than a tall frame".

**Why nothing is wrong with the code.** The slice clause of AC-36 holds exactly.
`ToolCard`'s `Math.max(1, liveCeiling)` is a guard on an unreachable input — for
every `liveClampRows >= 1` it is the identity, so the implemented behaviour *is*
`min(LIVE_TAIL_ROWS, liveClampRows)` — and the per-entry overshoot stays the one
row `Transcript.tsx` already documents as its residual: the clamp's `- 1` pays
for this card's unconditional footer (P2-7), and the header is the pre-existing
charge every live entry makes whatever the clamp says. The round adds no new
class of overflow, only the two rows P2-7 accounts for.

**What was done.** Nothing in the source. The floor is recorded here as **3**,
and the test named for AC-36 asserts what is actually true and load-bearing —
that the header and the footer both survive the tightest clamp — rather than a
row count the clamp cannot produce. Changing the clamp to permit a 0-row tail to
make the sentence true would trade a correct display for a literal reading of one
parenthetical.

---

## 评审结论 (Review Verdict)

**有条件通过 — Approved with conditions.**

The architecture is right and it is right for reasons the document argues rather
than asserts. Keeping `packages/core` frozen is correct: core's `onProgress` is a
declared interface with neither producer nor consumer (E-4…E-7), and reaching it
would mean widening a public union that `public-api.test.ts` freezes and that the
host application also switches on — a large, permanent cost for a display. D-22
is the load-bearing decision and it is correct: live rows must be reducer state,
because a store read during render leaves `entryRevision` unchanged and
`virtual-window.ts:51-57` states in the file what that costs. D-25's split
between a head-first settled preview and a last-first live tail is the right
answer to two genuinely different questions. And the scope is honest — L4 alone
would have satisfied a lax reading of the requirement's fourth clause, and the
document instead names the one tool where the second clause is actually unmet
and fixes that.

What v1 got wrong is what round 1 got wrong, and it is worth naming as a pattern
rather than as ten separate mistakes: **the seams**. Nine of the ten P0/P1
findings are places where a rule that reads correctly in prose lands in a
subsystem that keeps its invariant somewhere else, and then fails with nothing
reporting it — a sanitiser that never sees the bytes it was written for, an
action that never reaches the coalescer it was designed around, a prop that never
crosses a memo comparator, a field that never reaches the second of two
interfaces, a strip that was assigned to a file with no serializer, a tail that
no path releases. None of them would have thrown. Most of them would have shipped
looking approximately right on a fast local test.

**Conditions of approval.** All are already written into this v2; they are
restated because they are what the approval is contingent on, and because every
one of them fails silently if skipped.

1. **The `\r` rewrite runs on the incomplete tail, and the tail is displayed
   (P0-1 / D-33).** Pinned twice, because the sanitiser half and the display half
   fail independently: suite 1's carry-only corpus and AC-39. If implementation
   finds that showing the in-progress row is unacceptable for some reason this
   review did not foresee, that is a **return to review**, not a local decision —
   the alternative is a feature that does nothing for npm, pip, curl and docker,
   which is most of what a long `bash` call is.
2. **The output subscription pushes into `pending.current`; it does not dispatch
   (P0-2 / D-34).** Pinned by AC-38 and **mutation-checked** against the
   direct-dispatch form, because the direct form is what copying the three
   sibling subscriptions produces and it is what an implementer reading §1.2
   would write.
3. **`recordOutput` is added to `BuiltinToolsOptions` as well as `ToolDeps`, and
   forwarded (P1-1).** The failure mode is not a compile error in every
   arrangement, it is a feature that quietly does nothing. `tools/index.ts:50-61`
   is the tree's own record of this exact mistake being made once already.
4. **`nowSec` is in `EntryView`'s memo comparator, and AC-41 renders through
   `App` (P1-3).** A test that mounts `ToolCard` directly passes either way,
   which is why the mutation check is part of the condition and not an extra.
5. **Every path to idle releases the tail (P1-7 / D-35 / AC-40).** This is the
   one condition whose absence degrades the *whole session* rather than one card:
   a stranded live card pins `Transcript`'s monotonic settled boundary and
   re-renders the tail every frame until the process exits.
6. **`saveSession` strips (P1-2 / AC-34).** Not the reducer — it has no
   serializer.

Two notes for the implementer that are not conditions. `estimateEntryRows`'s
`!entry.preview` guard (P1-4) is a one-line trap with an immediate crash, so it
will be found; it is fixed in the body anyway because a plan that would crash on
the aborted-tool path should not be handed to anyone. And the P2s are
observations, not gates: P2-3 (the reverse scan) and P2-4 (never `?? []`) are the
two most worth reading before writing the App-side code, since both are silent
performance regressions in a subsystem whose entire purpose is not having those.

**Not re-litigated.** The accepted debt in §3.5 — six files over 1 000 lines, all
already over at round 1's HEAD — remains accepted. Splitting `App.tsx` or
`reducer.ts` inside a presentation round is how a presentation round becomes
unreviewable, and §8's R-10 states the alternative plainly enough.
