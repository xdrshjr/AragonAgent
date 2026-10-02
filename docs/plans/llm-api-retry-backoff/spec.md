# LLM API Retry & Exponential Backoff — Implementation Specification

> **Document version:** v2 — revised after design review. All P0 and P1 review
> findings are resolved in the body below; see [§0 评审记录](#0-评审记录) for the
> full list and [§16 评审结论](#16-评审结论) for the verdict.
>
> **For the downstream engineer:** use `superpowers:test-driven-development` while implementing this specification, and run `superpowers:verification-before-completion` before handing it off. Every acceptance criterion in §11 is written so it can be turned into a Vitest case before the production line that satisfies it exists.

**Goal:** When a provider API call fails, the agent must **retry at least 10 times with an increasing interval** instead of ending the turn — the same behaviour a user expects from Anthropic's Claude Code. The retry must be *correct* (never retry an abort, never duplicate streamed content, never retry a bad API key), *visible* (one live, self-rewriting line that says what failed, which attempt we are on, and when the next one fires), and *interruptible* (Esc ends the wait instantly).

**Architecture:** One new authority module in `@aragon-agent/core` — `llm/retry.ts` — owns the policy type, the classification predicate, the backoff arithmetic and a single generator `withRetry()` that wraps *any* `AsyncIterableIterator<StreamEvent>`. `ProviderRegistry.stream()` applies it, so all three adapters, the lead agent and every subagent inherit it with **zero call-site changes**. Three new `StreamEvent` variants carry the retry story to whoever is listening; the engine pauses its idle watchdog while a backoff is in flight. The CLI package owns *user intent and presentation* only: a sixth config section, two env vars, two flags, one slash command, one settings row, one transcript card and one status-bar chip.

The wrapper is not quite the whole story, and v1 said it was. A wrapper can only act on failures the transport *reports*, and today a stream that closes cleanly mid-answer reports success — so §4.5a adds one bounded change **inside** the adapters: each tracks its own terminal sentinel and yields an `error` when the SSE ends without it. That is the difference between the mid-stream restart machinery firing and it being unreachable code. Retry inside a subagent also needs one row on the existing team card (§6.10), because a child's events never reach the lead's view.

**Tech stack:** Node.js 18+, TypeScript/ESM, npm workspaces (`packages/core`, `packages/cli`), React + Ink for the TUI, Commander for argv, Vitest for tests.

---

## 0. 评审记录

Design review performed against the tree at `packages/core` / `packages/cli`. Every
claim below was checked against source, not against the v1 document. Severity:
**P0** = the feature ships broken or a headline requirement is unmet;
**P1** = a silent wrong behaviour, an unimplementable instruction, or a load-bearing
factual error; **P2** = clarity, naming, or a disclosed trade-off worth naming.

**P0 and P1 are all resolved in the v2 body.** The "Fix" column names where.

### P0

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| **P0-1** | **The truncated-stream case this design is built around does not exist in these adapters.** All three end their SSE loop by *unconditionally* yielding `done` with whatever accumulated — `anthropic.ts:284-291` ("Stream ended without message_stop — emit done with what we have"), `openai.ts:271-277`, `google.ts:178-182`. A stream closed gracefully mid-answer (proxy idle cut, LB timeout, HTTP/2 GOAWAY, `[DONE]` never arriving) therefore yields `sawDone === true`, and `withRetry` returns **success carrying a truncated answer**. Consequences: §4.5's "ended with neither `done` nor `error`" fallback and AC-9 test a path real adapters cannot reach; R-8's premise is false; and §1/§2/§3.5's headline promise — "a connection that dies forty seconds into a long answer" — is **not delivered**. Only the *throwing* variant (ECONNRESET → the `catch` at `anthropic.ts:292`) was ever covered. | `anthropic.ts:284`, `openai.ts:271`, `google.ts:178` | §2 audit row; §4.5a (new) *terminal-sentinel contract*; §5.5 adapter change; §7.1 file plan; AC-9 rewritten + AC-9b; R-8 rewritten. |
| **P0-2** | **`withRetry`'s control flow is not implementable as written.** §4.5's `decide(...)` consumes `delay` (the budget rule is `now() - firstFailureAt + delay > maxElapsedMs`) and `firstFailureAt`, but the pseudocode assigns **both after** calling `decide`. On the first failure `firstFailureAt` is `undefined`, so the arithmetic is `NaN`, and `NaN > maxElapsedMs` is `false` — **a budget that never triggers**, silently. This is the exact failure class the rest of the document is written to prevent. | §4.5 pseudocode, lines "decide := …" vs. "firstFailureAt ??= now()" | §4.5 control flow rewritten with an explicit assignment order and a typed `decide()` signature; AC-10b added. |
| **P0-3** | **Subagent retries are invisible and their budget composes badly.** (a) `TeamRuntime` reuses the lead's registry (`subagent.ts:281`), so children retry — but their `retry_scheduled` events go to the *child's* `Agent` listeners, never to the lead's `ViewState`. §6.4/§6.5/§6.6 give a child's 3-minute backoff **no card, no chip, no countdown**: the dispatch simply looks hung. (b) `DEFAULT_TEAM_CONFIG.subagentTimeoutMs` is `300_000` — *identical* to `maxElapsedMs`, so a child is killed by its own timeout at or before the moment its retry budget expires, and the user is told "subagent timed out" instead of "provider overloaded". (c) `shouldRetryColdStart` (`maxColdStartRetries: 1`) then replaces the child, which runs a **second** full ladder. §13.1 declares cold-start retry a non-goal but never analyses the composition. | `subagent.ts:281`, `schema.ts:518`, `team/limits.ts:116` | §4.1 `maxElapsedMs` default `300_000` → `240_000`; §5.6 (new) *Team composition*; §6.10 (new) subagent visibility via the existing `SubagentRun` channel; §10 R-14/R-15; AC-33/AC-34. |
| **P0-4** | **`maxRetries: 0` is unreachable from every CLI channel, silently.** §6.1 declares the range `[0, hardMaxRetries]`, §6.9 documents `/retry max 0..20`, §8.2 documents `ARAGON_RETRY_MAX` and `config set retry.maxRetries`. But `clampInt` delegates to `coercePositiveInt`, which returns the **fallback** for `n <= 0` (`schema.ts:1022`) — so `0` becomes `10`. `ARAGON_TEAM_MAX`'s copy-paste source additionally guards `parsed > 0` (`env.ts:154`), dropping `ARAGON_RETRY_MAX=0` on the floor. The document already caught this coercion trap for `multiplier` and missed it for the key that gates the entire feature; no AC covers it (AC-14 exercises the *core* `RetryPolicy`, not the CLI clamp). | `schema.ts:1019-1024`, `schema.ts:318-321`, `env.ts:149-154` | §6.1 `clampIntAllowingZero`; §6.2 env rule; AC-17 extended + AC-17b. |

### P1

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| **P1-1** | **An aborted attempt yields a synthetic `error` event**, contradicting §4.5's own G1 ("an aborted request never forwards a trailing error to a subscriber") and R-1, which both state the opposite as a guarantee. The written flow reaches `if not decision.retry: yield {type:'error'}` for `reason === 'aborted'` too. Through `consumeStream` (`complete()`) that becomes a **thrown, fabricated `network_error` on user Esc** — wrong blame at the one moment the user knows exactly what happened. | §4.5 pseudocode vs. §4.5 G1 / §10 R-1 | §4.5 flow: `aborted` returns without yielding; AC-5 extended. |
| **P1-2** | **`CONTENT_EVENTS` is never defined**, yet it is the single most consequential predicate in the design — it decides the commit point, which decides whether a replay duplicates text on screen. `thinking_start` carries no content; `tool_call_start` carries no *rendered* text but does create a card. An implementer must guess. | §4.5 pseudocode | §4.5a: explicit set + rationale. |
| **P1-3** | **Entry *removal* is a new operation in the reducer and its two invariants are unanalysed.** (a) `appendEntry`'s development-mode assertion enumerates live ids as `[streamingId, teamEntryId, todoEntryId]` (`reducer.ts:461`); omitting `retryEntryId` leaves I-L1-1 unenforced for the one new live card. (b) `Transcript` clamps with a **monotonic** high-water mark (`Transcript.tsx:426`); shrinking `entries` is a case that has never occurred before, and if `highWater > entries.length` the clamp marks *everything* settled — including the still-streaming assistant entry — which is `<Static>` duplication. | `reducer.ts:454-469`, `Transcript.tsx:426-430` | §6.4: `retryEntryId` added to the live list; ordering proof that removal is safe; AC-22 extended. |
| **P1-4** | **The singleton registry diverges from the controller's.** §3.3's coverage table claims `streamLLM` / `completeLLM` are covered by the installed policy. They resolve through `getProviderRegistry()`, which lazily calls `initProviders()` **with no arguments** (`providers/index.ts:127-132`), and the CLI never calls `setProviderRegistry` (`controller.ts:202` builds its own). So those two entry points carry `DEFAULT_RETRY_POLICY` and are **unaffected by `/retry off`, `--no-retry` and `ARAGON_RETRY=0`**. | `providers/index.ts:106-167`, `controller.ts:202` | §3.3 table corrected; §5.3 note. |
| **P1-5** | **The named motivating failure — a half-open connection — is still not covered, and the document implies it is.** §1 sells "one dropped TLS connection on a hotel Wi-Fi". A socket that dies *without* FIN or RST produces no event, no error and no close. `AgentConfig.timeouts.llmCallTimeout` is defaulted, stored and plumbed into `AgentLoopContext` (`agent.ts:148/403`, `agent-loop.ts:63`) but **never read anywhere** — a dead knob. The only backstop is the idle watchdog, which *aborts the run* rather than retrying. A per-attempt inter-event stall timer is not a safe fix here either: Anthropic's `ping` frames are swallowed by the adapter's `default: break` (`anthropic.ts:278-280`), so a long thinking pause is indistinguishable from a dead socket at the `StreamEvent` layer. | `agent.ts:148`, `agent-loop.ts:63`, `anthropic.ts:278-280` | §1/§2 claims corrected; audit row added; §13.7 non-goal with the `ping` reason. |
| **P1-6** | **`RETRY_LIMITS` is not enforced at the layer that declares it.** §4.1 says the limits "describe what the mechanism can physically do, and a hand-edited config must not be able to exceed them" — but only `computeBackoffDelay` applies `absoluteMaxDelayMs`. Nothing in core clamps `maxRetries` against `hardMaxRetries` or `maxElapsedMs` against anything; the only clamp lives in the CLI's `clampRetryConfig`. An embedder passing `{maxRetries: 5000}` gets 5000 — and hardening one path while leaving the other open is precisely the mistake §6.1 warns about, one layer up. | §4.1 vs. §4.3/§4.5 | §4.5: `normalizePolicy()` at generator entry; AC-14b. |
| **P1-7** | **Factual error about `runStart`.** §6.4 states "`submit` / `runStart` clear `retryEntryId` alongside `streamingId`". `runStart` (`reducer.ts:504-511`) clears **neither** `streamingId` nor `todoEntryId`; only `submit` does (`reducer.ts:493/497`). Following the sentence as written would change `runStart`'s semantics for two unrelated live cards. | `reducer.ts:486-511` | §6.4 corrected. |
| **P1-8** | **No settle rule covers `runEnd`, so R-10 reproduces *in-session*.** The settle list is `turnEnd` / `notice(error)` / `abortMark`. A run ended by the engine's **own** idle watchdog calls `Agent.abort()` internally (`agent.ts:165-168`); the UI dispatches `abortMark` only from the Esc handler (`App.tsx:1166`), so that path reaches `runEnd` with `retryEntryId` still set and a card frozen at `phase: 'waiting'`. The card then never settles, `Transcript`'s monotonic boundary never advances past it, and the tail re-renders every frame for the rest of the session — the exact failure R-10 claims to have closed, minus the reload. | `agent.ts:165-168`, `App.tsx:1166`, `reducer.ts:652` | §6.4: `runEnd` added as the terminal settle point; R-10 extended; AC-25b. |

### P2 (recorded, not blocking)

| # | Finding | Disposition |
| --- | --- | --- |
| **P2-1** | `Retry-After` never reaches the **in-stream** Anthropic error path (`anthropic.ts:262-276` has no headers). §5.5 discloses this, but that path is exactly where `rate_limit` / `overloaded` arrive on a streaming connection — i.e. the case most likely to need the header. | Accepted; noted in §5.5. Anthropic's in-stream errors are rare relative to HTTP-status errors, and the ladder alone is a safe fallback. |
| **P2-2** | The idiomatic abortable sleep is `import { setTimeout } from 'node:timers/promises'` — **banned** in core `src/` by `no-host-coupling.test.ts` rule 2 (one grandfathered exception: `google.ts` / `node:crypto`). AC-30 would fail loudly, not silently. | Warned in §4.5 G2. Use the global `setTimeout` + an `abort` listener. |
| **P2-3** | `transcript-text.ts` has `default: return []` and **no** `case 'todo'` — the todo feature deliberately declined a plain-text row. Listing `transcript-text.ts` as a required modify (§7.2) presents a choice as an obligation. | Kept as a modify; a retry that cost three minutes belongs in an exported transcript. Rationale added to §7.2. |
| **P2-4** | `RETRY_LIMITS_UI` (CLI, §6.6) reads as a sibling of core's `RETRY_LIMITS` but is unrelated (one is mechanism bounds, the other a column breakpoint). | Renamed `RETRY_UI` in §6.6 / §7.2. |
| **P2-5** | §4.1's ladder table is pre-jitter but is presented next to the user-visible countdown discussion; a reader can take `1 2 4 8 16 30 …` for what the card will show. | Caption added in §4.1. |
| **P2-6** | A mid-stream restart discards output tokens the user was billed for, and R-6's "we do not fabricate usage" leaves that spend entirely unaccounted beyond a retry count. | Named as a non-goal (§13.8) with the follow-up (`/cost` discarded-attempt line). |
| **P2-7** | `parseRetryAfterMs` reads `anthropic-ratelimit-requests-reset` but not `anthropic-ratelimit-input-tokens-reset`; on long contexts the **token** limit is the one that bites. | Added to the §4.4 read order. |

---

## 1. Overview

The engine today has *no* retry on the request path. `runAgentLoop` consumes the provider stream and, the moment an `error` event arrives, throws (`agent-loop.ts:175-177`). `Agent.runLoopWithLifecycle` catches that throw, prints `console.error('[Agent] loop error:', err)` and emits `agent_end` (`agent.ts:408-425`). The user sees one red notice and an idle prompt. A single HTTP 429 from a rate limiter, a single 529 while Anthropic is overloaded, one dropped TLS connection on a hotel Wi-Fi, one 503 from a proxy — each of those ends a turn that would have succeeded on the next attempt one second later. On a long agentic run that has already spent five minutes and forty tool calls, ending the turn is not a minor inconvenience; it is the whole run.

Two narrow retries do exist and neither is the one that is missing. `sendWithOutputLimitRecovery` (`llm/output-limit-recovery.ts`) is a *one-shot, structurally non-looping* repair for HTTP 400s that are specifically about the output-token cap — its own header says "Exactly one retry, structurally … A recovery loop doubles every user's bill", and it deliberately inspects **only** status 400. `shouldRetryColdStart` (`cli/src/team/retry.ts`) replaces a *subagent* that produced literally nothing, once, and is not reachable from the lead agent at all. Between them there is no coverage for the transport failures that actually dominate: 429, 529, 5xx, DNS, TLS, connection reset, and an SSE stream that stops mid-answer.

**What this design does and does not reach (review P0-1 / P1-5).** A failure is retryable here only if it *arrives as an event*. Three shapes do:

- an HTTP status before the stream opens (429 / 529 / 5xx / 401 / 400) — an `error` event from the `!response.ok` branch;
- a `fetch` or reader **throw** mid-stream (ECONNRESET, TLS teardown, socket hang-up, DNS) — an `error` event from the adapter's `catch`;
- a graceful mid-answer close — **today a `done` event**, and §4.5a is what turns it into an `error`.

One shape does **not**, and this document previously implied it did: a **half-open connection** — a socket that stops delivering bytes without FIN or RST, which is the literal "hotel Wi-Fi" case named above. It produces no event at all, so `withRetry` never wakes. `AgentConfig.timeouts.llmCallTimeout` looks like the answer and is not: it is defaulted, stored, and plumbed into `AgentLoopContext` (`agent.ts:148/403`, `agent-loop.ts:63`) and **never read**. The only thing that fires is the idle watchdog, which aborts the run instead of retrying it. §13.7 records why a stall timer is not a safe drop-in fix at this layer and what closing it would actually take.

So this design adds the missing layer and puts it in exactly one place. `withRetry()` sits between `ProviderRegistry` and the adapter, sees the whole event stream, and can therefore do the three things a per-adapter retry could not: it knows whether any content has already been forwarded downstream (the *commit point*, which decides whether a replay would duplicate text on the user's screen); it knows the `AbortSignal`, which is what keeps a user pressing Esc from being mistaken for a retryable timeout; and it can emit its own events, which is what turns a silent 40-second stall into a countdown the user can read. The defaults — 10 retries, 1 s → 2 s → 4 s → 8 s → 16 s → 30 s … with equal jitter, a 30 s ceiling per wait and a 5-minute overall budget — satisfy the requirement's literal text while keeping the worst case bounded and the wait always shorter than the engine's idle window.

---

## 2. Current-state audit

Everything below is present in the tree at the time of writing and is the input to this design.

| Fact | Location | Consequence |
| --- | --- | --- |
| A provider `error` event throws and ends the turn | `core/llm/../engine/agent-loop.ts:175-177` | One transient 429 kills a run; nothing retries. |
| The throw is swallowed into a `console.error` | `core/engine/agent.ts:408-410` | The engine has no error channel of its own; the CLI reconstructs one. |
| All three adapters share one error shape: `yield { type:'error', error }` then `return` | `anthropic.ts:90/96/101/274/293`, `openai.ts:140/146/151/279`, `google.ts:85/91/96/184` | A single wrapper around the iterator covers every provider. |
| **All three adapters end their SSE loop by *unconditionally* yielding `done`** with whatever accumulated, whether or not the terminal sentinel arrived | `anthropic.ts:284-291` ("Stream ended without message_stop — emit done with what we have"), `openai.ts:271-277`, `google.ts:178-182` | **P0-1.** A gracefully-closed mid-answer stream is indistinguishable from success. A wrapper alone cannot fix this — the adapters must report truncation (§4.5a / §5.5). |
| `parseSSEStream` `break`s on `signal.aborted` rather than throwing | `stream-utils.ts:52` | On user abort the adapter therefore falls through to the same unconditional `done`, carrying partial content. `withRetry` must treat that as "no retry" (it is a `done`), and `agent-loop.ts:167` already discards it. |
| `AgentConfig.timeouts.llmCallTimeout` is defaulted, stored, plumbed — and never read | `agent.ts:57/127/148/403`, `agent-loop.ts:63` | **P1-5.** There is no per-call timeout anywhere. A half-open socket is caught only by the idle watchdog, which aborts instead of retrying. |
| `coercePositiveInt` returns the fallback for `n <= 0` | `schema.ts:1019-1024` | **P0-4.** `clampInt` inherits it, so a config range whose floor is `0` cannot express `0`. `maxRetries` needs its own coercion (§6.1). |
| `TeamRuntime` reuses the lead's registry instance; `subagentTimeoutMs` defaults to `300_000`; `maxColdStartRetries` is `1` | `subagent.ts:281`, `schema.ts:518`, `team/limits.ts:116` | **P0-3.** Children inherit the retry policy but not the UI; and a per-child timeout equal to `maxElapsedMs` truncates the ladder (§5.6). |
| `appendEntry`'s dev-mode live-entry assertion enumerates exactly three ids | `reducer.ts:461` | **P1-3.** A fourth live card must join that list or I-L1-1 stops covering it. |
| `getProviderRegistry()` lazily builds the singleton with `initProviders()` and the CLI never installs its own | `providers/index.ts:127-132`, `controller.ts:202` | **P1-4.** `streamLLM`/`completeLLM` get the product default policy, not the user's. |
| `LLMError.retryable` already exists and is already correct per status | `core/llm/provider.ts:128-198` | The classification work is largely done; nothing consumes it on the main path. |
| `wrapFetchError` maps `AbortError` → `errorType:'timeout', retryable:true` | `provider.ts:208-214` | **Every user abort looks retryable.** `team/retry.ts` documents this trap at length; the new wrapper must not fall into it. |
| `classifyHttpError` drops response headers | `provider.ts:146-198` | `Retry-After` is unavailable to any consumer. 408 currently lands in `unknown`/non-retryable. |
| `ProviderRegistry.complete()` calls `provider.complete()`, bypassing `registry.stream()` | `providers/index.ts:56-59` | A wrapper installed only on `stream()` would silently skip `completeLLM`. All three adapters' `complete()` are byte-identically `consumeStream(this.stream(request))`. |
| `IdleWatchdog` aborts the run after `idleTimeout` with no events | `engine/watchdog.ts`, `agent.ts:165-168` | Core default 60 s (CLI passes 210 s). A silent 30 s backoff eats half the core default. |
| `IdleWatchdog.pause()/resume()` already exist and are idempotent; `pause()` swallows `kick()`; `stop()` clears `paused` | `watchdog.ts:40-63` | The engine already has the exact primitive a backoff needs, built for the plan-review wait. |
| `reduceStreamEvent` has `default: return []` | `cli/agent/reducer.ts:398` | New `StreamEvent` variants are forward-compatible: an un-taught CLI ignores them silently rather than crashing. |
| `Transcript`'s settled boundary is **monotonic**; `team.active` / `todo.live` cards are normalized away on load | `ui/Transcript.tsx:88/94`, `session/persist.ts:94-107` | Any new "live" card kind must join that normalization or it re-renders every frame forever. |
| Config has five nested sections, all scalars-only, hand-merged in **two** places in `store.ts` | `config/schema.ts`, `store.ts:147-155/195-208` | A sixth section is mechanical, and omitting either merge is a documented silent-failure mode. |
| The status bar's left cluster is `flexShrink={0}` and already carries `agents n/m` with a `statusCompactCols` degrade | `ui/StatusBar.tsx:77-92/197-204` | There is an established precedent for a transient run-state chip. |
| Core's public runtime surface is frozen at 75 exports | `core/__tests__/public-api.test.ts:124` | Any new export is a three-sync change (barrel + test + `API.md`/`CHANGELOG.md`). |

---

## 3. Approaches considered

### 3.1 Retry inside each adapter — rejected

Put a loop around `fetch` in `anthropic.ts` / `openai.ts` / `google.ts`. Three copies of the same policy, three places to forget the abort check, and — decisively — an adapter cannot see whether the *consumer* has already rendered a token, so it cannot make the commit-point decision that keeps a replay from duplicating text on screen. It also cannot emit anything the UI can render without inventing a per-adapter channel.

### 3.2 Retry in `runAgentLoop` — rejected

The loop would have to re-issue `providerRegistry.stream(...)` itself. That entangles retry state with the steering checkpoints, the tool-call fan-out and the CodeAct branch, all of which already share one `while` body; and it leaves `completeLLM` and any non-engine embedder unprotected.

### 3.3 A generator wrapper applied at `ProviderRegistry` — **selected**

`withRetry(makeStream, opts)` is an async generator that consumes an attempt, forwards its events, and on a retryable terminal `error` re-invokes `makeStream()`. Installing it in `ProviderRegistry.stream()` covers:

```
Agent.prompt -> runAgentLoop -> ctx.providerRegistry.stream(...)   [covered, user policy]
TeamRuntime  -> subagent Agent (same registry instance)            [covered, user policy]
completeLLM(providerId, req)   (after §5.4 re-routes complete)     [covered, DEFAULT only]
streamLLM(providerId, req)                                         [covered, DEFAULT only]
new AnthropicProvider().stream(req)   (raw adapter, by design)     [not covered]
```

**"DEFAULT only" is a real distinction, not a hedge (review P1-4).** `streamLLM` and
`completeLLM` resolve through `getProviderRegistry()`, which lazily builds the
singleton with `initProviders()` and **no arguments** (`providers/index.ts:127-132`).
The CLI builds its own registry at `controller.ts:202` and never calls
`setProviderRegistry`, so those two helpers carry `DEFAULT_RETRY_POLICY` and are
**not** affected by `/retry off`, `--no-retry` or `ARAGON_RETRY=0`. This is
acceptable today because the CLI has zero call sites for either helper — but it is
a divergence an embedder can trip over, so §5.3 states it where the constructor is
described, and it is the reason `setRetryPolicy()` exists as a public method rather
than being a constructor-only concern.

The last line is correct layering, not a gap: the adapter is the *transport*, the registry is the *policy*. An embedder who reaches past the registry has opted out.

### 3.4 Where the policy lives: core, not CLI — decided

Retry is a property of the provider protocol, not of a terminal UI. `no-host-coupling.test.ts` forbids core from importing anything host-shaped, and the CLI is not core's only consumer. Core owns the numbers, the classification and the arithmetic; the CLI owns the user's intent (config/env/flags/slash command) and the pixels.

### 3.5 Mid-stream restart: supported, guarded — decided

The cheap design retries only *before* any content event has been forwarded. That covers the HTTP-layer failures (429/529/5xx/DNS/TLS/connect), which is most of them. But the single most infuriating real-world failure is a connection that dies **forty seconds into a long answer**, and refusing to retry that would leave the requirement half-met. So mid-stream restart is supported, gated by `RetryPolicy.onPartialStream` (default `true`), and made safe by an explicit `stream_restart` event that tells the consumer exactly what to discard.

This is safe *because the engine state is still clean*: `messageManager.push(assistantMessage)` only runs on `done` (`agent-loop.ts:189`), and tool execution only starts after that. A discarded attempt has therefore written nothing to history and executed nothing. Only the **view** is dirty, and only the view needs rewinding.

---

## 4. Technical design — core

### 4.1 The authority module — `packages/core/src/llm/retry.ts` (new)

```ts
/**
 * Structural bounds. NOT user policy: these describe what the mechanism can
 * physically do, and a hand-edited config must not be able to exceed them.
 * (Same split `TEAM_LIMITS` states for team mode.)
 */
export const RETRY_LIMITS = {
  /** Ceiling on `maxRetries` from any layer. */
  hardMaxRetries: 20,
  /** Ceiling on one wait, whatever the config or a `Retry-After` header says. */
  absoluteMaxDelayMs: 120_000,
  /**
   * A `Retry-After` LARGER than this is not honoured and not retried — it is
   * surfaced immediately with the provider's own number in the message. A
   * provider asking us to come back in an hour is telling the user something,
   * and silently wedging the terminal for an hour is not relaying it.
   */
  retryAfterCeilingMs: 60_000,
  /** Floor under any computed wait, so jitter can never produce a 0 ms "retry". */
  minDelayMs: 100,
} as const;

export interface RetryPolicy {
  /** Retries AFTER the initial attempt. `10` => up to 11 total requests. */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Growth factor per retry. `2` doubles. */
  multiplier: number;
  /** Equal jitter (`d/2 + rand*d/2`). See §4.3 for why not full jitter. */
  jitter: boolean;
  /** Honour `Retry-After` / `anthropic-ratelimit-*-reset` when present. */
  respectRetryAfter: boolean;
  /** Wall-clock budget from the FIRST failure of this request. */
  maxElapsedMs: number;
  /** Allow a restart after content has already been forwarded (§3.5). */
  onPartialStream: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,
  respectRetryAfter: true,
  /**
   * 240 s, NOT 300 s (review P0-3). `DEFAULT_TEAM_CONFIG.subagentTimeoutMs` is
   * 300 000 (`schema.ts:518`), and a retry budget EQUAL to the per-child timeout
   * means the child is killed at the same instant its ladder ends — the user is
   * then told "subagent timed out" for what was a provider outage. 240 s fits the
   * full ten-step ladder (181 s worst case) with 59 s of headroom and still
   * leaves the child 60 s of its own window to actually produce an answer.
   * See §5.6 for the whole composition.
   */
  maxElapsedMs: 240_000,
  onPartialStream: true,
};
```

**Why `maxDelayMs: 30_000`.** Core's default `idleTimeout` is 60 000 ms. Even with the watchdog pause of §4.6 in place, a single wait longer than half the idle window is a design smell: it means the mechanism depends on the pause being correct rather than merely benefiting from it. Two independent guards, and the numeric one costs nothing.

**The resulting ladder** (`maxRetries: 10`) — *these are the pre-jitter base delays, i.e. the ceiling of each wait, not the number the countdown will show (review P2-5). Under equal jitter the card shows something in `[d/2, d]`, always computed from the actual chosen delay (§4.3):*

```
retry #  1   2   3   4    5    6    7    8    9   10     total
wait(s)  1   2   4   8   16   30   30   30   30   30      181
```

181 s worst case, ~136 s expected under equal jitter, comfortably inside the 240 s `maxElapsedMs`. The requirement's "at least 10, increasing interval" is met literally — and it is met *under the budget*, which is the property that matters: the budget must never be what stops the tenth retry, or the headline number becomes a lie. The ladder is legible enough that a user watching the countdown can predict the next one.

### 4.2 Classification — `isRetryableError`

```ts
export interface RetryDecision {
  retry: boolean;
  /** Machine reason, for logs and for the acceptance tests. */
  reason:
    | 'retryable'
    | 'aborted'
    | 'not_retryable'
    | 'budget_exhausted'
    | 'attempts_exhausted'
    | 'committed'
    | 'retry_after_too_long';
}
```

`isRetryableError(err, signal)` returns `false` when **any** of these hold, checked *in this order*:

1. **`signal?.aborted === true`.** THE P0 CHECK, AND IT MUST COME FIRST. `wrapFetchError` classifies an `AbortError` as `errorType:'timeout', retryable:true` (`provider.ts:208-214`), so every user Esc, every `AgentController.abort()`, every dispatch timeout and every tool-timeout cancellation arrives here wearing a retryable badge. `team/retry.ts` records this trap in thirty lines of comment because it cost someone an afternoon; this module must not re-learn it. Reading `signal.aborted` **before** `err.retryable` is what makes Esc mean Esc.
2. The error's `retryable` field is not `true`. Read **structurally** (`(err as {retryable?: unknown})?.retryable === true`), never with `instanceof LLMError` — the error crosses a package boundary and a duplicated core instance (a linked checkout, a hoisting accident) would make `instanceof` false while the field is plainly there, and the failure mode would be "retries silently stopped happening". This is the same rule `isRetryableStreamError` and `formatStreamError` already follow.

The resulting matrix, derived from `classifyHttpError`:

| `errorType` | HTTP | Retried | Why |
| --- | --- | --- | --- |
| `rate_limit` | 429 | **yes** | The canonical case. `Retry-After` honoured. |
| `overloaded` | 529 | **yes** | Anthropic's "come back shortly". |
| `server_error` | 5xx | **yes** | 500/502/503/504 are transient by definition. |
| `network_error` | — | **yes** | DNS, TLS, ECONNRESET, socket hang-up. |
| `timeout` | 408 | **yes** | *Unless the signal is aborted* — see check 1. |
| `auth_error` | 401/403 | no | Ten retries of a bad key is three minutes of looking broken. |
| `invalid_request` | 400 | no | Already owned by `sendWithOutputLimitRecovery`. |
| `context_overflow` | 400 | no | Deterministic; a replay fails identically. |
| `unknown` | other 4xx | no | Conservative default. |

**One change to `classifyHttpError`:** status `408` currently falls into `default` → `unknown` / non-retryable. It becomes `errorType: 'timeout', retryable: true`. Nothing else in the switch moves.

### 4.3 Backoff arithmetic — `computeBackoffDelay`

```ts
export function computeBackoffDelay(
  retryIndex: number,            // 1-based: the FIRST retry is 1
  policy: RetryPolicy,
  opts?: { retryAfterMs?: number; random?: () => number },
): number {
  const rand = opts?.random ?? Math.random;
  const raw = policy.initialDelayMs * Math.pow(policy.multiplier, retryIndex - 1);
  const base = Math.min(raw, policy.maxDelayMs, RETRY_LIMITS.absoluteMaxDelayMs);
  const jittered = policy.jitter ? base / 2 + rand() * (base / 2) : base;

  // MAX, not replace. A `Retry-After: 1` arriving on the ninth retry must not
  // undo eight retries' worth of backoff — the server is stating a FLOOR
  // ("not before this"), not a ceiling.
  const withHeader =
    policy.respectRetryAfter && opts?.retryAfterMs !== undefined
      ? Math.max(jittered, opts.retryAfterMs)
      : jittered;

  return Math.round(
    Math.min(Math.max(withHeader, RETRY_LIMITS.minDelayMs), RETRY_LIMITS.absoluteMaxDelayMs),
  );
}
```

**Equal jitter, not full jitter.** Full jitter (`rand() * base`) is the textbook contention minimiser, but it can return 40 ms on the sixth retry, and a UI that just announced "retrying in 30s" and then fires in 40 ms reads as a bug. Equal jitter keeps the announced number within a factor of two of the truth while still de-correlating N concurrent subagents hitting the same 429. The user-visible countdown is computed from the *actual* chosen delay, never from `base`, so what the card says is always what happens.

### 4.4 `Retry-After` parsing — `parseRetryAfterMs`

```ts
export function parseRetryAfterMs(
  headers: Headers | undefined,
  now: () => number = Date.now,
): number | undefined
```

Reads, in order: `retry-after` (integer seconds, or an HTTP-date → `date - now`), then `x-ratelimit-reset-after` (seconds, OpenAI-flavoured), then `anthropic-ratelimit-requests-reset`, then `anthropic-ratelimit-input-tokens-reset` (both RFC-3339 instants → `date - now`). The token header is fourth rather than absent because on a long context it is the limit that actually bites, and a request throttled on tokens that waits out only the *request* window comes back to the same 429 (review P2-7). Returns `undefined` when absent or unparseable, and never returns a negative number. A value above `RETRY_LIMITS.retryAfterCeilingMs` is returned **as-is** — the *caller* (`withRetry`) is what decides to stop, so the honest number reaches the user's error message.

The value rides on the error: `LLMError` gains a 7th optional positional field `retryAfterMs?: number`, and `classifyHttpError` gains an optional 4th parameter `headers?: Headers`. Both are additive; every existing call site compiles unchanged.

### 4.5 The wrapper — `withRetry`

```ts
export interface WithRetryOptions {
  policy: RetryPolicy;
  providerId: string;
  modelId: string;
  signal?: AbortSignal;
  /** All three injected so tests are deterministic and never sleep. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export async function* withRetry(
  makeStream: () => AsyncIterableIterator<StreamEvent>,
  opts: WithRetryOptions,
): AsyncIterableIterator<StreamEvent>;
```

Per-attempt bookkeeping and the exact control flow. **The assignment order below is
normative** — v1 called `decide()` before assigning the two values `decide()` reads,
which is both unimplementable and, taken literally, a budget check that evaluates to
`NaN` and therefore never fires (review P0-2).

```
policy         := normalizePolicy(opts.policy)   # (G4) clamp to RETRY_LIMITS, once
firstFailureAt := undefined
retryIndex     := 0                              # retries COMPLETED so far

loop forever:
  committed          := false     # any content event forwarded this attempt
  toolCallIds        := []        # tool_call_start ids forwarded this attempt
  sawDone            := false
  terminalError      := undefined

  for each event of makeStream():
     if signal.aborted: return                      # (G1) match agent-loop's own guard
     if event.type in CONTENT_EVENTS: committed = true
     if event.type == 'tool_call_start': toolCallIds.push(event.toolCallId)
     if event.type == 'error':  terminalError = event.error; break   # do NOT forward yet
     if event.type == 'done':   sawDone = true
     yield event

  if sawDone: return                                # success, hot path untouched

  if terminalError is undefined:
     # Defensive only: with §4.5a in place every adapter terminates in `done` or
     # `error`. Reaching here means an adapter broke its own contract.
     terminalError = new LLMError(
        'LLM stream ended without producing a done or error event',
        providerId, 'network_error', true)

  # ---- ORDER IS NORMATIVE FROM HERE (P0-2) --------------------------------
  # 1. Anchor the budget clock on the FIRST failure, before anything reads it.
  firstFailureAt ??= now()
  # 2. Derive the candidate wait for the NEXT attempt. `retryIndex + 1` because
  #    computeBackoffDelay is 1-based and retryIndex counts COMPLETED retries.
  retryAfterMs := policy.respectRetryAfter ? terminalError.retryAfterMs : undefined
  candidateDelay := computeBackoffDelay(retryIndex + 1, policy,
                                        { retryAfterMs, random })
  # 3. Only now can `decide` answer the budget question.
  decision := decide({ error: terminalError, signal, committed, retryIndex,
                       firstFailureAt, candidateDelay, retryAfterMs, policy, now })

  if decision.reason == 'aborted':
     return                                        # (G3) NO trailing error event

  if not decision.retry:
     yield { type:'error', error: terminalError }   # byte-identical to today
     return

  retryIndex += 1
  delay := candidateDelay                           # what we announce IS what we wait

  if committed:
     yield { type:'stream_restart', attempt: retryIndex, discardedToolCallIds: toolCallIds }
  yield { type:'retry_scheduled', attempt: retryIndex, maxRetries: policy.maxRetries,
          delayMs: delay, resumeAt: now() + delay, errorType, message, retryAfterMs }
  await sleep(delay, signal)                        # (G2) abortable
  if signal.aborted: return                         # (G3) again: silent
  yield { type:'retry_attempt', attempt: retryIndex, maxRetries: policy.maxRetries }
```

`decide(...)` takes every input explicitly — no closure reads — and returns the first
matching reason:

| Order | `reason` | Condition |
| --- | --- | --- |
| 1 | `aborted` | `signal?.aborted === true` (§4.2 check 1) |
| 2 | `not_retryable` | `(error as {retryable?: unknown})?.retryable !== true` |
| 3 | `committed` | `committed && !policy.onPartialStream` |
| 4 | `attempts_exhausted` | `retryIndex >= policy.maxRetries` — pre-increment, so `maxRetries: 10` permits retries at `retryIndex` 0…9 and stops the 11th failure |
| 5 | `budget_exhausted` | `now() - firstFailureAt + candidateDelay > policy.maxElapsedMs` — `firstFailureAt` is a number by construction (step 1) |
| 6 | `retry_after_too_long` | `retryAfterMs !== undefined && retryAfterMs > RETRY_LIMITS.retryAfterCeilingMs` |
| 7 | `retryable` | otherwise |

Six properties that are load-bearing and easy to break:

- **G1 — the abort guard is checked on every iteration**, matching `agent-loop.ts:167`. Combined with the same guard in the loop, an aborted request never forwards a trailing error to a subscriber, which is precisely the fifth "defence in depth" guard `team/retry.ts` describes from the other side of the boundary.
- **G2 — `sleep` must observe `signal`.** A bare `setTimeout` would make Esc take up to 30 s to be felt, which is the single most visible way this feature can be made to feel cheap. The default implementation resolves on either the timer or the signal's `abort` event, and removes its listener in a `finally`. **Do not reach for `node:timers/promises`** (whose `setTimeout` takes `{signal}` natively): `no-host-coupling.test.ts` rule 2 bans every `node:*` import under core `src/` with exactly one grandfathered exception, and AC-30 will fail (review P2-2). The global `setTimeout` plus one `abort` listener is the whole implementation.
- **G3 — `aborted` returns SILENTLY.** It is the one non-retry reason that must not `yield` an `error`, and v1's flow yielded one, contradicting G1 and R-1 (review P1-1). It matters concretely: `consumeStream` — the body of `complete()` after §5.4 — does not consult the signal, so a yielded error becomes a **thrown, fabricated `network_error` on user Esc**. Blaming the network for something the user just did is worse than saying nothing. Two return sites (the `decide` short-circuit and the post-sleep check) plus G1's in-loop guard; all three are silent.
- **G4 — `normalizePolicy` runs once, at generator entry.** `RETRY_LIMITS` claims in §4.1 to bound "what the mechanism can physically do", but v1 enforced only `absoluteMaxDelayMs`, and only inside `computeBackoffDelay`; `maxRetries` and `maxElapsedMs` were bounded solely by the CLI's `clampRetryConfig`, so an embedder passing `{maxRetries: 5000}` got 5000 (review P1-6). Hardening one path and leaving the other open is the mistake §6.1 warns about, one layer up. `normalizePolicy` clamps `maxRetries` to `[0, RETRY_LIMITS.hardMaxRetries]`, `maxDelayMs` to `[RETRY_LIMITS.minDelayMs, RETRY_LIMITS.absoluteMaxDelayMs]`, `initialDelayMs` to `<= maxDelayMs`, `multiplier` to `>= 1`, and `maxElapsedMs` to `>= initialDelayMs`. It is pure, total, and never throws — a bad policy is corrected, not rejected, because the alternative is a library that crashes on a config typo.
- **The success path is untouched.** A request that works yields exactly the events the adapter produced, in the same order, with no extra allocation beyond one boolean and one empty array. `withRetry` is not installed at all when `maxRetries <= 0` (§5.4), so an opted-out embedder is byte-identical to today.
- **The terminal error is forwarded, not replaced.** After exhaustion the consumer sees the *provider's own* `LLMError`, so `formatStreamError`, the `retryable` field and any downstream `instanceof` continue to behave. Only the retry *count* is new information, and it travels on the events, not on the error.

### 4.5a The commit point, and the terminal-sentinel contract

Two definitions v1 left implicit. Both are load-bearing.

**`CONTENT_EVENTS` (review P1-2).** The commit point decides whether a replay would
duplicate text on the user's screen, so the set is exactly *"events the consumer has
already rendered as answer content"*:

```ts
const CONTENT_EVENTS: ReadonlySet<StreamEvent['type']> = new Set([
  'text_delta', 'thinking_start', 'thinking_delta',
  'tool_call_start', 'tool_call_delta', 'tool_call_end',
]);
```

`thinking_start` is in the set even though it carries no text: it flips
`thinkingOpen` in the reducer (`reducer.ts:526-533`), which is visible state that a
restart must rewind. The tool events are in the set because `tool_call_start` appends
a transcript card (`reducer.ts:560-571`) — that is why `stream_restart` carries
`discardedToolCallIds` at all. `done` and `error` are terminal, not content; the
three `retry_*` variants are ours and never round-trip through `makeStream()`.

**The terminal-sentinel contract (review P0-1) — this is an ADAPTER change, not a
wrapper change.** v1 assumed a truncated SSE reaches `withRetry` as "an iterator that
ended with neither `done` nor `error`". No adapter can produce that: all three end
their loop by unconditionally yielding `done` with whatever accumulated
(`anthropic.ts:284-291`, `openai.ts:271-277`, `google.ts:178-182`). A stream closed
gracefully mid-answer — a proxy idle cut, a load-balancer timeout, an HTTP/2 GOAWAY,
`[DONE]` never arriving — therefore surfaces as **success carrying a truncated
answer**, and no wrapper installed above the adapter can tell the difference. Left
unfixed, the single failure §3.5 is built to handle is the one failure that silently
does not retry.

So each adapter tracks whether it saw its own terminal sentinel and reports the
truthful terminal event:

| Adapter | Sentinel | On absence |
| --- | --- | --- |
| `anthropic.ts` | the `message_stop` case (it already `return`s from inside the loop, line 259) | the fall-through at 284-291 becomes `yield { type:'error', error: new LLMError('… stream truncated before message_stop', id, 'network_error', true) }` |
| `openai.ts` | the `[DONE]` sentinel (`break` at line 170) | same shape, keyed on a `sawDone` flag set at that `break` |
| `google.ts` | its terminal chunk (`finishReason` present) | same shape |

Three constraints on that change, each of which reverses a plausible shortcut:

1. **Abort is not truncation.** `parseSSEStream` `break`s on `signal.aborted`
   (`stream-utils.ts:52`), which lands on the identical fall-through. The adapter
   must check `request.signal?.aborted` first and keep yielding `done` there — an
   abort is not a provider failure, and turning it into a retryable `network_error`
   re-creates the very trap §4.2 check 1 exists to close.
2. **An empty successful turn is still success.** A model that legitimately emits
   zero content and stops must not be reported as truncated. Anthropic and Google
   are unambiguous (they have explicit terminal frames); the flag is set at the
   frame, never inferred from `contentBlocks.length`.
3. **This changes `complete()`'s failure mode for truncation**, from "an
   `AssistantMessage` with partial content" to "a thrown `LLMError`". That is the
   point — a silently truncated answer is worse than a loud one — but it is a
   behaviour change and belongs in `CHANGELOG.md` next to R-7.

With the contract in place, truncation is retried by the ordinary `network_error`
path, and §3.5's mid-stream restart finally covers the case that motivated it.

### 4.6 Engine integration — the idle watchdog

`Agent.emit` gains one pre-step:

```ts
private emit(event: AgentEvent): void {
  // BEFORE the listeners: a listener that throws must not leave the watchdog
  // armed across a 30-second backoff.
  this.applyRetryWatchdogPolicy(event);
  for (const listener of this.listeners) { ... }
  this.watchdog.kick();          // a no-op while paused (watchdog.ts:22)
}

private applyRetryWatchdogPolicy(event: AgentEvent): void {
  if (event.type !== 'message_update') return;
  const t = event.streamEvent.type;
  if (t === 'retry_scheduled') this.watchdog.pause();
  else if (t === 'retry_attempt') this.watchdog.resume();
}
```

`pause()` swallows the subsequent `kick()` by design, and `resume()` restarts the window from now — both already documented as idempotent. The one failure mode worth naming is a `retry_scheduled` never followed by a `retry_attempt` (abort during the wait), which would leave the watchdog deaf; it cannot outlive the run, because `runLoopWithLifecycle`'s `finally` calls `watchdog.stop()`, and `stop()` clears `paused` for exactly this reason (`watchdog.ts:51-63`). **Do not "simplify" that line out of `stop()`.**

### 4.7 New `StreamEvent` variants — `packages/core/src/llm/types.ts`

```ts
/** A retryable failure occurred; the next attempt fires at `resumeAt`. */
export interface RetryScheduledEvent {
  type: 'retry_scheduled';
  attempt: number;            // 1-based retry index
  maxRetries: number;
  delayMs: number;
  resumeAt: number;           // epoch ms — the UI ticks against this, not delayMs
  errorType: LLMErrorType;
  message: string;            // already truncated by classifyHttpError
  retryAfterMs?: number;      // present only when the provider stated one
}

/** The wait is over; attempt `attempt` is going out now. */
export interface RetryAttemptEvent {
  type: 'retry_attempt';
  attempt: number;
  maxRetries: number;
}

/**
 * Content already forwarded this turn is being discarded and replayed.
 * Emitted ONLY when the failed attempt had reached its commit point.
 */
export interface StreamRestartEvent {
  type: 'stream_restart';
  attempt: number;
  discardedToolCallIds: string[];
}
```

Added to the `StreamEvent` union. This is forward-compatible in every existing consumer: `consumeStream` ignores anything that is not `done`/`error`; `agent-loop` forwards everything and reacts only to `done`/`error`; `reduceStreamEvent` has `default: return []`.

`resumeAt` rather than a stream of countdown ticks is a deliberate boundary. A 1 Hz tick from core would be 300 events per exhausted retry sequence, would set core's render cadence for every embedder, and would make the watchdog un-fireable during a backoff for reasons unrelated to §4.6's explicit decision. The consumer owns its own clock.

---

## 5. Technical design — where it is installed

### 5.1 `ProviderRegistry` gains a policy

```ts
export class ProviderRegistry {
  private retryPolicy: RetryPolicy | null;

  constructor(options: { retryPolicy?: RetryPolicy | null } = {}) {
    this.retryPolicy = options.retryPolicy === undefined
      ? DEFAULT_RETRY_POLICY            // ON by default (§10 R-7)
      : options.retryPolicy;            // `null` = explicit opt-out
  }

  setRetryPolicy(policy: RetryPolicy | null): void { this.retryPolicy = policy; }
  getRetryPolicy(): RetryPolicy | null { return this.retryPolicy; }
}
```

`undefined` and `null` mean different things here, exactly as they do for `PersistedConfig.maxTokens`: absent means "the product default", explicit `null` means "the user said no".

### 5.2 `stream()` wraps

```ts
stream(providerId: string, request: LLMRequest): AsyncIterableIterator<StreamEvent> {
  const provider = this.resolveProvider(providerId);
  const policy = this.retryPolicy;
  if (!policy || policy.maxRetries <= 0) return provider.stream(request);   // off-path: identical
  return withRetry(() => provider.stream(request), {
    policy,
    providerId,
    modelId: request.model,
    ...(request.signal ? { signal: request.signal } : {}),
  });
}
```

The thunk re-reads nothing: `request` is captured whole, so every attempt sends the *same* body — including any `max_tokens` that `sendWithOutputLimitRecovery` repaired on the way through, because that repair lives inside `provider.stream()` and re-runs per attempt.

### 5.3 `initProviders` forwards options

`initProviders(options?: { retryPolicy?: RetryPolicy | null })` passes them to the constructor. Frozen-surface impact: none (the export name is unchanged; an added optional parameter is source- and type-compatible).

**The singleton is a separate registry and keeps the product default (review P1-4).**
`getProviderRegistry()` lazily builds it with `initProviders()` and no arguments
(`providers/index.ts:127-132`); the CLI builds its own at `controller.ts:202` and
never calls `setProviderRegistry`. So `streamLLM` / `completeLLM` retry with
`DEFAULT_RETRY_POLICY` and **do not** observe `/retry off`, `--no-retry` or
`ARAGON_RETRY=0`. Harmless today (the CLI has zero call sites for either), and not
worth "fixing" by having the controller mutate global state — a library that
reassigns a process-wide singleton because a TUI changed a setting is a worse
trade. `CHANGELOG.md` states the divergence, and an embedder that wants one policy
everywhere calls `setProviderRegistry(initProviders({ retryPolicy }))` once at
startup.

### 5.4 `complete()` re-routes through `stream()`

```ts
async complete(providerId: string, request: LLMRequest): Promise<AssistantMessage> {
  return consumeStream(this.stream(providerId, request));
}
```

Behaviour-preserving: all three adapters implement `complete` as exactly `consumeStream(this.stream(request))` (`anthropic.ts:301`, `openai.ts:287`, `google.ts:192`). The only difference is that the registry's version is now the retrying one. **This is not optional** — without it `completeLLM` is the one public entry point that silently has no retry, which is exactly the kind of hole that gets discovered in production.

### 5.5 Adapter changes

**(a) Pass headers.** One line each, in the `if (!response.ok)` branch:

```ts
yield { type:'error', error: classifyHttpError(response.status, errorBody, this.id, response.headers) };
```

Anthropic additionally has an in-stream `error` event (`anthropic.ts:262-276`) with
no headers available; it keeps its current construction and simply carries no
`retryAfterMs`. That path is worth naming rather than waving past (review P2-1): it
is where `rate_limit` and `overloaded` arrive once the connection is already open,
which is the case most likely to want a server-stated wait. It falls back to the
plain ladder, which is safe — equal jitter plus a 30 s ceiling is a reasonable
guess — but it means `respectRetryAfter` is honoured on the HTTP-status path only,
and §8.1's description of it should be read that way.

**(b) Report truncation (review P0-1).** Each adapter tracks its own terminal
sentinel and yields an `error` when the SSE ends without it. The full contract,
including the abort exclusion and the "empty turn is still success" rule, is §4.5a.
This is the change that makes §3.5's mid-stream restart reachable at all; without
it a gracefully-closed stream is indistinguishable from a completed one and no
wrapper above the adapter can recover it.

### 5.6 Composition with team mode — budgets and the second ladder

Subagents inherit the policy for free, because `TeamRuntime` reuses the lead's
registry instance (`subagent.ts:281`). That is the design working. What v1 never
did was multiply the numbers out (review P0-3), and three of them collide.

| Knob | Value | Source |
| --- | --- | --- |
| `maxElapsedMs` | 240 000 (was 300 000) | §4.1 |
| `team.subagentTimeoutMs` | 300 000 | `schema.ts:518` |
| `team.dispatchTimeoutMs` | 900 000 | `schema.ts:519` |
| `TEAM_LIMITS.maxColdStartRetries` | 1 | `team/limits.ts:116` |
| `team.maxConcurrent` | 3 | `schema.ts:517` |

**Collision 1 — an equal budget is a hidden truncation.** At v1's 300 000, a child's
retry budget was *identical* to the timeout that kills the child. The ladder could
never complete: whichever timer won, the user was told "subagent timed out" for what
was a provider outage, and the retry story was invisible on the way there. Lowering
`maxElapsedMs` to 240 000 (§4.1) makes the ordering explicit — the full ten-step
ladder is 181 s worst case, the budget ends at 240 s, and the child still has ~60 s
of its own window left to answer. **The invariant is `maxElapsedMs + one model
round-trip < team.subagentTimeoutMs`**; anyone raising `maxElapsedMs` or lowering
`subagentTimeoutMs` must re-check it, and AC-33 pins the inequality so the next
person changing either number is told.

**Collision 2 — the ladders stack.** When a child exhausts its budget,
`shouldRetryColdStart` may still fire: it requires `retryable === true && turns === 0
&& toolCalls === 0 && !truncated`, and a child that never got a response satisfies
all four. With `maxColdStartRetries: 1` that is **one** replacement, and the
replacement runs its own full ladder. Worst case per child is therefore ~2 × 181 s
of backoff inside a 300 s cap, i.e. the second ladder is itself truncated by the
child timeout. This is bounded and acceptable — one replacement is the documented
ceiling and the side-effect proof still holds — but it must be stated, because the
naive reading ("cold-start retry is a non-goal, §13.1") suggests the two mechanisms
do not interact. They do; §13.1 is about *what* is retried, not about composition.

**Collision 3 — concurrency.** Three children retrying the same 429 in lockstep is
R-5, and equal jitter is the answer there. Nothing changes here except the note that
`maxConcurrent: 3` is now also what bounds *retry* fan-out, not just request fan-out.

Visibility is §6.10.

---

## 6. Technical design — CLI

### 6.1 Config — the sixth nested section

`RetryConfig` in `config/schema.ts`, **scalars only, exactly one level deep**, for the reason the `log` / `team` / `todo` section headers already state: `store.ts` merges these by hand and that merge is only correct while nesting stays flat.

```ts
export interface RetryConfig {
  enabled: boolean;            // default true
  maxRetries: number;          // default 10   range [0, RETRY_LIMITS.hardMaxRetries]
  initialDelayMs: number;      // default 1000 range [100, 30_000]
  maxDelayMs: number;          // default 30_000 range [1000, RETRY_LIMITS.absoluteMaxDelayMs]
  multiplier: number;          // default 2    range [1, 5]   ← the only float key
  jitter: boolean;             // default true
  respectRetryAfter: boolean;  // default true
  maxElapsedMs: number;        // default 240_000 range [10_000, 1_800_000]  (§5.6)
  onPartialStream: boolean;    // default true
}
```

`clampRetryConfig(raw)` is THE single gate for every read **and** write, mirroring `clampSkillsConfig` / `clampLogConfig` / `clampTeamConfig` / `clampTodoConfig` — hardening only the read path leaves a bad value on disk that reverts on every launch, which presents to the user as "my setting won't stick". Three invariants inside the gate:

- `maxDelayMs = max(maxDelayMs, initialDelayMs)` — a ceiling under the floor makes the ladder a flat line and the countdown a lie.
- `multiplier` needs a new `clampNumber(v, fallback, range)` helper: `coercePositiveInt` floors, and `2.5` is a legitimate factor. Six lines next to `clampInt`.
- **`maxRetries` needs `clampIntAllowingZero`, and this is the one that ships broken
  without it (review P0-4).** `clampInt` delegates to `coercePositiveInt`, which
  returns the **fallback** for `n <= 0` (`schema.ts:1019-1024`). So
  `clampRetryConfig({ maxRetries: 0 })` yields **10**, silently — and `0` is not a
  hypothetical: it is the documented floor of this key's own range, the value
  `/retry max 0` sends (§6.9), the value `--retry-max 0` and `ARAGON_RETRY_MAX=0`
  send (§6.2), and the value `aragon config set retry.maxRetries 0` sends (§8.2).
  Four documented controls, all of which would set the maximum instead of the
  minimum, with no error anywhere. This is the same coercion trap already caught
  one bullet up for `multiplier`; it was missed on the key that gates the feature.
  `clampIntAllowingZero(v, fallback, range)` is `clampInt` with its own coercion
  (`Number.parseInt`, reject only non-finite and negative, then floor and clamp) —
  six more lines beside it, and AC-17b pins the `0` case in both directions.

  `maxElapsedMs` intentionally keeps plain `clampInt`: its floor is 10 000, so it
  has no `0` to express.

`enabled: false` and `maxRetries: 0` are kept as **separate** keys rather than folded: `enabled` is the user's switch and survives round-tripping through the settings screen, while `maxRetries: 0` is what `toRetryPolicy` produces from it. Folding them would make `/retry off; /retry on` forget the user's chosen count.

`store.ts` gains the sixth section in **both** merges (read at ~line 155, write at ~line 208). Omitting the write merge means `/retry max 5` silently reverts `respectRetryAfter`; omitting the read merge means a user with no `retry` key gets `undefined` and `toRetryPolicy` throws.

### 6.2 Resolution, env, flags

`resolveRetryConfig(flags, env, file)` in `load.ts`, shaped exactly like `resolveTeamConfig`:

```ts
clampRetryConfig({
  ...DEFAULT_CONFIG.retry,
  ...(file.retry ?? {}),
  ...(env.retry ?? {}),
  ...(flags.retry !== undefined ? { enabled: flags.retry } : {}),
  ...(flags.retryMax !== undefined ? { maxRetries: flags.retryMax } : {}),
})
```

`!== undefined` on both, and that is the whole point: commander materialises a lone `--no-retry` as `opts.retry = true` when the flag is absent, so a truthiness check cannot tell `--no-retry` from "not passed". This is the same rule `resolveTeamConfig` and `resolveTodoConfig` each state once.

**Env — two vars only.** `ARAGON_RETRY` (positive list `1|true|on|yes`, matching `ARAGON_TEAM` / `ARAGON_TODO`, **not** `envBool`'s negative list) and `ARAGON_RETRY_MAX` (integer, left *absent* when unparseable so the config file can still win). No env var for the delays: every env var in this file exists because a flag and a config file are *both* unreachable in the channel it serves, and nobody tunes a backoff multiplier from a container entrypoint.

**`ARAGON_RETRY_MAX` accepts `0`; its copy-paste source does not (review P0-4).**
`ARAGON_TEAM_MAX` writes the section only when `Number.isFinite(parsed) && parsed > 0`
(`env.ts:149-154`), which is right for a fan-out width and wrong here — `0` is this
key's documented floor and its kill switch. The guard is `Number.isFinite(parsed) &&
parsed >= 0`. "Left absent when unparseable" still holds and still matters: an
unparseable value must not look permanently supplied, or the config file can never
win again.

**Flags.** `--no-retry` and `--retry-max <n>` on the root command in `cli.tsx`.

`logResolvedConfig` (`load.ts:~597`) gains `retry: config.retry.enabled ? config.retry.maxRetries : 'off'` — four layers feed this and none of them would otherwise leave a trace.

### 6.3 Controller — construction and live update

```ts
this.providerRegistry = initProviders({ retryPolicy: toRetryPolicy(config.retry) });
```

```ts
/** `RetryConfig` (user intent) -> `RetryPolicy` (engine policy). */
export function toRetryPolicy(cfg: RetryConfig): RetryPolicy | null {
  if (!cfg.enabled || cfg.maxRetries <= 0) return null;
  return { maxRetries: cfg.maxRetries, initialDelayMs: cfg.initialDelayMs, ... };
}
```

`AgentController.setRetryConfig(patch)` updates `this.config.retry` and calls `this.providerRegistry.setRetryPolicy(toRetryPolicy(...))`. **This live-update call is required, not a nicety.** Without it `/retry off` would persist correctly and change nothing until the next launch — the precise failure `config/schema.ts` warns about twice already, and the one a user reports as "the setting does nothing".

Subagents inherit automatically: `TeamRuntime` reuses the lead's registry instance (`subagent.ts:279-281`).

### 6.4 View model — the retry card

A new `Entry` kind, JSON-serialisable by construction so `/save` needs no format change:

```ts
| {
    id: string;
    kind: 'retry';
    attempt: number;
    maxRetries: number;
    errorType: string;
    message: string;
    delayMs: number;
    /** Epoch ms the next attempt fires; the UI ticks against this. */
    resumeAt?: number;
    phase: 'waiting' | 'retrying' | 'recovered' | 'exhausted' | 'interrupted';
    startedAt: number;
    /** Filled on settle. */
    totalRetries?: number;
    elapsedMs?: number;
  }
```

**ONE CARD PER TURN, REWRITTEN IN PLACE**, tracked by `ViewState.retryEntryId` — the same discipline `todo` uses and for the same reason: ten retries rendered as ten notices would bury the transcript in the one moment the user most needs it legible.

`ViewState` also gains `retry: RetrySnapshot | null` — the ephemeral projection that drives the status-bar chip, **never persisted** (the settled card is the history), nulled on settle. Same contract as `team`.

Actions and their sources:

| Action | Source | Effect |
| --- | --- | --- |
| `retryScheduled` | `retry_scheduled` stream event | Create or rewrite the card; `phase='waiting'`; set `retry` projection. |
| `retryAttempt` | `retry_attempt` | `phase='retrying'`; clear `resumeAt`. |
| `streamRestart` | `stream_restart` | Reset the streaming assistant entry's `text`/`thinking` to `''`; drop `kind:'tool'` entries whose `toolCallId` is in `discardedToolCallIds`. |
| `retryTick` | CLI 1 Hz timer | No state change; a nonce bump so the countdown re-renders. |

**`retryEntryId` joins `appendEntry`'s live-id list (review P1-3).** The
development-mode assertion at `reducer.ts:461` enumerates `[streamingId,
teamEntryId, todoEntryId]` and exists to make I-L1-1 — "the ring trim must never
drop a live target" — fail loudly instead of silently turning `mapEntry` into a
no-op. A fourth live card that is not in that list is a fourth card the invariant
does not cover.

**Entry *removal* is new, and it is safe for one specific reason.** `streamRestart`
is the first action in this reducer that shrinks `entries`, and `Transcript` clamps
its settled boundary with a **monotonic** high-water mark (`Transcript.tsx:426`):
`settled = min(entries.length, max(highWater, raw))`. If `highWater` ever exceeded
`entries.length`, the clamp would mark *everything* settled — including the
still-streaming assistant entry — and `<Static>` would duplicate it. It cannot, and
the ordering is why: the entries `streamRestart` removes are `kind:'tool'` cards
created by `toolCallStart` **after** `turnStart` created the streaming assistant
entry, so they sit strictly above it in the array; and the boundary scan already
breaks at that entry (`Transcript.tsx:81`), so `highWater <= indexOf(assistant) <
entries.length` both before and after the removal. Removing only entries above the
boundary is the invariant. **A future action that removes a settled entry would
break `<Static>`, and nothing would report it** — AC-22 asserts the boundary is
unchanged across a restart so that the next such action has to argue with a test.

Settling is **derived in the reducer**, not sent by core:

- in `turnEnd`: if `retryEntryId` is set → `phase='recovered'`, `totalRetries=attempt`, `elapsedMs=now-startedAt`, `retry=null`, `retryEntryId=undefined`.
- in `notice` with `level:'error'`: if `retryEntryId` is set and phase is `waiting|retrying` → `phase='exhausted'` plus the same settle fields. (The terminal `error` always precedes any `turn_end`, because a failed turn has none.)
- in `abortMark`: → `phase='interrupted'`, `retry=null`.
- **in `runEnd`: if `retryEntryId` is still set → `phase='interrupted'` plus the
  same settle fields.** This is the terminal backstop and it is not redundant
  (review P1-8). `abortMark` is dispatched only from the Esc handler
  (`App.tsx:1166`), but the engine also aborts **itself**: the idle watchdog calls
  `Agent.abort()` directly (`agent.ts:165-168`), the run unwinds, and the UI sees
  `agent_end` → `runEnd` with no `abortMark`, no `turn_end` and no error notice. A
  card left at `phase:'waiting'` then pins `Transcript`'s monotonic boundary and
  re-renders the tail **every frame for the rest of the session** — which is
  exactly the failure R-10 claims to close, except in-session rather than on
  reload. The rule is: every path that reaches `status:'idle'` settles the card.
- `submit` clears `retryEntryId` alongside `streamingId` and `todoEntryId`
  (`reducer.ts:493/497`), so a new turn gets its own card. **`runStart` clears
  none of the three today** (`reducer.ts:504-511`) and this design does not change
  that — v1 asserted otherwise (review P1-7), and following it would have altered
  the lifetime of two unrelated live cards for no reason. `runEnd`'s settle rule
  above is what makes `runStart` not needing to clear anything true rather than
  lucky.

`session/persist.ts::normalizeLoadedEntries` gains the third clause, matching `team.active` and `todo.live` exactly:

```ts
if (entry.kind === 'retry' && (entry.phase === 'waiting' || entry.phase === 'retrying')) {
  return { ...entry, phase: 'interrupted', resumeAt: undefined };
}
```

Without it the card never settles, `Transcript`'s **monotonic** settled boundary never advances past it, and every frame for the rest of the session re-renders the whole tail. This is the failure `persist.ts:99-104` already documents once.

`Transcript.tsx`'s settled-boundary scan gains `if (e.kind === 'retry' && (e.phase === 'waiting' || e.phase === 'retrying')) break;`, next to the existing `team`/`todo` lines. `virtual-window.ts` gains a `case 'retry'` in **both** of its switches (height estimate: 1 row). `transcript-text.ts` gains a `case 'retry'` for the plain-text export.

### 6.5 Rendering — `RetryCard.tsx`

One line. Always one line. Amber while in flight, muted once recovered, red once exhausted.

```
  ↻  Provider overloaded (529) · retry 3/10 in 7s          Esc to cancel
  ↻  Reconnecting · retry 4/10 …
  ↻  recovered after 3 retries · 12.4s
  ✖  Provider overloaded (529) · gave up after 10 retries · 3m01s
  ↻  interrupted after 2 retries
```

- The countdown comes from `Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000))`, recomputed at render. `App` runs a 1 Hz `setInterval` **only while `state.retry?.phase === 'waiting'`**, dispatching `retryTick`; it is cleared in the effect's teardown, so an idle session has no timer.
- `reducedMotion` suppresses the spinner glyph but **keeps the countdown ticking**. A frozen number is not calmer, it is broken — reduced motion is about animation, and a countdown is information.
- `Esc to cancel` is rendered only when the session is interactive (not headless) and only in `waiting`. It is the truth: the wait is `signal`-aware (§4.5 G2), so Esc lands within a frame.
- All glyphs through `pickGlyphs`. `Glyphs` gains one field: `retry: '↻'` (Unicode) / `'[r]'` (ASCII), following the `todoDone: '✔' / '[x]'` precedent. No component may spell either literal — `glyphs.test.ts`'s static scan fails the build if one does.
- Colours reuse the tokens `NoticeEntry` already uses for `warn` and `error`, plus `theme.muted`; no new theme token.

### 6.6 Status bar chip

`StatusBar` gains `retryActive?: { attempt: number; max: number; secondsLeft: number }`, rendered in the **left** cluster after `teamActive`:

```
cols >= RETRY_UI.statusCompactCols (100):   retry 3/10 7s
below:                                      [r3]
```

*(`RETRY_UI`, not `RETRY_LIMITS_UI` — review P2-4. The core constant it would have
shadowed bounds what the mechanism can do; this one is a column breakpoint, and a
name that reads as its sibling invites someone to look for the missing keys.)*

Left cluster because it is a run-state fact, like `agents 3/5`; degrading because the left cluster is `flexShrink={0}` and every column it takes comes out of the context gauge. This does **not** contradict the "no `cols >= N` breakpoint" rule in `StatusBar`'s header — that rule is written about `agentMode`, whose reason is that the mode must never be unreportable. The retry has a second, fuller home in the transcript card.

### 6.7 Headless mode

`runHeadless` writes one line per retry to **stderr**, never stdout:

```
[retry 3/10] overloaded — waiting 7s
[retry] recovered after 3 retries (12.4s)
```

stdout is the machine-readable answer and must stay parseable by `aragon -p | jq`. `agent/headless.ts` already holds the one non-ASCII exemption in the CLI, so the em dash is in-policy there.

### 6.8 Logging

`attachAgentEvents` (`logging/install.ts`) records `retry_scheduled` at `warn` with `{ attempt, maxRetries, delayMs, errorType, providerId, modelId }`, `retry_attempt` at `debug`, and a `recovered`/`exhausted` summary at `info`/`error`. Redaction is unaffected — the payload carries no user content, and the `message` field is already the truncated body `classifyHttpError` produces.

### 6.9 `/retry` slash command and the settings row

```
/retry                 show the effective policy
/retry on | off        toggle (persists AND live-updates the registry)
/retry max <n>         0..20
```

Persists via `updatePersistedConfig({ retry: {...} })` **and** calls `controller.setRetryConfig(...)` — both, for the reason in §6.3.

`SettingsScreen` gains one row, `API retries`, showing `10` or `off`. One row, not nine: the delays are for `config set` and `config.json`, and a settings screen that exposes a jitter checkbox is a settings screen nobody reads.

### 6.10 Retry inside a subagent

Everything above renders the **lead** agent's retries. A child's `retry_scheduled`
is emitted to that child's own `Agent` listeners and never reaches the lead's
`ViewState`, so without this section a subagent spending three minutes in backoff
shows no card, no chip and no countdown — the dispatch simply appears hung, which is
the single worst reading of a mechanism whose whole claim is that waiting is now
legible (review P0-3).

The fix is to use the channel that already exists rather than invent a second card.
`TeamRuntime` already observes each child's events to maintain `SubagentRun`
(`turns`, `toolCalls`, `phase`, `error`), and `TeamCard` / `transcript-text` already
render one row per child. So:

- `SubagentRun` gains `retry?: { attempt: number; maxRetries: number; resumeAt?: number }`,
  written from the child's `retry_scheduled` (set) / `retry_attempt` (clear
  `resumeAt`) and cleared on the child's next `turn_end` or terminal error.
- `TeamCard`'s row for that child renders `retrying 3/10 · 7s` in the warn tone
  where it would otherwise show its phase. One row, rewritten in place — the same
  discipline §6.4 applies to the lead's card, for the same reason.
- The lead's status-bar chip is **not** driven by children. `agents 3/5` already
  reports the dispatch; adding a second aggregate would put two numbers on the bar
  that disagree about what "3" means.

`ViewState.retry` stays lead-only, and `SubagentRun.retry` is ephemeral in exactly
the way the rest of that struct is — it is a live projection, and a settled team
entry keeps only what the run finally did. AC-34 pins that a child's retry is
visible on the team card; M-13 becomes an observation, not just a jitter check.

---

## 7. File / module change plan

### 7.1 `packages/core`

| File | Change | Intent |
| --- | --- | --- |
| `src/llm/retry.ts` | **new** | `RETRY_LIMITS`, `RetryPolicy`, `DEFAULT_RETRY_POLICY`, `isRetryableError`, `computeBackoffDelay`, `parseRetryAfterMs`, `withRetry`. |
| `src/llm/types.ts` | modify | Add `RetryScheduledEvent` / `RetryAttemptEvent` / `StreamRestartEvent` to the `StreamEvent` union. |
| `src/llm/provider.ts` | modify | `LLMError` 7th optional field `retryAfterMs`; `classifyHttpError(status, body, provider, headers?)`; status `408` → retryable `timeout`. |
| `src/llm/providers/index.ts` | modify | Registry holds/exposes a policy; `stream()` wraps; `complete()` routes through `stream()`; `initProviders(options?)`. |
| `src/llm/providers/anthropic.ts` | modify | Pass `response.headers` into `classifyHttpError` (1 line). **Plus §4.5a**: a `sawTerminal` flag set at the `message_stop` case, and the fall-through at 284-291 yielding `error` instead of `done` when it is unset and the signal is not aborted. |
| `src/llm/providers/openai.ts` | modify | Same header line. **Plus §4.5a**: flag set at the `[DONE]` `break` (line 170), same fall-through change at 271-277. |
| `src/llm/providers/google.ts` | modify | Same header line. **Plus §4.5a**: flag set at the terminal chunk, same fall-through change at 178-182. |
| `src/engine/agent.ts` | modify | `applyRetryWatchdogPolicy` — pause/resume the idle watchdog across a backoff. |
| `src/index.ts` | modify | Export the six new runtime symbols. |
| `src/__tests__/public-api.test.ts` | modify | Extend `EXPECTED`; bump `75` → `81`. |
| `src/__tests__/llm-retry.test.ts` | **new** | §11 AC-1…AC-14b. |
| `src/__tests__/retry-watchdog.test.ts` | **new** | §11 AC-15…AC-16. |
| `src/__tests__/adapter-truncation.test.ts` | **new** | §11 AC-9 / AC-9b — the §4.5a sentinel contract, one case per adapter plus the abort exclusion. |
| `API.md`, `CHANGELOG.md` | modify | Three-sync discipline (`public-api.test.ts` header). |

### 7.2 `packages/cli`

| File | Change | Intent |
| --- | --- | --- |
| `src/config/schema.ts` | modify | `RetryConfig`, `DEFAULT_RETRY_CONFIG`, `clampRetryConfig`, `clampNumber`, `PersistedConfig.retry`, `CliConfig.retry`. |
| `src/config/store.ts` | modify | Sixth section in **both** hand-merges. |
| `src/config/load.ts` | modify | `resolveRetryConfig`; wire into `loadConfig`; add to `logResolvedConfig`. |
| `src/config/env.ts` | modify | `ARAGON_RETRY`, `ARAGON_RETRY_MAX` (positive list; absent when unparseable). |
| `src/config/cli-commands.ts` | modify | `aragon config get/set retry.*` support. |
| `src/cli.tsx` | modify | `--no-retry`, `--retry-max <n>`; `CliFlags` fields. |
| `src/agent/controller.ts` | modify | `initProviders({retryPolicy})`; `setRetryConfig()`; `toRetryPolicy()`. |
| `src/agent/retry-view.ts` | **new** | Pure: `RETRY_UI`, `secondsLeft(resumeAt, now)`, `formatRetryLine(entry, glyphs)`. |
| `src/agent/reducer.ts` | modify | `kind:'retry'` entry, 4 actions, `retry` projection + `retryEntryId` (**including in `appendEntry`'s live-id list**, §6.4), stream-event cases, settle in `turnEnd`/`notice`/`abortMark`/**`runEnd`**. |
| `src/team/types.ts` + `src/team/runtime.ts` | modify | `SubagentRun.retry?` written from the child's retry events (§6.10). |
| `src/ui/entries/TeamCard.tsx` | modify | Render a child's `retry 3/10 · 7s` row (§6.10). |
| `src/agent/headless.ts` | modify | stderr retry lines. |
| `src/ui/entries/RetryCard.tsx` | **new** | The one-line card. |
| `src/ui/Transcript.tsx` | modify | Render `kind:'retry'`; extend the settled-boundary scan. |
| `src/ui/layout/virtual-window.ts` | modify | `case 'retry'` in **both** switches. |
| `src/ui/transcript-text.ts` | modify | `case 'retry'` for plain-text export. *(This file has `default: return []` and deliberately no `case 'todo'`, so the addition is a choice rather than a compile requirement — review P2-3. It is worth making: a turn that spent three minutes retrying is exactly the kind of cost an exported transcript is supposed to account for, which is the same argument the `team` case already makes in its own comment.)* |
| `src/ui/StatusBar.tsx` | modify | `retryActive` chip + compact degrade. |
| `src/ui/App.tsx` | modify | 1 Hz tick while `phase==='waiting'`; pass `retryActive`. |
| `src/ui/glyphs.ts` | modify | `retry` field in **both** glyph tables. |
| `src/ui/overlays/SettingsScreen.tsx` | modify | `API retries` row. |
| `src/commands/builtins.ts` | modify | `/retry` (show / on / off / max). |
| `src/session/persist.ts` | modify | Normalize a loaded `waiting`/`retrying` card to `interrupted`. |
| `src/logging/install.ts` | modify | Log the three retry events. |
| `src/__tests__/retry-config.test.ts` | **new** | §11 AC-17…AC-20, AC-33. |
| `src/__tests__/retry-reducer.test.ts` | **new** | §11 AC-21…AC-25b. |
| `src/__tests__/retry-session.test.ts` | **new** | §11 AC-26. |
| `src/__tests__/retry-render.test.tsx` | **new** | §11 AC-27…AC-28. |
| `src/__tests__/retry-team.test.ts` | **new** | §11 AC-34 — §6.10 subagent visibility. |
| `README.md`, `CHANGELOG.md` | modify | Document the section, the flags, `/retry`. |

### 7.3 Docs

| File | Change |
| --- | --- |
| `docs/plans/llm-api-retry-backoff/spec.md` | this document |
| `docs/plans/llm-api-retry-backoff/manual-test.md` | to be written by the implementation node from §12 |

---

## 8. Interface design

### 8.1 Core public API additions (6 runtime exports)

```ts
export const RETRY_LIMITS: { hardMaxRetries; absoluteMaxDelayMs; retryAfterCeilingMs; minDelayMs };
export const DEFAULT_RETRY_POLICY: RetryPolicy;
export function isRetryableError(err: unknown, signal?: AbortSignal): RetryDecision;
export function computeBackoffDelay(retryIndex, policy, opts?): number;
export function parseRetryAfterMs(headers?: Headers, now?: () => number): number | undefined;
export function withRetry(makeStream, opts): AsyncIterableIterator<StreamEvent>;
```

Type-only additions (`RetryPolicy`, `RetryDecision`, `WithRetryOptions`, the three event interfaces) are documented in `API.md` but are invisible to `public-api.test.ts`, which sees runtime values only.

`normalizePolicy` and `decide` stay **module-internal** — exported from `retry.ts`
for `llm-retry.test.ts` to import directly if it wants, but **not** re-exported from
the barrel. They are implementation of the two public entry points, and promoting
them would make the count 83 and add two symbols to the frozen surface that nobody
outside this module has a reason to call. AC-14b therefore asserts the clamp
*through* `withRetry`, which is also the only way to catch it being present but
unwired.

Signature changes, all additive and source-compatible:

```ts
classifyHttpError(status: number, body: string, provider: string, headers?: Headers): LLMError;
new LLMError(message, provider, errorType, retryable, statusCode?, raw?, retryAfterMs?);
initProviders(options?: { retryPolicy?: RetryPolicy | null }): ProviderRegistry;
new ProviderRegistry(options?: { retryPolicy?: RetryPolicy | null });
ProviderRegistry.setRetryPolicy(policy: RetryPolicy | null): void;
ProviderRegistry.getRetryPolicy(): RetryPolicy | null;
```

### 8.2 CLI surface

```
aragon --no-retry                # this run: no retries
aragon --retry-max 3             # this run: at most 3
ARAGON_RETRY=0                   # env kill switch
ARAGON_RETRY_MAX=15              # env override

aragon config get retry
aragon config set retry.maxRetries 15
aragon config set retry.maxDelayMs 45000
aragon config set retry.respectRetryAfter false

/retry            /retry off            /retry on            /retry max 5
```

### 8.3 `config.json` shape (sixth nested section)

```jsonc
{
  "retry": {
    "enabled": true,
    "maxRetries": 10,
    "initialDelayMs": 1000,
    "maxDelayMs": 30000,
    "multiplier": 2,
    "jitter": true,
    "respectRetryAfter": true,
    "maxElapsedMs": 240000,
    "onPartialStream": true
  }
}
```

---

## 9. Data model

No database, no files, no persistence beyond the one config section. Three in-memory shapes:

**Per-request, inside `withRetry` (lives for one `stream()` call):**

```ts
{ retryIndex: number; firstFailureAt?: number; committed: boolean;
  toolCallIds: string[]; sawDone: boolean; terminalError?: Error }
```

Discarded when the generator returns. Nothing is shared between concurrent requests — deliberately: a shared per-provider cooldown is considered and deferred in §13.

**Per-turn, in `ViewState` (CLI):** the `kind:'retry'` entry of §6.4 plus `retryEntryId?: string` and

```ts
interface RetrySnapshot {
  attempt: number; maxRetries: number; resumeAt?: number;
  phase: 'waiting' | 'retrying'; errorType: string;
}
```

`ViewState.retry: RetrySnapshot | null` — **never persisted** (`SavedSession` keeps `{ model, messages, entries, todos }` exactly as it is; `/save` and `/resume` need no format change and old files load unchanged).

**Process-lifetime:** none. Unlike `output-limits.ts`, this module learns nothing across requests, so there is no cache to clear and no `afterEach` hygiene rule for tests to follow.

---

## 10. Risks & mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R-1 | **A user abort is retried.** `wrapFetchError` marks `AbortError` retryable; a naive `if (err.retryable)` would make Esc start a 10-retry sequence. | `signal.aborted` is checked **first**, in three places: the per-event guard (G1), `isRetryableError` check 1, and after the sleep. AC-4 and AC-5 pin both directions. |
| R-2 | **Esc during a 30 s wait feels dead.** | `sleep` races the timer against the signal's `abort` event (G2). AC-5 asserts the promise settles within one tick of `abort()`. |
| R-3 | **Duplicated text on screen** after a mid-stream restart. | `stream_restart` carries `discardedToolCallIds`; the reducer resets the streaming entry's `text`/`thinking` and removes those tool cards. Engine history is provably clean (§3.5). AC-12/AC-22 pin it. Set `onPartialStream: false` to disable the whole path. |
| R-4 | **The idle watchdog aborts mid-backoff.** | Two independent guards: `maxDelayMs` clamped to 30 s (< the 60 s core default), and `Agent` pauses the watchdog across the wait (§4.6). `stop()` clears `paused`, so a leak cannot outlive the run. AC-15/AC-16. |
| R-5 | **Retry storm** — 5 concurrent subagents all retry the same 429 in lockstep. | Equal jitter de-correlates them; `team.maxConcurrent` already caps the fan-out at 3 by default. A shared per-provider cooldown is deferred with rationale (§13.3). |
| R-6 | **Cost.** A request that fails at token 3000 re-charges its input tokens on every attempt. | `maxElapsedMs` bounds the exposure; `respectRetryAfter` avoids hammering a rate limiter; the settled card reports the retry count so the spend is visible. **We do not fabricate usage for discarded attempts** — `turn_end` reports the successful attempt only, and §12 M-7 has the user confirm that is what they see. |
| R-7 | **Default-on is a behaviour change for embedders.** A library consumer's failing call now takes up to 3 minutes to fail. | Documented in `CHANGELOG.md` as a behaviour change with the opt-out spelled out (`initProviders({ retryPolicy: null })` / `setRetryPolicy(null)`); `maxElapsedMs` bounds it; `maxRetries: 0` short-circuits the wrapper entirely so the opted-out path is byte-identical. |
| R-8 | **A truncated stream changes from silent success to a loud error.** v1 described this as a `formatStreamError` message change; the real change is larger and lives in the adapters (§4.5a, review P0-1). Today a gracefully-closed mid-answer stream yields `done` with partial content — the user gets a truncated answer and is told nothing. After §4.5a it is a retryable `network_error`, so it is retried, and on exhaustion it renders "Network error reaching the provider". `complete()` changes from returning a partial `AssistantMessage` to throwing. | This is the point of the feature, but it is the most behaviour-visible part of it. `CHANGELOG.md` documents it next to R-7. AC-9 / AC-9b pin the sentinel contract per adapter **and** the abort exclusion, which is the one way this change could go wrong (turning every Esc into a fake network error). |
| R-9 | **`store.ts` merge omitted.** Adding the section to only one of the two hand-merges. | AC-19 asserts round-tripping a partial `{retry:{maxRetries:5}}` patch preserves `respectRetryAfter`; AC-20 asserts a config file with no `retry` key loads the full default section. |
| R-10 | **The live card never settles**, pinning `Transcript`'s monotonic boundary and re-rendering the tail every frame. **v1 covered only the reload path**; the in-session path is the engine's own idle watchdog calling `Agent.abort()` (`agent.ts:165-168`), which produces `agent_end` with no `abortMark`, no `turn_end` and no error notice (review P1-8). | `normalizeLoadedEntries` third clause **plus** four settle points — `turnEnd` / `notice(error)` / `abortMark` / **`runEnd`** (§6.4). The rule is "every path that reaches `status:'idle'` settles the card", and `runEnd` is what makes that exhaustive rather than enumerated. AC-26 pins the reload path; AC-25b pins the watchdog path. |
| R-11 | **Test flakiness** from real timers and real randomness. | `now` / `sleep` / `random` are all injectable on `WithRetryOptions`; every core test uses fakes and asserts the *exact* delay sequence. No test in this feature may call the real `setTimeout`. |
| R-12 | **`complete()` left unwrapped.** | AC-11 drives `registry.complete()` against a failing fake provider and asserts it recovers. |
| R-13 | **A provider that yields `error` and then more events.** None do today. | `withRetry` `break`s out of the attempt loop on the first `error` and never resumes that iterator; the generator's `return` triggers its `finally`, releasing the SSE reader (`stream-utils.ts:79-82`). |
| R-14 | **A subagent's retry is invisible**, so a three-minute child backoff reads as a hung dispatch (review P0-3). | `SubagentRun.retry?` rendered on the existing team row (§6.10). AC-34. |
| R-15 | **A child is killed by `subagentTimeoutMs` mid-ladder** and the user is told "subagent timed out" for a provider outage (review P0-3). | `maxElapsedMs` lowered to 240 000, below the 300 000 child timeout, with ~60 s of answer headroom (§4.1 / §5.6). AC-33 pins the inequality so the next person to change either number is told. |
| R-16 | **A documented setting silently does the opposite** (review P0-4). `maxRetries: 0` — the floor of its own range and the value four documented controls send — resolves to `10` through `coercePositiveInt`. | `clampIntAllowingZero` in `clampRetryConfig`, `>= 0` in the env reader (§6.1 / §6.2). AC-17b asserts `0` survives the clamp *and* that `-1` still falls back. |
| R-17 | **The §4.5a adapter change turns every user abort into a fake network error.** `parseSSEStream` `break`s on `signal.aborted` and lands on the same fall-through the truncation check guards (`stream-utils.ts:52`). | The signal check comes first and keeps yielding `done` on that path (§4.5a constraint 1). AC-9b pins it, and it is the reason AC-9b is not optional. |

---

## 11. Testing & acceptance criteria

Every item below is one Vitest case. Core `withRetry` tests use a `FakeProvider` whose `stream()` replays a scripted array of `StreamEvent`s per attempt, plus injected `now` / `sleep` / `random`. **AC-9 / AC-9b are the exception**: they exercise the *real* adapters against a scripted `fetch` returning a hand-built SSE body, because the whole point of §4.5a is what the adapters do at the end of a stream — a `FakeProvider` would assert the design against itself.

**Core — `withRetry` (`core/src/__tests__/llm-retry.test.ts`)**

- **AC-1** A first attempt that reaches `done` yields exactly the scripted events, in order, with no `retry_*` event and `sleep` never called.
- **AC-2** A retryable 529 on attempts 1-3 and `done` on attempt 4 yields three `retry_scheduled` / `retry_attempt` pairs and then the successful stream; no `error` event is forwarded.
- **AC-3** With `jitter: false`, ten consecutive 529s produce delays exactly `[1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]`, and the 11th failure forwards the original `LLMError` unchanged (same object identity).
- **AC-4** `auth_error` (401) is forwarded on the first failure; `sleep` is never called.
- **AC-5** `signal.abort()` during the backoff: the generator returns **yielding no further event of any type** — specifically no `error` (G3, review P1-1) — and the `sleep` promise settles in the same tick as the abort. Assert the full yielded sequence, not just the absence of a retry: an implementation that yields the terminal error on the abort path passes a weaker "did not retry" assertion.
- **AC-5b** `registry.complete()` aborted mid-backoff **rejects with the abort's own error, never a fabricated `network_error`.** `consumeStream` does not consult the signal, so this is the assertion that catches G3 being lost.
- **AC-6** An `AbortError`-shaped failure (`retryable: true`, `errorType: 'timeout'`) with `signal.aborted === true` is **not** retried; the same failure with `signal.aborted === false` **is** retried. *(Both directions — asserting only one lets the next reader invert the check while the suite stays green.)*
- **AC-7** `Retry-After: 5` on the second retry produces a delay of at least 5000 even though the ladder says 2000; `Retry-After: 1` on the ninth retry does **not** shrink the delay below the ladder.
- **AC-8** `Retry-After: 3600` (> `retryAfterCeilingMs`) forwards the error immediately with reason `retry_after_too_long`.
- **AC-9** **(§4.5a, per adapter — `adapter-truncation.test.ts`.)** Feed each of the three adapters an SSE body that ends **without** its terminal sentinel (`message_stop` / `[DONE]` / a chunk carrying `finishReason`) after emitting some text. Each must yield `{type:'error'}` with `errorType:'network_error'`, `retryable: true` — **not** `done`. *(Against v1's adapters all three yield `done`, so this test fails before the change and is the whole proof that P0-1 is closed.)*
- **AC-9b** The same truncated body with `request.signal` **already aborted** yields `done`, not `error` — an abort is not a truncation (§4.5a constraint 1). And a body that carries the terminal sentinel with **zero** content blocks still yields `done` — an empty turn is a legitimate success (constraint 2).
- **AC-9c** `withRetry` over an adapter-shaped iterator that ends with neither `done` nor `error` still synthesises a retryable `network_error` (the defensive branch survives, even though §4.5a makes it unreachable from real adapters).
- **AC-10** `maxElapsedMs` exhaustion forwards the error even though `retryIndex < maxRetries`.
- **AC-10b** **The budget is actually evaluated on the first failure.** With `maxElapsedMs: 500` and `initialDelayMs: 1000`, the *first* retryable failure forwards the error with reason `budget_exhausted` and `sleep` is never called. *(This is the case v1's ordering computed as `now() - undefined + delay`, i.e. `NaN`, which compares `false` and lets every first retry through — review P0-2. Asserting only a later-retry budget stop leaves that hole open.)*
- **AC-11** `registry.complete(...)` against a provider failing twice then succeeding returns the assembled message (proves §5.4).
- **AC-12** With `onPartialStream: true`, a failure after a `text_delta` emits `stream_restart` carrying the ids of every `tool_call_start` forwarded in that attempt, then retries. With `onPartialStream: false` the same failure is forwarded immediately.
- **AC-12b** `thinking_start` alone sets the commit point: a failure whose only prior event was `thinking_start` still emits `stream_restart` under `onPartialStream: true` (§4.5a `CONTENT_EVENTS`, review P1-2). A failure with **no** prior events emits none.
- **AC-13** `classifyHttpError(408, ...)` → `errorType: 'timeout'`, `retryable: true`; `classifyHttpError(429, body, p, headers)` with `retry-after: 7` → `retryAfterMs === 7000`.
- **AC-14** `maxRetries: 0` — `registry.stream()` returns the adapter's iterator **directly** (`===` on a marker, not a wrapper).
- **AC-14b** `normalizePolicy` clamps at the core boundary (review P1-6): `withRetry` given `{maxRetries: 5000}` performs at most `RETRY_LIMITS.hardMaxRetries` retries, and given `{maxDelayMs: 10_000_000}` never waits longer than `absoluteMaxDelayMs`. Asserted through `withRetry` rather than by calling the helper, so the clamp cannot be "present but unwired".

**Core — engine (`core/src/__tests__/retry-watchdog.test.ts`)**

- **AC-15** A `retry_scheduled` forwarded through `Agent.emit` pauses the watchdog; a subsequent `retry_attempt` resumes it. With a 100 ms idle timeout and a 500 ms simulated backoff, the run is **not** aborted.
- **AC-16** A run aborted while paused leaves the watchdog usable for the next run (`stop()` clears `paused`).

**CLI — config (`cli/src/__tests__/retry-config.test.ts`)**

- **AC-17** `clampRetryConfig({})` returns `DEFAULT_RETRY_CONFIG`; `{maxRetries: 999}` clamps to 20; `{maxDelayMs: 500, initialDelayMs: 5000}` yields `maxDelayMs === 5000`; `{multiplier: 0.1}` clamps to 1.
- **AC-17b** **`0` survives, `-1` does not** (review P0-4): `clampRetryConfig({maxRetries: 0}).maxRetries === 0`, `clampRetryConfig({maxRetries: '0'}).maxRetries === 0`, and `clampRetryConfig({maxRetries: -1}).maxRetries === 10`. Then end-to-end: `ARAGON_RETRY_MAX=0` and `--retry-max 0` both resolve to `0`, and `toRetryPolicy` returns `null` for that config. *(Both directions. Asserting only that `0` survives lets someone "fix" it by dropping the guard entirely and accepting `-1` as `-1`.)*
- **AC-18** Layer precedence: file `maxRetries: 3` < env `ARAGON_RETRY_MAX=7` < flag `--retry-max 2` resolves to 2; `--no-retry` beats `ARAGON_RETRY=1`.
- **AC-19** `updatePersistedConfig({retry:{maxRetries:5}})` preserves `respectRetryAfter` and `jitter` (the write-side merge).
- **AC-20** A `config.json` with no `retry` key loads a complete section (the read-side merge).

**CLI — reducer (`cli/src/__tests__/retry-reducer.test.ts`)**

- **AC-21** Three `retry_scheduled` events produce **one** entry of `kind:'retry'`, rewritten in place, with `attempt === 3`.
- **AC-22** `stream_restart` clears the streaming assistant entry's `text` and removes exactly the tool entries named in `discardedToolCallIds`, leaving earlier turns untouched. **Additionally** (review P1-3): the `Transcript` settled-boundary index computed over `state.entries` is unchanged across the restart, proving the removal touched nothing at or below the boundary — the property that keeps `<Static>` from duplicating the live entry.
- **AC-23** `turnEnd` after two retries settles the card to `phase:'recovered'`, `totalRetries === 2`, and nulls `state.retry`.
- **AC-24** A terminal error notice settles the card to `phase:'exhausted'`; the generic `GENERIC_RUN_FAILURE` guard in `runEnd` does **not** additionally fire (`errorNoticed` is already true).
- **AC-25** `abortMark` during `waiting` settles to `phase:'interrupted'` and nulls `state.retry`.
- **AC-25b** **`runEnd` reached with a `waiting` card and *no* preceding `abortMark`, error notice or `turnEnd`** — the engine-side watchdog abort — settles to `phase:'interrupted'` and nulls `state.retry` (review P1-8). Assert `retryEntryId === undefined` afterwards, because that is what lets `Transcript`'s boundary advance.

**CLI — session (`cli/src/__tests__/retry-session.test.ts`)**

- **AC-26** A session saved with a `phase:'waiting'` card loads with `phase:'interrupted'` and `resumeAt === undefined`.

**CLI — render (`cli/src/__tests__/retry-render.test.tsx`)**

- **AC-27** `RetryCard` renders one row in all five phases, and renders only ASCII under `caps.unicode === false`.
- **AC-28** `StatusBar` shows `retry 3/10` at 120 columns and `[r3]` at 80.

**CLI — team (`cli/src/__tests__/retry-team.test.ts`)**

- **AC-34** A child emitting `retry_scheduled` sets `SubagentRun.retry` and the team row renders `retry 3/10`; the child's next `turn_end` clears it (§6.10, review P0-3).

**Cross-cutting**

- **AC-29** `glyphs.test.ts` (existing static scan) still passes — no new non-ASCII literal outside `glyphs.ts`.
- **AC-30** `no-host-coupling.test.ts` still passes — `retry.ts` imports nothing host-shaped and leaks no host brand. **In particular it imports no `node:*` module** (rule 2, one grandfathered exception): the abortable `sleep` uses the global `setTimeout`, not `node:timers/promises` (review P2-2).
- **AC-31** `public-api.test.ts` passes with 81 expected exports; `API.md` lists all six.
- **AC-32** `npm run build` and both `tsc --noEmit` passes (`tsconfig.json` and `tsconfig.test.json`) are clean in **both** packages.
- **AC-33** **A static assertion, not a runtime one** (review P0-3 / R-15): `DEFAULT_RETRY_POLICY.maxElapsedMs < DEFAULT_TEAM_CONFIG.subagentTimeoutMs`, with a comment naming §5.6. It lives in the CLI suite because that is where both constants are visible. Its entire job is to make the next person who edits either number read the reason.

---

## 12. Manual verification matrix

To be transcribed into `manual-test.md` by the implementation node. Items **M-2, M-3, M-5 and M-5b are not skippable** — each covers a failure that no unit test can observe.

| # | Setup | Expect |
| --- | --- | --- |
| M-1 | `aragon` with a valid key; ask anything. | No retry card, no chip. Byte-identical to the previous release. |
| M-2 | Point `--base-url` at a local server that returns 529 five times then proxies through. | One card, counting 1→5, countdown visible and decrementing each second, then `recovered after 5 retries`. The transcript has **one** retry line, not five. |
| M-3 | During M-2's wait, press **Esc**. | The wait ends within a frame (not at the end of the 8 s), the card reads `interrupted after N retries`, the prompt is usable. |
| M-4 | `aragon --api-key sk-invalid`. | Immediate auth error, **no** retry card, no delay. |
| M-5 | Kill the network mid-answer (after text has streamed). | Partial text is discarded, the card appears, the answer restarts from the top on reconnect. No duplicated paragraph. |
| M-5b | **Close the response stream gracefully mid-answer** — a local proxy that stops forwarding and closes the connection cleanly, *without* a reset. | The same as M-5. **Against a pre-§4.5a build this instead ends the turn with a silently truncated answer and no card at all**, which is precisely why M-5b is not skippable: M-5 exercises the throwing path, M-5b the closing path, and only the second one was broken. |
| M-6 | `aragon --no-retry` against the 529 server. | Fails on the first error, exactly as before this change. |
| M-7 | After M-2, read the cost readout. | Cost reflects the successful attempt only; the card's retry count is what tells the user more was spent. |
| M-8 | `/retry off` then trigger a 529. | No retry. Then `/retry on` in the same session, trigger again → retries, **without restarting** (proves the live update of §6.3). |
| M-9 | Force a wait at 80 columns. | Chip reads `[r3]`; the context gauge is not visibly squeezed. |
| M-10 | Run in `cmd.exe` (`caps.unicode === false`). | Card renders `[r]`, no mojibake. |
| M-11 | Save a session mid-wait with `/save`, `/resume` it. | The card reads `interrupted`; the transcript does not flicker or re-render continuously. |
| M-12 | `aragon -p "…" 1>out.txt 2>err.txt` against the 529 server. | `out.txt` holds only the answer; retry lines are in `err.txt`. |
| M-13 | A team dispatch of 3 children against the 529 server. | All three retry independently; their waits are visibly de-correlated (jitter); **each child's row on the team card reads `retry n/10` while it waits** (§6.10). The dispatch never looks hung. |
| M-14 | `reducedMotion: true` during a wait. | No spinner, countdown still ticks. |
| M-15 | `/retry max 0`, then trigger a 529. | No retry, and `/retry` reports `0` — **not `10`** (review P0-4). Then `aragon --retry-max 0` and `ARAGON_RETRY_MAX=0` in fresh sessions, same result. |

---

## 13. Non-goals

1. **Retrying a `done` that carried an empty message.** The "the model returned nothing" case belongs to `shouldRetryColdStart` (`team/retry.ts`), which owns the side-effect proof (`turns === 0 && toolCalls === 0`) that makes it safe. `withRetry` retries *transport* failures; an empty success is not one.
2. **Retrying tool execution.** `ToolExecutor` has its own timeout and error normalisation, and a re-run of `write_file` is not idempotent. Out of scope by construction.
3. **A shared per-provider cooldown / circuit breaker.** When one request learns `Retry-After: 30`, sibling requests to the same provider could honour it too. This is genuinely better under a wide fan-out, and it is deferred rather than dismissed: it introduces cross-request coupling on the registry (a `Map<providerId, notBefore>`), a new lifecycle question (when does it clear?), and a new class of test. Equal jitter plus `team.maxConcurrent: 3` handles today's fan-out. Revisit if `maxConcurrent` defaults ever rise.
4. **Resuming a stream from a byte offset.** No provider in this set supports SSE resumption; a restart is a full replay.
5. **Retrying `listModels`.** It already returns `[]` on failure by contract (`LLMProvider.listModels` doc), and a model picker that hangs for three minutes is worse than an empty list.
6. **Per-model or per-provider policies.** One policy per registry. A second axis is unjustified until someone can name the model that needs it.
7. **A half-open connection (no FIN, no RST) — the stalled-socket case (review P1-5).** It produces no event, so `withRetry` never wakes; the idle watchdog aborts the run instead of retrying it. The obvious fix — an inter-event stall timer inside `withRetry` — is **not safe at this layer**, and the reason is specific: Anthropic's `ping` frames are swallowed by the adapter's `default: break` (`anthropic.ts:278-280`), so at the `StreamEvent` layer a long extended-thinking pause and a dead socket look identical. A stall timer short enough to catch the dead socket (< the 60 s core `idleTimeout`, or it never wins the race) would spuriously restart legitimate `high`/`xhigh` thinking turns — trading a rare hang for a common wrong answer. Closing this properly means surfacing liveness *below* the adapter (forward `ping` as a keepalive `StreamEvent`, or arm the timer on SSE bytes rather than on `StreamEvent`s) and then wiring the long-dead `AgentConfig.timeouts.llmCallTimeout`. That is a separate change with its own audit; §1 and §2 now say so instead of implying coverage.
8. **Accounting for tokens spent on discarded attempts (review P2-6).** A mid-stream restart re-charges input tokens and throws away output tokens the user paid for, and R-6's "we do not fabricate usage" leaves that spend visible only as a retry count on the card. Correct, because inventing usage for an attempt whose `done` never arrived would put a made-up number in `/cost`. The follow-up is a real one — a `discarded attempts: n` line in `/cost` fed by the `retry_scheduled` count — and it is deferred, not dismissed.

---

## 14. Implementation order

Each step ends green; nothing is left half-wired between steps.

1. **Core, pure, no integration.** `retry.ts` with `RETRY_LIMITS` / `RetryPolicy` / `normalizePolicy` / `computeBackoffDelay` / `parseRetryAfterMs` / `isRetryableError`. Tests AC-3, AC-6, AC-7, AC-8, AC-13 first.
2. **`provider.ts`** — `retryAfterMs`, `headers?`, 408. Three adapter header one-liners.
3. **Adapter terminal-sentinel contract (§4.5a).** The `sawTerminal` flag and the fall-through change in all three adapters, plus the abort exclusion. Tests AC-9, AC-9b. **This step is independent of `withRetry` and lands before it on purpose**: it is a truthfulness fix to the transport that is worth having even if every later step were reverted, and it is the only step whose test fails against the pre-feature tree for a reason unrelated to retry.
4. **`withRetry`** + `types.ts` event variants. Tests AC-1, AC-2, AC-4, AC-5, AC-5b, AC-9c, AC-10, AC-10b, AC-12, AC-12b, AC-14b.
5. **`ProviderRegistry`** — policy field, `stream()` wrap, `complete()` re-route, `initProviders(options?)`. Tests AC-11, AC-14.
6. **`agent.ts`** watchdog pause/resume. Tests AC-15, AC-16.
7. **Barrel + `public-api.test.ts` + `API.md` + `CHANGELOG.md`** in one commit (three-sync discipline). Test AC-31.
8. **CLI config** — schema (including `clampIntAllowingZero`), both `store.ts` merges, `load.ts`, `env.ts`, flags. Tests AC-17, AC-17b, AC-18…AC-20, AC-33.
9. **Controller** — `toRetryPolicy`, construction, `setRetryConfig`.
10. **Reducer + `retry-view.ts`** — entry kind, actions, `retryEntryId` in the live-id list, settle rules including `runEnd`. Tests AC-21…AC-25, AC-25b.
11. **Session normalization.** Test AC-26.
12. **UI** — glyph field, `RetryCard`, `Transcript`, `virtual-window` (both switches), `transcript-text`, `StatusBar`, `App` tick. Tests AC-27…AC-29.
13. **Team visibility (§6.10)** — `SubagentRun.retry`, `TeamCard` row. Test AC-34.
14. **`/retry`, settings row, headless stderr, logging.**
15. **Docs** — `manual-test.md` from §12, CLI `README.md`, both `CHANGELOG.md`s (R-7's default-on behaviour change, R-8's truncation change, and the §5.3 singleton divergence). Run AC-32 and the full suite.

---

## 15. Definition of done

- All **42** acceptance criteria pass (AC-1…AC-34 including the `b`/`c` variants added in v2); `npm test` is green in both packages.
- `npm run build` and `tsc --noEmit` under **both** `tsconfig.json` and `tsconfig.test.json` are clean in both packages (a passing build is not a passing typecheck — `__tests__` is excluded from the build config).
- `glyphs.test.ts`, `no-host-coupling.test.ts` and `public-api.test.ts` pass unmodified in intent.
- The **16** manual checks in §12 are executed, with M-2, M-3, M-5 and M-5b evidenced.
- `API.md`, both `CHANGELOG.md`s and the CLI `README.md` describe the new section, the flags, `/retry`, the default-on behaviour change of R-7, the truncation behaviour change of R-8, and the §5.3 singleton divergence.
- With `retry.enabled = false`, a session's observable behaviour is byte-identical to the pre-feature build **except for §4.5a**, which is deliberately unconditional: an adapter that reports a truncated stream honestly does so whether or not retry is enabled. That is the one intentional exception, and it belongs in `CHANGELOG.md` rather than behind the switch — a switch that also disables telling the user the truth is not a kill switch, it is a mute button.

---

## 16. 评审结论

**有条件通过 (approved with conditions).**

The architecture is right and should be built as described. Placing the wrapper at
`ProviderRegistry` rather than in the adapters or the loop is the correct seam: it is
the only layer that can see the commit point, the `AbortSignal` and the whole event
stream at once, and the v1 document argues that case better than a reviewer could.
The abort-first classification, the equal-jitter choice, the `Retry-After`-as-floor
rule, the injectable clock, the single rewritten card and the watchdog pause are all
correct and well-reasoned, and none of them changed in review.

What did change is that four things v1 asserted turned out not to be true of this
tree, and all four are now fixed in the body: the adapters cannot produce the
"iterator ended with no terminal event" signal the design was built around (P0-1);
`withRetry`'s control flow read two values before assigning them, silently disabling
the budget (P0-2); subagents inherit the policy but not the UI, with a retry budget
exactly equal to the timeout that kills them (P0-3); and `maxRetries: 0` — the floor
of its own documented range and the value four documented controls send — resolves
to `10` (P0-4). Eight P1 findings, all resolved, are listed in §0.

Approval is conditional on these five, in this order:

1. **§4.5a ships, and AC-9 / AC-9b are written before it.** This is the condition
   that matters. Without the adapter change, the mid-stream restart machinery of
   §3.5 — `stream_restart`, `discardedToolCallIds`, `onPartialStream`, the reducer
   rewind, R-3 — is built for a signal that never arrives, and the requirement's
   headline scenario silently returns a truncated answer. If §4.5a is descoped, the
   honest move is to descope §3.5 with it and say so, not to ship the machinery and
   assume it fires.
2. **AC-10b and AC-17b exist as written, both directions.** They are the two
   findings whose failure mode is a green suite and a wrong default. A test that
   only asserts the happy direction is what let both survive v1.
3. **M-5b is executed on a real graceful close**, not simulated by killing the
   socket. M-5 and M-5b exercise different code paths in the adapter and only the
   second one was ever broken.
4. **AC-33 is a static assertion with the §5.6 comment attached.** The
   240 000 / 300 000 relationship is invisible at both edit sites; the test is the
   only thing that will tell the next person.
5. **§13.7 stays in the non-goals with its reasoning intact.** The stalled-socket
   case is genuinely out of scope, but the reason is subtle (swallowed `ping`
   frames make a thinking pause and a dead socket indistinguishable at the
   `StreamEvent` layer) and someone will otherwise "just add a timeout" and ship
   spurious restarts on `xhigh` turns.

One judgement call is recorded rather than required: `maxElapsedMs` moved from
300 000 to 240 000 to clear `subagentTimeoutMs`. Raising `team.subagentTimeoutMs`
instead would preserve the lead agent's longer budget and is a defensible
alternative — but it changes a knob owned by another feature to accommodate this
one, and 240 s still fits the full ten-step ladder with 59 s to spare, so the
requirement's literal text is untouched either way.

Scope is right-sized. The one place the document was tempted into over-engineering —
a per-attempt stall timeout — is correctly refused in §13.7, and the one place it
was under-specified for a real user control — `maxRetries: 0` — is now covered by a
six-line helper rather than a new abstraction. Nothing here needs a circuit breaker,
a per-provider cooldown or a second policy axis, and §13 is right to defer all three.

---

## 17. 实施过程发现的方案缺陷 (Issues Found During Implementation)

Seven findings, in the order they bit. Each names what the design said, why the
tree could not honour it, and what shipped instead. The corrected approach is what
is in the code; nothing here was worked around silently.

### IF-1 — `parseRetryAfterMs` closes a module cycle, and the cycle is load-bearing

§4.4 puts `parseRetryAfterMs` in `retry.ts` and gives `classifyHttpError` an
optional `headers?` parameter — but never says who calls the parser. Only
`classifyHttpError` can: it is the one place that holds both the headers and the
`LLMError` constructor. So `provider.ts` imports a value from `retry.ts` while
`retry.ts` imports `LLMError` from `provider.ts`.

**Shipped:** the cycle, documented at both ends. It is provably safe because
neither side touches the other's binding during module evaluation — `retry.ts`'s
top level builds `RETRY_LIMITS`, `DEFAULT_RETRY_POLICY` and `CONTENT_EVENTS` and
nothing else, and `provider.ts` calls the parser only inside a function body. A
future top-level `LLMError` reference in `retry.ts`, or a top-level
`parseRetryAfterMs()` call in `provider.ts`, WOULD hit the TDZ and throw at import
time, which is why both files carry the warning. The alternative — a third module
for one pure function — was rejected as worse: it would put the `Retry-After` read
order two files away from the policy that consumes it.

### IF-2 — G4's `maxElapsedMs >= initialDelayMs` clamp makes AC-10b unreachable

§4.5 G4 requires `normalizePolicy` to clamp `maxElapsedMs` to `>= initialDelayMs`.
AC-10b requires that `{ maxElapsedMs: 500, initialDelayMs: 1000 }` stop on the
FIRST failure with `budget_exhausted` and never sleep. The two cannot both hold:
the clamp raises 500 to 1000, the budget test becomes `0 + 1000 > 1000`, which is
`false`, and the first retry fires.

**Shipped:** the floor is `RETRY_LIMITS.minDelayMs` (100) instead of
`initialDelayMs`. AC-10b wins because it is a named approval condition (§16 #2) and
because it is the assertion that catches the P0-2 ordering bug — the one whose
failure mode is a green suite and a budget that never fires. The dropped floor
prevented nothing a user can reach: `retry.maxElapsedMs`'s own range starts at
10 000, so "a budget smaller than one wait" is unexpressible through every
supported write path. It is also a coherent intent ("give up after 500 ms in
total") that the clamp would have silently overridden.

### IF-3 — OpenAI truncation cannot be keyed on `[DONE]` alone

§4.5a's table names `[DONE]` as the OpenAI sentinel. `[DONE]` is a convention of
OpenAI's own server, not a property of the wire format: several OpenAI-compatible
endpoints — precisely the ones `--base-url` exists for — close the connection after
the last chunk without sending it. Keying truncation on `[DONE]` alone would make
every request against such a server a retryable `network_error`, i.e. ten retries
and then a failure, for a stream that completed perfectly.

**Shipped:** `sawTerminal` is set by `[DONE]` **or** by a `finish_reason` on any
choice. A stream cut mid-answer carries neither, so the detection the design wanted
is unchanged; what changed is that a legitimate completion is not mistaken for a
truncation. `adapter-truncation.test.ts` pins the compatible-endpoint case
explicitly. Anthropic and Google are unaffected — both have unambiguous terminal
frames, as §4.5a constraint 2 says.

### IF-4 — Anthropic needs no `sawTerminal` flag, and adding one would be dead code

§7.1 asks for "a `sawTerminal` flag set at the `message_stop` case" in
`anthropic.ts`. That case `return`s from inside the SSE loop, and so does the
in-stream `error` case — so reaching the fall-through already PROVES neither
arrived. A flag would be written and then immediately returned past.

**Shipped:** no flag in `anthropic.ts`; the fall-through tests
`request.signal?.aborted` and yields `error` otherwise, with a comment naming the
two returns that make the absence the signal. `openai.ts` and `google.ts` DO carry
the flag, because their terminal frames only `break`.

### IF-5 — AC-5b's "the abort's own error" is not reachable at this layer

AC-5b asks that `registry.complete()` aborted mid-backoff "reject with the abort's
own error". There is no such error to reject with. G3 requires the generator to
return SILENTLY on abort, and in the mid-backoff case the wrapper is inside
`sleep` — no adapter error was ever produced. `consumeStream` then throws its own
`Stream ended without a done event`.

**Shipped:** the achievable half, which is also the half the design argues for —
the rejection is never an `LLMError`, never carries `errorType`, and never mentions
the network. The test asserts exactly that. Rejecting with a synthesised
`AbortError` was considered and refused: it would be a fabricated error on the one
path whose whole rule is "do not fabricate".

### IF-6 — a `ViewState` nonce cannot drive the countdown; the entry must change identity

§6.4 specifies `retryTick` as "no state change; a nonce bump so the countdown
re-renders". A flat field on `ViewState` re-renders `Transcript`, but `EntryView` is
`React.memo`'d with an explicit comparator whose first clause is
`a.entry === b.entry` — so the retry card itself would not re-render and the
countdown would freeze at whatever second it was first drawn on, while the
transcript paid for a render every second and got nothing for it.

**Shipped:** `retryTick` rewrites the retry entry by identity (`{ ...e }`, same
values) and `EntryView` reads `Date.now()` in the `case 'retry'` branch. That
re-renders exactly one entry per tick and leaves every other memo boundary intact —
threading a `now` prop through `EntryView` would have re-rendered the whole
transcript once a second. `entryRevision` deliberately does NOT include the
countdown, so the height cache is not invalidated 30 times per backoff to
re-measure a row that is always one line.

### IF-7 — a child's team row cannot carry a countdown

§6.10 sketches the child row as `retrying 3/10 · 7s`. Nothing re-renders it: the
row is drawn from `state.team`, which is written by `agent_update`, and a child in
backoff emits exactly ONE event for the whole wait. The lead's 1 Hz `retryTick` is
gated on the LEAD's own `state.retry`. A `7s` frozen for thirty seconds reads as a
hung countdown — the exact impression the row exists to remove.

**Shipped:** `SubagentRun.retry` is `{ attempt, maxRetries }` with no `resumeAt`,
and the row renders `retry 3/10`. This is what AC-34 asserts in its own wording. A
second 1 Hz timer driven by team state was refused as scope the design did not ask
for. Separately, `createSubagent`'s `emit()` coalescing guard gained the retry key
alongside `lastPhase`: a child entering backoff stays `thinking`, so without it the
`retry_scheduled` could be thrown away by the throttle and the row would say
`thinking` for the whole wait.

**And `team/runtime.ts` needed no change at all.** §7.2 pairs it with
`team/types.ts` as the place `SubagentRun.retry` is written from the child's retry
events. The child's events are observed in `team/subagent.ts` — that is where
`agent.subscribe` lives — and `TeamRuntime.publish()` already shallow-copies the
whole run into the snapshot and into every `agent_update`. So the write belongs in
`subagent.ts` and the propagation was already free.

### Also worth recording

- **`toRetryPolicy` had to become total.** Every controller test in the CLI builds a
  `CliConfig` literal by hand, and those literals legitimately omit `retry` —
  `loadConfig` is the only thing that guarantees the section. A `TypeError` thrown
  from a pure translation function called in the `AgentController` constructor is
  the wrong way to discover that, so it now routes through `clampRetryConfig`,
  which also means an out-of-range hand-built value can never reach the engine.
- **`SettingsScreen`'s row is a separate prop, not a `SettingsValues` field.**
  `SettingsValues` is what Enter WRITES; routing retry through it would mean either
  nine editable rows or one row whose Enter silently rewrote a section it does not
  own.
- **`clampNumber` is used, `clampIntAllowingZero` is used, and both are private.**
  §6.1 describes them as siblings of `clampInt`; they are, and they are not
  exported, because every write path into the section goes through
  `clampRetryConfig` and a second entry point is how the two coercions start
  disagreeing.
- **Concurrent work in the same tree.** This feature was implemented alongside
  `fast-model-tier` and `wheel-scrolls-transcript-only`, which touch
  `config/schema.ts`, `config/load.ts`, `config/store.ts`, `agent/controller.ts`,
  `agent/reducer.ts`, `session/persist.ts`, `team/{types,runtime,subagent,task-tool}.ts`
  and `ui/App.tsx`. Type errors under `src/fast/`, at `team/runtime.ts:203`, in
  `team/task-tool.ts` and in `reducer.ts`'s `teamStart` (a newly-required
  `SubagentRun.tier`), plus the one failing case in `team-retry.test.ts`
  (`outcome.usage` became `sumTier('main')` while that file's fixtures carry no
  `tier`), belong to that work and not to this change.
