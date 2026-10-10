# team-overseer — the dispatch supervisor (soft-timeout inspection)

> Status: shipping round 1.
> Parent feature: `team-subagents` (§3.8's timeout matrix gains a fourth column).
> Zero files under `packages/core/` change (D-10 / I-5 hold).

## 1. Problem

A subagent that exceeds a ceiling today dies for a mechanical reason:

| Ceiling | Today | Failure mode |
| --- | --- | --- |
| `subagentTimeoutMs > 0` | per-child `setTimeout` -> `handle.abort()` | a slow-but-healthy child is killed at an arbitrary wall clock |
| event silence (`idleTimeoutMs`, default 210 s) | core `IdleWatchdog` aborts the child | a wedged child dies with no diagnosis and no recovery |
| silent stream death | child resolves with no summary | `[failed: run produced no output]`, nothing more |

The requirement this feature implements: when a subagent exceeds a time
ceiling, SOMEBODY LOOKS. A dedicated supervisor agent (one per dispatch,
running on the fast tier) inspects the child, tries to help it recover,
reassigns or abandons it when recovery is impossible — and keeps waiting
when the child is simply working. Timeouts become inspection triggers, not
death sentences.

## 2. Non-goals

- No change to `dispatchTimeoutMs` (whole-batch hard ceiling, `0` = none) or
  `maxTurnsPerSubagent` (a turn cap is not time).
- No change to Core's `IdleWatchdog`. It keeps aborting on event silence; the
  supervisor merely gets its chance EARLIER (soft inspection at
  `idleTimeoutMs`, hard backstop at `idleTimeoutMs * overseerWatchdogFactor`).
- The supervisor is not a full `Agent` with tools. It is a single-shot
  structured decision call per inspection (the `FastReviewer` transport
  pattern), so it cannot itself wedge.

## 3. Design

### 3.1 The supervisor loop

One `TeamOverseer` per dispatch, created in `TeamRuntime.dispatch()` when the
provider is active, disposed at dispatch end. It owns:

- per-child decision MEMORY (what it decided before, and why), so the second
  inspection of the same child knows the first happened;
- one in-flight inspection per child (a timer refire while a call is pending
  is a no-op, not a queue);
- the inspection budget bookkeeping.

It does NOT own child lifecycle. Timers live in the runtime; actions are
applied by the runtime (§3.4).

### 3.2 Triggers (two soft timers per child)

| Timer | First armed | Re-armed |
| --- | --- | --- |
| wall clock | `subagentTimeoutMs > 0 ? subagentTimeoutMs : TEAM_LIMITS.overseerDefaultCheckMs` | the model's `nextCheckMs`, clamped to `[overseerNextCheckMinMs, overseerNextCheckMaxMs]` |
| event silence | `config.idleTimeoutMs` after the child's LAST agent event | same window after the next event |

Both fire an INSPECTION, never an abort. The silence timer is PAUSED while
the child legitimately blocks on something other than itself:

- `phase === 'waiting'` (`team_wait`, whose watchdog the comm tool already
  pauses), and
- the child is queued in `TeamHumanQueue` (exposed by a new
  `isWaiting(label)` on that CLI-local queue — enqueue-pause parity with
  D-18, one level up).

A kick arrives from `SubagentHooks.onActivity`, called on EVERY core agent
event (unthrottled — `onUpdate` is coalesced and would lie about silence).

### 3.3 The decision protocol

One `completeViaFastRegistry` call per inspection: no tools, thinking off,
temperature 0, output bounded by `FAST_LIMITS.reviewOutputTokens`, wall clock
bounded by `FAST_LIMITS.reviewTimeoutMs` (the review-call transport bounds,
mirrored — a supervision call must never out-supervise the thing it
supervises).

Input: `buildChildDigest(run, transcriptTail, memory)` — byte-budgeted by
`TEAM_LIMITS.overseerDigestBytes`. Facts: label, description, phase, turns,
toolCalls, lastTool, retry projection, elapsed, filesTouched, the tail of the
child's live message history, and the supervisor's own previous decisions.

Output: JSON `{"action": "wait"|"nudge"|"replace"|"abandon", "reason": string,
"guidance"?: string, "nextCheckMs"?: number}`. `normalizeOverseerDecision`
REPAIRS, never rejects (the `normalizeSubagentSpecs` rule): an unparseable or
out-of-budget answer becomes `wait` with the default interval — supervision
must not kill a healthy child because the supervisor hiccupped. When the
child is already terminal (`childAlive: false` in the digest), `wait` and
`nudge` normalize to `abandon` (post-mortem mode: only replace/abandon are
physically possible).

### 3.4 Actions and where they apply

| Action | Applied by | Mechanism |
| --- | --- | --- |
| `wait` | runtime, immediately | re-arm both timers (`nextCheckMs` clamped) |
| `nudge` | runtime, immediately | `handle.agent.steer(guidance)` — queued, drained at the safe top-of-loop checkpoint; guarded by the handle's `abortRequested` flag |
| `replace` | runtime, DEFERRED | sets `handle.overseerVerdict = {action:'replace',...}` then `handle.abort()`; the WORKER LOOP (`runOne`) performs the rebuild after `agent.prompt()` resolves |
| `abandon` | runtime, DEFERRED | same verdict channel; `runOne` settles the run `failed` with `overseer abandoned: <reason>` |

THE INVARIANT THAT MAKES `replace` SAFE: `runOne` is the only place a child's
`agent.prompt()` is awaited. If the supervisor rebuilt the handle directly,
the fresh child would never be driven — the worker is still awaiting the OLD
agent and then moves to the next index. The verdict flag funnels every
lifecycle change back through the same loop the cold-start retry uses, and
`replaceChild` generalizes `replaceForRetry`: a fresh handle from
`makeHandle`, an AMENDED prompt (a bounded overseer note: why the last
attempt stalled, what it already wrote — `filesTouched` — and the supervisor's
guidance), `run.replacements` carried forward, timers re-armed.

`replace` and `abandon` are also the FIFTH and SIXTH abort paths the
cold-start retry predicate must exclude (after user Esc, `ctx.signal`,
dispatch timeout and per-child timeout — see `retry.ts`'s four), because
every abort reaches the provider as a "retryable" `AbortError`. The exclusion
reads the verdict off the handle BEFORE `shouldRetryColdStart` is consulted.

Post-mortem: when a child settles `failed` with no summary AND the
replacement budget remains, the supervisor gets ONE inspection with
`childAlive: false` — a watchdog death is the "timed out" case the
requirement most wants diagnosed, and replace-after-death is exactly
"重新指派".

### 3.5 Budgets (all structural, `TEAM_LIMITS`)

- `overseerMaxInspectionsPerChild: 4` — an indecisive supervisor stops
  burning fast-tier calls; the child simply runs under its hard ceilings.
- `overseerMaxReplacementsPerChild: 1` — no ping-pong rebuilds. A replacement
  that also stalls dies on its own watchdog.
- `overseerDigestBytes: 8_000`, `overseerGuidanceChars: 1_200`,
  `overseerReasonChars: 200` — byte/char clamps on everything the protocol
  carries.
- `overseerDefaultCheckMs: 300_000` — the wall-clock first check when
  `subagentTimeoutMs === 0` (the shipped default).
- `overseerNextCheckMinMs: 60_000` / `overseerNextCheckMaxMs: 900_000` — the
  clamp on the model-chosen next check.
- `overseerWatchdogFactor: 4` — when the supervisor is active, a child's own
  `idleTimeout` is multiplied by this, so the soft silence inspection at
  `idleTimeoutMs` always precedes the hard abort.

### 3.6 Policy (config keys)

- `team.overseer: boolean`, default TRUE. Read live per dispatch; `/team
  overseer on|off` persists it.

Behaviour change disclosed: with the supervisor active, `subagentTimeoutMs >
0` no longer hard-aborts — it is the FIRST inspection point. The hard
backstop for a wedged child becomes the lengthened own-idle-watchdog; the
hard backstop for the batch remains `dispatchTimeoutMs`.

Supervisor availability: `FastWiring.available() && fast tier resolves &&
team.overseer`. With the fast tier off, unresolvable, or mid-dispatch
disabled, the supervisor is absent and children behave exactly as before
(`active()` is re-read per dispatch, and per inspection call, the way the
child reviewer's is).

### 3.7 Events, report, UI

- `TeamEvent` gains `{type:'overseer'; dispatchId; label; decision; at}` —
  CLI-local like the other five members. Consumers: `App.tsx` (team card
  refresh), `logging/install.ts` (log line), `exec/runner.ts` (mapped to a
  notice, not a new `ExecTeamEvent` shape), `headless.ts` (one-line notice).
- `SubagentRun` gains optional `interventions?: number` and `replacements?`;
  the report's per-child head gains `, overseer N` / `, replaced N` in the
  `retried Nx` position, and `buildDispatchReport` renders an `### Overseer`
  section (one line per intervention, budgeted by the existing
  `reportMaxBytes` ladder).
- `TASK_DESCRIPTION` gains one sentence: stalled children may be nudged or
  replaced by a supervisor; the report says so. The lead must not be
  surprised by a section it did not ask for.

## 4. Invariants

- **I-OV1** Every child lifecycle change funnels through `runOne`. The
  supervisor may steer, flag and abort — never rebuild or settle directly.
- **I-OV2** A failed inspection call is `wait`, never a kill.
- **I-OV3** The silence timer treats `team_wait` and human-queue waits as
  legitimate (paused, not fired).
- **I-OV4** `nudge` never steers into an abort already requested (the same
  guard-1 fact the child reviewer reads).
- **I-OV5** Budgets decrement monotonically; exhaustion degrades to
  no-supervision, not to a harsher regime.
- **I-OV6** Zero `packages/core/` changes; the feature is `src/team/**` +
  wiring + config + consumers.

## 5. Test map

`team-overseer.test.ts` (stub `agentFactory` + stub provider; zero network):
digest bounds; decision normalization (invalid -> wait; dead child ->
abandon/replace only); silence triggers inspection; waiting/queued pauses the
silence timer; nudge steers and never into a requested abort; replace flows
through the worker loop with an amended prompt and carried counters; abandon
settles `failed` with the supervisor's reason; budget exhaustion stops
inspecting; post-mortem replace; provider absent -> byte-identical legacy
behaviour. Plus updates: `team-config.test.ts` (key + default),
`team-runtime.test.ts` (verdict exclusion from cold-start retry),
`team-retry.test.ts`, report/panel tests, `logging-install.test.ts`, exec
event mapping, headless notice.

## 6. Risks

- **R-OV1** The replace race (I-OV1 violated) ships a child nobody awaits —
  guarded by the verdict channel and asserted in tests.
- **R-OV2** A nudge is delivered at the next top-of-loop drain; a child
  blocked in a long tool call receives it only after the tool returns
  (bounded by `toolTimeoutMs`, default 180 s). The digest states the current
  tool so the supervisor can account for the latency.
- **R-OV3** Cost: bounded by 4 inspections + 1 replacement per child on the
  fast tier.
- **R-OV4** `subagentTimeoutMs > 0` semantics soften for existing configs
  (disclosed in §3.6 and the config docstring).
