# Team live activity - design specification

- **Version**: **v2** (v1 reviewed; 3 P0 + 9 P1 fixed in the body, see
  `## 评审记录 (Review Notes)` below)
- **Feature slug**: `team-live-activity`
- **Round**: iteration 3 of 3, following `team-subagents` (shipped) and
  `team-agent-profiles` (designed, not implemented)
- **Baseline**: `7a6bf563` - "feat: add team subagents, a parallel delegation
  mode for the CLI agent"
- **Blast radius**: `packages/cli` only. **Zero changes under
  `packages/core/src`**, preserving AC-12 of the first round.
- **New config keys**: none. **New DB tables / migrations**: none (this CLI has
  no database). **New runtime dependencies**: none.

> **This document is deliberately pure ASCII.** `src/team/**` is inside the glyph
> scanner's scope (`packages/cli/src/team/limits.ts:5`, enforced by
> `glyphs.test.ts`), every code fragment below is destined for that tree, and the
> two earlier specs in this directory were mangled by a non-UTF-8 hop in the
> tooling pipeline. Requirement clauses are quoted in translation rather than in
> the original.
>
> **v2 exception**: the two review headings carry their mandated CJK titles with
> an English gloss appended, so the sections stay findable if this file takes
> another non-UTF-8 hop. Those four lines - two headings and two cross-references
> - are the **only** non-ASCII bytes in the file; every other line, this review's
> included, is ASCII.

---

## 评审记录 (Review Notes)

Review method: every claim v1 made about existing code was checked against the
file and line it named, at `7a6bf563`. I-1 through I-25 and I-27 all verified as
stated. I-26 did not (P2-1). The findings below are ordered by severity; each
names where in the body it is resolved.

### P0

| # | Concern | Resolved in |
|---|---|---|
| **P0-1** | **The prose activity line is not width-bounded, so F-1 breaks the row layout it inherits.** `activityChars: 64` plus the `writing: ` prefix is up to 73 characters in a column the shipped panel treats as fixed-width - `TeamPanel.tsx:146-149`, and the comment at `135-145` and I-10 both assert activity and elapsed never lose characters. Today `activity()` returns at most 16. On an 80-column terminal a row needs 3 + 8 + 2 + 73 + 2 + 6 = 94 columns before the description gets one. The only width degradation v1 specifies (`cols < activityWideCols`) applies to `describeToolActivity`; 3.2.4 returned `writing: ${run.activity}` in **both** forms. Worse, `sanitizeActivity` clamps in UTF-16 code units while the budget is display columns, so a CJK tail - which 3.2.2's own header explicitly anticipates - is up to twice as wide again. | 3.2.2, 3.2.4, 4.5, 5.1, 6.2, 7.2 |
| **P0-2** | **`canSend` is the load-bearing input to F-3 and v1 never defined it.** 3.4.2 introduced it as "optional, defaulting to `() => true`; `TeamRuntime` supplies the real answer from its handles" and stopped. The obvious implementation - "the child's phase is running" - is wrong: at the shipped defaults (`maxConcurrent: 3`, `maxSubagents: 5`) children 4 and 5 sit in `queued` while 1-3 run, so a wait on a queued peer would be refused as `all_finished`. That is exactly the false refusal R-4 claims to prevent, reached by a path R-4 does not cover. It must also read the **live** `handles` array (F-4 mutates it) and be installed on a bus that `runtime.ts:112` constructs *before* `handles` exists. | 3.4.2, 3.4.4 (new), 5.2 |
| **P0-3** | **`all_blocked` refuses waits a third party would have answered.** 3.4.1 case 3 argued a peer blocked with a deadline `>=` the caller's "cannot act first". False: a blocked peer can be released **early** by a message from someone else. `a` waits `from: b`; `b` waits `from: c`; `c` messages `b` at t=10; `b` resumes and messages `a`. v1 refuses `a` at t=0. AC-20 was written to catch the deadline half of this and misses the release-by-third-party half. | 3.4.1, 3.4.2, AC-20a |

### P1

| # | Concern | Resolved in |
|---|---|---|
| **P1-1** | **Two deadlines on two different clocks.** `makeTeamWait` passed `deadlineAt: Date.now() + timeoutMs`; `Waiter.deadlineAt` is stamped inside `wait()` from `this.now()` - the injectable clock **every** existing `team-bus.test.ts` case uses (`new TeamBus([...], { now: c.now })`, 5 sites). Comparing them compares a real timestamp with a fake one, so AC-18/19/20 cannot be written as specified. | 3.4.2, 3.4.3 |
| **P1-2** | **`no_peers` fires on four distinct situations and its copy asserts one.** `peersOf` excludes the lead (`bus.ts:79-81`), so `from: "lead"` (a value `team_send`'s own schema advertises), `from` naming a nonexistent label, `from` naming the caller, and a genuinely single-child dispatch all produced "you are the only subagent in this dispatch". Three of the four are false, and the typo case is the one where precise wording would change what the model does next. | 3.4.2, 3.4.3 |
| **P1-3** | **`from` matching is case-insensitive in `checkWaitable` and case-sensitive in `wait()`.** v1 compared `p.toLowerCase() === opts.from.toLowerCase()`; `wait()` (`bus.ts:209`) and `deliverToWaiter` (`bus.ts:248`) compare `m.from === opts.from` exactly. `from: "A2"` against label `a2` passes the new gate and then waits the full 120 s for a message the delivery filter can never match - F-3 declining to fire on exactly the case it exists for. | 3.4.2, 3.4.3 |
| **P1-4** | **`activityArgs` retained the whole tool-args object, `write_file`'s `content` included, for the life of the dispatch and past it.** `publish()` shallow-copies the run into the snapshot and into every `agent_update`; `dispatch()` copies it into `DispatchOutcome.runs`, which `TeamCard` holds in the transcript. A child writing a 2 MB file keeps 2 MB alive per write for the session, and puts a file body one `JSON.stringify` away from a log - the liability 3.6 spends a paragraph avoiding. R-13 rated this Low because the formatter never reads `content`; retention is not readership. The mitigation it declined costs nothing, because `describeToolActivity` is **already** a per-tool table. | 3.2.2, 3.2.3, 5.1, R-13 |
| **P1-5** | **`activityArgs` was never cleared.** v1 cleared `run.activity` on `turn_start` and `tool_execution_end` and argued the column "can never claim the child is writing text it finished writing"; `activityArgs` got no such treatment, which is what turned P1-4 from a per-call retention into a whole-run one. | 3.2.3 |
| **P1-6** | **The narrow form of `bash` was specified two ways and neither matched the code.** 6.2 said "`bash` with no command"; 3.2.2 routed `bash` through `detail(..., wide=false)` -> `basename(command)`, and `basename` splits on `/`: `npm test -w cli` comes back whole and `./scripts/build.sh --prod` comes back as `build.sh --prod`. | 3.2.2, 6.2 |
| **P1-7** | **One stored backoff resolver, up to `maxConcurrent` concurrent backoffs.** 3.5.3 said `backoff()` is "a stored resolver that `abortAll()` calls". A provider-wide 429 cold-starts every in-flight child into backoff at once, so two of three resolvers are overwritten and AC-17 holds for one child and not the others. | 3.5.3 |
| **P1-8** | **`runOne`'s new signature was not propagated to its caller.** `worker()` (`runtime.ts:210-224`) calls `this.runOne(dispatchId, handle, subagentTimeoutMs)`; the new signature is `(dispatchId, handles, index, makeHandle, subagentTimeoutMs)`. Neither 3.5.3 nor 7.2 mentioned `worker`. | 3.5.3, 7.2 |
| **P1-9** | **AC-20 asserted the opposite of the rule it defends.** 3.4.1 case 3 argues that the child with the LONGER deadline must be permitted, because the shorter-deadline peer wakes first and may send. AC-20 said "`b` waits 30 s on `a` ... `b` must be allowed to wait" - naming the shorter one. Under v1's own rule `b` is correctly refused: nothing can release `a` inside 30 s. An implementer following the criterion literally would have weakened a correct rule to make a wrong test pass, and the weakening would look like a bug fix. Found while checking the fixpoint (P0-3) against the criteria it has to satisfy. | AC-20, AC-20-inv |

### P2

| # | Concern | Disposition |
|---|---|---|
| **P2-1** | **I-26 is false.** `packages/cli/src/__tests__/logo.test.ts:2` imports `string-width`. It is *not* a declared dependency of `packages/cli` (neither `dependencies` nor `devDependencies`) - it resolves transitively through `ink`, which is a latent fragility in its own right. | Fixed: I-26 restated. |
| **P2-2** | `sanitizeActivity` ran two regexes per token delta even though `emit()` discards all but one result per 120 ms window. | Fixed: 3.2.3 moves it behind the throttle. |
| **P2-3** | `sanitizeActivity` guarded the trailing surrogate only. `textTail = (textTail + delta).slice(-160)` cuts at a code-unit boundary and can leave a lone **low** surrogate at the head. | Fixed: 3.2.2. |
| **P2-4** | F-4 breaks an F-2 invariant: 3.3.2 says "`startedAt` never changes once set", 3.5.3 assigns `run.startedAt = Date.now()` on every attempt. | Fixed: 3.3.2 states the interaction. |
| **P2-5** | 5.1 was titled "four new optional fields" and listed five. | Fixed: 5.1. |
| **P2-6** | File counts did not close: 7.1 promised 6 new files and omitted `manual-test.md` (required by 8.2 and 12); 7.2 listed 9 modified and omitted `packages/cli/CHANGELOG.md` (required by 7.5). | Fixed: 7.1, 7.2, 12. |
| **P2-7** | An unclaimed **fifth** abort exclusion: `agent-loop.ts:167` breaks out of the stream loop before emitting `message_update` when `ctx.signal.aborted`, so on every abort path the error event never reaches the subscriber and `run.retryable` is never set. | Fixed: recorded in 3.5.1 as defence in depth, explicitly **not** as a replacement for the four. |
| **P2-8** | `runOne` at 5 parameters sits exactly on this repo's ceiling (CLAUDE.md: at most 5 formal parameters) and the retry loop body is close to the 60-line method ceiling. | Fixed: 3.5.3 takes an options object. |

---

## 0. Requirement trace

The user's requirement for this feature has seven clauses and two quality bars.
Round 1 shipped implementations of all seven clauses. This round exists because
two of them are satisfied only in the weakest possible sense, and because the
quality bars - "elegant, top-tier design, consistent with human-computer
interaction best practice" and "robust, reliable, top-tier" - are where the
shipped code has nameable, reproducible gaps.

| Clause | Status after round 1 | This round |
|---|---|---|
| R-a: team mode on by default, toggle in the config file | Complete (`config/schema.ts:468-475`) | untouched |
| R-b: the agent decides for itself whether to delegate | Complete (`team/task-tool.ts`) | untouched |
| R-c: a final summary rolled up to the lead | Complete (`team/report.ts`) | +2 lines (F-3, F-4 signals) |
| R-d: an inter-agent channel, telephone-like, not too chatty | Complete (`team/bus.ts`) | **F-3**: the channel never notices that nobody can answer |
| R-e: a subagents mechanism like Anthropic Claude Code | Partial; named profiles designed in `team-agent-profiles`, not built | explicitly **handed forward**, see section 11 |
| R-f: adaptive count, hard max 10, configurable | Complete (`team/limits.ts:34`) | **F-2**: at counts above 5 the panel stops showing the running ones |
| R-g: the TUI must show that subagents are running | Present but thin | **F-1**, **F-2** |
| Quality: elegant / HCI best practice | - | **F-1**, **F-2** |
| Quality: robust / reliable | - | **F-3**, **F-4** |

Four work items, each traceable to a defect or a gap that can be demonstrated
against the tree at `7a6bf563`:

- **F-1 - Activity detail.** The roster proves liveness but not progress. A user
  watching five children for four minutes sees five rows that all say
  `thinking`.
- **F-2 - Panel row priority.** `TeamPanel.tsx:115` takes the first five runs by
  **array index**. With `maxSubagents` above 5 the visible rows are the ones that
  finished first, and everything still working is hidden behind `+N more`.
- **F-3 - Unanswerable waits.** `team_wait` has no idea whether anyone is left who
  could answer it. A child waiting on a peer that already finished burns its
  whole timeout and reports "No message arrived".
- **F-4 - Cold-start retry.** A child whose very first request dies on an HTTP 429
  is `[failed]` for the rest of the dispatch, even though it did nothing, touched
  nothing, and would almost certainly succeed two seconds later.

---

## 1. Overview

### 1.1 What is being built

This round makes a running dispatch **legible** and makes two of its silent
failure modes **loud**, without adding a single user-facing knob.

The legibility half is F-1 and F-2. Today `TeamPanel` renders one row per child
carrying a spinner, a label, the model's own description, a phase word, and an
elapsed clock. The phase word comes from a five-case switch over
`SubagentRun.phase` (`ui/TeamPanel.tsx:57-76`), so the middle column can only
ever say one of `queued`, `starting`, `thinking`, `tool: bash`, `waiting for
mail`, `done`, `failed`, `aborted`. That is enough to prove the process is alive
and nothing more: the difference between a child three seconds into a `grep` and
a child three minutes into a runaway `bash` is invisible, and both look exactly
like a child that is quietly failing. F-1 replaces the phase word with an
**activity line** derived from data the event stream already carries - the tool
name plus its most salient argument (`bash: npm test -w cli`, `read:
src/api/routes.ts`, `waiting for a2`), and, between tool calls, the tail of the
text the child is currently writing. F-2 fixes the row-selection defect that
makes the whole panel misleading at the fan-out widths the requirement
explicitly permits.

The robustness half is F-3 and F-4, and both are about a dispatch spending time
on an outcome that is already determined. F-3 gives `TeamBus` enough knowledge to
answer "can anyone actually send me a message before my own deadline?" - and when
the answer is no, `team_wait` returns immediately with a sentence that says why,
instead of parking the child for up to 120 seconds and then saying "No message
arrived within 120s". F-4 notices the one class of child failure that is provably
free of side effects - a transport error on the very first request, before any
turn completed and before any tool ran - and retries it exactly once after a
short backoff, so a single 429 during a five-way fan-out costs two seconds
instead of one fifth of the result.

### 1.2 Why this shape

Three constraints shaped the scope more than taste did.

**No new configuration.** `config/store.ts` merges the nested config sections by
hand, and `config/schema.ts:427-431` records that the merge is correct only while
every section stays exactly one level deep and scalars-only. Every bound this
round introduces is structural in the sense `limits.ts:8-24` already defines -
it describes what the panel can physically carry and what a retry can safely be -
so all of them go in `TEAM_LIMITS` and none of them go in `TeamConfig`. The
settings surface, the `/team` command, the persisted file format and
`clampTeamConfig` are untouched. That is worth more than the flexibility a knob
would buy: `team.*` already has six keys, and a seventh that nobody will ever set
is a maintenance cost with no user on the other end of it.

**No new event volume.** F-1 is the follow-up that round 1 deferred ("streaming a
child's text into the panel ... considerably more expensive to render. Deferred
until the coalescing budget has been measured"). The measurement is now done and
the answer is that the budget is **already being paid**: `subagent.ts:351` calls
`emit()` at the end of the subscribe handler for *every* core event including
`message_update`, and `emit()` throttles at `TEAM_LIMITS.agentUpdateThrottleMs`
(120 ms) with a phase-transition bypass (`subagent.ts:284-295`). Token deltas
already drive that throttle today; they simply do not carry anything into the
run. F-1 adds one bounded string append per delta and changes the render count by
zero. Separately, the panel's clocks advance because `App.tsx:337-347` runs a
200 ms interval while `state.status === 'running'`, and the lead is `running` for
the whole dispatch because it is blocked inside `task` - so no part of this round
needs a timer of its own.

**No mechanism a child could exploit to widen its own permissions.** Both earlier
review rounds found the same class of P0: the design reasoned about the lead and
assumed children inherit its safety properties. Every item here is therefore
either read-only with respect to the child (F-1 observes an event stream, F-2 is
a pure function over a snapshot) or strictly *narrowing* (F-3 makes a wait end
sooner; F-4 only ever runs when the child has provably done nothing at all).
Nothing in this round can make a child able to do something it could not do at
`7a6bf563`.

### 1.3 Non-goals

1. **Named agent profiles.** `docs/plans/team-agent-profiles/spec.md` is a
   reviewed, approved-with-conditions design at 1465 lines and it is not
   implemented. This round does not restate it, does not partially implement it,
   and does not conflict with it - see section 11 for the explicit hand-off and
   the two places the two designs touch.
2. **Full child transcripts.** Round 1's follow-up 3 wanted `--team-transcripts`.
   `TeamCard` already keeps per-child summaries in the transcript
   (`ui/entries/TeamCard.tsx:127-135`) and `aragon logs tail --level trace`
   already records briefs and summaries, so what remains is the rarer verbatim
   case. Out of scope; it interacts with the session file format.
3. **Streaming a child's *thinking* into the panel.** Text deltas only. Reasoning
   traces are the most sensitive thing a model emits, a one-line roster is the
   worst possible place to surface them, and the panel is on screen by default.
4. **Retrying anything except a cold start.** A child that failed after touching
   a file cannot be retried safely and this round does not try. See D-7.
5. **A per-child detail view or an interactive roster.** The panel stays a
   read-only band inside `AppShell`'s measured bottom box; making it focusable
   would put a second key-handling surface next to the composer.

---

## 2. Constraints inherited from the shipped code

Each claim below was checked against the file and line named, at `7a6bf563`.
They are the facts the design is built on; if any of them is false the design
above it is wrong.

| # | Constraint | Evidence |
|---|---|---|
| I-1 | The panel takes visible rows by array index, not by state. | `ui/TeamPanel.tsx:115` - `snapshot.runs.slice(0, TEAM_LIMITS.panelMaxRows)` |
| I-2 | `panelMaxRows` is 5; `hardMaxSubagents` is 10; the default `maxConcurrent` is 3. So at a fan-out of 6+ the first five rows are the ones the slot pool started first, i.e. the ones that finish first. | `team/limits.ts:34,82`; `config/schema.ts:468-475` |
| I-3 | The slot pool hands out indices from a shared cursor in order. | `team/runtime.ts:210-224` |
| I-4 | The middle column is a pure switch over `phase` and can carry nothing else. | `ui/TeamPanel.tsx:57-76` |
| I-5 | `emit()` is called for **every** core event and throttled at 120 ms, with phase transitions bypassing the throttle. | `team/subagent.ts:284-295,351` |
| I-6 | `tool_execution_start` carries the fully parsed `args`. `noteFile` already reads `args.path` from it. | `packages/core/src/types.ts:44-49`; `team/subagent.ts:297-304` |
| I-7 | `message_update` carries a `StreamEvent`; `text_delta` has `delta: string`, `error` has `error: Error`. | `packages/core/src/llm/types.ts:112-115,151-154` |
| I-8 | The panel's clocks advance because `App` re-renders on a 200 ms interval while the lead is running, not because anything in `src/team` ticks. | `ui/App.tsx:337-347` |
| I-9 | `TeamPanel` receives `rows` but **not** `cols`. `App` has `cols` in scope at the render site. | `ui/TeamPanel.tsx:29-38`; `ui/App.tsx:1091-1108` |
| I-10 | `description` is the only flexible column; activity and elapsed never lose characters under width pressure. | `ui/TeamPanel.tsx:135-145` |
| I-11 | A blocked `team_wait` cannot send: the child's agent loop is awaiting the tool call. A child in `team_wait` is therefore not a possible sender until its own wait ends. | `team/comm-tools.ts:154-165` |
| I-12 | The **lead** can never send on the bus. Its mail is collected for the report and there is no `team_send` on a lead. | `team/bus.ts:155-161`; `team/subagent.ts:126-132` (comm tools are built per child) |
| I-13 | `bus.wait()` registers a `Waiter` with `key` and optional `from` and knows nothing about liveness or deadlines. | `team/bus.ts:41-45,204-238` |
| I-14 | A single wait is clamped to `waitMaxSeconds` (120 s) and to the child's `subagentTimeoutMs`. | `team/comm-tools.ts:148-152`; `team/limits.ts:71-73` |
| I-15 | `run.messagesSent` is refreshed from the bus on `tool_execution_end`, not counted from tool calls. This is the established pattern for pulling a bus-owned counter into a run. | `team/subagent.ts:336-342` |
| I-16 | `this.live = handles` assigns the **same array reference**, so replacing `handles[i]` also replaces what `abortAll()` will abort. | `team/runtime.ts:142,285-296` |
| I-17 | The outcome is built by mapping over `handles` after the workers settle, so a handle swapped in during the run is the one that reaches the report. | `team/runtime.ts:178-193` |
| I-18 | `runOne` resolves the final phase in a fixed order: aborted, then timed out, then error, then no-summary, then done. | `team/runtime.ts:255-272` |
| I-19 | `LLMError` carries `retryable: boolean`, is exported from core's public API, and that export is pinned by a test. | `packages/core/src/llm/provider.ts:106-118`; `packages/core/src/index.ts:69`; `packages/core/src/__tests__/public-api.test.ts:28` |
| I-20 | **`wrapFetchError` marks an `AbortError` as `errorType: 'timeout'`, `retryable: true`.** Every abort in this system therefore *looks* retryable. | `packages/core/src/llm/provider.ts:181-203` |
| I-21 | `formatStreamError` reads `errorType` **structurally** off the error rather than using `instanceof`. | `agent/reducer.ts:332-335` |
| I-22 | The logging projection of `agent_update` is `{label, phase, lastTool}` and is recorded on phase transitions only. Bodies of `team_send` are never recorded at any level; briefs and summaries are `trace` only. | `logging/install.ts:404-408,438-452` |
| I-23 | Headless prints one `start` line and one terminal line per label, guarded by two `Set`s. | `agent/headless.ts:99-127` |
| I-24 | Every refusal on the team channel is a non-error `textResult`; an `errorResult` reads to a model as a malfunction and invites a retry. | `team/comm-tools.ts:13-15,73-94` |
| I-25 | The builtin tool names and their salient arguments are: `read_file`/`write_file`/`edit_file`/`list_dir` -> `path`, `glob` -> `pattern`, `grep` -> `pattern` (+ optional `path`), `bash` -> `command`. | `tools/fs-tools.ts:40,86,120,183`; `tools/search-tools.ts:30,83`; `tools/bash-tool.ts:50` |
| I-26 | There is **no** display-width helper in `packages/cli/src` **production** code; truncation for display is Ink's `wrap="truncate"`. `string-width` is imported by exactly one file, `__tests__/logo.test.ts:2`, and is **not** a declared dependency of `packages/cli` - it resolves transitively through `ink`. So a column budget in this round must be expressible in code units, and it must be conservative, because a code-unit count under-reports the display width of CJK and emoji by up to 2x. | `packages/cli/package.json`; `__tests__/logo.test.ts:2`; `ui/TeamPanel.tsx:142,146` |
| I-28 | The agent loop checks `ctx.signal.aborted` at the **top** of each stream iteration and `break`s before `ctx.emit({type:'message_update'})`, so on an aborted request the provider's `error` event never reaches a subscriber. | `packages/core/src/engine/agent-loop.ts:166-177` |
| I-29 | `packages/core` performs **no** retry of a retryable `LLMError`. The provider yields `{type:'error'}`, the loop forwards it as `message_update` and then throws it. | `packages/core/src/engine/agent-loop.ts:170-177`; repo-wide grep for `retryable` under `packages/core/src` |
| I-27 | `report.ts` already guards against splitting a UTF-8 sequence when truncating, because a mid-sequence cut renders as a replacement character. | `team/report.ts:38-53` |

---

## 3. Technical design

### 3.1 Module map

Three new modules, all pure, all in `src/team/`, all unit-testable without an
`Agent`, a network or a terminal:

```
src/team/activity.ts     F-1  describeToolActivity(), sanitizeActivity()
src/team/panel-rows.ts   F-2  selectPanelRows()
src/team/retry.ts        F-4  isRetryableStreamError(), shouldRetryColdStart()
```

F-3 has no new module: it is a new **pure** method on `TeamBus`
(`checkWaitable`) plus a counter, because it needs the waiter set and the
mailboxes and moving those out would be a refactor rather than a feature.

Everything else is a small edit to a file that already exists. The full list is
section 7.

### 3.2 F-1: the activity line

#### 3.2.1 Where the text comes from

Two sources, both already flowing through `subagent.ts`'s subscriber (I-5):

- **`tool_execution_start`** carries `{toolName, args}` with `args` fully parsed
  (I-6). This is the high-value source: it is precise, it is one event per tool
  call rather than one per token, and it covers the case a user most wants to see
  (`bash: npm test`).
- **`message_update`** with `streamEvent.type === 'text_delta'` carries the
  child's prose as it is written (I-7). This is the low-value-but-continuous
  source that fills the gap between tool calls, where the panel today says
  `thinking` for minutes at a time.

Thinking deltas are deliberately **not** read (non-goal 3).

#### 3.2.2 `src/team/activity.ts`

```ts
/**
 * Activity strings for the live roster (team-live-activity F-1).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope. That rule binds
 * the LITERALS IN THIS FILE, not the runtime data flowing through it - a child
 * may well be reading a CJK path, and `run.description` already carries model
 * text into the same row.
 */

import { TEAM_LIMITS } from './limits.js';

/**
 * The only part of a tool call this module will ever render (P1-4).
 *
 * A PICKED SUBSET, NOT THE ARGS OBJECT. Storing `event.args` whole would put
 * `write_file`'s `content` - a whole file - on the run, and `TeamRuntime.publish`
 * shallow-copies the run into the live snapshot AND into every `agent_update`
 * event, and `dispatch()` copies it again into `DispatchOutcome.runs`, which
 * `TeamCard` holds in the transcript for the rest of the session. Two facts make
 * that unacceptable rather than merely wasteful: the retention is unbounded in
 * the file's size, and one `JSON.stringify` anywhere downstream would put a file
 * body into a log - the exact liability 3.6 spends a paragraph avoiding.
 *
 * This costs nothing in maintenance: the switch below is ALREADY a per-tool
 * table, so a new tool is one entry either way.
 */
export interface ActivityArgs {
  path?: string;
  pattern?: string;
  command?: string;
  to?: string;
  from?: string;
}

/** Pick at capture time. Called once per `tool_execution_start`. */
export function pickActivityArgs(args: unknown): ActivityArgs {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, TEAM_LIMITS.activityArgChars) : undefined;
  const picked: ActivityArgs = {};
  const path = str(a.path);
  const pattern = str(a.pattern);
  const command = str(a.command);
  const to = str(a.to);
  const from = str(a.from);
  if (path !== undefined) picked.path = path;
  if (pattern !== undefined) picked.pattern = pattern;
  if (command !== undefined) picked.command = command;
  if (to !== undefined) picked.to = to;
  if (from !== undefined) picked.from = from;
  return picked;
}

/**
 * Strip anything that could corrupt the frame, collapse whitespace, and clamp.
 *
 * THE CONTROL-CHARACTER STRIP IS A CORRECTNESS BOUNDARY, NOT TIDINESS. This
 * string is model-chosen and reaches an Ink <Text> unescaped. A child running
 * `bash` with an ANSI escape in the command line would otherwise write that
 * escape into the roster: at best a mangled row, at worst a cleared screen or a
 * moved cursor in the middle of someone's transcript. `bash`'s own output never
 * reaches the panel; its ARGUMENTS now do.
 *
 * SURROGATES ARE GUARDED AT BOTH ENDS (P2-3). The trailing guard is the obvious
 * one. The LEADING one is needed because the caller feeds this a rolling tail
 * built with `String.slice(-n)`, which cuts on a UTF-16 code-unit boundary and
 * can therefore hand us a lone LOW surrogate at index 0. Either half of a split
 * pair renders as a replacement character - the same failure `truncateBytes`
 * guards one layer down (report.ts:38-53).
 */
export function sanitizeActivity(raw: string, maxChars: number): string {
  let src = raw;
  const head = src.charCodeAt(0);
  if (head >= 0xdc00 && head <= 0xdfff) src = src.slice(1);
  const flat = src
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxChars <= 0) return '';
  if (flat.length <= maxChars) return flat;
  if (maxChars <= 3) return flat.slice(0, maxChars);
  let cut = maxChars - 3;
  const code = flat.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${flat.slice(0, cut)}...`;
}

/** The basename of a path, for the narrow form. Pure string work: no `path`. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The program name of a command line, for the narrow form. */
function program(commandLine: string): string {
  const first = commandLine.trim().split(/\s+/)[0] ?? '';
  return basename(first) || commandLine;
}

/**
 * One short phrase describing a tool call.
 *
 * `wide` false is the narrow-terminal form (D-4). For a path-valued argument
 * that is the basename; for `bash` it is the PROGRAM NAME (P1-6). Running the
 * command line through `basename` - which is what v1 specified - is wrong twice
 * over: `basename` splits on `/`, so `npm test -w cli` comes back whole and
 * `./scripts/build.sh --prod` comes back as `build.sh --prod`. Neither is
 * shorter and the second is a lie about what ran.
 *
 * Anything not in the table renders as its own name. That is the correct
 * degradation for `skill_find` and for any tool a later round registers on a
 * child: a name is always true, and inventing an argument mapping for a tool
 * this module has not been taught is how a formatter starts lying.
 */
export function describeToolActivity(
  toolName: string,
  args: ActivityArgs | undefined,
  wide: boolean,
): string {
  const a = args ?? {};
  switch (toolName) {
    case 'read_file':
      return detail('read', a.path, wide, basename);
    case 'write_file':
      return detail('write', a.path, wide, basename);
    case 'edit_file':
      return detail('edit', a.path, wide, basename);
    case 'list_dir':
      return detail('list', a.path ?? '.', wide, basename);
    case 'glob':
      return detail('glob', a.pattern, wide, basename);
    case 'grep':
      return detail('grep', a.pattern, wide, basename);
    case 'bash':
      return detail('bash', a.command, wide, program);
    case 'team_send': {
      const to = (a.to ?? '').trim();
      return to ? `messaging ${to}` : 'messaging';
    }
    case 'team_wait': {
      const from = (a.from ?? '').trim();
      return from ? `waiting for ${from}` : 'waiting for mail';
    }
    default:
      return toolName;
  }
}

function detail(
  verb: string,
  value: string | undefined,
  wide: boolean,
  narrow: (v: string) => string,
): string {
  const v = (value ?? '').trim();
  if (v.length === 0) return verb;
  return `${verb}: ${wide ? v : narrow(v)}`;
}
```

Note what `describeToolActivity` gives away for free: `team_wait`'s `from`
argument is already on the event, so the roster can say `waiting for a2` instead
of `waiting for mail` **without any plumbing between `comm-tools.ts` and the
run**. The same trick covers `team_send`'s recipient.

#### 3.2.3 Wiring in `subagent.ts`

Inside `createSubagent`, next to the existing `noteFile` helper:

```ts
  // The tail of the text the child is writing right now. Bounded on every
  // append: a long turn would otherwise grow this without limit, and it is the
  // only per-token allocation this feature adds.
  let textTail = '';
```

and in the subscriber:

```ts
      case 'turn_start':
        run.phase = 'thinking';
        textTail = '';
        run.activity = undefined;      // a new turn is not the last turn's work
        run.activityArgs = undefined;
        break;
```

```ts
      case 'tool_execution_start':
        run.phase = event.toolName === 'team_wait' ? 'waiting' : 'tool';
        run.lastTool = event.toolName;
        run.toolCalls += 1;
        run.activity = undefined;                            // prose is stale now
        run.activityArgs = pickActivityArgs(event.args);     // PICKED, not raw (P1-4)
        noteFile(event.toolName, event.args);
        break;
```

```ts
      case 'tool_execution_end':
        run.phase = 'thinking';
        textTail = '';
        run.activity = undefined;
        // CLEARED, like `activity` (P1-5). Leaving it set would keep the picked
        // strings alive for the whole run and past it - `publish()` copies the
        // run into the snapshot and into every event, and `dispatch()` copies it
        // into the outcome the transcript holds - for a value nothing renders
        // once the phase is back to `thinking`.
        run.activityArgs = undefined;
        if (event.toolName === 'team_send') run.messagesSent = deps.bus.sentCount(spec.label);
        if (event.toolName === 'team_wait') run.blockedWaits = deps.bus.blockedWaitCount(spec.label);
        break;
```

```ts
      case 'message_update':
        if (event.streamEvent.type === 'error') {
          run.error = formatStreamError(event.streamEvent.error);
          run.retryable = isRetryableStreamError(event.streamEvent.error);
        } else if (event.streamEvent.type === 'text_delta') {
          // O(1) per delta: one bounded concat + one bounded slice, and NOTHING
          // else. Sanitizing here would run two regexes per token for a result
          // `emit()` throws away 99 times out of 100 (P2-2); it happens once per
          // emitted frame instead, in `flushActivity` below.
          textTail = (textTail + event.streamEvent.delta).slice(-TEAM_LIMITS.activityTailChars);
        }
        break;
```

and one line inside `emit()`, on the path that has already decided to publish:

```ts
  const emit = (): void => {
    const now = Date.now();
    if (run.phase === lastPhase && now - lastEmit < TEAM_LIMITS.agentUpdateThrottleMs) return;
    lastPhase = run.phase;
    lastEmit = now;
    // Exactly one sanitize per PUBLISHED frame rather than one per token (P2-2).
    // `textTail` is cleared on `turn_start` and `tool_execution_end`, so an empty
    // tail is how "not writing anything right now" is expressed.
    run.activity = textTail.length > 0
      ? sanitizeActivity(textTail, TEAM_LIMITS.activityChars)
      : undefined;
    hooks.onUpdate({ ...run, filesTouched: [...run.filesTouched] });
  };
```

**The formatting decision that keeps this cheap.** `run.activity` holds only the
*prose* case, sanitized and clamped to the hard storage ceiling
`TEAM_LIMITS.activityChars`. The *tool* case is stored as the picked
`run.activityArgs` and phrased by the panel, because the panel is the only place
that knows the terminal width and therefore whether the wide or narrow form
applies (D-4). Storing a width-dependent string in the run would bake one
terminal's width into a value the report and the headless writer also read.

Note the division of labour that P0-1 forced into the open: `activityChars` is a
**storage** ceiling (how much prose a run may carry), not a **display** budget
(how many columns the row can spare). The display budget is computed by the
panel from `cols` in 3.2.4, and it is always <= the storage ceiling.

`run.activity` and `run.activityArgs` are both cleared on `turn_start` and on
`tool_execution_end`, and `activityArgs` is additionally replaced on every
`tool_execution_start`, so neither column can ever claim the child is doing work
it finished two minutes ago. During a tool call the panel uses `activityArgs`;
between tool calls it uses `activity`; when neither is set it falls back to the
phase word exactly as today.

#### 3.2.4 Rendering

`ui/TeamPanel.tsx`'s `activity(run)` becomes `activityLine(run, cols)`:

```ts
/**
 * How many characters the activity column may spend at this width (P0-1).
 *
 * THIS IS THE FIX FOR THE ONE THING v1 GOT STRUCTURALLY WRONG. `activityChars`
 * is a STORAGE ceiling; a terminal has a COLUMN budget, and the two are not the
 * same number. The shipped row is
 *
 *     marker(3) + label(8) + description(flex) + 2 + activity + 2 + elapsed(~6)
 *
 * and the comment at TeamPanel.tsx:135-145 - repeated as I-10 - promises that
 * activity and elapsed never lose characters, i.e. that `description` absorbs
 * ALL width pressure. A 64-character prose tail plus `writing: ` is 73, which on
 * an 80-column terminal needs 94 columns before `description` gets one. The
 * promise cannot be kept by wishing; the column has to be sized from `cols`.
 *
 * `WIDE_CHAR_ALLOWANCE` is the concession to I-26: there is no display-width
 * helper in production code and `string-width` is not a declared dependency, so
 * this budget is denominated in code units while the terminal is denominated in
 * columns. CJK and emoji occupy two columns per unit, so the budget is halved
 * against the reserve rather than spent to the last cell. Erring small costs a
 * few characters of prose; erring large costs the elapsed column.
 */
const ROW_RESERVED_COLS = 3 + 8 + 2 + 2 + 8 + 12; // marker, label, gaps, elapsed, min description
const WIDE_CHAR_ALLOWANCE = 2;

export function activityBudget(cols: number): number {
  const spare = Math.floor((cols - ROW_RESERVED_COLS) / WIDE_CHAR_ALLOWANCE);
  return Math.max(TEAM_LIMITS.activityMinChars, Math.min(TEAM_LIMITS.activityChars, spare));
}

function activityLine(run: SubagentRun, cols: number): string {
  const wide = cols >= TEAM_LIMITS.activityWideCols;
  const budget = activityBudget(cols);
  switch (run.phase) {
    case 'queued':   return 'queued';
    case 'starting': return run.retries ? 'starting (retry)' : 'starting';
    case 'thinking':
      // Clamped AT RENDER, against this terminal's budget. `run.activity` was
      // clamped at STORE against `activityChars`; that is a ceiling, not a fit.
      return run.activity
        ? `writing: ${sanitizeActivity(run.activity, budget)}`
        : 'thinking';
    case 'tool':
    case 'waiting':
      return run.lastTool
        ? sanitizeActivity(describeToolActivity(run.lastTool, run.activityArgs, wide), budget)
        : (run.phase === 'waiting' ? 'waiting for mail' : 'tool');
    case 'done':     return `done  ${run.turns} turns`;
    case 'failed':   return 'failed';
    case 'aborted':  return 'aborted';
  }
}
```

Two width policies, and they answer different questions:

- **`wide` (`cols >= TEAM_LIMITS.activityWideCols`, 100)** decides *which fact*
  to show: a whole path or its basename, a whole command line or its program
  name. This mirrors `StatusBar`'s existing `statusCompactCols` degradation
  (`team/limits.ts:86`, `ui/StatusBar.tsx:166`) rather than inventing a second
  threshold, and it is why `TeamPanel` gains a `cols` prop (I-9).
- **`activityBudget(cols)`** decides *how much of it fits*. It is a continuous
  function of width rather than a second threshold, because the failure it
  prevents - a row wider than the terminal - is continuous.

Second half of the fix, in the row itself. The activity cell becomes shrinkable
so that Yoga, not arithmetic, has the last word:

```tsx
            <Box flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={color}>
                {'  '}
                {activityLine(run, cols)}
              </Text>
            </Box>
```

Belt and braces on purpose. The budget keeps the row *readable*; `flexShrink={1}`
plus `overflow="hidden"` keeps a miscounted wide character from pushing the
elapsed column off the screen. Neither alone is sufficient: arithmetic cannot see
double-width glyphs (I-26) and flex-shrink alone would silently eat the whole
column at 80 columns instead of showing a short, true phrase.

I-10 is preserved in the sense that matters: `description` remains the column
that absorbs width pressure *first*, and `elapsed` still never loses a character.
What changes is that `activity` is now a bounded, width-aware column rather than
an unbounded one, which is the only way the promise stays true at all.

### 3.3 F-2: which rows the panel shows

#### 3.3.1 The defect, stated precisely

At `maxSubagents: 8, maxConcurrent: 3`, the slot pool starts indices 0, 1 and 2,
then 3, 4, 5 as slots free (I-3). By the time indices 5-7 are running, indices
0-4 have finished. `TeamPanel.tsx:115` slices the first five by index, so the
panel shows **five green settled rows and `+3 more`** while three children are
working. The one thing clause R-g asks for - a display that shows subagents are
running - is the one thing that display is not doing.

This is reachable with the shipped defaults the moment a user raises
`maxSubagents` past 5, which `/team max 8` invites them to do and
`clampTeamConfig` permits up to 10.

#### 3.3.2 `src/team/panel-rows.ts`

```ts
export interface PanelRows {
  visible: SubagentRun[];
  hiddenTotal: number;
  hiddenRunning: number;
}

const RUNNING: ReadonlySet<string> = new Set(['starting', 'thinking', 'tool', 'waiting']);
const SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'aborted']);

/** 0 running, 1 queued, 2 settled. */
function group(run: SubagentRun): number {
  if (RUNNING.has(run.phase)) return 0;
  if (SETTLED.has(run.phase)) return 2;
  return 1;
}

/**
 * Rank the roster so that what is VISIBLE is what is HAPPENING.
 *
 * Ordering inside each group is chosen for ROW STABILITY, which is the real
 * usability constraint here: the panel re-renders every 200 ms (App.tsx:337-347)
 * and a row that changes position on each tick is unreadable.
 *  - running: by `startedAt` ascending. `startedAt` changes exactly once in a
 *    run's life outside of its first assignment - on a cold-start retry (F-4,
 *    3.5.3), which re-stamps it (P2-4). A retried child therefore moves to the
 *    end of the running group, once, at the moment it visibly restarts. That is
 *    the correct reading of the ordering rule rather than an exception to it:
 *    the group is ordered by "how long has this been going", and a retry resets
 *    exactly that.
 *  - queued: original order; that IS the order the pool will start them in.
 *  - settled: most recently ended first, so the newest result is the one that
 *    stays on screen as others complete.
 * A run changes position at most twice in its life - queued -> running ->
 * settled - and each move carries real information.
 *
 * The final tiebreak is the original index. `Array.prototype.sort` is stable in
 * every Node this package supports, so the tiebreak is not load-bearing; it is
 * here so the ordering is total and the test can assert it without depending on
 * that guarantee.
 */
export function selectPanelRows(runs: SubagentRun[], max: number): PanelRows {
  const ranked = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const ga = group(a.run);
      const gb = group(b.run);
      if (ga !== gb) return ga - gb;
      if (ga === 0) return (a.run.startedAt ?? 0) - (b.run.startedAt ?? 0) || a.index - b.index;
      if (ga === 2) return (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0) || a.index - b.index;
      return a.index - b.index;
    })
    .map((e) => e.run);

  const limit = Math.max(0, max);
  const visible = ranked.slice(0, limit);
  const hidden = ranked.slice(limit);
  return {
    visible,
    hiddenTotal: hidden.length,
    hiddenRunning: hidden.filter((r) => RUNNING.has(r.phase)).length,
  };
}
```

#### 3.3.3 The hidden-row line

`+3 more` becomes `+3 more (1 running)` when `hiddenRunning > 0`. With the
ranking above `hiddenRunning` can only be non-zero when more than
`panelMaxRows` children are running at once, which requires `maxConcurrent > 5`
- rare, and precisely the case where the old line was most misleading.

### 3.4 F-3: waits nobody can answer

#### 3.4.1 The four cases, and why they are safe to refuse

A `team_wait` is **unanswerable** when no participant that could send to this
child will be able to do so before this child's own deadline. Four ways that
happens, all decidable from state the bus either has or can be given:

1. **Nobody is addressable.** A one-child dispatch (`peersOf` is empty), or
   `from` naming the caller itself. `resolveRecipients` already treats both as
   unroutable for `send` (`bus.ts:176-182`); `wait` currently does not.
2. **`from` names something that cannot be a sender.** A label that does not
   exist (a typo), or `lead` - which `team_send`'s own schema advertises as a
   destination and which is therefore a plausible thing for a model to wait on,
   even though the lead never sends (I-12). v1 folded this into case 1 and told
   the child "you are the only subagent in this dispatch", which is false in a
   five-way fan-out and unhelpful in every case (P1-2). It is its own reason with
   its own sentence, and the sentence lists the labels that DO exist.
3. **Everyone who could answer has finished.** A settled child cannot send
   again - it has no loop left. The bus does not know this today; `TeamRuntime`
   does, because it holds the handles (3.4.5).
4. **Everyone who could answer is deadlocked against this caller.** This is the
   mutual-wait case and it is the trap in the whole item. Two independent things
   have to be true before a refusal here is sound:

   - **The deadline comparison.** If `a` waits 120 s on `b` while `b` waits 30 s
     on `a`, then at t=30 s `b` times out, returns to its loop, and may well send
     to `a`. Refusing `a` at t=0 would destroy a legitimate outcome. So a blocked
     peer only counts as unable to act if its own deadline is **>= the caller's**.
   - **Closure over who could release it (P0-3).** v1 stopped at the deadline and
     concluded that such a peer "cannot act first". That is false: a blocked peer
     can be released **early** by a message from a third party. Chain: `a` waits
     `from: b`; `b` waits `from: c`; `c` messages `b` at t=10; `b` resumes and
     messages `a` at t=12. v1 refuses `a` at t=0 and throws that away. A blocked
     peer therefore only counts as unable to act if **its own** acceptable-sender
     set is itself confined to participants that are finished, or blocked past
     the caller's deadline, or the caller (who is about to block).

   Computing that is a two-line fixpoint over at most ten participants, and the
   fixpoint is what makes the refusal a genuine deadlock proof rather than a
   guess. The 2-cycle that AC-19 tests is the smallest instance of it.

The lead is never an acceptable sender (I-12) and a blocked child is never a
possible sender until its wait ends (I-11). Both facts are load-bearing.

**When in doubt, wait.** Every ambiguity in this section resolves toward
returning `null` (permit the wait). A wait that should have been refused costs
seconds; a refusal that should have been a wait destroys a result, and the child
has no way to tell that it happened.

#### 3.4.2 Bus changes

`TeamBusOptions` gains one optional member:

```ts
  /**
   * Whether `label` still has a loop that could call `team_send`.
   *
   * Optional and defaulting to `() => true`, so every existing construction site
   * and every existing test keeps its current behaviour exactly. `TeamRuntime`
   * supplies the real answer (3.4.5), and getting that implementation wrong is
   * the highest-consequence mistake available in this item - see P0-2.
   */
  canSend?: (label: string) => boolean;
```

`Waiter` gains `deadlineAt: number`, set in `wait()` from
`this.now() + Math.max(0, opts.timeoutMs)`.

Two private helpers, both linear scans over at most ten entries - called once per
`team_wait`, so a scan is the right data structure:

```ts
/**
 * Canonical label for a model-supplied `from`, or `undefined` (P1-3).
 *
 * PUBLIC, because `makeTeamWait` has to hand the SAME string to `checkWaitable`
 * and to `wait()`.
 */
resolveLabel(raw: string): string | undefined {
  const t = raw.trim().toLowerCase();
  return this.labels.find((l) => l.toLowerCase() === t);
}

private waiterFor(label: string): Waiter | undefined {
  for (const w of this.waiters) if (w.key === label) return w;
  return undefined;
}
```

`resolveLabel` closes P1-3. v1 compared peers case-insensitively but left the
mailbox peek and `wait()`'s own delivery filter (`bus.ts:209`, `bus.ts:248`)
comparing `m.from === opts.from` **exactly**. So `from: "A2"` against a label
`a2` passed the new gate and then waited the full 120 s for a message the
delivery filter can never match - F-3 declining to fire on precisely the case it
exists for.

The fix is to canonicalize **once, in `makeTeamWait`**, and use the result for
both calls (3.4.3). `wait()` and `deliverToWaiter` are then unchanged and simply
start receiving a string that matches: this repairs the pre-existing
case-sensitivity as a side effect, without touching either function.

The refusal type, now four reasons (P1-2):

```ts
export type WaitRefusal =
  | { reason: 'no_peers' }
  | { reason: 'unknown_sender'; asked: string; peers: string[] }
  | { reason: 'all_finished'; who: string[] }
  | { reason: 'all_blocked'; who: string[] };
```

And the method. **Pure**: no counters, no mutation, no waiter registration;
`makeTeamWait` records the refusal (D-6).

```ts
/**
 * Decide whether waiting could possibly pay off.
 *
 * TAKES `timeoutMs`, NOT `deadlineAt` (P1-1). v1 had `makeTeamWait` compute
 * `Date.now() + timeoutMs` and compare it against `Waiter.deadlineAt`, which is
 * stamped from `this.now()` - the INJECTABLE clock that all five existing
 * `team-bus.test.ts` construction sites already pass. That compares a real
 * timestamp with a fake one. The deadline is derived here, from the one clock
 * this class has.
 *
 * BIASED TOWARD PERMITTING. Every branch that cannot be decided returns `null`.
 */
checkWaitable(key: string, opts: { from?: string; timeoutMs: number }): WaitRefusal | null {
  const peers = this.peersOf(key);
  if (peers.length === 0) return { reason: 'no_peers' };

  let acceptable = peers;
  if (opts.from !== undefined) {
    const canonical = this.resolveLabel(opts.from);
    // Covers a typo, `lead` (which never sends - I-12), and the caller's own
    // label. All three are "this wait can never be satisfied", and none of them
    // is "you have no teammates".
    if (canonical === undefined || canonical === key) {
      return { reason: 'unknown_sender', asked: opts.from.trim(), peers };
    }
    acceptable = [canonical];
  }

  // Something is already in the mailbox: `wait()` will return it synchronously,
  // so this is never a pointless wait however dead the peers are. Matched with
  // the SAME canonical label `wait()` will use (P1-3).
  const want = opts.from !== undefined ? this.resolveLabel(opts.from) : undefined;
  const queued = this.mailboxes.get(key) ?? [];
  if (queued.some((m) => want === undefined || m.from === want)) return null;

  const deadlineAt = this.now() + Math.max(0, opts.timeoutMs);

  // A peer can act unless it is finished, or blocked past our own deadline.
  const finished = (p: string): boolean => !this.canSend(p);
  const blockedPast = (p: string): boolean => {
    const w = this.waiterFor(p);
    return w !== undefined && w.deadlineAt >= deadlineAt;
  };

  const stuck: string[] = [];
  for (const peer of acceptable) {
    if (finished(peer) || blockedPast(peer)) { stuck.push(peer); continue; }
    return null;   // this one could still send in time
  }

  // FIXPOINT (P0-3). Everyone acceptable is stuck; that is not yet a proof,
  // because a blocked peer can be released EARLY by a third party. Grow the
  // "cannot act" set until it closes: a blocked peer stays in it only while
  // everyone who could wake it is also in it (or is the caller, who is about to
  // block). If growth stops with an acceptable peer outside the set, that peer
  // can still be woken and we must permit the wait.
  const cannotAct = new Set<string>([key, ...peers.filter(finished)]);
  for (const p of stuck) cannotAct.add(p);
  for (;;) {
    let shrank = false;
    for (const p of [...cannotAct]) {
      if (p === key || finished(p)) continue;
      const w = this.waiterFor(p);
      // Not blocked at all -> free to send whenever it likes.
      if (w === undefined) { cannotAct.delete(p); shrank = true; continue; }
      // Who could release `p`? Its own acceptable senders - and `peersOf`, NOT
      // `participants`, because the lead is never a sender (I-12). Using
      // `participants` here would put `lead` in every from-less waiter's waker
      // set, `lead` is never in `cannotAct`, and `all_blocked` would become
      // unreachable for exactly the from-less waits it was written for.
      const wakers = w.from ? [w.from] : this.peersOf(p);
      if (wakers.some((x) => x !== p && !cannotAct.has(x))) {
        cannotAct.delete(p);
        shrank = true;
      }
    }
    if (!shrank) break;
  }
  if (acceptable.some((p) => !cannotAct.has(p))) return null;

  const dead = acceptable.filter(finished);
  if (dead.length === acceptable.length) return { reason: 'all_finished', who: dead };
  return { reason: 'all_blocked', who: acceptable };
}
```

The fixpoint shrinks rather than grows, and it terminates because each pass
either removes at least one member or stops. At ten participants the worst case
is a hundred set lookups, once per `team_wait`, and `team_wait` is itself
rate-limited by the message budget (R-10).

Plus a counter, following I-15's established pattern exactly:

```ts
recordBlockedWait(label: string): void { /* this.blocked.set(label, n + 1) */ }
blockedWaitCount(label: string): number { /* ... */ }
```

**`wait()` itself is not modified** beyond stamping `deadlineAt` on the waiter.
Its signature, its return type and its semantics are untouched, so
`team-bus.test.ts`'s existing cases keep passing unchanged. That is the seam that
makes this item cheap.

#### 3.4.3 `makeTeamWait` changes

Between the timeout clamp and `bus.wait`:

```ts
      // `timeoutMs`, not a deadline: the bus owns the clock (P1-1).
      const refusal = bus.checkWaitable(selfKey, {
        ...(from ? { from } : {}),
        timeoutMs,
      });
      if (refusal) {
        bus.recordBlockedWait(selfKey);
        return textResult(refusalText(refusal));
      }
      // Past the gate, `from` is known to name a real peer, so hand `wait()` the
      // CANONICAL label rather than what the model typed (P1-3). `wait()` and
      // `deliverToWaiter` compare exactly; this is the one line that makes them
      // agree with the gate that just permitted the call.
      const fromLabel = from ? bus.resolveLabel(from) : undefined;
```

and `bus.wait(selfKey, { ...(fromLabel ? { from: fromLabel } : {}), ... })`
below.

`refusalText` is a local pure function. Copy, following I-24 (never an
`errorResult`) and following the existing refusal style in `makeTeamSend`, which
always names the limit and says what to do instead:

| reason | text |
|---|---|
| `no_peers` | `Nobody to wait for: you are the only subagent in this dispatch. Continue and put what you found in your final summary.` |
| `unknown_sender` | `Nobody here is called "<asked>". Teammates: <peers>. (The lead never sends messages.) Continue, or wait again naming one of those.` |
| `all_finished` | `Nobody can answer: <who> already finished. Continue without it and say so in your summary.` |
| `all_blocked` | `Deadlock avoided: <who> is waiting for a message too, and cannot be released before your own deadline. Continue with what you have and report it.` |

`<who>` and `<peers>` are label lists joined with `and`, capped at three names
plus `and N others` - a 10-way dispatch must not produce a 200-character refusal.

The `unknown_sender` line exists because of P1-2: it is the only one of the four
that tells the child something it can act on **in this turn**. The other three
say "give up on the message"; this one says "you asked for a name nobody has,
here are the names". Folding it into `no_peers` (v1) both lost that and asserted
something false - "you are the only subagent" - in a dispatch that may have four
others.

Note the child's watchdog is **not** paused for a refusal, because there is no
wait: the refusal path returns before `agent?.pauseIdleWatchdog()`. Placing the
check before the pause is deliberate - a pause/resume pair around a synchronous
return is a needless state transition on the one object whose state is hardest to
reason about.

#### 3.4.4 `canSend`: the definition v1 left out (P0-2)

`canSend` decides case 3 of 3.4.1 on its own, and the plausible implementation is
wrong. "The child's phase is running" excludes `queued` - and at the **shipped
defaults** (`maxConcurrent: 3`, `maxSubagents: 5`, `config/schema.ts:468-475`)
children 4 and 5 sit in `queued` for the first part of every five-way dispatch.
A child waiting on a queued peer would be told "nobody can answer: a4 already
finished". That is the false refusal R-4 names, reached by a path R-4 does not
cover, and it fires on the default configuration rather than on an edge case.

The predicate is therefore **negative**: a label cannot send only once it has
reached a terminal phase.

```ts
// In `TeamRuntime.dispatch`, BEFORE the bus is constructed. `handles` is
// assigned below, and `canSend` is only ever called from inside a `team_wait`
// on a child that does not exist yet, so the TDZ window is not reachable.
let handles: SubagentHandle[] = [];

const canSend = (label: string): boolean => {
  const handle = handles.find((h) => h.run.label === label);
  // Unknown label -> permit. `checkWaitable` has its own `unknown_sender` branch
  // and this one must not become a second, silent way to refuse.
  if (!handle) return true;
  const phase = handle.run.phase;
  // TERMINAL phases only. `queued` is NOT terminal: that child has not started
  // yet and will. This is the whole of P0-2.
  return phase !== 'done' && phase !== 'failed' && phase !== 'aborted';
};

const bus = new TeamBus(specs.map((s) => s.label), {
  onMessage: (message) => this.emit({ type: 'message', dispatchId, message }),
  canSend,
});
```

Three properties this shape has and a snapshot would not:

- It reads `handles` **live**, through the closure. F-4 replaces `handles[index]`
  mid-dispatch (3.5.3); a captured array or a captured handle would answer for
  the discarded child.
- It is keyed on `run.label`, which survives the retry (the fresh run carries the
  same spec).
- It is defined before `new TeamBus(...)` and populated after, which the existing
  construction order at `runtime.ts:112-141` requires - the bus is built from
  `specs` and the handles are built from the bus.

#### 3.4.5 What the lead sees

`buildSection` in `report.ts` gains one conditional line:

```
blocked waits: 2 (no teammate could answer)
```

emitted only when `run.blockedWaits` is set and non-zero. It is one line inside a
section that is trimmed last, and it tells the lead something it can act on: a
child that tried twice to reach a teammate and could not is a child whose brief
had a dependency the lead should not have split.

### 3.5 F-4: one-shot cold-start retry

#### 3.5.1 The predicate, and the trap under it

Retry is safe only when the child provably did nothing. All five conditions:

```ts
export function shouldRetryColdStart(run: SubagentRun, attemptsSoFar: number): boolean {
  return (
    attemptsSoFar <= TEAM_LIMITS.maxColdStartRetries &&
    run.retryable === true &&
    run.turns === 0 &&
    run.toolCalls === 0 &&
    !run.truncated
  );
}
```

`turns === 0 && toolCalls === 0` is the side-effect proof: no turn completed, so
nothing was written to the transcript, and no tool ran, so nothing was written to
disk. Everything else about the child is fresh by construction.

**The trap is I-20.** `wrapFetchError` classifies an `AbortError` as
`errorType: 'timeout'` with `retryable: true`. Every abort in this system reaches
the provider as an aborted fetch, so *a user pressing Esc produces a "retryable"
error*. If `retryable` alone gated the retry, Esc would spawn a fresh child. The
predicate above does not see this because `TeamRuntime` excludes the abort paths
before it ever calls the predicate, and there are exactly four of them:

| Abort source | Excluded by |
|---|---|
| User Esc / `AgentController.abort()` | `this.aborted` (`runtime.ts:285-296`) |
| `ctx.signal` from the `task` tool | same - the listener calls `abortAll()` (`runtime.ts:157-158`) |
| Dispatch timeout | same - `dispatchTimer` calls `abortAll()` (`runtime.ts:164`) |
| Per-child timeout | the local `timedOut` flag (`runtime.ts:237-241`) |
| Turn-cap abort | `run.truncated` in the predicate, and `turns >= maxTurns` fails `turns === 0` anyway (`subagent.ts:324-327`) |

This is the single most important paragraph in this section. AC-12 pins it from
both ends.

There is a **fifth** guard, discovered while checking I-20 and recorded here as
defence in depth rather than as a substitute for the four (P2-7). The agent loop
tests `ctx.signal.aborted` at the top of every stream iteration and `break`s
**before** `ctx.emit({type:'message_update'})` (`agent-loop.ts:166-177`, I-28).
An `AbortError` originates from the signal, so by the time the provider yields
its `error` event the signal is already aborted and the event is dropped - which
means `run.retryable` is never even set on an abort path. Two consequences, and
the second is the reason this is written down rather than relied on:

1. `shouldRetryColdStart` would return `false` for an aborted child even if all
   four exclusions above were deleted.
2. **This must not be used to justify deleting any of them.** It is a property of
   a `break` in another package that no test in this repo pins, and I-28 could
   change under a refactor of core's steering handling without anyone here
   noticing. AC-12 keeps testing all four sources, from this side of the
   boundary.

#### 3.5.2 `src/team/retry.ts`

```ts
/**
 * Read `retryable` STRUCTURALLY rather than with `instanceof LLMError`.
 *
 * The error is constructed inside `packages/core` and crosses a package
 * boundary; a duplicated core instance (a linked checkout, a hoisting accident)
 * would make `instanceof` false while the field is plainly there, and the
 * failure mode would be "retries silently stopped happening". `formatStreamError`
 * reads `errorType` exactly this way for the same reason (reducer.ts:332-335).
 */
export function isRetryableStreamError(err: unknown): boolean {
  return (err as { retryable?: unknown } | null | undefined)?.retryable === true;
}
```

#### 3.5.3 `TeamRuntime` changes

`dispatch()` hoists handle construction into a factory so a retry can build a
fresh one with identical wiring:

```ts
    const makeHandle = (spec: SubagentSpec): SubagentHandle =>
      createSubagent(spec, subDeps, {
        onUpdate: (r) => this.publish(dispatchId, r),
        onUsage: (label, usage) => this.emit({ type: 'usage', dispatchId, label, usage }),
      });
    // ASSIGNMENT, not a declaration: `handles` is the `let` hoisted above the
    // bus in 3.4.4 so `canSend` can close over it. A `const` here would shadow
    // it, `canSend` would see the empty array forever, and every peer would look
    // live - which fails open rather than closed, so nothing would break loudly.
    handles = specs.map(makeHandle);
```

`runOne` takes the index and the array instead of the handle, and gains the retry
loop. **One options object, not five positional parameters** (P2-8): this repo
caps a signature at five formal parameters (`CLAUDE.md`, "Clean Code Guidelines",
section 2) and v1's version sat exactly on that ceiling, which is the wrong place
for a signature that has grown twice already.

```ts
  interface RunOneCtx {
    dispatchId: string;
    handles: SubagentHandle[];
    makeHandle: (spec: SubagentSpec) => SubagentHandle;
    subagentTimeoutMs: number;
  }

  private async runOne(ctx: RunOneCtx, index: number): Promise<void> {
    const { dispatchId, handles, makeHandle, subagentTimeoutMs } = ctx;
    for (let attempt = 0; ; attempt += 1) {
      const handle = handles[index]!;
      const { run, agent } = handle;
      run.phase = 'starting';
      run.startedAt = Date.now();
      this.publish(dispatchId, run);

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; agent.abort(); }, subagentTimeoutMs);
      try {
        await agent.prompt(handle.spec.prompt);
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }

      const retryable =
        !this.aborted && !timedOut && shouldRetryColdStart(run, attempt + 1);
      if (!retryable) {
        run.endedAt = Date.now();
        this.settlePhase(run, timedOut, subagentTimeoutMs);   // runtime.ts:255-272, extracted
        this.publish(dispatchId, run);
        return;
      }

      // A COLD START THAT TOUCHED NOTHING. Replace the child rather than
      // re-prompting it: `Agent.prompt()` appends to the SAME history, so a
      // second prompt on the old instance would show the child its brief twice.
      const carried = { ...run.usage };
      const retries = (run.retries ?? 0) + 1;
      handle.unsubscribe();
      try { handle.agent.abort(); } catch { /* already gone; must not stop the retry */ }

      const fresh = makeHandle(handle.spec);
      // Provably {0,0} under the predicate above (no turn completed, so no
      // `turn_end` and no usage event). Carried anyway so that a future
      // relaxation of the predicate cannot silently under-report spend - the
      // failure R-5 calls the most misleading one this feature can produce.
      fresh.run.usage = carried;
      fresh.run.retries = retries;
      // `this.live` IS `handles` (runtime.ts:142), so this one assignment also
      // makes `abortAll()` abort the NEW child. Anyone tempted to "clean up" that
      // aliasing into a defensive copy must update both here.
      handles[index] = fresh;
      this.publish(dispatchId, fresh.run);

      await this.backoff(TEAM_LIMITS.retryBackoffMs);
      if (this.aborted) {
        fresh.run.phase = 'aborted';
        fresh.run.endedAt = Date.now();
        this.publish(dispatchId, fresh.run);
        return;
      }
    }
  }
```

`worker()` is the only caller and it changes with the signature (P1-8). v1 gave
`runOne` a new shape and never mentioned the call site; the loop at
`runtime.ts:210-224` keeps its bounds check and passes the index down:

```ts
      const handle = handles[index];
      if (!handle) return;
      if (this.aborted) { /* unchanged: mark aborted, continue */ }
      await this.runOne(ctx, index);
```

`backoff(ms)` is a promise over a `setTimeout` whose timer is `unref`'d (the same
guard `bus.ts:230` documents) and which resolves early if `this.aborted` flips.
**A `Set` of resolvers, not one field** (P1-7):

```ts
  private readonly pendingBackoffs = new Set<() => void>();

  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.pendingBackoffs.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pendingBackoffs.add(done);
    });
  }
```

and in `abortAll()`, after the child aborts:

```ts
    for (const release of [...this.pendingBackoffs]) release();
```

The plural is load-bearing, and the case that needs it is the case this whole
item was written for. A provider-wide 429 fails **every** in-flight child's first
request at once, so up to `maxConcurrent` children enter backoff in the same
tick. With a single stored resolver, two of three are overwritten and only the
last one released - so AC-17 ("an abort during the backoff window ends the
dispatch promptly") would hold for one child and quietly not for the others.

`settlePhase` is `runtime.ts:255-272` extracted verbatim into a private method so
the retry loop has one exit and the phase resolution order (I-18) stays in one
place.

#### 3.5.4 What the lead and the user see

- **Panel**: the row returns to `starting`, rendered `starting (retry)`. No new
  column, no badge, no colour change - a retrying child *is* a child that is
  starting. The parenthetical is there for one reason: F-2 ranks the running
  group by `startedAt` and a retry re-stamps it, so this is the only row that
  ever moves backwards in that group, and the row should say why it did (P2-4).
- **Report**: `buildSection`'s head line gains `, retried 1x` after the tool count
  when `run.retries` is set.
- **Headless**: nothing changes, and this is a property rather than an accident.
  `agent/headless.ts:113-118` prints a start line only the first time a label
  leaves `queued` (guarded by the `started` Set, I-23), and the failed attempt
  never publishes a terminal phase because the retry path returns before
  `settlePhase`. One start line, one terminal line, exactly as today. AC-14 pins
  it.
- **Logs**: `agent_update` is recorded on phase transitions only (I-22), so a
  retry shows up as a second `starting` for the same label - which is precisely
  the diagnostic signal someone reading the log wants.

### 3.6 Logging and redaction

`run.activity` and `run.activityArgs` are **not** added to the logging
projection. `logging/install.ts:404-408` picks `{label, phase, lastTool}` off
`agent_update` and that stays exactly as it is.

The reasoning is I-22's own: a `team_send` body is never recorded because it is
user content that reached no other sink, and briefs and summaries are `trace`
only because of their size. An activity line is a child's prose tail or a shell
command line - the same category of content, at up to one record per phase
transition per child. `lastTool` already answers the diagnostic question this
record exists for ("what was it doing when it died"); the argument adds liability
without adding diagnosis. AC-9 asserts the absence from both ends.

### 3.7 Headless

Zero changes (3.5.4). The activity line is a live-canvas affordance; a stderr
stream is not a canvas, and per-transition activity lines would turn `-p` output
into a log. `agent/headless.ts` is not in this round's change plan at all.

---

## 4. Interface design

This CLI has no REST and no WebSocket surface; the interfaces are the tool
schemas, the config file, the flags and the slash commands.

### 4.1 Tool schemas

Unchanged. `task`, `team_send` and `team_wait` keep their exact parameter
schemas and descriptions. A model that worked at `7a6bf563` behaves identically.

The only model-visible change is the **text of four `team_wait` refusals**, which
were already free-form English (I-24) and are documented in 3.4.3.

### 4.2 Config

**No new keys.** `TeamConfig`, `DEFAULT_TEAM_CONFIG`, `clampTeamConfig`,
`PersistedConfig` and the `store.ts` merge are all untouched, so
`config-purity.test.ts` and `config-skills-merge.test.ts` keep passing without
edits and a `config.json` written by the shipped build stays valid.

### 4.3 CLI flags and environment

Unchanged. `--team` / `--no-team` / `--team-max` / `ARAGON_TEAM` behave exactly
as they do today.

### 4.4 Slash commands

Unchanged. `/team [status|on|off|max <n>]` is untouched.

### 4.5 New constants in `TEAM_LIMITS`

Appended to `team/limits.ts`, on the structural side of the file's own
distinction ("bounds a user has no business tuning"):

```ts
  // --- Live activity (team-live-activity F-1) ---
  /**
   * STORAGE ceiling for a prose activity tail (P0-1). The most a `SubagentRun`
   * may carry, NOT the width of the column: `TeamPanel.activityBudget(cols)`
   * derives the display budget from the terminal and is always <= this.
   */
  activityChars: 64,
  /**
   * Floor under `activityBudget`. Below roughly 46 columns the roster has bigger
   * problems than an elided activity line, and a column narrower than this shows
   * nothing but an ellipsis - at which point the phase word is more informative.
   */
  activityMinChars: 12,
  /** Rolling text buffer kept per child. The only per-token allocation. */
  activityTailChars: 160,
  /** Per picked tool argument (P1-4). A path or a command longer than this is
   *  elided on capture, so a run can never carry more than a few hundred bytes
   *  of argument however large the real call was. */
  activityArgChars: 120,
  /** At or above this many columns the activity line carries a full path or
   *  command; below it, a basename or a program name. Mirrors `statusCompactCols`.
   *  This chooses WHICH FACT to show; `activityBudget` chooses how much of it. */
  activityWideCols: 100,

  // --- Cold-start retry (team-live-activity F-4) ---
  /** Retries of a child that produced NOTHING. One, and not configurable: a
   *  second retry doubles the worst-case latency of a failing dispatch and buys
   *  nothing a re-dispatch by the lead would not buy better. */
  maxColdStartRetries: 1,
  retryBackoffMs: 2_000,
```

`TEAM_BLOCK_VERSION` is **not** bumped: neither prompt block's wording changes.

---

## 5. Data model

### 5.1 `SubagentRun` (`team/types.ts`) - five new optional fields

(v1 said "four" and listed five - P2-5.)

```ts
  /**
   * Prose the child is writing right now, sanitized and clamped to
   * `TEAM_LIMITS.activityChars`. Set only between tool calls; cleared on
   * `turn_start`, on `tool_execution_start` and on `tool_execution_end` so it
   * can never describe work the child has already finished.
   *
   * THE CLAMP HERE IS A STORAGE CEILING, NOT A COLUMN WIDTH (P0-1). The panel
   * re-clamps to `activityBudget(cols)` at render. Do not "simplify" by clamping
   * to the display budget here: this value has no terminal.
   *
   * NEVER LOGGED (3.6) and never persisted: it is ephemeral by construction and
   * a resumed session has no live dispatch.
   */
  activity?: string;

  /**
   * The five argument fields any of the nine known tools might want to show,
   * picked at capture time by `pickActivityArgs` and elided to
   * `TEAM_LIMITS.activityArgChars` each.
   *
   * A PICKED SUBSET, NOT `event.args` (P1-4). The run is shallow-copied into the
   * live snapshot and into every `agent_update` event by `publish()`, and again
   * into `DispatchOutcome.runs` by `dispatch()`, which `TeamCard` holds in the
   * transcript for the session. Holding `event.args` would mean holding
   * `write_file`'s `content` - a whole file, unbounded - along all of those
   * paths, and would put a file body one `JSON.stringify` from a log.
   *
   * Stored unformatted because the PANEL owns the wide/narrow decision and it is
   * the only object that knows the terminal width. A formatted string here would
   * bake one terminal's width into a value the report and the headless writer
   * also read.
   *
   * Cleared on `turn_start` and `tool_execution_end` (P1-5).
   */
  activityArgs?: ActivityArgs;

  /** `team_wait` calls refused as unanswerable (F-3). Pulled from the bus on
   *  `tool_execution_end`, the same way `messagesSent` is (subagent.ts:341). */
  blockedWaits?: number;

  /** Cold-start retries spent (F-4). 0 or absent for the overwhelming majority
   *  of runs; `1` at most under `TEAM_LIMITS.maxColdStartRetries`. */
  retries?: number;

  /**
   * Whether the error that ended this attempt was transport-level and
   * retryable, read structurally off `LLMError.retryable`.
   *
   * NOT RENDERED ANYWHERE. It exists so `TeamRuntime` can decide without
   * re-parsing `run.error`, which is a human-facing sentence produced by
   * `formatStreamError` and must never become a machine-readable contract.
   */
  retryable?: boolean;
```

All five are optional, so every existing construction site of `SubagentRun` -
including the fixtures in the eight shipped `team-*.test.ts` files - compiles
unchanged. `ActivityArgs` is imported from `team/activity.ts`; `types.ts` gains
one `import type` and no runtime import, so it stays the dependency-free module
it is today.

`TeamSnapshot`, `TeamMessage`, `DispatchOutcome`, `SubagentSpec` and the
`TeamEvent` union are **unchanged**. Snapshots carry `runs`, so the new fields
reach the panel with no event-shape change and no controller change.

### 5.2 `TeamBus` internal state

```ts
  private readonly blocked = new Map<string, number>();   // label -> refused waits
  private readonly canSend: (label: string) => boolean;   // default () => true
```
and `Waiter` gains `deadlineAt: number`, stamped from `this.now()` so that
`checkWaitable`'s derived deadline and every registered waiter's deadline are on
the same clock (P1-1).

`TeamRuntime` gains `pendingBackoffs: Set<() => void>` (3.5.3 / P1-7) and the
`canSend` closure over its live `handles` array (3.4.4 / P0-2).

### 5.3 Persistence

Nothing in this round is persisted. `session/persist.ts` is not in the change
plan; a resumed session still shows a settled, duration-less `TeamCard` exactly
as round 1's P1-5 decided.

---

## 6. UI design

### 6.1 The roster, before and after

Before, at `maxSubagents: 8`, four minutes in:

```
* team  3 running - 5 done - 4m01s
  v api      audit the auth middleware        done  6 turns   58.2s
  v routes   map the route table              done  4 turns   1m12s
  v tests    inventory the test suite         done  9 turns   1m44s
  v docs     read the plan docs               done  3 turns   41.0s
  v deps     list outdated packages           done  5 turns   1m02s
  +3 more
```

Three children are working. The panel shows none of them.

After, at 120 columns (`wide`, `activityBudget` = 47):

```
* team  3 running - 5 done - 4m01s
  o schema   diff the drizzle schema          bash: npm run db:generate       2m11s
  o client   trace the websocket client       read: src/lib/websocket-client.ts  1m48s
  o ui       find the dead components         writing: the three panels that no longer...  0m52s
  v tests    inventory the test suite         done  9 turns                    1m44s
  v deps     list outdated packages           done  5 turns                    1m02s
  +3 more
```

The same roster at 80 columns (narrow, `activityBudget` = 22). This is the view
v1 could not produce: its activity column was a fixed 73 characters wide and the
row needed 94 columns before the description got one (P0-1).

```
* team  3 running - 5 done - 4m01s
  o schema   diff the...   bash: npm             2m11s
  o client   trace th...   read: websocket-c...  1m48s
  o ui       find the...   writing: the three... 0m52s
  v tests    inventor...   done  9 turns         1m44s
  v deps     list out...   done  5 turns         1m02s
  +3 more
```

Same five rows, same column layout, same glyph budget. Every visible row is now
either doing something or is the most recent thing to have finished, and the
elapsed column is still on screen at every width the panel renders at all.

### 6.2 Degradation matrix

| Condition | Behaviour |
|---|---|
| `rows < panelCollapseRows` (20) | Header line only, exactly as today (`TeamPanel.tsx:111-113`). Activity never renders. |
| Any width | The activity cell is clamped to `activityBudget(cols)` characters AND is `flexShrink={1} overflow="hidden"`, so it can never push the elapsed column off (P0-1). |
| `cols < activityWideCols` (100) | Narrow **form**: `read: routes.ts` rather than `read: src/api/routes.ts`; `bash: npm` rather than `bash: npm run db:generate`. Chooses which fact, independently of how much of it fits. |
| `cols <= 46` | `activityBudget` bottoms out at `activityMinChars` (12) and the column shows a heavily elided phrase. Below that Ink truncates; the elapsed column survives. |
| `caps.unicode === false` | Unchanged: markers come from `pickGlyphs`, and no literal glyph is introduced by this round. |
| CJK / emoji in a path or a prose tail | The budget is halved against the reserve (`WIDE_CHAR_ALLOWANCE`), because it counts code units and the terminal counts columns (I-26). Worst case the line is shorter than it needed to be. |
| `reducedMotion` | Unchanged: static marker instead of a spinner. The activity line is text and does not animate. |
| No `text_delta` yet in this turn | `thinking`, exactly as today. |
| Tool not in the table (`skill_find`, anything a later round adds) | The tool's own name. |
| A retrying child | `starting (retry)`. Same phase, same colour, same marker; the parenthetical exists so the one row that legitimately restarts its clock says why (P2-4). |
| More running children than `panelMaxRows` | `+N more (K running)`. |

### 6.3 What does not change

`TeamCard`, `StatusBar`'s `teamActive` cluster, the `AppShell` slot, the wheel
router's measured bottom box (I-10 of round 1) and the Ctrl+O expansion all keep
their current behaviour. `TeamCard` gains only the `retried 1x` fragment through
`report.ts`; its own component is unchanged.

---

## 7. File / module change plan

### 7.1 New files (7)

| File | Intent |
|---|---|
| `packages/cli/src/team/activity.ts` | `pickActivityArgs()` + `sanitizeActivity()` + `describeToolActivity()` + the `ActivityArgs` type; pure, ASCII-literal, no imports beyond `TEAM_LIMITS`. |
| `packages/cli/src/team/panel-rows.ts` | `selectPanelRows()`; pure ranking of a roster into visible / hidden-total / hidden-running. |
| `packages/cli/src/team/retry.ts` | `isRetryableStreamError()` + `shouldRetryColdStart()`; the whole retry decision, testable without an `Agent`. |
| `packages/cli/src/__tests__/team-activity.test.ts` | Sanitizer, formatter, wide/narrow forms, arg picking, control-char and surrogate cases. |
| `packages/cli/src/__tests__/team-panel-rows.test.ts` | Ranking, stability, hidden counts. |
| `packages/cli/src/__tests__/team-retry.test.ts` | The predicate, including every abort exclusion (AC-12). |
| `docs/plans/team-live-activity/manual-test.md` | The seven steps of 8.2. Required by 8.2 and by 12, and missing from v1's count (P2-6). |

### 7.2 Modified files (11)

| File | Change |
|---|---|
| `packages/cli/src/team/limits.ts` | Append seven constants (4.5). No existing value changes. |
| `packages/cli/src/team/types.ts` | Five optional fields on `SubagentRun` (5.1), each with the comment that says why it exists; one `import type { ActivityArgs }`. |
| `packages/cli/src/team/subagent.ts` | `textTail` local; set/clear `activity` and `activityArgs` in `turn_start`, `tool_execution_start` and `tool_execution_end`; append the tail in `message_update`; sanitize **once per published frame** inside `emit()` (P2-2); set `retryable` on stream error; pull `blockedWaits` from the bus on `team_wait` end. |
| `packages/cli/src/team/bus.ts` | `canSend` option; `deadlineAt` on `Waiter`; `checkWaitable()`; `resolveLabel()`; `waiterFor()`; `recordBlockedWait()` / `blockedWaitCount()`. `wait()` and `send()` semantics unchanged. |
| `packages/cli/src/team/comm-tools.ts` | `makeTeamWait` calls `checkWaitable` (passing `timeoutMs`, not a deadline) before pausing the watchdog; `refusalText()` local, four reasons. `makeTeamSend` and `withMailboxTail` unchanged. |
| `packages/cli/src/team/runtime.ts` | `makeHandle` factory; the `canSend` closure and its `let handles` hoist (3.4.4); pass `canSend` to `TeamBus`; `RunOneCtx`; `worker()` passes the index (P1-8); `runOne` retry loop; `settlePhase` extracted; `backoff()` over `pendingBackoffs`; `abortAll()` releases **every** pending backoff. |
| `packages/cli/src/team/report.ts` | `buildSection`: `, retried Nx` on the head line; `blocked waits: N` line. Budgeting logic untouched. |
| `packages/cli/src/ui/TeamPanel.tsx` | `cols` prop; `activityBudget()` + `activityLine()` replace `activity()`; the activity cell becomes a shrinkable `<Box>` (P0-1); `selectPanelRows` replaces the index slice; `+N more (K running)`. |
| `packages/cli/src/ui/App.tsx` | Pass `cols={cols}` to `<TeamPanel>` (one line, at `App.tsx:1101-1107`; `cols` is already in scope at `App.tsx:1095`). |
| `packages/cli/CHANGELOG.md` | One `Unreleased` entry (7.5). Missing from v1's count (P2-6). |
| `docs/plans/team-live-activity/spec.md` | This review; no further edits expected during implementation. |

### 7.3 Test files that need updating (3)

| File | Why |
|---|---|
| `packages/cli/src/__tests__/team-panel.test.tsx` | `TeamPanel` gains a required `cols` prop; existing cases must pass one. Add the F-2 cases here or in `team-panel-rows.test.ts` - the ranking cases belong in the pure test, the rendering cases here. |
| `packages/cli/src/__tests__/team-runtime.test.ts` | Add the retry cases; existing cases pass unchanged because the stub factory's runs have `turns === 0` **and** `retryable` unset, so `shouldRetryColdStart` is false. **Verify this before writing new cases**: a stub that leaves `retryable` true would retry every child and the existing suite would hang rather than fail informatively. |
| `packages/cli/src/__tests__/team-bus.test.ts` | Add `checkWaitable` cases. Existing cases pass unchanged **only while `canSend` defaults to `() => true`** - the file has five `new TeamBus(...)` sites and none of them will pass one, so a default of anything else changes their behaviour silently rather than failing to compile. `wait()` is untouched. The new cases construct with `{ now: c.now }` like every existing one, which is what AC-18a exists to confirm actually works end to end (P1-1). |

### 7.4 Files deliberately NOT changed

`agent/headless.ts` (3.7), `logging/install.ts` (3.6), `config/schema.ts` (4.2),
`config/store.ts`, `commands/builtins.ts` (4.4), `agent/controller.ts`,
`team/task-tool.ts`, `team/normalize.ts`, `team/prompt.ts`,
`team/human-queue.ts`, `ui/entries/TeamCard.tsx`, `ui/StatusBar.tsx`,
`session/persist.ts`, and everything under `packages/core/`.

The absence of `agent/controller.ts` from this list's opposite is worth stating
plainly: this round adds no dependency the controller has to inject, because
`canSend` is supplied by `TeamRuntime`, which already holds the handles.

### 7.5 CHANGELOG

One entry under `Unreleased` in `packages/cli/CHANGELOG.md`, describing the four
items in user terms. No version bump: release bumps land in their own
`chore(release)` commits, as round 1's review established.

---

## 8. Testing and acceptance criteria

### 8.1 Acceptance criteria

**F-1 - activity**

- **AC-1** `sanitizeActivity` removes every character in `\x00-\x1f` and
  `\x7f`, collapses runs of whitespace, and never returns a string longer than
  the requested cap. Asserted with an input containing `\x1b[2J`, a tab and a
  newline.
- **AC-2** `sanitizeActivity` never returns a lone surrogate. Asserted by
  truncating a string whose cap lands mid-emoji and checking the result
  round-trips through `Buffer.from(s, 'utf8').toString('utf8')` unchanged.
- **AC-2a** `sanitizeActivity` never returns a lone **low** surrogate either
  (P2-3). Asserted by passing a string whose first code unit is the second half
  of a pair, which is exactly what `textTail.slice(-n)` can produce.
- **AC-3** `describeToolActivity` returns the documented phrase for all seven
  builtins plus `team_send` and `team_wait`, in both wide and narrow forms, and
  returns the bare tool name for an unknown tool.
- **AC-3a** The narrow form of `bash` is the **program name** (P1-6):
  `{command: 'npm test -w cli'}` renders `bash: npm`, and
  `{command: './scripts/build.sh --prod'}` renders `bash: build.sh`. This must
  fail against v1's `basename(command)`, which returns the first input whole and
  the second as `build.sh --prod`.
- **AC-3b** `pickActivityArgs` keeps only `{path, pattern, command, to, from}`,
  each elided to `activityArgChars` (P1-4). Asserted by passing
  `{path: 'a.txt', content: <1 MB string>}` and checking the result has no
  `content` key and that `JSON.stringify(picked).length` is under 1 kB. This is
  the assertion that keeps a file body out of the transcript.
- **AC-3c** **The activity column is bounded by terminal width** (P0-1).
  `activityBudget(cols)` is non-decreasing in `cols`, never exceeds
  `activityChars`, never falls below `activityMinChars`; and for a run in
  `thinking` with a full-length `run.activity`, the rendered activity string at
  `cols = 80` is at most `activityBudget(80)` characters plus the `writing: `
  prefix. Must fail against v1, whose line was a fixed 73 characters at every
  width.
- **AC-3d** At `cols = 80` with five running rows and 60-character descriptions,
  the elapsed column is present on every rendered row. This is the user-visible
  form of P0-1 and the reason the cell is also `flexShrink={1}`.
- **AC-4** A `text_delta` sequence longer than `activityTailChars` leaves
  `textTail` at exactly `activityTailChars` characters. Asserted through
  `createSubagent` with a stub agent that emits 10 000 deltas, by reading
  `run.activity`'s length and confirming it is `<= activityChars`.
- **AC-5** `run.activity` **and** `run.activityArgs` are both `undefined`
  immediately after `turn_start` and immediately after `tool_execution_end`
  (P1-5). v1 only cleared the first, which is what turned P1-4 from a
  per-tool-call retention into a whole-run one.
- **AC-6** The panel renders `writing: <tail>` only in the `thinking` phase and
  the tool phrase only in `tool` / `waiting`.
- **AC-7** At `cols` below `activityWideCols` the rendered line contains a
  basename and not a directory separator, for a `read_file` on a nested path.
- **AC-8** **Non-regression on render volume**: emitting 500 `text_delta` events
  inside one throttle window produces at most one `onUpdate` call. This is the
  claim in 1.2 that made F-1 affordable; it is a test, not a comment.
- **AC-9** No log record contains an `activity` or `activityArgs` key at any
  level, asserted through `attachTeamEvents` with a fake logger over a
  dispatch that includes a `bash` call. Asserted from both ends: the projection
  type has no such member, and the emitted records do not.

**F-2 - row priority**

- **AC-10** With eight runs of which indices 0-4 are `done` and 5-7 are
  `thinking`, `selectPanelRows(runs, 5)` returns all three running runs and
  `hiddenRunning === 0`. This is the defect in 3.3.1, and it must fail against
  the shipped `slice(0, 5)`.
- **AC-11** Ordering is stable across ticks: calling `selectPanelRows` twice on
  the same roster returns the same order, and a roster where only `endedAt`
  advanced on an already-settled run does not reorder the running rows.
- **AC-11a** A run whose `startedAt` was re-stamped by a retry moves to the end
  of the running group and nowhere else - no settled or queued row changes
  position (P2-4). The two features interact here and nowhere else.

**F-4 - cold-start retry** (numbered before F-3 because AC-12 is the highest-risk
assertion in the round)

- **AC-12** **An aborted child is never retried.** Four cases, each asserting
  exactly one attempt: user abort mid-run, `ctx.signal` abort, dispatch timeout,
  per-child timeout - all with an error whose `retryable` is `true`, which is
  what `wrapFetchError` actually produces for an `AbortError` (I-20). This is the
  trap in 3.5.1; if it is not asserted from all four sources, one of them will be
  reintroduced by a future refactor.
- **AC-13** A child whose first attempt fails with `retryable: true`, `turns: 0`,
  `toolCalls: 0` is retried exactly once, ends `done`, and the outcome's run has
  `retries === 1`. A second failure of the same kind does **not** produce a third
  attempt.
- **AC-14** A child that failed with `turns: 1` is not retried; a child that
  failed with `toolCalls: 1` is not retried; a child whose error is not retryable
  is not retried.
- **AC-15** After a retry, `handles[i]` and the runtime's live list are the
  **same** handle: `abortAll()` during the second attempt aborts the second
  child, not the discarded one. Asserted by counting `abort()` calls on both stub
  agents.
- **AC-16** Headless output for a retried child is one `start` line and one
  terminal line, byte-identical to the non-retried case apart from the duration.
- **AC-17** An abort during the backoff window ends the dispatch promptly (the
  run settles `aborted`) rather than after `retryBackoffMs`.
- **AC-17a** **The same holds when several children back off at once** (P1-7).
  Three children fail their cold start in the same tick; an abort during the
  shared backoff window settles **all three** promptly. Must fail against a
  single stored resolver, which releases only the last one registered - and the
  simultaneous case is the normal one, because the failure that triggers a cold
  start is usually provider-wide.

**F-3 - unanswerable waits**

- **AC-18** A `team_wait` on a peer whose `canSend` is false returns
  **immediately** with the `all_finished` text; asserted with a fake clock, so
  "immediately" means "without advancing the clock", not "quickly".
- **AC-18a** **`checkWaitable` uses only the bus's own clock** (P1-1). Asserted
  by constructing `new TeamBus(labels, { now: fake })` where `fake` is far from
  `Date.now()` (e.g. `0`), registering a waiter, and checking that the
  equal-deadline mutual case still refuses and the unequal one still permits. Run
  this before AC-19 and AC-20: under v1's `deadlineAt: Date.now() + timeoutMs`
  those two compare a real timestamp with a fake one and are meaningless.
- **AC-19** Mutual wait with **equal** deadlines: the second waiter is refused
  with `all_blocked`.
- **AC-20** **Mutual wait with unequal deadlines: the LONGER waiter is not
  refused.** `b` is already blocked with a 30 s deadline; `a` then waits 120 s on
  `b`. `a` must be permitted, because `b` times out at t=30, returns to its loop,
  and may then send - comfortably inside `a`'s deadline. A cycle detector that
  ignores deadlines refuses `a` here, which is the failure this criterion exists
  to catch.

  (v1 wrote this criterion the other way round - "`b` must be allowed to wait" -
  which asserts the opposite of the rule the same paragraph defends: nothing can
  release `a` before `b`'s own 30 s deadline, so refusing `b` is correct and is
  what both v1's rule and the fixpoint do. An implementer following the criterion
  literally would have weakened the rule to satisfy a test that was wrong. P1-9.)
- **AC-20-inv** The converse, asserted so the asymmetry is deliberate rather than
  incidental: `a` is already blocked with 120 s; `b` then waits 30 s on `a`; `b`
  **is** refused with `all_blocked`, because in a two-child dispatch nothing can
  release `a` inside 30 s.
- **AC-20a** **A wait on a peer who can be released by a third party is NOT
  refused** (P0-3). Three children: `a` waits `from: b`; `b` is already waiting
  `from: c` with an equal deadline; `c` is running and unblocked. `a` must be
  permitted, because `c` can message `b`, `b` can then message `a`, and all of it
  fits inside `a`'s deadline. Must fail against v1's rule, which sees `b` blocked
  past `a`'s deadline and refuses. This is the fixpoint's whole purpose.
- **AC-20b** **A queued peer counts as able to send** (P0-2). Five specs,
  `maxConcurrent: 3`; while indices 3 and 4 are still `queued`, a `team_wait`
  from index 0 naming index 4 is **permitted**. Must fail against a `canSend`
  written as "the phase is running", which is the natural way to write it and
  which refuses on the shipped default configuration.
- **AC-20c** `canSend` reads the **live** handle after a retry (P0-2 / F-4
  interaction): once `handles[i]` has been replaced, `canSend(label)` answers for
  the replacement. Asserted by retrying a child and then querying while the
  second attempt runs.
- **AC-21** A wait is not refused when a matching message is already queued, even
  if every peer has finished.
- **AC-21a** `from` is matched case-insensitively **and consistently** (P1-3):
  `team_wait {from: 'A2'}` against label `a2` is permitted when `a2` is live, and
  a message `a2` sends afterwards satisfies it. The second half is the one that
  matters - v1 accepted `A2` at the gate and then handed `wait()` a string its
  own delivery filter could never match.
- **AC-22** A single-child dispatch refuses with `no_peers`.
- **AC-22a** **`unknown_sender` is its own reason with its own text** (P1-2).
  Three cases in a five-child dispatch, each refused with the label list and
  **not** with "you are the only subagent in this dispatch": `from` naming a
  label that does not exist, `from: 'lead'`, and `from` naming the caller.
- **AC-23** Every refusal is a non-error `ToolResult` (`isError` unset/false) -
  the D-7 discipline, one level down.
- **AC-24** `run.blockedWaits` reaches the report: a run with two refusals renders
  the `blocked waits: 2` line, and a run with none renders no such line.

**Whole-round invariants**

- **AC-25** `git diff --stat 7a6bf563 -- packages/core` is empty.
- **AC-26** `packages/cli/src/config/schema.ts` is unchanged; `clampTeamConfig`'s
  existing tests pass without edits.
- **AC-27** The glyph scanner still covers `src/team/**` and is non-vacuous:
  temporarily inserting a non-ASCII literal into `team/activity.ts` makes
  `glyphs.test.ts` fail. This is the third round in a row to add files under that
  tree and the second review to make it a condition; run it, do not assume it.
- **AC-28** Full workspace suite green: `npm test` in both packages, and both
  packages build.

### 8.2 Manual verification

A companion `docs/plans/team-live-activity/manual-test.md` with nine steps,
following the shape of `docs/plans/team-subagents/manual-test.md`:

1. `/team max 8`, then a prompt that fans out to eight children. Confirm the
   panel always shows at least one running row while any child is running.
2. Narrow the terminal below 100 columns mid-dispatch; confirm activity lines
   switch to basenames and program names and no row wraps.
3. **Narrow to exactly 80 columns while a child is writing prose** (P0-1).
   Confirm the elapsed column is still on screen on every row and no row wraps.
   This is the step that would have caught the one structural defect in v1, and
   it must be done at 80 rather than at 100 - at 100 the old code fits.
4. Shrink below 20 rows; confirm the panel collapses to its header.
5. A dispatch where one child is told to `team_wait` for a peer that finishes
   first; confirm the refusal appears in that child's summary within a second or
   two rather than after 120 s.
6. **A dispatch of five with `maxConcurrent: 3`, where child 1 is told to
   `team_wait` for child 5 while child 5 is still queued** (P0-2). Confirm the
   wait is **not** refused, and that it is satisfied when child 5 starts and
   messages.
7. Point the CLI at an unreachable base URL for two seconds during dispatch
   start-up; confirm one retry, `starting (retry)` in the panel, and a successful
   report.
8. Press Esc mid-dispatch; confirm no child restarts and the transcript shows the
   dispatch aborted.
9. `aragon logs tail --level trace` during a dispatch with a `bash` call; confirm
   no command line appears in the log.

---

## 9. Risks and mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-1 | A control character or ANSI escape in a `bash` argument corrupts the frame or clears the screen. | High | `sanitizeActivity` strips `\x00-\x1f` and `\x7f` before the string can reach Ink. AC-1. |
| R-2 | An abort is misclassified as retryable and Esc spawns a fresh child. | **Highest in the round** | Four independent exclusions enumerated in 3.5.1, asserted from all four sources by AC-12. |
| R-3 | The retry swaps `handles[i]` but not the live list, so `abortAll()` aborts a dead child and leaks a live one. | High | `this.live` aliases `handles` (I-16); one assignment covers both, with a comment at the assignment. AC-15. |
| R-4 | The deadlock check refuses a wait that would have been answered. | High | The deadline comparison (3.4.1 case 3). AC-20 is written specifically to fail a naive cycle detector. |
| R-5 | Per-token string work becomes measurable on a 10-way dispatch. | Medium | `textTail` is sliced to `activityTailChars` on every append, so the buffer is O(1); the render count is unchanged (AC-8). |
| R-6 | Row reordering makes the panel harder to read than the buggy-but-static version. | Medium | Ranking keys are chosen so a run moves at most twice in its life (3.3.2); AC-11 pins stability. |
| R-7 | A prose activity line leaks sensitive content into a log or a screenshot-able surface. | Medium | Not logged at any level (3.6, AC-9); on screen only while the dispatch runs; never persisted. |
| R-8 | `TeamPanel`'s new required `cols` prop breaks the two test files that construct it. | Medium | Listed explicitly in 7.3. Making it optional was rejected: a missing width would silently pick the narrow form forever. |
| R-9 | The `team-runtime.test.ts` stub factory happens to produce runs that satisfy the retry predicate, and the existing suite hangs. | Medium | Called out as a pre-check in 7.3. The predicate requires `retryable === true`, which no current stub sets. |
| R-10 | `checkWaitable` is called on a hot path and scans the waiter set. | Low | At most 10 waiters, once per `team_wait`, and `team_wait` is itself rate-limited by the message budget. |
| R-11 | The `retried 1x` fragment pushes a report section past its byte budget. | Low | It is 11 bytes on a head line, and head lines are never trimmed (`report.ts:16-18`). |
| R-12 | This round and `team-agent-profiles` collide when the latter is implemented. | Medium | Two touch points, both additive, both named in section 11. |
| R-13 | ~~`activityArgs` holds a reference to the tool's args object~~ - **now fixed rather than accepted** (P1-4). v1 rated this Low on the grounds that the formatter never reads `write_file`'s `content`. Retention is not readership: `publish()` copies the run into the snapshot and into every event, and `dispatch()` copies it into the outcome the transcript holds, so a 2 MB write stayed alive per file for the session and sat one `JSON.stringify` away from a log. | Medium | `pickActivityArgs` stores five named strings, each elided to `activityArgChars`, and the run clears them on `tool_execution_end`. AC-3b, AC-5. The "second place to update" objection does not survive contact with the code: `describeToolActivity` is already a per-tool table. |
| R-14 | The narrow/wide threshold makes a test depend on terminal width. | Low | `cols` is an explicit prop; tests pass it. No test reads the real terminal. |
| R-15 | The activity column overflows the row and pushes the elapsed column off screen. | **Was fatal in v1, now bounded** (P0-1) | `activityBudget(cols)` clamps at render, `flexShrink={1} overflow="hidden"` catches whatever the arithmetic misses, and the budget is halved against the reserve because it counts code units and the terminal counts columns (I-26). AC-3c, AC-3d. |
| R-16 | `canSend` is written as "the phase is running", so a wait on a `queued` peer is refused as `all_finished`. | **High, and reachable on the default config** (P0-2) | The predicate is negative - terminal phases only - and defined in 3.4.4 rather than left to the implementer. AC-20b, AC-20c. |
| R-17 | The deadlock refusal fires on a peer that a third party would have released. | High (P0-3) | The fixpoint in `checkWaitable`; every undecidable branch returns `null`. AC-20a, written to fail the deadline-only rule. |
| R-18 | `checkWaitable`'s fixpoint is subtly wrong in a direction nobody notices, because a wrong refusal is silent. | Medium | The bias is stated as a rule in 3.4.1 ("when in doubt, wait") rather than left implicit, the loop shrinks rather than grows, and three of the six F-3 acceptance criteria assert **permission** rather than refusal. |

---

## 10. Decision log

- **D-1 - No new config keys.** Every bound is structural in the sense
  `limits.ts:8-24` already defines. Rejected alternative: `team.activityDetail`
  and `team.retries`. A knob nobody sets is a merge surface (`store.ts`), a
  clamp, a `/team` verb and a settings row, for a default that is right.
- **D-2 - Text deltas, not thinking deltas.** Non-goal 3. Reasoning traces in a
  persistent one-line roster is a privacy step-change nobody asked for.
- **D-3 - `activityArgs` stored as a picked subset; the panel formats.** The
  panel is the only object that knows the width, so no formatted string is stored
  (v1's point, unchanged). What v1 got wrong was the other half: the *unformatted*
  value it stored was `event.args` whole, which retains a file body along every
  copy path the run takes (P1-4). Five named strings, picked at capture, elided
  at capture. Unformatted and small are not in tension.
- **D-4 - Two width policies, and they answer different questions** (revised
  under P0-1). `activityWideCols` reuses `statusCompactCols`'s threshold pattern
  to decide *which fact* to show - full path or basename, command line or program
  name. `activityBudget(cols)` decides *how much of it fits*, and it is a
  continuous function rather than a second threshold because the failure it
  prevents (a row wider than the terminal) is continuous. v1 had only the first
  and therefore had no answer for a 64-character prose tail on an 80-column
  terminal.
- **D-5 - Ranking, not "keep the first N but guarantee K running".** The
  alternative is more stable but its rule cannot be stated in one sentence, and a
  panel whose selection rule a user cannot predict is worse than one that
  occasionally moves a row.
- **D-6 - `checkWaitable` is pure; the tool records the refusal.** A predicate
  with a counter inside it is a predicate people stop trusting. It also keeps
  `TeamBus`'s existing tests independent of the new counter.
- **D-7 - Retry only a cold start, only once, only on a transport error.** The
  side-effect proof is `turns === 0 && toolCalls === 0`. Any weaker predicate
  requires knowing whether a partially-completed child's writes are idempotent,
  which is not knowable. Rejected alternative: retrying with the tools removed -
  that produces a different child, not a retry.
- **D-8 - Replace the child on retry rather than re-prompting it.**
  `Agent.prompt()` appends to the same history, so a second prompt shows the
  child its brief twice. A fresh `createSubagent` is the only shape where the
  retried child is genuinely equivalent to the first.
- **D-9 - Carry `usage` across the retry even though it is provably zero.** One
  line that survives a future relaxation of the predicate, guarding the failure
  R-5 of round 1 calls the most misleading this feature can produce.
- **D-10 - Read `retryable` structurally, not with `instanceof LLMError`.**
  `formatStreamError` already reads `errorType` this way (I-21), and an
  `instanceof` across a duplicated core instance fails silently.
- **D-11 - Refusals stay non-error `textResult`s.** D-7 of round 1, unchanged and
  extended to the three new refusals. AC-23.
- **D-12 - No changes to `agent/headless.ts`.** The correct headless behaviour
  falls out of the existing `started`/`finished` Sets; a change here would be a
  change for its own sake. AC-16 pins the property rather than the absence.
- **D-13 - `TeamPanel.cols` is required, not optional.** An optional width prop
  defaulting to narrow would silently produce the degraded form forever if a call
  site forgot it; a required prop fails at compile time.
- **D-14 - This round does not touch `team-agent-profiles`.** Section 11.
- **D-15 - `canSend` is a negative predicate over terminal phases** (P0-2).
  "Cannot send" is decidable - the child has no loop left. "Can send" is not, and
  a `queued` child is the counter-example that fires on the shipped defaults. The
  predicate answers the decidable question and every unknown label returns
  `true`, so `canSend` can never become a second, silent path to a refusal.
- **D-16 - Every undecidable branch of `checkWaitable` permits the wait** (P0-3).
  A wait that should have been refused costs the child seconds it can see. A
  refusal that should have been a wait destroys a result the child cannot see was
  ever possible. The asymmetry is total, so the bias is total, and it is written
  as a rule in 3.4.1 rather than left to whoever edits the function next.
- **D-17 - The deadlock proof is a fixpoint, not a deadline comparison** (P0-3).
  The comparison alone is unsound because a blocked peer can be released early by
  a third party. Ten participants make the fixpoint free; soundness is not.
- **D-18 - `checkWaitable` takes `timeoutMs` and derives the deadline itself**
  (P1-1). The bus owns the clock, and it is the injectable one that every
  existing test passes. A caller-computed deadline in `comm-tools.ts` mixes
  `Date.now()` into a comparison against `this.now()`.
- **D-19 - Prose is sanitized once per published frame, not once per token**
  (P2-2). `emit()` discards all but one result per 120 ms window, so two regexes
  per token were paid for a value nobody read. The per-delta path is now one
  bounded concat and one bounded slice, which is what 1.2's affordability
  argument actually claimed.

---

## 11. Open questions and hand-offs

### 11.1 The outstanding round: named agent profiles

`docs/plans/team-agent-profiles/spec.md` (v2, 1465 lines, reviewed and approved
with five conditions) is **designed and not implemented**. It is the remaining
work on requirement clause R-e ("a subagents mechanism like Anthropic Claude
Code"): profiles discovered from `.aragon/agents` and `.claude/agents`, selected
by `subagent_type`, with per-profile tools and model. This round deliberately
does not restate, re-scope or partially implement it. It is the natural next
piece of work and its five implementation conditions still stand as written.

**The two places the two designs touch**, so whichever lands second does not
surprise the other:

1. **`SubagentRun` gains fields in both.** Profiles adds `profile?: string` and a
   per-child cost field; this round adds the five in 5.1. All are optional and
   independent, so the merge is additive with no conflict.
2. **`TeamPanel`'s row.** The profiles design puts a `[reviewer]` chip after the
   label and a per-child model after it. This round makes the activity column
   variable-width. Both compete for the same row on a narrow terminal, and the
   resolution is already available: the profile chip belongs in the same
   `activityWideCols` degradation this round introduces. Whoever lands second
   should reuse that threshold rather than adding a third.

### 11.2 Bounded follow-ups from this round

1. **A `+N more` that can be expanded.** Ctrl+something to page the roster when
   more than five children run at once. Needs a key-handling decision next to the
   composer; deliberately out of scope (non-goal 5).
2. **`activityArgs` as a picked subset** rather than the whole args object
   (R-13). One line of code and one more place to update per new tool; worth
   doing only if a real payload ever proves large.
3. **Retry with a widened predicate**, e.g. a child that failed after N turns but
   touched no file. Requires trusting `filesTouched`, which round 1's R-2 already
   says is best-effort (a child writing through `bash` is invisible to it). Do
   not attempt without a stronger side-effect signal.
4. **A deadlock *report*** rather than a refusal: telling the lead "a and b
   waited on each other" in the header, so the lead can fix its own decomposition
   next time. Cheap once `blockedWaits` exists; left out to keep the header's
   line count stable.
5. **Surfacing `retryable` in the report badge** (`[failed: rate limited -
   retryable]`) so the lead can re-dispatch just the failed child. Attractive,
   and deliberately deferred: it changes what the lead does with a report, which
   deserves its own round rather than a field on a badge.

---

## 12. Definition of done

- [ ] Seven new files, eleven modified files, three test files updated
      (section 7).
- [ ] All 42 acceptance criteria green. **Ten of them must be verified to FAIL
      against a deliberately naive implementation before being accepted as
      passing** - AC-3a, AC-3b, AC-3c, AC-10, AC-12, AC-17a, AC-20, AC-20-inv, AC-20a,
      AC-20b. Each corresponds to a defect this review found in v1, and each is
      the kind that passes vacuously if the test is written after the code.
- [ ] AC-18a run **before** AC-19 and AC-20, so the fake-clock plumbing is
      confirmed before two criteria that silently depend on it.
- [ ] AC-27's non-vacuity check on `glyphs.test.ts` actually run, not assumed.
- [ ] `git diff --stat 7a6bf563 -- packages/core` empty.
- [ ] `manual-test.md` written and its nine steps executed once on a real
      terminal, step 3 at exactly 80 columns.
- [ ] CHANGELOG entry under `Unreleased`; no version bump.
- [ ] The five conditions in `## 评审结论 (Review Verdict)` discharged.

---

## 评审结论 (Review Verdict)

**有条件通过 (approved with conditions).**

The document is feasible on this stack, correctly scoped, and consistent with the
conventions in `CLAUDE.md` and with the shipped code. Every claim it makes about
the tree at `7a6bf563` was checked against the file and line it names: I-1
through I-25 and I-27 hold exactly as written, which is a better rate than either
previous round achieved and reflects that this design was written from a reading
of the code rather than from the two specs beside it. I-26 was overstated and is
corrected; two new constraints (I-28, I-29) were added from checks this review
performed.

The four work items are the right four. F-2 is a real shipped defect with a
one-line repro. F-1 is the follow-up round 1 deferred, and the measurement it was
deferred pending has now actually been done rather than assumed. F-3 and F-4 both
narrow rather than widen what a child can do, which is the discipline the two
earlier reviews had to impose and this one did not.

The three P0s share a shape worth naming, because it is different from the shape
the previous two rounds found. Round 1 and round 2 both failed by reasoning about
the lead and assuming children inherited its properties. This round reasons
correctly about the child throughout. It fails instead by **specifying the
interesting half of a mechanism and leaving the boring half to the implementer**:
`activityChars` was chosen without asking what the row is made of (P0-1);
`canSend` was introduced by name, given a default, and never defined (P0-2); the
deadlock rule was argued to the point where it sounded right and stopped one step
short of sound (P0-3). All three are now written out. The pattern is worth
watching for in the next round: a design that is precise about its novel parts
and hand-waves its connective tissue is harder to review than one that is
uniformly vague, because the precision reads as completeness.

P1-9 is worth separating out, because it is the only finding that was not in the
prose at all. AC-20 asserted the **opposite** of the rule the paragraph above it
argues for, and it did so in a way that reads as a careful edge case. That is the
most expensive kind of defect a spec can carry: an implementer trusts the
criterion over the prose, weakens a correct rule to make the test pass, and the
weakening looks like diligence. It was found only by running the fixpoint from
P0-3 by hand against each of the six F-3 criteria - which is a check worth
repeating on any round that adds a rule and its counter-example in the same pass.

All 3 P0 and all 9 P1 concerns are resolved in the body. Seven of the eight P2s
are also fixed (P2-1 through P2-6 and P2-8 in the body; P2-7 recorded as an
explicit non-substitute for AC-12). No P0 or P1 remains open.

### Conditions

1. **Do not accept AC-3c, AC-20a and AC-20b as passing until they have been seen
   to fail.** Each targets a specific defect this review found in v1, and each
   would pass vacuously against a plausible-but-wrong implementation. AC-20b in
   particular fails on the **default** configuration if `canSend` is written the
   obvious way, so a green suite proves nothing unless the red was observed
   first. Section 12 lists ten such criteria; these three are the ones where the
   naive implementation is the one a competent engineer would reach for.

2. **Run AC-18a before AC-19 and AC-20.** The mutual-wait criteria are the only
   two in the round that depend on a piece of plumbing (the shared clock) that
   nothing else exercises, and under v1's two-clock arrangement they would have
   produced whatever the wall clock happened to make true that second.

3. **Measure step 3 of the manual test at exactly 80 columns**, with a child
   mid-prose and five running rows. Anything at or above 100 columns exercises
   the path v1 already fit into, so the test that matters is the narrow one. If
   the elapsed column disappears, `ROW_RESERVED_COLS` is wrong and no amount of
   `flexShrink` will hide it.

4. **Pre-check the `team-runtime.test.ts` stub before writing the retry cases**
   (v1's own condition, carried forward, and now with more force). A stub whose
   runs leave `retryable` true would make `shouldRetryColdStart` true for every
   child; the suite would hang rather than fail, and the hang would be attributed
   to the retry loop rather than to the fixture. The same pre-check now applies to
   the `canSend` default: `team-bus.test.ts` constructs `TeamBus` at five sites
   without one, and the default must stay `() => true` or those five change
   behaviour silently.

5. **Keep `checkWaitable` pure and keep it biased.** D-6 and D-16 are the two
   properties that make F-3 reviewable at all: a predicate with a counter inside
   it stops being trustworthy, and a predicate that guesses in the refusing
   direction fails invisibly. If a later change makes the fixpoint expensive
   enough to want caching, cache in the caller.

### Not blocking, recorded for the round that lands next

- `activityArgs` and the profile chip from `team-agent-profiles` both want the
  same row on a narrow terminal. Section 11.2 already says the chip should reuse
  `activityWideCols`; it should now also be sized against `activityBudget`, which
  is the more specific hook and did not exist when section 11 was written.
- `string-width` being imported by `logo.test.ts` without being a declared
  dependency of `packages/cli` (I-26) is a latent break waiting for an `ink`
  major. Out of scope here; worth a one-line `devDependencies` entry in whatever
  round next touches that file.
- Follow-up 5 (surfacing `retryable` in the report badge) is more attractive now
  that `run.retryable` exists and is populated on every failure path. Still its
  own round, as v1 says.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Written during implementation, against the design above. Every entry names the
section it contradicts and what was actually built. IF-1 is the only one that
changes what a user sees; the rest are accuracy, testability and this repo's own
code-size ceilings.

### IF-1 - The prose line renders the HEAD of the rolling window, not its tail

**Where**: 3.2.3 (`emit()`), 4.5 (`activityTailChars` / `activityChars`), 1.1.

`textTail` holds the last `activityTailChars` (160) code units the child wrote.
`emit()` publishes `sanitizeActivity(textTail, activityChars)` - and
`sanitizeActivity` clamps from the **head**, appending `...`. So the panel shows
the **first 64 characters of the trailing 160**, i.e. prose the child wrote
between 96 and 160 characters ago, advancing in 160-character jumps as the window
slides rather than following the write head.

Every prose description of the feature reads as the leading edge: 1.1 says "the
tail of the text the child is currently writing", 3.2.1 calls it "the child's
prose as it is written", and 6.1's mock-up (`writing: the three panels that no
longer...`) is a fragment with the ellipsis at the END, which is what a
head-clamp of a *leading* window produces. The two constants were chosen
independently and their interaction was never traced - the same shape the Review
Verdict names for the three P0s ("precise about its novel parts, hand-waves its
connective tissue").

**Not changed, deliberately.** 3.2.3 specifies the expression literally, AC-4
asserts only the bound (`<= activityChars`), and the alternative is a genuine UX
judgement rather than a correction: a trailing window re-renders scrolling text
on every published frame (up to 8 times a second, five rows at once), which may
well read worse on a one-line roster than a line that advances in steps. Choosing
between those is a design decision, not an implementation one.

**The one-line change, if the next round decides the other way**: set
`activityTailChars` equal to `activityChars`. The buffer is already sliced on
every append, so the per-delta cost is unchanged and `sanitizeActivity` needs no
edit. `team-activity.test.ts`'s AC-4 case pins the current value exactly and will
fail loudly, which is the intent.

### IF-2 - The illustrative widths in 6.1 and 4.5 do not match `activityBudget`

**Where**: 6.1 ("at 120 columns, `activityBudget` = 47"), 4.5
(`activityMinChars`: "below roughly 46 columns").

With `ROW_RESERVED_COLS = 35` and `WIDE_CHAR_ALLOWANCE = 2` the formula gives
`floor((120 - 35) / 2) = 42` at 120 columns, not 47, and the floor starts biting
below **59** columns rather than below 46. 6.1's 80-column figure (22) is
correct.

Cosmetic: the formula in 3.2.4 is authoritative, AC-3c asserts monotonicity and
the two bounds rather than any particular value, and both mock-ups remain
truthful about layout. Recorded so nobody "fixes" the constants to match the
prose.

### IF-3 - `checkWaitable` as written breaches this repo's complexity ceiling

**Where**: 3.4.2.

The method as specified is ~50 lines with the fixpoint loop inline, which puts
the `wakers.some(...)` test four levels deep (`for(;;)` > `for..of` > `if` >
callback) and its branch count over the `CLAUDE.md` ceiling of 10.

**Built as specified plus one extraction**: the fixpoint moved to a private
`closeCannotAct(cannotAct, key, finished)` that mutates the set in place. Both
properties condition 5 protects survive verbatim - `checkWaitable` still
registers nothing and counts nothing (pinned by the "checkWaitable is PURE"
case), and every undecidable branch still returns `null`. The helper is private,
so the seam is invisible outside the class.

### IF-4 - `runOne`'s retry body breaches the 60-line method ceiling

**Where**: 3.5.3.

With the comments the design itself mandates (the abort-exclusion paragraph, the
`this.live` aliasing warning, the D-9 usage note), the loop body lands well over
60 lines. The handle swap moved to a private `replaceForRetry(...)`, which is
also where the aliasing comment now lives - next to the assignment it warns
about. `settlePhase` and `backoff` are as specified. `RunOneCtx` is declared at
module scope, because TypeScript does not allow an `interface` inside a class
body as 3.5.3's indentation suggests.

### IF-5 - AC-3c cannot be asserted through a rendered frame

**Where**: 3.2.4 declares `activityLine` non-exported; 8.1 AC-3c asserts a
property of the string it returns.

The activity cell is `wrap="truncate"` inside an `overflow="hidden"` box, so Ink
shortens the row too. A frame assertion therefore cannot distinguish "the
arithmetic clamped it" from "Ink truncated it" - which is precisely the confusion
that let v1's fixed-width column look correct at 100 columns and break at 80.

`activityLine` is exported alongside `activityBudget`, for the same reason
`buildSubagentTools` is exported one round earlier: the property this round has
to keep has to be directly checkable. AC-3d still goes through a real 80-column
frame.

### IF-6 - An existing panel assertion changes, and it is not an unrelated edit

**Where**: 7.3 says the existing `team-panel.test.tsx` cases need a `cols` prop
and says nothing else about them.

One shipped case asserts `tool: grep` on a fixture with `lastTool: 'grep'` and no
args. F-1 removes the `tool: ` prefix entirely, and a `grep` whose pattern the
panel never saw degrades to the verb - so the assertion becomes `grep`, plus a
negative assertion that `tool: grep` is gone. This follows from 6.2's degradation
matrix but is not called out anywhere, and a reviewer scanning the diff would
otherwise read it as scope creep.

### IF-7 - AC-20c has no single end-to-end observable, and AC-20b nearly had none

**Where**: 8.1 AC-20b / AC-20c.

`TeamBus` is constructed inside `dispatch()` and never escapes, so neither
criterion can be asserted by reaching for the bus. AC-20b in particular is
worthless as a bus-level unit test: writing a `canSend` in the test file and
checking that `checkWaitable` consults it asserts the test, not the production
closure - and the production closure is exactly what P0-2 says a competent
engineer will get wrong.

**The seam that does work**: `agentFactory` receives the `AgentConfig` the
runtime assembled, and that carries the child's real `team_wait`. Driving it
directly (`team-runtime.test.ts`, "canSend end to end") asserts the shipped
predicate against the shipped bus. A refusal returns synchronously and a
permitted wait parks, so "permitted" is asserted as "did not return within 80 ms"
rather than by waiting out a 120-second timeout.

AC-20c is split, because its two halves live on opposite sides of that seam: the
bus half (the predicate is consulted at check time, never captured) is in
`team-bus.test.ts`; the runtime half (after a retry, `handles[i]` and the live
list are the same handle) is in `team-retry.test.ts`, asserted by counting
`abort()` calls on both stub agents.

### IF-8 - 7.3 lists three test files needing updates; there are four

**Where**: 7.3, and 8.1 AC-24.

AC-24 (`run.blockedWaits` reaches the report) is an assertion about
`buildDispatchReport` output, so it belongs in `team-report.test.ts` - which 7.3
does not list. Same class as P2-6, which the review caught for 7.1 and 7.2 and
did not re-run against 7.3. Three cases were added there: the conditional
`blocked waits: N` line, the `retried Nx` fragment, and both surviving the
last-resort trim that drops every summary.

### Discipline notes (conditions 1, 2 and 4, discharged)

- **Condition 1 / section 12.** All ten criteria were run against a deliberately
  naive implementation and **seen to fail** before being accepted: AC-3a
  (`basename(command)`), AC-3b (retain `event.args`), AC-3c (`activityBudget`
  returning `activityChars`), AC-10 (the shipped index slice), AC-12 (`retryable`
  alone gating the retry - 4 of 5 cases red), AC-17a (one stored resolver),
  AC-20 (a deadline-blind cycle detector), AC-20a (the deadline comparison with
  no fixpoint), AC-20b (`canSend` as "the phase is running"), and AC-20-inv plus
  AC-19 against the opposite error, an implementation from which `all_blocked` is
  unreachable.
- **Condition 2.** AC-18a is the first case in the F-3 block and was run before
  AC-19 and AC-20, which execute in declaration order after it.
- **Condition 4.** Pre-checked before writing the retry cases: the shipped
  `team-runtime.test.ts` `StubAgent` never emits `message_update`, so `retryable`
  is never set and `shouldRetryColdStart` is false for every existing fixture.
  The five `new TeamBus(...)` sites in `team-bus.test.ts` pass no `canSend`, and
  the default stays `() => true`.
- **AC-27.** Verified non-vacuous rather than assumed: a non-ASCII literal
  inserted into `team/activity.ts` makes `glyphs.test.ts` fail, and removing it
  makes it pass.
- **Condition 3** (step 3 of the manual test, at exactly 80 columns) is the one
  item that cannot be discharged from here: it needs a real terminal and a real
  provider. `manual-test.md` step 3 states the width and the reason it must not
  be run at 100.
