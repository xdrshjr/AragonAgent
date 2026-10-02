# Context auto-compaction — hardening round

**Feature slug:** `context-auto-compaction-hardening`
**Document version:** **v2** (round 2 of the loop; round 1 shipped as `553827ca7`)
**Review status:** reviewed — 2 P0 / 5 P1 / 5 P2 raised, all P0 and P1 fixed in the
body below. See `## 评审记录` and `## 评审结论`.
**Predecessor:** `docs/plans/context-auto-compaction/spec.md` v2 — read it first. This
document is a **delta**, not a replacement. Every decision, guard, limit and
invariant recorded there stands unless a row below says otherwise, and exactly
one of them is reversed (D-15, see §3.4).

---

## 评审记录 (Review Notes)

Reviewed against the tree at `553827ca7`, section by section, on the four
dimensions the review brief names: feasibility, completeness, consistency with
`CLAUDE.md` and the codebase's own conventions, and right-sizing.

**The headline:** W1's diagnosis is correct and important — I re-derived it
independently and the arithmetic holds (`agent-loop.ts:401` reads a `lastUsage`
assigned at `:495`, one push and a whole tool-result batch behind the history it
is deciding about). W2's gap is real (`compactor.ts:367` splices verbatim, and
`:297` is the only lever). W3's premise check is fair (`schema.ts:632-633`
really is 24 turns / 15 minutes). The evidence table is unusually honest: **15 of
17 rows verified exactly at the cited lines**, and the two misses are one-line
citation drift, not substance.

What the review found is that three of the six workstreams specify a *mechanism
the tree cannot provide*. W3 is wired through a method `Agent` does not have
(RV-1) and bounded by a constant it cannot reach (RV-2). W4 archives an array
that exists nowhere in the data model — every layer carries a **count** under
that name (RV-3). None of these is visible from the design's own vantage point;
all three are visible from the callee's.

| # | Severity | Section | Concern | Status |
|---|---|---|---|---|
| **RV-1** | **P0** | §3.4.3 | W3's child history accessor does not exist. `Agent` (core) has **no** `getMessages()`; it exposes `get state(): AgentState` (`agent.ts:200`), and `controller.ts:574` reads `this.agent.state.messages`. `controller.ts:1392`'s `getMessages()` is `AgentController`'s **own** method, not the engine's — the document mistakes one for the other and asserts the method "is already public". The second accessor is wrong too: `() => systemPrompt` names a local that does not exist, because `subagent.ts:316-330` builds the prompt **inline inside** the `agentFactory({…})` call. As written W3 does not compile, and the obvious repair (add `getMessages()` to core's `Agent`) is a public-API change §4.1 explicitly forecloses. Also: "the four existing stubs" is **eight** call sites across eight test files. | **Fixed** — §3.4.3 rewritten |
| **RV-2** | **P0** | §3.4.2 | W3's policy overlay cannot set `maxPerRun`. The table lists it as an overlay key "applied inside the factory rather than by mutating config", but `maxPerRun: 5` lives in `COMPACTION_LIMITS` (`limits.ts:72`) and is read directly as `COMPACTION_LIMITS.maxPerRun` at `compactor.ts:190`. `limits.ts:12-20` declares the structural/policy split load-bearing ("a user has no business tuning them"), so wrapping `getConfig()` — the mechanism that can carry the other four rows — cannot reach it. Left unfixed the child silently inherits **5**, which is 2.5× the bound DH-6 and RH-5 rest on when they reverse D-15. §7's `compactor.ts` row lists no such change. The overlay *mechanism* is also unstated for the four rows it can carry. | **Fixed** — §3.4.2 + §4.2 + §7 |
| **RV-3** | **P1** | §3.5.2 / §3.5.3 / §5.2 | W4 has no `Message[]` to archive. `droppedMessages` is a **number** at every layer: `CompactionPlan` (`compaction.ts:24`, `:118`), `finish(…, applied: { droppedMessages: number })` (`compactor.ts:577`, `:608`), `AgentEvent.compaction_end` (`types.ts:101`). The archive document reuses **that key name** for an array of verbatim messages, and §3.5.3 claims it "is handed over as a reference from the compactor's record" — `CompactionRecord` (`types.ts:70-88`) has no such field and §5.2 adds only `tailRelief?` / `archivePath?`. The messages exist solely as `before.slice(protectedPrefix, plan.cutIndex)` in `runCompaction`'s local scope (`compactor.ts:315`), long out of scope when `settlePending` runs. And they must **not** be put on `CompactionRecord`: that record is dispatched into the reducer (`App.tsx:858`) and retained in UI state, so a megabyte-scale array would enter React state and every transcript re-render. | **Fixed** — side channel + key renamed |
| **RV-4** | **P1** | §3.2.4 | W1's one-number guarantee fails in exactly the states that matter. `shouldCompact` returns **before** the measurement on five paths (`compactor.ts:190` per-run cap, `:201` cooldown, `:205` manual, `:210` overflow, `:213` self-disabled). Hanging `onPressure` off the measurement means the delta-aware gauge goes dark once the per-run cap is spent, while guard 4 has self-disabled, and through every cooldown window — i.e. precisely when compaction is exhausted and the window is still filling. The gauge silently reverts to the under-reporting base W1 exists to correct, and test 15 **pins that behaviour as correct**. AC-H4 is vacuous on those turns. | **Fixed** — measurement hoisted above the guards |
| **RV-5** | **P1** | §3.3.3 | A relief-only compaction is specified to report `mode: 'summarized'`. `CompactionRecord.mode` is derived from `outcome.mode` (`compactor.ts:587`) and `detailLine` (`CompactionCard.tsx:97-102`) renders `summarized ${messagesBefore - messagesAfter} messages with ${model}`. Relief changes no message count, so the card reads **"summarized 0 messages with claude-haiku-4-5"** for a compaction in which no summarization ran. This contradicts §6.3's own honesty rules and the `truncated` precedent it cites. | **Fixed** — §3.3.3 + §5.2 + §6.2a |
| **RV-6** | **P1** | §3.5.2 / §3.5.4 | The archive is one global directory with no session dimension, but both new verbs are specified against "**the session's** archives" and an `index` that is "1-based **within the session**". Concurrent `aragon` processes are an acknowledged in-tree condition — `file-sink.ts:94-95` says so in as many words. So two sessions interleave in one directory, `/compact history` presents another session's compactions as this one's, `<n>` is ambiguous across sessions, and global `archiveMaxFiles: 20` mtime pruning can delete a live session's archives from under it. No ambient in-process session id exists on the TUI path (`SessionMeta.id` is persisted, not live). | **Fixed** — run id in the name, listing scoped, retention two-tier |
| **RV-7** | **P1** | §3.5.3 | W4's write-ordering invariant is false on the manual path. §3.5.3 says the archive is written "only when `verdict.applied === true`, i.e. **after the engine adopted the splice**", justified by "writing on a refused splice would archive a history that is still live". But `compactNow` settles `applied: true` at `wiring.ts:306` and *returns* the messages; adoption happens afterwards in the caller at `controller.ts:1613`. Benign today because that caller always applies — but the failure posture is built on an invariant the code does not hold. | **Fixed** — invariant restated per path |
| **RV-8** | P2 | §7 | Both new files land in `src/compaction/`, which `glyphs.test.ts::inScope` (`:217`) hardcodes into the ASCII-only scanner; `limits.ts:5-10` records that no literal in that tree may hold a non-ASCII byte. The document never says so. Loud failure, not silent — hence P2. | Fixed (noted in §7) |
| **RV-9** | P2 | §3.3.2 | Rule 1 excludes `tool_call` args because "they are already clipped to 200 chars in the digest". `toolArgChars: 200` (`limits.ts:32`) bounds the **digest**, not the history; history args are unclipped. The sound argument is that assistant messages are bounded by `maxOutputTokens` per turn, so they are not what fills a window. | Fixed |
| **RV-10** | P2 | §3.2.2 | W1 falsifies a load-bearing comment: `compactor.ts:219-220` states "the measured branch ignores these two arguments, so this costs one closure call per turn on the common path". After W1 that branch walks and allocates a slice every turn. | Fixed (§3.2.2 note) |
| **RV-11** | P2 | §3.5.4 | `/compact show <n>`'s index domain is unstated — session compaction index, or the row number `/compact history` printed? | Fixed |
| **RV-12** | P2 | §2 | Citation drift, substance unaffected: `getProviderRegistry` is `controller.ts:1408` (E-13 says `:1409`); `partLength` is `output-limits.ts:323-334` (E-17's neighbourhood says `:320-333`); `SubagentAgentLike` ends at `:56`. | Fixed |

**Dimensions where the design was checked and found sound**, recorded so a later
reader does not re-litigate them:

- **Feasibility of W1's core arithmetic.** `Agent.emit` is synchronous
  (`agent.ts:365-379`) and `wiring.ts:406` reads `getMessages()` inside the
  `turn_end` handler, so `messages.length` there really is the **pre-push**
  length and the `+1` skip is exactly right. `estimatePromptTokens`
  (`output-limits.ts:356-363`) carries no cross-message state, so calling it on a
  slice is legitimate. DH-3 is also correct: `computeEstimateOffset` measures a
  whole request, so the offset is already inside the measured base.
- **The four invalidation sites are complete.** I traced every non-append
  mutation: `/clear` → `builtins.ts:1006` → site 3; `/resume` →
  `builtins.ts:1062` and `exec/index.ts:173` → both through
  `AgentController.replaceMessages` → site 4; the in-loop splice → site 1; the
  manual splice at `controller.ts:1613` bypasses site 4's hook but settles
  `applied: true` first, so site 1 does cover it (for a slightly different reason
  than §3.2.3 gives — see RV-7).
- **W2's structural-invariance claim.** Clipping a body changes no role, id or
  count, so `validateHistory`'s open/close walk is untouched. The property test
  (test 5) is the right shape for it.
- **Right-sizing.** Six workstreams is a lot for one round, but each is small and
  independently revertible, and W6 is the one that pays for the others. No
  workstream was found over-engineered. W4 is the closest call — an audit
  artefact is not what the user asked for — but R-1 makes it defensible and
  DH-14's refusal to add undo is the correct restraint.

---

## 0. Requirement trace (需求映射)

The user requirement, unchanged across both iterations:

| # | Requirement (原文) | Where it is served | After round 1 | What round 2 adds |
|---|---|---|---|---|
| **R-a** | 上下文使用量达到最大上下文长度的 90% 后自动触发压缩 | `Compactor.shouldCompact` → `shouldCompactAt` (`compaction/pressure.ts:151`) | Shipped. **But the number it compares is systematically short by one turn's tool results** (§2, E-1) | **W1** — occupancy counts every message in the history, not only those the last measurement covered |
| **R-b** | 类似 claude-code / codex 的行为 | Three triggers, the summarize → retry → truncate ladder, `/compact` | Shipped for the lead agent only | **W2** the last rung claude-code has and this build does not (relief inside the retained tail); **W3** sub-agents get the same protection |
| **R-c** | 压缩时 TUI 界面要显示正在压缩 | Activity row, status chip + gauge, transcript card | Shipped — three surfaces | **W5** — the live card gains elapsed time and the cancel affordance, so a 45-second wait is legible rather than merely animated |
| **R-d** | Anthropic 的顶级产品 / 美观优雅 / 稳健可靠 | Whole feature | Shipped, **never executed against a live provider** (11 manual rows, 7 marked ★ not skippable, all unrun) | **W6** — six of the seven ★ rows become offline CI tests driven by a scripted provider; **W4** — a compaction stops being an irreversible act |

**The honest summary of round 1:** the architecture is right, the code is
careful, and the feature has never run end to end outside unit tests with a
mocked `complete()`. Round 2 spends its budget on the three places where the
shipped code is *wrong or absent* (W1, W2, W3), one place where it is
*irreversible* (W4), one where it is *thin* (W5), and the fact that none of it
has ever been observed working (W6).

---

## 1. Overview

Round 1 gave a long run a way to survive a full context window: at 90 %
occupancy the loop pauses at a turn boundary, a summarizer replaces the older
half of the history with a structured `<compacted_context>` block, and the run
continues with the same tools, todo list and working directory. That mechanism
is sound. Reading the shipped tree against the loop it lives in, however, turns
up one defect that defeats the trigger's whole purpose and two structural gaps
that show up precisely in the workload the feature was built for — a long,
tool-heavy, unattended run.

The defect is arithmetic. `computePressure` returns the provider's reported
usage for the **previous** request whenever there is one, and the checkpoint
that reads it runs *after* the current turn's tool results have been appended to
the history (`agent-loop.ts:401` versus `:478` and `:497`). Tool results are the
largest single increment in this loop — the executor caps combined text output
at 100 000 bytes *per call* (`core/src/tools/executor.ts:44`), roughly 25 000
tokens at `CHARS_PER_TOKEN`, and a turn may carry several in parallel. So the
number the trigger fires on is short by exactly the quantity that fills windows.
A session reading 88 % can be sending 110 %. The feature then works, but through
its reactive path: a failed HTTP request, a burnt one-shot recovery flag, and a
compaction that happens after the provider has already refused. W1 makes the
occupancy figure count the whole history — measured base plus an estimate of
what has been appended since the measurement — and routes that same number to
the status gauge so the user and the trigger keep reading one value (R-11).

The two structural gaps are the ends of the ladder. At the bottom, nothing
handles a **retained tail that alone exceeds the window**: `keepRecentTurns`
messages are spliced back verbatim (`compactor.ts:367`), an overflow attempt may
halve `keepRecentTurns` once (`:297`), and if two turns of large tool results
still do not fit, the run dies with no rung left. At the top, **sub-agents get
no compaction at all** (D-15), on the stated grounds that they are short-lived —
but a child is bounded by `team.maxTurnsPerSubagent: 24` and
`team.dispatchTimeoutMs: 900_000` (`config/schema.ts:632`), which is 24 turns and
fifteen minutes, the same profile the commit message uses to describe a run that
fills a window. When a child overflows, its history is discarded, the dispatch
reports an error, and up to fifteen minutes of work reaches the lead as one
partial assistant sentence. W2 adds the missing rung (bounded, announced,
structure-preserving clipping of oversized `tool_result` bodies inside the
retained tail). W3 reverses D-15 with a per-child manager under tighter bounds.

The remaining three workstreams are about the difference between working and
being trustworthy. W4 makes compaction non-destructive on disk: the dropped
messages are written to a pruned archive before the splice is adopted, so R-1 —
"the summary is wrong and the agent proceeds confidently on a false record",
the feature's defining risk — becomes a thing a human can check rather than a
thing they must accept. W5 gives the live transcript card an elapsed counter and
tells the user that Esc cancels, which `controller.ts:917` has always made true
and no surface has ever said. W6 builds the offline harness that lets six of the
seven ★-not-skippable manual rows run in CI, because a feature whose failure
mode is "the session becomes permanently un-sendable" should not be defended
solely by unit tests that mock the summarization call.

---

## 2. Evidence — what was read, and what it proves

Every claim this document is built on was verified in the tree at `553827ca7`.
The line numbers are from that commit.

| # | Evidence | Where | What it proves |
|---|---|---|---|
| **E-1** | The compaction checkpoint runs at the top of the `while`, before `turn_start`; `turn_end` is emitted at `:478`, `lastUsage = usage` at `:495`, and the assistant message is pushed at `:497` — tool results are appended after that, inside the tool-processing block. | `core/src/engine/agent-loop.ts:401`, `:478`, `:495`, `:497` | At the checkpoint, `probe.lastUsage` describes a request that did **not** include this turn's assistant message (covered separately by `outputTokens`) **nor any of its tool results**. |
| **E-2** | `computePressure` takes the measured branch whenever `lastUsage` is present and never looks at `input.messages` on that branch. | `cli/src/compaction/pressure.ts:103-113` | The under-report of E-1 reaches both the trigger and the gauge unmodified. |
| **E-3** | Combined tool text output is capped at 100 000 bytes per call, and truncation is applied per call, not per turn. | `core/src/tools/executor.ts:35`, `:44` | The invisible delta is bounded by (100 KB x parallel calls), i.e. ~25 k tokens per call. On a 200 k window with a 0.9 threshold the headroom is 20 k. One call can exceed it. |
| **E-4** | The retained tail is `before.slice(plan.cutIndex)`, spliced verbatim; nothing clips a message body. | `cli/src/compaction/compactor.ts:367` | There is no mechanism for "the tail itself does not fit". |
| **E-5** | An overflow attempt halves `keepRecentTurns` in memory, floored at 1. | `cli/src/compaction/compactor.ts:297-300` | The only existing lever. `Math.max(1, floor(4/2)) = 2`; if two turns do not fit, the ladder is exhausted. |
| **E-6** | `planCompaction` returns `null` when the best cut is at or below `protectedPrefix`; the caller turns that into `nothing_to_drop` and charges guard 3. | `core/src/engine/compaction.ts:115`, `cli/src/compaction/compactor.ts:303-306` | "Nothing to drop" and "the tail is too big" are the same outcome today, and both are terminal. |
| **E-7** | `defaultSubagentFactory` is `(config) => new Agent(config)`; the child's `AgentConfig` is assembled at `:315-349` and contains no `contextManager`. `agentRef` is assigned at `:350`. | `cli/src/team/subagent.ts:61`, `:315`, `:350` | Sub-agents inherit no compaction. Confirmed by grep: `contextManager` appears in exactly one construction site, `agent/controller.ts:596`. |
| **E-7b** | `Agent` exposes `get state(): AgentState` and has **no** `getMessages()` method; `AgentController.getMessages()` at `:1392` is the *controller's* method, whose body is `this.agent.state.messages`. The wiring is fed the same way at `:574`. | `core/src/engine/agent.ts:200`, `cli/src/agent/controller.ts:574`, `:1392` | **The accessor W3 needs is a property read, not a method call** (RV-1). `SubagentAgentLike` (`subagent.ts:52-56`) exposes neither today. |
| **E-7c** | `COMPACTION_LIMITS.maxPerRun` is a module constant read directly by the guard, and `limits.ts`'s header declares the structural/policy split ("a user has no business tuning them"). | `cli/src/compaction/limits.ts:12-20`, `:72`, `cli/src/compaction/compactor.ts:190` | **A per-child `maxPerRun` cannot come from config** (RV-2). It has to become an instance-level bound. |
| **E-8** | `team.maxTurnsPerSubagent: 24`, `team.dispatchTimeoutMs: 900_000`. | `cli/src/config/schema.ts:632-633` | D-15's premise ("children are short-lived") does not hold for the upper end of the configured bound. |
| **E-9** | A child's stream error becomes `run.error`, and `run.summary` keeps the last non-empty assistant text. | `cli/src/team/subagent.ts:462-468`, `:427` | A child overflow is survivable for the *dispatch* but total for the *child's context*: everything it learned is discarded. |
| **E-10** | `AgentController.abort()` calls `this.compaction?.abort()` before `agent.abort()`, deliberately redundant with the engine's own race. | `cli/src/agent/controller.ts:911-918` | "Esc cancels an in-flight summarization" is already true. No surface tells the user. |
| **E-11** | The live card renders a spinner, `compacting context #N`, and the model; `durationMs` is only rendered once settled. | `cli/src/ui/entries/CompactionCard.tsx:77-91` | Between second 0 and second 45 the card carries no changing information. |
| **E-12** | The reducer writes `contextTokens` from `occupiedTokens(action.usage)` at `turnEnd`, and from `contextTokensEstimated` after a compaction. | `cli/src/agent/reducer.ts:1198`, `:1787`, dispatched at `cli/src/ui/App.tsx:870` | There is exactly one existing action for "the gauge figure is derived". W1 reuses it rather than inventing a second writer. |
| **E-13** | `CompactionWiring.getRegistry()` lazily calls `initProviders()` with no injection seam; `AgentController` builds its own registry at `:341` and exposes it via `getProviderRegistry()` at `:1408`. | `cli/src/compaction/wiring.ts:364-372`, `cli/src/agent/controller.ts:341`, `:1408` | The lead's transport is scriptable in a test today; the summarizer's is not. One optional dep closes it. |
| **E-14** | `getSessionsDir()` is `<home>/sessions`, and `app-paths.ts` records that `logs/`, `sessions/` and `skills/` are scan roots — "every extra file inside one is another thing each walk has to recognise and skip". | `cli/src/config/app-paths.ts:182-184`, `:206` | The archive must **not** live in `sessions/`. It gets its own root. |
| **E-15** | `enforceRetention(dir, maxFiles)` exists but is coupled to the log file prefix/suffix constants. | `cli/src/logging/file-sink.ts:97-118` | The pattern is reusable; the function is not. W4 gets a 20-line twin rather than a generalization that would put log knowledge in the compaction tree. |
| **E-16** | `ProviderRegistry.register()` overwrites by id and is public. | `core/src/llm/providers/index.ts:40-42` | A scripted provider can replace `anthropic` in a test registry with no production change. |
| **E-17** | `estimatePromptTokens(messages, systemPrompt?)` = `ceil(chars / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD_TOKENS * count`, and counts nothing else — in particular not tool schemas. `partLength` (`:323-334`) is what gives it the `string | ContentPart[]` shapes W2 clips. | `core/src/llm/output-limits.ts:356-363`, `:323-334` | It is safe to call on a *slice*: the function has no cross-message state. This is what makes W1's delta computable with an existing export. |
| **E-18** | `Agent.emit` is synchronous — it applies the watchdog policy, calls every listener in a `for` loop, then kicks. | `core/src/engine/agent.ts:365-379` | `wiring.ts:406`'s `getMessages()` inside the `turn_end` handler observes the history **before** `agent-loop.ts:497`'s push. This is what makes W1's `+1` skip exactly right rather than approximately right. |
| **E-19** | `shouldCompact` returns before ever measuring on five paths: per-run cap, cooldown, manual, overflow, self-disabled. The measurement is the last thing it does. | `cli/src/compaction/compactor.ts:190`, `:201`, `:205`, `:210`, `:213`, `:221` | **A gauge fed from that measurement stops updating whenever a guard short-circuits** (RV-4) — including the exhausted-and-still-filling state the user most needs it in. |
| **E-20** | Retention is best-effort because "on Windows another `aragon` process may hold a handle on a file we would like to remove". | `cli/src/logging/file-sink.ts:94-95` | Concurrent CLI processes are an **acknowledged in-tree condition**, so a single global archive directory keyed by a per-session index is ambiguous by construction (RV-6). |

---

## 3. Technical design

### 3.1 Module map delta

```
packages/core/src/engine/
  compaction.ts            MODIFIED  + relieveTail(), + TailReliefResult   (W2)
  context-manager.ts       unchanged
  agent-loop.ts            unchanged                                        <- note
  types.ts                 MODIFIED  + compaction_end.tailRelief            (W2)

packages/cli/src/compaction/
  pressure.ts              MODIFIED  + delta-aware computePressure          (W1)
  compactor.ts             MODIFIED  + measuredPrefixLength, + tail relief  (W1,W2)
  wiring.ts                MODIFIED  + onHistoryReplaced, + createRegistry
                                     + archive hand-off, + childManager()   (W1,W3,W4,W6)
  types.ts                 MODIFIED  + Pressure.deltaTokens, + record fields
  limits.ts                MODIFIED  + 6 constants
  archive.ts               NEW       write + list + prune                   (W4)
  child.ts                 NEW       ChildCompactionFactory                 (W3)
  command.ts               MODIFIED  + `history`, + `show <n>`              (W4)

packages/cli/src/
  agent/controller.ts      MODIFIED  3 history-mutation notifications, child factory
  team/subagent.ts         MODIFIED  1 conditional spread                   (W3)
  team/types.ts            MODIFIED  + SubagentRun.compactions              (W3)
  team/runtime.ts          MODIFIED  pass the factory through               (W3)
  ui/entries/CompactionCard.tsx  MODIFIED  elapsed + cancel hint + relief  (W2,W5)
  ui/App.tsx               MODIFIED  elapsed tick into the live card        (W5)
  config/schema.ts         MODIFIED  2 new keys                             (W3,W4)
  config/{store,env,load,cli-commands}.ts  MODIFIED  the 2 keys everywhere
```

**`agent-loop.ts` is deliberately untouched.** Every round-2 change is on the
host side of the port or inside the pure `compaction.ts` module. The engine seam
— checkpoint placement, the copy handed across the port, the structural gate,
the watchdog pause, the 120 s ceiling — was reviewed twice in round 1 and is
correct. Reopening it to carry host policy would undo §1.2's boundary.

---

### 3.2 W1 — occupancy counts the whole history

#### 3.2.1 The defect, as a sequence

```
turn 12   request sent            (provider measures 152 000 tokens -> lastUsage)
          turn_end emitted        wiring records: gauge = 152 000  (76 % of 200 k)
          assistant pushed        (+3 400 tokens, already inside usage.outputTokens)
          read_file x2 executed   (+2 x 98 KB of text  ->  ~49 000 tokens appended)
turn 13   CHECKPOINT              shouldCompact reads lastUsage = 152 000  -> 76 %
                                  threshold 90 % not met -> no compaction
          request built           actual prompt ~204 400 tokens  -> HTTP 400
          reactive path           compaction runs, one request wasted,
                                  overflowRecovered burnt for this turn
```

The trigger's job is to fire *before* the request that would not fit. It is
reading a number that predates the largest contributor to that request.

#### 3.2.2 The fix

The measured figure stays authoritative for what it covers; the messages
appended since are estimated and added.

```ts
// cli/src/compaction/pressure.ts

export interface PressureInput {
  lastUsage?: TokenUsage;
  messages: readonly Message[];
  systemPrompt: string;
  contextWindow: number;
  windowKnown: boolean;
  estimateOffset?: number;
  /**
   * The history LENGTH the measurement in `lastUsage` covered — i.e.
   * `messages.length` at the `turn_end` that produced it, BEFORE the assistant
   * message was pushed. `undefined` disables the delta entirely and reproduces
   * round 1's behaviour exactly.
   */
  measuredPrefixLength?: number;
}
```

```ts
if (input.lastUsage) {
  const base = occupiedTokens(input.lastUsage);
  const delta = estimateAppendedTokens(input.messages, input.measuredPrefixLength);
  occupied = base + delta;
  source = 'usage';
  deltaTokens = delta;
} else {
  const raw = estimatePromptTokens(input.messages as Message[], input.systemPrompt);
  occupied = raw + (input.estimateOffset ?? 0);
  source = 'estimate';
  deltaTokens = 0;
}
```

```ts
/**
 * Tokens appended to the history since the measurement that produced `lastUsage`.
 *
 * `+ 1` SKIPS THE ASSISTANT MESSAGE, and that is not an off-by-one to tidy away:
 * `turn_end` fires BEFORE the push (`agent-loop.ts:478` / `:497`), so the message
 * at index `measuredPrefixLength` is the assistant turn whose cost is ALREADY in
 * `usage.outputTokens`. Counting it again double-charges every turn.
 *
 * NO `estimateOffset` IS APPLIED HERE. That offset is the systematic difference
 * between what `estimatePromptTokens` counts and what the provider bills for a
 * WHOLE REQUEST — chiefly the tool schemas, which are sent once per request and
 * are already inside `base`. It is a per-request constant, not a per-message
 * rate. Adding it to a slice would inflate occupancy by several thousand tokens
 * on every turn and fire compaction early on short conversations.
 *
 * BOUNDS-CHECKED RATHER THAN TRUSTED. If the recorded prefix no longer indexes
 * this array — a `/clear`, a `/resume`, a splice whose invalidation call was
 * missed — the delta is 0 and the function degrades to round 1's number. A
 * missing invalidation must cost accuracy, never correctness.
 */
export function estimateAppendedTokens(
  messages: readonly Message[],
  measuredPrefixLength: number | undefined,
): number {
  if (measuredPrefixLength === undefined) return 0;
  const start = measuredPrefixLength + 1;
  if (start >= messages.length) return 0;
  return estimatePromptTokens(messages.slice(start) as Message[]);
}
```

**One existing comment must be corrected in the same edit (RV-10).**
`compactor.ts:219-220` currently reads "The measured branch ignores these two
arguments, so this costs one closure call per turn on the common path." W1 makes
that false: the measured branch now walks `messages.slice(prefix + 1)` and
allocates that slice on every turn. The cost is bounded by **one turn's**
appended messages, not by the history, so it stays negligible — but the comment
is load-bearing documentation in this codebase and a false one is worse than
none. It becomes: "The measured branch reads `messages` only to estimate what
was appended after the measurement (§3.2.2); the slice is one turn wide."

`Pressure` gains `deltaTokens: number` (always present, `0` when there is none)
and `isApproximate(p)` becomes the single exported rule for the `~` prefix:

```ts
/** The one rule for "this number is partly a guess" (§6.3). */
export function isApproximate(p: Pressure): boolean {
  return p.source === 'estimate' || p.deltaTokens > 0;
}
```

#### 3.2.3 Recording the prefix, and invalidating it

`Compactor` gains one field and one method:

```ts
private measuredPrefixLength: number | undefined;

onTurnEnd(usage: TokenUsage, messages: readonly Message[], systemPrompt: string): void {
  this.estimateOffset = computeEstimateOffset(usage, messages, systemPrompt);
  // The SAME array `computeEstimateOffset` just measured, so the two numbers
  // describe the same request by construction.
  this.measuredPrefixLength = messages.length;
}

/** Any host-side history mutation that is not an append. */
invalidateMeasurement(): void {
  this.measuredPrefixLength = undefined;
}
```

`measure()` forwards `measuredPrefixLength` into `computePressure`.

**Invalidation is required at exactly four sites.** Each is a place where the
history is replaced or cleared rather than appended to, so recorded indices stop
meaning anything:

| # | Site | Call |
|---|---|---|
| 1 | `CompactionWiring.settlePending` when `verdict.applied === true` (the in-loop splice) | `this.compactor.invalidateMeasurement()` |
| 2 | `CompactionWiring.compactNow` after a successful `replaceMessages` — i.e. inside the `applied: true` settle, so site 1 covers it | (same call, one code path) |
| 3 | `AgentController.clearMessages()` (`:1370`) | `this.compaction?.onHistoryReplaced()` |
| 4 | `AgentController.replaceMessages()` (`:1388`) | `this.compaction?.onHistoryReplaced()` |

`CompactionWiring.onHistoryReplaced()` is a two-line forwarder. Sites 3 and 4
cover `/clear`, `/resume`, and any future host-side rewrite; the bounds check in
`estimateAppendedTokens` is the belt for a fifth site nobody remembers to add.

#### 3.2.4 One number on screen and in the trigger (R-11 preserved)

Round 1's R-11 says the gauge and the trigger must read one function, and today
they do — `occupiedTokens`, at `reducer.ts:1198` for the gauge and inside
`computePressure` for the trigger. W1 would break that: the trigger would see
`base + delta` at the checkpoint while the gauge still showed `base` from the
last `turn_end`, and a user watching 76 % would see compaction fire.

The fix reuses the one existing derived-figure action (E-12) rather than adding
a second writer:

1. `Compactor.shouldCompact` **measures once, before the guards**, and reports
   that measurement unconditionally (see the ordering rule below).
2. `CompactionWiring` supplies the reporting dep as
   `(pressure) => this.emit({ type: 'snapshot', snapshot: this.snapshotWith(pressure) })`,
   where `snapshotWith` is `snapshot()` with the pressure argument substituted
   for the re-measurement (so the checkpoint does not measure twice).
3. `App.tsx`'s existing `case 'snapshot'` handler (`:890-892`, which today only
   dispatches `compactionSnapshot`) gains a second dispatch:
   `{ type: 'contextTokensEstimated', tokens: snapshot.pressure.occupied }`
   **when `isApproximate(snapshot.pressure)`**, which is precisely the case
   `contextTokensEstimated` was built for and which already sets the `~`.

With compaction off there is no wiring, no snapshot, no dispatch, and the gauge
is written only at `turnEnd` exactly as before — AC-1's byte-identity claim is
untouched.

##### The ordering rule (RV-4) — measure above the guards, not below them

`shouldCompact` today returns **before** it measures on five paths (E-19):
per-run cap (`:190`), cooldown (`:201`), manual (`:205`), overflow (`:210`),
self-disabled (`:213`). Hanging the gauge off the measurement therefore stops
feeding it in every one of those states — and two of them are permanent:
`compactionsThisRun >= maxPerRun` never clears within a run, and guard 4's
`selfDisabled` is designed not to. **The user would lose the corrected number at
exactly the moment it becomes the only number that matters:** compaction spent,
window still filling, nothing left to save the session but the user noticing.
The gauge would silently fall back to the measured base — the very figure W1
exists because it under-reports.

So the measurement moves up. The rewritten shape:

```ts
shouldCompact(probe: CompactionProbe): boolean {
  const config = this.deps.getConfig().compaction;
  if (!config.enabled) return false;

  // MEASURED ONCE, ABOVE THE GUARDS, AND REPORTED UNCONDITIONALLY (RV-4).
  // Below the guards this call is skipped on five paths, two of them permanent
  // (the per-run cap and guard 4 never clear within a run) - so the delta-aware
  // gauge would go dark precisely when compaction is exhausted and the window is
  // still filling. Reporting is not a side effect of deciding; it is the other
  // half of R-11.
  const pressure = this.measure({
    ...(probe.lastUsage ? { lastUsage: probe.lastUsage } : {}),
    messages: this.deps.getMessages(),
    systemPrompt: this.deps.getSystemPrompt(),
  });
  this.deps.onPressure?.(pressure);

  if (this.compactionsThisRun >= this.maxPerRun) return false;      // guard 2
  const cooled = probe.turnIndex - this.lastCompactionTurn >= COMPACTION_LIMITS.minTurnsBetween;
  const manual = this.pendingManual !== null;
  if (probe.trigger !== 'overflow' && !manual && !cooled) return false;  // guard 1
  if (manual) return true;
  if (probe.trigger === 'overflow') return true;
  if (this.selfDisabled) return false;                              // guard 4

  return shouldCompactAt(pressure, config.threshold, {
    maxOutputTokens: this.effectiveMaxOutputTokens(),
  });
}
```

**What this costs, stated rather than waved at.** The guards stop being free:
every enabled turn now pays one `measure()` — on the measured branch that is
`occupiedTokens` plus an `estimatePromptTokens` over a **one-turn-wide slice**,
and on the estimate branch it is the full-history walk `shouldCompact` already
paid whenever it got past the guards. This is bounded, synchronous and allocates
one slice; `shouldCompact`'s contract comment ("SYNCHRONOUS, CHEAP, SIDE-EFFECT
FREE except for the pressure cache") stays true, and it is updated to name
`onPressure` as the second, deliberate effect. **With compaction disabled the
`!config.enabled` early return is still the first statement, so an ordinary
session pays nothing** — AC-H1 is unaffected.

Test 15 changes accordingly: `onPressure` fires **once per enabled checkpoint**,
including checkpoints where a guard then declines to compact, and **not** when
`compaction.enabled` is false. Written the other way round it would pin the
defect as the contract.

#### 3.2.5 What the fix is worth, quantitatively

With `keepRecentTurns: 4`, `threshold: 0.9` and a 200 k window, the pre-fix
trigger can be short by one turn's tool output (E-3: up to ~25 k tokens per
call). Post-fix the trigger fires on `152 000 + 49 000 = 201 000` in §3.2.1's
sequence — above the 180 000 threshold — and the request that would have been
refused is never built. The reactive path stays as the safety net for the case
this cannot cover (a wrong `contextWindow`), which is what R-5 says it is for.

---

### 3.3 W2 — the last rung: relief inside the retained tail

#### 3.3.1 What is missing

The ladder today: summarize with the fast tier → retry on the main model →
truncate the head without a summary → (by config) stop. Every rung operates on
the **head**. When the *tail* is what does not fit — four turns, or two after an
overflow halving, carrying several 100 KB tool results — every rung reports
success or `nothing_to_drop` while the history stays un-sendable (E-4, E-5, E-6).

#### 3.3.2 The mechanism

A new pure function in core, alongside the other mechanics:

```ts
// core/src/engine/compaction.ts

export interface TailReliefOptions {
  /** Index the tail starts at; nothing before it is touched. */
  from: number;
  /** Clip each oversized tool_result body to this many characters. */
  clipChars: number;
  /** Stop as soon as the estimate falls below this. */
  targetTokens: number;
  /** System prompt, so the estimate is measured the same way everywhere. */
  systemPrompt: string;
  /** Appended where text was removed. The host supplies it; core has no glyphs. */
  marker: (removed: number) => string;
}

export interface TailReliefResult {
  messages: Message[];
  clippedMessages: number;
  charsRemoved: number;
}

export function relieveTail(
  messages: readonly Message[],
  opts: TailReliefOptions,
): TailReliefResult;
```

Rules, in order, and each of them load-bearing:

1. **Only `tool_result` bodies are eligible.** Not `user` messages (the anchor
   and the user's own instructions are the last things to damage), not
   `assistant` messages (clipping the model's own reasoning mid-tail produces a
   history that contradicts itself), and not the `tool_call` args carried inside
   them. **The reason for that last exclusion is a size bound, not the digest
   (RV-9):** `toolArgChars: 200` clips args *in the digest*, and the history's
   copies are unclipped — but an assistant message is bounded by the turn's
   `maxOutputTokens`, so with `keepRecentTurns` at 2–4 the assistant side of the
   tail is tens of thousands of tokens at the very most. Tool *results* are
   bounded at 100 KB **each** (E-3) and there can be several per turn. The tail
   is blown by results, not by calls. Recorded as DH-4.
2. **Oldest first.** The newest tool result is the one the next request is most
   likely to be about. Walk from `from` upward and stop as soon as the projected
   estimate is under `targetTokens`.
3. **Structure is never changed.** No message is removed, no `toolCallId` is
   touched, no role changes. `validateHistory` therefore cannot fail on a
   relieved history — the open/close walk sees the identical sequence. This is
   what makes W2 safe to run *after* a splice, and it is the reason relief clips
   rather than drops.
4. **Every clip is announced in the text the model reads**, at the exact place
   the data was removed: `content.slice(0, clipChars) + marker(removed)` where
   the host passes
   `(n) => "\n[... ${n} characters removed by context compaction ...]"`. A model
   that sees the marker knows the output is partial and can re-run the tool; a
   model handed a silently truncated file does not.
5. **Content shapes:** `tool_result.content` is `string | ContentPart[]`
   (`partLength`, `output-limits.ts:320-333`). A string is sliced. A part array
   has its `text` parts clipped in order, longest first, until the budget is met;
   `image` parts are left alone (they are counted at a flat `CHARS_PER_TOKEN *
   256` by the estimator and clipping them is a different feature). Recorded as a
   known limitation in §12.

#### 3.3.3 Where it is called

Inside `Compactor.runCompaction`, after the splice is assembled and before
`this.finish(...)`:

```ts
const spliced: Message[] = [anchor.message, block, ...before.slice(plan.cutIndex)];

// The tail's own size is only knowable AFTER the head is gone. Projecting it
// before the splice would be projecting against a number that is about to change
// by 80 %.
const budget = this.tailBudgetTokens();      // window - requiredHeadroom - blockAllowance
const projected = estimatePromptTokens(spliced, ctx.systemPrompt);
let relief: TailReliefResult | null = null;
if (projected > budget) {
  relief = relieveTail(spliced, {
    from: 2,                                  // anchor + block are never eligible
    clipChars: COMPACTION_LIMITS.tailToolResultChars,
    targetTokens: budget,
    systemPrompt: ctx.systemPrompt,
    marker: tailClipMarker,
  });
}
```

and the `plan === null` branch (E-6) gains the same treatment: when there is
nothing to drop **and** occupancy is over budget, relief runs on the unspliced
history with `from = protectedPrefix`, and a result with `clippedMessages > 0`
is returned as `action: 'replace'` with `reason: 'tail_relief_only'`. That
converts today's terminal `nothing_to_drop` into a recoverable outcome — which
is exactly the case that kills a run today.

##### What a relief-only compaction is called (RV-5)

v1 of this section said the outcome keeps `mode: 'summarized'` "unchanged". It
cannot. `CompactionRecord.mode` is copied from `outcome.mode`
(`compactor.ts:587`) and `detailLine` (`CompactionCard.tsx:97-102`) renders

```
summarized ${messagesBefore - messagesAfter} messages with ${model}
```

Relief drops **no** messages, so that line resolves to **"summarized 0 messages
with claude-haiku-4-5"** — a claim that a summarization ran, on nothing, when
none ran at all. That is the same class of statement §6.3's honesty rules and
round 1's `truncated` disclosure exist to forbid, and it would appear only in
the rare, alarming case the user most needs to read correctly.

The port's shape still stays frozen (DH-5): `CompactionOutcome.mode` remains
`'summarized' | 'truncated'` and relief-only reports **`'truncated'`** across the
port, because `truncated` is already the engine-side word for "this history was
reduced without a summary" and that is literally what happened. The distinction
lives on the CLI's own record, where the vocabulary is the CLI's to extend:

- `CompactionMode` (`cli/src/compaction/types.ts:25`) gains a fourth member,
  `'relieved'`, and `finish` sets it when the outcome carries
  `reason === 'tail_relief_only'`.
- `detailLine` gains the matching branch **before** its `truncated` branch:
  `clipped ${n} tool results in the retained turns - nothing could be dropped`.
- Everywhere `CompactionMode` is switched on must be revisited; the union is
  small and TypeScript finds them, but `mode === 'summarized'` written as an
  `else` will silently absorb the new member, so the implementing node greps for
  `'truncated'` and pairs each site.

A relief-only card therefore reads honestly on both lines: the headline still
shows the token drop that makes it worth reporting
(`112 → 112 messages · 118.4k → 95.2k tokens`), and the detail line says what
actually happened.

`tailBudgetTokens()` is
`max(0, contextWindow - requiredHeadroom({ maxOutputTokens }) - COMPACTION_LIMITS.blockAllowanceTokens)`.
The block allowance (2 000) reserves room for the `<compacted_context>` block
itself, which is written after the projection.

#### 3.3.4 Reporting

`relief` flows out through three places, all additive:

- `CompactionOutcome` is **not** extended. The engine does not need to know; it
  validates and adopts a history like any other. (DH-5: keeping the port's shape
  frozen is worth more than reporting symmetry.)
- `CompactionRecord.tailRelief?: { messages: number; charsRemoved: number }` —
  the CLI's own record, which is what the card and `/compact status` read.
- `AgentEvent.compaction_end.tailRelief?: { messages: number; charsRemoved: number }`
  — optional, so no existing subscriber changes. This is the one core-side type
  addition in round 2, and it exists so `aragon exec`'s JSON stream and the
  headless stderr line can report a degradation that the user is entitled to
  know about. It requires the three-sync discipline (C-6): `types.ts`, `API.md`,
  `CHANGELOG.md`, plus `logging/install.ts`'s union (IF-3's lesson).

Guard 3 (`minReclaimRatio`) counts relief as progress: `checkProgress` measures
the final history, which is the relieved one, so this happens for free — the
call already takes `messages`. A test pins it (AC-H7), because "for free" is the
kind of property a refactor breaks silently.

---

### 3.4 W3 — sub-agents survive their own window (reverses D-15)

#### 3.4.1 Why the reversal

D-15's reasoning was: "children are bounded by their dispatch timeout and turn
cap; giving them one makes a dispatch's cost unpredictable." The premise is
measurable and false at the configured bounds (E-8): 24 turns and 15 minutes is
the same shape as the lead run the feature exists for. The cost argument also
inverts once you price the alternative — an overflow ends the dispatch, and the
lead pays for 24 turns of a child's tool calls and receives one sentence (E-9).
One extra fast-model summarization is the cheap side of that trade.

**DH-6: D-15 is reversed, under tighter bounds and behind a config key.**

#### 3.4.2 Shape

A child manager is the same `Compactor` with a different policy overlay and no
UI. `compaction/child.ts`:

```ts
export interface ChildCompactionDeps {
  /** The lead wiring's own resolution + transport, reused (D-10 stays true). */
  resolveSummarizer: () => SummarizerChoice | null;
  complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  getConfig: () => CliConfig;
  getModelInfoFor: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => ModelInfo;
  isPricedModel: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => boolean;
  /** Child compaction spend joins the session totals through the lead's sink. */
  onUsage: (usage: TokenUsage) => void;
  /** For the team panel's `compacted N` marker. */
  onCompacted: (label: string) => void;
}

/** One manager per child. State is per-history and must not be shared. */
export function createChildContextManager(
  label: string,
  getMessages: () => readonly Message[],
  getSystemPrompt: () => string,
  deps: ChildCompactionDeps,
): ContextManager;
```

Policy overlay:

| Key | Lead | Child | Where it comes from | Why |
|---|---|---|---|---|
| `threshold` | `compaction.threshold` (0.9) | same | config, untouched | One number the user set. |
| `keepRecentTurns` | 4 | **2** | **config view** | A child's task is narrow; two turns is enough continuity, and it doubles the head available to summarize. |
| `maxPerRun` | 5 | **2** | **instance bound** | Cost predictability, which was D-15's real concern. |
| `useFastTier` | config | **forced true when the fast tier resolves** | **config view** | A background repair inside a background worker must never take the main model's quota. |
| `onFailure` | config | **forced `truncate`** | **config view** | A child that stops is a failed dispatch; the user is not there to intervene. |
| manual queue | yes | **no** | never queued | There is no `/compact` for a child. |
| archive (W4) | yes | **no** | dep omitted | One archive per lead compaction is auditable; twenty per dispatch is noise. |

##### The overlay needs two mechanisms, not one (RV-2)

v1 said the overlay is "applied inside the factory rather than by mutating
config" and left it there. That works for three rows and **cannot** work for
`maxPerRun`, which is the one row DH-6 and RH-5 lean on when they reverse D-15.

**Mechanism A — a config view, for the three policy rows.** `Compactor` reads
policy through `deps.getConfig()`. The child factory supplies a wrapper that
returns the live config with only the `compaction` section overlaid:

```ts
const childConfig = (): CliConfig => {
  const base = deps.getConfig();
  return {
    ...base,
    compaction: {
      ...base.compaction,
      keepRecentTurns: COMPACTION_LIMITS.childKeepRecentTurns,
      onFailure: 'truncate',
      useFastTier: true,
    },
  };
};
```

It must **re-read `deps.getConfig()` on every call**, never close over one
snapshot: a settings-screen edit mid-dispatch has to reach a running child, which
is the same reason `subagent.ts:337` reuses the lead's `getApiKey` closure rather
than the resolved key. `useFastTier: true` is still subject to the fast tier
actually resolving — the overlay expresses a preference, `resolveSummarizer`
decides, and when nothing resolves the child falls back exactly as the lead does.

**Mechanism B — an instance bound, for `maxPerRun`.** `maxPerRun: 5` is **not**
config. It lives in `COMPACTION_LIMITS` (`limits.ts:72`) and is read as
`COMPACTION_LIMITS.maxPerRun` directly by guard 2 (`compactor.ts:190`), and
`limits.ts:12-20` is explicit that these entries are structural and deliberately
not user-tunable. There is no config view that reaches it. So `Compactor` gains
one optional constructor field:

```ts
/**
 * Guard 2's ceiling for THIS compactor.
 *
 * A FIELD RATHER THAN A DIRECT `COMPACTION_LIMITS` READ, because a child gets a
 * tighter one (W3 / DH-6) and `maxPerRun` is STRUCTURAL, not policy - there is
 * no config path to it by design (`limits.ts:12-20`). Defaults to the lead's
 * value, so every existing construction site is unchanged.
 */
private readonly maxPerRun: number;
// constructor: this.maxPerRun = opts?.maxPerRun ?? COMPACTION_LIMITS.maxPerRun;
```

and guard 2 becomes `if (this.compactionsThisRun >= this.maxPerRun) return false;`.
`COMPACTION_LIMITS.childMaxPerRun` (§4.2) is where the child's `2` lives, so both
numbers stay in the one file that owns structural bounds.

**Why this matters rather than being tidy-up:** without mechanism B the child
inherits **5**, and the cost argument that justifies reversing a recorded
decision is quietly 2.5× wrong. AC-H11 is therefore extended to assert the bound
directly (a child offered a sixth compaction is refused at the third), because
"the overlay was applied" and "the overlay took effect" are different claims and
only the second one is worth anything here.

#### 3.4.3 Wiring

Four edits, all conditional spreads or forwarders:

1. `SubagentDeps` gains
   `contextManagerFor?: (label: string, getMessages: () => readonly Message[], getSystemPrompt: () => string) => ContextManager`.
2. The system prompt is **hoisted to a local** immediately above the factory
   call. Today `subagent.ts:316-330` builds it **inline** inside the
   `deps.agentFactory({ … })` argument, so there is nothing for an accessor to
   close over:
   ```ts
   const systemPrompt = buildSystemPrompt({ /* …exactly as today… */ });
   const manager = deps.contextManagerFor?.(
     spec.label,
     () => agentRef?.state.messages ?? [],
     () => systemPrompt,
   );
   const agent = deps.agentFactory({
     systemPrompt,
     // …
     ...(manager ? { contextManager: manager } : {}),
   });
   ```
3. **`agentRef` is assigned at `:350`, after the factory call**, so the message
   accessor must be a lazy closure — the same constraint
   `CompactionWiringDeps.getMessages` already documents. A non-lazy read here is
   `undefined` at construction and the child's estimate branch silently measures
   an empty history, which is CR-1 reproduced one module over.
4. `TeamRuntime` passes `contextManagerFor` through from the controller, which
   builds it from `this.compaction?.childFactory()`. When compaction is
   unregistered or `compaction.subagents` is false, the dep is absent and
   `subagent.ts` spreads nothing — byte-identical to today.

##### How the child reads its history (RV-1)

v1 of this section said `AgentController` "reaches it through
`this.agent.getMessages()`; the same method exists on `Agent` and is already
public". **Both halves are false, and the design does not compile on them.**

- `Agent` (core) has **no** `getMessages()`. It exposes `get state(): AgentState`
  (`agent.ts:200`), and the wiring is fed from
  `this.agent.state.messages` / `this.agent.state.systemPrompt`
  (`controller.ts:574-575`).
- `controller.ts:1392`'s `getMessages()` is **`AgentController`'s own** method —
  a one-line forwarder whose body is `this.agent.state.messages`. v1 read the
  controller's API as the engine's.

The repair must not be "add `getMessages()` to core's `Agent`": §4.1 freezes the
core surface at one new export (`relieveTail`), and adding a method to the engine
to serve a host-side convenience is the §1.2 boundary violation this round is
otherwise careful about. So the accessor is a **property read**, and
`SubagentAgentLike` (`subagent.ts:52-56`) gains the narrowest possible member:

```ts
export interface SubagentAgentLike extends WatchdogPausable {
  prompt(text: string): Promise<void>;
  abort(): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /**
   * NARROWED ON PURPOSE - `Agent` satisfies it with its full `AgentState`
   * getter, and a stub satisfies it with `{ messages: [] }`. Widening this to
   * `AgentState` would make every test stub fabricate a systemPrompt, a model
   * and a phase to compile, for a field none of them use (W3 / RV-1).
   */
  readonly state: { readonly messages: readonly Message[] };
}
```

**And it is not four stubs, it is eight** (IF-7's lesson, applied to itself —
count before claiming). Every `agentFactory` in the CLI test tree must satisfy
the new member:

| File | Site(s) |
|---|---|
| `__tests__/exec-child-permission.test.ts` | `:48` (already an `as unknown as` cast — unaffected, but confirm) |
| `__tests__/fast-task-tier.test.ts` | `:177`, `:220` via the shared `stubAgent` helper |
| `__tests__/retry-team.test.tsx` | `:118`, `:151` via `class RetryingAgent` |
| `__tests__/team-activity.test.ts` | `:239` |
| `__tests__/team-retry.test.ts` | `:183` |
| `__tests__/team-runtime.test.ts` | `:182`, `:379` (stub class documented at `:92`) |
| `__tests__/team-tool-gate.test.ts` | `:100` |
| `__tests__/todo-session.test.ts` | `:289` |

Most gain the literal `state: { messages: [] }`. The two that drive real
histories (`team-runtime`, `fast-task-tier`) return the array they already
track, which is what makes test 26's laziness assertion meaningful rather than
tautological.

#### 3.4.4 What the user sees

- `SubagentRun.compactions?: number`, incremented by `onCompacted`.
- The team panel row appends `compacted N` next to the existing `mail N` cluster
  when `compactions > 0`.
- The dispatch report line gains `, compacted twice` in the same position
  `truncated` uses today.
- **No transcript card.** A child's compaction is an implementation detail of a
  tool call; a card in the lead's transcript would claim the lead's own context
  had been compacted. Recorded as DH-7.

---

### 3.5 W4 — a compaction stops being irreversible

#### 3.5.1 The property

Round 1's §1.3 states the non-goal plainly: "the dropped messages are gone".
Combined with R-1 — "the summary is wrong or lossy, and the agent proceeds
confidently on a false record... this is the feature's defining risk and it
cannot be eliminated" — the product currently asks the user to accept an
unverifiable, unrecoverable transformation of their session. That is the wrong
default for a tool that runs unattended.

W4 does not add undo (§12: restoring an over-full history re-creates the
condition that triggered compaction). It adds **fidelity on disk**: before the
splice is adopted, the dropped messages are written verbatim to a pruned
archive, and `/compact history` tells the user where.

#### 3.5.2 Location and format

`<home>/compaction/` — its own root, **not** inside `sessions/` (E-14).
`getCompactionArchiveDir()` joins `app-paths.ts` next to `getSessionsDir()`.

##### The name carries a run id, because the directory is shared (RV-6)

v1 named files `compaction-<YYYY-MM-DD>-<hhmmss>-<index>.json`, where `index` is
"1-based **within the session**", and then specified both new verbs against
"**the session's** archives". One global directory plus a per-session counter
does not support that, and the tree already knows why: `file-sink.ts:94-95`
makes retention best-effort precisely because "on Windows another `aragon`
process may hold a handle on a file we would like to remove" (E-20).
**Concurrent CLI processes are an acknowledged condition, not an edge case** —
two terminals, or a TUI alongside an `aragon exec`. Left as v1 had it:
`/compact history` presents another session's compactions as this one's,
`/compact show 2` is ambiguous whenever two runs both reached their second
compaction, and one global 20-file mtime prune deletes a live session's archives
out from under it while it is still running.

There is no ambient session id on the TUI path to key this on —
`SessionMeta.id` (`session/persist.ts:29`) is written into a saved file, and a
session that is never `/save`d never has one. So the archive mints its own, once
per process, in `CompactionWiring`'s constructor:

```ts
/**
 * Identifies THIS RUN's archives in a directory several runs share (RV-6).
 *
 * NOT `SessionMeta.id`: that exists only once a session has been saved, and the
 * unattended long run this feature serves is exactly the one nobody saved.
 * Short, filename-safe, and only ever compared for equality - it is a grouping
 * key, not an identity.
 */
private readonly runId = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
```

One file per applied compaction:
`compaction-<YYYY-MM-DD>-<hhmmss>-<runId>-<index>.json`

with `runId` also stored **inside** the document, so a file renamed or copied by
hand is still self-describing and the reader never has to parse the name for
meaning it cannot verify.

Retention becomes two-tier, and the order matters:

1. **Within this run:** keep the newest `archiveMaxFiles` files carrying
   *this* `runId`. This is the bound that protects the user from their own long
   session, and it can never touch another run.
2. **Across runs:** delete files older than `archiveMaxAgeMs` (7 days)
   **regardless of `runId`**, so an abandoned run's archives do not accumulate
   forever. Age, not count, because a count-based global prune is exactly the
   rule that deletes a live session's work.

Both passes are wrapped the way `enforceRetention` is (E-15): every `rmSync` in
its own `try`, a locked file is skipped rather than fatal.

```jsonc
{
  "version": 1,
  "blockVersion": "v1-2026-08",     // COMPACTION_BLOCK_VERSION at write time
  "createdAt": 1786983926844,
  "runId": "1f3k9x2b",               // this process's archives (RV-6)
  "index": 2,                        // 1-based within this run
  "trigger": "pressure",             // pressure | overflow | manual
  "mode": "summarized",              // summarized | truncated | relieved
  "model": "claude-haiku-4-5",
  "generation": 2,
  "tokensBefore": 118400,
  "tokensAfter": 23100,
  "messagesBefore": 112,
  "messagesAfter": 9,
  "droppedCount": 103,               // the NUMBER (mirrors CompactionRecord)
  "summary": "…the block body as spliced…",
  "tailRelief": { "messages": 3, "charsRemoved": 214003 },
  "clipped": false,                  // true when `dropped` was shortened
  "dropped": [ /* verbatim Message objects, oldest first */ ]
}
```

##### The array does not exist yet, and it must not travel on the record (RV-3)

v1 called this field `droppedMessages` and said §3.5.3's writer receives it "as a
reference from the compactor's record". Neither holds:

- **`droppedMessages` is a `number` at every layer that carries it** —
  `CompactionPlan.droppedMessages` (`compaction.ts:24`, `:118`), the
  `applied: { droppedMessages: number }` argument to `finish`
  (`compactor.ts:577`, `:608`), and `AgentEvent.compaction_end.droppedMessages`
  (`types.ts:101`). Reusing that exact key for an array of `Message` in the one
  document a support engineer reads under pressure is a trap for no benefit, so
  the archive's count is `droppedCount` and its array is `dropped`.
- **`CompactionRecord` does not carry the messages** (`types.ts:70-88`), and §5.2
  proposed adding only `tailRelief?` and `archivePath?`. The messages exist only
  as `before.slice(protectedPrefix, plan.cutIndex)` inside `runCompaction`'s
  local scope (`compactor.ts:315`), which has returned long before
  `settlePending` runs.
- **They must not be added to `CompactionRecord` either.** That record is
  dispatched into the reducer (`App.tsx:858` → `compactionEnd`) and retained in
  view state for the transcript card's lifetime. Hanging a megabyte-scale
  `Message[]` off it would put the dropped history into React state and drag it
  through every subsequent render — the opposite of what compaction is for.

So the messages travel on a **side channel that never enters the event stream**.
`Compactor` stashes them at the moment it has them and hands them over exactly
once:

```ts
/**
 * The messages the last splice dropped, held ONLY until the wiring collects
 * them for the archive (W4 / RV-3).
 *
 * NOT ON `CompactionRecord`: that record is dispatched into the reducer and
 * retained in view state for the card's lifetime (`App.tsx:858`), so putting a
 * megabyte of history on it would park the dropped conversation in React state
 * - precisely the memory this compaction just reclaimed.
 *
 * `take` rather than `get`: the reference is released on read, so a wiring that
 * declines to archive (key off, or `applied: false`) cannot pin it, and a second
 * read cannot double-write.
 */
private lastDropped: Message[] | null = null;
takeLastDropped(): Message[] | null { … }   // returns and nulls
```

`runCompaction` sets it from the same `head` slice it already computes, only when
archiving is enabled (`getConfig().compaction.archive`), so with the key off the
slice is never retained and W4 costs nothing. `settlePending` calls
`takeLastDropped()` on the `applied: true` path and passes the array straight to
`archive.write(...)`; on every other path it calls it too, and discards — that is
what guarantees the reference cannot outlive one compaction regardless of which
branch the verdict took.

Bounds, all in `COMPACTION_LIMITS`:

- `archiveMaxFiles: 20` — newest-first **within this run's `runId`** (RV-6),
  with the `enforceRetention` shape (E-15) reimplemented locally against this
  prefix.
- `archiveMaxAgeMs: 604_800_000` (7 days) — the cross-run sweep.
- `archiveMaxBytes: 8_000_000` — if the serialized document exceeds it, dropped
  message bodies are clipped from the **oldest** end (they are the least likely
  to be wanted) with `"clipped": true` recorded. The metadata and the summary are
  never clipped: a truncated archive that still says what happened beats none.

#### 3.5.3 Timing and failure posture

Written from `CompactionWiring.settlePending`, **only** when
`verdict.applied === true`. The rule the writer is enforcing is *"never archive a
history that is still live"*, and it is worth stating per path rather than in one
sentence, because **the two paths reach `applied: true` at different moments
relative to the splice (RV-7)**:

| Path | Who decides `applied` | Splice adopted | Archive written |
|---|---|---|---|
| In-loop (`pressure` / `overflow`) | the **engine**, after `validateHistory` | inside the engine, before it emits `compaction_end` | on that event → **after** adoption |
| Manual (`/compact` while idle) | the **wiring**, after running `validateHistory` itself (`wiring.ts:299-310`) | by the caller, at `controller.ts:1613`, *after* `compactNow` returns | at `wiring.ts:306` → **before** adoption |

v1 asserted the in-loop ordering for both. On the manual path the archive is
written while `compactNow`'s return value is still in flight, and the only thing
that makes it correct is that its sole caller applies the messages
unconditionally on the next statement.

That is a fact about one call site, not an invariant, so it is written down where
it can be checked rather than left to be rediscovered: `compactNow`'s doc comment
gains **"its caller MUST adopt `messages` — the archive is already written by the
time this returns"**, and AC-H13 is extended to pin the manual path specifically.
The alternative — deferring the write until the caller confirms — buys nothing
real (the caller is one line away and cannot fail) and costs the property that
makes W4 simple: one writer, one trigger, one place to look.

- `void archive.write(...)` — fire and forget. The compaction path must not wait
  on a filesystem, and `settlePending` runs inside an event handler.
- Every error is caught and logged at `warn` with the path. **A failed archive
  never affects the compaction**, and it never notifies: a toast for a
  best-effort audit file trains users to ignore toasts.
- The dropped-message array reaches the writer through `Compactor.takeLastDropped()`
  (§3.5.2), which **releases the reference as it returns it**. Once the engine has
  adopted the splice, that array and the in-flight write are the only things
  holding the dropped history, so it lives exactly until the write resolves — one
  compaction's worth of already-allocated objects, bounded by `maxPerRun`.
  `settlePending` calls `takeLastDropped()` on **every** verdict and discards on
  the ones that do not archive, so no branch can leave it pinned.

#### 3.5.4 Reading it back

`/compact history` — **this run's** archives, newest first. The listing filters
on `runId` (RV-6), so a second `aragon` running in another terminal is invisible
here rather than interleaved with this one's:

```
compaction history (3 archives, ~/.aragon/compaction)

  #3  12:41:07   overflow   118.4k -> 23.1k   103 messages   compaction-2026-08-17-124107-1f3k9x2b-3.json
  #2  12:22:55   pressure    96.2k -> 19.8k    71 messages   compaction-2026-08-17-122255-1f3k9x2b-2.json
  #1  11:58:10   pressure    88.0k -> 21.4k    64 messages   compaction-2026-08-17-115810-1f3k9x2b-1.json
```

When the directory holds archives from other runs, one muted trailing line says
so without listing them, because the alternative is a user concluding their own
compactions went missing:

```
  (4 more archives from earlier runs in this directory)
```

`/compact show <n>` — metadata plus the stored summary plus the archive path.

**`<n>` is the compaction index within this run** — the `#n` printed by
`/compact history`, which is also the `index` field in the document (RV-11).
Those are the same number by construction: the listing is `runId`-scoped and
`index` is unique within a run, so there is no second numbering to confuse it
with. An `n` that matches nothing gets `No archive #n. Try /compact history.`

**It never prints message bodies.** A single archive can be megabytes; the
transcript is not a pager, and the path is one click from being one. Recorded as
DH-9.

---

### 3.6 W5 — the long moment is legible

Three additions to the live card only (`CompactionCard.tsx`), none to the
activity row — that row's "one row, no digits, no `esc abort`, no width ladder"
rule was legislated a feature earlier and is not this change's to reopen (DH-10).

1. **Elapsed.** `CompactionCardProps.elapsedMs?: number`, rendered as
   `formatDuration(elapsedMs)` in the position `durationMs` occupies once
   settled, so the number does not move when the card settles. Fed from the same
   one-second tick that already drives `ActivityLine`'s elapsed figure; only the
   single `live` card receives it, so exactly one memoized card re-renders per
   second (`App.tsx` already re-renders the activity row at that rate).
2. **The cancel affordance.** The live detail line becomes
   `summarizing with <model> - esc to cancel`, and `- esc to cancel` is omitted
   when `model === ''` for the same reason the separator is (CR-7). This is
   truthful today (E-10) and unstated today.
3. **Relief disclosure.** When `tailRelief` is present the settled card gains a
   third line, in `theme.noticeWarn` like `truncated`:
   `clipped 3 tool results in the retained turns (214.0k characters) - the recent turns alone exceeded the window`.
   A bounded, announced data loss the user is entitled to notice, in the same
   voice §6.4's honesty rules use for `truncated`.

Nothing here changes the settled card's existing headline, which is what the
round-1 render tests assert.

---

### 3.7 W6 — six of the seven ★ rows become CI

#### 3.7.1 What is not covered today

`core/src/__tests__/compaction-loop.test.ts` drives the **engine** against a
scripted provider and covers the seam thoroughly (18 cases: the gate, the copy,
the ceiling, the watchdog, the reactive path, malformed outcomes). What no test
drives is the **CLI's compaction stack against a provider**: every CLI test
injects `complete` directly, so `summarize-call.ts`, the registry, the retry
policy, the digest → prompt → response → splice chain and the event stream to
the reducer have never been exercised together. Manual rows 1, 2, 3, 5, 10, 11
(★) are the only coverage those paths have, and none has been run.

#### 3.7.2 The harness

`packages/cli/src/__tests__/helpers/scripted-provider.ts` — an `LLMProvider`
(E-16) built from a script:

```ts
export type ScriptStep =
  | { kind: 'assistant'; text?: string; toolCalls?: { name: string; args: unknown }[];
      usage: TokenUsage }
  | { kind: 'overflow' }            // throws { errorType: 'context_overflow' }
  | { kind: 'error'; errorType: string }
  | { kind: 'summary'; text: string };   // served to the summarizer call

export function scriptedProvider(id: string, steps: ScriptStep[]): LLMProvider;
```

It implements `stream()` and `complete()` — `complete()` is the one the
summarizer uses (`wiring.ts:162`), `stream()` the one the loop uses — and
records every request it received, so a test can assert **what was actually
sent** after a compaction, which is the assertion the manual rows exist to make.

One production seam is required, and only one:

```ts
export interface CompactionWiringDeps {
  // …
  /** Defaults to `initProviders`. Overridden only by tests (§8.2). */
  createRegistry?: (options: ProviderRegistryOptions) => ProviderRegistry;
}
```

`getRegistry()` becomes `(this.deps.createRegistry ?? initProviders)({ retryPolicy: … })`.
Everything else the harness needs is already public: `ProviderRegistry.register`
overwrites by id (E-16), `AgentController.getProviderRegistry()` exposes the
lead's (E-13), and `Agent` accepts a `providerRegistry` in its config.

#### 3.7.3 The six rows, converted

| Manual row | Automated as | The assertion that matters |
|---|---|---|
| 1 — small-window headroom co-trigger | `compaction-e2e.test.ts::triggers on headroom, not ratio, on a 32k window` | Compaction fires at 71 % because `headroom < requiredHeadroom`. |
| 2 — resume pressure, estimate path | `…::a resumed 180k history compacts on turn 1 with no lastUsage` | The CR-1 regression, now end to end. |
| 3 — wrong-window recovery | `…::a provider that overflows once completes after one compaction and one re-send` | Two `stream()` calls, the second carrying the compacted history. |
| 5 — failure ladder | `…::fast fails, main retries, truncation is announced` | Three provider calls in order; `mode: 'truncated'`; the notify text. |
| 10 — two compactions in one session | `…::the second compaction carries the first block forward whole` | The digest handed to the summarizer contains the prior block verbatim (D-22), and `generation` is 2. |
| 11 — reactive path, transcript | `compaction-render.test.tsx::…` (extended) | The card sequence live → settled with `trigger: 'overflow'`. |

Row 9 (persisted OFF, no flags) stays manual: it is about process launch and
`config.json` on a real machine, which is what a manual row is for.

---

### 3.8 Logging delta

Three new structured events on the existing `compaction` child logger:

| Event | Fields | Why |
|---|---|---|
| `compaction_pressure_delta` | `base`, `delta`, `messages`, `ratio` | The single number a support thread needs to tell "the trigger is late" from "the window is wrong". Logged at `debug`, once per checkpoint that computes a non-zero delta. |
| `compaction_tail_relief` | `clippedMessages`, `charsRemoved`, `projectedBefore`, `budget` | W2 fires rarely; when it does, it is the most interesting event in the session. `info`. |
| `compaction_archive_failed` | `path`, `error` | `warn`. The only trace a silent best-effort write leaves. |

`compaction_child` (`label`, `index`, `tokensBefore`, `tokensAfter`) is logged
by the child manager at `info`, since W3 has no UI card.

---

## 4. Interface design

### 4.1 Core API delta

| Name | Kind | Change |
|---|---|---|
| `relieveTail` | runtime export | **new**, from `engine/compaction.ts` |
| `TailReliefOptions`, `TailReliefResult` | type exports | **new** |
| `AgentEvent` → `compaction_end.tailRelief?` | type | **additive optional field** |

Runtime exports go 85 → 86. The three-sync discipline (C-6) applies: `index.ts`,
`__tests__/public-api.test.ts`, `API.md`, `CHANGELOG.md`. `logging/install.ts`'s
union must stay a superset of core's (IF-3).

No change to `ContextManager`, `CompactionProbe`, `CompactionContext` or
`CompactionOutcome`. The port shape is frozen (DH-5).

### 4.2 Config keys — `config.json`, section `compaction`

Two additions to the existing nine-section schema. Both clamp through
`clampCompactionConfig` and both appear in `config set`, the env table and the
settings screen — the eight-place discipline IF-8 records.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `compaction.subagents` | boolean | `true` | Give `task` children their own compaction (W3). `false` reproduces round 1 exactly. |
| `compaction.archive` | boolean | `true` | Write the dropped messages to `<home>/compaction/` before adopting a splice (W4). |

`COMPACTION_LIMITS` additions (structural, not user-facing):

| Constant | Value | Meaning |
|---|---|---|
| `tailToolResultChars` | `2_000` | Clip bound for an oversized `tool_result` in the retained tail. |
| `blockAllowanceTokens` | `2_000` | Room reserved for the `<compacted_context>` block in the tail-budget projection. |
| `archiveMaxFiles` | `20` | Retention **within one `runId`** (RV-6). |
| `archiveMaxAgeMs` | `604_800_000` | Cross-run sweep, 7 days. Age rather than count, so a live run's archives are never pruned by another run (RV-6). |
| `archiveMaxBytes` | `8_000_000` | Per-file ceiling before dropped bodies are clipped. |
| `childKeepRecentTurns` | `2` | W3 overlay, delivered through the child's config view (§3.4.2 mechanism A). |
| `childMaxPerRun` | `2` | W3 overlay, delivered through `Compactor`'s instance bound (§3.4.2 mechanism B) — **there is no config path to `maxPerRun`, by design** (RV-2). |

These are all **structural** entries and belong here for the reason
`limits.ts:12-20` gives: they describe what the mechanism can physically carry,
and a user has no business tuning them. The two new `config.json` keys above are
policy. Keeping `childMaxPerRun` here rather than inventing
`compaction.childMaxPerRun` preserves that split.

### 4.3 CLI flags and environment

No new flags. Two new env vars, following the three that exist:

| Var | Effect |
|---|---|
| `ARAGON_COMPACTION_SUBAGENTS` | `0`/`false` disables W3 for the process. |
| `ARAGON_COMPACTION_ARCHIVE` | `0`/`false` disables W4 for the process. |

Both follow `config/env.ts`'s existing boolean parsing and precedence: flag >
env > `config.json` > default.

### 4.4 Slash command `/compact`

```
Usage: /compact [status | on | off | threshold <n> | keep <n> | history | show <n> | <instructions>]
```

Two new verbs, inserted before the free-text fall-through so a user cannot
accidentally summarize with the word "history":

- `/compact history` — §3.5.4's table. With no archives:
  `No compaction archives for this session. (compaction.archive is off)` when
  disabled, `No compactions have been archived yet.` when enabled.
- `/compact show <n>` — metadata + summary + path for archive `n`; on a bad
  index, `No archive #n. Try /compact history.`

`formatCompactionStatus` gains two lines when they apply:

```
  tail relief    3 tool results clipped (214.0k chars) in 1 compaction
  archive        3 files in ~/.aragon/compaction
```

### 4.5 `aragon exec` JSON stream and headless

The existing `compaction` event gains the optional `tailRelief` object. Headless
stderr gains one line, only when relief fired:

```
[compaction] clipped 3 tool results in the retained turns (214.0k chars)
```

D-18 stands: the summary is still not on the JSON stream.

### 4.6 Settings screen

The compaction section gains two toggles (`subagents`, `archive`) in the shape
the six existing rows use. No new screen, no new navigation.

---

## 5. Data model

### 5.1 `Pressure` (`cli/src/compaction/types.ts`)

```ts
export interface Pressure {
  occupied: number;          // base + deltaTokens, or estimate + estimateOffset
  contextWindow: number;
  ratio: number;
  headroom: number;
  source: PressureSource;    // WHERE THE BASE CAME FROM — unchanged semantics
  windowKnown: boolean;
  estimateOffset?: number;
  /**
   * NEW (W1). Tokens estimated for messages appended after the measurement in
   * `lastUsage`. `0` on the estimate branch and whenever the recorded prefix is
   * unusable. `> 0` is what makes `isApproximate` true on the measured branch.
   */
  deltaTokens: number;
}
```

`source` deliberately keeps two members. It answers "where did the base come
from", and adding a `'usage+delta'` member would force every existing consumer
of the union to be revisited for a distinction they do not act on — the `~`
question is answered by `isApproximate`, which is one exported function with one
test.

### 5.2 `CompactionRecord`

```ts
  /** NEW (W2). Present only when relief fired. */
  tailRelief?: { messages: number; charsRemoved: number };
  /** NEW (W4). Path written, for `/compact show`. Absent when archiving is off. */
  archivePath?: string;
```

`CompactionMode` gains a fourth member (RV-5):

```ts
export type CompactionMode = 'summarized' | 'truncated' | 'relieved' | 'none';
```

`'relieved'` means **the tail was clipped and nothing was dropped** — the
`plan === null` recovery of §3.3.3. It exists only on the CLI's record; the port
still reports `'truncated'` for it (DH-5), which is the engine-side word for
"reduced without a summary" and is accurate.

**What deliberately does NOT go on this record (RV-3):** the dropped `Message[]`.
This object is dispatched into the reducer (`App.tsx:858`) and lives in view state
for the card's lifetime, so an archive-sized array here would park the compacted
history in React. The messages travel on `Compactor.takeLastDropped()` instead
(§3.5.2), which never enters the event stream.

### 5.3 Archive document

`CompactionArchive` in `compaction/archive.ts`, exactly §3.5.2's JSON, with a
`version: 1` discriminator so a future format change is detectable rather than a
parse crash. The reader tolerates unknown fields and rejects `version !== 1`
with a one-line notice.

Two field names are load-bearing and were corrected in review (RV-3):
`droppedCount` is the number, `dropped` is the array. **Neither is called
`droppedMessages`**, because that name already means *a count* in three typed
places (`CompactionPlan`, `finish`'s `applied` argument, and
`AgentEvent.compaction_end`) and the archive is the document someone reads while
diagnosing a bad summary.

### 5.4 `SubagentRun` (`cli/src/team/types.ts`)

```ts
  /** NEW (W3). Compactions this child performed on its own history. */
  compactions?: number;
```

Optional, so every existing construction site and fixture compiles unchanged.

---

## 6. UI design

### 6.1 The live card

```
compact  ⠹ compacting context #2  ·  claude-haiku-4-5  ·  12s
 summarizing with claude-haiku-4-5 - esc to cancel
```

### 6.2 A settled card that relieved the tail

```
compact  context compacted  ·  112 → 9 messages  ·  118.4k → 23.1k tokens  ·  9.4s
 summarized 103 messages with claude-haiku-4-5
 clipped 3 tool results in the retained turns (214.0k characters) - the recent
 turns alone exceeded the window
 │ Task: migrate the auth module to the new session store …
 └ +14 more lines (ctrl+o to expand)
```

### 6.2a A settled card that could only relieve (RV-5)

The `plan === null` recovery: nothing could be dropped, so nothing was
summarized, and the card must not claim otherwise.

```
compact  context compacted  ·  112 → 112 messages  ·  118.4k → 95.2k tokens  ·  0.3s
 clipped 3 tool results in the retained turns - nothing could be dropped
```

No model is named, because no model was called; no duration is claimed beyond the
clip itself. This is `mode: 'relieved'`, and it is the branch that would
otherwise have rendered `summarized 0 messages with claude-haiku-4-5`.

### 6.3 Honesty rules (delta to §6.4)

Round 1's four rules stand. Two are added:

- **The `~` means "part of this number is a guess", and `isApproximate` is the
  only thing that decides it.** With W1 the gauge is a measured base plus an
  estimated tail for most of a turn, and pretending otherwise would be the same
  lie `estimateOffset` was introduced to stop telling.
- **A clip is stated where it happened and where it is summarized.** Inside the
  history (the marker the model reads), on the card, in `/compact status`, on the
  JSON stream and in the archive. A bounded loss the user is not told about is an
  unbounded loss as far as their trust is concerned.

### 6.4 The team panel

```
  researcher   thinking   6 turns   14 tools   mail 2   compacted 1
```

---

## 7. File / module change plan

### New files

**Both new `compaction/` files are inside the ASCII-only scanner (RV-8).**
`glyphs.test.ts::inScope` (`:217`) hardcodes `compaction/` into its directory
list, and `limits.ts:5-10` records that no literal in that tree may hold a
non-ASCII byte. That covers the tail-clip marker, every `/compact history` and
`/compact show` string, and the archive's own field names. Failure is loud (the
glyph test goes red), but it is a late and confusing red if nobody wrote it down.

| Path | Intent |
|---|---|
| `packages/cli/src/compaction/archive.ts` | Write / list / read / prune the compaction archive (W4). No imports from `ui/`. ASCII only. |
| `packages/cli/src/compaction/child.ts` | `createChildContextManager` — the per-child policy overlay (W3), i.e. §3.4.2's config view (mechanism A) plus the `maxPerRun` instance bound (mechanism B). ASCII only. |
| `packages/cli/src/compaction/tail-budget.ts` | The tail-relief projection, split out per §7's pre-made decision below (`compactor.ts` reached 973 lines against the 1 000-line cap). `tailBudgetTokens` + `attemptTailRelief` + `reliefSummary`. ASCII only. |
| `packages/cli/src/__tests__/helpers/scripted-provider.ts` | An `LLMProvider` built from a step script, with request capture (W6). |
| `packages/cli/src/__tests__/compaction-e2e.test.ts` | The six converted ★ rows (W6). |
| `packages/cli/src/__tests__/compaction-tail-relief.test.ts` | W2, host side. |
| `packages/cli/src/__tests__/compaction-archive.test.ts` | W4, including the byte cap and retention. |
| `packages/cli/src/__tests__/compaction-child.test.ts` | W3, with a stub subagent factory. |
| `packages/core/src/__tests__/tail-relief.test.ts` | `relieveTail` as a pure function, incl. a property test against `validateHistory`. |
| `docs/plans/context-auto-compaction-hardening/manual-test.md` | The rows that stay manual (row 9 + the two new toggles), authored with the implementation. |

### Modified files

| Path | Change |
|---|---|
| `packages/core/src/engine/compaction.ts` | `relieveTail` + two interfaces. No change to the three existing functions. |
| `packages/core/src/types.ts` | `compaction_end.tailRelief?`. |
| `packages/core/src/index.ts` | Export `relieveTail` and its two types (85 → 86 runtime). |
| `packages/core/API.md`, `CHANGELOG.md` | Three-sync (C-6). |
| `packages/core/src/__tests__/public-api.test.ts` | The export count and name list. |
| `packages/cli/src/compaction/pressure.ts` | `estimateAppendedTokens`, `isApproximate`, `measuredPrefixLength` in `PressureInput`, `deltaTokens` in the result. |
| `packages/cli/src/compaction/compactor.ts` | `measuredPrefixLength` field + `invalidateMeasurement`; `onTurnEnd` records it; `measure` forwards it; **the measurement moves above the guards and `deps.onPressure` reports it unconditionally (RV-4)**; **`maxPerRun` becomes an instance field read by guard 2 (RV-2)**; **`lastDropped` + `takeLastDropped()` (RV-3)**; `mode: 'relieved'` on the relief-only branch (RV-5); tail-relief projection in `runCompaction` and in the `plan === null` branch; `tailBudgetTokens`. The stale cost comment at `:219-220` is corrected (RV-10). |
| `packages/cli/src/compaction/wiring.ts` | `onHistoryReplaced`; `createRegistry` dep; `snapshotWith`; `runId`; archive hand-off in `settlePending` via `takeLastDropped()`; `childFactory()`; `compactNow`'s doc comment gains the caller obligation (RV-7). |
| `packages/cli/src/compaction/types.ts` | §5.1 / §5.2, including `CompactionMode`'s fourth member (RV-5). |
| `packages/cli/src/compaction/limits.ts` | Seven constants (§4.2). |
| `packages/cli/src/ui/entries/CompactionCard.tsx` | Also: the `'relieved'` branch in `detailLine`, ahead of `'truncated'` (RV-5). |
| `packages/cli/src/team/subagent.ts` | Also: hoist `systemPrompt` to a local above the factory call, and widen `SubagentAgentLike` with `readonly state: { readonly messages: readonly Message[] }` (RV-1). |
| 8 CLI test files with `agentFactory` stubs | Satisfy the widened `SubagentAgentLike` — the table in §3.4.3 lists them (RV-1). |
| `packages/cli/src/compaction/command.ts` | `history` and `show` verbs; two status lines; `USAGE`. |
| `packages/cli/src/agent/controller.ts` | `onHistoryReplaced()` at `clearMessages` and `replaceMessages`; `childFactory` plumbed into `TeamRuntime`. |
| `packages/cli/src/agent/reducer.ts` | Nothing new — `contextTokensEstimated` is reused (E-12). Listed so a reader does not go looking. |
| `packages/cli/src/ui/App.tsx` | Snapshot → `contextTokensEstimated` when `isApproximate`; one-second elapsed into the live card. |
| `packages/cli/src/ui/entries/CompactionCard.tsx` | Elapsed, cancel hint, relief line. |
| `packages/cli/src/team/{subagent,runtime,types}.ts` | §3.4.3. |
| `packages/cli/src/config/{schema,store,env,load,cli-commands}.ts` | Two keys, five files (IF-8). |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | Two toggles. |
| `packages/cli/src/exec/events.ts`, `exec/runner.ts`, `agent/headless.ts` | `tailRelief` on the JSON event and one stderr line. |
| `packages/cli/src/config/app-paths.ts` | `getCompactionArchiveDir()`. |
| `packages/cli/README.md`, `packages/cli/CHANGELOG.md` | The two keys, the two verbs, what a clip means. |

**No file crosses 1 000 lines as a result.** `compactor.ts` is the largest
mover: 743 → ~830. `wiring.ts` 501 → ~580. If `compactor.ts` approaches the
guideline during implementation, the tail-relief projection block (~40 lines)
moves to `compaction/tail-budget.ts` — noted here so the decision is not
improvised.

**Implementation note.** It did approach it: `compactor.ts` reached **973** of
1 000 before the split, so the escape hatch above was taken exactly as written.
After it: `compactor.ts` 927, `wiring.ts` 649, `tail-budget.ts` 94.

---

## 8. Testing & acceptance criteria

### 8.1 Unit tests

**`core/src/__tests__/tail-relief.test.ts`**

1. Clips a `tool_result` string body and appends the host's marker.
2. Clips text parts of a part-array body, longest first; leaves `image` parts.
3. Never touches `user` or `assistant` messages, even when they are the largest.
4. Walks oldest-first and stops as soon as the target is met (the newest tool
   result survives when relief of one older message is enough).
5. **Property test:** for 200 generated histories, `validateHistory(relieveTail(h, …).messages)` is `ok` whenever `validateHistory(h)` is — structure is invariant under relief.
6. `from` is respected: nothing before it changes, by identity (`toBe`).
7. A history with no eligible message returns `charsRemoved: 0` and the same array contents.

**`cli/src/__tests__/compaction-pressure.test.ts` (extended)**

8. `estimateAppendedTokens` returns 0 for `undefined`, 0 when the prefix is at or past the end, and the slice estimate otherwise.
9. The `+1` skip: a history whose only appended message is the assistant turn yields `deltaTokens === 0`.
10. The measured branch with three appended tool results yields `occupied === base + estimate(those three)` — **and the offset is not applied** (asserted against a fixture with a non-zero `estimateOffset`).
11. `isApproximate` is true for the estimate branch, true for `deltaTokens > 0`, false otherwise.
12. Out-of-range prefix (history shorter than the recorded prefix) degrades to `deltaTokens: 0` rather than throwing or going negative.

**`cli/src/__tests__/compaction-compactor.test.ts` (extended)**

13. `onTurnEnd` records `messages.length`; `invalidateMeasurement` clears it.
14. **The regression for §3.2.1:** a history at 76 % measured with 49 k of appended tool results triggers; the same history with the prefix invalidated does not. This is the test that fails against the pre-fix code.
15. **(rewritten, RV-4)** `deps.onPressure` fires **once per checkpoint while `compaction.enabled`**, including checkpoints the guards then decline — asserted specifically for (a) `compactionsThisRun >= maxPerRun`, (b) inside the cooldown window, and (c) `selfDisabled` — and **not at all** when `compaction.enabled` is false. Written as v1 had it ("not for the early-return guards") this test would pin the defect as the contract.
15a. **(RV-2)** `maxPerRun` is read from the instance, not the module: a `Compactor` constructed with `maxPerRun: 2` refuses its third compaction while one constructed with the default refuses its sixth.

**`cli/src/__tests__/compaction-tail-relief.test.ts`**

16. A spliced history still over budget is relieved; the returned outcome is `replace` and `record.tailRelief` is populated.
17. `plan === null` **and** over budget yields `action: 'replace'` with `reason: 'tail_relief_only'` — the case that is terminal today.
17a. **(RV-5)** That outcome's record carries `mode: 'relieved'`, and the rendered detail line contains neither `summarized` nor a model name. Asserted on the rendered string, because the defect this replaces was invisible in the record and visible only on screen.
18. `plan === null` and under budget still yields `nothing_to_drop` (no behaviour change for the common case).
19. Relief counts as progress: guard 3 does not increment `consecutiveNoProgress` after a relief that met the budget.

**`cli/src/__tests__/compaction-archive.test.ts`**

20. Writes on `applied: true`, does not write on `applied: false`.
20a. **(RV-3)** The written document's `dropped` array is the verbatim messages the splice removed, `droppedCount` matches its length, and `takeLastDropped()` returns `null` on a second call — the reference is released, not shared.
20b. **(RV-3)** `CompactionRecord` carries **no** message array: the object dispatched to the reducer is asserted to have no key whose value is an array of messages, so a later refactor cannot quietly park the dropped history in view state.
21. Retention prunes to `archiveMaxFiles` **within one `runId`**, oldest by mtime, and **leaves another `runId`'s files untouched even when the directory holds more than `archiveMaxFiles` in total** (RV-6). A separate case covers the `archiveMaxAgeMs` cross-run sweep.
21a. **(RV-6)** `/compact history` lists only this run's archives and reports the count of others in one trailing line; `/compact show <n>` resolves `n` against this run's `index` and refuses an index belonging to another run.
22. A document over `archiveMaxBytes` clips oldest bodies and sets `clipped: true`; metadata and summary survive.
23. An unwritable directory logs `compaction_archive_failed` and the compaction still reports `applied: true` (the failure posture, asserted rather than assumed).
23a. **(RV-7)** The manual `/compact` path archives too, and the assertion is ordered: the write is observable **before** `compactNow` resolves, which is the ordering §3.5.3's table records rather than the one v1 assumed.
24. `compaction.archive: false` writes nothing, creates no directory, **and never retains the dropped slice** (`takeLastDropped()` returns `null`).

**`cli/src/__tests__/compaction-child.test.ts`**

25. With `compaction.subagents: true`, the stub factory receives a config **with** `contextManager`; with `false`, the key is absent (`'contextManager' in config === false`, not `=== undefined`).
26. **(RV-1)** The child's accessors are lazy **and read `state.messages`**: a factory that invokes the accessor during construction sees `[]`, and after `agentRef` is assigned sees the history — the CR-1 shape, one module over. The stub satisfies `SubagentAgentLike` with `{ state: { messages } }`, which is also the compile-time proof that the interface was widened the narrow way.
27. **(RV-2)** Child overlay applied **and effective**, asserted separately per mechanism: the config view really returns `keepRecentTurns: 2` / `onFailure: 'truncate'` / `useFastTier: true` **and re-reads the live config on each call** (a mid-dispatch config change is visible to the child); and the instance bound really refuses the child's **third** compaction, which the config view cannot deliver.
28. `onCompacted` increments `SubagentRun.compactions` and the panel row renders `compacted 1`.

**`cli/src/__tests__/compaction-render.test.tsx` (extended)**

29. Live card with `elapsedMs` renders the duration and `esc to cancel`.
30. `model === ''` omits both the separator and the cancel hint (CR-7's rule extended).
31. A settled card with `tailRelief` renders the warn-coloured third line.

**`cli/src/__tests__/compaction-config.test.ts` (extended)**

32. Both new keys round-trip through `config set`, env and `config.json`, and an unparseable value resolves to the default (CR-8's corrected behaviour).

### 8.2 The integration harness (W6)

`compaction-e2e.test.ts` wires a **real** `Agent` (core) to a **real**
`CompactionWiring` + `Compactor`, with `createRegistry` returning a registry
whose only provider is the scripted one. No `AgentController` — it constructs
tools, skills and a dozen subsystems that this test has nothing to say about,
and the six rows are all about the compaction stack.

Each of the six rows in §3.7.3 asserts, at minimum: the number of provider
calls, the **contents of the request the provider received after the
compaction** (this is the assertion the manual rows exist to make and no unit
test can), and the `CompactionEvent` sequence.

### 8.3 Acceptance criteria

| # | Criterion |
|---|---|
| **AC-H1** | With no `contextManager` injected, event streams, allocations and the status bar are byte-identical to round 1. Asserted by the existing AC-1 snapshot, re-run. |
| **AC-H2** | `deltaTokens` is 0 whenever `measuredPrefixLength` is absent, so a build with W1's recording removed behaves exactly like `553827ca7`. |
| **AC-H3** | A history 76 % measured with 49 k appended tool tokens triggers compaction; the pre-fix code does not (test 14). |
| **AC-H4** | The gauge and the trigger show the same occupancy at the checkpoint, including the delta (one snapshot, one dispatch, one number) — **and they keep doing so on turns where a guard declines to compact**, including after the per-run cap is spent and after guard 4 self-disables (RV-4, test 15). Stated the weaker way, this criterion is satisfiable by a build whose gauge goes dark exactly when the session is in trouble. |
| **AC-H5** | `estimateOffset` is never added to the delta (test 10). |
| **AC-H6** | `relieveTail` preserves `validateHistory` for every generated history (test 5). |
| **AC-H7** | Relief counts as progress against guard 3 (test 19). |
| **AC-H8** | A tail that alone exceeds the window is recovered rather than reported `nothing_to_drop` (test 17). |
| **AC-H8a** | A relief-only compaction never claims a summary: `mode: 'relieved'`, and the rendered detail line contains no model name and not the word `summarized` (test 17a / RV-5). |
| **AC-H9** | Every clip is announced in the message body, on the card, in `/compact status`, on the JSON stream and in the archive. |
| **AC-H10** | With `compaction.subagents: false`, `subagent.ts` spreads no `contextManager` key at all (test 25). |
| **AC-H11** | A child that crosses its threshold compacts and completes; the same child with the key off ends in `run.error` (both in one test, so the difference is the assertion). **And the child's `maxPerRun` bound is asserted directly** — a child is refused its third compaction, not its sixth (test 27 / RV-2), because that bound is the whole cost argument for reversing D-15. |
| **AC-H11a** | The child reads its history through `state.messages`, lazily, and `SubagentAgentLike` was widened with the narrow member rather than core's `Agent` gaining a method (test 26 / RV-1). Core's runtime export count stays 86. |
| **AC-H12** | Child compaction spend reaches `usageTotal` through the lead's sink and is priced with the **summarizer's** cost table (CR-6's rule, extended to children). |
| **AC-H13** | An archive is written before the run continues and never blocks it; a write failure is invisible to the session except in the log (test 23). **The manual path is asserted separately**, because it writes *before* the caller adopts the splice rather than after (test 23a / RV-7). |
| **AC-H14** | The archive directory is `<home>/compaction`, never inside `sessions/` (E-14). |
| **AC-H14a** | Two runs sharing that directory never disturb each other: `/compact history` shows only this run's, and retention prunes only this run's by count (tests 21 / 21a / RV-6). |
| **AC-H15** | `/compact history` and `/compact show` never print message bodies. |
| **AC-H15a** | The dropped `Message[]` never reaches the reducer: `CompactionRecord` carries no message array, and `takeLastDropped()` releases its reference on read (tests 20a / 20b / RV-3). |
| **AC-H16** | The live card shows elapsed seconds and `esc to cancel`; Esc during a summarization settles the card (CR-3's regression, re-run). |
| **AC-H17** | The six converted ★ rows pass offline, with no network and no API key. |
| **AC-H18** | `relieveTail` joins the barrel with `API.md`, `CHANGELOG.md` and `public-api.test.ts` updated in the same commit (C-6). |
| **AC-H19** | Both new config keys appear in all eight places (schema, clamp, store merge, env, load, `config set`, settings screen, README). |
| **AC-H20** | Both packages typecheck **run individually** (`--workspaces` exits 0 on failure — CR-5) and with `tsconfig.test.json`. |
| **AC-H21** | `glyphs.test.ts` passes with `archive.ts` and `child.ts` in the tree — every literal in `src/compaction/**` is ASCII, including the tail-clip marker and the two new `/compact` verbs' output (RV-8). |

### 8.4 What stays manual

`manual-test.md` for this round carries three rows: row 9 from round 1
(persisted OFF with no flags, a launch-time property), plus one row each for the
two new toggles observed on a real session. Round 1's `manual-test.md` is
**not** deleted: rows 4, 6, 7, 8 remain the only coverage of the fast tier
against a live provider, an ASCII terminal and a 60-column window.

---

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| **RH-1** | **W1 over-counts and fires compaction early**, spending money on sessions that did not need it. | The delta is a raw estimate of a slice with no offset applied (§3.2.2), i.e. biased *low* by the same per-message framing error the estimator always had; it can only move occupancy toward the truth. Guard 1's cooldown and guard 3's reclaim ratio are unchanged and still bound the spend. |
| **RH-2** | **A missed invalidation makes the delta index the wrong array**, producing a wrong number silently. | Four sites are enumerated (§3.2.3), and `estimateAppendedTokens` bounds-checks, so a missed site degrades to round 1's behaviour rather than to a wrong figure. Test 12 pins the degradation. |
| **RH-3** | **W2 clips a tool result the next turn needed**, and the model proceeds on partial data. | Oldest-first, newest never clipped while an older candidate exists; the marker is in the text the model reads at the exact place; relief only runs when the alternative is a request that cannot be sent. |
| **RH-4** | **W2 breaks the structural invariant** and produces an un-sendable history — R-2, the worst outcome. | Relief changes no roles, no ids and no message count; the property test (test 5) asserts `validateHistory` invariance over generated histories; and the engine's gate still runs afterwards, so a bug degrades to "compaction did not happen". |
| **RH-5** | **W3 makes a dispatch's cost unpredictable** — D-15's original objection. | `childMaxPerRun: 2`, forced fast tier, `keepRecentTurns: 2`, and a config key that restores the old behaviour exactly. The bounded worst case is 2 fast-model summarizations per child; the unbounded case it replaces is a discarded 24-turn dispatch. |
| **RH-6** | **W3's lazy accessors are read eagerly** and the child measures an empty history — CR-1 one module over. | The accessors are closures over `agentRef`, which is assigned after the factory returns; test 26 asserts the shape directly rather than the symptom. |
| **RH-7** | **The archive leaks conversation content to disk** in an environment where that is not acceptable. | Same trust boundary as `sessions/` and `logs/`, which already persist the same material; one key turns it off; retention bounds it at 20 files; the path is printed by `/compact history` so it is discoverable rather than hidden. |
| **RH-8** | **The archive fills a disk.** | `archiveMaxFiles: 20` pruned on every write, `archiveMaxBytes: 8_000_000` per file — a bounded 160 MB worst case in a dedicated, self-pruning directory. |
| **RH-9** | **W5's per-second prop re-renders the transcript.** | Only the single `live` card receives `elapsedMs`; every settled card keeps object identity through `mapEntry` and stays memoized. `spinner-census.test.ts` and the settled-boundary assertions from C-8/C-9 are re-run. |
| **RH-10** | **The scripted provider drifts from the real adapters** and the six converted rows pass against a fiction. | The harness implements `LLMProvider` (the same interface the real adapters implement), and rows 4, 6, 7, 8 stay manual precisely so the live-provider path keeps a human check. §12 states that W6 reduces the manual burden and does not remove it. |
| **RH-11** | **`tailRelief` on `compaction_end` is added to core and a subscriber union is missed**, failing the build late or, worse, dropping the field silently. | IF-3's rule: `logging/install.ts`'s union must be a superset of core's, asserted by the existing upstream-contracts test, which is re-run as part of AC-H18. |

---

## 10. Decisions

| # | Decision | Why |
|---|---|---|
| **DH-1** | **The measured base stays authoritative; only the appended suffix is estimated.** | Mixing two units is exactly what D-23 warned about. The base is the provider's own number for a request that really happened; the delta describes messages no request has yet carried, and there is nothing better than an estimate for those. |
| **DH-2** | **The `+1` skip is part of the contract**, documented at the function. | `turn_end` before the assistant push is a property of `agent-loop.ts` that a future refactor could change; the comment names the two line numbers so the coupling is discoverable. |
| **DH-3** | **`estimateOffset` is not applied to the delta.** | It is a per-request constant (tool schemas), already inside the base. Applying it per slice inflates every turn. |
| **DH-4** | **Relief clips `tool_result` bodies only.** | They are the largest, the most redundant, and the only category whose partial form the model can act on correctly (it can re-run the tool). Clipping assistant text produces a history that contradicts itself. **The size argument is the bound, not the digest (RV-9):** a tool result is capped at 100 KB *each* with several per turn (E-3), while an assistant message is capped by the turn's `maxOutputTokens`. |
| **DH-5** | **The port's shape stays frozen**: relief is reported on the CLI record and on the core event, not through `CompactionOutcome`. | The engine validates and adopts; it has no use for the distinction. A wider outcome type is a public contract change for a reporting nicety. |
| **DH-6** | **D-15 is reversed.** Sub-agents get a manager, under a tighter overlay and a config key. | Its premise is measurably false at `maxTurnsPerSubagent: 24` / `dispatchTimeoutMs: 900_000`, and the cost it protects against is smaller than the cost it allows. |
| **DH-7** | **A child compaction produces no transcript card.** | The lead's transcript describes the lead's context. The team panel and the dispatch report are where a child's internals belong. |
| **DH-8** | **The archive is written after the engine's verdict, asynchronously, best-effort.** | Archiving a refused splice records a history that is still live; blocking on a filesystem inside an event handler is a stall the watchdog is paused across. |
| **DH-9** | **`/compact show` never prints message bodies.** | An archive is megabytes and the transcript is not a pager. The path is the useful output. |
| **DH-10** | **The activity row is not reopened.** Elapsed and the cancel hint go on the card. | "One row, no digits, no `esc abort`" was legislated a feature earlier and is a global rule about that row, not a gap. |
| **DH-11** | **`Pressure.source` keeps two members; `isApproximate` answers the `~` question.** | A third member would force every consumer to be revisited for a distinction none of them acts on. |
| **DH-12** | **W6 builds its harness around `Agent` + the real wiring, not `AgentController`.** | The controller constructs a dozen unrelated subsystems; the six rows are about the compaction stack, and a harness that is expensive to stand up is a harness nobody extends. |
| **DH-13** | **Exactly one production seam is added for testability** (`createRegistry`). | Every other thing the harness needs is already public. A test-only seam per module is how a codebase acquires a shadow API. |
| **DH-14** | **No `/compact undo`.** | Restoring the pre-compaction history restores the condition that triggered compaction; the next request fails. Fidelity on disk gives the user what undo was wanted for — the ability to check and to recover *by hand* — without a button that re-breaks the session. |
| **DH-15** | **(review, RV-4) Reporting occupancy is not a side effect of deciding to compact.** The measurement moves above the guards and is published every enabled checkpoint. | Below the guards it is skipped on five paths, two of which never clear within a run — so the corrected number would disappear from the gauge in exactly the state where it is the user's only warning. The cost is one bounded, synchronous estimate per turn; the `!config.enabled` early return still keeps an ordinary session at zero. |
| **DH-16** | **(review, RV-2) `maxPerRun` becomes an instance field on `Compactor`; `keepRecentTurns` / `onFailure` / `useFastTier` come from a config view.** | `limits.ts:12-20` splits structural from policy and puts `maxPerRun` firmly on the structural side, with no config path by design. A child needs a tighter bound anyway, so the choice is a per-instance field or a new user-facing key that contradicts that split. The field is the smaller change and keeps both numbers in `COMPACTION_LIMITS`. |
| **DH-17** | **(review, RV-1) The child reads `state.messages`; core's `Agent` gains nothing.** `SubagentAgentLike` is widened with `readonly state: { readonly messages: readonly Message[] }`. | Adding `getMessages()` to the engine to serve a host-side convenience is the §1.2 boundary violation this round otherwise avoids, and it would move the core export surface. Narrowing the structural member to the one field the child uses keeps eight test stubs to a one-line addition each. |
| **DH-18** | **(review, RV-3) The dropped messages travel on a side channel (`takeLastDropped`), never on `CompactionRecord`.** | That record is dispatched into the reducer and retained in view state for the card's lifetime. Putting the dropped history on it would park in React exactly the memory the compaction just reclaimed — an archive feature that makes the leak it audits. |
| **DH-19** | **(review, RV-6) The archive is keyed by a per-process `runId`, and cross-run retention is by age rather than count.** | The directory is shared by every `aragon` on the machine — `file-sink.ts:94-95` already treats concurrent processes as normal. A global count-based prune deletes a live session's archives; a per-run count plus a global age sweep bounds the directory without any run reaching into another's. |
| **DH-20** | **(review, RV-5) A relief-only compaction reports `mode: 'relieved'` on the CLI record and `'truncated'` across the port.** | `'summarized'` would render "summarized 0 messages with `<model>`" for a compaction in which no model was called. The port keeps two members (DH-5) because the engine's question is only "was this reduced without a summary", and the answer there is yes. |

---

## 11. Definition of done

1. Both packages build and typecheck **individually** (CR-5's rule), including
   `tsconfig.test.json`.
2. `relieveTail` and its two types are exported with `index.ts`,
   `public-api.test.ts`, `API.md` and `CHANGELOG.md` updated in the same commit
   (86 runtime exports).
3. Every acceptance criterion in §8.3 has at least one automated test. AC-H17 is
   the six-row e2e file; nothing in §8.3 is satisfied by inspection.
4. Test 14 (W1), test 17 (W2) and AC-H11 (W3) are each **verified to fail
   against `553827ca7`** before the fix lands. A regression test that has never
   been red is a claim, not a test.
4a. The four review-added assertions that pin a *specific* corrected behaviour —
   test 15 (RV-4), test 15a / 27's bound half (RV-2), test 17a (RV-5) and test
   20b (RV-3) — are each **run against a build with only that fix reverted** and
   observed red. These do not fail against `553827ca7`, because the code they
   guard does not exist there; a green-from-birth test is what let all four
   defects be written down as done in the first place.
5. `compaction.subagents` and `compaction.archive` appear in all eight places
   (AC-H19), and `--no-compaction` still turns the entire feature off in one
   flag.
6. No new file exceeds 1 000 lines; `compactor.ts` and `wiring.ts` stay under it
   (§7 records the escape hatch if they do not).
7. `manual-test.md` for this round exists with its three rows; round 1's file is
   left in place and its unrun ★ rows are marked as **converted** where §3.7.3
   converted them, with a pointer to the automated test name.
8. `README.md` documents the two keys, the two `/compact` verbs, what a clipped
   tool result means and where the archive lives. The CHANGELOG states that
   sub-agent compaction is on by default and how to turn it off.
9. The `## 实施过程发现的方案缺陷` section is appended to **this** document by the
   implementing node, in round 1's format: what the design said, what the tree
   required, what was done.

---

## 12. Non-goals (this round)

- **No tokenizer.** W1 improves the estimate's *scope*, not its precision. The
  round-1 argument stands: a 10 % safety margin absorbs a 20 % error, and a
  tokenizer dependency is a large cost for a guard rail.
- **No undo** (DH-14).
- **No hierarchical summaries.** A second compaction still merges the prior
  block forward (D-22).
- **No image handling in relief.** Image parts in a `tool_result` are left
  alone; the estimator's flat 256-token charge for them is already wrong in a
  direction W1 does not fix. Recorded so the next round knows where to look.
- **No learned context ceilings** (D-14 stands).
- **W6 does not remove the manual rows.** Rows 4, 6, 7, 8 remain the only
  observation of the feature against a live provider, an ASCII terminal and a
  narrow window. The claim this round makes is that six of the seven ★ rows no
  longer depend on a human remembering to run them — not that the feature has
  been observed in production.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Written by the implementing node, in round 1's format: what the design said, what
the tree required, what was done. Eleven findings — ten from the implementing
node, IF-11 added by the reviewing node; none required a decision to be reversed,
and every one of them is a place where the document was written from the caller's
point of view — the same pattern the review verdict names, one layer further in.

---

### IF-1 — `AgentEvent.compaction_end.tailRelief` cannot be populated by the engine

**What the design said.** §3.3.4 adds the optional field to core "so `aragon
exec`'s JSON stream and the headless stderr line can report a degradation that
the user is entitled to know about", and §4.1 budgets it as the round's one
core-side type addition.

**What the tree required.** Neither consumer reads core's event.
`exec/runner.ts` and `agent/headless.ts` both subscribe through
`controller.subscribeCompaction` and read `event.record` — the **CLI's**
`CompactionRecord`. And the engine has no way to learn about relief: DH-5 freezes
`CompactionOutcome` at two `mode` members with no relief field, and §3.1 states
`agent-loop.ts` is deliberately untouched. That function's `finally` builds
`compaction_end` from `applied` / `mode` / `summary` / `reason` and nothing else,
so there is no path from `relieveTail`'s result to that event.

**What was done.** The field is added as specified and documented as
host-populated: it is an additive slot on a public contract, it costs nothing, and
a host that emits its own `AgentEvent`s can use it. The **actual** reporting goes
where the consumers actually look — `CompactionRecord.tailRelief` →
`ExecCompactionEvent.tailRelief` (§4.5's "the existing `compaction` event", which
on re-reading is the CLI's exec event rather than core's) and the headless stderr
line. `logging/install.ts`'s union gained the field too, per RH-11's rule.

The core export count is unaffected: `relieveTail` is still the only new runtime
export, 85 → 86.

---

### IF-2 — the `agentFactory` stub table is neither eight files nor the right eight

**What the design said.** §3.4.3 lists eight CLI test files with `agentFactory`
call sites that must satisfy the widened `SubagentAgentLike`, and condition 1 of
the verdict says to verify the count before editing — noting that v1 of the
document said "four".

**What the tree required.** Six files needed the new member, and three of the
eight listed did not:

| File | Listed | Needed | Why |
|---|---|---|---|
| `fast-task-tier.test.ts` | yes | **yes** | one shared `stubAgent` helper |
| `retry-team.test.tsx` | yes | **yes** | `class RetryingAgent implements SubagentAgentLike` |
| `team-activity.test.ts` | yes | **yes** | object literal |
| `team-retry.test.ts` | yes | **yes** | `class ScriptedAgent` |
| `team-runtime.test.ts` | yes | **yes** | `class StubAgent` |
| `team-tool-gate.test.ts` | yes | no | reaches the factory through a cast |
| `todo-session.test.ts` | yes | no | same |
| `exec-child-permission.test.ts` | yes | no | already `as unknown as` (the document said so) |

And **two files the table does not list** had to change, for reasons unrelated to
`SubagentAgentLike`:

- `max-tokens-ui.test.tsx` — two `SettingsValues` fixtures, which §4.6's two new
  rows made incomplete. The change plan lists `SettingsScreen.tsx` but not its
  fixture holders.
- `compaction-render.test.tsx` — one `Pressure` fixture, which §5.1's
  non-optional `deltaTokens` made incomplete.

**What was done.** The six real sites gained `state: { messages: [] }`, except
`team-runtime.test.ts`'s, which gained a real mutable array so a child manager
built against it would measure what the child actually accumulated. The two
fixture files were completed. IF-7's lesson from round 1 — count before claiming
— applies to the count of the count.

---

### IF-3 — the summarizer does not reach a provider through `complete()`

**What the design said.** §3.7.2: "`complete()` is the one the summarizer uses
(`wiring.ts:162`), `stream()` the one the loop uses", and the scripted provider
implements both so a test can tell them apart.

**What the tree required.** `wiring.ts:162` calls
`ProviderRegistry.complete(providerId, request)`, and that method is
`consumeStream(this.stream(providerId, request))` **by design** — its own comment
says routing it through `provider.complete()` "would leave `completeLLM` as the
one public entry point with no retry at all, which is exactly the kind of hole
that gets discovered in production" (llm-api-retry-backoff §5.4). So a scripted
provider sees a summarization and a turn through the **same** method, and
"requests that arrived through `complete()`" is an empty array on every run.

**What was done.** The harness classifies by a property of the **request** rather
than by entry point: `buildSummarizeRequest` sets `temperature: 0`,
`thinkingLevel: 'off'`, no tools and exactly one message, together and
deliberately (its own comment: "NO TOOLS, no thinking, one bounded user
message"), and the agent loop sets none of them. `ScriptedProvider` therefore
exposes `agentRequests` and `summarizerRequests` rather than `streamRequests` /
`completeRequests`, and the reason is written at the field.

This changes what §3.7.3's row-3 assertion counts: **two agent-loop requests**
(the refused one and the compacted re-send) plus one summarization, not "two
`stream()` calls".

---

### IF-4 — `contextManagerFor`'s three parameters cannot carry what W3 needs

**What the design said.** §3.4.3 item 1:
`contextManagerFor?: (label, getMessages, getSystemPrompt) => ContextManager`.

**What the tree required.** Two things the signature has no room for, and one it
gets wrong:

1. **`onCompacted` has no route.** §3.4.2 lists it as a `ChildCompactionDeps`
   member "for the team panel's `compacted N` marker", and §3.4.4 says
   `SubagentRun.compactions` is incremented by it. But the only object holding a
   `SubagentRun` is `createSubagent`'s local `run`, and the factory is supplied by
   `AgentController`, several layers away. Delivered through the deps, the
   callback would have to find the right child by label through an indirection
   that does not exist.
2. **A child's context window is the CHILD's.** `Compactor.modelInfo()` resolves
   from `config.provider` / `config.model`, so a `tier: 'fast'` child would be
   measured against the LEAD's window — usually much larger. The trigger would
   fire late in exactly the population W3 exists for. §3.4.2's overlay table has
   no row for the model, and there is no path to one from the label alone.
3. **The return type must be able to decline.** AC-H10 requires `subagent.ts` to
   spread **no `contextManager` key at all** when the feature is off. A factory
   typed `=> ContextManager` cannot express that, and the obvious repair — omit
   `contextManagerFor` from `SubagentDeps` when the key is off — fixes the
   decision at dispatch construction, so a settings-screen edit mid-dispatch
   would not reach the next child.

**What was done.** The three positional parameters become one options object,
`ChildContextManagerRequest { label, model, getMessages, getSystemPrompt,
onCompacted }` — the shape `TeamRuntime.RunOneCtx` argues for one package over
("an options object, not five positional parameters"). The child's config view
overlays `provider` / `model` / `baseUrl` from `req.model`, so occupancy is
measured against the window the child actually has. `SubagentDeps` holds a
`ChildContextManagerProvider`, returning `ChildContextManager | undefined`, and
`AgentController` supplies `(req) => this.compaction?.childFactory()?.(req)` —
evaluated per child, so the key is re-read every time.

---

### IF-5 — a child has no `turn_end` hook, so W1 does not reach W3

**What the design said.** Nothing. §3.2.3 records the prefix in
`Compactor.onTurnEnd`, which `CompactionWiring` calls from its subscription to the
lead's event stream. §3.4 treats the child manager as "the same `Compactor` with a
different policy overlay".

**What the tree required.** `ContextManager` is `{ shouldCompact, compact }`.
Nothing on that port carries a turn boundary, and the child manager has no
subscription of its own — `createSubagent` owns the child's `agent.subscribe`. So
`measuredPrefixLength` would stay `undefined` for a child's whole life, and every
W3 child would read exactly the systematically-short number W1 exists to correct.
Nothing would report a fault.

**What was done.** `ChildContextManager extends ContextManager` with one extra
method, `onTurnEnd`, called from `subagent.ts`'s existing `turn_end` case with
`agentRef?.state.messages ?? []` and the hoisted `systemPrompt`. The port itself
is unchanged (DH-5 holds): this is a host-side interface between two host-side
modules.

---

### IF-6 — `ChildCompactionDeps.resolveSummarizer` is wrong, and two members are missing

**What the design said.** §3.4.2's `ChildCompactionDeps` carries
`resolveSummarizer: () => SummarizerChoice | null` — "the lead wiring's own
resolution + transport, reused (D-10 stays true)".

**What the tree required.** Injecting the lead's resolution would be a defect
rather than a saving. `Compactor.resolveSummarizer()` reads
`config.compaction.useFastTier` (which the child's view forces true), asks
`resolveFastTier`, and falls back to `mainRef()`. Over the child's config view
that fallback is the **child's own** model, which is right. The lead's resolution
falls back to the **lead's** model — so a Haiku child whose fast tier failed to
resolve would summarize with Opus, the exact opposite of the same table's rule
that "a background repair inside a background worker must never take the main
model's quota".

Separately, `CompactorDeps` requires `hasKey` and `getApiKey`, which §3.4.2's list
omits.

**What was done.** `resolveSummarizer` is not a dep; the child's own `Compactor`
resolves over its config view. `hasKey` and `getApiKey` were added, forwarded from
the lead wiring's own deps so a settings-screen key edit reaches a running child.
D-10 still holds through `complete`, which **is** the lead wiring's transport.

---

### IF-7 — a relief-only record must also drop the model name

**What the design said.** §3.3.3 specifies `mode: 'relieved'` and a `detailLine`
branch that names no model. §6.2a's mock shows the card with no model anywhere.

**What the tree required.** `CompactionRecord.model` is read by three surfaces,
not one: the card, `/compact status`, and the archive document. `finish` sets it
from `args.summarizer?.ref.modelId`, which is non-empty whenever a summarizer
**resolves** — including on the relief-only path, where no call was made. A
`detailLine` branch alone would leave two other surfaces naming a model that was
never asked anything.

**What was done.** `finish` sets `model: ''` on the relief-only branch, next to
the `mode` override and for the same stated reason. Test 17a asserts both.

---

### IF-8 — §3.4.4's "next to the existing `mail N` cluster" describes a row that does not exist

**What the design said.** §3.4.4: "The team panel row appends `compacted N` next
to the existing `mail N` cluster when `compactions > 0`", illustrated by §6.4's
mock `researcher   thinking   6 turns   14 tools   mail 2   compacted 1`.

**What the tree required.** `TeamPanel`'s per-child row is
`activityLine(run, cols)`, which renders **one** phase-dependent string clamped to
`activityBudget(cols)` — `queued`, `starting`, `writing: …`, a tool description,
`done  N turns`, `failed`, `aborted`. There is no turns/tools/mail cluster on a
row at all; `snapshot.messageCount` is a **header** readout. The mock describes a
panel this package does not have.

**What was done.** `compacted N` goes on the **settled** row only —
`done  6 turns  compacted 1` — because a running row is already competing for
`activityBudget(cols)` with the child's own prose, and displacing what the child
is doing right now buys nothing. The dispatch report carries it for good, in the
position `retried Nx` uses: that is the only place the lead learns a child's
history was summarized mid-task, which is what makes a thin summary explained
rather than mysterious.

---

### IF-9 — the child's archive is suppressed through the config view, not by omitting a dep

**What the design said.** §3.4.2's overlay table: "archive (W4) | yes | **no** |
dep omitted".

**What the tree required.** Archiving is not a dep. `runCompaction` reads
`getConfig().compaction.archive` before it retains the dropped slice, and
`settlePending` reads it again before it writes — and the child manager has no
`settlePending` at all, so "omit the dep" has nothing to omit and the child would
still **retain** the slice on every compaction.

**What was done.** The child's config view sets `archive: false`, so the slice is
never retained and the child's `takeLastDropped()` is always `null`. Same
mechanism A the other three rows use, noted at the key.

---

### IF-10 — two of the "five files" for a config key need no edit, and that is by design

**What the design said.** §7: `config/{schema,store,env,load,cli-commands}.ts`,
"Two keys, five files (IF-8)". AC-H19: both keys must appear "in all eight
places".

**What the tree required.** `store.ts` and `load.ts` merge the `compaction`
section **whole** — `clampCompactionConfig({ ...DEFAULT_CONFIG.compaction,
...(partial.compaction ?? {}) })` on the read side, `{ ...current.compaction,
...(patch.compaction ?? {}) }` on the write side, and a four-layer spread in
`resolveCompactionConfig`. A new scalar therefore flows through both by
construction, and an edit would be a no-op. The two files that DO need per-key
code are `env.ts` (each variable is read by name) and `cli-commands.ts` (a
dedicated setter per key, for the reason its own comment gives).

**What was done.** Three of the five files changed; `store.ts` and `load.ts` are
untouched, and `compaction-config.test.ts` asserts the round trip through both
anyway — which is the only way to know the spread really covers a new key rather
than looking as if it does. All eight places of AC-H19 are satisfied; two of them
were already satisfied before this round began.

---

### IF-11 — the archive write is synchronous, because `archivePath` has to be true

*(Found in review, not by the implementing node. The code carries the reasoning
at `wiring.ts::archive`; this records it where the document can be checked
against the tree.)*

**What the design said.** §3.5.3: "`void archive.write(...)` — fire and forget.
The compaction path must not wait on a filesystem, and `settlePending` runs inside
an event handler", and DH-8 states the write is "asynchronous, best-effort".

**What the tree required.** §5.2 also gives `CompactionRecord` an `archivePath?`
"absent when the write failed — a best-effort artefact never claims to exist",
and `/compact show` resolves against what is on disk. Those two cannot both hold
through a fire-and-forget call: the record is dispatched to the reducer in the
next statement, so a path attached before the write resolves is a claim the
wiring has no way to retract, and one attached after would have to mutate an
entry the transcript has already rendered. Deferring the write also loses the
ordering RV-7 spent a table establishing — on the manual path the archive must be
observable **before** `compactNow` resolves.

**What was done.** `writeArchive` is called synchronously and returns the path or
`null`, and `settlePending` sets `archivePath` only on a path. The stall this
trades for is bounded and small against what surrounds it: one `writeFileSync`
capped at `archiveMaxBytes` (8 MB) plus one `readdir` + `stat` pass, at most
`maxPerRun` times per run, on a code path whose own LLM call took seconds. The
failure posture the design actually cares about is unchanged and is the part that
was load-bearing: `writeArchive` never throws, logs `compaction_archive_failed`
at `warn`, never notifies, and never affects whether the compaction is applied
(test 23). The README's "asynchronous" was corrected to match.

---

### What was NOT done, and why it is not a finding

Nothing in §7's change plan was skipped, and no decision was reversed. Two things
the document asks for could not be executed by this node:

- **DoD 4 / 4a — the red-first discipline.** Test 14 (W1), test 17 (W2) and
  AC-H11 (W3) are written so that they fail against `553827ca7`, and tests 15,
  15a, 17a and 20b are written so that they fail against a build with only their
  own fix reverted. Observing those reds requires checking out a second tree and
  building it, which is outside this node's scope. The tests are in place and the
  reasoning is recorded at each of them; the observation is not.
- **The three manual rows.** `manual-test.md` for this round exists with its
  three rows, and all three are unrun: each needs a live provider and a real home
  directory. §12's claim stands unchanged — after this round the compaction stack
  is *tested*, not *observed*.

---

## 评审结论 (Review Verdict)

### 有条件通过 — approved with conditions

The design is sound and worth building. W1 identifies a real, quantified defect
in shipped code and fixes it in the right place; W2 closes a genuine hole at the
bottom of the ladder; W3 reverses a prior decision on measured grounds rather
than taste, which is the only honest way to reverse one. The evidence discipline
is the document's best feature — 15 of 17 rows verified exactly at the cited
lines, and the two misses are single-line drift.

The review's substantive finding is a pattern rather than seven separate slips.
**Every P0 and P1 is a claim about a callee that was written from the caller's
point of view**: a method assumed on `Agent` because the controller has one of
that name (RV-1); a bound assumed tunable because its four table-neighbours are
(RV-2); an array assumed present because a field of that name exists as a count
(RV-3); a measurement assumed reachable because `shouldCompact` reaches it *on
the path the author was thinking about* (RV-4); a directory assumed private
because one session was in view (RV-6); an ordering assumed uniform because the
in-loop path is the one that matters (RV-7). All seven were invisible from the
design's vantage point and obvious one file away. That is worth naming because
the implementing node will be reading this document, not the tree.

All 2 P0 and 5 P1 findings are **fixed in the body above**, with the mechanism
respecified rather than merely flagged. The 5 P2s are also fixed. No finding
remains open.

**Conditions on the implementing node** — each is a place where the document is
now correct but the tree still has to agree:

1. **Verify RV-1's stub table before editing.** §3.4.3 lists eight
   `agentFactory` call sites across eight files, counted at `553827ca7`. If the
   count has moved, fix the table in the same commit. IF-7's lesson applies to
   this document as much as to the last one — v1 said "four".
2. **Do not satisfy RV-1 by adding `getMessages()` to core's `Agent`.** It is the
   smaller diff and the wrong one: it moves the core surface (§4.1 budgets
   exactly one new export) and puts a host convenience in the engine. If
   `SubagentAgentLike`'s widened member turns out not to typecheck against
   `Agent`'s `state` getter, report it rather than routing around it.
3. **RV-4's hoist changes a hot path.** `shouldCompact` runs once per turn of
   every enabled session. Confirm on a real run that the added
   `estimatePromptTokens` over the appended slice is invisible at the tick rate,
   and keep `!config.enabled` as the first statement so a compaction-off session
   is provably unchanged (AC-H1).
4. **Land test 15 red first.** It is the one assertion that would otherwise be
   written to match whatever the code does, and v1's version of it actively
   pinned the defect. The same applies to 15a, 17a and 20b (DoD 4a).
5. **`maxPerRun` must be asserted through behaviour, not construction.** AC-H11's
   extension exists because "the overlay was passed" and "the overlay took
   effect" are different claims, and only the second one bounds the cost that
   justifies reversing D-15.
6. **Report anything that contradicts this document** into
   `## 实施过程发现的方案缺陷` (DoD 9) rather than adjusting the code to fit the
   prose. Round 1 produced nine such findings and the feature is better for
   them; this round changed enough load-bearing mechanism that more are likely,
   particularly around the `CompactionMode` fourth member (RV-5), whose switch
   sites TypeScript will find but whose `else` branches it will not.

**One thing this round should not be read as claiming.** W6 converts six ★ rows
to CI, and that is real progress, but the feature still has never run against a
live provider. §12 says so and the verdict repeats it: after this round the
compaction stack is *tested*, not *observed*. The four remaining manual rows are
the whole of the evidence that it works in the world, and they are still unrun.

**Scope note (right-sizing).** Six workstreams in one round is at the upper
bound of what a single review can hold, and the P0s clustered in W3 and W4 — the
two workstreams that touch subsystems the author had least reason to read. If
the implementing node needs to shed scope, **W4 is the one to defer**: it is the
only workstream that serves no failure the user currently hits, its correctness
argument was the weakest of the six (three of the seven P0/P1s are W4's), and
deferring it costs nothing that R-1 does not already accept. W1, W2, W3 and W6
should ship together — W1 because it is a live defect, W2 and W3 because they
close the two ways a long run still dies, and W6 because without it none of
these three is observable.

*Reviewed against `553827ca7`. `spec.md` is the only file modified; no source
code was touched and no commit was made, per the review brief.*
