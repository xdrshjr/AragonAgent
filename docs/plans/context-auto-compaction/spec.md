# Context auto-compaction — design specification

- **Version:** **v2** (v1 authored by the design node; v2 is the reviewed
  revision — every P0 and P1 raised in `## 评审记录` is resolved in the body
  below, and the sections that changed are named in each finding.)
- **Feature slug:** `context-auto-compaction`
- **Status:** design only — this node produces no implementation code.
- **Packages touched:** `packages/core` (a small, additive, dependency-injected
  seam) **and** `packages/cli` (all policy, all UI). See §1.2 and §3.3 for why
  this is the one feature in this repo that cannot be CLI-only.
- **Tree read for this design:** working copy at `56c61c6c2`,
  `@aragon-agent/core` / `@aragon-agent/cli` as checked out under
  `packages/*/package.json`. Every line number quoted below was read in that
  tree, not recalled. **v2 re-read every one of them** plus
  `agent/controller.ts`, `ui/App.tsx`, `cli.tsx`, `config/{store,env,load}.ts`,
  `providers/{openai,google}.ts` and `commands/builtins.ts`, which v1 cited but
  did not quote.

---

## 评审记录 (Review Notes — v2)

Reviewed section by section against **feasibility** (does the current stack
support it), **completeness** (boundary cases, error paths, rollout),
**consistency** (does it fight a convention this repo has already legislated) and
**right-sizing**.

The design is strong: the port shape is right, the engine-owns-validation posture
is right, and the trap inventory in §2 is unusually honest. The findings below
are therefore mostly of one kind — **places where the code sketch or the change
plan does not actually deliver a property the prose promises**, which is the
failure mode a 1 400-line spec is most prone to and the one that costs the most
after implementation starts.

Severity key: **P0** = would ship broken or unsafe; **P1** = a stated guarantee
is not delivered, or a defect that is silent in production; **P2** = consistency
/ clarity, fix if cheap.

### P0

| # | Finding | Where | Resolution |
|---|---|---|---|
| **P0-1** | **The "one shot per turn" overflow guard is dead code.** §3.5's recovery path ends in `continue`, which returns to the top of the `while` — and §3.3 places `overflowRecovered = false` at the top of the `while`. The flag is therefore cleared on the way back in, so a session whose tail alone cannot fit compacts on every pass, bounded only by `maxPerRun`. The spec asserts this guard as a safety property in §3.5 and in AC-11; as sketched it does not exist. | §3.3, §3.5 | Fixed: the flag is cleared **only after a stream completes** (§3.3), never at the top of the loop, and §3.5's `continue` is documented as the reason. New AC-11a asserts exactly two requests and exactly one compaction when the provider throws twice. |
| **P0-2** | **`contextManager` cannot be passed into `new Agent({...})` as §7 requires.** `AgentController` constructs the `Agent` at `controller.ts:536` and every optional subsystem **after** it (`this.fast` at `:572`), because — in that file's own words — "`FastWiring` subscribes to the lead's event stream, so it cannot be built before the `Agent`." `CompactionWiring` needs the same stream (it must observe `compaction_end` to learn the engine's `applied` verdict, and `agent_start` to reset the per-run cap), so under §7's plan the field is still `undefined` when `new Agent` runs: the feature compiles, registers nothing, and is silently off with the key on — the exact failure `toolOutputs`' comment at `:265-280` documents. | §3.2, §7, new C-12 | Fixed: `CompactionWiring` is constructed **before** the `Agent` (it needs no agent reference to exist) and **attached** after it via `attach(subscribe)`. `manager()` returns a stable `ContextManager`; `undefined` when the feature is off, preserving AC-1. Recorded as **C-12** and **D-19**. |

### P1

| # | Finding | Where | Resolution |
|---|---|---|---|
| **P1-1** | **`lastUsage` is declared and read but never assigned.** §3.3 hoists it above the `while` and passes it into every probe, but the loop's authoritative usage is the per-iteration local at `agent-loop.ts:152`, and no line in the spec copies it out. Every trigger would therefore run on the `source: 'estimate'` fallback for the whole session — the primary measured path never engages, the status bar and the trigger diverge (the defect §3.4.1 exists to close), and nothing reports it. | §3.3 | Fixed: `lastUsage = usage` immediately after the `turn_end` emit, with the reason stated inline. New unit test asserts `probe.lastUsage` is defined on turn 2. |
| **P1-2** | **The engine hands the host a live alias of its own message array.** `MessageManager.getAll()` returns the internal array itself (`message-manager.ts:20-22`, no copy), and §3.3 launders the `readonly` away with `as Message[]` before putting it on `CompactionContext`. A host that sorts, splices or truncates it corrupts engine state directly, in-place, before validation can see it — which defeats §3.3 step 5, the one thing the engine is in this feature for. | §3.2, §3.3 | Fixed: the engine passes a shallow copy. One array allocation per compaction, i.e. at most `maxPerRun` per run. |
| **P1-3** | **A `compact()` that never settles wedges the run permanently.** `compaction_start` pauses the watchdog, and a paused `IdleWatchdog` is fully deaf (`watchdog.ts:22`, `kick()` early-returns while paused). The engine then `await`s the host with no ceiling of its own and no race on `ctx.signal`. So a host bug that returns a non-settling promise produces a hang with the *idle detector switched off* — strictly worse than the pre-feature behaviour — and Esc does not help either, since abort only unblocks the await if the host honours the signal. §3.3 step 4 says a host that breaks its contract must degrade to "compaction did not happen"; an unbounded await is not that. | §3.3 | Fixed: the engine races `compact()` against `ctx.signal` and a hard `COMPACTION_HARD_TIMEOUT_MS` ceiling (120 s — strictly above the worst legal host budget of `45 s × 2` plus the digest render, so it only ever fires on a host bug), and resumes the watchdog in a `finally`. New AC-10a / AC-14a. |
| **P1-4** | **The reactive path shows the user a false error before it recovers.** `agent-loop.ts:170` emits `message_update` for **every** stream event *before* the `error` branch throws at `:175-177`, and `reducer.ts:637-644` turns a stream `error` into an error notice through `formatStreamError`, whose `context_overflow` text is literally *"Context length exceeded - start a new conversation with /reset."* (`:681-682`). So the successful reactive path always paints a red banner telling the user to throw the session away, one frame before quietly saving it. That is the opposite of R-e, and AC-11 does not catch it because it only asserts the run completes. | §3.5, §6.4 | Fixed: `compactionStart` with `trigger: 'overflow'` **rewrites** the notice it finds at the tail into an informational "Context window exceeded — compacting and retrying." (new reducer behaviour, §5.5), and `formatStreamError`'s copy now names `/compact` alongside `/reset`. New AC-11b asserts no `level: 'error'` notice survives a successful recovery. |
| **P1-5** | **`--no-compaction` alone silently un-sets a persisted `enabled: false` on every run.** `cli.tsx` states the rule seven times in seven comments (`:1605-1650`): a **persisted** boolean needs BOTH forms declared, positive first, because commander defaults `opts.x` to `true` when only `--no-x` exists, at which point the flag is indistinguishable from its own default and overrides `config.json` unconditionally. §4.3 lists only `--no-compaction`, and `enabled` is persisted **and** defaults to `true` — the polarity in which this is worst. It would make R-12's mitigation ("one config key restores the old behaviour exactly") false. | §4.3, new C-13 | Fixed: both `--compaction` and `--no-compaction`, positive first, resolved with `!== undefined`. Recorded as **C-13**; new unit test asserts a stored `false` survives a flagless run. |
| **P1-6** | **Reducer actions are dispatched twice, so the transcript gets two cards and `tokensReclaimed` doubles.** §7 gives `reducer.ts` "`reduceEvent` cases for the two core events" *and* §5.2 + §7 give `App.tsx` a `subscribeCompaction` effect over the CLI-local stream. Both carry the same compaction. Nothing in the spec names the single authority. | §5.2, §7, §5.5 | Fixed: the CLI-local stream is the **sole** source of reducer actions; `reduceEvent` gains **no** cases for `compaction_start` / `compaction_end` (C-5's `default: return []` is exactly right), and the wiring is the only consumer of the two core events. Recorded as **D-20**. |
| **P1-7** | **`/compact` while idle bypasses the structural gate.** §4.4 says an idle `/compact` "runs immediately", but when the agent is idle there is no loop and therefore no §3.3 step 5. The only way to splice is `Agent.replaceMessages` (`agent.ts:304`), which validates nothing. D-4 declares that gate unbypassable and R-2 calls an invalid splice the worst possible outcome; as specified, the manual path is a hole in exactly that gate. | §4.4, §3.6.5 | Fixed: the idle path MUST call the exported `validateHistory` before `replaceMessages` and refuse on failure, reporting through the same card and the same `reason` vocabulary. `validateHistory` was already going to be a public runtime export (§4.1), so this costs nothing. New AC-16a. |
| **P1-8** | **The transcript card cannot be expanded, so AC-6 cannot pass.** `expandedToolIds` is keyed by entry id, but both *selection* surfaces filter by kind and neither would match: Ctrl+O picks the last `kind === 'tool' \|\| 'team'` entry (`App.tsx:1625-1627`) and `/expand` filters `kind === 'tool'` (`builtins.ts:940`). §7's `App.tsx` row lists three changes and this is not one of them, so the card would render `ctrl+o to expand` and Ctrl+O would silently expand an older tool card instead. | §6.3, §7 | Fixed: the Ctrl+O predicate gains `'compaction'` (third member) and the empty-state toast is widened; `/expand` is left tool-only **deliberately** and that is now stated. New render test. |
| **P1-9** | **Anchor and prior-summary handling is not idempotent, and a second compaction throws away two thirds of the first summary.** Two coupled defects. (a) §3.6.5 identifies the goal anchor as "the first `user` message of the conversation" — but after one compaction that message *is* the compacted block (merged shape) or is followed by it, so the second compaction either promotes a summary to "the user's original task" or keeps the block as an anchor **and** re-digests it, duplicating it. (b) The prior `<compacted_context>` block is a `user` message, so §3.6.3's table clips it to `userChars` (2 000) before re-summarizing — while §5.4 lets it be `summaryMaxChars` (6 000) long. §1.3 accepts flattening summaries; it does not accept silently discarding two thirds of the record on every subsequent compaction. | §3.6.2, §3.6.3, §3.6.5 | Fixed: the anchor is **always its own leading message** and is **structurally identifiable** (`<original_task>` for the text shape, `anchor="verbatim"` on the block for the ContentPart shape); a recognized anchor is carried through untouched and excluded from the head. The digest recognizes a `<compacted_context>` block and carries it **whole** up to `summaryMaxChars`, and the summarizer prompt is told it is merging a prior record. `planCompaction` gains `protectedPrefix` so "nothing worth dropping" stays a core-side, host-knowledge-free judgement. Recorded as **D-21** / **D-22**. |
| **P1-10** | **`occupiedTokens` is correct only by accident of which adapters exist today.** The formula is right for Anthropic — `input_tokens` genuinely excludes the cache buckets (`anthropic.ts:139-141`) — and it is safe on OpenAI and Google **only because neither adapter ever populates `cacheReadTokens` / `cacheWriteTokens`** (verified: the strings do not appear in `openai.ts` or `google.ts`). But OpenAI's `prompt_tokens` **already includes** cached tokens, so the first person to map `prompt_tokens_details.cached_tokens` onto the existing field turns this sum into a double-count and makes compaction fire early on every OpenAI session — the mirror image of the very defect §3.4.1 is fixing, introduced by a change that looks like a pure improvement. §3.4.1 states the formula as if it were provider-independent. | §3.4.1, new C-14 | Fixed: the provider-side invariant is stated (**C-14**), `occupiedTokens` is documented as consuming *additive* cache fields only, and a regression test asserts the two fields stay unset on the OpenAI and Google adapters so the trap fails loudly at the moment someone opens it. |
| **P1-11** | **The gauge and the guards mix measured and estimated units, and the estimate is biased low in one direction.** `estimatePromptTokens` counts `systemPrompt` + message bodies (`output-limits.ts:348-356`) and **never counts the tool definitions**, which the loop does send (`agent-loop.ts:147,158`) and which the provider's `input_tokens` does include — several thousand tokens for this CLI's toolset. Three consequences the spec does not address: the `source: 'estimate'` path (the resumed-session case §3.4.2 calls the most dangerous moment in the feature's life) systematically **under**-reports; §6.2 drops the gauge to an estimated "after" while the number it replaces was measured, so the bar visibly climbs again on the next `turn_end` for no reason the user can see; and §3.8 guard 3 compares an estimated projection against a threshold calibrated on measurements, so it can pass when reality would fail. R-11 claims this class of divergence is closed by one shared function; it is not, because there are two *units*. | §3.4.2, §5.1, §6.2, §3.8 | Fixed: a **calibration offset** is carried — `offset = occupiedTokens(lastUsage) - estimateOf(historyAtThatTurn)`, clamped to `≥ 0` — and applied to every estimated figure, including the post-compaction gauge value and guard 3's projection. Before the first `turn_end` the offset is unknown and the estimate is used raw, still marked `~`. Recorded as **D-23**; new unit test. |
| **P1-12** | **AC-20 is unsatisfiable as written and therefore discredits the whole AC list.** It requires that "no file exceeds the 1000-line guideline". Six of the files §7 modifies already do: `cli.tsx` 1 929, `schema.ts` 1 730, `reducer.ts` 1 673, `App.tsx` 2 235, `controller.ts` 1 443, `builtins.ts` 1 204. An AC that cannot pass is either a blocker on a feature that is not the cause, or — far more likely — the one that gets waved through, which teaches the next reader that this list is decorative. Separately, §7 puts the six-form `/compact` command **and** its status report into `builtins.ts`, the worst of the six. | §8.2 AC-20, §7 | Fixed: AC-20 is restated against what this change controls — every **new** file under 1 000 lines, no modified file made materially worse, and the `/compact` body moved to `compaction/command.ts` with `builtins.ts` gaining only the registration (the `FastWiring` budget argument at `controller.ts:286-296`, applied one layer out). |
| **P1-13** | **Guards 3 and 4 can convert a recoverable overflow into a dead run.** The four guards are written as trigger-blind. But an `overflow` compaction is responding to a request the provider has **already proven impossible**, so a splice reclaiming "only" 10 % is strictly better than the alternative, and self-disabling after two such attempts guarantees the next request dies. As written, the anti-loop machinery can switch off the reactive path — the feature's whole answer to R-5 — in exactly the sessions that need it. | §3.8, §3.5 | Fixed: guard 3 (progress) **advises but never vetoes** an `overflow` compaction, and guard 4's self-disable suppresses only the **pressure** trigger; the reactive path stays live, bounded by `maxPerRun` and by P0-1's now-real one-shot flag. An overflow retry additionally halves `keepRecentTurns` for that attempt only (floor 1), which is the one lever that can make a too-large tail fit. Recorded as **D-24**; new AC-12a. |

### P2 (fixed where the fix was one line; otherwise recorded)

| # | Finding | Disposition |
|---|---|---|
| **P2-1** | `turnIndex` is read by `CompactionProbe` and passed in three call sites but never declared or incremented anywhere in `runAgentLoop` — and guard 1's cooldown is measured in it. | Fixed in §3.3: declared beside `lastUsage`, incremented once per iteration, semantics stated. |
| **P2-2** | `COMPACTION_LIMITS.statusCompactCols: 90` diverges from all four existing peers, which are `100` (`retry-view.ts:26`, `fast/limits.ts:95`, `team/limits.ts:86`, `todo/limits.ts:44`), with no reason given. A per-chip breakpoint ladder that is nearly-but-not-quite uniform is a reading hazard for no gain. | Fixed: `100`. |
| **P2-3** | §3.6.3's digest budget multiplies by `CHARS_PER_TOKEN`, which is **module-private** in `output-limits.ts:311`. The CLI cannot import it, so it would grow a second copy — two chars/token constants that must agree and nothing checking that they do. | Fixed: core exports it (fourth name in the C-6 three-sync list, §4.1). |
| **P2-4** | §6.2 says red means "compaction is imminent", but `thresholdColor` is `pct > high` (exclusive) while the trigger is `ratio >= threshold` (inclusive), so with `high = threshold` the red band is only ever displayed when compaction did **not** run. | Fixed: the operators are preserved byte-for-byte and the *meaning* is corrected — red now reads "over the threshold and compaction did not or could not run", which is the more useful thing for it to mean. |
| **P2-5** | §7's `schema.ts` row does not say `compaction` is the **NINTH** nested object nor restate the "scalars only" rule that all eight existing rows carry, and §4.2 says `warnThreshold` is clamped "jointly" without fixing the order. | Fixed in §4.2 / §7. |
| **P2-6** | §7 describes `summarize-call.ts` as "one bounded call" without saying whether it streams. The fast reviewer uses `registry.complete()` (`providers/index.ts:120`), which is the right precedent — nothing consumes a summary incrementally. | Fixed in §3.6.4. |
| **P2-7** | The §6.3 card mock contains literal `→` and `⤓`. `ui/` is inside `glyphs.test.ts::inScope`, so both must resolve through `glyphs.ts` — the arrow through the existing `arrowRight`, not just the new glyph. | Fixed in §6.3. |
| **P2-8** | `fast.enabled` defaults to **`false`** and `resolveFastTier` returns `{ok:false,reason:'disabled'}` on that alone (`fast/resolve.ts:41`), so with `useFastTier: true` the **default** summarizer is the session's main model — a ~30 k-token main-model call the user did not ask for. §3.6.4 reads as though the cheap path were the common one. | Fixed in §3.6.4 / §4.2: said plainly, with the cost consequence and the one key that changes it. |
| **P2-9** | `/clear` clears the view but not `messages` (§1.1), so compaction can fire against a visually empty transcript. Nothing is wrong, but the card and the notice must not read as though they describe what is on screen. | Fixed: one line in §6.4. |
| **P2-10** | §1.2 cites `no-host-coupling.test.ts` as keeping "core free of host knowledge". What it actually asserts is narrower and worth quoting precisely, because rule 2 (no `node:*` imports outside one grandfathered file) is the one that constrains `compaction.ts`. | Fixed in §1.2. |
| **P2-11** | Two cross-references point at a **`§2.1` that does not exist** (the front matter and §1.2's last sentence); §2 is a flat `C-1`…`C-16` list with no subsections. A dangling pointer to the section that supposedly records the rejected alternatives is the one a sceptical reader follows first. | Fixed: both now point at §3.3 and D-1, which are where that argument actually lives. |

---

## 0. Requirement trace (需求映射)

| # | Requirement (as given) | Where it is satisfied |
|---|---|---|
| **R-a** | 「这个项目对应的 Agent 执行功能，现在缺少上下文自动压缩的功能」 | §3 as a whole — a `ContextManager` port in the engine loop plus a CLI-side compactor |
| **R-b** | 「当上下文使用量达到最大上下文长度的 90% 以后，自动触发压缩机制」 | §3.4 the pressure formula and the trigger, `compaction.threshold` default `0.9` (§4.2); §3.4.3 the headroom co-trigger that makes 90 % correct on a *small* window too |
| **R-c** | 「类似 claudecode / codex 那样」 | §3.6 the summarize-and-splice shape, §3.6.5 the goal anchor, §4.4 the `/compact` command with free-text steering, §3.5 the reactive `context_overflow` recovery |
| **R-d** | 「压缩的时候，用户 TUI 界面上要有对应的内容显示，告诉用户正在压缩上下文」 | §6 — three surfaces: the activity row (live), the status-bar gauge/chip (state), the transcript card (record). §6.5 says which one is the *guaranteed* one |
| **R-e** | 「Anthropic 的顶级产品；美观、优雅、顶级设计、符合人机交互最佳实践」 | §6, and specifically §6.1's rule that the run never goes silent and never shows two spinners, which is this package's existing law |
| **R-f** | 「稳健、可靠、顶级」 | §3.7 the failure ladder (summarize → retry → mechanical truncation, never a wedged run), §3.8 the four anti-loop guards, §5.3 structural validation of every spliced history, §9 risks |

---

## 1. Overview

### 1.1 What is being built

A session's conversation grows monotonically. `MessageManager` is an append-only
array (`packages/core/src/engine/message-manager.ts:12`), `runAgentLoop` pushes
one assistant message and one `tool_result` per tool call on every iteration
(`agent-loop.ts:189`, `:263`), and **nothing anywhere removes a message**. The
only two ways a history shrinks today are `/clear` (which clears the *view*, not
`messages`) and `/reset` (which throws the whole conversation away). So a long
agentic run has exactly one ending available to it when the window fills: an
HTTP 400 classified as `context_overflow` (`llm/provider.ts:186`), surfaced by
`formatStreamError` as *"Context length exceeded - start a new conversation with
/reset"* (`agent/reducer.ts:681`). The product's answer to running out of context
is currently **"throw away everything you were doing."**

This feature replaces that with **automatic compaction**: when the conversation
occupies ≥ 90 % of the model's context window, the engine pauses at a turn
boundary, hands the history to a **summarizer model**, and swaps the older part
of the conversation for a compact, structured summary — keeping the user's
original task verbatim and the most recent turns verbatim. The run then
continues in the same turn loop, with the same tools, the same todo list and the
same working directory. Nothing about the session restarts.

Three capabilities ship together, and they are three because the failure they
each cover is different:

1. **Proactive compaction (§3.4).** Measured occupancy crosses the threshold →
   compact *before* sending the next request. This is the requirement as stated,
   and it is the one that fires 99 % of the time.
2. **Reactive compaction (§3.5).** The provider returns `context_overflow`
   anyway — because the static `contextWindow` was wrong, because the session
   points at a proxy with a smaller real window, or because a single tool result
   was larger than the headroom. The engine compacts once and re-sends the turn
   instead of ending the run.
3. **Manual compaction (§4.4).** `/compact [instructions]`, for the user who can
   see the gauge at 80 % and knows the next step is expensive.

### 1.2 Why this shape

**The policy is in the CLI; the mechanism is in the engine.** The engine does not
know what a context window is — `Agent` holds a `ModelRef`, never a `ModelInfo`
— and it must not learn, because `ModelRegistry` lives one layer up. The guard
that actually bites here is `no-host-coupling.test.ts` **rule 2**: no file under
`packages/core/src/` may import from `node:*`, with exactly one grandfathered
exception (`llm/providers/google.ts`). That is why `engine/compaction.ts` is pure
— no clock, no filesystem, no `process` — and why the summarizer call, the
timeout and every table lookup live on the CLI side of the port. (Rules 1, 3 and
4 of that file are about host path aliases and brand strings and are not
load-bearing for this feature; v1 paraphrased all four as "host knowledge", which
is looser than what is checked.) The CLI
already resolves `ModelInfo.contextWindow` for the status bar
(`App.tsx:2184`). So the engine gains **one injected port** it calls at a turn
boundary, and every decision — the threshold, which model summarizes, what the
summary asks for, what happens on failure — is made on the CLI side of that
port. This is the same dependency-injection posture the README claims for the
whole engine ("you supply the provider registry, an API-key resolver, the tool
list, and the model reference").

**The engine owns structural validity, and only that.** A compacted history that
strands a `tool_result` without its `tool_call` is an immediate HTTP 400 on
Anthropic: `convertMessages` emits one `user` message carrying a
`tool_use_id` per `tool_result` (`providers/anthropic.ts:471-484`), and the API
rejects a `tool_use_id` with no `tool_use` before it. That failure is not
recoverable by the host and must not be recoverable *by policy* — so the engine
validates whatever the port hands back and **refuses to adopt an invalid
history**, continuing with the original. A host bug becomes "compaction did not
happen" rather than "the session is now permanently un-sendable."

**Compaction happens at a turn boundary, inside the loop, never at
`agent_end`.** This is the reason the feature cannot be CLI-only. The CLI's
existing optional subsystems (`fast/`, `todo/`, `team/`) all hang off
`controller.subscribe` and act between runs. But a 40-turn tool-heavy run never
reaches `agent_end` until it is over, and the window fills *during* it. A
compactor that could only act at `agent_end` would watch the run die and then
tidy up afterwards. §3.3 records why the checkpoint's exact placement inside the
iteration is load-bearing in three separate ways, and D-1 records the rejected
`agent_end` alternative. *(v2: v1 pointed both of these at a `§2.1` that does not
exist — §2 is a flat C-1…C-16 list. P2-11.)*

### 1.3 Non-goals (feature v1 — not to be confused with this document's version)

- **No tokenizer dependency.** Occupancy comes from the provider's own reported
  usage when there is any, and from core's existing crude
  `estimatePromptTokens` (`llm/output-limits.ts:348`) when there is not. Adding
  `tiktoken` to buy 5 % accuracy on a number that already has a 10 % safety
  margin is not a trade this package makes.
- **No learned context ceilings.** `output-limits.ts` has a whole
  learn/rank mechanism for *output* ceilings (`learnModelCeiling`, ranks
  `discovery` / `recovery`). The symmetric thing for context windows is
  attractive and is deliberately out of scope: §3.5's reactive path already
  keeps a wrong window from ending a run, and a learning cache is a second
  source of truth to get wrong. Recorded in §10 as D-14.
- **No multi-level / hierarchical summaries.** A second compaction summarizes
  the previous `<compacted_context>` block along with everything after it. There
  is no summary-of-summaries tree.
- **No sub-agent compaction.** `TeamRuntime` children get their own `Agent`
  instances; they are short-lived and bounded by `team.dispatchTimeoutMs`. They
  inherit no `ContextManager` in v1 (§3.9), which keeps a dispatch's cost
  predictable. Recorded as D-15.
- **No persistence of the pre-compaction history.** `/save` writes what the
  engine holds. A compacted session saves compacted. The dropped messages are
  gone, and §6.4 makes that visible in the transcript rather than silent.

---

## 2. Constraints inherited from the existing code

Each of these was read, not assumed. They are listed because the design is
shaped by them and a future reader who "simplifies" past one of them will
produce a silent failure.

- **C-1 — `MessageManager` has exactly one mutating replacement path.**
  `restore(messages)` (`message-manager.ts:33`) copies the array; `Agent`
  exposes it as `replaceMessages` (`agent.ts:304`). There is no splice, no
  removal, and no index-based mutation. Compaction is therefore always
  *replace-the-whole-array*, which is also the only shape that can be validated
  atomically.
- **C-2 — the loop re-reads `messages` on every iteration.**
  `agent-loop.ts:148` calls `ctx.messageManager.getAll()` fresh each pass, so a
  replacement performed before that line is picked up with no further plumbing.
  This is what makes the seam a one-line insertion.
- **C-3 — `Agent.emit()` is synchronous, per-listener `try/catch`, and it kicks
  the watchdog** (`agent.ts:340-354`). A listener that throws cannot break the
  loop, and every emitted event resets the idle window.
- **C-4 — the idle watchdog aborts the run after 60 s of no events**
  (`DEFAULT_IDLE_TIMEOUT`, `agent.ts:97`). A summarization call is a normal LLM
  call and can exceed that. `applyRetryWatchdogPolicy` (`agent.ts:372`) is the
  precedent and the shape: pause on the "we are deliberately waiting" event,
  resume on the "we are moving again" event, both idempotent, and `stop()`
  clears `paused` so an abort during the wait cannot leave it deaf.
- **C-5 — `reduceStreamEvent` and `reduceEvent` both end in
  `default: return []`** (`reducer.ts:599`, `:666`). New core events are
  forward-compatible with every existing consumer by construction, which is what
  makes adding two `AgentEvent` members a non-breaking change.
- **C-6 — `public-api.test.ts` freezes core's *runtime* exports** and states a
  three-sync discipline (barrel → `EXPECTED` → `API.md` + `CHANGELOG.md`).
  `export type` declarations are erased and out of scope. So the type-only
  additions in §5.1 cost nothing there; the two pure functions in §5.3 do, and
  §7 lists all three files.
- **C-7 — `glyphs.test.ts::inScope` is a hardcoded directory list**
  (`__tests__/glyphs.test.ts:208-217`): `ui/` plus
  `^(agent|boot|commands|config|diagnostics|exec|fast|session|team|todo|tools|update)/`.
  A new `compaction/` tree is **invisible to the scanner until it is added to
  that regex**, and a scanner that silently stops scanning is worse than no
  scanner. Adding the tree and adding the word are the same change (this is the
  trap `fast-model-tier` recorded as its C-4).
- **C-8 — `normalizeLoadedEntries` (`session/persist.ts:178`) already carries
  four clauses**, all of them the same bug: an entry that can be saved in a
  *live* state never settles on resume, and `Transcript`'s settled boundary is
  **monotonic** (`Transcript.tsx:75-114`), so it re-renders the whole tail on
  every frame for the rest of the session. A fifth live entry kind needs a fifth
  clause.
- **C-9 — `entryRevision` (`ui/layout/virtual-window.ts:70`) and
  `estimateRows` (`:200`) are two separate switches over `Entry['kind']`.** Both
  must gain a case. `entryRevision` must be O(1) and must change whenever the
  rendered output changes (I-L3-1 there).
- **C-10 — `CliConfig` and `PersistedConfig` are two shapes and a key must be in
  both.** The file says so four times in four different comments
  (`schema.ts:1413`, `:1424`, `:1476`, `:1586`): a key added only to the
  persisted shape round-trips through `config set`, appears in `config list`,
  and never reaches the code that reads `config.*`. Nothing fails; the setting
  simply does nothing.
- **C-12 — `AgentController` builds the `Agent` before every optional subsystem,
  and that order cannot be reversed.** `this.agent = new Agent({...})` is at
  `controller.ts:536`; `this.fast = fastRegistered ? new FastWiring({...})` is at
  `:572`, under a comment that states the reason: "`FastWiring` subscribes to the
  lead's event stream, so it cannot be built before the `Agent`." Any subsystem
  that must be *inside* the `Agent`'s constructor argument therefore cannot also
  subscribe to the `Agent` in its own constructor. Compaction needs both — the
  port goes in, and `compaction_end` / `agent_start` come out — so it is split:
  **construct before, attach after** (§3.2). A field assigned after the `new
  Agent` call and spread into it conditionally produces a build where the feature
  is registered, enabled, and silently absent; `toolOutputs`' comment at
  `:265-280` documents that exact shape of failure for the live-output store.
- **C-13 — a persisted boolean needs BOTH commander forms, positive first.**
  `cli.tsx` states this seven times (`:1605-1650`): declaring only `--no-x` makes
  commander default `opts.x` to `true`, at which point the flag cannot be told
  apart from its own default and overwrites `config.json` on every run that
  passed nothing. `--update` / `--no-update` carries the sharpest version of the
  note ("the kill switch for a feature that installs software would quietly
  un-set itself"), and `compaction.enabled` is in the same polarity: persisted,
  default `true`. Resolution reads `flags.compaction !== undefined`, never
  truthiness.
- **C-14 — only the Anthropic adapter populates the cache token fields, and
  `occupiedTokens` depends on that.** `TokenUsage.cacheReadTokens` /
  `cacheWriteTokens` are set in exactly one place (`anthropic.ts:139-141`), where
  they are genuinely **additive**: Anthropic's `input_tokens` excludes cached
  tokens. `openai.ts:207` sets `inputTokens = prompt_tokens` and `google.ts:137`
  sets it from `promptTokenCount`, and **neither ever writes the cache fields** —
  the identifiers do not occur in either file. That is what makes §3.4.1's sum
  safe today. It is not safe by construction: OpenAI's `prompt_tokens` already
  *includes* cached tokens, so mapping `prompt_tokens_details.cached_tokens` onto
  the existing field — which looks like a pure improvement — would double-count
  and fire compaction early on every OpenAI session. The invariant is therefore
  "these two fields are additive-only", it is asserted by a test (§8.1), and a
  provider that reports an inclusive total must add a *differently named* field.
- **C-15 — card expansion has two selection surfaces and both filter by kind.**
  `expandedToolIds` is keyed by entry id, so the *storage* is generic — but
  Ctrl+O picks `.reverse().find(e => e.kind === 'tool' || e.kind === 'team')`
  (`App.tsx:1625-1627`) and `/expand` filters `kind === 'tool'`
  (`builtins.ts:940`). A new expandable kind that is not added to a predicate
  renders its own "ctrl+o to expand" hint and then does nothing, while the
  keystroke expands some older card instead. Nothing errors.
- **C-16 — six of the files this feature touches are already over the 1 000-line
  guideline.** Measured in this tree: `App.tsx` 2 235, `cli.tsx` 1 929,
  `schema.ts` 1 730, `reducer.ts` 1 673, `controller.ts` 1 443, `builtins.ts`
  1 204. `CLAUDE.md`'s cap is real and `controller.ts:286-296` records it being
  used as a live budget argument ("this one had 40 to spare when the design was
  written"), so the discipline this feature must honour is *don't make them
  worse*: new behaviour goes into new files under `src/compaction/`, and the
  existing six get registrations and forwarders only.
- **C-11 — "compact" is already taken.** `DensityMode` is
  `'comfortable' | 'compact'` (`schema.ts:98`), `statusCompactCols` in four
  `limits.ts` files means "narrow terminal", and `estimateRows` has a live
  comment reading "`compact` never spends it at all" about *density*. A config
  section named `compact` next to `density: 'compact'` is a permanent reading
  hazard. **This feature therefore spells itself `compaction` everywhere in
  code** — directory `src/compaction/`, config section `compaction`,
  `COMPACTION_LIMITS`, entry kind `'compaction'`. The user-facing slash command
  stays `/compact`, because that is the name users arrive with (D-13).

---

## 3. Technical design

### 3.1 Module map

```
packages/core/src/engine/
  context-manager.ts   NEW  the injected port: types only, zero logic
  compaction.ts        NEW  pure mechanics: safe cut points, plan, validate
  agent-loop.ts        MOD  the pressure checkpoint + overflow recovery
  agent.ts             MOD  accept + forward the port; watchdog policy
packages/core/src/
  types.ts             MOD  compaction_start / compaction_end
  index.ts             MOD  barrel

packages/cli/src/compaction/
  limits.ts            NEW  COMPACTION_LIMITS (structural) + block version
  types.ts             NEW  CompactionEvent / CompactionSnapshot / records
  pressure.ts          NEW  occupiedTokens(), computePressure(), shouldCompact()
  digest.ts            NEW  history -> bounded plain-text transcript
  summary-prompt.ts    NEW  the summarizer system prompt + the splice block
  summarize-call.ts    NEW  one bounded LLM call, no tools, temperature 0
  compactor.ts         NEW  ContextManager impl: decide, call, assemble, emit
  wiring.ts            NEW  flags, resolution, event fan-out, /compact status
  command.ts           NEW  the /compact handler and its status report (C-16)
packages/cli/src/ui/entries/
  CompactionCard.tsx   NEW  the transcript card
```

`command.ts` is a v2 addition and it is a budget decision, not taste (C-16 /
P1-12): `/compact` has six forms and the longest status report in the package,
and `builtins.ts` is already 1 204 lines. It exports one `run(ctx)`; `builtins.ts`
gains the four-line registration and nothing else — the same split
`controller.ts:286-296` argues for `FastWiring`, one layer out.

Everything the CLI adds is CLI-local, in the shape `fast/` already established:
one `*Wiring` class holding the flags and the lifetime, one field plus thin
forwarders on `AgentController`, a CLI-local event stream, and a `*_LIMITS`
object that is the single authority on every structural bound.

### 3.2 The port

```ts
// packages/core/src/engine/context-manager.ts — TYPES ONLY, no logic.

/** What the engine can cheaply tell the host at a turn boundary. */
export interface CompactionProbe {
  readonly messageCount: number;
  /**
   * Authoritative usage of the most recently COMPLETED turn, or `undefined`
   * before the first one (a fresh run, or the first turn after `/resume`).
   *
   * THE HOST MUST HANDLE `undefined` (§3.4.2). It is not an edge case: the most
   * dangerous single moment in this feature's life is the first request of a
   * resumed 180 k-token session, where there is no usage to read and the naive
   * answer is "0 %".
   */
  readonly lastUsage?: TokenUsage;
  /** 1-based index of the turn that is about to be sent. */
  readonly turnIndex: number;
  readonly trigger: CompactionTrigger;
}

export type CompactionTrigger = 'pressure' | 'overflow';

export interface CompactionContext extends CompactionProbe {
  /**
   * A SHALLOW COPY of the engine's history, never the live array (P1-2).
   *
   * `MessageManager.getAll()` returns the internal array itself
   * (`message-manager.ts:20-22` — the "readonly view" in its doc comment is a
   * TYPE, not a copy). Passing that across the port would let a host that sorts,
   * splices or truncates it corrupt engine state in place, BEFORE the structural
   * gate at §3.3 step 5 can look at it — which would defeat the one job the
   * engine has in this feature. One array allocation per compaction, i.e. at
   * most `maxPerRun` per run, buys the whole guarantee.
   */
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly model: ModelRef;
  /**
   * The run's signal. The host MUST forward it into its own LLM call.
   *
   * The engine does not TRUST that it does: `runCompaction` races this promise
   * against the signal and against a hard ceiling (§3.3), because the watchdog is
   * paused across the call and a non-settling promise would otherwise hang the
   * run with the idle detector switched off (P1-3).
   */
  readonly signal: AbortSignal;
}

export type CompactionOutcome =
  | { action: 'keep'; reason: string }
  | {
      action: 'replace';
      messages: Message[];
      mode: 'summarized' | 'truncated';
      /** For the event; the engine does not interpret it. */
      summary?: string;
      reason?: string;
    };

export interface ContextManager {
  /**
   * SYNCHRONOUS, CHEAP, SIDE-EFFECT FREE. Called once per turn, before the LLM
   * request is built.
   *
   * IT IS SYNCHRONOUS SO THAT "OFF" AND "BELOW THRESHOLD" COST NOTHING (I-2).
   * A single async port would put an `await` — a microtask tick and a promise
   * allocation — on every turn of every run for a decision that is `false`
   * more than 99 % of the time, and would make it impossible to state that a
   * session below the threshold is byte-identical to a pre-feature build.
   */
  shouldCompact(probe: CompactionProbe): boolean;

  /**
   * Only called when `shouldCompact` returned `true`.
   *
   * MUST NOT THROW. The engine wraps the call defensively anyway (§3.3 step 4),
   * because a host that breaks its own contract must degrade to "compaction did
   * not happen", never to "the run died" — but a throwing implementation is a
   * bug on the host side and is logged as one.
   */
  compact(ctx: CompactionContext): Promise<CompactionOutcome>;
}
```

`AgentConfig` gains `contextManager?: ContextManager`. `Agent` stores it and
forwards it on `AgentLoopContext`. There is **no setter**: the CLI's
implementation reads its own config live through closures, which is the idiom
`FastWiring` already uses (`fast/wiring.ts:59-61`, "Read LIVE on every call").

#### 3.2.1 Construct before, attach after (C-12 / D-19)

The port has to be **inside** the `Agent`'s constructor argument, and the wiring
has to **subscribe** to the `Agent`. `AgentController` cannot do both in one step:
`new Agent({...})` is at `controller.ts:536` and every optional subsystem is
built after it, precisely because `FastWiring`'s constructor subscribes.

So `CompactionWiring` is split, and this is the whole of it:

```ts
// controller.ts — BEFORE `new Agent(...)`. Needs no agent reference to exist:
// only live config, the one key resolver, the price table and a notifier.
this.compaction = compactionRegistered
  ? new CompactionWiring({
      getConfig: () => this.config,                      // LIVE, the fast idiom
      hasKey: (id) => this.hasApiKey(id),
      getApiKey: (id) => this.resolveKey(id),
      getModelInfoFor: (ref) => this.getModelInfoFor(ref),
      isPricedModel: (ref) => this.isPricedModel(ref),
      notify: (level, text) => deps.notify?.(level, text),
    })
  : null;

this.agent = new Agent({
  ...,
  // `undefined` WHEN OFF, which is what makes AC-1's byte-identity claim true:
  // the loop's gate is `if (!ctx.contextManager) return false` against a field
  // that is genuinely absent — not a live object whose predicate says no.
  ...(this.compaction ? { contextManager: this.compaction.manager() } : {}),
});

// AFTER `new Agent(...)`. `CompactionWiring`'s CONSTRUCTOR MUST NOT SUBSCRIBE —
// that is the constraint that makes the split work, and it is why this call is
// separate rather than a `subscribe` dep like `FastWiring`'s.
this.compaction?.attach((l) => this.agent.subscribe(l));
```

`attach` is what lets the wiring see `compaction_end` — the engine's `applied`
verdict, which the compactor cannot know because validation happens after it
returns — and `agent_start`, which resets guard 2's per-run counter. It is
idempotent and returns nothing; `dispose()` unsubscribes, beside
`this.fast?.dispose()` at `controller.ts:1062`.

`manager()` returns a **stable** object for the controller's lifetime, so the
`Agent` never needs a setter and `contextManager` is never reassigned. Its two
methods delegate to the wiring, which reads config live — so `/compact off`,
`/compact threshold 0.8` and a settings-screen save all take effect mid-session
without touching the `Agent`.

### 3.3 The engine seam

One new step at the top of each loop iteration, **after** the steering
checkpoint and **before** `turn_start`:

```ts
// agent-loop.ts, inside `runAgentLoop` — all three hoisted ABOVE the while.
let lastUsage: TokenUsage | undefined;
let turnIndex = 0;
// NOT RESET AT THE TOP OF THE LOOP (P0-1). See the note under this block.
let overflowRecovered = false;

while (!ctx.signal.aborted) {
  // ----- Steering checkpoint (unchanged, agent-loop.ts:126) -----
  ...

  turnIndex += 1;   // 1-based, ONE PER ITERATION — guard 1's cooldown unit.

  // ----- Context pressure checkpoint (NEW) -----
  await runCompaction(ctx, { trigger: 'pressure', lastUsage, turnIndex });
  if (ctx.signal.aborted) break;

  ctx.emit({ type: 'turn_start' });
  ...
  // ----- Turn end (agent-loop.ts:188) -----
  ctx.emit({ type: 'turn_end', message: assistantMessage, usage });
  // THE TWO LINES THE PROBE DEPENDS ON. Without the first, `lastUsage` is
  // forever `undefined`, every trigger runs on the crude estimate, and the
  // status bar and the trigger diverge — the exact defect §3.4.1 exists to
  // close, reintroduced silently (P1-1). Without the second, the one-shot
  // overflow guard never clears and a session that recovered once can never
  // recover again in the same run.
  lastUsage = usage;
  overflowRecovered = false;
  ctx.messageManager.push(assistantMessage);
  ...
```

**`overflowRecovered` is cleared here, not at the top of the loop, and that is
load-bearing (P0-1).** §3.5's recovery ends in `continue`, which re-enters the
`while` — so a top-of-loop reset would clear the flag on the way back in and the
"one shot per turn" property would not exist at all. Clearing it after a stream
*completes* is the correct expression of the intent: the flag means "this turn has
already spent its one overflow recovery", and a turn that never produced a `done`
event has not finished. `maxPerRun` would still bound the money, but the guard the
prose promises has to be the guard the code has.

`turnIndex` is likewise declared here rather than assumed (P2-1): guard 1's
cooldown is measured in it, and a probe field with no producer is a guard with no
teeth. It counts **loop iterations**, so an overflow `continue` consumes one — a
deliberate choice, because it makes the cooldown cover the re-send pass too.

**Placement is load-bearing in three ways.**

1. *After* the steering drain, so a message the user just steered in is part of
   the history being measured and is inside the retained tail by construction
   (it is the newest message). Compacting before the drain would measure a
   history that is about to grow and could, in the pathological case, summarize
   away a message the user typed one second earlier.
2. *Before* `turn_start`, so the UI reads compaction as a phase of its own
   rather than as a stall inside a turn. The activity row's whole job is to say
   "the silence is work" (`ActivityLine.tsx:22`); it must be able to say *which*
   work.
3. *Inside* the `while`, not before it. A run that starts under the threshold
   and crosses it at turn 12 is the normal case, and it is the case an
   `agent_end`-based design cannot serve at all.

`runCompaction` is a private function in `agent-loop.ts`:

```ts
/**
 * A CEILING, NOT A POLICY (P1-3). It must sit STRICTLY ABOVE the largest wall
 * clock a well-behaved host can legitimately spend, or it starts firing on
 * correct hosts and the ladder's rungs stop being reachable. §3.7's worst legal
 * case is two `callTimeoutMs` calls back to back (45 s + 45 s = 90 s) plus the
 * digest render, so 90 s would be exactly the boundary — this is 120 s, leaving
 * 30 s of slack. It is deliberately longer than `DEFAULT_IDLE_TIMEOUT` (60 s):
 * the watchdog is paused across the call, so this is the only clock running.
 */
const COMPACTION_HARD_TIMEOUT_MS = 120_000;

async function runCompaction(ctx, params): Promise<boolean> {
  const cm = ctx.contextManager;
  if (!cm) return false;                                    // 1. off: zero cost

  const probe = { messageCount: ctx.messageManager.length, ...params };
  if (!cm.shouldCompact(probe)) return false;               // 2. sync gate

  // A SHALLOW COPY, NOT THE LIVE ARRAY (P1-2). `getAll()` hands back the
  // internal array; `as Message[]` would launder away the only thing stopping a
  // host from mutating engine state in place, before step 5 can see it.
  const before = [...ctx.messageManager.getAll()];
  ctx.emit({                                                // 3. pauses watchdog
    type: 'compaction_start',
    trigger: probe.trigger,
    messageCount: before.length,
  });

  const started = Date.now();
  let outcome: CompactionOutcome;
  try {                                                     // 4. never throws out
    // BOUNDED AND RACED, because step 3 just switched the idle detector OFF
    // (P1-3). `IdleWatchdog.pause()` makes `kick()` a no-op (`watchdog.ts:22`),
    // so an `await` with no ceiling here is strictly worse than the pre-feature
    // behaviour: a host that returns a non-settling promise hangs the run AND
    // there is nothing left to notice. Racing the signal is the other half —
    // abort only unblocks the await if the host forwards it, and "the host is
    // correct" is exactly the assumption this whole function refuses to make.
    outcome = await raceCompaction(
      cm.compact({ ...probe, messages: before, systemPrompt: ctx.systemPrompt,
                   model: ctx.model, signal: ctx.signal }),
      ctx.signal,
      COMPACTION_HARD_TIMEOUT_MS,
    );
  } catch (err) {
    outcome = { action: 'keep', reason: `manager_threw: ${errText(err)}` };
  }
  // `raceCompaction` resolves to `{action:'keep', reason:'manager_timeout'}` or
  // `'aborted'` rather than throwing, so the two ladder rungs stay distinguishable
  // in the event and in the log. The losing promise is left to settle on its own;
  // its result is dropped, and it cannot reach `restore` because `applied` is
  // decided here.

  let applied = false;
  let reason = outcome.action === 'keep' ? outcome.reason : undefined;
  if (outcome.action === 'replace') {
    // Positional `previousLength` is supplied so the `grew` rung is live (§5.3).
    const check = validateHistory(outcome.messages, { previousLength: before.length });
    if (check.ok) {                                          // 5. STRUCTURAL GATE
      ctx.messageManager.restore(outcome.messages);
      applied = true;
    } else {
      reason = `invalid_history: ${check.reason}`;
    }
  }

  // IN A `finally` IN THE REAL IMPLEMENTATION. `compaction_end` is what resumes
  // the watchdog (below), so it must be emitted on every exit from this function
  // — including a `throw` that escapes the two guards above. A compaction that
  // failed to emit its `end` leaves the run permanently deaf.
  ctx.emit({ type: 'compaction_end', applied, reason, ... , durationMs: Date.now() - started });
  return applied;
}
```

**Step 5 is the whole reason the engine is involved at all** and must never be
reduced to trusting the host. §5.3 defines `validateHistory`. Four conditions,
any of which rejects: an orphan `tool_result`; an assistant `tool_call` with no
matching later `tool_result`; an empty array; a history that grew
(`after.length > before.length`, which is not a correctness failure but is
always a bug, and adopting it would let a broken compactor amplify the very
problem it exists to solve).

**Watchdog.** `Agent.applyRetryWatchdogPolicy` is widened (and renamed
`applyWatchdogPolicy`) to cover the two new events:

```ts
if (event.type === 'compaction_start') this.watchdog.pause();
else if (event.type === 'compaction_end') this.watchdog.resume();
```

Applied **before** the listeners, exactly as the retry policy is and for the
identical reason spelled out at `agent.ts:341-345`: a subscriber that throws is
caught, but the policy still has to have been applied, or a 40-second
summarization is read as 40 seconds of idleness and the run is aborted for being
idle while it is provably working. `stop()` already clears `paused`
(`watchdog.ts`), which bounds the leak if a run is aborted mid-compaction.

**Abort.** `ctx.signal` is handed to the host and re-checked immediately after
`runCompaction` returns. An Esc during summarization must not be followed by a
full-price request.

### 3.4 Proactive trigger — how "90 %" is computed

#### 3.4.1 The occupancy formula, and a defect it fixes

```ts
// packages/cli/src/compaction/pressure.ts
export function occupiedTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    usage.outputTokens
  );
}
```

The cache terms are not decoration. Anthropic's `message_start` reports
`input_tokens` **excluding** cached tokens and puts them in
`cache_read_input_tokens` / `cache_creation_input_tokens`
(`providers/anthropic.ts:139-141`). The CLI itself never sends `cache_control`,
so on a direct connection those are absent and the sum is unchanged — but any
gateway or proxy that caches on the user's behalf makes them non-zero, and
**today's status-bar gauge (`reducer.ts:1071`,
`contextTokens: usage.inputTokens + usage.outputTokens`) silently under-reports
context occupancy for exactly those users.** That is a live, pre-existing defect
in the number this feature is about to trigger on.

**This sum is only valid for *additive* cache fields, and that is a provider-side
invariant rather than a property of `TokenUsage` (C-14 / P1-10).** It holds today
because exactly one adapter writes those fields: `openai.ts:207` sets
`inputTokens = prompt_tokens` and `google.ts:137` sets it from
`promptTokenCount`, and neither ever mentions `cacheReadTokens` or
`cacheWriteTokens`. OpenAI's `prompt_tokens` **already includes** cached tokens,
so mapping `prompt_tokens_details.cached_tokens` onto the existing field — a
change that reads as a pure improvement and would sail through review — turns
this function into a double-count and makes compaction fire early on every OpenAI
session, with the gauge agreeing with it and nothing reporting a fault. The
invariant is therefore written down here, asserted by a test (§8.1), and the
remedy for an inclusive-total provider is a **differently named** field, never a
reinterpretation of these two.

**The gauge and the trigger must read the same function.** If they diverge, a
user watching 78 % on the status bar sees compaction fire, concludes the feature
is broken, and turns it off. So `reducer.ts`'s `turnEnd` case is changed to call
`occupiedTokens(action.usage)`, and the compactor calls it too. One function,
one number, one story.

#### 3.4.2 When there is no usage

`lastUsage` is `undefined` before the first `turn_end` of a run. That is not
rare and it is not safe: `/resume` restores a 180 k-token conversation and the
very first request of the new session is the one most likely to overflow.

Fallback: core's existing `estimatePromptTokens(messages, systemPrompt)`
(`llm/output-limits.ts:348`, already a public runtime export) — ~4 chars/token
plus 4 tokens of framing per message. It is documented there as "deliberately
crude… a guard rail, not an accounting function", which is precisely the job.

**But it is not crude symmetrically, and that matters (P1-11).** Read at
`output-limits.ts:348-356`: it counts `systemPrompt` and message bodies and
**nothing else**. The loop also sends `tools: toolDefs`
(`agent-loop.ts:147, 158`), which the provider's `input_tokens` includes and this
function does not — several thousand tokens for this CLI's toolset. So the
fallback is biased **low, always, in the one direction that hurts**: the resumed
180 k-token session §3.4.2 calls the most dangerous moment in the feature's life
is exactly where the estimate is used, and it reads lower than the truth.

Two numbers that disagree about their unit are the same defect R-11 claims to
close by sharing one function; sharing the function is necessary and not
sufficient. The fix is a **calibration offset**, carried on the same struct:

```ts
export interface Pressure {
  occupied: number;
  contextWindow: number;
  ratio: number;                       // occupied / contextWindow, clamped [0,1]
  headroom: number;                    // contextWindow - occupied
  source: 'usage' | 'estimate';
  /** The window came from `buildRuntimeModel`'s 128k placeholder, not a table. */
  windowKnown: boolean;
  /**
   * `occupiedTokens(lastUsage) - estimateOf(the history that produced it)`,
   * clamped to `>= 0`, or `undefined` before the first `turn_end`.
   *
   * The systematic part of the estimator's error — chiefly the tool schemas, plus
   * whatever the 4-chars/token average misses for this conversation's actual
   * vocabulary. It is re-measured on every `turn_end`, so it tracks a toolset
   * that changed mid-session (`/tools`, a skill that registers one).
   */
  estimateOffset?: number;
}
```

Everywhere an estimated figure is compared against a threshold or shown to a
user, it is `estimate + (estimateOffset ?? 0)`. That is three places and they are
all places the spec already had a claim about: the fallback trigger here, the
post-compaction gauge value (§6.2), and guard 3's projection (§3.8). Before the
first `turn_end` there is nothing to calibrate against and the raw estimate is
used — still under-reporting, but §3.4.3's headroom term is the belt for that
case and it does not depend on the ratio being accurate.

`source: 'estimate'` is carried, never re-derived, and it reaches the UI: the
status bar already renders a leading `~` when the window is unknown
(`StatusBar.tsx:197`), and this widens that to "the *number* is approximate
too". Honesty about a guess is cheaper than a support thread about a wrong
percentage — and a calibrated guess that still says `~` is the honest version of
both.

#### 3.4.3 The trigger, and why a ratio alone is wrong

```ts
export function shouldCompact(p: Pressure, cfg: CompactionConfig, req: Headroom): boolean {
  return p.ratio >= cfg.threshold || p.headroom < requiredHeadroom(req);
}

function requiredHeadroom(req: Headroom): number {
  return req.maxOutputTokens + THINKING_HEADROOM_TOKENS + CONTEXT_SAFETY_MARGIN_TOKENS;
}
```

`THINKING_HEADROOM_TOKENS` (4096) and `CONTEXT_SAFETY_MARGIN_TOKENS` (1024) are
existing core exports (`output-limits.ts:42`, `:48`) and are reused rather than
re-spelled.

The second term is not belt-and-braces. **90 % of a 200 k window leaves 20 k,
which is plenty. 90 % of a 32 k window leaves 3.2 k, which is less than a single
`max_tokens` of 8192 — the request is already impossible.** A pure ratio trigger
is therefore correct for the models most users run and quietly wrong for the
small ones, and "quietly wrong on the cheap models" is not a property an
Anthropic-grade product ships. Both terms, one `||`.

`req.maxOutputTokens` is the session's effective cap: `cfg.maxTokens` when the
user set one, else `DEFAULT_MAX_OUTPUT_TOKENS`.

### 3.5 Reactive trigger — surviving a wrong window

The static table is a guess for anything it has not seen: `buildRuntimeModel`
returns `contextWindow: 128_000` for every unknown model
(`model-registry.ts:141`). Point the CLI at a proxy in front of a 32 k model and
the proactive trigger will never fire before the API refuses the request.

So the streaming section of the loop gains one recovery:

```ts
try {
  for await (const event of stream) { ... }
} catch (err) {
  const type = (err as { errorType?: unknown })?.errorType;   // STRUCTURAL, not instanceof
  if (type !== 'context_overflow' || overflowRecovered || !ctx.contextManager) throw err;
  overflowRecovered = true;
  const applied = await runCompaction(ctx, { trigger: 'overflow', lastUsage, turnIndex });
  if (!applied) throw err;
  continue;                                                    // re-send this turn
}
```

Five details, and two of them are v2 corrections.

- **Structural check, not `instanceof LLMError`.** `retry.ts`'s
  `isRetryableError` already records why: the error may have crossed a module
  boundary or been rebuilt, and an identity check on the class is the version of
  this test that fails in production and passes in the unit test.
- **One shot per turn** (`overflowRecovered`), *and* the per-run cap of §3.8
  still applies. Two compactions in a row that both fail to make the request fit
  mean the tail alone is too big, and looping on that spends real money to
  produce the same 400. **This only works because the flag is cleared after a
  completed stream and not at the top of the loop — the `continue` below re-enters
  the `while`, so a top-of-loop reset makes this bullet a fiction (P0-1, §3.3).**
- **The user must not be told to `/reset` on a path that recovers (P1-4).**
  `agent-loop.ts:170` emits `message_update` for *every* stream event before the
  `error` branch throws at `:175-177`, and `reduceStreamEvent`'s `case 'error'`
  (`reducer.ts:637-644`) turns that into a `level: 'error'` notice whose text is
  `formatStreamError`'s `context_overflow` string — *"Context length exceeded -
  start a new conversation with /reset."* (`:681-682`). So the happy path of this
  entire section ends with a red banner telling the user to throw away the session
  we just saved, one frame before saving it. The fix is on the CLI side and is
  one reducer clause: `compactionStart` with `trigger: 'overflow'` **rewrites**
  a trailing `context_overflow` error notice in place, to
  `level: 'info'` / *"Context window exceeded - compacting and retrying."*
  (§5.5). It rewrites rather than removes, because an entry that vanishes from
  `entries` is an entry `<Static>` has already printed and cannot un-print; and it
  matches on the notice being the tail entry so it can never touch an older,
  genuine error. If recovery then fails, the ladder's own error notice (§3.7 rung
  4, or the re-thrown 400) is what the user is left with — so the honest outcome
  is preserved in both directions.
- **Nothing is stranded.** `context_overflow` is a 400 on the request; the
  stream never opened, so no assistant message was pushed
  (`agent-loop.ts:189` is far below) and no partial content was emitted. The
  reducer's `compactionStart` action nevertheless seals any live `streamingId`
  entry defensively — for the same reason `session/persist.ts` carries four
  normalization clauses: an entry that never settles pins `Transcript`'s
  monotonic boundary and re-renders the tail forever (C-8). That defence is not
  hypothetical: `provider.ts:170-171` records that Anthropic can also deliver an
  error **in-stream**, after the connection is open and therefore after text
  deltas have already been emitted.
- **The anti-loop guards must not be able to switch this path off (P1-13).** An
  `overflow` compaction is answering a request the provider has already **proven**
  impossible, so the arithmetic that makes guard 3 sensible for the proactive
  trigger inverts here: a splice that reclaims "only" 10 % is strictly better than
  a dead run. §3.8 is therefore trigger-aware — guard 3 advises but never vetoes
  an overflow compaction, and guard 4's self-disable suppresses the **pressure**
  trigger only.

### 3.6 What compaction actually does

#### 3.6.1 Find the cut

A cut index `i` splits the history into `head = messages[0..i)` (summarized and
dropped) and `tail = messages[i..]` (kept verbatim). `i` is **safe** iff, walking
from 0, the set of open tool calls is empty at the boundary before `i` **and**
`messages[i]` is not a `tool_result`.

```ts
// packages/core/src/engine/compaction.ts — PURE.
export function findSafeCutIndices(messages: readonly Message[]): number[] {
  const safe: number[] = [];
  const open = new Set<string>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (open.size === 0 && m.role !== 'tool_result') safe.push(i);
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_call') open.add(b.toolCallId);
    } else if (m.role === 'tool_result') {
      open.delete(m.toolCallId);
    }
  }
  if (open.size === 0) safe.push(messages.length);
  return safe;
}
```

The set-based walk rather than a role-pattern rule, because the history is not
always the clean `user → assistant → tool_result*` shape the loop produces.
Steering interruption pushes synthesized `tool_result`s for the *remaining*
calls in a batch (`agent-loop.ts:216-224`); CodeAct injects a bare `user`
message (`:329`); `/resume` restores whatever a file contained. A rule that
encodes the happy path is a rule that produces an invalid splice on the one
history that got interesting.

#### 3.6.2 Choose the cut

`planCompaction(messages, { keepRecentTurns, protectedPrefix })` walks
`findSafeCutIndices` backwards and returns the **largest** safe index that still
leaves at least `keepRecentTurns` complete turns in the tail, where a "turn" is
counted by `user`-role messages that are not tool results. It returns `null` when
`cutIndex <= protectedPrefix` — i.e. when the head would contain nothing but
material that is already structurally preserved and therefore nothing worth
dropping. §3.8 turns that `null` into a bounded, loud outcome rather than a retry
loop.

`protectedPrefix` (default `0`) is a **v2 addition and it is what makes repeated
compaction terminate cleanly (P1-9).** v1's condition was "the best cut is `0` or
`1`", which encodes an assumption about what messages 0 and 1 are. After one
compaction they are the goal anchor and the `<compacted_context>` block (§3.6.5),
so on the second pass the head can be exactly those two — a summary being
re-summarized with no new material, which produces a smaller, lossier record and
reports success. The host counts its own protected prefix (it is the host that
knows what an `<original_task>` message is) and passes the number; core stays free
of any knowledge of the block format, which is the §1.2 boundary. Hard-coding `1`
in core, or teaching core the tag, are both ways of putting host knowledge in the
engine to save a parameter.

#### 3.6.3 Build the digest

The head is rendered into a bounded plain-text transcript
(`compaction/digest.ts`) — **not** shipped as raw messages. Two reasons, and the
second one is the one that bites:

- Tool results are the bulk. Four 60 KB file reads are 240 KB of body that says
  almost nothing about what was decided.
- **The summarizer may have a smaller context window than the model being
  compacted.** The whole point of §3.6.4 is to use a cheap model, and cheap
  models are exactly the ones with 32 k windows. Sending 180 k of history to
  summarize would fail with the same error we are recovering from.

So the budget is `min(COMPACTION_LIMITS.digestMaxChars, (summarizerWindow -
COMPACTION_LIMITS.summarizerReserveTokens) * CHARS_PER_TOKEN)`, and rendering
clips per message kind. `CHARS_PER_TOKEN` is **module-private** in core today
(`output-limits.ts:311`), so §4.1 promotes it to a runtime export rather than
letting the CLI grow a second copy: two chars-per-token constants that must agree
and nothing checking that they do is how the digest budget and the occupancy
estimate drift apart (P2-3).

| kind | rendered as | clip |
|---|---|---|
| **prior `<compacted_context>` block** | `PRIOR SUMMARY: …`, tag stripped | **`summaryMaxChars` (6000)** — see below |
| `user` | `USER: …` | `userChars` (2000) |
| assistant text | `ASSISTANT: …` | `assistantChars` (2000) |
| assistant thinking | *dropped entirely* | — |
| assistant `tool_call` | `CALL <name>(<args>)` | `toolArgChars` (200) |
| `tool_result` | `RESULT[ok\|error] …` | `toolResultChars` (600) |
| image parts | `[image]` | — |

**The first row is a v2 addition and its absence was a silent, compounding data
loss (P1-9).** A `<compacted_context>` block is a `user` message (§3.6.5, and
deliberately so — D-5), so v1's table clipped it to `userChars` (2 000) while
§5.4 permits it to be `summaryMaxChars` (6 000) long. Every compaction after the
first would therefore have discarded up to two thirds of the previous summary
*before* summarizing it, and then reported `mode: 'summarized'`. §1.3 accepts that
a second compaction flattens the first one's output rather than building a tree;
it does not accept throwing most of it away. The digest recognizes the block by
its opening tag, carries the body whole, and the summarizer prompt is told
(§3.6.4) that a `PRIOR SUMMARY` section is an authoritative record to **merge and
carry forward**, not raw transcript to condense again.

Thinking blocks are dropped because they are the model's private scratch, they
are the single largest contributor at `thinkingLevel: high`, and nothing after
the turn depends on them. If the rendered whole still exceeds the budget,
**oldest entries are dropped first — except the `PRIOR SUMMARY`, which is
evicted last of all** (it is the densest thing in the head by construction; it is
already the compressed form of everything before it). A single line
`[... N earlier messages omitted from this digest ...]` is prepended, so the
summary can say that it is incomplete instead of pretending.

#### 3.6.4 Call the summarizer

One call through `ProviderRegistry.complete()` — **not** `stream()`; nothing
consumes a summary incrementally and the registry's `complete` is itself
`consumeStream(this.stream(...))` (`providers/index.ts:120`), which is the fast
reviewer's precedent (P2-6). No tools, `temperature: 0`, `thinkingLevel: 'off'`,
`maxTokens: COMPACTION_LIMITS.summaryOutputTokens` — the exact shape of
`fast/review-call.ts:110-125`, and for the same reasons stated there (the
`temperature: 0` / `thinkingLevel: 'off'` pair is one choice, because the
Anthropic adapter deletes `temperature` whenever a thinking budget is set,
`anthropic.ts:434-439`).

**Which model.** `compaction.useFastTier` (default `true`): if
`resolveFastTier(config, hasKey)` resolves, summarize with the fast tier;
otherwise use the session's main model. One key, and it leans on the single
existing authority for that question (`fast/resolve.ts`) rather than inventing a
second answer to "is there a cheap model here?".

**Say the default out loud (P2-8): for almost everyone the summarizer is the main
model.** `resolveFastTier` returns `{ok: false, reason: 'disabled'}` on
`fast.enabled !== true` alone (`fast/resolve.ts:41`), and `fast.enabled` defaults
to `false`. So `useFastTier: true` describes a *preference*, not the common path,
and the out-of-the-box first compaction is a ~30 k-token call **on the session's
own model** — real money on a frontier model, spent by a feature that is on by
default (D-16). Three things make that the right trade rather than a hidden cost:
it happens at most `maxPerRun` times per run, the alternative is losing the entire
run, and §6.4 puts the spend in `usageTotal` and on the card with the summarizer's
own price table. The user who wants it cheap sets `fast.enabled: true` and
`fast.model`, and the card then names the cheap model — which is also the sentence
the README has to contain (§11).

**Its own registry, fail-fast.** Like the fast reviewer (`fast/wiring.ts:210`),
the summarize call goes through `initProviders({ retryPolicy: { ...DEFAULT_RETRY_POLICY,
maxRetries: 1 } })`. Inheriting the user's `/retry` policy would let a
background repair compete with the user's own work for a rate-limited provider's
quota — and it would put ten backoffs inside a window the watchdog is paused
across.

**Bounded in wall clock.** `COMPACTION_LIMITS.callTimeoutMs` (45 s). Longer than
the fast reviewer's 20 s because the input is 30× larger and the output is 4×
larger, and because the cost of a timeout here is a degraded run rather than a
missing critique.

The system prompt asks for a fixed skeleton. Section headings are part of the
contract because the next model to read them is an LLM:

```
## Task            the user's original goal, and any revision to it
## Decisions       what was decided and why; one line each
## Files           path -> what changed / what is in it that matters
## Facts           commands, paths, APIs, values discovered — verbatim where exactness matters
## Open            what remains, in the order it should be done
## Pitfalls        what was tried and did not work, so it is not tried again
```

with a hard instruction to stay under `summaryMaxChars`, to prefer verbatim
identifiers over prose, to never invent a fact the transcript does not contain,
and to write in the language of the conversation.

One further clause, added in v2 alongside the digest's `PRIOR SUMMARY` row
(P1-9): **when the digest opens with a `PRIOR SUMMARY` section, that section is an
authoritative record of everything before it and must be merged and carried
forward, not re-condensed.** Facts, file paths and pitfalls already recorded there
are to be reproduced, not paraphrased away, and anything it marks as incomplete
stays marked. Without that clause the second compaction is a model deciding, with
no instruction either way, how much of a summary a summary needs — which is the
mechanism by which flattened summaries decay into nothing over a long run.

`compaction.instructions` (from `/compact <text>`) is appended as a
`## Focus` directive when present — the Claude Code affordance, and it is one
string concatenation.

#### 3.6.5 Assemble the new history

```
[ goal anchor (always its own message) ]  +  [ <compacted_context> block ]  +  tail (verbatim)
```

**The goal anchor.** The first `user` message of the conversation is preserved
verbatim and never summarized. This is the single highest-value rule in the
feature: a summarizer that is 90 % faithful is fine for the middle of a
conversation and catastrophic for the sentence that says what the user wanted.

**The anchor is ALWAYS its own leading message, and it is always structurally
identifiable. Both halves of that sentence are v2 corrections and they close a
real defect (P1-9).** v1 had two shapes — merged into the block when short and
plain, standalone otherwise — and identified the anchor as "the first `user`
message of the conversation". Those two rules are not composable across repeated
compactions, because after the first compaction the first user message **is** the
compacted block:

- In the merged shape, the second compaction reads a *summary* and promotes it to
  "the user's original task", preserved verbatim forever while the actual task
  sentence is inside it and re-summarizable.
- In the standalone shape, `anchorChars` is 4 000 and a block may be
  `summaryMaxChars` (6 000) plus framing, so the block trips the "too long" branch
  and is kept as its own leading message **and** appears in the head to be
  digested — the same text twice, once labelled as the user's goal.

Neither failure raises anything. Both get worse with every subsequent compaction.
So the assembly rule is fixed and idempotent:

| shape | leading message | how it is recognized next time |
|---|---|---|
| plain text, any length | one `user` message: `<original_task>…</original_task>`, body clipped to `anchorChars` with an explicit `[truncated]` marker if it must be | the `<original_task>` opening tag |
| carries `ContentPart[]` (an image the task depends on) | the original message, byte-for-byte verbatim | `anchor="verbatim"` on the following block, plus the block's own position |

On every compaction the host computes `protectedPrefix` (§3.6.2) by recognizing
this leading message and, if present, the `<compacted_context>` block right after
it. Recognized messages are **carried through untouched and excluded from the
head**; only material after them is eligible for the digest. `planCompaction`
returns `null` when there is nothing else, and §3.8 turns that into a bounded,
loud outcome.

The text shape now clips rather than switching to verbatim-standalone, because the
switch was the only reason `anchorChars` had two behaviours. A 4 000-character
first message clipped with a visible marker keeps the rule "one leading anchor,
always recognizable"; a 40 000-character first message is not a goal statement and
truncating it with a marker is the honest outcome. AC-7 becomes mechanically
checkable as a result: the compacted history's first message is a `user` message
whose text contains the original task's first `anchorChars` characters.

Two consecutive `user` messages are legal here and that is verified rather than
assumed: `convertMessages` already emits one `user` message per `tool_result`
(`anthropic.ts:471-484`), so every multi-tool batch in this codebase's history
has always produced consecutive user messages. Anthropic's other structural
requirement — that the first message be `role: 'user'` — is satisfied by
construction, since the anchor is a `user` message in both shapes.

**The block.**

```
<compacted_context version="v1-2026-08" replaced="112" turns="17" anchor="tagged" generation="1">
The conversation above this point was compacted to free context. The following
is an accurate record of it. Continue the work from here; do not re-derive this
history, do not ask the user to repeat it, and do not apologise for the gap.

## Task
...
</compacted_context>
```

`anchor` is `"tagged"` or `"verbatim"` per the table above, and `generation`
counts compactions in this history (`1`, `2`, …). Both are v2 additions and both
are cheap: `anchor` is what lets the next compaction know which leading-message
shape it is looking at without re-deriving it from lengths, and `generation` is
what makes "this session has been compacted three times" answerable from the
history alone — by `/compact status`, by a bug report, and by the summarizer
itself, which is entitled to know it is reading a third-generation record.

A `user` message, not an assistant one. Fabricating an assistant message that
claims the model said something it did not is a lie the model will then act on,
and it corrupts every subsequent turn. The XML tag is the same disclosure device
`<fast_review>` and `<skill>` already use in this codebase, and the instruction
line is what stops the model from reading the block as the user *asking* for a
summary.

`version` is `COMPACTION_BLOCK_VERSION`, bumped whenever the wording changes, so
a behaviour report can be tied to a block revision with one grep — the rule
`FAST_BLOCK_VERSION` and `TEAM_BLOCK_VERSION` already state.

### 3.7 The failure ladder

Summarization is a network call to a model. It will fail. The question a
"robust" claim actually has to answer is *what the run does next*, and the
answer must never be "sit at 94 % and send the request anyway", because that is
a 400 that ends the run.

| step | condition | action |
|---|---|---|
| 1 | call succeeds, text non-empty | splice `mode: 'summarized'` |
| 2 | call fails / times out / returns empty | **one** retry, on the **main** model if step 1 used the fast tier (a fast model that cannot summarize is the most likely single failure) |
| 3 | retry also fails, `onFailure: 'truncate'` (default) | splice `mode: 'truncated'`: same cut, same goal anchor, block body replaced by `N earlier messages were dropped to free context. Their content is not available.` Emit a **warn** notice. |
| 4 | retry also fails, `onFailure: 'stop'` | `{ action: 'keep', reason: 'summarize_failed' }`, emit an **error** notice naming `/compact`, `/clear` and `/reset`. The run proceeds and will probably hit `context_overflow`, which is what the user asked for by setting this. |
| — | the whole `compact()` exceeds `COMPACTION_HARD_TIMEOUT_MS` (120 s), or the signal aborts | **not a rung** — the engine has already stopped waiting (§3.3) and recorded `manager_timeout` / `aborted`. Rungs 1–4 are budgeted to fit **strictly under** it: the worst legal case is two `callTimeoutMs` calls back to back (45 s + 45 s) plus the digest render, so a well-behaved host always reaches a rung on its own and the ceiling only ever fires on a host bug. If it starts firing in practice, that is the signal to look at the host — **and to check this arithmetic still holds** if `callTimeoutMs` or the retry count ever changes; the two numbers are coupled and only this row says so. |

Step 3 is the default and it is a real judgement call, so here is the argument.
Truncation loses information. But an unattended `aragon exec` in CI that wedges
on an unrecoverable 400 loses the whole run, and a truncation that is announced
in the transcript, on the JSON event stream and in the block itself is not
silent data loss — it is a visible, bounded degradation. The user who prefers
the other trade sets one key.

**The goal anchor survives every rung**, including truncation. If the run keeps
going, it keeps going knowing what it was asked to do.

### 3.8 Anti-loop guards

Compaction spends money and can, if it makes no progress, spend it repeatedly.
Four independent guards, in the discipline `todo-plan-followthrough` established
for auto-continuation.

**All four are trigger-aware, and that is a v2 correction (P1-13).** v1 wrote them
trigger-blind, which lets the anti-loop machinery switch off the reactive path —
the feature's entire answer to R-5 — in precisely the sessions that need it. The
arithmetic is different on the two triggers and it is not a close call: a
*pressure* compaction that reclaims little has spent money to buy two turns and
should stop; an *overflow* compaction is answering a request the provider has
**already refused**, so the same small reclaim is the difference between a
continuing run and a dead one. Guard 3 therefore advises rather than vetoes on
overflow, and guard 4's self-disable covers the pressure trigger only. `maxPerRun`
and §3.3's now-real one-shot flag remain the hard bounds on both.

1. **Cooldown** *(both triggers)*. `COMPACTION_LIMITS.minTurnsBetween` (2), in
   `turnIndex` units (§3.3). Never two turns in a row. A compaction that just ran
   needs a real turn before its effect is measurable, because `lastUsage` is still
   the pre-compaction number until the next `turn_end`. The one exception is an
   `overflow` on the very next pass: the cooldown cannot block the only path that
   makes an already-refused request sendable, so it is checked against the
   *pressure* trigger and bypassed for overflow.
2. **Per-run cap** *(both triggers, hard)*. `COMPACTION_LIMITS.maxPerRun` (5).
   Reset on `agent_start`, which is why the wiring subscribes to the agent stream
   at all (§3.2.1).
3. **Progress requirement** *(hard on pressure, advisory on overflow)*. After a
   splice, the projected occupancy — estimated, because no usage exists yet, and
   therefore **calibrated with `estimateOffset`** (§3.4.2 / P1-11) — must be below
   `threshold - COMPACTION_LIMITS.minReclaimRatio` (0.15). A compaction that
   leaves the session at 88 % with a threshold of 90 % has bought two turns and
   will fire again immediately. On overflow the projection is logged and reported
   but never vetoes the splice.
4. **Stuck detection** *(pressure only)*. Two consecutive **pressure**
   compactions that fail the progress requirement, or two consecutive
   `planCompaction` → `null`, **disable the proactive trigger for the session**
   with a warn notice that names the actual cause and the actual remedies:

   > Auto-compaction is off for this session: the most recent
   > `keepRecentTurns` turns alone exceed the threshold. Lower
   > `compaction.keepRecentTurns`, or use `/clear` / `/reset`.

   This is the one outcome a naive implementation turns into an infinite
   summarization loop against a paid API, and it is worth four lines of state to
   foreclose. **The reactive path stays armed**, so a session in this state still
   survives an overflow rather than dying at the next request — and if the tail
   really is too large, the overflow attempt is the one that can do something
   about it (below).

**One lever the guards do not have, and the overflow path does.** A tail that
alone exceeds the window is the single failure mode none of the four guards can
fix — they can only stop spending on it. So an `overflow`-triggered compaction
halves `keepRecentTurns` **for that attempt only** (floor 1), in memory, never
persisted. It is the only variable in the whole feature that can make an
impossible request possible, and applying it exactly where the provider has proven
the request impossible is the narrowest place to put it. The card and
`/compact status` report the reduced value so the user can see why the tail got
shorter and make it permanent if they want to.

### 3.9 Interaction with the rest of the system

- **Todo list.** `TodoStore` lives on the controller and is untouched by
  compaction: the plan is a *belief the model holds*, and compaction does not
  change what the model believes, only how much of the record it can see. The
  summarizer prompt's `## Open` section is asked to restate open items, which is
  belt-and-braces for a list the rail is already showing.
- **Fast tier reviews.** `FastReviewer` builds its own bounded frame ring and
  never reads `agent.state.messages` (`fast/limits.ts:28-35`), so compaction is
  invisible to it. Correct: a review is about the last few turns.
- **Team dispatches.** Children get no `ContextManager` in v1 (D-15). A child's
  history is bounded by its dispatch timeout and its own turn cap.
- **Skills.** Skill content is injected into the *system prompt*, not into
  `messages`, so it survives compaction untouched — and it is counted in
  occupancy, because `estimatePromptTokens` takes `systemPrompt` and the
  provider's `input_tokens` includes it.
- **Plan mode.** Orthogonal. Compaction does not change the mode and the mode
  does not gate compaction.
- **`/save` and `/resume`.** A compacted session saves compacted (§1.3). The
  `kind: 'compaction'` entry is JSON-serializable by construction.

### 3.10 Logging

A `compaction` log scope (`getLogger().child('compaction')`), matching the `fast`
scope added in that feature's round 2. One `info` per compaction with
`{ trigger, before, after, droppedMessages, occupiedBefore, estimatedAfter,
model, durationMs, mode }`, one `warn` per degrade, one `warn` on self-disable.
**Never the summary text and never message content** — the same rule
`todo-plan-followthrough` states for item text.

---

## 4. Interface design

### 4.1 Core API delta

```ts
// index.ts — runtime (values); these FOUR go in EXPECTED + API.md + CHANGELOG
export { findSafeCutIndices, planCompaction, validateHistory } from './engine/compaction.js';
// v2 / P2-3: module-private today (`output-limits.ts:311`). Exported so the CLI's
// digest budget and core's occupancy estimate cannot disagree about the constant.
export { CHARS_PER_TOKEN } from './llm/output-limits.js';

// index.ts — types (erased; free per C-6)
export type { ContextManager, CompactionProbe, CompactionContext,
              CompactionOutcome, CompactionTrigger } from './engine/context-manager.js';
export type { CompactionPlan, HistoryCheck } from './engine/compaction.js';
export type { CompactionStartEvent, CompactionEndEvent } from './types.js';
```

`AgentConfig` gains one optional member:

```ts
  /**
   * Optional context manager. `undefined` means the engine never compacts and
   * every code path is byte-identical to a pre-feature build.
   */
  contextManager?: ContextManager;
```

### 4.2 Config keys — `config.json`, section `compaction`

| key | type | default | clamp | meaning |
|---|---|---|---|---|
| `enabled` | boolean | **`true`** | — | Whether a `ContextManager` is constructed at all. |
| `threshold` | number | `0.9` | `[0.5, 0.95]` | Occupancy ratio that triggers compaction. |
| `warnThreshold` | number | `0.75` | `[0.4, threshold - 0.05]` | Where the gauge turns amber. Clamped **jointly** with `threshold` so it can never be ≥ it. |
| `keepRecentTurns` | integer | `4` | `[1, 20]` | Complete turns kept verbatim in the tail. |
| `useFastTier` | boolean | `true` | — | Summarize with the fast tier when it resolves. |
| `onFailure` | `'truncate' \| 'stop'` | `'truncate'` | enum | §3.7 rungs 3 / 4. |

Six keys — between `todo`'s three and `fast`'s ten, and each one answers a
question a user can actually have.

**`enabled` defaults to `true`, unlike every other optional subsystem in this
package,** and that is deliberate. `fast.enabled` and `team.enabled` default off
because they add behaviour the user did not ask for. This one *removes* a
failure the user did not ask for: without it, the answer to a full window is a
dead run. The byte-identity discipline is still honoured — `--no-compaction`
constructs no manager, subscribes nothing, allocates no registry, and produces
an engine loop with `ctx.contextManager === undefined`, i.e. one `if` per turn
against a field that is `undefined`.

`enabled` is read **once at construction** (it decides whether the manager
exists at all, the `team.enabled` / `todo.enabled` rule); the other five are read
**live** on every use, so `/compact threshold 0.8` takes effect in the running
session.

Per C-10, all six live on `CompactionConfig`, which is reachable from **both**
`PersistedConfig` and `CliConfig`. It is the **NINTH** nested object in
`schema.ts` and, like all eight before it, it is **scalars only** — `store.ts`
merges these sections by hand in exactly two places (`:166` read, `:235` write)
and a nested field would need both rewritten first (P2-5).

**`clampCompactionConfig` clamps in a fixed order**, because "jointly" is not an
instruction: `threshold` is clamped to `[0.5, 0.95]` **first**, then
`warnThreshold` to `[0.4, clampedThreshold - 0.05]`. The other order lets a
file with `threshold: 0.6, warnThreshold: 0.9` produce a warn mark above the
trigger, i.e. a gauge that turns amber after it has already gone red. Both bounds
of the second range are reachable and consistent at the extremes: `threshold`
floored at `0.5` gives `warnThreshold ∈ [0.4, 0.45]`.

### 4.3 CLI flags and environment

| flag | env | effect |
|---|---|---|
| `--compaction` | `ARAGON_COMPACTION=1` | `enabled: true` (the default) |
| `--no-compaction` | `ARAGON_COMPACTION=0` | `enabled: false` |
| `--compaction-threshold <0..1>` | `ARAGON_COMPACTION_THRESHOLD` | `threshold` |
| — | `ARAGON_COMPACTION_KEEP_TURNS` | `keepRecentTurns` |

Three flags and three env vars, resolved by the same accumulate-and-cast section
builder `env.ts` already uses for `fast` / `team` / `todo`.

**Both boolean forms are declared, positive first, and that is not optional
(C-13 / P1-5).** v1 listed only `--no-compaction`. `cli.tsx` states the rule seven
times in seven adjacent comments (`:1605-1650`): with only the negative form
declared, commander defaults `opts.compaction` to `true`, at which point the flag
is indistinguishable from its own default and **silently overwrites a stored
`enabled: false` on every run that passed no flag at all**. `compaction.enabled`
is persisted and defaults to `true`, which is the same polarity as `update.mode` —
the pair whose comment calls its own omission the worst of the seven, because "the
kill switch for a feature that installs software would quietly un-set itself".
Here the kill switch is for a feature that spends money on the user's behalf, and
R-12's whole mitigation ("one config key restores the old behaviour exactly") rests
on it. `resolveCompactionConfig` reads `flags.compaction !== undefined`, never
truthiness, and a unit test asserts a stored `false` survives a flagless run.

### 4.4 Slash command `/compact`

| form | behaviour |
|---|---|
| `/compact` | Compact now. Idle → run immediately. Running → queue for the next turn boundary and toast `Will compact before the next turn.` |
| `/compact <instructions>` | Same, with the text appended to the summarizer prompt as `## Focus`. Claude Code parity, one concatenation. |
| `/compact status` | The guaranteed reporting surface (§6.5): occupancy, window, source (`measured` / `estimated`), threshold, compactions this session, tokens reclaimed, summarizer model, whether pricing is known, and whether the feature self-disabled and why. |
| `/compact on` / `off` | Flip the live switch. `off` in a session started with `--no-compaction` reports that nothing is registered, the `/team`-and-`/todo` wording. |
| `/compact threshold <n>` | Set and persist; accepts `0.9` or `90%`. |
| `/compact keep <n>` | Set and persist `keepRecentTurns`. |

The queue-when-running behaviour is what makes the command safe: replacing
`messages` under a live loop is a race, but a flag that `shouldCompact` honours
at the next boundary is not — the boundary is the one moment the engine is
single-threaded with respect to the history, by construction.

**The idle path must validate before it splices (P1-7).** When the agent is idle
there is no loop, so §3.3 step 5 does not run — and the only way to replace the
history is `Agent.replaceMessages` (`agent.ts:304` → `MessageManager.restore`),
which validates nothing. As v1 specified it, `/compact` while idle was therefore a
hole in exactly the gate D-4 declares unbypassable and R-2 calls the worst possible
outcome. The idle path is:

```ts
// compaction/command.ts — the idle branch. MIRRORS §3.3 steps 3-5 EXACTLY.
const outcome = await wiring.compactNow({ trigger: 'manual', ... });
if (outcome.action !== 'replace') { report(outcome.reason); return; }
const check = validateHistory(outcome.messages, { previousLength: before.length });
if (!check.ok) { report(`invalid_history: ${check.reason}`); return; }   // REFUSE
controller.replaceMessages(outcome.messages);
```

`validateHistory` is a public runtime export (§4.1) precisely so this costs
nothing, and the failure vocabulary is the same `invalid_history: <reason>` string
the engine produces, so the card, the log and `/compact status` cannot tell the two
paths apart. No watchdog handling is needed — `runLoopWithLifecycle`'s `finally`
already called `watchdog.stop()` (`agent.ts:439`), so nothing is armed while idle.

The **running** path needs none of this: it goes through the queue, the boundary,
and the engine's own gate.

### 4.5 Settings screen

Three rows in the existing screen, next to the fast-tier rows: `Auto-compaction`
(on/off), `Threshold` (percentage), `Keep recent turns` (integer). `onFailure`
and `useFastTier` are file/`/compact`-only — the screen is for the settings a
user changes, not for every setting that exists.

### 4.6 `aragon exec` JSON stream

One additive event type. Per the contract stated at `exec/events.ts:14-19`,
adding an event type does **not** bump `EXEC_SCHEMA_VERSION`:

```ts
export interface ExecCompactionEvent {
  type: 'compaction';
  sessionId: string;
  turn: number;
  subtype: 'start' | 'end';
  trigger: 'pressure' | 'overflow' | 'manual';
  /** `end` only. */
  applied?: boolean;
  mode?: 'summarized' | 'truncated' | 'none';
  reason?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
}
```

The summary text is **not** on the stream. It can be tens of thousands of
characters and no wrapper needs it; the transcript card and the log have it.

### 4.7 Headless (`-p`)

Two stderr lines, in the compact style headless already uses for tools:

```
[compaction] 118.4k -> 23.1k tokens, 112 -> 9 messages (17 turns summarized, 3.4s)
```

and, on a degrade, `[compaction] summarize failed (timeout) - dropped 103 messages without a summary`.

---

## 5. Data model

### 5.1 Core event additions (`packages/core/src/types.ts`)

```ts
export interface CompactionStartEvent {
  type: 'compaction_start';
  trigger: CompactionTrigger;
  messageCount: number;
}

export interface CompactionEndEvent {
  type: 'compaction_end';
  applied: boolean;
  mode: 'summarized' | 'truncated' | 'none';
  /** Set whenever `applied` is false, and on any degraded splice. */
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  droppedMessages: number;
  /** Core's own `estimatePromptTokens`, both sides — comparable by construction. */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** The summary body, so the CLI needs no second channel to render the card. */
  summary?: string;
  durationMs: number;
}
```

Both join the `AgentEvent` union. Every existing consumer is forward-compatible
by C-5.

`estimatedTokens{Before,After}` are computed **by core, with core's own
estimator, on both sides**. Two numbers produced by one function are comparable;
a "before" from provider usage and an "after" from an estimate are not, and the
card's headline claim ("118k → 23k") would be comparing a measurement to a guess.

### 5.2 CLI runtime shapes (`compaction/types.ts`)

```ts
export type CompactionMode = 'summarized' | 'truncated' | 'none';
export type CompactionUiTrigger = 'pressure' | 'overflow' | 'manual';

/** One compaction, in whatever state it reached. Rendered by `CompactionCard`. */
export interface CompactionRecord {
  index: number;               // 1-based within the session
  trigger: CompactionUiTrigger;
  mode: CompactionMode;
  applied: boolean;
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  model: string;
  durationMs: number;
  usage?: TokenUsage;
}

/** Everything `/compact status`, the chip and the settings row read. */
export interface CompactionSnapshot {
  live: boolean;               // registered AND enabled AND a model resolves
  model: string;
  compactions: number;
  tokensReclaimed: number;     // sum of (before - after)
  usage: TokenUsage;           // what compaction itself has spent
  pricingUnknown: boolean;     // CARRIED, never re-derived
  inFlight: boolean;
  selfDisabled: boolean;
  selfDisabledReason?: string;
  pressure: Pressure;
}

export type CompactionEvent =
  | { type: 'compaction_start'; index: number; trigger: CompactionUiTrigger; model: string }
  | { type: 'compaction_end'; record: CompactionRecord }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'snapshot'; snapshot: CompactionSnapshot };
```

A **CLI-local** stream, like `FastEvent` / `TeamEvent` / `TodoEvent`, for the
reason each of those records: core's `AgentEvent` union is a public contract and
must not learn host shapes. Note the asymmetry with §5.1 — core emits the two
*engine* events because the engine is what performs the splice; the CLI emits
the richer ones because only the CLI knows the model name, the price and the
session totals.

**This stream is the SOLE source of reducer actions, and `reduceEvent` gains no
cases for the two core events (P1-6 / D-20).** v1 gave `reducer.ts` both — a
`reduceEvent` case per core event *and* an `App.tsx` `subscribeCompaction` effect
over this stream — which is the same compaction arriving twice: two transcript
cards, `tokensReclaimed` doubled, and the gauge written twice with the second
write landing after the first. Nothing in v1 named the authority.

The right authority is this stream, because it is strictly richer: the wiring is
the `ContextManager`, so it knows the summarizer's model, its cost and the
session totals, and it learns `applied` / `reason` by subscribing to
`compaction_end` (§3.2.1). `reduceEvent`'s `default: return []` (C-5) is therefore
exactly right for the two new core events and needs no edit — which is also the
cheapest possible expression of "one authority". The two core events remain part of
core's public contract for other embedders; this host simply consumes them one
layer earlier.

### 5.3 Core pure mechanics (`packages/core/src/engine/compaction.ts`)

```ts
export interface CompactionPlan {
  /** Head is `[0, cutIndex)`; tail is `[cutIndex, end)`. */
  cutIndex: number;
  droppedMessages: number;
  retainedTurns: number;
}

export type HistoryCheck =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'orphan_tool_result' | 'unclosed_tool_call' | 'grew' };

export function findSafeCutIndices(messages: readonly Message[]): number[];
export function planCompaction(
  messages: readonly Message[],
  opts: { keepRecentTurns: number },
): CompactionPlan | null;
export function validateHistory(
  messages: readonly Message[],
  opts?: { previousLength?: number },
): HistoryCheck;
```

`validateHistory` walks once with the same open-set as `findSafeCutIndices`:
`orphan_tool_result` when a `tool_result` arrives for an id not open;
`unclosed_tool_call` when the walk ends with a non-empty open set; `empty` for a
zero-length array; `grew` when `previousLength` is supplied and exceeded. It is
the gate at §3.3 step 5 and it is the only thing standing between a host bug and
an un-sendable conversation.

### 5.4 `COMPACTION_LIMITS` (`cli/src/compaction/limits.ts`)

Structural bounds — what a digest, a call and a card can physically carry. **Not
user policy**; the six keys in §4.2 are the policy. The distinction is the one
`TEAM_LIMITS` / `TODO_LIMITS` / `FAST_LIMITS` all state.

```ts
export const COMPACTION_LIMITS = {
  digestMaxChars: 120_000,        // ~30k tokens; ceiling before the window check
  summarizerReserveTokens: 8_000, // output + system + framing, kept out of the digest budget
  userChars: 2_000,
  assistantChars: 2_000,
  toolArgChars: 200,
  toolResultChars: 600,
  // v2: the anchor is ALWAYS its own message (D-21), so this is now a CLIP
  // bound on the tagged text shape rather than a shape switch. A first message
  // longer than this is not a goal statement, and truncating it with a visible
  // `[truncated]` marker beats making the anchor rule length-dependent (P1-9).
  anchorChars: 4_000,
  summaryMaxChars: 6_000,         // what the prompt asks for and the splice clips to
  summaryOutputTokens: 2_048,
  callTimeoutMs: 45_000,
  minTurnsBetween: 2,
  maxPerRun: 5,
  minReclaimRatio: 0.15,
  stuckLimit: 2,
  cardTextRows: 6,                // collapsed card body; Ctrl+O expands
  // 100, NOT 90 (P2-2). All four existing peers are 100 — `retry-view.ts:26`,
  // `fast/limits.ts:95`, `team/limits.ts:86`, `todo/limits.ts:44` — and a
  // status-bar degradation ladder that is nearly-but-not-quite uniform is a
  // reading hazard bought for nothing. v1 said 90 with no reason given.
  statusCompactCols: 100,
} as const;

export const COMPACTION_BLOCK_VERSION = 'v1-2026-08';

/**
 * The engine's ceiling on one `compact()` call (§3.3 / P1-3). NOT in
 * `COMPACTION_LIMITS`: it lives in `packages/core/src/engine/agent-loop.ts`,
 * because the whole point of it is that it does not depend on the host being
 * correct — a constant the host owns is a constant the host can get wrong.
 *
 * COUPLED TO `callTimeoutMs` ABOVE. The worst legal host budget is two calls at
 * `callTimeoutMs` plus the digest render (45 + 45 = 90 s), so this must stay
 * strictly greater; raising `callTimeoutMs` without raising this makes the §3.7
 * ladder unreachable and turns every slow-but-correct summarization into
 * `manager_timeout`.
 */
// core: const COMPACTION_HARD_TIMEOUT_MS = 120_000;
```

### 5.5 View state and transcript entry

`ViewState` gains two members:

```ts
  /** The live compaction projection, or `null`. NEVER PERSISTED. */
  compaction: CompactionSnapshot | null;
  /** The `kind: 'compaction'` entry the in-flight compaction is writing into. */
  compactionEntryId?: string;
```

`Entry` gains one kind:

```ts
  | {
      id: string;
      kind: 'compaction';
      index: number;
      trigger: CompactionUiTrigger;
      mode: CompactionMode;
      applied: boolean;
      reason?: string;
      messagesBefore: number;
      messagesAfter: number;
      tokensBefore: number;
      tokensAfter: number;
      summary?: string;
      model: string;
      durationMs?: number;
      /** Rewritten once, when the call returns. Normalized away ON LOAD (C-8). */
      live: boolean;
    }
```

Five new actions: `compactionStart`, `compactionEnd`, `compactionUsage`
(with a **precomputed** `costDelta`, so the reducer stays cost-table-free — the
rule `teamUsage` and `fastUsage` both state, and it matters more here because
the summarizer has a different cost table from the lead), `compactionSnapshot`,
and `contextTokensEstimated` (§6.2). All five are dispatched from **one** place,
`App.tsx`'s `subscribeCompaction` effect (§5.2 / P1-6).

`compactionStart` carries two responsibilities beyond opening the card, and both
are defensive:

1. **Seal any live `streamingId` entry** — C-8's failure mode, and reachable here
   because Anthropic can deliver an error in-stream after text has been emitted
   (`provider.ts:170-171`).
2. **Rewrite a trailing `context_overflow` error notice** when
   `trigger === 'overflow'` (P1-4): `level: 'error'` → `'info'`, text →
   *"Context window exceeded - compacting and retrying."* It **rewrites in place
   rather than removing**, because `<Static>` cannot un-print an entry it has
   already drawn, and it matches only when that notice is the tail entry, so it can
   never touch an older genuine error. If the recovery subsequently fails, the
   ladder's own notice (§3.7) or the re-thrown 400 is what the user is left with —
   so neither direction lies.

---

## 6. UI design

The requirement names one surface ("压缩的时候，用户 TUI 界面上要有对应的内容显示"). This
design ships three, because they answer three different questions, and this
package's own law is that a duplicated readout is a defect (`StatusBar.tsx:299`,
`ActivityLine.tsx:8`). Each surface says exactly one thing the others cannot.

### 6.1 While it runs — the activity row

`ActivityLine` is the row that exists to say *the silence is work*. It already
has a precedent for overriding its rotating phrase: `runningTool` replaces
"Pondering…" with `Running bash`, because "a UI that says 'Pondering' while
`npm test` runs is not calm, it is wrong" (`ActivityLine.tsx:80-88`). Compaction
is the same argument one step further.

```
  ⠹ Compacting context…
```

A new optional prop `compacting?: boolean` takes precedence over `runningTool`,
which takes precedence over the phrase. Compaction can occur before
`turn_start`, i.e. at a moment when `status` is `'running'` but no tool is in
flight — precisely the window in which the phrase rotation would say something
false.

**No second spinner.** `single-spinner-while-running`'s D-1 stands: this row
owns the only animation while it is mounted, and the `CompactionCard` follows
the `FastCard` pattern of taking `reducedMotion` widened by `App`.

### 6.2 As state — the status bar

Two changes, both minimal.

1. **The gauge's colour ladder aligns with the thresholds.** `buildGauge`
   currently hardcodes `>85 high / >=60 mid` (`ui/gauge.ts:25-29`). It gains an
   optional `marks?: { warn: number; high: number }` defaulting to
   `{ warn: 60, high: 85 }`, so every existing call site and test is
   byte-identical, and `StatusBar` passes
   `{ warn: warnThreshold * 100, high: threshold * 100 }`. **The two comparison
   operators are preserved exactly** (`pct > high`, `pct >= warn`); changing either
   would move the default 85 or 60 boundary and break the byte-identity claim that
   makes this a free change.

   **What red means, corrected (P2-4).** v1 said amber = "approaching compaction",
   red = "compaction is imminent". The first is right; the second cannot be,
   because the trigger is `ratio >= threshold` (inclusive) while the fill is
   `pct > high` (exclusive) — so with `high = threshold`, any occupancy that would
   render red has *already* triggered compaction, and the gauge repaints downward in
   the same frame. The red band is only ever **observable** when compaction did not
   or could not run: the feature is off, self-disabled (§3.8 guard 4), or the ladder
   ended at rung 4. That is a genuinely more useful meaning than "imminent", and it
   is the one the README and the settings-screen help text state.
2. **A `compacting` chip** in the right cluster next to `eco` / `fast`,
   suppressed below `COMPACTION_LIMITS.statusCompactCols` — the `teamActive`
   treatment, not the `agentMode` one, because `/compact status` is the
   guaranteed reporting surface (§6.5).

The percentage label also widens its `~` prefix: today `~` means "the window is
a guess" (`contextWindowKnown`); it now also means "the occupancy is a guess"
(`pressure.source === 'estimate'`).

**The gauge must fall immediately.** `contextTokens` is only written at
`turn_end` (`reducer.ts:1071`). Without a change, a compaction that took the
session from 92 % to 24 % would leave the bar at 92 % until the next turn
completes — and the user would reasonably conclude that nothing happened. So
`compactionEnd` sets `contextTokens` to `estimatedTokensAfter` and marks the
source as an estimate; the next `turn_end` replaces it with measured usage. This
is a small change and it is the difference between the feature feeling real and
feeling broken.

**And the number it falls to must be in the same unit as the number it replaces
(P1-11).** The value being overwritten came from `occupiedTokens(usage)` — a
provider measurement that includes the tool schemas. `estimatedTokensAfter` comes
from `estimatePromptTokens`, which never counts them (`output-limits.ts:348-356`).
Writing the raw estimate makes the bar fall too far and then visibly climb again on
the next `turn_end` for no reason the user can see, which is the same
"is-this-thing-working" doubt the immediate drop exists to prevent, just one turn
later. So the CLI writes `estimatedTokensAfter + (pressure.estimateOffset ?? 0)`
and keeps the `~` prefix while the value is derived. Core still reports both
`estimatedTokens{Before,After}` **uncalibrated** and from its own estimator, because
§5.1's argument stands — the two must be comparable *to each other*, and core has
no access to a measurement to calibrate against.

### 6.3 As a record — the transcript card

```
⤓  context compacted  ·  112 → 9 messages  ·  118.4k → 23.1k tokens  ·  3.4s
   │ summarized 17 turns with claude-haiku-4-5 · kept the original task + 4 turns
   │ ## Task
   │ Add auto-compaction to the agent loop…
   │ ## Open
   │ - wire the exec event
   ↳ ctrl+o to expand
```

(The mock above is illustrative. **Every non-ASCII character in it resolves
through `glyphs.ts`** — `⤓` through the new `compaction` field and `→` through the
existing `arrowRight`, the one `StatusBar` already uses. `ui/` is inside
`glyphs.test.ts::inScope`, so a literal arrow left in the component fails the scan;
v1's mock showed both inline with only the new glyph accounted for, P2-7.)

Rendered through the shared `EntryFrame` like every other card, so a compaction
reads as one more step in the transcript rather than a new species of object.
The body is the summary, clamped to `COMPACTION_LIMITS.cardTextRows` and
expandable — unlike `FastCard`, which is collapsed by construction, there
genuinely is more to reveal here.

**Expansion needs a change v1 did not list, and without it AC-6 cannot pass
(C-15 / P1-8).** `expandedToolIds` is keyed by entry id, so the *storage* is
already generic — but both surfaces that *choose* a target filter by kind and
neither would match a compaction card:

- **Ctrl+O** picks `.reverse().find(e => e.kind === 'tool' || e.kind === 'team')`
  (`App.tsx:1625-1627`). It gains `'compaction'` as a third member, and the
  empty-state toast widens from `No tool output to expand.` to `Nothing to
  expand.`. Without this the card renders `ctrl+o to expand` and the keystroke
  silently expands an older tool card instead — the hint lies and nothing errors.
- **`/expand`** filters `kind === 'tool'` (`builtins.ts:940`) and is **deliberately
  left alone**: its own description is "Expand / collapse a recent tool card", it
  takes an N-from-last index over tool cards specifically, and widening it would
  change what `/expand 3` means for every existing user. Ctrl+O is the general
  surface; `/expand` is the indexed tool one. Stated here so the asymmetry reads as
  a decision rather than an oversight.

Colour: `theme.accent` for a normal compaction, `theme.noticeWarn` for
`mode: 'truncated'`, `theme.toolError` for `applied: false`. Glyph: a new
`compaction` field on `Glyphs` — `'⤓'` Unicode, `'[c]'` ASCII, mirroring
`retry`'s `'↻'` / `'[r]'`. It goes in `glyphs.ts` and nowhere else (that file's
header is explicit that a literal in a component bypasses the whole mechanism).

### 6.4 Honesty rules

- A **truncated** compaction says so on the card *and* inside the spliced block,
  because the model reading the block is also entitled to know that the record is
  incomplete.
- A **failed** compaction produces a card and a notice. A **declined** one — one
  that changed nothing, called nothing and spent nothing, decided before any work
  began — produces neither. In the transcript it is indistinguishable from a turn
  at which the threshold was never crossed. It is still *reported*, on two
  surfaces that are not the transcript: `/compact status` counts it
  (`This session: N compactions (M checkpoints declined)`), and the diagnostic log
  records it in full. If declines keep happening, guard 4 says so out loud, once
  (§3.8 guard 4). See
  `docs/plans/context-auto-compaction-quiet-noop/spec.md` §9. "It did nothing" is
  never the observable outcome of a compaction that **did** something, and "it is
  declining every time" is never something the user has to infer — the rule
  `fast-model-tier` states as R-8, narrowed to what it was actually about.
- **Self-disable** produces a warn notice naming the cause and the remedies
  (§3.8 guard 4), once, on the transition.
- **Cost is real cost.** Compaction usage is added to `usageTotal` through
  `compactionUsage`, priced with the summarizer's own table via
  `getModelInfoFor`, and `isPricedModel` gates the honesty flag — an unknown
  model priced at `$0.00` would make the feature look free while it spends money
  (the C-11 / RV-4 lesson from `fast-model-tier`). This matters more than v1
  implied, because the **default** summarizer is the session's own model (§3.6.4 /
  P2-8), not a cheap one.
- **The card describes the HISTORY, never the screen.** `/clear` clears the
  transcript view but not `messages` (§1.1), so compaction can legitimately fire
  against a visually empty transcript and report "112 → 9 messages" with nine
  visible rows. Every string on the card and in `/compact status` therefore names
  the conversation the model sees, and none of them says "above" or "earlier in
  this transcript" (P2-9). The spliced block's own wording — "the conversation
  above this point" — is addressed to the *model*, whose view is `messages`, and is
  correct there.
- **A recovered overflow does not leave a red banner behind.** §3.5 / §5.5: the
  notice the stream already emitted is rewritten to informational when the
  reactive path engages, and restored to a real error only if the recovery fails
  (P1-4).

### 6.5 The guaranteed surface

`/compact status`. The chip drops on a narrow terminal, the activity row is
suppressed under an overlay, and the card scrolls away. The command answers
every question about the feature's state at any width, in any mode, including
after the fact.

---

## 7. File / module change plan

### New files

| file | intent |
|---|---|
| `packages/core/src/engine/context-manager.ts` | The injected port. Types only, zero logic, zero imports outside `llm/types.js`. |
| `packages/core/src/engine/compaction.ts` | Pure mechanics: `findSafeCutIndices`, `planCompaction`, `validateHistory`. No I/O, no provider knowledge. |
| `packages/core/src/__tests__/compaction.test.ts` | Safe-cut / plan / validate, including the steering-interrupt and CodeAct histories. |
| `packages/core/src/__tests__/compaction-loop.test.ts` | Loop integration: the sync gate, the structural refusal, overflow recovery, watchdog pause/resume, abort mid-compaction. |
| `packages/cli/src/compaction/limits.ts` | `COMPACTION_LIMITS` + `COMPACTION_BLOCK_VERSION`. |
| `packages/cli/src/compaction/types.ts` | `CompactionRecord` / `CompactionSnapshot` / `CompactionEvent` / `Pressure`. |
| `packages/cli/src/compaction/pressure.ts` | `occupiedTokens`, `computePressure`, `requiredHeadroom`, `shouldCompact`. Pure. |
| `packages/cli/src/compaction/digest.ts` | Head → bounded plain-text transcript, oldest-first eviction. Pure. |
| `packages/cli/src/compaction/summary-prompt.ts` | Summarizer system prompt, `## Focus` splice, `<compacted_context>` assembly, `COMPACTION_BLOCK_VERSION` interpolation. Pure. |
| `packages/cli/src/compaction/summarize-call.ts` | One bounded call. Receives the signal and an `onTimeout`; **owns no `AbortController`** — the prohibition `fast/review-call.ts` records at length, for the identical reason. |
| `packages/cli/src/compaction/compactor.ts` | The `ContextManager` implementation: gate, plan, digest, call, ladder, assemble, emit, guards. |
| `packages/cli/src/compaction/wiring.ts` | `CompactionWiring`: registered/enabled flags, live snapshot, manual queue, event fan-out, self-disable state. **Constructor MUST NOT subscribe** — `attach(subscribe)` is separate, which is what makes C-12's construct-before/attach-after split work. Exposes `manager(): ContextManager`, `attach`, `dispose`, `compactNow`, `snapshot`. |
| `packages/cli/src/compaction/command.ts` | The `/compact` handler and its status report (C-16 / P1-12). `builtins.ts` gets the registration only. |
| `packages/cli/src/ui/entries/CompactionCard.tsx` | The transcript card. |
| `packages/cli/src/__tests__/compaction-pressure.test.ts` | Occupancy incl. cache tokens, estimate fallback, both trigger terms, threshold clamping. |
| `packages/cli/src/__tests__/compaction-digest.test.ts` | Budget maths, clip-by-kind, oldest-first eviction, the omission marker. |
| `packages/cli/src/__tests__/compaction-compactor.test.ts` | The failure ladder, all four guards, the goal anchor's two shapes, the manual queue. |
| `packages/cli/src/__tests__/compaction-render.test.tsx` | Card states, activity-row precedence, gauge marks, chip width gate. |

### Modified files

| file | change |
|---|---|
| `packages/core/src/engine/agent-loop.ts` | `contextManager?` on `AgentLoopContext`; `lastUsage` / `turnIndex` / `overflowRecovered` hoisted **and assigned** (P1-1 / P2-1 / P0-1: `lastUsage = usage` and `overflowRecovered = false` after `turn_end`, never at the top of the loop); the pressure checkpoint; `runCompaction` with the shallow copy (P1-2), the signal+ceiling race (P1-3) and `compaction_end` in a `finally`; the `context_overflow` catch. |
| `packages/core/src/engine/agent.ts` | `AgentConfig.contextManager`; forward into the loop ctx; widen `applyRetryWatchdogPolicy` → `applyWatchdogPolicy` for the two new events. **No setter** (§3.2.1). |
| `packages/core/src/types.ts` | Two event interfaces + union members. |
| `packages/core/src/index.ts` | **Four** runtime exports (the three from `engine/compaction.ts` plus `CHARS_PER_TOKEN`, P2-3) + the type re-exports. |
| `packages/core/src/llm/output-limits.ts` | `CHARS_PER_TOKEN` promoted from module-private to exported (P2-3). No behaviour change. |
| `packages/core/src/__tests__/public-api.test.ts` | `EXPECTED` gains the **four** (three-sync discipline, C-6). |
| `packages/core/API.md`, `packages/core/CHANGELOG.md` | The other two thirds of C-6. |
| `packages/cli/src/agent/controller.ts` | One `compaction: CompactionWiring \| null` field + thin forwarders. **Construct it ABOVE `new Agent({...})` and `attach` it BELOW** (C-12 / P0-2 / §3.2.1) — v1's "pass `contextManager` into `new Agent({...})`" is not implementable as written, because the wiring must subscribe to the agent it would have to precede. Spread the port conditionally so it stays `undefined` when off (AC-1). `dispose()` beside `this.fast?.dispose()` at `:1062`. Call `onConfigChanged()` from `setModel` / `setApiKey` / `/reload` / the settings save, next to the existing `fast` call (the tier it may summarize with resolves from live config — the RV-3 lesson). |
| `packages/cli/src/agent/reducer.ts` | `Entry` kind; five actions; `ViewState.compaction` / `compactionEntryId`; **NO `reduceEvent` cases for the two core events** (P1-6 / D-20 — the CLI-local stream is the sole authority and C-5's `default: return []` is already correct); `compactionStart` also seals a live `streamingId` and rewrites a trailing `context_overflow` notice on `trigger: 'overflow'` (P1-4); **`turnEnd` switches to `occupiedTokens(action.usage)`** and records `estimateOffset` (§3.4.1 / §3.4.2); `formatStreamError`'s `context_overflow` copy names `/compact` alongside `/reset` (the second half of P1-4's fix — the remedy list predates this feature and is now incomplete); `resetConversation` / `clearTranscript` drop the id like every other live-card id. |
| `packages/cli/src/agent/usage.ts` | Nothing — `formatTokens` already renders `118.4k`. Listed so the reader knows it was checked. |
| `packages/cli/src/ui/App.tsx` | `controller.subscribeCompaction(...)` effect (a separate subscription — `CompactionEvent` is CLI-local, the `FastEvent` argument — and the **sole** dispatcher of the five actions, P1-6); `compacting` into `ActivityLine`; gauge marks + chip into `StatusBar`; **`'compaction'` added to the Ctrl+O target predicate at `:1625-1627` and the empty-state toast widened** (C-15 / P1-8 — without this the card's own `ctrl+o to expand` hint does nothing and AC-6 cannot pass). |
| `packages/cli/src/cli.tsx` | **Both** `--compaction` and `--no-compaction`, positive first (C-13 / P1-5), plus `--compaction-threshold <n>`. Declaring only the negative form silently un-sets a stored `enabled: false` on every flagless run. |
| `packages/cli/src/ui/ActivityLine.tsx` | `compacting?: boolean` prop, highest precedence in the label ladder. |
| `packages/cli/src/ui/StatusBar.tsx` | `compactionActive?: { inFlight: boolean }`; `contextEstimated?: boolean` widening the `~`; pass `marks` to `buildGauge`. |
| `packages/cli/src/ui/gauge.ts` | Optional `marks` with today's values as defaults. |
| `packages/cli/src/ui/Transcript.tsx` | `computeSettledCount` clause for `kind === 'compaction' && live`; the `EntryView` case. |
| `packages/cli/src/ui/transcript-text.ts` | One case in the plain-text exporter. |
| `packages/cli/src/ui/layout/virtual-window.ts` | **Both** switches (C-9): `entryRevision` (O(1): `` `c${live?1:0}.${summary?.length ?? 0}.${mode}` ``) and `estimateRows`. |
| `packages/cli/src/ui/glyphs.ts` | `compaction` field in both tables. |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | Three rows + the `SettingsValues` type + `App`'s save handler (the RV-13 lesson: those two are easy to miss). |
| `packages/cli/src/session/persist.ts` | Fifth `normalizeLoadedEntries` clause: `live` → `false`, `applied` → `false`, `reason` → `'interrupted (session resumed)'` (C-8). |
| `packages/cli/src/config/schema.ts` | `CompactionConfig`, `DEFAULT_COMPACTION_CONFIG`, `clampCompactionConfig` (**threshold first, then `warnThreshold` against the clamped value** — §4.2 / P2-5), members on **both** `PersistedConfig` and `CliConfig` (C-10), documented as the **NINTH** nested object, **scalars only**, matching the eight existing rows. |
| `packages/cli/src/config/load.ts`, `config/env.ts`, `config/store.ts` | Resolution (`flags.compaction !== undefined`, C-13), flags, env, and the hand-written section merge (`store.ts` merges by hand at `:166` and `:235` — a nested field would need both rewritten first, so `CompactionConfig` is **all scalars**). |
| `packages/cli/src/commands/builtins.ts` | **Registration only** — the `/compact` body lives in `compaction/command.ts` (C-16 / P1-12). This file is already 1 204 lines and `/compact` has six forms plus the longest status report in the package. `/expand` is deliberately **not** touched (§6.3). |
| `packages/cli/src/commands/registry.ts` | Nothing — `/compact` reaches its subsystem through `controller`, like `/fast` and unlike `/update`. Listed so the reader knows it was checked. |
| `packages/cli/src/agent/headless.ts` | Optional `subscribeCompaction?` on `HeadlessController` (optional for the reason the other three are) + two stderr lines. |
| `packages/cli/src/exec/events.ts`, `exec/runner.ts` | `ExecCompactionEvent` + emission. No `EXEC_SCHEMA_VERSION` bump. |
| `packages/cli/src/__tests__/glyphs.test.ts` | **`compaction` added to `inScope`'s regex** (C-7). Adding the tree and adding the word are the same change. |
| `packages/cli/README.md` | The `/compact` row, the `compaction` config section, one paragraph under the integration surface. |
| `packages/cli/CHANGELOG.md` | The entry. |

---

## 8. Testing & acceptance criteria

### 8.1 Unit tests (Vitest, offline)

**Core.**
- `findSafeCutIndices` returns `[0, len]` for `[user]`; excludes every
  `tool_result` index; excludes an assistant index while a call is open;
  handles the steering-interrupt shape (assistant with 3 calls, 3 synthesized
  results, then a user message) and the CodeAct shape (bare user message after
  an assistant text turn).
- `planCompaction` returns the largest safe index leaving ≥ `keepRecentTurns`
  turns; returns `null` when `cutIndex <= protectedPrefix` (asserted at
  `protectedPrefix` of 0, 1 and 2); never returns an index that is not in
  `findSafeCutIndices`.
- `validateHistory` catches each of the four reasons, and passes every history
  `planCompaction` can produce (property test over generated histories).
- Loop: `shouldCompact === false` → **zero** awaits, zero events (assert the
  emitted event list is byte-identical to a run without a manager).
- Loop: a manager returning a history with an orphan `tool_result` → **not**
  adopted, `compaction_end.applied === false`,
  `reason.startsWith('invalid_history')`, and `messageManager.getAll()` is
  reference-identical to before.
- Loop: a manager that throws → run continues, `applied === false`,
  `reason.startsWith('manager_threw')`.
- **Loop / P1-2: a manager that mutates `ctx.messages` in place** (splices it to
  length 1) and then returns `{action:'keep'}` → `messageManager.getAll()` is
  unchanged. This fails against `getAll() as Message[]` and passes against the
  shallow copy, which is the whole point of the copy.
- **Loop / P1-1: `probe.lastUsage` is `undefined` on turn 1 and deep-equals the
  previous `turn_end`'s usage on turn 2.** The regression that catches "hoisted but
  never assigned".
- **Loop / P0-1: a stub provider throwing `context_overflow` on every attempt →
  exactly ONE compaction**, then the error propagates. This is the test that
  distinguishes a live `overflowRecovered` from a dead one; v1's sketch passes the
  two-attempt case and fails this one.
- Watchdog: with `idleTimeout: 50` and a manager that resolves after 200 ms, the
  run is **not** aborted; `pause` / `resume` are called exactly once each.
- **Watchdog / P1-3: a manager returning a promise that never settles** → the run
  ends within `COMPACTION_HARD_TIMEOUT_MS` (injected small in the test) with
  `applied === false`, `reason === 'manager_timeout'`, **and `watchdog.resume()`
  called** — asserting the `finally`, because a `compaction_end` that is never
  emitted leaves the run permanently deaf.
- **Watchdog / P1-3: abort during a non-settling `compact()`** → `runCompaction`
  returns, `reason === 'aborted'`, and no request is sent afterwards. (AC-14 is
  only true if the *engine* races the signal; a host that ignores it must not be
  able to make Esc inert.)
- Overflow: a stub provider that throws `errorType: 'context_overflow'` on
  attempt 1 and succeeds on attempt 2 → exactly one compaction, exactly two
  requests, run completes.
- Abort during `compact()` → no request is sent after it returns.

**CLI.**
- `occupiedTokens` includes both cache fields; a usage with only
  `input`/`output` is unchanged (the regression guard for §3.4.1).
- **C-14 / P1-10: a source scan asserts `cacheReadTokens` / `cacheWriteTokens`
  are written in `providers/anthropic.ts` and nowhere else.** The additive-only
  invariant `occupiedTokens` rests on is a property of the adapters, not of
  `TokenUsage`, so it needs a test that fails at the moment someone maps OpenAI's
  inclusive `prompt_tokens_details.cached_tokens` onto the same field.
- `computePressure` falls back to `estimatePromptTokens` and marks
  `source: 'estimate'`.
- **P1-11: `estimateOffset` is `occupiedTokens(usage) - estimateOf(history)`
  clamped at 0, is recomputed on every `turn_end`, and is applied to the fallback
  ratio, the post-compaction gauge value and guard 3's projection.** Asserted with a
  tool-definition-heavy request, where the raw estimate is provably lower than the
  reported `input_tokens`.
- The headroom co-trigger fires at 32 k / `maxTokens: 8192` / ratio 0.88 and
  does **not** fire at 200 k / same ratio.
- `clampCompactionConfig` forces `warnThreshold < threshold` from both
  directions, **and clamps `threshold` first** — `{threshold: 0.6, warnThreshold:
  0.9}` must yield `warnThreshold: 0.55`, not a warn mark above the trigger.
- **C-13 / P1-5: a stored `enabled: false` survives a run that passes no flag**,
  and `--compaction` overrides it to `true`. The failing version of this test is the
  one where only `--no-compaction` is declared.
- Digest: budget is the min of the constant and the summarizer-window
  derivation; oldest-first eviction; the omission marker appears exactly when
  something was evicted; a `thinking` block contributes zero characters.
- **P1-9: a prior `<compacted_context>` block in the head is carried at up to
  `summaryMaxChars`, not clipped to `userChars`, and is evicted LAST.** Asserted
  with a 5 500-character block: the digest must contain all of it.
- Ladder: fast-tier failure → main-model retry → truncation; `onFailure: 'stop'`
  → `{action:'keep'}` and an error notice.
- Guards: cooldown, per-run cap, progress requirement, and self-disable after
  `stuckLimit` — each asserted independently, and the self-disable notice text
  asserted verbatim (it names the remedies; a wording drift makes it useless).
- **P1-13: guard 3 does not veto an `overflow` compaction; guard 4's self-disable
  does not suppress one; the `keepRecentTurns` halving applies to the overflow
  attempt only and is not persisted.** Three assertions, because trigger-blind
  guards would pass a test that only exercises the pressure trigger.
- **P1-9 / idempotence: compact the same conversation TWICE.** After pass 2 the
  history's first message still contains the original task text; there is exactly
  **one** `<original_task>` and exactly **one** `<compacted_context>`; and
  `generation` is `2`. Then a third pass with nothing new → `planCompaction` returns
  `null` via `protectedPrefix` rather than re-summarizing the summary.
- Goal anchor: always its own leading message; `<original_task>`-tagged for the
  text shape (with the `[truncated]` marker past `anchorChars`), byte-verbatim for
  the `ContentPart[]` shape with `anchor="verbatim"` on the block; **present, and
  recognizable, in both cases and in `mode: 'truncated'`**.
- Reducer: `compactionEnd` sets `contextTokens` to `estimatedTokensAfter +
  estimateOffset` (§6.2); `compactionUsage` adds to `usageTotal` with the
  precomputed delta; `clearTranscript` / `resetConversation` drop
  `compactionEntryId`.
- **P1-4: `compactionStart` with `trigger: 'overflow'` rewrites a trailing
  `context_overflow` error notice to `level: 'info'`**, leaves an identical notice
  that is *not* the tail entry alone, and leaves a `trigger: 'pressure'` start
  alone.
- **P1-6: one `CompactionEvent` produces exactly one `kind: 'compaction'` entry
  and one `tokensReclaimed` increment.** Driving the reducer with both the core
  events and the CLI event must not double anything — the regression for the
  double-dispatch v1 permitted.
- Persist: a saved `live: true` compaction entry loads settled (C-8), asserted
  through `loadSession`, not through the normalizer directly.
- Render: the card in `summarized` / `truncated` / `failed` / `live` states;
  `ActivityLine` shows `Compacting context…` even when `runningTool` is set;
  the chip is absent below `statusCompactCols`; `buildGauge` with no `marks` is
  byte-identical to today, **and with `marks` preserves the `>high` / `>=warn`
  operators**.
- **C-15 / P1-8: the Ctrl+O target predicate selects a trailing `kind:
  'compaction'` entry**, and `/expand` still selects only tool cards.
- `glyphs.test.ts` fails if a non-ASCII literal is added under
  `src/compaction/` (proving C-7's regex was actually updated), **and
  `CompactionCard.tsx` contains no literal arrow** (P2-7).

### 8.2 Acceptance criteria

| # | Criterion |
|---|---|
| **AC-1** | With `compaction.enabled: false`, a run's emitted `AgentEvent` sequence, request bodies and rendered frames are byte-identical to a pre-feature build. |
| **AC-2** | With defaults, a session driven past 90 % occupancy compacts **before** the next request is sent, and that request's `input_tokens` is lower than the previous turn's. |
| **AC-3** | The status-bar percentage that triggers compaction is the same number the user was looking at one turn earlier (one `occupiedTokens`, §3.4.1). |
| **AC-4** | During compaction the activity row reads `Compacting context…`, and exactly one spinner is animating anywhere on screen. |
| **AC-5** | Immediately after compaction the gauge falls; it does not wait for the next `turn_end`. |
| **AC-6** | The transcript keeps a card recording before/after message counts, before/after tokens, the summarizer model, the duration, and an expandable summary. |
| **AC-7** | The user's original task text is present verbatim in the compacted history in every mode, including `truncated`, **as the first message and identifiable by `<original_task>` or by `anchor="verbatim"`** — so the assertion is mechanical rather than a substring search (§3.6.5). |
| **AC-7a** | Compacting the same conversation **twice** leaves exactly one `<original_task>` and one `<compacted_context>`, still carrying the original task text; a third pass with no new material returns `null` rather than re-summarizing the summary (P1-9). |
| **AC-8** | A compacted history never contains an orphan `tool_result` or an unclosed `tool_call`, asserted by `validateHistory` over 10 000 generated histories. |
| **AC-9** | A `ContextManager` returning an invalid history changes nothing: the run continues on the original messages and the transcript says why. |
| **AC-10** | A 60-second summarization does not trip the idle watchdog. |
| **AC-10a** | A `ContextManager` whose `compact()` never settles does not hang the run: it ends within the engine's hard ceiling with `applied: false` / `reason: 'manager_timeout'`, and the watchdog is resumed (P1-3). |
| **AC-11** | A provider returning `context_overflow` on a session whose static window is wrong recovers: one compaction, one re-send, run completes. |
| **AC-11a** | A provider returning `context_overflow` on **every** attempt produces exactly one compaction and exactly two requests, then propagates the error — the one-shot guard is real, not reset by the recovery's own `continue` (P0-1). |
| **AC-11b** | After a **successful** reactive recovery, no `level: 'error'` notice mentioning `/reset` survives in the transcript; the user sees one informational "compacting and retrying" line instead (P1-4). |
| **AC-12** | Two consecutive **pressure** compactions that reclaim nothing self-disable the proactive trigger with a notice naming the cause and the remedies; no third pressure call is made. |
| **AC-12a** | After that self-disable, a `context_overflow` still triggers a reactive compaction — the anti-loop guards cannot switch off the path that answers a provably impossible request (P1-13). |
| **AC-13** | Compaction never runs on two consecutive turns and never more than `maxPerRun` times in one run. |
| **AC-14** | Esc during compaction ends the run without sending a request. |
| **AC-14a** | AC-14 holds even when the `ContextManager` ignores the signal entirely: the **engine** races it (P1-3). |
| **AC-15** | Compaction spend appears in `usageTotal`, priced with the summarizer's table; an unpriced summarizer reports `pricing unknown` rather than `$0.00`. |
| **AC-16** | `/compact` while idle compacts immediately; while running it queues and compacts at the next turn boundary, with a toast saying so. |
| **AC-16a** | The **idle** `/compact` path refuses an invalid history exactly as the engine does: `validateHistory` is called before `replaceMessages`, a failure changes nothing, and the card reports the same `invalid_history: <reason>` string (P1-7). |
| **AC-17** | `/compact status` reports the same occupancy, threshold and totals as the status bar and the card. |
| **AC-18** | `aragon exec --output-format stream-json` emits `compaction` start/end events; `EXEC_SCHEMA_VERSION` is unchanged; a consumer ignoring unknown types is unaffected. |
| **AC-19** | A session saved mid-compaction resumes with a settled card, and `Transcript`'s settled boundary advances past it. |
| **AC-20** | `npm run build && npm test` pass in both packages. **Every NEW file is under the 1 000-line guideline**, and no modified file grows by more than ~40 lines: `controller.ts` gains one field, one `attach` call and ~6 forwarders; `builtins.ts` gains a registration only (the body is in `compaction/command.ts`); all state lives in `compaction/wiring.ts`. *(Restated in v2: the original wording — "no file exceeds the 1000-line guideline" — is unsatisfiable, because six of the files this change touches already do: `App.tsx` 2 235, `cli.tsx` 1 929, `schema.ts` 1 730, `reducer.ts` 1 673, `controller.ts` 1 443, `builtins.ts` 1 204. An AC that cannot pass is one that gets waved through, and a waved-through AC teaches the next reader that this list is decorative — C-16 / P1-12.)* |
| **AC-21** | The Ctrl+O hint the card renders actually works: pressing it expands the compaction card's summary (C-15 / P1-8). |
| **AC-22** | One compaction produces exactly one transcript card and one `tokensReclaimed` increment, with both the core events and the CLI-local event delivered (P1-6). |

### 8.3 Manual test pointers (`manual-test.md`, authored with the implementation)

1. Small-window run: point at a 32 k model, ask for four large file reads, watch
   the headroom co-trigger fire below 90 %.
2. Resume pressure: `/save` a large session, restart, `/resume`, confirm the
   gauge reads `~` and compaction fires on the **first** turn.
3. Wrong-window recovery: set `baseUrl` to a proxy in front of a smaller model
   and confirm the reactive path.
4. Fast-tier summarizer: `/fast model <cheap>` + `compaction.useFastTier: true`,
   confirm the card names the cheap model and the digest fits its window.
5. Failure ladder: kill the network during summarization; confirm the retry, the
   truncation, the warn notice, and that the run continues.
6. ASCII terminal (`cmd.exe`, `ARAGON_UNICODE=0`): card, chip and activity row
   render without mojibake.
7. Narrow terminal (60 cols): chip drops, gauge survives, `/compact status`
   still answers.
8. `--no-compaction`: nothing is registered, `/compact` says so, and a run at
   95 % dies exactly as it does today.
9. **Persisted off, no flags** (v2 / P1-5): `aragon config set compaction.enabled
   false`, restart with **no flags at all**, and confirm `/compact status` still
   reports it off. The failure this catches is silent and happens on every run.
10. **Two compactions in one session** (v2 / P1-9): drive past the threshold twice
    and confirm the second card still shows the original task, that `/compact
    status` reports `generation: 2`, and that the second summary contains facts the
    first one recorded rather than a thinner paraphrase of them.
11. **Reactive path, watching the transcript** (v2 / P1-4): with a proxy in front of
    a smaller model, confirm the user never sees a red "start a new conversation
    with /reset" banner on a recovery that succeeds.

Rows 1, 2, 3, 5, **9, 10 and 11** are recorded as **not skippable**: each covers a
failure that is invisible in a unit test or invisible until it has already cost the
user something.

---

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| **R-1** | **The summary is wrong or lossy, and the agent proceeds confidently on a false record.** This is the feature's defining risk and it cannot be eliminated. | The goal anchor is verbatim (§3.6.5); the tail is verbatim; the prompt forbids inventing facts and asks for verbatim identifiers; the block tells the model the history was compacted; the card and `/compact status` make it visible so the user can intervene. |
| **R-2** | **An invalid splice makes the conversation permanently un-sendable** — the worst possible outcome, because `/reset` becomes the only exit. | Structural validation in the **engine**, not the host (§3.3 step 5 / §5.3), with a property test over generated histories (AC-8). A host bug degrades to "no compaction". |
| **R-3** | **A summarization loop burns money.** | Four independent guards (§3.8), one of which permanently self-disables with a diagnosis. |
| **R-4** | **The summarizer's own window is too small for the digest.** | The digest budget is derived from the summarizer's `contextWindow` (§3.6.3), not from a constant alone. |
| **R-5** | **`contextWindow` is a guess (128 k) for unknown models**, so the trigger may never fire. | The reactive path (§3.5) makes a wrong window a recoverable event rather than a fatal one; the `~` prefix tells the user the number is approximate. |
| **R-6** | **Occupancy under-reports behind a caching gateway** — a live defect today. | `occupiedTokens` includes both cache fields, and the gauge and the trigger share it (§3.4.1). |
| **R-7** | **The watchdog aborts a slow summarization.** | Pause/resume in `Agent.emit`, applied before listeners, `stop()` clears `paused` (§3.3 / C-4). |
| **R-8** | **The naming collision with `DensityMode: 'compact'`** produces a future reader who edits the wrong thing. | Code spells it `compaction` everywhere; only the user-facing command is `/compact` (C-11 / D-13). |
| **R-9** | **A new `Entry` kind that never settles re-renders the tail forever.** | The fifth `normalizeLoadedEntries` clause, the `computeSettledCount` clause, and both `virtual-window` switches (C-8 / C-9), each with a test. |
| **R-10** | **Compaction fires during a `task` dispatch**, whose tool call can run for minutes. | It cannot: the checkpoint is between turns, and a dispatch is one tool call *inside* a turn. Stated so a future "compact whenever pressure is high" refactor knows what it would break. |
| **R-11** | **Two sources of truth for occupancy** drift, and the user stops trusting the gauge. | One exported function, two call sites, one regression test (AC-3). |
| **R-12** | **`enabled: true` by default changes behaviour for existing users.** | It changes it in the direction of not dying; the CHANGELOG says so; `--no-compaction` and one config key restore the old behaviour exactly (AC-1) — **and both commander forms are declared so the config key actually survives a flagless run** (C-13 / P1-5, without which this mitigation is false). |
| **R-13** | **A host bug hangs the run with the idle detector switched off.** `compaction_start` pauses the watchdog, and a paused `IdleWatchdog` swallows every `kick()`. A non-settling `compact()` is then worse than the pre-feature behaviour. | The engine races the call against `ctx.signal` and a hard 120 s ceiling, and emits `compaction_end` from a `finally` so the watchdog always resumes (§3.3 / P1-3 / AC-10a / AC-14a). |
| **R-14** | **Repeated compaction decays the record to nothing.** The second pass summarizes the first pass's output; if that output is clipped, or if the anchor rule promotes a summary to "the original task", the loss compounds silently and every card still says `summarized`. | The anchor is structurally identified and carried untouched; the prior block is carried whole and evicted last; the summarizer is told to merge rather than re-condense; `protectedPrefix` makes "nothing new to summarize" a `null` instead of a lossy no-op (§3.6 / P1-9 / AC-7a). |
| **R-15** | **The anti-loop guards disable the reactive path in the sessions that need it**, turning a recoverable overflow into a dead run. | The guards are trigger-aware: guard 3 advises on overflow, guard 4 suppresses the pressure trigger only, and an overflow attempt may halve `keepRecentTurns` for itself (§3.8 / P1-13 / AC-12a). |
| **R-16** | **A future adapter reinterprets the cache token fields** and `occupiedTokens` silently double-counts, firing compaction early on every session of that provider. | The additive-only invariant is written down (C-14) and asserted by a source scan (§8.1 / P1-10); an inclusive-total provider must add a differently named field. |
| **R-17** | **The gauge mixes a measured number with an estimated one**, so it falls too far after compaction and climbs back for no visible reason — the same doubt the immediate drop exists to remove. | `estimateOffset` calibrates every estimated figure against the last measurement, and the `~` prefix stays while a value is derived (§3.4.2 / §6.2 / P1-11). |

---

## 10. Decisions

| # | Decision | Why |
|---|---|---|
| **D-1** | Compact **inside the loop at a turn boundary**, not at `agent_end`. | The window fills *during* a long run; an `agent_end` design watches it die (§1.2). |
| **D-2** | **Core owns the mechanism, the CLI owns the policy.** | Core has no `ModelInfo` and must not learn one (`no-host-coupling.test.ts`); the CLI already resolves the window for the status bar. |
| **D-3** | The port is **`shouldCompact` (sync) + `compact` (async)**, not one async method. | Keeps "off" and "below threshold" free of a promise allocation per turn, which is what makes AC-1's byte-identity claim true. |
| **D-4** | The engine **validates and may refuse** the host's history. | An orphan `tool_result` is an unrecoverable 400 (`anthropic.ts:471-484`); a host bug must not be able to produce one. |
| **D-5** | Summarize into a **`user` message**, never a fabricated assistant message. | A fake assistant turn is a lie the model then acts on. |
| **D-6** | **Preserve the first user message verbatim** as a goal anchor. | A 90 %-faithful summary is fine for the middle of a conversation and catastrophic for the sentence that says what the user wanted. |
| **D-7** | **Digest, don't ship raw messages,** to the summarizer. | Tool bodies are the bulk and say the least; and the summarizer's window may be a fraction of the lead's (§3.6.3). |
| **D-8** | **Drop thinking blocks from the digest.** | Largest contributor at `thinkingLevel: high`, and nothing after the turn depends on them. |
| **D-9** | **Truncate rather than stop** on total summarization failure (default). | An unattended run that wedges on a 400 loses everything; an announced truncation loses some context. The user who disagrees sets one key (§3.7). |
| **D-10** | The summarizer gets its **own fail-fast registry**, `maxRetries: 1`. | A background repair must not compete with the user's own work for a rate-limited quota — the `fast/wiring.ts:210` argument, applied unchanged. |
| **D-11** | **One `occupiedTokens`** shared by the gauge and the trigger, including cache tokens. | Divergence trains the user to distrust the gauge; and the current formula is already wrong behind a caching gateway (§3.4.1). |
| **D-12** | The trigger is **`ratio ≥ threshold OR headroom < required`**. | A pure ratio is right for 200 k windows and quietly wrong for 32 k ones (§3.4.3). |
| **D-13** | Code says **`compaction`**; the command says **`/compact`**. | `DensityMode: 'compact'` and `statusCompactCols` already own the short word (C-11); users already know the command name. |
| **D-14** | **No learned context ceilings** in v1. | The reactive path already survives a wrong window; a learning cache is a second source of truth to get wrong (§1.3). |
| **D-15** | **Subagents get no `ContextManager`** in v1. | Children are bounded by their dispatch timeout and turn cap; giving them one makes a dispatch's cost unpredictable. |
| **D-16** | `enabled` defaults to **`true`**. | Every other optional subsystem here adds behaviour; this one removes a failure. Byte-identity is preserved under `--no-compaction` (§4.2). |
| **D-17** | `/compact` while running **queues** rather than refusing or racing. | The turn boundary is the only moment the engine is single-threaded with respect to the history; a flag honoured there is safe, `replaceMessages` under a live loop is not. |
| **D-18** | The **summary is not on the exec JSON stream**. | It can be tens of thousands of characters, no wrapper needs it, and the log and the card already have it. |

### v2 decisions (from the review)

| # | Decision | Why |
|---|---|---|
| **D-19** | `CompactionWiring` is **constructed before the `Agent` and attached after it**; its constructor must not subscribe. | It has to be inside the `Agent`'s constructor argument *and* subscribe to the `Agent`. `controller.ts:536` / `:572` and `FastWiring`'s own comment make that ordering non-negotiable (C-12 / P0-2). Splitting construction from attachment is the only shape that satisfies both and keeps `contextManager` genuinely `undefined` when the feature is off. |
| **D-20** | The **CLI-local `CompactionEvent` stream is the sole source of reducer actions**; `reduceEvent` gains no cases for the two core events. | One compaction arriving through two channels is two cards and a doubled reclaim total. The stream is strictly richer (model, price, session totals) and C-5's `default: return []` already handles core's events correctly, so this is also the smallest change (P1-6). |
| **D-21** | The goal anchor is **always its own leading message and always structurally tagged**. | v1's merge-when-short optimization saved one message and made the rule non-idempotent: on the second compaction the "first user message" is a summary. A tag makes recognition exact instead of length-dependent (P1-9). |
| **D-22** | A prior `<compacted_context>` block is carried into the digest **whole and evicted last**, and the summarizer is told to merge it. | It is a `user` message, so v1's per-kind clip would have discarded two thirds of it on every subsequent compaction while still reporting `summarized`. It is also the densest thing in the head by construction (P1-9). |
| **D-23** | Estimated occupancy is **calibrated with an offset** measured against the last real `turn_end`, not used raw. | `estimatePromptTokens` never counts the tool definitions the request carries, so the estimate is biased low in exactly the direction that matters, and comparing it against thresholds set from measurements is comparing two units. One shared *function* is not the same as one shared *unit* (P1-11). |
| **D-24** | The anti-loop guards are **trigger-aware**: guard 3 advises on overflow, guard 4 suppresses the pressure trigger only, and an overflow attempt may halve `keepRecentTurns` for itself. | A pressure compaction that reclaims little should stop; an overflow compaction that reclaims little is the difference between a live run and a dead one, because the provider has already refused the request (P1-13). |
| **D-25** | `/compact` while **idle** calls `validateHistory` itself before `replaceMessages`. | The engine's gate is not reachable when there is no loop, and D-4 says that gate is unbypassable. `validateHistory` is already a public export, so honouring D-4 on the manual path costs three lines (P1-7). |

---

## 11. Definition of done

1. `packages/core` builds and tests green; `public-api.test.ts` updated together
   with `API.md` and `CHANGELOG.md` (the three-sync discipline, C-6) — **four**
   runtime names, including `CHARS_PER_TOKEN`.
2. `packages/cli` builds and tests green; `glyphs.test.ts::inScope` includes
   `compaction` and the scan passes (C-7).
3. Every acceptance criterion in §8.2 has at least one automated test, except
   AC-11 and AC-15, which are covered by a stub-provider integration test and a
   manual row respectively.
4. `manual-test.md` exists with the **eleven** rows in §8.3, each with an expected
   observation, and rows 1, 2, 3, 5, 9, 10 and 11 recorded as **not skippable**.
5. **Every new file is under 1 000 lines and no modified file grows materially**
   (AC-20 as restated): `controller.ts` gains one field, one `attach` call and its
   forwarders; `builtins.ts` gains a registration only. The pre-existing six files
   over the guideline are not this change's to fix and not this change's to worsen
   (C-16).
6. A default session that never reaches the threshold produces byte-identical
   output to the pre-feature build (AC-1), asserted by an event-sequence
   snapshot rather than by inspection — which requires `contextManager` to be
   genuinely `undefined` when off, i.e. the spread in §3.2.1 rather than a
   permanently-installed adapter object.
7. `README.md` documents the config section, **both** flag forms, the env vars and
   `/compact`; states that the default summarizer is the session's own model unless
   the fast tier is configured (§3.6.4); and states what a red gauge means (§6.2).
   The CHANGELOG entry states the `enabled: true` default and how to turn it off.
8. **Every P0 and P1 in `## 评审记录` is closed in the body**, each with the test or
   assertion named in §8.1 / §8.2. No finding is resolved by deleting the claim it
   contradicted.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Nine findings from building the feature. Each records what the design said, what
the tree actually required, and what was done — the implementation followed the
corrected approach in every case rather than deviating silently.

**Eight are closed; IF-9 is reported rather than fixed** (it is about an
acceptance criterion's wording, not about the code).

Five of the nine are files or guards the change plan in §7 did not list; two
(IF-2, IF-4) are defects in the implementation, both caught by the tests §8.1
specified; IF-5 is a rounding artefact; IF-9 is the AC. **None of them argues for
a different architecture**, which is the useful headline: the port shape, the
engine-owns-validation posture and the construct-before/attach-after split all
survived contact unchanged.

### IF-1 — RT-4 (`skills/__tests__/upstream-contracts.test.ts`) was not in the change plan, and this feature makes its central claim false

**What the design said.** §7 lists the files this change touches. That test is not
among them.

**What the tree required.** RT-4 asserts, in its own words, that *"no
history-trimming API exists in the engine"*, by scanning
`message-manager.ts`, `agent-loop.ts` **and** `agent.ts` for
`/(prune|compact|evict|trim|truncateHistory)\w*/i`. Context compaction puts the
word `compact` in two of those three files by design, so the assertion goes red
on the first commit — which is exactly what it was built to do. Its own remedy
text names the case: *"If you are introducing history trimming or compaction,
that claim stops being true — clear `SkillRegistry.active` when history is
dropped, or make the digest unconditional-full."*

**Why neither of its two suggested remedies was taken.** The skill digest tells
the model an earlier copy of a skill body is above in the transcript. After
compaction that can be false. But `renderSkillDigest`'s omitted-body note already
names **both** conditions under which `force=true` is the right answer — *"If you
cannot find the earlier copy, **or it was truncated**"* — and that clause was
added (P1-6 of the skills round) for a *truncated* earlier copy. A
*compacted-away* one is the same situation from the model's point of view and the
same escape hatch resolves it. Clearing `SkillRegistry.active` from the loop would
additionally require the engine to reach into the skill registry, which is a
coupling this package does not have and should not grow for this.

**What was done.** RT-4 now asserts the narrower and more useful thing:

- the **message store** still has no trimming API (unconditional scan, unchanged);
- `MessageManager`'s six public methods are unchanged;
- the loop shrinks history in **exactly one place**, and that place is downstream
  of `validateHistory` — asserted by counting `messageManager.restore(` in
  `agent-loop.ts` and requiring the `validateHistory` call and the `if (!cm)`
  opt-out gate;
- the digest's `force=true` escape hatch **still exists** — a new assertion, so
  deleting it turns a compacted session's repeat `skill()` call into a confident
  pointer at nothing.

The self-check that proves the regex is not vacuous is unchanged.

### IF-2 — a host that resolves `compact()` with the wrong shape killed the run

**What the design said.** §3.3 step 4: *"a host that breaks its own contract must
degrade to 'compaction did not happen', never to 'the run died'"*, implemented as
an inner `try/catch` around the awaited call.

**What the tree required.** That `catch` covers a **rejected** promise. It does
not cover a promise that **resolves with the wrong thing** — which is the commoner
mistake, because `ContextManager` is an interface a host implements in its own
package and is therefore untyped at this boundary at runtime. A stub, a mock, or a
host that forgot a `return` all arrive as `undefined`; reading `.action` off that
throws **outside** the inner catch. `compaction_end` is still emitted (the
`finally` does its job, so the watchdog is correctly resumed), but the throw
escapes `runCompaction` and ends the run — precisely the failure step 4 forbids.

Found by a unit test whose stub `compact` was `vi.fn()`, which is exactly how a
real host's mistake would look.

**What was done.** `normalizeOutcome()` in `agent-loop.ts` coerces anything that
is not a well-formed `CompactionOutcome` — `undefined`, `null`, a non-object, an
unknown `action`, or a `replace` with no `messages` array — into
`{ action: 'keep', reason: 'manager_bad_outcome' }`. Two regression tests.

### IF-3 — `logging/install.ts` was not in the change plan, and its union must be a superset of core's

**What the design said.** §7 does not list it.

**What the tree required.** `AgentEventSource.subscribe` takes a listener of
`AgentLogEvent`, a deliberately loose structural mirror of core's `AgentEvent`.
Adding two members to core's union makes `AgentController` structurally
incompatible with `attachAgentEvents`, and **every call site fails to
type-check** — three in `cli.tsx`. That is the right failure mode (loud, at
compile time), but it means the file is in the change plan whether the design
listed it or not.

**What was done.** Two members added, plus two `case`s that record the compaction
at `info` under the **`agent`** scope — because this module logs the lead's
lifecycle, and a run's `agent` records must not have an unexplained 40-second gap
where a summarization was. `compaction_end` with `applied: false` logs at `warn`,
because the run is still at the occupancy that triggered it. The `summary` field
is never read, for the reason this file's `message_update` case already records.

`LogScope` also had to gain `'compaction'`, which §3.10 asks for but §7 does not
list.

### IF-4 — `countProtectedPrefix`'s verbatim-anchor branch had an off-by-one

**What the design said.** §3.6.5: the host recognizes the leading anchor and, if
present, the `<compacted_context>` block right after it, and passes the count as
`protectedPrefix`.

**What the tree required.** The first implementation read `messages[n]` where `n`
was still `0` — i.e. it re-read the anchor's own slot instead of the one after
it. The **tagged** shape was unaffected (it sets `n = 1` first), so the defect was
invisible for the common path. The **verbatim** shape — a first message carrying
`ContentPart[]`, i.e. a task that depends on an image — returned `0`, which means
the anchor and the block go back into the head and get re-digested on every
subsequent compaction. That is P1-9's exact decay, arriving through the back door,
and nothing raises.

**What was done.** Rewritten as three explicit cases with no shared cursor.
Regression test asserts `[image, block, next] -> 2`.

### IF-5 — floating point made the persisted thresholds seventeen digits long

**What the tree required.** `threshold - WARN_THRESHOLD_GAP` is `0.95 - 0.05`,
which is `0.8999999999999999`, and `parseThresholdInput('90')` is `90/100`. Both
land in `config.json` and in `aragon config list`. A seventeen-digit value for a
setting the user typed as `90%` looks like corruption and invites a hand-edit that
the clamp then has to defend against.

**What was done.** `clampCompactionConfig` rounds both ratios to two decimals,
which is exact for every value the `[0.5, 0.95]` range can hold and matches the
whole-percentage unit the UI reads them in.

### IF-6 — the design's own test scaffolding needed one seam core did not have

**What the design said.** AC-10a requires that a non-settling `compact()` ends
within the engine's hard ceiling, *"injected small in the test"*.

**What the tree required.** `COMPACTION_HARD_TIMEOUT_MS` is a module constant in
`agent-loop.ts` — deliberately, because *a constant the host owns is a constant
the host can get wrong* — so there was nothing to inject and the assertion would
have taken two minutes of wall clock.

**What was done.** `AgentConfig.timeouts.compactionHardTimeout?` and the matching
`AgentLoopContext.timeouts` field, both documented as existing **only** so AC-10a
is testable and explicitly **not** a policy knob. Production behaviour is
unchanged: the field is spread conditionally, so an omitted value produces the
same loop context it did before.

### IF-7 — fifteen test fixtures and four stub controllers were not in the change plan

**What the tree required.** `tsconfig.json` **excludes** `**/__tests__/**`, so
adding the ninth nested config section is invisible to the type-checker in test
code and shows up as a runtime `TypeError` in fifteen files. Separately, four
files hand a hand-written stub to `App` as `... as unknown as AgentController`,
so three new controller methods are likewise not a compile error there — the same
TypeScript blindness those files already document for the fast tier's four.

**What was done.** `compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false }`
in every `CliConfig` fixture (`enabled: false` matching what those same fixtures
already do for `skills`, `team` and `todo`), and `isCompactionRegistered` /
`getCompactionSnapshot` / `subscribeCompaction` on the four stubs.

`spinner-census.test.ts` also went red, and it was right to: `CompactionCard` is
the **ninth** animated site, and the census is the checklist for
`single-spinner-while-running` §3.1. It takes `reducedMotion` like the other
eight, so the fix was to record it rather than to exempt it.

### IF-8 — `config/cli-commands.ts` was not in the change plan, and without it the kill switch was unreachable from a script

**What the design said.** §7 lists `config/load.ts`, `config/env.ts` and
`config/store.ts`. It does not list `config/cli-commands.ts`, and §4.2 describes
the six keys as ordinary config keys.

**What the tree required.** `config list` enumerates a section **dynamically**, so
it showed all six `compaction.*` keys the moment the section existed. `config set`
does **not**: it checks membership in a hardcoded `CONFIG_SET_KEYS` set and
dispatches through a per-section `apply*ConfigSet` function, because — as that
file says five times over — a generic dotted writer would write `compaction` as a
FLAT top-level string key, the section would silently never take effect, and
`config set` would still print `Set compaction.enabled = false`.

So `aragon config set compaction.enabled false` failed with
`Unknown config key "compaction.enabled"` while `aragon config list` printed that
exact key one command earlier.

**Why it was a must-fix rather than a note.** `--no-compaction` and `/compact off`
both still worked, so the kill switch was reachable interactively. But
`compaction.enabled: false` is R-12's whole mitigation — "one config key restores
the old behaviour exactly" — and a config key that can only be set by hand-editing
JSON is not that for anyone scripting a fleet. **Manual-test row 9 runs exactly
that command**, so the not-skippable row would have failed at its first step.

Caught by a smoke run of the built binary, not by a test: every unit test in the
feature exercised `loadConfig` and `updatePersistedConfig` directly, and both were
correct. The gap was one layer further out, in the surface a user actually types.

**What was done.** `COMPACTION_CONFIG_SET_KEYS` and `applyCompactionConfigSet`,
following the five existing sections exactly — every key routed through
`clampCompactionConfig` so no key can pick up a different coercion later, the two
thresholds additionally accepting a percentage, and `cli.tsx` echoing the STORED
value so `config set compaction.threshold 0.2` prints the clamped `0.5`. New test
file `compaction-config.test.ts` (19 assertions) covering both `store.ts` merge
halves, the setter, the C-13 flag matrix and all four resolution layers.

### IF-9 — AC-20's "~40 lines" figure is not met by four files, and the number was the wrong bound

**Status: NOT CLOSED. Reported rather than fixed.**

**What the design said.** AC-20 as restated in v2: *"no modified file grows by
more than ~40 lines: `controller.ts` gains one field, one `attach` call and ~6
forwarders; `builtins.ts` gains a registration only; all state lives in
`compaction/wiring.ts`."*

**Measured.** Every **new** file is under 1 000 lines (largest: `compactor.ts` at
701). The two files the AC names by hand are within their stated budget —
`builtins.ts` **+15** (registration only, body in `compaction/command.ts`) and
`cli.tsx` **+24**. Four others are not:

| file | added | comment | code |
|---|---|---|---|
| `agent/reducer.ts` | 299 | 145 | **154** |
| `config/schema.ts` | 178 | 110 | **68** |
| `agent/controller.ts` | 159 | 93 | **66** |
| `ui/App.tsx` | 123 | 65 | **58** |

**Why it was not "fixed".** Every one of those four additions is a change §7
assigns to that file by name, and none of them is policy logic:

- `reducer.ts` gets one `Entry` kind (18 fields), five actions and five cases.
  A `ViewAction` case cannot live anywhere but the reducer; that is what a
  reducer is. It is also the largest of the four for a structural reason — the
  new entry kind's declaration and its two settle paths are inherently verbose.
- `schema.ts` gets the ninth nested config section: an interface, a default, a
  clamp and two `CliConfig` / `PersistedConfig` members. C-10 requires the last
  of those, and the other four cannot be split out without giving `store.ts` a
  second place to import a clamp from.
- `controller.ts` gets one field, the construct block, the `attach` call and
  **eight** forwarders (the AC guessed six; `/compact`'s six forms plus
  `compactNow` and `subscribeCompaction` need eight). All state is in
  `compaction/wiring.ts` as required.
- `App.tsx` gets the `subscribeCompaction` effect §7 mandates, the Ctrl+O
  predicate widening P1-8 requires, and the status-bar props.

**The finding is about the AC, not the code.** A line count is the wrong bound for
a codebase whose house style is this comment-dense: **55 % to 62 % of what was
added to those four files is prose**, and cutting it to hit a number would be
deleting exactly the explanations this document spends its own §2 arguing are
load-bearing. The property AC-20 is reaching for — *new behaviour goes into new
files; the six over-guideline files get registrations, declarations and
forwarders only* — **holds**, and is checkable by reading the four diffs. If the
AC is kept, its bound should be restated in those terms rather than in lines; the
alternative is a criterion that gets waved through, which is the failure P1-12
identified in its first version.

---

## 评审结论 (Review Verdict)

**有条件通过 (Approved with conditions).**

The design is sound and is the right shape for this repo. The three structural
judgements it rests on — mechanism in core / policy in the CLI, compaction at a
turn boundary inside the loop, and the engine validating and refusing the host's
history — are all correct, and I found nothing that argues for a different
architecture. §2's inherited-constraints inventory is the most valuable part of the
document and it is accurate; the reactive path, the failure ladder and the goal
anchor are the right three answers to the three ways this feature can hurt a user.

What the review found was not architectural. It was a consistent gap between what
the prose promised and what the sketches delivered: **two of the safety properties
the document asserts did not exist in the code it specified** (the one-shot overflow
guard, and the port being injectable at all), and eight more were true only if the
host behaved. That gap is the expected failure mode of a spec this detailed — the
prose is written from intent and the code from mechanism — and it is exactly what a
review is for. All 2 P0 and 13 P1 findings are resolved in the body above; the
eleven P2s are fixed where the fix was one line and recorded where it was not.

Approval is conditional on the following, all of which are now written into the
document and none of which are open questions:

1. **The five invariants that are silent when broken must ship with their named
   tests, not just their prose.** P0-1 (`overflowRecovered` cleared after a
   completed stream, never at the top of the loop), P1-1 (`lastUsage` assigned),
   P1-2 (shallow copy across the port), P1-9 (anchor and prior-block idempotence)
   and P1-10 (the additive-cache-field source scan) all fail *quietly*: the feature
   keeps working, reports success, and is wrong. Prose does not hold those; the
   assertions in §8.1 do. If any one of them is dropped during implementation, it
   must be dropped from the document in the same change, with the reason.
2. **C-12's construct-before / attach-after split is verified against
   `controller.ts` before the first line of wiring is written.** It is the one
   finding that makes v1 literally not build as specified, and the failure mode if
   it is got wrong a second way — a field assigned after `new Agent` and spread
   conditionally — is a build where the feature is registered, enabled, and silently
   absent.
3. **Both commander flag forms land in the same commit as the config key.** C-13 /
   P1-5. `cli.tsx` has paid for this seven times; an eighth would silently un-set a
   kill switch on a feature that spends the user's money.
4. **AC-20 stays restated.** If a future reader restores "no file exceeds 1 000
   lines", they will either block a correct change or wave through an AC they cannot
   satisfy. The measured line counts are in C-16 so the restatement can be checked
   rather than trusted.
5. **`manual-test.md` includes rows 9, 10 and 11 as not skippable.** Persisted-off
   survival, two-compactions-in-one-session decay, and the false `/reset` banner are
   the three defects that unit tests can pass while a user still sees them.

One thing deliberately left as accepted risk rather than a condition: **R-1 stands
unmitigated in principle.** A summarizer that is 90 % faithful will, eventually,
drop something a run needed, and no amount of prompt engineering closes that. The
design's answer — verbatim anchor, verbatim tail, a block that tells the model the
record is partial, and three UI surfaces that make it visible so a human can
intervene — is the right answer and it is not a complete one. That is inherent to
compaction as a technique, it is the same trade Claude Code and Codex make, and it
is preferable by a wide margin to today's behaviour, which is to lose the entire
run. It should be stated in the CHANGELOG in those terms rather than implied.

No P0 or P1 remains open. Implementation may begin against **v2**.

---

## 代码评审记录 (Code Review — the implementation, pre-commit)

Reviewed the working tree against §7's change plan (coverage), against the
adjacent subsystems it touches (regression risk), and against this package's own
conventions. **The architecture survived unchanged and every §7 row is
implemented**; the eight findings below are all defects in the seams, and all
eight are fixed in this commit. Five of them are the same species the design
document spends its §2 warning about — code that reports success while doing
something other than what its own comment claims.

Severity key as in `## 评审记录`: **P1** = a stated guarantee is not delivered,
or a defect that is silent in production; **P2** = correctness or clarity, cheap
to fix.

### P1

| # | Finding | Where | Fix |
|---|---|---|---|
| **CR-1** | **The estimate fallback measured an empty history, so §3.4.2 was never delivered.** `Compactor.shouldCompact` called `this.measure(probe)`, and `CompactionProbe` carries `messageCount` but not the messages — the port is synchronous by design (D-3). `computePressure` therefore ran `estimatePromptTokens([], '')`, which is `0`, so occupancy read **0 %** and the proactive trigger could not fire before the first `turn_end` of a run. That is precisely the resumed-180 k-token-session case §3.4.2 calls "the most dangerous single moment in this feature's life", and the naive answer it exists to reject. `compaction-pressure.test.ts` passes either way, because it hands `computePressure` a history directly; manual-test row 2 — **not skippable** — would have failed at its first observation. | `compaction/compactor.ts`, `compaction/wiring.ts` | `CompactorDeps` gains the same lazy `getMessages` / `getSystemPrompt` accessors the wiring already held for `turn_end`, and `shouldCompact` passes them into `measure`. New regression test asserts a huge history with **no** `lastUsage` triggers. |
| **CR-2** | **The idle `/compact` path reported `-> 0 tokens` and inflated `tokensReclaimed` by the whole occupancy.** `compactNow` settled its record with a hardcoded `tokensAfter: 0`, because there is no engine `compaction_end` on that path to supply the pair. The card's headline claim became "118.4k -> 0 tokens" — a compaction that freed the entire window — and `/compact status` carried the same overstatement for the rest of the session. AC-16 / AC-16a assert the splice and the refusal, not the arithmetic. | `compaction/wiring.ts` | Both sides now come from core's own `estimatePromptTokens`, exactly as §5.1 specifies for the in-loop path; a refused splice reports `after == before`. New regression test. |
| **CR-3** | **A verdict arriving before the compactor's record left the transcript card `live` forever.** `runCompaction` races `compact()` against `ctx.signal`, so **Esc during a summarization** — not a host bug, the ordinary abort path — emits `compaction_end` while `compact()` is still unwinding. `settlePending` found no held record, returned, and nothing ever settled the card. That is C-8's failure mode exactly: `Transcript`'s settled boundary is monotonic, so the whole tail re-renders on every frame for the rest of the session while the card goes on claiming a compaction is running. `manager_timeout` (AC-10a) and a `compact()` that rejects outright reach the same place. | `compaction/wiring.ts` | The wiring holds what the CLI `compaction_start` announced, settles from the record when it exists and from that skeleton when it does not, and drops the late record so no second card opens. New regression test times the two streams against each other. |
| **CR-4** | **Guard 4 counted user-requested compactions, so `/compact` twice on a short conversation self-disabled the session.** A queued `/compact` reaches the loop as an ordinary `pressure` checkpoint — that is what the queue *is* — and `runCompaction` charged the result to `noteNoProgress(ctx.trigger, ...)`. Two `/compact`s on a history with nothing worth dropping therefore switched the proactive trigger off for the session and told the user, wrongly, that their most recent turns exceed the threshold. D-24 scopes this guard to the pressure trigger, and `CompactionUiTrigger` exists precisely to tell the two apart. | `compaction/compactor.ts` | `noteNoProgress` / `checkProgress` take the **UI** trigger. New regression test. |
| **CR-5** | **Four type errors were shipping green, because `npm run typecheck --workspaces` exits 0 when a workspace fails.** `tsconfig.json` excludes `__tests__`, so these are invisible to `npm run build` and appear only under `tsconfig.test.json`: `ModelCost` spelled `inputPerMillion` / `outputPerMillion` (it is `input` / `output`), a `TranscriptTextOptions` fixture missing `elapsedMs`, and **two `SettingsValues` fixtures in `max-tokens-ui.test.tsx` that IF-7's sweep missed**. The last pair is this feature's own widening of that type. Both workspaces now typecheck cleanly when run individually — which is the only way to run them. | `__tests__/compaction-compactor.test.ts`, `__tests__/compaction-render.test.tsx`, `__tests__/max-tokens-ui.test.tsx` | Corrected. |

### P2

| # | Finding | Fix |
|---|---|---|
| **CR-6** | **Compaction spend was priced with the LEAD's cost table**, directly under a comment saying it is priced with the summarizer's (`App.tsx`'s `case 'usage'` called `getModelInfo()`). A Haiku summarization on an Opus session was billed at Opus rates in `usageTotal` — the same class of lie as the `$0.00` that `pricingUnknown` exists to prevent, in the other direction (AC-15). `/compact status` had the mirror defect: it reconstructed the summarizer's provider as `fast.enabled ? fast.provider : provider`, which is wrong whenever `fast.enabled` is true and `compaction.useFastTier` is false — that combination looks up the main model under the fast provider, misses the static table, and prints `$0.00` for a priced model while `pricingUnknown` (set from the ref actually used) stays false. | `AgentController.getCompactionSummarizerRef()` carries the ref both callers need. It also gives `CompactionWiring.summarizerRef()` — dead code until now — its consumer. |
| **CR-7** | The live card's headline emitted a dangling separator when no summarizer resolved (`model === ''`, reachable when the provider's key is removed mid-session). | Separator omitted with the model. |
| **CR-8** | `applyCompactionConfigSet`'s doc comment claimed an unparseable value "keeps the current setting". It resolves to the **default** — the same thing `config set retry.maxRetries banana` does, because `clampOne` merges onto `DEFAULT_COMPACTION_CONFIG`. Not silent (`cli.tsx` echoes the stored value), but the comment described a third behaviour that only the settings screen and `/compact threshold` actually have. A dead `reserve = 0` assignment in `digest.ts` went with it. | Comment corrected to the behaviour; dead assignment removed. |

### 未修改的事项 (checked, deliberately left alone)

- **`packages/cli/CHANGELOG.md` now has two `## Unreleased` headings.** The
  second one predates this change (it sits below `## 0.6.0` at HEAD) and is not
  this feature's to clean up.
- **`CompactionRecord.usage`** is declared and never populated. §5.2 declares it
  too, and spend already reaches the user through `compactionUsage` →
  `usageTotal`; removing it would be a spec deviation for no gain.
- **`.claude-index/` and `CLAUDE.md`** are modified in the working tree by an
  unrelated index regeneration and are **not** staged with this feature.

### 评审结论

**通过 (Approved).** The port shape, the construct-before / attach-after split,
the engine-owns-validation posture and the three UI surfaces are all implemented
as designed, and the invariants `## 评审结论` made approval conditional on (P0-1,
P1-1, P1-2, P1-9, P1-10) all ship with their named tests. Every finding above is
fixed in the same commit as the feature, each with a regression test where the
failure was silent. Both packages typecheck; 2 496 CLI tests and 376 core tests
pass.
