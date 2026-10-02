# Fast model tier — design specification

- **Feature slug:** `fast-model-tier`
- **Version:** **v2** (v1 → v2 after the design review recorded in **评审记录**
  below; every P0 and P1 raised there is fixed in the body, and each fix is
  marked `(RV-n)` at the point it lands. The verdict is in **评审结论** at the
  end.)
- **Status:** design only — this node produces no implementation code
- **Package touched:** `packages/cli` only. `packages/core` gains **zero source
  changes** (I-1), for the reason `team-subagents` records: core freezes its
  runtime export list (`public-api.test.ts`) and forbids host coupling
  (`no-host-coupling.test.ts`), and everything this feature needs is already on
  core's public surface (`ProviderRegistry.complete`, `Agent.subscribe`,
  `Agent.steer`).
- **Tree read for this design:** `404f925a`, `@aragon-agent/core` 0.2.6,
  `@aragon-agent/cli` 0.5.6.

---

## 评审记录

*(Review notes — inserted at review time, ahead of §0 so the defects are read
before the design that contained them.)*

Reviewed against the tree at `404f925a` by reading the code each claim rests on,
not by reading the claim. Verified-correct load-bearing assertions are listed
first, because a review that only lists defects gives the next reader no way to
tell which parts were checked.

**Verified accurate (no action):** the three steering checkpoints and their line
numbers (`agent-loop.ts:126` / `:199` / `:214`, including that checkpoint 3
replaces every *remaining* call in the batch, `:216-223`); `Agent.emit()` is
synchronous with per-listener `try/catch` (`agent.ts:340-349`); `steer()` only
enqueues (`agent.ts:260-262`); the loop exits on a tool-less turn
(`agent-loop.ts:344-357`); `ProviderRegistry.complete()` exists and is public
(`providers/index.ts:56`); `LLMRequest` really does carry `temperature`,
`maxTokens`, `thinkingLevel`, `baseUrl`, `signal` (`llm/provider.ts:18-75`);
`IdleWatchdog.pause()` is a boolean (`watchdog.ts:13, 38-42`) — C-6 holds;
`store.ts` merges by hand in exactly two places (`:147-155`, `:194-208`) — C-3
holds; `glyphs.test.ts`'s `inScope` is a hardcoded
`/^(agent|commands|config|team|todo|tools)\//` — C-4 holds and `fast` is genuinely
invisible until added; `env.ts` accumulates one section object and casts it
(`:142-158`, `:182-201`) — C-9 holds; `normalizeLoadedEntries` normalizes both
`team.active` and `todo.live` (`session/persist.ts:94-106`) — C-5 holds;
`subagent.ts` really does read `deps.config.provider/model/baseUrl` and
`deps.config.thinkingLevel` at two adjacent sites (`:254-258`, `:278`);
`App.tsx:548` really does compute team cost from
`controller.getModelInfo().cost`; `controller.subscribe(listener)` already
forwards core `AgentEvent`s (`controller.ts:505`), so the reviewer needs no new
core surface; the bottom-right cell of `/team`'s table is real
(`builtins.ts:230-237`).

Two of the design's riskiest assumptions were checked directly and **hold**, and
the evidence is now recorded in the body so a later "simplification" cannot
quietly invalidate them: (a) injecting at checkpoint 1 produces a second
consecutive `user` message, which is safe because `convertMessages` already emits
one `user` message *per* `tool_result` (`anthropic.ts:411-448`) — multi-tool
batches have always done this; (b) `complete()` does not discard usage, because
all three adapters set `message.usage` before yielding `done`
(`anthropic.ts:255`, `openai.ts:274`, `google.ts:179`).

| # | Severity | Concern | Where fixed |
|---|---|---|---|
| **RV-1** | **P0** | **An aborted run strands the injected `<fast_review>` in the steering queue, and it surfaces in the *next* conversation attributed to the user.** `runLoopWithLifecycle`'s `finally` never clears the queues (`agent.ts:410-425`), and `runAgentLoop` re-tests `ctx.signal.aborted` at `:271` — *after* the last `tool_execution_end` was emitted at `:249`. Esc (or the idle watchdog) during the final tool's `await` therefore still delivers the event, the reviewer's synchronous listener still sees `outstanding === 0` and `isRunning() === true`, it steers, and the loop breaks without ever reaching checkpoint 1. §3.5.4's stated mitigation (clear `pending` on abort) cannot help: `pending` was already consumed. This is R-4 realized through a path D-8 does not cover, and AC-26 asserted a property the design did not deliver. | §3.5.4 (the drain-confirmation rule), §3.5.5, C-10, AC-26/AC-31, R-4, D-19 |
| **RV-2** | **P1** | **The review triggers on `turn_end`, but the frame it digests is not complete until the batch ends.** `turn_end` is emitted at `agent-loop.ts:188`, *before* any tool runs, while `TurnFrame.tools` carries `isError` and `ms`, which only exist at `tool_execution_end` (`:249-256`). The newest frame in every digest was therefore guaranteed to be missing exactly the fact a reviewer most needs — did the last batch fail. | §3.5.1 (frame sealing), §3.5.2, D-20, AC-32 |
| **RV-3** | **P1** | **Two flags are not enough: the tier can stop resolving mid-session.** `/reload`, `/model`, and the settings screen all rewrite `config.provider` / `config.model` / `config.baseUrl` / `apiKeys`, and `fast.provider: ''` / `fast.baseUrl: ''` *inherit* from exactly those. `fastRegistered` is frozen at construction, so `task` keeps advertising `model:"fast"` while `resolveFastTier` has started returning `no_key` — and the child is then built with a `ModelRef` whose provider has no key, dying inside its own loop at `agent-loop.ts:140-145`. | §3.2 rule 8, §3.3 (`fastAvailable`), §3.4, §3.9, AC-33 |
| **RV-4** | **P1** | **An unknown fast model reports its spend as exactly `$0.00`.** `ModelRegistry.buildRuntimeModel` returns `cost: { input: 0, output: 0 }` (`model-registry.ts:149`), and the fast tier is the *most* likely place to name a model the static table has never heard of. §3.6 promised "fast-tier spend is real spend and must reach the status bar"; AC-17/AC-18 would have passed against a zero. Separately, §3.6 named no accessor at all — `controller.getModelInfo()` takes no argument. | §3.6 (`getModelInfoFor`, unknown-cost honesty), C-11, AC-17/AC-18/AC-34 |
| **RV-5** | **P1** | **The change plan busts the repo's own file-size guideline without saying so.** `controller.ts` is 960 lines and `CLAUDE.md` caps a file at 1000; §7 handed it nine new responsibilities. `reducer.ts` is 944 and gains an entry kind plus three actions. | §7 (extraction plan), C-12, DoD 7 |
| **RV-6** | **P1** | **D-8's stated rationale is factually wrong.** `Agent.steer()` does not "silently restart a finished run" — it only pushes onto a queue (`agent.ts:260-262`). The decision is right; the reason given was not, and the *real* reason is the RV-1 mechanism. A wrong reason in a decision table is worse than no reason: it is what the next engineer checks against the code, finds false, and uses to justify reverting the decision. | §3.5.4, D-8 |
| **RV-7** | P2 | `outstanding` must be **assigned** from the `turn_end` message, never carried across turns: checkpoint 2 (`:199-207`) and an abort mid-batch both leave it permanently non-zero for that batch. | §3.5.1 |
| **RV-8** | P2 | `agent_start` carries no payload (`agent.ts:385`), so `runId` is minted by the reviewer, not read from the event. | §3.5.1 |
| **RV-9** | P2 | `tool_execution_end` is emitted *before* its `tool_result` is pushed (`:249` vs `:263`). The design is still correct because `steer()` only enqueues — but that ordering is now stated, because an "improvement" that pushed the block directly would corrupt the conversation. | §3.5.4 |
| **RV-10** | P2 | `message_update` is emitted for **every** stream event (`:170`), so the frame recorder is a synchronous per-token listener. Gate it. | §3.5.2 |
| **RV-11** | P2 | `AssistantMessage.usage` is optional; `computeCost(undefined, cost)` is a `NaN` on the status bar. | §3.5.3 |
| **RV-12** | P2 | A review triggered while a `task` dispatch is executing waits minutes for its window and arrives about a turn long past. | §3.5.5 (`pendingMaxAgeMs`) |
| **RV-13** | P2 | `virtual-window.ts` has **two** switches over entry kind (`:60`, `:146`); `SettingsValues` and `App.tsx`'s save handler are types §7 did not name. | §7 |
| **RV-14** | P2 | `NormalizedSpecs` / `normalizeSubagentSpecs` are exported and have existing callers and tests; changing the arity unconditionally is a needless breaking edit. | §3.4 (`opts` optional) |
| **RV-15** | P2 | A fast child inherits `deps.config.maxTokens`, an ambition sized for the main model. Harmless (the adapter clamps down, `llm/provider.ts:44-52`) but worth one sentence rather than a later bug report. | §3.4 |
| **RV-16** | P2 | `/fast model "provider:model"` must reject a non-adapter provider with the message `cli.tsx:510` already uses, rather than inventing a second wording. | §4.4 |
| **RV-18** | **P1** | **`ProviderRegistry.complete()` is no longer one HTTP call.** An in-flight sibling feature (`llm-api-retry-backoff`, uncommitted in this same working tree: `packages/core/src/llm/retry.ts` plus edits to `providers/index.ts`, `provider.ts`, `types.ts`, `engine/agent.ts`) makes the registry's `complete()` route through a **retrying** `stream()`, and adds `retry_scheduled` / `retry_attempt` stream events that `Agent.emit()` uses to `pause()` and `resume()` the idle watchdog. Three consequences for this design, none of which v1 could have known: `reviewTimeoutMs` becomes a budget for *attempts × (call + backoff)* rather than for one call, so a briefly rate-limited fast provider burns `maxConsecutiveFailures` and self-disables the reviewer for a transient; the retry policy is **registry-global** (`setRetryPolicy`, no per-request override on `LLMRequest`) and the reviewer shares the lead's registry instance, so it cannot opt out; and C-6's single-writer assumption about `IdleWatchdog.pause()` now has two automatic writers, which strengthens I-5 rather than weakening it. | §3.5.3 (timeout semantics + opt-out), §3.5.5 (failure classification), C-6, I-5, R-17, D-24, AC-36 |
| **RV-17** | P2 | Right-sizing: five configuration channels, seven `/fast` verbs, four flags and four env vars for an off-by-default v1 is a lot — but it is *exactly* the `team` / `todo` surface, and matching precedent beats minimising in isolation. Recorded, not changed. If the change has to be cut, §6's team-panel `~` marker and the status chip go first; `/fast status` is the guaranteed reporting surface. | §6 |

---

## 0. Requirement trace (需求映射)

| # | Requirement (as given) | Where it is satisfied |
|---|---|---|
| **R-a** | 「给对应的 Agent 的执行增加一个小模型的功能，也就是快速模型的功能」 | §3.2 the tier, §3.4 delegation, §3.5 review |
| **R-b** | 「用户可以在对应的 TUI 界面中进行设置」 | §4.4 `/fast`, §4.5 settings screen rows |
| **R-c** | 「也可以在对应的配置文件中进行设置」 | §4.2 the `fast` section of `config.json`, §4.3 flags/env |
| **R-d** | 「如果用户不设置的话，默认使用关闭快速模型的状态」 | `DEFAULT_FAST_CONFIG.enabled = false` (§4.2); I-2 pins the byte-identity that makes "off" mean *off* |
| **R-e** | 「用户也可以把快速模型设置成和主模型一样的模型」 | §3.2 — no dedup check anywhere; `/fast same` is a one-word shortcut for it (§4.4) |
| **R-f** | 「大模型…遇到难度较低、或不复杂但非常耗费上下文的任务时，可以派子 Agent 用快速模型去处理」 | §3.4 — `task` gains a per-subagent `model: "fast"`; `<fast_tier>` tells the model *when* (§4.6) |
| **R-g** | 「主 Agent 每隔一定节点数量，触发异步的快速模型检查，并给出主模型反馈意见」 | §3.5 — `FastReviewer`, every `reviewEveryTurns` turns, injected as `<fast_review>` |
| **R-h** | 「通过大小模型协同进行 Agent 的 harness，类似 Claude Code；美观、优雅、顶级设计；稳健、可靠」 | §3.5.4 (the injection window — the correctness core), §6 (UI), §9 (risks) |

---

## 1. Overview

### 1.1 What is being built

A **second, cheaper model** becomes a first-class citizen of a session. The
session already resolves exactly one `ModelRef` (`config.provider` /
`config.model` / `config.baseUrl`) and hands it to the lead `Agent` and to every
subagent. This feature adds a parallel, optional resolution — the **fast tier** —
and two ways to spend it:

1. **Delegation (pull).** The lead decides. `task` — the existing batch
   delegation tool — gains one optional per-subagent field, `model: "fast"`.
   A subagent marked that way is built with the fast tier's `ModelRef` and
   otherwise runs through the identical factory, the identical gates, and the
   identical report. This is where "不复杂但非常耗费上下文" is actually paid for:
   a child that reads nine files and reports four sentences moves ~200 KB of
   file bodies out of the lead's context window and onto a model that costs a
   fraction as much per token.

2. **Periodic review (push).** The harness decides. Every *N* completed turns of
   a run, a `FastReviewer` builds a small digest of what the lead has been doing,
   asks the fast model one non-streaming question about it, and — if the answer
   is not "on track" — injects the answer back into the running loop as a
   `<fast_review>` block. The lead sees a short, second-opinion critique
   mid-run, when it can still act on it, and pays a few hundred tokens for it
   instead of a second full-size model turn.

Both are **off by default and off together**: `fast.enabled` defaults to
`false`, and with it false the system prompt, the `task` schema, the tool array,
the transcript, the status bar and the request payloads are byte-identical to
the tree this design was written against (I-2). The user turns the tier on from
the settings screen, from `/fast`, from `config.json`, from a flag, or from an
environment variable — five channels, one resolution path (§3.7).

### 1.2 Why this shape

Three properties of the existing code decided almost everything below, and they
are worth stating before the design rather than discovering during it.

**The core loop runs tool calls strictly sequentially, and plan mode depends on
it** (`agent-loop.ts:210`, invariant I-P11 of `plan-mode/spec.md`). That is why
delegation rides on the existing `task` batch rather than becoming a new
`fast_task` tool: N single-child tool calls would be N *serial* children, which
is the opposite of the point, and the fan-out already lives inside one tool
execution where the scheduling is ours.

**`Agent.steer()` is not a neutral channel.** It is drained at three
checkpoints, and two of them are destructive to a run that did not ask to be
interrupted (§3.5.4). A background reviewer that calls `steer()` whenever its
answer happens to arrive will, sooner or later, either delete the model's
pending tool calls or produce a conversation Anthropic rejects with an HTTP 400.
The entire reviewer is shaped around *when* it is allowed to speak.

**Every optional subsystem in this package is two flags, not one**
(`teamRegistered`/`teamEnabled`, `todoRegistered`/`todoEnabled`). The tool array
is built once and must not be rebuilt; the system prompt *is* a live path. This
feature adopts the same split for the same reason and with the same honest
message when they disagree (§3.3).

### 1.3 Non-goals (v1)

1. **No third tier.** `main` and `fast`, and no `tiny`. A third tier doubles the
   resolution surface and the report's cost arithmetic to serve a case nobody
   has asked for.
2. **No automatic tier selection for the lead itself.** The lead never silently
   runs a turn on the fast model. "The harness quietly answered you with a
   cheaper model" is the single most damaging thing this feature could do to
   trust, and no amount of accuracy heuristics makes it safe.
3. **No review of subagents.** Children are reviewed by the report they produce
   and by their lead. A reviewer per child multiplies the cost by
   `maxConcurrent` and puts a critique where nothing can act on it.
4. **No streaming for the review call.** It is one bounded, non-streaming
   `complete()` (§3.5.3); nothing renders it token by token.
5. **No persisted review history.** Reviews are transcript entries and log
   records. `/save` carries the entries it already carries; there is no separate
   file.
6. **No per-tier API-key UI beyond what exists.** Keys are per *provider*
   already (`apiKeys[providerId]`); a fast tier on a different provider uses
   that provider's key through the existing resolver (§3.2).

---

## 2. Constraints inherited from the existing code

| # | Constraint | Consequence for this design |
|---|---|---|
| **C-1** | `packages/core` freezes its export surface and bans host imports. | Zero core changes. The review call goes through `ProviderRegistry.complete()`, which is already public and already held by `AgentController`. |
| **C-2** | The tool array is built **once** in the controller constructor and must never be rebuilt (`controller.ts:273`, and its own comment explains why: `submit_plan` mutates the mode from inside a tool execution). | `task`'s schema delta is decided at construction (`fastRegistered`), not live. `/fast on` in a session launched without the tier persists and says so plainly (§4.4). |
| **C-3** | `store.ts` merges nested config sections **by hand**, one level deep, in **two** places (`loadPersistedConfig` and `updatePersistedConfig`). Omitting either is silent (the `todo` P0-1 story). | `FastConfig` is scalars only, and both merges gain a line (§7). |
| **C-4** | `glyphs.test.ts` scans a hardcoded list of directories. A **new tree is invisible to it** until the regex is extended — a guard rail that silently stops guarding. | `src/fast/**` is added to `inScope` in the same change that creates the tree (§7, AC-27). |
| **C-5** | `Transcript`'s settled boundary is **monotonic**: an entry that never settles never reaches `<Static>` and is re-rendered on every frame forever. Both `team.active` and `todo.live` are normalized away **on load**, in `session/persist.ts`. | The `fast` entry's `live` flag gets the same treatment (§5.4). |
| **C-6** | `IdleWatchdog.pause()` is a **boolean, not a counter** (`watchdog.ts:13, 38-42`; used via `controller.ts:695`). A nested resume re-arms the watchdog while an outer wait is still running. **And it now has two automatic writers** (RV-18): `Agent.emit()` pauses on `retry_scheduled` and resumes on `retry_attempt`, so a retry backoff and a `--confirm` prompt can already overlap. | The reviewer **must not** touch the watchdog (§3.5.5 / I-5) — a third writer of a two-state flag that two independent subsystems already drive is how a legitimate six-minute dispatch gets aborted for being "idle". |
| **C-7** | `Agent.emit()` calls listeners **synchronously**, inside the loop (`agent.ts:340`). | The reviewer subscribes to the **core agent** through the controller, not to React state, and makes its injection decision inside that synchronous callback (§3.5.4). |
| **C-8** | `ajv` is an **optional** dependency of core, so a JSON-Schema bound may or may not be enforced. Every existing bound lives in the tool `description` and in a normalizer. | `model: "fast"` is declared as shape (`enum`) and repaired as policy in `normalizeSubagentSpecs` (§3.4). |
| **C-9** | Commander materializes a lone `--no-x` as `opts.x = true`. Four features in this package have been bitten by it. | `--fast` / `--no-fast` are declared as a **pair**, carried through `toFlags`, and read with `!== undefined` (§4.3). |
| **C-10** | **A run never clears its message queues.** `runLoopWithLifecycle`'s `finally` stops the watchdog, flips `running`, and emits `agent_end` — and nothing else (`agent.ts:410-425`). Anything left in `steeringQueue` survives into the **next** `prompt()` and is drained at checkpoint 1, i.e. appended after the user's next question. `Agent` exposes no way to remove one message: only `clearAllQueues()` (`agent.ts:309`). | The reviewer must *confirm delivery*, not assume it (§3.5.4). And because the only other writer of that queue is `AgentController.steer()` (`controller.ts:580`, whose only caller is `App.tsx:890`), the controller can count what it queued and know when clearing is provably safe. |
| **C-11** | **An unrecognised model has a cost table of zeros**, not a missing one: `ModelRegistry.buildRuntimeModel` returns `cost: { input: 0, output: 0 }` (`model-registry.ts:149`) and `getModelInfo()` falls back to it (`controller.ts:950-954`). | The fast tier is the likeliest place to name a model the static table has never seen, so "unknown price" must be rendered as unknown, never as free (§3.6). |
| **C-12** | This repo's `CLAUDE.md` caps a source file at **1000 lines**, and `controller.ts` is already at 960, `reducer.ts` at 944, `App.tsx` at 1559. | The controller-side wiring is extracted rather than inlined, and §7 states the budget explicitly instead of discovering it at review time. |

---

## 3. Technical design

### 3.1 Module map

```
packages/cli/src/fast/            <- NEW TREE (add to the glyph scanner, C-4)
  limits.ts      FAST_LIMITS + FAST_BLOCK_VERSION   (structural bounds)
  types.ts       FastTier | TurnFrame | FastReview | FastEvent | FastSnapshot
  resolve.ts     resolveFastTier(config)            (THE single authority)
  digest.ts      buildReviewDigest(...)             (pure, no I/O)
  critique.ts    normalizeCritique(...)             (pure, no I/O)
  prompt.ts      buildFastBlock(...) / buildReviewSystemPrompt(...)
  reviewer.ts    FastReviewer                       (the only stateful module)
  wiring.ts      FastWiring                         (controller-side glue, C-12)
```

`fast/` depends on: `@aragon-agent/core` types, `config/schema`,
`logging/logger`. It depends on **nothing** in `ui/`, and `reviewer.ts` is the
only file in it that performs I/O or holds a timer — the same split `todo/`
keeps between its pure modules and its store.

`wiring.ts` exists for a budget reason, not an aesthetic one (C-12 / RV-5).
`controller.ts` is at 960 of its 1000 permitted lines, and §7 originally handed
it nine new responsibilities. `FastWiring` owns the pair of flags, the tier
cache, the reviewer's lifetime and the `resolveTier` closure; `AgentController`
keeps a single `private readonly fast: FastWiring | null` and four thin
forwarders (`setFastConfig` / `setFastEnabled` / `getFastStatus` /
`subscribeFast`), which is roughly forty lines rather than three hundred. It is
still CLI-local and still holds no `ui/` import.

### 3.2 Resolving the fast tier — one authority

```ts
// fast/resolve.ts
export type FastTier =
  | { ok: true; ref: ModelRef; thinkingLevel: ThinkingLevel; sameAsMain: boolean }
  | { ok: false; reason: 'disabled' | 'no_model' | 'no_adapter' | 'no_key' };

export function resolveFastTier(
  config: CliConfig,
  hasKey: (providerId: string) => boolean,
): FastTier;
```

Rules, in order:

1. `config.fast.enabled === false` → `{ ok: false, reason: 'disabled' }`.
2. `provider = fast.provider || config.provider` — an empty string **inherits
   the main provider**, which is what makes `fast.model` alone a complete
   configuration for the overwhelmingly common case ("same vendor, cheaper
   model").
3. `modelId = fast.model.trim()`; empty → `{ ok: false, reason: 'no_model' }`.
   Enabling the tier without naming a model is a half-finished setting, and
   silently inheriting the main model would make R-e (opt in to
   fast == main) indistinguishable from a typo.
4. `isAdapterProvider(provider)` false → `no_adapter`.
5. `hasKey(provider)` false → `no_key`.
6. `baseUrl = fast.baseUrl || (provider === config.provider ? config.baseUrl : undefined)`.
   A fast tier on the *same* provider inherits the session's base URL — a user
   pointing the CLI at a gateway means both models, not one. A fast tier on a
   *different* provider does not, because that base URL belongs to a different
   API.
7. `sameAsMain = provider === config.provider && modelId === config.model`.
   Reported by `/fast status` and by the settings screen and **never used to
   skip work** (R-e): the user is allowed to choose it, and the cost of the
   review is real either way.

8. **The tier is re-resolved on every config mutation, not once (RV-3).** Rules
   2 and 6 make `fast.provider: ''` and `fast.baseUrl: ''` *inherit* from
   `config.provider` / `config.baseUrl`, and rule 5 reads `apiKeys`. All four are
   live: `/model`, `/provider`, the settings screen's save, `/reload` and a
   one-shot key edit each rewrite one of them mid-session. A tier resolved once
   at construction is therefore a tier that can be describing a provider the
   session no longer uses. `FastWiring` caches the last `FastTier` and
   recomputes it — plus `composeSystemPrompt()`, because `<fast_tier>`
   interpolates the resolved model id — from a single `onConfigChanged()` hook
   the controller already calls for the same reason after `setModel`.

Every consumer — the controller, the subagent factory, the reviewer, `/fast`,
the settings screen, the status bar — reads the tier through this function and
nowhere else. Four call sites recomputing "is fast usable?" from raw config keys
is exactly how a UI ends up showing a chip for a tier that refuses every call.

`hasKey` is `AgentController.hasApiKey`, which already resolves the config-file
key, the provider environment variable and the one-shot `--api-key` override.

### 3.3 Two flags and one live predicate

```
fastRegistered  decided ONCE at construction  = resolveFastTier(config).ok
fastEnabled     live, flipped by /fast on|off = starts equal to fastRegistered
fastAvailable   derived, read at every use    = fastRegistered && fastEnabled
                                                && fast.delegate (for delegation)
                                                && resolveFastTier(config).ok
```

**The third term is not redundant, and leaving it out is RV-3.** `fastRegistered`
is frozen at construction by C-2, but the tier it was derived from is not:
§3.2 rule 8 lists five live inputs. So `fastRegistered && fastEnabled` can be
true at the exact moment `resolveFastTier` has started returning `no_key` —
a user who switched the main provider, or cleared a key in the settings screen,
with `fast.provider: ''` inheriting from it. Without the third term, `task` keeps
advertising `model:"fast"`, `resolveTier('fast')` hands back a `ModelRef` whose
provider has no key, and the child dies inside its own loop with
`No API key available for provider "openai"` (`agent-loop.ts:140-145`) — an
error naming neither the fast tier nor the setting that caused it.

`fastAvailable` is therefore what `normalizeSubagentSpecs` is given (§3.4), what
`resolveTier` falls back on, and what the reviewer's trigger tests (§3.5.1).
`FastWiring.available()` is its one implementation; `sameAsMain` remains display
only (R-13).

- **`fastRegistered` false** ⇒ `task`'s schema has no `model` property, no
  `<fast_tier>` block is ever spliced, no `FastReviewer` is constructed, and
  `ViewState.fast` is `null` for the session. This is the byte-identity branch
  (I-2).
- **`fastEnabled` false with `fastRegistered` true** ⇒ the `model` property
  still exists in the schema (it cannot be removed, C-2) but
  `normalizeSubagentSpecs` **downgrades** `"fast"` to `"main"` and the report
  says how many it downgraded; the reviewer is dormant; `<fast_tier>` is not
  spliced.
- **`/fast on` when `fastRegistered` is false** ⇒ persist it, and say the one
  honest sentence: *"The fast tier is off for this session (not configured at
  launch). Saved for next launch."* This is the bottom-right cell of `/team`'s
  table (`builtins.ts:230`) reproduced deliberately, not by accident: a session
  that grows a schema field mid-flight would be a session whose request payloads
  change shape between turns, and the alternative — advertising a capability the
  schema does not carry — is the dead end P0-2 of `team-subagents` describes.

A one-line startup notice covers the two configuration mistakes that are
otherwise invisible: `no_model` → *"fast.enabled is on but fast.model is empty —
the fast tier is off. Set it with /fast model <id>."*, `no_key` → *"No API key
for <provider> — the fast tier is off."* Raised once, at construction, through
the existing `deps.notify` channel.

### 3.4 Capability A — fast-tier delegation through `task`

**Wire shape.** One optional property is added to each item of `task.subagents`:

```jsonc
{ "label": "scan", "description": "...", "prompt": "...",
  "readOnly": true, "model": "fast" }        // "main" (default) | "fast"
```

**Internal shape.** `SubagentSpec` gains `tier: 'main' | 'fast'`. The wire name
is `model` because that is what a model expects to see; the internal name is
`tier` because `SubagentSpec.model` would read as a model *id* at every call
site.

**Normalization** (`normalizeSubagentSpecs`, `team/normalize.ts`) gains one
parameter and one return field:

```ts
normalizeSubagentSpecs(raw, max, opts?: { fastAvailable?: boolean })
  -> { specs, requested, downgraded: number }
```

`opts` is **optional and defaults to `{ fastAvailable: false }` (RV-14).**
`normalizeSubagentSpecs` and `NormalizedSpecs` are both exported and both have
existing callers and tests; a required third parameter is a breaking edit that
buys nothing, and an omitted one now means exactly what a pre-feature build
meant. `downgraded` is likewise additive — `NormalizedSpecs` gains a field, it
does not change one.

`src.model === 'fast' && opts.fastAvailable` → `tier: 'fast'`. `'fast'` without
availability → `tier: 'main'` and `downgraded += 1`. Anything else → `'main'`.
Never rejected, per the file's own contract ("repair, never reject").

`fastAvailable` is §3.3's live predicate, evaluated **at dispatch time**, not a
snapshot taken at construction (RV-3). `fast.delegate: false` and "the tier
stopped resolving twenty minutes ago" are the same observable to the model — a
downgrade, counted and reported — which is the honest reading of both.

`downgraded > 0` puts one line in the report header: *"2 subagents ran on the
main model (fast tier off)."* A **silent** downgrade is the failure this line
exists to prevent — the model asked for a cheap child, got an expensive one, and
would have no way to learn that its cost model is wrong.

**Construction** (`team/subagent.ts`). `SubagentDeps` gains
`resolveTier: (tier) => { ref: ModelRef; thinkingLevel: ThinkingLevel }`, and
the two hardcoded reads at `subagent.ts:254` and `:278` route through it:

```ts
const { ref, thinkingLevel } = deps.resolveTier(spec.tier);
// ... model: ref, thinkingLevel
```

`resolveTier('fast')` returns the **main** tier's `ref` and `thinkingLevel` when
`fastAvailable` is false, so the two guards agree by construction: the normalizer
can never produce a `tier: 'fast'` spec the factory would refuse, and the factory
can never build a child against a `ModelRef` the tier no longer resolves (RV-3).

`thinkingLevel` is per tier and defaults to `'off'` for the fast tier
(`fast.thinkingLevel`, §4.2). A "fast" model asked to think for 32 768 tokens is
not fast, and inheriting the session's `xhigh` into a mechanical file-scan child
would be the most expensive possible reading of the word.

`maxTokens` is deliberately **not** per tier (RV-15). A child already inherits
`deps.config.maxTokens` (`subagent.ts:283`), which is an ambition sized for the
main model; the adapter clamps it down to whatever the fast model actually
accepts (`llm/provider.ts:44-52`), so a large inherited value degrades to the
right number rather than to an HTTP 400. An eleventh config key to restate that
is not worth the merge site.

Everything else about a child is unchanged and must stay unchanged: the same
`createBuiltinTools` call, the same `--confirm` gate, the same plan-mode gate,
the same skills ceiling, the same `withMailboxTail`, the same watchdog and the
same timeouts. **Delegation to a cheaper model is not a permission boundary**
(I-4) — a fast child may do exactly what a main child may do, no more.

**Reporting.** `SubagentRun` gains `tier`. Report rows carrying `tier === 'fast'`
are annotated `[fast]` after the label, and `DispatchOutcome` splits usage:

```ts
usage: TokenUsage;      // main-tier children, unchanged meaning
fastUsage?: TokenUsage; // fast-tier children, absent when none ran
```

The header line computes spend from **two** cost tables. Summing fast-tier
tokens at the lead model's price is not a rounding error — for a Haiku child
under a Sonnet lead it over-reports by roughly an order of magnitude, and the
whole justification for the feature is a number in that report.

### 3.5 Capability B — the periodic asynchronous review

#### 3.5.1 Trigger

`FastReviewer` subscribes to the **lead** agent's event stream (through
`AgentController`, C-7) and maintains, per run:

| field | source | meaning |
|---|---|---|
| `runId` | **minted by the reviewer** on `agent_start` (RV-8) | monotonic; every stale-result test compares against it. `agent_start` carries no payload (`agent.ts:385`), so this is a counter the reviewer owns, not a value it reads |
| `turns` | `turn_end` | completed turns of this run |
| `outstanding` | **assigned** at `turn_end` to the number of `tool_call` blocks in `message.content`, then decremented by each `tool_execution_end` (RV-7) | tool calls still to run in the current batch |
| `frames` | see §3.5.2 | ring buffer, `FAST_LIMITS.maxFramesRetained` |
| `inFlight` | — | at most **one** review call at a time |
| `pending` | — | a critique waiting for its injection window |
| `reviews` | — | reviews started this run; capped at `FAST_LIMITS.maxReviewsPerRun` |

`outstanding` is **assigned**, never carried across turns, and the difference is
not cosmetic (RV-7). Two paths end a batch without emitting a
`tool_execution_end` for every call: checkpoint 2 skips the whole batch
(`agent-loop.ts:199-207`) and an abort breaks out of the loop mid-batch
(`:211`). A counter that only ever decremented would sit permanently above zero
after either, and the injection window would never open again for the rest of
the run. Re-assigning at each `turn_end` makes both cases self-heal on the next
turn, which is the correct behaviour: those batches genuinely had no window.

**A review is started when a turn's frame is sealed (RV-2), not at `turn_end`.**
A frame seals at the `tool_execution_end` that brings `outstanding` to `0`, or
immediately at `turn_end` for a turn with no tool calls. `turn_end` fires at
`agent-loop.ts:188`, *before* the first tool runs, while `TurnFrame.tools`
carries `isError` and `ms` — fields that exist only once
`tool_execution_end` has been emitted (`:249-256`). Triggering there meant the
newest frame of every digest was structurally missing the single fact a reviewer
most needs: whether the batch it is reviewing failed. Sealing costs nothing —
it is the same event the injection window already keys on (§3.5.4) — and a
tool-less turn ends the run anyway (`:344-357`), so a review triggered there
would have been dropped for want of a window regardless.

The remaining conditions are unchanged: `fastAvailable` (§3.3); `fast.review` is
on; `turns % fast.reviewEveryTurns === 0`; `inFlight === false`;
`pending === null`; `reviews < maxReviewsPerRun`; the reviewer has not
self-disabled (§3.5.5).

`inFlight === false` is not an optimization. With `reviewEveryTurns: 1` and a
slow fast provider, an unguarded reviewer starts a second call before the first
returns, then a third, and the run ends with four critiques racing for one
injection window — of which three are stale by construction.

Turns, not tool calls, are the unit of "每隔一定节点数量". A turn is the loop's
own natural node: it is exactly one LLM call plus its tool batch, it is what
`turn_end` reports, and it is what the user sees the status bar count.

#### 3.5.2 The digest — and why not `agent.state.messages`

`buildReviewDigest(frames, goal, limits)` is a pure function over a ring buffer
the reviewer maintains itself:

```ts
interface TurnFrame {
  index: number;                 // 1-based within the run
  textTail: string;              // <= FAST_LIMITS.turnTailChars
  tools: Array<{ name: string; arg?: string; isError?: boolean; ms?: number }>;
  error?: string;                // formatStreamError, if the turn errored
  sealed: boolean;               // §3.5.1: complete, and safe to digest
}
```

`textTail` is appended from `message_update{text_delta}` and clipped on every
append — the same O(1) rolling-tail trick `subagent.ts:392` already uses for the
activity line, and the only per-token allocation this feature adds. `tools`
records the tool name plus **one picked argument**, elided to
`FAST_LIMITS.toolArgChars`, exactly as `pickActivityArgs` does.

`buildReviewDigest` includes **sealed frames only** (RV-2). The turn being
reviewed is sealed by definition — sealing is what triggered the review — so
the window is the newest `reviewContextTurns` sealed frames, and a frame that is
still accumulating is never half-rendered into a prompt.

**The recorder is gated, because `message_update` is not a text event (RV-10).**
`agent-loop.ts:170` forwards *every* stream event through it — `text_delta`,
`thinking_delta`, `tool_call_delta`, `tool_call_start`, `done` — so the frame
recorder is a synchronous listener on the hottest path in the package, in a
repo that has already had to write a `tui-render-performance` plan about that
path. It therefore returns immediately unless the event is a `text_delta` **and**
`fastAvailable` **and** `fast.review` is on **and**
`reviews < maxReviewsPerRun` — after the last review of a run there is nothing
left that can consume a frame, so there is no reason to keep building them. With
the tier off the listener is never subscribed at all (§3.3), which is the
byte-identity branch and also, not incidentally, the zero-cost one.

**The reviewer never reads `agent.state.messages`, and this is the single most
important economic decision in the feature (D-6).** That history holds whole
file bodies: a session that has read four 60 KB files carries 240 KB of them.
Shipping it to the "cheap" model to ask whether the run is on track would make a
review cost *more* than the main-model turn it is reviewing — the exact
inversion the feature exists to prevent. The digest is bounded at
`FAST_LIMITS.digestMaxChars` (4 000) by construction, so a review's input cost
is flat regardless of session length. Anyone tempted to "just pass the messages,
the model has the context anyway" is about to turn a 400-token call into a
60 000-token one, and nothing in the UI would show it except the bill.

`goal` is the user's request for this run, captured in
`AgentController.prompt()` and clamped to `FAST_LIMITS.goalChars` (500). Without
it the fast model is asked to judge whether work is on track without being told
what the track is.

#### 3.5.3 The call

One non-streaming request through the registry the controller already holds:

```ts
providerRegistry.complete(tier.ref.providerId, {
  model: tier.ref.modelId,
  baseUrl: tier.ref.baseUrl,
  apiKey: getApiKey(tier.ref.providerId)!,
  systemPrompt: buildReviewSystemPrompt({ maxChars: fast.reviewMaxChars }),
  messages: [{ role: 'user', content: digest, timestamp: Date.now() }],
  maxTokens: FAST_LIMITS.reviewOutputTokens,   // 512
  thinkingLevel: 'off',
  temperature: 0,
  signal: controller.signal,                    // reviewer-owned AbortController
});
```

No tools, no thinking, `temperature: 0`, a hard 512-token cap and a
`FAST_LIMITS.reviewTimeoutMs` (20 s) watchdog of its own. The review is an
opinion, not an actor: giving it tools would make it a second agent editing the
same working tree with none of the gates the lead's tools carry.

`thinkingLevel: 'off'` also keeps `temperature: 0` from being silently dropped:
the Anthropic adapter deletes `temperature` whenever a thinking budget is set
(`anthropic.ts:395-402`), so the two settings are a pair, not two independent
choices.

**`complete()` may retry, and the reviewer must not pay for it (RV-18).** The
sibling `llm-api-retry-backoff` feature — uncommitted in this same tree, so the
two land together — routes `ProviderRegistry.complete()` through a retrying
`stream()`. The reviewer therefore issues *one call* that can become several
attempts separated by backoff, and `reviewTimeoutMs` stops meaning "how long one
request may take". Three rules follow:

- **`reviewTimeoutMs` is the wall-clock budget for the whole call including
  retries**, and it is documented as such. 20 s is retained: a review that has
  not answered in 20 s has already missed the turn it was about.
- **The reviewer opts out of retry.** A review is an accessory (§3.5.5 "never
  fatal"), and spending three attempts plus backoff on an advisory the lead may
  never see inverts the cost thesis the whole feature rests on. The retry policy
  is registry-global (`setRetryPolicy`) with no per-request override on
  `LLMRequest`, so this needs **one additive optional field** —
  `LLMRequest.maxRetries?: number`, honoured by `ProviderRegistry.stream()` as an
  override of `policy.maxRetries`, with `0` meaning "hand back the adapter's
  iterator directly", which is the opt-out path that file already implements.
  That is a `packages/core` change, so it belongs to **`llm-api-retry-backoff`'s
  scope, not this one** (I-1 / C-1: this feature stays at zero core diffs).
  Coordination, not a fork: if that field does not ship, the fallback below still
  makes the tier safe.
- **Fallback if the field does not exist.** Retries stay on, `reviewTimeoutMs`
  is raised to 30 s, and — critically — the failure classifier below treats a
  retry-exhausted rate limit as a *transient*, not as a strike.

**Usage is read from `message.usage`, defaulted to zeros (RV-11).**
`ProviderRegistry.complete()` returns an `AssistantMessage`, and all three
adapters populate `usage` before yielding `done` (`anthropic.ts:255`,
`openai.ts:274`, `google.ts:179`) — so the "cheap" call is fully accounted for
without touching core. But the field is declared **optional**
(`llm/types.ts`), and `computeCost(undefined, cost)` is a `NaN` that propagates
straight to the status bar and stays there for the session. The reviewer
therefore reads `message.usage ?? { inputTokens: 0, outputTokens: 0 }` and logs
`fast_review_done` with a `usageMissing: true` field when it had to.

**Output contract.** The system prompt asks for at most `reviewMaxChars`
characters of plain prose, and for the exact string `OK - on track.` when there
is nothing worth saying. `normalizeCritique(raw, maxChars)` (pure) strips code
fences, collapses whitespace, clamps to `maxChars` on a word boundary, and
classifies:

```ts
type Critique =
  | { kind: 'ok' }                    // matches /^ok\b.*on track/ after normalization
  | { kind: 'advice'; text: string }
  | { kind: 'empty' };
```

The `ok` test is a **normalized regex, not string equality** — `trim`,
`toLowerCase`, strip trailing punctuation, then `/^ok\b.*on track/`. Exact
equality against `'OK - on track.'` fails on a model that writes `Ok, on track`
and then injects a useless "review" into the main context on every cycle,
forever, which is worse than no reviewer at all.

`kind: 'ok'` and `kind: 'empty'` are **not injected**. They still produce a
transcript entry (one muted line) and a log record, so the user can see the
harness is alive without the lead paying context for it.

#### 3.5.4 The injection window — the load-bearing part

`Agent.steer()` pushes onto a queue that `runAgentLoop` drains at three places.
They are not interchangeable:

| # | Where | Line | What happens to a message drained here |
|---|---|---|---|
| **1** | Top of the loop, before the LLM call | `agent-loop.ts:126` | Pushed as a `user` message. Conversation shape stays valid. **SAFE.** |
| **2** | After the LLM call, before tool execution | `agent-loop.ts:199` | `continue` — the assistant message's `tool_use` blocks are left with **no** `tool_result`. Anthropic rejects the next request with HTTP 400 *"tool_use ids were found without tool_result blocks"*. **HARD FAILURE.** |
| **3** | Between two tool executions | `agent-loop.ts:214` | Every remaining tool call in the batch is replaced with `Tool execution skipped due to steering interrupt.` **SILENTLY DESTRUCTIVE.** |

For a human pressing Enter mid-run, 2 and 3 are the desired semantics — the user
means *stop and do this instead*. For an unrequested background critique they
are a defect generator: checkpoint 3 deletes work the model was mid-way through,
and checkpoint 2 ends the run with a provider error whose text mentions neither
the reviewer nor the fast model. A reviewer that calls `steer()` from its own
promise callback hits both within a few sessions, and neither symptom points
back at it.

**Why checkpoint 1 is safe, concretely.** Draining there pushes a `user` message
directly after the batch's `tool_result` messages, which means the request
carries two adjacent `user` turns. That is already the steady state of this
codebase and not a new risk: `convertMessages` emits **one `user` message per
`tool_result`** (`anthropic.ts:411-448`), so every multi-tool batch has always
produced consecutive `user` turns and every adapter in the tree tolerates it.
This is recorded because it is the load-bearing assumption under the word
"SAFE", and a reader who has not checked it might reasonably assume the opposite.

**The rule.** The reviewer calls `agent.steer()` from exactly one place: inside
the **synchronous** listener for the `tool_execution_end` event that brings
`outstanding` to `0`. Because `Agent.emit()` runs listeners synchronously inside
the loop (C-7) and the batch is finished, the next `hasSteering()` the loop
evaluates is checkpoint 1, at the top of the next iteration. The injected
message lands after a complete set of tool results and destroys nothing.

Note the ordering the rule sits on (RV-9): `tool_execution_end` is emitted at
`agent-loop.ts:249`, **before** its own `tool_result` is pushed at `:263`. The
design is still correct — `steer()` only enqueues, and the drain does not happen
until the top of the next iteration, by which time `:263` has run. It is stated
here because it inverts the intuitive reading, and an "improvement" that pushed
the block onto `messageManager` directly from this listener would place a `user`
message *between* an assistant's `tool_use` and its `tool_result` — the HTTP 400
of checkpoint 2, reintroduced by a change that looks like a simplification.

Everything else follows from that rule:

- The async `complete()` callback **never injects**. It only sets
  `pending = { runId, text, ... }`.
- At each `tool_execution_end`, if `outstanding === 0 && pending !== null &&
  pending.runId === runId && agent.isRunning() && !controller.isAbortRequested()`
  → `steer(block)`, set `awaitingDrain = true`, emit the transcript entry, clear
  `pending`.
- If the batch is not finished, `pending` waits. The next batch end is another
  window; a run with more turns has more windows.
- On `agent_end`, `pending` is **dropped** (D-8), not carried: a critique of
  turn 5 delivered into the user's *next* question is advice about a different
  task, arriving from nowhere, attributed to the user. (v1 gave a second reason —
  that `steer()` on an idle agent restarts a finished run — and it was simply
  false: `Agent.steer()` pushes onto a queue and does nothing else,
  `agent.ts:260-262`. RV-6. The correct second reason is the delivery hazard
  below, which is the same hazard one step later.) A dropped review is logged and
  shown as `fast review #3 - missed its window` in the transcript, so "it did
  nothing" is never the observable outcome.
- A turn that ends with **no** tool calls ends the run (the loop exits at
  `end_turn`). There is no window; the pending review is dropped by the same
  rule.

#### 3.5.4a Steering is not delivery — the drain confirmation (RV-1, P0)

The rule above is necessary and, on its own, **not sufficient**. `steer()` puts
the block on a queue; only checkpoint 1 delivers it; and there is a reachable
interleaving in which the reviewer steers and checkpoint 1 is never reached:

1. The last tool of a batch is executing — the loop is inside the `await` at
   `agent-loop.ts:242`.
2. The user presses `Esc`, or the idle watchdog fires. Either way the run's
   `AbortSignal` is aborted.
3. `execute()` returns. The loop **still emits `tool_execution_end`** at `:249` —
   the abort is not re-tested until `:271`.
4. The reviewer's synchronous listener sees `outstanding === 0`, `pending`
   set, and `agent.isRunning() === true` (`running` is not cleared until the
   `finally` at `agent.ts:412`). It steers.
5. The loop pushes the tool result, exits the `for`, tests the signal at `:271`
   and **breaks**. `agent_end` is emitted. Nothing clears the queues (C-10).
6. The next `prompt()` pushes the user's new question and then drains the queue
   at checkpoint 1 — appending a critique about the *previous* task, in the
   `user` role, into a conversation it has nothing to do with.

That is R-4 exactly, reached through a door D-8 does not cover, and v1's stated
mitigation ("`abort()` clears `pending`") could not help: `pending` had already
been consumed in step 4. AC-26 asserted an outcome the design did not produce.

**The fix is two guards, because there are two abort sources.**

*Guard 1 — do not steer into an abort.* `AgentController.abort()` sets
`abortRequested = true` **synchronously, before** calling `agent.abort()`, and
exposes `isAbortRequested()`; the window check reads it. `abortRequested` clears
at the next `agent_start`. This closes the `Esc` path, which is the common one.

*Guard 2 — confirm the drain, because the watchdog does not go through the
controller.* `IdleWatchdog` calls `Agent.abort()` directly
(`watchdog.ts:15-17`, `agent.ts:221-225`), so guard 1 cannot see it, and neither
can any other future abort inside core. So the reviewer proves delivery instead
of assuming it:

- `awaitingDrain` is set when it steers and cleared on the next `turn_start` —
  the loop cannot reach `turn_start` (`:136`) without having passed checkpoint 1
  (`:126`), so `turn_start` **is** the delivery receipt.
- If `agent_end` arrives with `awaitingDrain` still true, the block was never
  delivered. The reviewer logs `fast_review_dropped { reason: 'stranded' }`,
  rewrites the entry from `advice` to `dropped`, and removes the block.
- Removal is safe to perform because the reviewer can prove it owns the whole
  queue. `AgentController.steer()` (`controller.ts:580`) is the only other writer
  in the package and `App.tsx:890` is its only caller, so the controller keeps a
  `userSteerCount` incremented there and reset at every `turn_start`. With
  `userSteerCount === 0` the queue provably contains nothing but the reviewer's
  own block, and `controller.clearAllQueues()` (`:929`) removes exactly it.
- With `userSteerCount > 0` the reviewer **does not clear**: the user's own
  message is in there, destroying it would be a far worse bug than the one being
  fixed, and `Agent` exposes no way to remove one entry (C-10). It logs at
  `warn` and leaves the block, whose `<fast_review turn=... model=...>` wrapper
  and `<fast_tier>` prompt paragraph at least make it self-identifying if it
  does surface. This residue is bounded, rare, labelled, and — unlike the v1
  design — *reported*.

The asymmetry is deliberate: the reviewer may always destroy its own message and
may never destroy the user's.

**Rejected alternative (D-9): the mailbox-tail trick.** `team/comm-tools.ts`
delivers child mail by wrapping every tool so the message rides on the next tool
*result*, which is safe by construction. Applying it to the lead would mean
wrapping all seven-to-eleven built-in tools and appending the critique to
whatever tool happened to run next — a review attached to the tail of a
`read_file` result, rendered inside that tool's preview card, attributed to the
tool. The window rule achieves the same safety without touching a single tool.

#### 3.5.5 Budgets, failure, and the watchdog

- **Per run:** `FAST_LIMITS.maxReviewsPerRun` (6). A 40-turn run at
  `reviewEveryTurns: 5` would otherwise buy 8 critiques the lead increasingly
  ignores.
- **Failures:** a transport error, a timeout or an unparseable answer increments
  `consecutiveFailures`. At `FAST_LIMITS.maxConsecutiveFailures` (3) the reviewer
  **self-disables for the session** and raises exactly one `warn` notice naming
  the last error. Never an error entry per failure: three identical stream
  errors in the transcript teach the user nothing and bury the answer they were
  reading.
- **Not every failure is a strike (RV-18).** `rate_limit` and `overloaded` —
  the two `LLMErrorType`s the retry feature classifies as retryable — are
  **transient** and do **not** increment `consecutiveFailures`; they are logged
  and the review is dropped. Self-disabling is meant for a *misconfigured* tier
  (a wrong model id, a dead gateway, a key without access), which is the case a
  user must be told about because it will never fix itself. A fast provider that
  is merely busy for ninety seconds is the opposite: counting it as a strike
  would silently kill the reviewer for the rest of a session over a condition
  that resolved on its own — and, with retry now inside `complete()`, three
  strikes can arrive from a single busy minute rather than three separate ones.
  `no_key` / `no_adapter` never reach here at all; §3.2 rejects them before a
  call is made.
- **Never fatal.** No reviewer failure aborts the run, marks a turn failed, or
  changes an exit code. The lead's work is the product; the review is an
  accessory to it.
- **Staleness of a waiting critique.** `pending` is discarded once it is older
  than `FAST_LIMITS.pendingMaxAgeMs` (120 s) or once `turns` has advanced by
  more than `FAST_LIMITS.pendingMaxTurnsBehind` (2) since the turn it reviewed
  (RV-12). The window is not guaranteed to be prompt: a `task` dispatch is one
  tool call that can run for minutes (`team.dispatchTimeoutMs`), so a critique
  triggered just before one arrives at the far side describing a state that has
  since been rewritten by five children. Advice that is merely late is worse
  than no advice, because the lead cannot tell that it is late. A discarded
  critique is logged and rendered `dropped` with the reason, exactly like one
  that missed its window.
- **Abort.** `AgentController.abort()` sets `abortRequested` **before**
  `agent.abort()` (§3.5.4a guard 1), then aborts the reviewer's own
  `AbortController` and clears `pending`. `dispose()` does the same and also
  unsubscribes. Neither may clear `awaitingDrain` — that flag is the receipt
  guard 2 depends on, and it is resolved only at `turn_start` or `agent_end`.
- **I-5 — the reviewer must not touch the idle watchdog.** It is tempting
  (`withPausedWatchdog` is right there and the review is a network call), and it
  is wrong twice over. First, the lead is not *blocked* on the review — it is
  streaming or running tools throughout, so events keep flowing and the watchdog
  is being kicked anyway. Second, `IdleWatchdog.pause()` is a boolean, not a
  counter (C-6): a background pause/resume pair that happens to straddle a
  `task` dispatch re-arms the watchdog **mid-dispatch** and aborts a legitimate
  six-minute fan-out with `[Agent] idle watchdog fired` and no other
  explanation. This is precisely the hazard `controller.ts:695` documents for
  the child confirm queue, one feature later.

### 3.6 Usage, cost and the status bar

Fast-tier spend is **real spend and must reach the status bar** (the rule
`team-subagents` §3.9 states). Three sources, three cost tables:

| source | event | cost table |
|---|---|---|
| lead turns | core `turn_end` | main model |
| main-tier children | `TeamEvent.usage` with `tier: 'main'` | main model |
| fast-tier children | `TeamEvent.usage` with `tier: 'fast'` | **fast** model |
| reviews | `FastEvent.usage` | **fast** model |

`TeamEvent.usage` therefore gains `tier`, and `App.tsx:548` selects the cost
table by it instead of always calling `controller.getModelInfo().cost`.
`FastEvent.usage` is dispatched as a new `fastUsage` reducer action shaped
exactly like `teamUsage` (`usage` + a precomputed `costDelta`): the reducer
stays pure and cost-table-free, which is the property that makes it testable.

**The accessor (RV-4).** `controller.getModelInfo()` takes no argument
(`controller.ts:950`), so "select the cost table by tier" needs a door that did
not exist. `AgentController` gains one method, not a second `getModelInfo`
overload:

```ts
getModelInfoFor(ref: Pick<ModelRef, 'providerId' | 'modelId'>): ModelInfo;
```

It is the existing body with the two hardcoded `this.config` reads
parameterised — `modelRegistry.getModel(...)` with a `buildRuntimeModel(...)`
fallback — and `getModelInfo()` becomes a one-line call into it. One resolution
path, which is the same reason §3.2 has exactly one `resolveFastTier`.

**Unknown pricing is not zero pricing (C-11 / RV-4).** `buildRuntimeModel`
returns `cost: { input: 0, output: 0 }` for a model the static table has never
seen (`model-registry.ts:149`), and the fast tier is precisely where an
unrecognised model id is *likely* — the whole point is a small, new, or
third-party model. Rendering that as `$0.00` would make the feature look free
while it is spending money, which is the same class of lie as attributing fast
spend to the main model's price and is the one R-8 exists to forbid. So:

- `getModelInfoFor` is paired with `isPricedModel(ref)` — true only when
  `modelRegistry.getModel(...)` found a real entry.
- With pricing known, everything behaves as above.
- With pricing unknown, the fast tier's `costDelta` is `0` **and** the reviewer
  sets `pricingUnknown: true` on `FastSnapshot`. `/fast status` and the dispatch
  report then print `cost: unknown (no price table for <model>)` instead of a
  currency amount, and the status bar's aggregate carries a trailing `+?` so the
  total is visibly a lower bound rather than a figure.
- The same rule applies to a fast-tier child's rows in the dispatch report.

`/fast status` additionally reports the session's fast-tier totals separately —
tokens, reviews, delegated children — because the aggregate on the status bar
cannot answer "is the cheap tier actually saving me anything?".

### 3.7 Config resolution

`resolveFastConfig(flags, env, file)` follows `resolveTeamConfig` exactly —
defaults › file › env › flags, all through `clampFastConfig` — with `!==
undefined` on `flags.fast` (C-9). It is a sixth nested section, scalars only, and
**both** of `store.ts`'s hand-written merges gain a line (C-3). Omitting the
`updatePersistedConfig` half is the silent bug the `todo` section documents at
length: `/fast review 8` sends `{ fast: { reviewEveryTurns: 8 } }`, a shallow
top-level spread replaces the whole section, `enabled` is written absent, and the
tier the user configured yesterday is gone tomorrow with no error anywhere.

### 3.8 System-prompt block

`buildSystemPrompt` gains `fastBlock?: string`, spliced **conditionally** in the
same style as `skillsBlock`, `planBlock`, `teamBlock`, `subagentBlock` and
`todoBlock`. With the tier off the parameter is `''` and the prompt is
byte-identical (I-2) — the property `--no-skills`, `--no-team` and `--no-todo`
each already depend on, and which one unconditional guidance line would break
for all four at once.

The block is composed from two independently gated sentences groups
(`delegate` / `review`), so `fast.delegate: false, fast.review: true` advertises
only what exists. Composed in `fast/prompt.ts`, spliced by
`controller.composeSystemPrompt()`, which remains the **only** caller of
`agent.setSystemPrompt()` (invariant I-S2).

A child's prompt never carries `<fast_tier>`: children cannot delegate and are
not reviewed. `buildSubagentBlock` is unchanged.

### 3.9 Interaction with the rest of the system

| Subsystem | Interaction |
|---|---|
| **Plan mode** | Unchanged. A fast child obeys `spec.readOnly` and the live session mode identically (`subagent.ts:196`); the reviewer never calls a tool, so it cannot mutate anything in `plan` mode. The `<fast_review>` block is advisory text; it cannot approve a plan. |
| **Skills ceiling** | Unchanged. The reviewer has no tools, so `computeToolPolicy` never sees it. A fast child gets `skill_find` only, exactly as a main child does (D-16 of `team-subagents`). |
| **`--confirm`** | Unchanged. A fast child's mutating tools queue on the one human slot through `TeamHumanQueue` like any other child. |
| **Headless (`-p`)** | The tier resolves and both capabilities work. The review's transcript entry becomes a log record only — stdout is the answer channel and must not gain harness chatter (D-12). |
| **`/reload`** | Re-reads `config.json` and calls `controller.setFastConfig(...)`, which re-resolves the tier and rebuilds the prompt. It cannot change `fastRegistered` (C-2), and `/reload` is already refused mid-run. |
| **`/model`, `/provider`, the settings screen's save, a key edit** | **Each re-resolves the tier and recomposes the system prompt (§3.2 rule 8 / RV-3).** These are not neutral to the fast tier even when the user never touches a `fast.*` key: `fast.provider: ''` and `fast.baseUrl: ''` inherit from the main model's, and `hasKey` reads `apiKeys`. Switching the main provider can therefore turn a working tier into `no_key`, or silently re-point an inheriting tier at a different vendor's gateway. Three consequences, all handled by the single `onConfigChanged()` hook: `fastAvailable` goes false and delegation downgrades with a counted report line (§3.4); `<fast_tier>`'s `{{MODEL}}` is re-interpolated so the prompt never names a model the tier will not use; and a one-line notice names the new reason, reusing §3.3's `no_key` / `no_adapter` wording rather than inventing a second set. |
| **`/save` · `/resume`** | `kind: 'fast'` entries serialize as-is; `live` is normalized to `false` on load (C-5). No `SavedSession` format change. |
| **Watchdog / timeouts** | No change to any timeout. The reviewer owns its own 20 s abort and touches nothing else (I-5). |

### 3.10 Logging

Scope `fast`, through the existing `ScopedLogger`:

| event | level | fields |
|---|---|---|
| `fast_tier_resolved` | info (once, at construction) | `enabled`, `provider`, `model`, `sameAsMain`, `reason` when not ok |
| `fast_review_start` | debug | `runId`, `turn`, `reviewIndex`, `digestChars`, `frames` |
| `fast_review_done` | info | `reviewIndex`, `ms`, `kind` (`ok`/`advice`/`empty`), `chars`, `usage`, `usageMissing` when the adapter returned none (RV-11) |
| `fast_review_injected` | info | `reviewIndex`, `turn`, `outstanding` (always 0 — the assertion, recorded) |
| `fast_review_delivered` | debug | `reviewIndex` — emitted at the `turn_start` that clears `awaitingDrain`; its **absence** before an `agent_end` is the RV-1 signature |
| `fast_review_dropped` | info | `reviewIndex`, `reason` (`run_ended`/`aborted`/`stale_run`/`stale_pending`/`stranded`) |
| `fast_review_stranded` | warn | `reviewIndex`, `cleared` (whether `userSteerCount === 0` allowed removal) — §3.5.4a guard 2 |
| `fast_tier_unavailable` | warn (once per transition) | `reason` — the tier stopped resolving mid-session (§3.2 rule 8) |
| `fast_review_failed` | warn | `reviewIndex`, `error`, `consecutiveFailures` |
| `fast_delegate` | info | `dispatchId`, `label`, `tier`, and `downgraded` when it was |

The digest text itself is recorded only at `trace`; it contains workspace
content, and the level ladder in `logging/redact.ts` already draws that line for
prompt text.

---

## 4. Interface design

### 4.1 `task` — the schema delta

Added to each `subagents[]` item **only when `fastRegistered`** (C-2):

```jsonc
"model": {
  "type": "string",
  "enum": ["main", "fast"],
  "default": "main",
  "description": "Which tier runs this subagent. \"fast\" is a cheaper, quicker model - use it for mechanical, high-volume work (reading or searching many files, summarizing long output, mechanical edits). Keep \"main\" for design, tricky debugging, and anything that must be right the first time."
}
```

and one sentence appended to `TASK_DESCRIPTION`:

> `Set model:"fast" on a subagent whose job is bulk reading, searching or summarizing; leave it out for work that needs judgement.`

`enum` is shape, so it stays in the schema (C-8); *when to use it* is policy and
lives in the description and the prompt block, where the model actually reads it
and where `ajv`'s presence or absence cannot change the behaviour.

### 4.2 Config keys — `config.json`, section `fast`

| key | type | default | clamp | meaning |
|---|---|---|---|---|
| `fast.enabled` | boolean | **`false`** | — | Resolve the tier at all (R-d). |
| `fast.provider` | string | `''` | must be an adapter provider | `''` inherits the main provider. |
| `fast.model` | string | `''` | — | The fast model id. Empty ⇒ tier off with a notice. |
| `fast.baseUrl` | string | `''` | — | `''` inherits only when the provider matches (§3.2). |
| `fast.thinkingLevel` | enum | `'off'` | `clampThinkingLevel` | Applied to fast-tier children and reviews. |
| `fast.delegate` | boolean | `true` | — | Allow `model:"fast"` on `task`. |
| `fast.review` | boolean | `true` | — | Run the periodic review. |
| `fast.reviewEveryTurns` | number | `5` | `[1, 50]` | Turns between reviews. |
| `fast.reviewContextTurns` | number | `3` | `[1, 10]` | Turn frames included in a digest. |
| `fast.reviewMaxChars` | number | `280` | `[80, 600]` | Ceiling on an injected critique. |

Ten scalars, one level deep (C-3). `clampFastConfig` is the single gate for
**both** read and write, like `clampTeamConfig` — hardening only the read path
leaves a bad value on disk that reverts every launch, which presents to the user
as "my setting won't stick".

`aragon config set fast.<key> <value>` works through a new
`applyFastConfigSet(key, value)` in `config/cli-commands.ts`, shaped exactly like
`applyTeamConfigSet` and for the same reason: a generic setter would write
`fast` as a flat string key and the section would silently never take effect.

### 4.3 CLI flags and environment

| flag | form | notes |
|---|---|---|
| `--fast` / `--no-fast` | **pair** | Mandatory pair (C-9). Carried in `toFlags` and read with `!== undefined`. |
| `--fast-model <id>` | value | Implies nothing about `enabled` — pass `--fast` too, or set it in the file. |
| `--fast-provider <id>` | value | |
| `--fast-review <n\|off>` | value | `off` sets `fast.review: false`; a number sets `reviewEveryTurns`. |

| env var | maps to |
|---|---|
| `ARAGON_FAST` | `fast.enabled` (positive list `1/true/on/yes`, as `ARAGON_TEAM` does — **not** `envBool`, whose negative list disagrees on `disable`) |
| `ARAGON_FAST_PROVIDER` | `fast.provider` |
| `ARAGON_FAST_MODEL` | `fast.model` |
| `ARAGON_FAST_BASE_URL` | `fast.baseUrl` |

There is deliberately **no** `ARAGON_FAST_REVIEW_EVERY` / `_MAX_CHARS` /
`_DELEGATE`. `env.ts` states the rule in source: an environment variable exists
only where a flag **and** a config file are both unreachable — a container, an
ssh session, being spawned by another tool. "Which model, and is it on" passes
that test; tuning a review cadence does not, and every key that fails it is
documentation debt plus a fifth place for the value to disagree with itself.

All four env keys accumulate into **one** `section` object assigned once, the
shape `env.ts`'s `todo` branch uses — because the `as PersistedConfig['fast']`
cast defeats the compiler, and two separate assignments would silently drop
`enabled` (the P1-4 defect that file records).

### 4.4 Slash command `/fast`

```
/fast                          status
/fast on | off                 live switch (honest branch when not registered)
/fast model <id>               set fast.model      (accepts "provider:model")
/fast provider <id>            set fast.provider
/fast same                     copy the main provider/model/baseUrl (R-e)
/fast review <n> | off         reviewEveryTurns, or turn the review off
/fast delegate on | off        allow model:"fast" on task
```

`status` prints, in one notice: the state (`on` / `off` / `off for this session
(not configured at launch)`), the resolved `provider:model`, `(same as main)`
when it is, the cadence, and this session's fast-tier totals — reviews run,
children delegated, tokens and cost.

Every mutating branch does the **two calls plus persist** that `/todo` documents:
`controller.setFastConfig(patch)` (updates the object `App` reads at render time
*and* rebuilds the prompt) and `ctx.persistConfig({ fast: patch })` (survives the
session). Persist alone reports success and changes nothing until relaunch; the
setter alone forgets by morning.

`/fast model <id>` accepts `provider:model`, and an unknown provider is rejected
with **the message `cli.tsx:510` already prints** — `Unknown provider "x". Choose:
anthropic, openai, google.` — rather than a second wording for the same fact
(RV-16). `ADAPTER_PROVIDERS` is `['anthropic', 'openai', 'google']`
(`config/schema.ts:29`); `isAdapterProvider` is the check, and it is the same one
`clampFastConfig` applies to `fast.provider` on both the read and the write path.

`/fast` is **refused mid-dispatch** (`controller.isTeamBusy()`), like `/team`:
half a dispatch under one tier and half under another produces a report nothing
can afterwards explain.

### 4.5 Settings screen

Four rows appended to `FIELDS` in `SettingsScreen.tsx`, after `Max tokens` and
before `API key`:

| row | kind | notes |
|---|---|---|
| `Fast tier` | enum `off` / `on` | The one row that is always meaningful. |
| `Fast model` | text | Placeholder `(same as main)` when empty and the tier is on — the honest reading of §3.2 rule 3 is that it is *not* set, so the placeholder is `(not set)`; `(same as main)` is shown only when the value literally equals the main model. |
| `Fast provider` | enum `(inherit)` + `ADAPTER_PROVIDERS` | `(inherit)` is the empty string. |
| `Fast review` | text | A number, or `off`. Parsed like `Max tokens`: a typo changes nothing. |

Plus one derived, non-editable line under them — the sibling of
`effectiveCapLine`:

```
Fast tier: anthropic:claude-haiku-4-5  (key set)  review every 5 turns
Fast tier: off  (fast.model is not set)
Fast tier: openai:gpt-... (no API key for openai - the tier will stay off)
```

A settings screen that lets a user switch a tier on and gives no signal that it
cannot resolve is the failure `effectiveCapLine` was added to fix for
`maxTokens`, one screen later. Saving applies through the same
`setFastConfig` + persist pair as `/fast`.

### 4.6 System-prompt block

```
<fast_tier>
A second, cheaper model is available in this session ({{MODEL}}).

Delegation: pass model:"fast" to a task subagent whose work is mechanical and
high-volume - reading or searching many files, summarizing long command output,
applying the same small edit in several places. Keep model:"main" (the default)
for design decisions, tricky debugging, and anything that has to be right the
first time. A fast subagent has the same tools and the same permissions as any
other; only the model differs.

Reviews: every few turns a <fast_review> block may appear in the conversation.
It is an automated second opinion from the fast model - NOT a message from the
user. Treat it as advice: act on it when it is right, say so briefly and carry
on when it is not, and never ask the user to confirm it.
</fast_tier>
```

Under 1 100 characters, paid on every turn of a fast-enabled session, and each
paragraph is present only when its capability is (`delegate` / `review`).
`FAST_BLOCK_VERSION = 'v1-2026-07'` makes a wording change greppable from a
behaviour report, exactly as `TEAM_BLOCK_VERSION` and `TODO_BLOCK_VERSION` do.

The injected message itself:

```
<fast_review turn="12" model="claude-haiku-4-5">
You have edited config/schema.ts three times without running the tests. The
clamp for reviewEveryTurns is missing its upper bound.
</fast_review>
```

The `turn` and `model` attributes are not decoration: the block arrives in the
`user` role (that is what `steer` does, `agent-loop.ts:129`), so the only thing
distinguishing it from the human is what it says about itself.

---

## 5. Data model

### 5.1 Persisted and effective config

`PersistedConfig.fast: FastConfig` (sixth nested section) and
`CliConfig.fast: FastConfig` (resolved). Shape in §4.2. No migration: a config
file with no `fast` key gets `DEFAULT_FAST_CONFIG` from the first spread in
`loadPersistedConfig`, which is why that line is as required as the two merges
(the P0-1 lesson of `todo`).

### 5.2 Runtime shapes (`fast/types.ts`)

```ts
export type FastTierName = 'main' | 'fast';

export interface FastReview {
  index: number;                 // 1-based within the session
  runId: number;
  turn: number;                  // the turn that triggered it
  model: string;                 // resolved fast model id, for the card
  kind: 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';
  text?: string;                 // present only for 'advice'
  detail?: string;               // failure reason / drop reason
  durationMs: number;
  usage?: TokenUsage;
  injected: boolean;
}

export interface FastSnapshot {
  live: boolean;                 // the tier resolved and is enabled
  model: string;
  sameAsMain: boolean;
  reviews: number;
  delegated: number;             // fast-tier children this session
  usage: TokenUsage;
  pricingUnknown: boolean;       // no price table for `model` (C-11 / RV-4)
  inFlight: boolean;             // a review call is open right now
}
```

`TurnFrame` is in §3.5.2. Everything here is JSON-serializable by construction,
so nothing in `/save` needs a format change.

### 5.3 `FastEvent` — a CLI-local stream

```ts
export type FastEvent =
  | { type: 'review_start'; index: number; turn: number }
  | { type: 'review_end'; review: FastReview }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'tier_changed'; snapshot: FastSnapshot };
```

CLI-local for the reason `TeamEvent` is (D-10 there): adding a member to core's
`AgentEvent` union would break `public-api.test.ts` and teach core about a host
shape it has no business defining. `AgentController.subscribeFast(listener)`
forwards it and returns a no-op unsubscribe when no reviewer exists, so every
caller can subscribe unconditionally.

### 5.4 Transcript entry and session persistence

```ts
| { id: string; kind: 'fast'; reviewIndex: number; model: string;
    status: 'running' | 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';
    text?: string; turn: number; durationMs?: number; live: boolean }
```

`live: true` is normalized to `false` **on load**, in
`session/persist.ts::normalizeLoadedEntries`, next to `team.active` and
`todo.live` and for the identical reason (C-5): `Transcript`'s settled boundary
is monotonic, so a card that never settles is re-rendered on every frame for the
rest of the session. The reducer never legitimately sees a stale-live entry —
only the file does.

### 5.5 `FAST_LIMITS` (`fast/limits.ts`)

Structural, not policy — the distinction `TEAM_LIMITS` and `TODO_LIMITS` both
state. A user tunes the ten `fast.*` config keys; nothing here.

```ts
export const FAST_LIMITS = {
  digestMaxChars: 4_000,      // the flat input cost of a review (D-6)
  goalChars: 500,
  turnTailChars: 600,
  toolArgChars: 120,          // mirrors TEAM_LIMITS.activityArgChars
  maxFramesRetained: 12,      // >= the max of reviewContextTurns, with slack
  reviewOutputTokens: 512,
  reviewTimeoutMs: 20_000,
  maxReviewsPerRun: 6,
  maxConsecutiveFailures: 3,
  pendingMaxAgeMs: 120_000,     // a waiting critique goes stale (RV-12)
  pendingMaxTurnsBehind: 2,     // ... or is overtaken by the run itself
  cardTextRows: 4,            // rows the card renders before eliding
  statusCompactCols: 100,     // below this the status chip drops
} as const;

export const FAST_BLOCK_VERSION = 'v1-2026-07';
```

`reviewMaxChars` is a **config** key and not here: it is the one number whose
right value depends on how chatty the user wants their own context to be.
`reviewOutputTokens` stays structural because 512 tokens is a bound on a
protocol, not a preference.

---

## 6. UI design

**Transcript card** (`ui/entries/FastCard.tsx`). Single, quiet, never more than
six rows. Collapsed by construction rather than by an expand toggle: the text is
already clamped to `reviewMaxChars`, so there is nothing hidden to reveal.

```
  fast review #2 · claude-haiku-4-5 · turn 12 · 1.4s
  You have edited config/schema.ts three times without running the tests.
  The clamp for reviewEveryTurns is missing its upper bound.
```

`status: 'ok'` renders one muted line (`fast review #3 · on track`), which is
the common case and must stay visually cheap. `'failed'` and `'dropped'` render
one muted line with the reason. All glyphs through `pickGlyphs`; the file lives
under `ui/`, already in the scanner's scope.

**Status bar** — a `fast` chip in the **right** cluster, next to `eco`, shown
only when the tier is live and dropped below `FAST_LIMITS.statusCompactCols`.
`fast` when idle, `fast*` while a review is in flight. This is a derived readout
and is allowed to degrade; the guaranteed reporting surface is `/fast status`.
(The "no `cols >= N` breakpoint" rule in `StatusBar.tsx` is written about
`agentMode`, whose reason is that the mode must never be unreportable. It does
not extend to this.)

**Team panel / card** — a fast-tier child's label carries a trailing `~`
(ASCII, `src/team/**` is glyph-scanned) and the card's footer states the split:
`3 agents · 2 fast`.

---

## 7. File / module change plan

### New files

| File | Intent |
|---|---|
| `packages/cli/src/fast/limits.ts` | `FAST_LIMITS` + `FAST_BLOCK_VERSION` — the structural bounds, separate from the ten user-facing config keys. |
| `packages/cli/src/fast/types.ts` | `FastTierName`, `TurnFrame`, `FastReview`, `FastSnapshot`, `FastEvent`. |
| `packages/cli/src/fast/resolve.ts` | `resolveFastTier(config, hasKey)` — the single authority every consumer reads. |
| `packages/cli/src/fast/digest.ts` | `buildReviewDigest(frames, goal, limits)` — pure, bounded, no I/O. |
| `packages/cli/src/fast/critique.ts` | `normalizeCritique(raw, maxChars)` — pure classifier with the normalized on-track regex. |
| `packages/cli/src/fast/prompt.ts` | `buildFastBlock(...)`, `buildReviewSystemPrompt(...)`, `renderReviewInjection(...)`. |
| `packages/cli/src/fast/reviewer.ts` | `FastReviewer` — event subscription, frame sealing, trigger, the `complete()` call, the injection window, the drain confirmation (§3.5.4a), budgets, failure policy. |
| `packages/cli/src/fast/wiring.ts` | `FastWiring` — the flag pair, the cached tier, `available()`, `resolveTier`, `onConfigChanged()`, the reviewer's lifetime. Keeps `controller.ts` inside its 1000-line budget (C-12 / RV-5). |
| `packages/cli/src/ui/entries/FastCard.tsx` | The transcript card for one review. |
| `packages/cli/src/__tests__/fast-resolve.test.ts` | Tier resolution matrix, including `sameAsMain` and every `reason`. |
| `packages/cli/src/__tests__/fast-digest.test.ts` | Digest bounds, frame windowing, and that `messages` are never read. |
| `packages/cli/src/__tests__/fast-critique.test.ts` | On-track normalization, clamping, fence stripping. |
| `packages/cli/src/__tests__/fast-reviewer.test.ts` | The injection window, staleness, budgets, failure self-disable — all with a stub `complete`. |
| `packages/cli/src/__tests__/fast-config.test.ts` | Clamp/merge/resolution across the four layers. |
| `packages/cli/src/__tests__/fast-task-tier.test.ts` | `model:"fast"` normalization, downgrade counting, per-tier `ModelRef`. |
| `docs/plans/fast-model-tier/manual-test.md` | Manual matrix (§8.3). |

### Modified files

| File | Intent |
|---|---|
| `packages/cli/src/config/schema.ts` | `FastConfig`, `DEFAULT_FAST_CONFIG`, `clampFastConfig`; `fast` on `PersistedConfig` and `CliConfig`. |
| `packages/cli/src/config/store.ts` | **Both** hand-written merges learn the sixth section (C-3). |
| `packages/cli/src/config/load.ts` | `resolveFastConfig` + the four `CliFlags` fields. |
| `packages/cli/src/config/env.ts` | The four `ARAGON_FAST*` keys, one accumulated section assigned once. |
| `packages/cli/src/config/cli-commands.ts` | `applyFastConfigSet` for `aragon config set fast.*`. |
| `packages/cli/src/cli.tsx` | Flag declarations, `toFlags` carriage, controller wiring — all three sites. |
| `packages/cli/src/agent/controller.ts` | **Thin (C-12 / RV-5):** one `FastWiring` field, four forwarders (`setFastConfig` / `setFastEnabled` / `getFastStatus` / `subscribeFast`), `getModelInfoFor` + `isPricedModel` (RV-4), `abortRequested` + `isAbortRequested()` and the `userSteerCount` in `steer()` (§3.5.4a), `prompt()` goal capture, `fastBlock` in `composeSystemPrompt`, `onConfigChanged()` from the existing mutators. The flags, the tier cache and the reviewer's lifetime live in `fast/wiring.ts`. Budget check: the file is at 960 of 1000 lines before this change, so the split is a constraint, not a preference. |
| `packages/cli/src/agent/system-prompt.ts` | `fastBlock?` parameter, conditionally spliced. |
| `packages/cli/src/agent/reducer.ts` | `kind: 'fast'` entry, `fastStart` / `fastEnd` / `fastUsage` actions, `ViewState.fast`; `teamUsage` gains `tier`. **Budget: 944 of 1000 lines before the change (C-12).** If the entry union and the three cases do not fit, the `fast` cases move to a `reducer-fast.ts` handler the switch delegates to — the same shape, not a rewrite. |
| `packages/cli/src/agent/headless.ts` | Subscribe to `FastEvent` for logging only; no stdout output (D-12). |
| `packages/cli/src/team/types.ts` | `SubagentSpec.tier`, `SubagentRun.tier`, `DispatchOutcome.fastUsage`, `TeamEvent.usage.tier`. |
| `packages/cli/src/team/normalize.ts` | Parse `model`, downgrade when unavailable, return `downgraded`. |
| `packages/cli/src/team/task-tool.ts` | Conditional `model` property + one description sentence + the downgrade note. |
| `packages/cli/src/team/subagent.ts` | `deps.resolveTier(spec.tier)` replaces the two hardcoded config reads. |
| `packages/cli/src/team/runtime.ts` | Pass `resolveTier` into `SubagentDeps`; split outcome usage by tier. |
| `packages/cli/src/team/report.ts` | `[fast]` row annotation, second cost table, the downgrade line. |
| `packages/cli/src/team/prompt.ts` | One sentence in `<team_mode>` when fast delegation is live. |
| `packages/cli/src/commands/builtins.ts` | The `/fast` command. |
| `packages/cli/src/session/persist.ts` | Normalize `kind: 'fast'` entries to `live: false` on load (C-5). |
| `packages/cli/src/ui/App.tsx` | `subscribeFast` → dispatch; status-bar props; cost table selection by tier via `getModelInfoFor` (RV-4); the four new `SettingsValues` fields in the save handler (RV-13). |
| `packages/cli/src/ui/Transcript.tsx` | Render `kind: 'fast'`. |
| `packages/cli/src/ui/layout/virtual-window.ts` | Row-height estimate for the new entry kind — in **both** switches over entry kind (`:60` and `:146`). Adding the case to one of them yields a transcript whose scroll arithmetic disagrees with what it drew, which manifests as drift rather than as an error (RV-13). |
| `packages/cli/src/ui/transcript-text.ts` | Plain-text rendering for `/save` and the exit transcript. |
| `packages/cli/src/ui/StatusBar.tsx` | The `fast` chip. |
| `packages/cli/src/ui/TeamPanel.tsx`, `ui/entries/TeamCard.tsx` | The `~` tier marker and the `n fast` footer. |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | Four rows appended to `FIELDS` + the derived tier line beside `effectiveCapLine`. The `SettingsValues` type gains the four keys, and `FieldKey = keyof SettingsValues` propagates them (RV-13). |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | A `/fast` row. |
| `packages/cli/src/__tests__/glyphs.test.ts` | Add `fast` to the `inScope` regex (C-4) — **not optional**. |
| `packages/cli/README.md` | Fast tier section: config keys, flags, env, `/fast`, cost note. |
| `packages/cli/CHANGELOG.md` | Release entry. |

**Not touched:** every file under `packages/core/`, and `packages/cli/src/todo/**`,
`skills/**`, `input/**`, `logging/**` (beyond using the logger).

---

## 8. Testing & acceptance criteria

### 8.1 Unit tests (Vitest, offline)

The reviewer is testable without a network because its two dependencies are
injected: `complete` (a stub returning a fixed `AssistantMessage`) and a fake
event source that replays a scripted `AgentEvent` sequence. The digest, the
critique classifier and the tier resolver are pure functions.

Key cases:

- **Injection window.** Replay `turn_end(2 tool calls)` → `tool_execution_end` →
  (review resolves here) → `tool_execution_end`. Assert `steer` is called
  **exactly once**, **after the second** `tool_execution_end`, and never after
  the first. This is the test that would catch a refactor moving `steer()` back
  into the promise callback.
- **Stranded delivery (RV-1, the P0 regression test).** Replay
  `turn_end(1 tool call)` → `tool_execution_end` (review already resolved, so the
  reviewer steers) → `agent_end` **without an intervening `turn_start`**. Assert:
  `awaitingDrain` was true at `agent_end`; the entry ends as `dropped` with
  reason `stranded`; `clearAllQueues` was called exactly once when
  `userSteerCount === 0`; and **not at all** when a user steer was recorded
  first. This is the test that would catch a refactor deleting guard 2 as
  "defensive".
- **Abort does not steer (RV-1, guard 1).** Set `abortRequested` before
  replaying the batch-ending `tool_execution_end`; assert `steer` is never
  called and the review is `dropped`, not injected.
- **Frame sealing (RV-2).** Trigger a review and assert the digest contains the
  triggering turn's `isError` and `ms` values — i.e. that the frame was sealed
  before it was digested — and that an unsealed frame is never included.
- **Tier lost mid-session (RV-3).** Flip the resolver to `no_key` between two
  dispatches; assert the second dispatch downgrades and counts, no child is
  constructed with the fast `ModelRef`, and the prompt block is recomposed.
- **Unknown pricing (RV-4).** Resolve the tier to a model absent from the static
  table; assert `pricingUnknown` is true, `costDelta` is `0`, and `/fast status`
  renders `unknown` rather than a currency amount.
- **Staleness.** Resolve a review after `agent_end`; assert `steer` is never
  called and a `dropped` review is emitted.
- **Stale pending (RV-12).** Hold a `pending` critique past
  `pendingMaxAgeMs`; assert it is discarded with reason `stale_pending` and never
  injected.
- **Overlap.** `reviewEveryTurns: 1` with a `complete` that never resolves;
  assert exactly one call is ever started.
- **Budget.** 40 turns, `reviewEveryTurns: 1`; assert exactly
  `maxReviewsPerRun` calls.
- **Self-disable.** Three consecutive rejections; assert one `warn` notice, no
  fourth call, and that the agent run is otherwise untouched.
- **Digest bound.** 12 frames each with a 5 000-character tail; assert the
  digest is ≤ `digestMaxChars` and that the newest frames survive.
- **On-track.** `'Ok, on track'`, `'OK - on track.'`, `'  ok — everything on
  track  '` all classify as `ok`; `'OK, but the tests are failing'` classifies
  as `advice`.
- **Downgrade.** `model:"fast"` with the tier off → `tier: 'main'`,
  `downgraded: 1`, and the report line present.
- **Per-tier `ModelRef`.** A stub `agentFactory` captures `AgentConfig`; assert
  a `fast` child got the fast `ModelRef` and `thinkingLevel: 'off'`, and a
  `main` child got the session's.
- **Cost split.** A dispatch with one child per tier; assert the two cost tables
  are used and the totals differ.

### 8.2 Acceptance criteria

| # | Criterion |
|---|---|
| **AC-1** | With no `fast` key in `config.json`, `fast.enabled` resolves `false` and the tier is off (R-d). |
| **AC-2** | With the tier off, `controller.getSystemPrompt()` is **byte-identical** to the pre-feature output for a fixed tool array (I-2). |
| **AC-3** | With the tier off, `task`'s JSON schema has no `model` property and `TASK_DESCRIPTION` is byte-identical. |
| **AC-4** | With the tier off, no `FastReviewer` is constructed and `subscribeFast` returns a no-op. |
| **AC-5** | `fast.enabled: true` with `fast.model: ''` leaves the tier off and raises exactly one notice. |
| **AC-6** | `fast.enabled: true` with an unreachable provider key leaves the tier off and raises exactly one notice; no LLM call is attempted. |
| **AC-7** | `fast.model` equal to the main model resolves `ok` with `sameAsMain: true` and is used normally (R-e). |
| **AC-8** | `--no-fast` beats a `config.json` with `enabled: true`; `--fast` beats `enabled: false`. |
| **AC-9** | `ARAGON_FAST=1 ARAGON_FAST_MODEL=x` resolves the tier with no flag and no config file. |
| **AC-10** | `/fast on` in a session launched without the tier persists the setting and reports the "not configured at launch" sentence; the session is otherwise unchanged. |
| **AC-11** | `/fast review 8` updates both the live config (`controller.getConfig().fast`) and `config.json`. |
| **AC-12** | `/fast` is refused mid-dispatch. |
| **AC-13** | `aragon config set fast.reviewEveryTurns 400` writes `50` and prints `50`. |
| **AC-14** | A subagent with `model:"fast"` is constructed with the fast `ModelRef` and `fast.thinkingLevel`; a sibling without it is unchanged. |
| **AC-15** | A fast child obeys `readOnly`, the session's plan mode, `--confirm` and the skills ceiling identically to a main child (I-4). |
| **AC-16** | With `fast.delegate: false`, `model:"fast"` is downgraded, counted, and reported. |
| **AC-17** | The dispatch report computes fast-tier spend from the fast model's cost table. |
| **AC-18** | The status bar's cumulative cost includes review spend at the fast model's price. |
| **AC-19** | A review is started on turn `reviewEveryTurns` and not before. |
| **AC-20** | `steer()` is called **only** from the `tool_execution_end` that empties the batch (the §8.1 window test). |
| **AC-21** | A review resolving after `agent_end` is dropped, logged, and shown as `dropped`; the next user turn's message list is unchanged. |
| **AC-22** | At most one review call is in flight at any time. |
| **AC-23** | At most `maxReviewsPerRun` reviews are started per run. |
| **AC-24** | Three consecutive review failures self-disable the reviewer for the session with one warn notice; the run completes normally. |
| **AC-25** | An `ok` critique produces a card and **no** `steer()` call. |
| **AC-26** | `Esc` during a run aborts the in-flight review, and — the part v1 asserted but did not deliver — **no `<fast_review>` block reaches any later conversation**. Concretely: after `Esc` at the batch-ending `tool_execution_end`, the next `prompt()`'s message list contains the user's new question and nothing else (RV-1). |
| **AC-31** | A review that is steered and then stranded by an abort ends as `dropped { reason: 'stranded' }`, logs `fast_review_stranded`, and clears the queue **only** when `userSteerCount === 0`; with a user steer queued it clears nothing and warns (§3.5.4a). |
| **AC-32** | The digest for a review triggered by turn *N* contains turn *N*'s tool results (`isError`, `ms`), i.e. the frame was sealed before it was read (RV-2). |
| **AC-33** | Switching the main provider to one with no API key, with `fast.provider: ''`, makes `fastAvailable` false: `model:"fast"` downgrades and is counted, no child is built against the unusable `ModelRef`, `<fast_tier>` is recomposed or dropped, and one notice names the reason (RV-3). |
| **AC-34** | A fast model absent from the price table reports `pricingUnknown`, contributes `0` to the aggregate, and is rendered as `unknown` — never as `$0.00` — in `/fast status`, the dispatch report and the status bar (RV-4). |
| **AC-35** | `controller.ts` and `reducer.ts` are each ≤ 1000 lines after the change (C-12 / RV-5). |
| **AC-36** | A fast provider returning `rate_limit` three times running does **not** self-disable the reviewer, and the run is unaffected; a wrong `fast.model` (a non-retryable `invalid_request`) self-disables after three with exactly one `warn` notice (RV-18). |
| **AC-37** | The frame recorder ignores every `StreamEvent` type other than `text_delta`, including `retry_scheduled` / `retry_attempt` and any member added after this design was written (RV-10 / R-16). |
| **AC-27** | `glyphs.test.ts` scans `src/fast/**` and reports zero violations (C-4). |
| **AC-28** | A session saved mid-review resumes with the card settled (`live: false`) (C-5). |
| **AC-29** | `-p` with the tier on runs both capabilities and writes nothing extra to stdout. |
| **AC-30** | `npm run build`, `npm run typecheck` (both tsconfigs) and `npm test` are green in both packages; `packages/core` has zero source diffs. |

### 8.3 Manual test pointers (`manual-test.md`, authored with the implementation)

1. Fresh install, no config → no chip, no `<fast_tier>` in `/debug`, `task`
   schema unchanged.
2. `/fast model claude-haiku-4-5` then `/fast on` → chip appears, `/fast status`
   resolves.
3. Ask for work that spans six or more turns → observe a `fast review` card and,
   in the next turn, the model acknowledging it.
4. `/fast review off` → cards stop, delegation still works.
5. A deliberately wrong `fast.model` → one notice, tier off, run unaffected.
6. Pull the network for the fast provider only (bad `fast.baseUrl`) → three
   failures, one notice, run completes.
7. A `task` batch with one `fast` and one `main` child → report shows `[fast]`
   and two cost lines.
8. `/save` mid-review, `/resume` → the card is settled and the transcript does
   not re-render.

---

## 9. Risks & mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-1** | **An ill-timed `steer()` corrupts the conversation** — checkpoint 2 leaves `tool_use` without `tool_result` (HTTP 400) or checkpoint 3 silently deletes pending tool calls. | **Critical** | The injection window rule (§3.5.4), enforced structurally (injection is only reachable from one synchronous callback) and pinned by AC-20 with a replay test. |
| **R-2** | **The review costs more than it saves** — a naive implementation passing `agent.state.messages` to the "cheap" model. | High | D-6: the reviewer maintains its own bounded frame ring and never reads message history; `digestMaxChars` makes the input cost flat. AC in §8.1 asserts the digest bound. |
| **R-3** | **Runaway review spend** on a long run or a fast cadence. | High | Three independent caps: `maxReviewsPerRun`, single-flight, and `reviewOutputTokens`. All spend reaches the status bar and `/fast status` (§3.6). |
| **R-4** | **A stale critique lands in the wrong conversation** and looks like the user said it. | **Critical** (raised from High: v1's mitigation was incomplete — RV-1) | Four layers now, because `steer()` is an enqueue and not a delivery: (1) `runId` comparison and the drop-on-`agent_end` rule (D-8); (2) `pendingMaxAgeMs` / `pendingMaxTurnsBehind` (RV-12); (3) **the drain confirmation of §3.5.4a** — guard 1 refuses to steer into a requested abort, guard 2 proves delivery at the next `turn_start` and removes an undelivered block when it can prove it owns the queue; (4) the `<fast_review turn model>` wrapper and the `<fast_tier>` paragraph, so the residual case the reviewer must not clear is at least self-identifying. AC-26 / AC-31. |
| **R-5** | **The reviewer breaks a healthy run** through the watchdog. | High | I-5: it never touches the watchdog, and the reason (`pause()` is a boolean, not a counter) is recorded at the call site it would be added to. |
| **R-6** | **Silent downgrade** — the model asks for `fast`, gets `main`, and never learns its cost model is wrong. | Medium | `downgraded` is counted in the normalizer and stated in the report (§3.4). |
| **R-7** | **Cost is attributed to the wrong model**, making the feature look free or ruinous. | Medium | Per-tier `TokenUsage` on `DispatchOutcome` and `TeamEvent.usage.tier`; the reducer receives a precomputed `costDelta` so the cost table is chosen exactly once, in `App`. |
| **R-8** | **A quiet capability** — the user enables the tier and cannot tell whether it ever did anything. | Medium | The card (including `ok` / `failed` / `dropped` one-liners), the chip, and `/fast status`'s session totals. Nothing about this feature is allowed to be invisible. |
| **R-9** | **The new tree escapes the glyph scanner**, so the ASCII guarantee becomes vacuous for the newest code. | Medium | AC-27; the regex change ships in the same commit as the tree (the `team/` and `todo/` precedent). |
| **R-10** | **`store.ts`'s second merge is forgotten**, so every `/fast` write drops the rest of the section. | Medium | C-3 states both sites; `fast-config.test.ts` round-trips a partial patch through `updatePersistedConfig`. |
| **R-11** | **Prompt bloat** — `<fast_tier>` is paid on every turn of every enabled session. | Low | Under 1 100 characters, split per capability, versioned, and absent entirely when the tier is off. |
| **R-12** | **A fast model produces low-quality advice** the lead over-trusts. | Low | The block says "advice", the critique is clamped to `reviewMaxChars`, it arrives as prose with no authority to approve anything, and `/fast review off` is one command. |
| **R-13** | **`sameAsMain` tempts a "skip the call" optimization**, silently turning R-e into a no-op. | Low | `sameAsMain` is documented as **display only** (§3.2 rule 7) and no branch reads it. |
| **R-14** | **A tier that stops resolving mid-session** builds a child against a provider with no key; the child dies with an error naming neither the tier nor the setting (RV-3). | High | `fastAvailable` is a live predicate, evaluated at dispatch time (§3.3); `resolveTier` falls back to main; one notice names the reason; AC-33. |
| **R-15** | **Unknown pricing renders as `$0.00`**, so the feature looks free while spending (RV-4). | High | `isPricedModel` + `pricingUnknown`, and `unknown` is a distinct rendering from a currency amount everywhere spend is shown (§3.6); AC-34. |
| **R-16** | **The frame recorder is a per-token synchronous listener** on the package's hottest path (RV-10). | Medium | It is gated on `text_delta` + tier live + review on + reviews remaining, and never subscribed at all with the tier off (§3.5.2). Note the gate must be a `text_delta` **allow**-test, not a "skip the types I know about" deny-test: `llm-api-retry-backoff` is adding two new `StreamEvent` members right now, and a deny-list would have silently started recording them. |
| **R-17** | **A busy fast provider self-disables the reviewer for the session**, because retry now lives inside `complete()` and three strikes can come from one minute (RV-18). | High | Retryable classifications (`rate_limit`, `overloaded`) are transient and do not count as strikes (§3.5.5); the reviewer opts out of retry where the core field exists, and raises its budget where it does not (§3.5.3). |
| **R-18** | **The two features land in the same tree and diverge**: this design's `complete()` semantics were written against a non-retrying registry. | Medium | RV-18 records the exact overlap and assigns the one core-side change (`LLMRequest.maxRetries?`) to the retry feature's scope, keeping this feature at zero core diffs (I-1). Whichever lands second re-reads §3.5.3 before implementing; AC-36 fails loudly if neither did. |

---

## 10. Decisions

| # | Decision | Alternative rejected, and why |
|---|---|---|
| **D-1** | Delegation rides on the existing `task` batch. | A separate `fast_task` tool: the core loop is strictly sequential, so N calls would be N serial children — the opposite of the point (I-1 of `team-subagents`). |
| **D-2** | Two flags (`fastRegistered` / `fastEnabled`). | One live flag: the tool array is immutable (C-2), so a live `on` would advertise a schema field that does not exist. |
| **D-3** | The tier is **off** by default. | On-by-default: the requirement says otherwise (R-d), and a feature that silently spends money on a second provider is not a default. |
| **D-4** | `fast.provider` empty inherits the main provider; `fast.model` empty means *not configured*. | Inheriting the model too: it would make "fast == main" (a legitimate choice, R-e) indistinguishable from a typo. |
| **D-5** | Turns are the review's unit. | Tool calls: a batch of six is one decision, not six; and `turn_end` is the event the loop already reports. |
| **D-6** | The digest is built from a bounded frame ring, never from message history. | `agent.state.messages`: file bodies would make a review cost more than the turn it reviews (R-2). |
| **D-7** | Injection happens only at the batch-empty `tool_execution_end`. | Injecting from the promise callback: hits checkpoints 2 and 3 (R-1). |
| **D-8** | A pending critique is **dropped** at `agent_end`. | Carrying it into the next run: stale advice, attributed to the user, about a different question. **(Corrected in v2, RV-6.** v1 gave a second reason — "`steer()` on an idle agent restarts a finished run" — which is false: `Agent.steer()` only pushes onto a queue, `agent.ts:260-262`. The real second hazard is worse and is now D-19: a message that *is* queued and never drained resurfaces in the next conversation on its own. A decision defended by a checkable claim that turns out to be wrong is a decision the next engineer reverts.) |
| **D-9** | Steering, not a mailbox tail. | Wrapping every lead tool to piggyback the critique on the next tool result: eleven wrapped tools and a review rendered inside a `read_file` card. |
| **D-10** | `FastEvent` is CLI-local. | Extending core's `AgentEvent`: breaks `public-api.test.ts` and couples core to a host shape (the `TeamEvent` precedent). |
| **D-11** | The reviewer gets **no tools**. | A tool-using reviewer: a second agent editing the same tree with none of the lead's gates. |
| **D-12** | Headless emits no extra stdout. | Printing review cards in `-p`: stdout is the answer channel and is piped into other tools. |
| **D-13** | `fast.thinkingLevel` defaults to `'off'`. | Inheriting the session level: an `xhigh` "fast" child is neither fast nor cheap. |
| **D-14** | Four env vars, no cadence env var. | A full env surface: `env.ts` states the rule — an env var exists only where a flag *and* a config file are both unreachable. |
| **D-15** | Delegation is a **model** choice, never a permission boundary. | Restricting fast children's tools: it would look like security, is not, and would make the report's `[fast]` rows mean two different things. |
| **D-16** | `ok` critiques are shown but not injected. | Injecting them: pure context tax on every cycle, for the message "nothing to say". |
| **D-17** | The on-track test is a normalized regex. | String equality: one model writing `Ok, on track` turns the optimization off permanently and silently. |
| **D-18** | Reviews self-disable after three consecutive failures. | Retrying forever: three identical stream errors per run, none of them the user's problem. |
| **D-19** | The reviewer **confirms delivery** (`awaitingDrain` cleared at `turn_start`) instead of assuming that a `steer()` was delivered (§3.5.4a / RV-1). | Trusting `isRunning()`: the loop emits the batch's last `tool_execution_end` *before* it re-tests the abort signal (`agent-loop.ts:249` vs `:271`) and nothing clears the queues at `agent_end` (C-10), so `isRunning()` is true in exactly the interleaving where delivery will not happen. |
| **D-20** | Two abort guards, not one. | Only checking `controller.abort()`: the idle watchdog calls `Agent.abort()` directly (`watchdog.ts:15-17`), so a controller-level flag cannot see it — and the watchdog fires precisely on the long, quiet runs where a review is most likely to be pending. |
| **D-21** | The reviewer clears the queue only when it can prove it is the sole writer (`userSteerCount === 0`); otherwise it warns and leaves the block. | `clearAllQueues()` unconditionally: `Agent` cannot remove one message (C-10), so the alternative destroys a user's own steering message to tidy up after the harness. Never trade someone else's data for your own cleanliness. |
| **D-22** | A review is triggered when a turn's frame **seals**, not at `turn_end` (RV-2). | Triggering at `turn_end`: it fires before any tool runs (`agent-loop.ts:188`), so the newest frame is structurally missing `isError` and `ms` — the reviewer would be asked whether the run is on track while being denied the fact that the last batch just failed. |
| **D-24** | A retryable failure (`rate_limit` / `overloaded`) is **not** a strike against `maxConsecutiveFailures` (RV-18). | Counting every failure equally: with retry now inside `complete()`, one busy minute at the fast provider can produce three "failures" and disable the reviewer for the whole session — punishing the user for a condition that fixed itself, and doing it silently after a single `warn`. Self-disable exists for misconfiguration, which does not resolve on its own. |
| **D-25** | The per-request retry opt-out (`LLMRequest.maxRetries?`) is assigned to **`llm-api-retry-backoff`'s** scope, not this one (RV-18). | Adding it here: it is a `packages/core` change, and I-1 / C-1's zero-core-diff property is what keeps `public-api.test.ts` and `no-host-coupling.test.ts` green without negotiation. A cross-feature request is cheaper than a precedent for editing core from the CLI's side of the fence. |
| **D-23** | `fastAvailable` is a live predicate rather than a third stored flag (RV-3). | A third stored flag: it would need invalidating from five call sites (`/model`, `/provider`, settings save, `/reload`, key edit), and the failure mode of missing one is a child built against a provider with no key — silent until the child dies. A predicate cannot go stale. |

---

## 11. Definition of done

1. `docs/plans/fast-model-tier/spec.md` (this file) exists — done at this node —
   and `docs/plans/fast-model-tier/manual-test.md` is authored alongside the
   implementation from the matrix in §8.3.
2. Every file in §7 is created or modified as described; `packages/core` shows
   **zero** source diffs (`git diff --stat packages/core/src`).
3. `npm run build`, `npm run typecheck` (both `tsconfig.json` and
   `tsconfig.test.json` in each package) and `npm test` are green.
4. AC-1 … AC-37 pass, with **AC-2, AC-3, AC-20, AC-21, AC-26, AC-27, AC-31,
   AC-32, AC-33, AC-34, AC-36 and AC-37** covered by automated tests rather than inspection —
   those ten are the ones whose failure is silent. AC-26 and AC-31 are the P0
   regression pair (RV-1) and neither may be marked done by manual inspection:
   the interleaving they cover needs an abort landing inside a specific `await`,
   which is reproducible in a replay test and effectively not by hand.
5. `packages/cli/README.md` documents the ten config keys, the four flags, the
   four env vars and `/fast`, including one sentence on cost.
6. A default-config session (`fast.enabled: false`) is indistinguishable from
   the pre-feature build in the system prompt, the tool schemas, the transcript
   and the request payloads.
7. `controller.ts` and `reducer.ts` are each ≤ 1000 lines, and `src/fast/**`
   holds no file over 1000 lines (C-12 / RV-5 / AC-35). The budget is checked as
   part of the change, not discovered by the next reviewer.
   **Not met for the first two — see IF-1.**

---

## 实施过程发现的方案缺陷

*(Issues found during implementation. Recorded rather than silently worked
around, per the implementation node's constraint. Each names what the design
said, what the tree actually contained, and what was done instead.)*

> **Round-2 status (`docs/plans/fast-model-tier-hardening/`, W1–W4).**
> **IF-2 CLOSED** — `LogScope` gained `'fast'` and both fast loggers use it; the
> two compromise comments are gone (W4).
> **IF-3 CLOSED** — the reviewer no longer shares the lead's registry: `FastWiring`
> builds its own through `initProviders({ retryPolicy: { ...DEFAULT, maxRetries: 1 } })`,
> so the 30 s fallback was replaced by a measured 20 s bound (W2 / D-H11). The
> transient exclusion is retained deliberately and now matters more, not less.
> **IF-1: the fast-owned share is CLOSED, the repo-level remainder stays OPEN.**
> `reviewer.ts` was split into `frames.ts` + `review-call.ts` + a remainder (W3),
> and round 2 added **zero net lines** to `controller.ts`, `reducer.ts` and
> `App.tsx` — verified with `git diff --stat`. Those three are still over cap;
> D-H10 owns that debt and names its discharge condition (the next change to
> each), rather than re-inheriting it silently.
> **IF-7 is re-pinned across the new module boundary** by AC-H16 and by the
> cancellation cases in `fast-reviewer.test.ts`, which were written and confirmed
> green *before* the split.

### IF-1 — AC-35 / DoD 7 is unachievable by this feature alone: the budget was already spent

**What the design said.** `controller.ts` is at 960 of its 1000 permitted lines
and `reducer.ts` at 944, so the controller-side wiring is *extracted* rather than
inlined (C-12 / RV-5), and both files finish ≤ 1000.

**What the tree contained.** `llm-api-retry-backoff` — the sibling feature RV-18
already flags as uncommitted in this same working tree — landed in these two
files *while this one was being implemented*. Measured:

| file | committed at `404f925a` | after both features |
|---|---|---|
| `agent/controller.ts` | 960 | 1266 |
| `agent/reducer.ts` | 944 | 1416 |

`reducer.ts` was already past 1000 before a single line of this feature reached
it. The overage is **jointly caused and cannot be attributed**, so it also cannot
be fixed from inside this feature's scope: refactoring another feature's
uncommitted code, in a file a second agent is actively editing, would trade a
line-count for a merge conflict.

**What was done.** The extraction the design mandates *was* performed and is what
keeps this feature's own footprint small: `fast/wiring.ts` (321 lines) holds the
flag pair, the tier cache, `available()`, `resolveTier`, `onConfigChanged()` and
the reviewer's lifetime, and `AgentController` gains one field plus the four thin
forwarders §7 specifies. Every file under `src/fast/**` is well inside the cap
(largest: `reviewer.ts`, 794).

**What is left.** AC-35 is a **repo-level** debt against `controller.ts` and
`reducer.ts` that the next change to either should discharge, not a fast-tier
defect. Recording it here rather than quietly passing the criterion is the point:
"the budget is checked as part of the change" was satisfied; the budget itself
was not.

### IF-2 — there is no `fast` log scope, and `logging/**` is out of scope

**What the design said.** §3.10: "Scope `fast`, through the existing
`ScopedLogger`."

**What the tree contained.** `LogScope` (`logging/logger.ts:35`) is a closed
union of nine members, and §7's own "Not touched" list includes `logging/**`
(beyond using the logger). The two instructions contradict each other.

**What was done.** Scope `agent`, which is the settled precedent rather than a
compromise: `team/` and `todo/` are two whole subsystems and neither has its own
scope — `todo/store.ts:95` logs under `agent`. Every event name in §3.10's table
is unchanged (`fast_review_start`, `fast_review_injected`, `fast_review_stranded`
…) and each is unique across the package, so the one property §3.10 actually
needs — a record findable from a behaviour report with one grep — holds. The
choice is commented at both `FastReviewer.log` and `FastWiring.log`.

### IF-3 — `LLMRequest.maxRetries` did not ship, so §3.5.3's fallback is the live path

**What the design said.** D-25 assigns the per-request retry opt-out to
`llm-api-retry-backoff`'s scope, with §3.5.3's fallback ("retries stay on,
`reviewTimeoutMs` rises to 30 s, retryable failures are transients") as the safe
path if it does not arrive.

**What the tree contained.** It did not arrive. `ProviderRegistry.complete()`
routes through a retrying `stream()` (`providers/index.ts`), the policy is
registry-global via `setRetryPolicy`, and `LLMRequest` carries no per-request
override. The reviewer shares the lead's registry instance, so it cannot opt out.

**What was done.** The fallback, in full and in one place:
`FAST_LIMITS.reviewTimeoutMs` is **30 000** rather than the 20 000 §5.5 lists,
documented at the constant as a budget for *attempts × (call + backoff)*; and
`rate_limit` / `overloaded` do not increment `consecutiveFailures`
(`TRANSIENT_ERROR_TYPES` in `reviewer.ts`, asserted by AC-36's two cases). No
`packages/core` file was touched (`git diff --stat packages/core/src` shows only
the retry feature's own edits), so I-1 / C-1 hold.

### IF-4 — `normalizeSubagentSpecs` must count downgrades over the SURVIVORS

**What the design said.** §3.4: `'fast'` without availability → `tier: 'main'`
and `downgraded += 1`.

**What implementation showed.** Incrementing at the point of repair counts specs
the `maxSubagents` cap then drops. Those children never ran at all, so reporting
them as "ran on the main model" is a second, different falsehood inside the line
that exists to prevent the first (R-6). `downgraded` is therefore computed after
the slice, over the surviving specs, with a regression case in
`fast-task-tier.test.ts`.

### IF-5 — the main-tier usage sum is the COMPLEMENT of fast, not `=== 'main'`

**What implementation showed.** `SubagentRun.tier` is populated by
`createSubagent` for every real run, but a hand-built run in a test — or one
restored from a session file written before the field existed — has it
`undefined`, and `handles.filter(h => h.run.tier === 'main')` silently drops that
child's spend from `DispatchOutcome.usage`. Under-reporting is the one failure
the per-tier split exists to prevent, so the default direction has to be
"counted": the predicate is `h.run.tier !== 'fast'`. `team-retry.test.ts` caught
this on the first run.

### IF-6 — `SubagentSpec.tier` / `SubagentRun.tier` are required, and that costs test churn

`tier` is REQUIRED on both (as §7 specifies), which means fifteen existing test
files needed a `tier: 'main'` in their fixtures and a `fast: DEFAULT_FAST_CONFIG`
in their `CliConfig` builders. Making the field optional would have avoided all
of it and would also have made "which model did this child run on?" answerable
only sometimes — the exact silent-gap class this design objects to elsewhere. The
churn was accepted; the three hand-written `FakeController`s (`app.test.tsx`,
`mouse-routing.test.tsx`, `app-follow-through.test.tsx`) also gained
`getFastStatus` / `subscribeFast` / `getModelInfoFor` / `isPricedModel`, exactly
as `app.test.tsx`'s own note about `subscribeTodos` predicts every new controller
member will.

### IF-7 — a CANCELLED review was scored as a failed one (found at code review)

**What the design said.** §3.5.5 draws the line twice: `consecutiveFailures`
counts "a transport error, a timeout or an unparseable answer", and self-disable
"is meant for a *misconfigured* tier … because that is the case a user must be
told about, since it will never fix itself" (D-18 / D-24). Abort is listed
separately, and `DropReason` has carried `'aborted'` since v2.

**What the code did.** The reviewer aborts its own in-flight `complete()` from
three places that all mean *never mind* — `endRun()` (the run finished first),
`abort()` (Esc) and `dispose()` — and every one of them landed in
`onReviewFailure`. So each scored a full strike and rendered a `failed` card.

Three ordinary runs are enough to trip it, because a run that ends with a review
still open is not an edge case: a turn that answers without tools ends the run
(`agent-loop.ts:344-357`), so any review started on the second-to-last turn is
still in flight when `agent_end` arrives. The reviewer then self-disabled **for
the rest of the session**, announcing it with a `warn` quoting
`Stream ended without a done event` — a message that names neither the fast tier
nor anything the user did. This is D-24's hazard exactly, reached through a
different door: punishing the user for a condition that was never a fault.

**Why it could not be classified from the error.** The retry layer returns
**silently** on abort (`retry.ts` G3 — deliberately, so a user Esc is not blamed
on the network), so the stream ends with no `done` and no `error`, and
`consumeStream` throws a bare `Error` with no `errorType`. A timeout — which
§3.5.5 says *should* be a strike — goes through the identical
`controller.abort()` and produces the identical error. The two are
indistinguishable by inspection, so the **reason has to be recorded at the call
site**, not inferred.

**What was done.** `FastReviewer` stamps `callAbortReason` before aborting:
`'timeout'` from its own timer (still a strike, still a `failed` card) and
`'cancelled'` from `cancelCall()`, which `endRun()` / `abort()` / `dispose()`
now share. A cancelled review emits a terminal `dropped` card with detail
`cancelled` — terminal because `review_start` already placed a `running` entry
and `Transcript`'s settled boundary is monotonic (C-5) — and leaves
`consecutiveFailures` untouched, being neither a success that clears it nor a
failure that raises it. Three regression cases in `fast-reviewer.test.ts` pin
all three halves: cancelled is `dropped` not `failed`, three run-ends raise no
notice and leave the reviewer alive, and a timeout is still a strike.

---

## 评审结论

*(Review verdict.)*

**有条件通过 (approved with conditions).**

The design is sound and unusually well grounded: nearly every load-bearing claim
in it was checked against the code and held, including the two that would have
sunk it if they had not (checkpoint 1's adjacent-`user`-message safety, and
`complete()` preserving usage). The central insight — that `Agent.steer()` is
drained at three checkpoints of which two are destructive, and that the whole
reviewer must therefore be shaped around *when* it may speak — is correct and is
the right thing to have built the feature around. Requirements R-a … R-h are all
traceable to a mechanism, the off-by-default byte-identity branch is real, and
the scope matches the `team` / `todo` precedent rather than inventing a sixth
way to configure something.

One **P0** and six **P1** issues were found; all seven are fixed in the body
above and none required abandoning a decision. The P0 is worth restating because it is
the class of defect this design was otherwise built to avoid: v1 treated
`steer()` as *delivery* when it is only *enqueue*, and the loop's own ordering
(`tool_execution_end` at `agent-loop.ts:249`, abort re-tested at `:271`, queues
never cleared at `agent.ts:410-425`) leaves a reachable window in which the
critique is queued, never drained, and resurfaces in the user's next
conversation wearing the user's role. §3.5.4a closes it.

Approval is conditional on the following, which are commitments for the
implementation node rather than further design work:

1. **AC-26 and AC-31 ship as automated replay tests in the same commit as
   `fast/reviewer.ts`.** Not afterwards, and not as manual-test rows. They are
   the only mechanical guard on the P0, and the interleaving is impractical to
   hit by hand.
2. **AC-20 keeps its exact wording** — `steer()` is called *only* from the
   `tool_execution_end` that empties the batch. A future refactor that moves it
   into the `complete()` callback will look tidier and will reintroduce R-1.
3. **`glyphs.test.ts`'s `inScope` regex gains `fast` in the commit that creates
   `src/fast/`** (C-4 / AC-27). The tree is invisible to the scanner until it
   does, and a guard that silently stops guarding is worse than no guard.
4. **Both merge sites in `store.ts` gain the `fast` line** (C-3 / R-10), with the
   round-trip test through `updatePersistedConfig`. This has bitten the package
   once already.
5. **The file-size budget (C-12 / AC-35) is verified before the change is
   proposed as done**, not treated as advisory. `controller.ts` has 40 lines of
   headroom.
6. **`manual-test.md` adds a row for the abort case**: start a long run, press
   `Esc` on the last tool of a batch while a review is in flight, then ask an
   unrelated question and confirm the new conversation contains nothing but it.
7. **The `llm-api-retry-backoff` overlap is settled before the reviewer is
   written, not after** (RV-18). That feature is uncommitted in the same working
   tree and it changes what `ProviderRegistry.complete()` means. Two things must
   be agreed with its owner: whether `LLMRequest.maxRetries?` ships there (D-25),
   and that `reviewTimeoutMs` is a whole-call budget. §3.5.3's fallback makes the
   tier safe either way, so this is a coordination item and not a blocker — but
   discovering it during implementation would cost a rewrite of `reviewer.ts`'s
   failure path, and AC-36 is the test that makes the disagreement loud.

**Re-review is not required** for the conditions above; they are verifiable from
the implementation's own tests. A second design review *is* warranted only if the
implementer needs to change §3.5.4a — the drain confirmation is the one part of
this document where a "simplification" reopens a P0.

Two items are explicitly accepted as-is and should not be relitigated during
implementation: the five configuration channels (RV-17 — matching `team` /
`todo` beats minimising in isolation), and the residual case in §3.5.4a where a
user steer is queued alongside a stranded block and the reviewer declines to
clear. The second is a deliberate trade: a labelled, logged, rare stale
advisory is a smaller harm than deleting a message the user typed.

Nothing here blocks starting implementation.
