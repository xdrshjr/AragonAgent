# Fast model tier — round 2: budget, fail-fast, and the recorded debts

> **Version:** v2 (round 2) — reviewed, P0/P1 resolved in body
> **Feature slug:** `fast-model-tier-hardening`
> **Predecessor:** `docs/plans/fast-model-tier/spec.md` v2, shipped in `3f9dbd0f`
> **Status:** reviewed — 有条件通过 (see 「评审结论」)
> **Scope:** `packages/cli` only. Zero `packages/core` changes (C-1 holds, and §3.2
> explains how W2 keeps it).

---

## 评审记录 (Review Notes)

Reviewed against the committed tree at `293147d0` (the spec was written against
`3f9dbd0f`; the two differ only in `retry.ts`'s terminal-contract error text, which
does not move any claim here). Every line reference in §2 was opened and read
rather than accepted. **The evidence table is accurate**: `reviewer.ts` 871,
`controller.ts` 1 266, `reducer.ts` 1 416, `App.tsx` 1 669 all match `wc -l`
exactly; `reviewIndex` really is declared at `:222`, incremented only at `:541`
and reset nowhere; `beginRun()` `:337` really resets only `reviewsThisRun`;
`initProviders()` really returns a fresh registry (`providers/index.ts:172-178`);
`DEFAULT_RETRY_POLICY.maxRetries` really is `10` (`retry.ts:83-84`); `LogScope`
really is a closed nine-member union with no `fast` (`logger.ts:35-47`); and both
`store.ts` merges (`:165`, `:229`) really do spread the `fast` section wholesale
through `clampFastConfig`, so §4.1's "no `store.ts` change" is correct.

Two of the design's central structural claims also hold under checking, and they
are load-bearing enough to state positively: **`runReview()` has exactly one call
site** (`reviewer.ts:521`, inside `maybeStartReview()`), so W1's single
enforcement point is genuinely single and cannot be bypassed; and **`FastWiring`
receives `complete` through its own deps** (`wiring.ts:58`, forwarded at `:128`),
so W2 can rebind the reviewer's registry without touching `controller.ts` —
AC-H10 is achievable as written.

The findings below are what did not survive.

| # | Sev | Finding | Fixed in |
|---|---|---|---|
| **RV-H1** | **P0** | W3's split, as drawn, cuts IF-7's cancellation-classification invariant in half. §3.3 lists "`callAbortReason` stamping" as belonging to `review-call.ts`, but `cancelCall()` (`reviewer.ts:278-281`) — the *writer* of `'cancelled'` — is reached from `abort()` (`:261`), `endRun()` (`:456`) and `dispose()` (`:285`), all of which §3.3 keeps in `reviewer.ts`. Both `callAbort` (`:204`) and `callAbortReason` (`:216`) are shared mutable state between the call and the lifecycle: written at `:564-565`, `:571-572`, `:603-604` and `:280`, read in the catch at `:595`. The natural encapsulation — `review-call.ts` owning its own `AbortController` — silently removes the lifecycle's ability to stamp `'cancelled'` before aborting, so every cancelled review is reclassified as a transport failure. **That is precisely the defect round 1 shipped and fixed as IF-7**, whose symptom was the reviewer self-disabling for the rest of the session behind a warn quoting "Stream ended without a done event". It cannot be recovered from the error object: the retry layer returns silently on abort (`retry.ts:553`, G3), so a cancel and a timeout produce byte-identical bare `Error`s. §3.3 protects the drain guards by name and says nothing about this one. | §3.3 (second constraint), AC-H16, R-H10 |
| **RV-H2** | **P1** | `reviewTimeoutMs` 30 000 → 12 000 budgets the wrong term. The stated rationale — "with two attempts, 12 s is generous" — budgets `attempts × (call + backoff)`, but the model's own generation latency does not shrink when `maxRetries` drops from 10 to 1. The review asks a *cheap* model for 512 tokens (`limits.ts:47`) from a 4 000-char digest, and a loaded free-tier endpoint answering that in 15-25 s is ordinary. A timeout is a strike (`reviewer.ts:571`, AC-H14), and `maxConsecutiveFailures` is 3 — so W2 converts "slow but healthy provider" into a tier that self-disables for the session and tells the user it is *misconfigured*. That is the exact register D-24 reserves for faults that never self-heal, spent on one that does. | §3.2, D-H11, AC-H14, §7.3 row 6 |
| **RV-H3** | **P1** | §4.2 is self-contradictory about the mid-dispatch guard: it says the verb "inherits the guard at `:353` **unchanged**" *and* that "bare `/fast budget` is grouped with `status` for that guard". The actual condition is `verb && verb !== 'status' && controller.isTeamBusy()` (`builtins.ts:353`), so with the guard unchanged a bare `/fast budget` is **refused** mid-dispatch. Grouping it with `status` requires editing the condition, which the change plan's `builtins.ts` row does not mention. | §4.2, §6 |
| **RV-H4** | **P1** | §4.2's implementation enumeration lists `ctx.persistConfig({ fast: … })` and omits `controller.setFastConfig(patch)`. The latter is the only thing that makes a raised budget take effect live, because `budgetLimit()` reads `deps.getConfig()`, which resolves to the controller's in-memory config — not to disk. Implemented as enumerated, `/fast budget 80` persists and changes nothing until relaunch, and **AC-H4 fails**. The repo names this exact failure mode in the comment the section says it is following (`builtins.ts:337-343`: "Persist alone reports success and changes nothing until relaunch; the setter alone forgets by morning"). | §4.2, §10 |
| **RV-H5** | **P1** | §4.4 under-specifies the settings work by describing a row shape that does not exist. `SettingsRow.kind` is `'enum' \| 'text' \| 'secret'` (`SettingsScreen.tsx:89`) — **there is no numeric kind**, so "mirroring the existing numeric rows" names nothing. A fifth fast row additionally needs: a new key on `SettingsValues` (which is string-typed by design, `:49`), parse+clamp in `readFastSettings` (`:151`), seeding in `fastSettingsFrom` (`:168`), and both `Pick<SettingsValues, …>` unions (`:114`, `:151`, `:168`) extended — plus four comments that say "the four fast rows" (`:105`, `:138`, `:167`, `:186`). "No new interaction pattern" is true; "one new row" is not. | §4.4, §6, D-H12 |
| **RV-H6** | **P1** | W2 leaves `FastWiringDeps.complete` (`wiring.ts:58`) dead. Its only consumer is `:128`, which is exactly the binding W2 replaces. The spec does not decide the disposition, and both options have a cost the reader must be told about: removing it forces a `controller.ts` edit at the construction site, contradicting §6's "explicitly not touched"; keeping it leaves an injected dependency nothing reads, which the next author deletes — reintroducing the same edit later and without the context. | §3.2, §6, AC-H17 |
| **RV-H7** | P2 | R-H3 says the fast registry is "disposed with" `FastWiring`. `ProviderRegistry` exposes no `dispose()` (`providers/index.ts`), and `FastWiring.dispose()` (`:267-270`) only disposes the reviewer and clears listeners. The registry is simply dropped for GC. The mitigation is still sound — adapters are stateless — but the stated mechanism does not exist. | §8 R-H3 |
| **RV-H8** | P2 | §3.5's trace is internally inconsistent. `beginRun()` resets `this.turns = 0` (`:332`), so "turn 40" is turn 40 *of a single run*, while "40 reviews already started this session" implies many runs. At cadence 5 that run would have started 8 reviews, and `maxReviewsPerRun` is 6 — so "per-run: 2 < 6" holds only after six single-flight skips. Illustrative, not load-bearing, but a reader who reconciles it against the code by "fixing" the code loses the run cap. | §3.5 |
| **RV-H9** | P2 | §6's modified-file table lists `packages/cli/src/fast/wiring.ts` twice, once for the registry and once "(snapshot)". | §6 |
| **RV-H10** | P2 | `offFastStatus()`'s placeholder takes `reviewBudget: 0` alongside `budgetReached: false`, so the obvious re-derivation `reviews >= reviewBudget` evaluates `0 >= 0` → `true` and disagrees with the carried flag. Harmless *only* because §5 forbids callers from re-deriving; that prohibition needs to be at the field, where the next consumer reads it. | §5 |
| **RV-H11** | P2 | A few §2 line anchors drift by one or two lines against the tree: `DropReason` is `:115` (not `:116`), `FastSnapshot` is `:73` (not `:74`), and `clampFastConfig` is `:945` — `:934` is the comment above it. The `wiring.ts:88` anchor is right but sits in the exported free function `offFastStatus()`, not in a `FastWiring` method. Anchors, not claims; every claim verified. | §2 note |
| **RV-H12** | P2 | Worth stating because it is what makes the timeout authoritative: `FAST_RETRY_POLICY` inherits `respectRetryAfter: true` and `maxElapsedMs: 240_000` from `DEFAULT_RETRY_POLICY`, and a `Retry-After` is applied **after** the `maxDelayMs` clamp (`retry.ts:316-324`), so a single honoured retry can sleep up to the 60 s `retryAfterCeilingMs`. The reviewer's own timeout still wins, but only because `defaultSleep` resolves on the abort signal (`retry.ts:417-427`, G2) *and* the reviewer passes `signal` into the request (`:589`). Both are load-bearing for W2 and neither is mentioned. | §3.2 |

**Not findings** (checked, and correct as written): the single-counter rule of
§3.1.1 and its `41/40` argument; the "after the cadence gate" placement; the
latch keyed on the limit; `store.ts` needing no change; `glyphs.test.ts` already
scoping `src/fast/` (`glyphs.test.ts:186-189`, so two new files there are scanned
automatically); `clampFastConfig` gating the write path through
`setFastConfig` (`controller.ts:1236`); and `onConfigChanged()` existing
(`wiring.ts:187`) and being what republishes the snapshot after `/fast budget`.

---

## 0. What this round is, and what it is not

Round 1 built the feature the requirement asked for and shipped it: an opt-in
fast tier, off by default, settable from the TUI and from `config.json`, allowed
to equal the main model, able to run `task` children on a cheaper model, and
running an asynchronous review every N turns that feeds a critique back to the
lead. All of that works and is covered by 1 505 passing tests.

This round does not add a capability. It closes the four things round 1 either
recorded as unfinished or did not look at, every one of which is a *reliability*
or *honesty* property rather than a feature:

| # | Gap | Evidence | Round-1 status |
|---|---|---|---|
| **W1** | Unrequested background spend has **no session bound**. | `reviewer.ts:337` resets the only counter per run | Not identified |
| **W2** | The background review shares the lead's **retrying** registry and cannot opt out. | `IF-3`; `LLMRequest` has no retry field; policy is registry-global | Recorded, fallback shipped |
| **W3** | `reviewer.ts` is at **871 of 1 000** lines; three shared files are over cap. | `IF-1` | Recorded, deferred as unattributable |
| **W4** | There is no `fast` log scope. | `IF-2` | Recorded, `agent` used instead |

W1 is the headline and the only one a user can feel. W2 and W4 are the two
recorded defects that are now *cheap* to close because the blocking condition
(the uncommitted `llm-api-retry-backoff` tree) has since been committed. W3 is
the precondition for doing W1 and W2 at all without breaching the repo's own
file-size rule.

Requirement trace: the original requirement's last two bullets are
「稳健，可靠，顶级」 and 「美观，优雅，顶级设计，符合人机交互最佳实践」. W1 is the
first bullet applied to money; W2 is it applied to failure; W3 is it applied to
the code. The user-facing half of W1 (a budget you can see, raise, and are told
about exactly once) is the second bullet.

---

## 1. Overview

### 1.1 The shape of the problem

The fast tier spends money in two directions, and they are not morally
equivalent. **Delegation** (`task` with `model: "fast"`) is spend the lead
*chose*, inside a run the user started, bounded by `team.maxSubagents` (5) and
`team.maxConcurrent` (3), and it exists to *reduce* total cost by keeping a
240 KB file body out of the lead's context. **Review** is spend nobody asked
for: it fires on a turn counter, it runs while the user is reading something
else, and its output is an advisory the lead may ignore.

Round 1 bounded review spend structurally and per-run — a digest is capped at
4 000 characters (`FAST_LIMITS.digestMaxChars`), an answer at 512 tokens
(`reviewOutputTokens`), and a run at 6 reviews (`maxReviewsPerRun`). What it
never did was bound it across a *session*. `reviewsThisRun` is reset to zero in
`beginRun()` (`packages/cli/src/fast/reviewer.ts:337`), and `canReviewAgain()`
(`:505-510`) consults `selfDisabled`, `available()`, `config.review` and
`reviewsThisRun` — and nothing else. A long working session is not one run; it is
one run per user message. Thirty messages buys up to **180 unrequested review
calls**, and the product's only response is to tell you afterwards.

It does tell you, accurately: `/fast status` already reports
`N reviews, M delegated subagents, in X / out Y, cost $Z`
(`packages/cli/src/commands/builtins.ts:88-92`), and it renders
`unknown (no price table for <model>)` rather than `$0.00` for an unpriced model
(C-11). The tier therefore **meters its spend and never bounds it** — which is
the one combination that lets a user discover the number only once it is large.

### 1.2 The shape of the fix

A budget denominated in **reviews**, not currency, defaulting to 40 per session,
enforced at the one place a review can begin, announced exactly once when it is
reached, raised live with `/fast budget <n>`, and stated up front by
`/fast status` as `12/40` rather than `12`.

Denominating in reviews rather than dollars falls directly out of C-11 and is the
central design decision of this round (D-H1). The fast tier is by construction
the likeliest place in the product to name a model the static cost table has
never seen — that is what "the cheap new model my vendor shipped last week" means
— and `ModelRegistry.buildRuntimeModel` returns `cost: { input: 0, output: 0 }`
for exactly those (`model-registry.ts:149`). A budget the product cannot compute
for its own most likely configuration is not a budget; it is a limit that silently
never triggers. A review *count*, by contrast, is exact for every model, and
because per-review cost is already structurally bounded on both sides, `count ×
bound` is an honest ceiling the user can be shown before they spend it.

W2 then fixes the other half of "unrequested": not just how *much* the reviewer
spends, but what it does to the foreground when the provider is unhealthy. Today
the reviewer calls `complete()` on the controller's own registry, whose retry
policy is `DEFAULT_RETRY_POLICY` with **`maxRetries: 10`**
(`packages/core/src/llm/retry.ts:83-84`). During a rate-limit storm the
background advisory retries ten times *against the same provider quota the user's
actual work needs*. Round 1 could not fix this because `LLMRequest` carries no
per-request override and the policy is registry-global (IF-3), so it raised its
own timeout to 30 s and absorbed the cost. It turns out no core change is needed:
`initProviders()` is exported and returns a **fresh** registry every call
(`packages/core/src/llm/providers/index.ts:172-178`), so the CLI can give the
reviewer its own registry with a fail-fast policy.

### 1.3 Non-goals

1. **No new capability.** No third tier, no lead-on-fast, no subagent review, no
   persisted review history. Round 1's six non-goals (§1.3 there) all stand.
2. **No budget on delegation.** §3.1.4 argues this positively rather than
   deferring it: budgeting the half that *saves* context would be a bug.
3. **No currency budget**, now or later — D-H1 is a decision, not a staging step.
4. **No `packages/core` change.** W2 is specifically designed around this (§3.2).
5. **No refactor of `controller.ts` / `reducer.ts` / `App.tsx`.** §3.3 states why
   the debt is named here but discharged elsewhere.
6. **No new CLI flag and no new environment variable** — D-14's rule, applied
   (§4.5).

---

## 2. Evidence

Everything below was read in the committed tree at `3f9dbd0f`, not inferred, and
re-verified at review time against `293147d0`.

> **Anchor drift (RV-H11).** Every *claim* in this table verified; a few *line
> numbers* are off by one or two — `DropReason` is at `:115`, `FastSnapshot` at
> `:73`, and `clampFastConfig` at `:945` (`:934` is the comment above it). The
> `wiring.ts:88` anchor is correct but sits inside the exported free function
> `offFastStatus()`, not a `FastWiring` method. Locate by symbol, not by line.

| Claim | Location | Reading |
|---|---|---|
| The review counter is per-run | `fast/reviewer.ts:337` | `this.reviewsThisRun = 0;` inside `beginRun()` |
| It is the only count gate | `fast/reviewer.ts:505-510` | `canReviewAgain()` returns `this.reviewsThisRun < FAST_LIMITS.maxReviewsPerRun` |
| Session usage is tracked but never gates | `fast/reviewer.ts:246`, `:656-658` | `sessionUsage()` is a getter; `this.usage` has no reader other than reporting |
| Spend is reported without a ceiling | `commands/builtins.ts:88-92` | `This session: ${snapshot.reviews} reviews, …` |
| Unpriced models are common and render "unknown" | `builtins.ts:80-87`, C-11 | deliberate, and the reason D-H1 avoids currency |
| `LLMRequest` has no retry override | `core/src/llm/provider.ts:30-55` | fields end at the optional generation parameters |
| Retry policy is registry-global | `core/src/llm/providers/index.ts:52-56` | `setRetryPolicy(policy)` on the instance |
| Default is ten retries | `core/src/llm/retry.ts:83-84` | `maxRetries: 10` |
| `initProviders()` returns a fresh registry | `core/src/llm/providers/index.ts:172-178` | `new ProviderRegistry(options)` per call, three adapters registered |
| The CLI already calls it once | `agent/controller.ts:241` | `initProviders({ retryPolicy: toRetryPolicy(config.retry) })` |
| File sizes against the 1 000-line cap | measured | `reviewer.ts` **871**, `controller.ts` **1 266**, `reducer.ts` **1 416**, `App.tsx` **1 669** |
| `LogScope` is a closed nine-member union | `logging/logger.ts:35-47` | no `fast` |
| Log config filters by **level**, not scope | `config/schema.ts:439-457` | so adding a scope needs no config change |
| Env vars are for launch-time facts only | `config/env.ts:244-250` (D-14) | "tuning a review cadence does not [pass that test]" |

---

## 3. Technical design

### 3.1 W1 — the session review budget

#### 3.1.1 The counter already exists — do not add a second one

The obvious implementation is a new `reviewsThisSession` field beside the per-run
one. **Do not write it.** `FastReviewer.reviewIndex` is already exactly that
counter:

```ts
// reviewer.ts:241-244
/** Reviews STARTED this session, for `/fast status` and `FastSnapshot`. */
reviewCount(): number {
  return this.reviewIndex;
}
```

`reviewIndex` is incremented at `:541` (`const index = (this.reviewIndex += 1)`),
inside `runReview()`, and — unlike `reviewsThisRun` at `:337` — it is **never
reset**. It is already session-scoped, already counted at **start** rather than
at success, and already the number `/fast status` prints. So W1's gate is a
comparison against a value that exists, and the new field count for this whole
item is **one** (`budgetAnnouncedAt`, §3.1.3).

This is not a micro-optimisation, it is the difference between a budget that can
lie and one that cannot. A parallel `reviewsThisSession` would be a second
answer to "how many reviews has this session run", incremented on an adjacent
line by a different author's next edit, and the first time the two drift the
product shows `12/40` in the status line while suppressing at 40 of a number
nobody can see. Reusing `reviewIndex` makes the gate's left-hand side and the
status line's numerator **the same expression**, so they cannot disagree.

Counting at start rather than at success is inherited, and it is the right
direction: counting completions would let a misconfigured tier that times out
every time run forever against a budget that never advances — the failure mode
most likely to coincide with a provider that charges for the attempt anyway.

`beginRun()` (`:327-342`) is **not** touched, and the comment on
`reviewsThisRun`'s reset there gains one clause saying that the session counter
is deliberately not reset beside it. Without that clause the next reader tidies
the two counters into one reset and silently removes the budget.

#### 3.1.2 Where it is enforced, and where it is announced

The budget is checked in `maybeStartReview()` (`:512-522`), **after** the cadence
test and before `runReview()`:

```ts
private maybeStartReview(): void {
  if (!this.canReviewAgain()) return;              // unchanged
  if (this.inFlight || this.pending !== null) return;  // unchanged
  const cadence = Math.max(1, this.deps.getConfig().reviewEveryTurns);
  if (this.turns === 0 || this.turns % cadence !== 0) return;  // unchanged
  if (this.reviewIndex >= this.budgetLimit()) {        // NEW - §3.1.1
    this.announceBudgetReached();
    return;
  }
  void this.runReview(this.turns);
}

/** Live, so `/fast budget <n>` takes effect on the next sealed frame. */
private budgetLimit(): number {
  return this.deps.getConfig().reviewMaxPerSession;
}
```

Two placement decisions, both load-bearing:

**It is not in `canReviewAgain()`.** That function is a predicate with three
other callers' worth of expectation on it, and the announcement is a side effect.
A query that emits UI is how a status read starts writing to the transcript.

**It is after the cadence gate, not before.** This is the entire difference
between one notice and one notice *per turn*. A session that has exhausted its
budget still seals a frame on every turn and still calls `maybeStartReview()`
every time; gating before the cadence test would evaluate the budget on all of
them. After it, the check runs only on turns where a review **would actually have
started**, so the notice is tied to a real suppressed review rather than to the
clock. The user is told at the first moment the budget costs them something.

#### 3.1.3 The exhaustion latch

Announcing once is not the same as announcing once *ever*: `/fast budget 80`
must make the tier live again, including its ability to tell you when *that*
budget is reached.

```ts
/** The limit at which exhaustion was last announced; `-1` = not announced.
 *  Keyed on the LIMIT, not on a boolean, so raising the budget re-arms the
 *  notice without a second latch to keep in sync. */
private budgetAnnouncedAt = -1;

private announceBudgetReached(): void {
  const limit = this.budgetLimit();
  if (this.budgetAnnouncedAt === limit) return;
  this.budgetAnnouncedAt = limit;
  this.deps.notify(
    'info',
    `Fast reviews: session budget reached (${limit}). ` +
      `Delegation is unaffected. Raise it with /fast budget <n>.`,
  );
  this.log.info('fast_review_budget_reached', { limit });
}
```

**There is no transcript card, and that is a correctness requirement, not a
styling choice.** Round 1's R-8 ("it did nothing" is never the observable
outcome) governs a review that *started*: every such path emits a `FastReview`
via `emitReview()`, which carries an `index`, and indices come from
`this.reviewIndex += 1`. A suppressed review never started and has no index.
Minting one to hang a card on would increment the exact counter that
`reviewCount()` returns and `/fast status` renders as the numerator — so the
first suppression would display **`41/40`**, and every later one would push the
numerator further past a limit it is being compared against. The user-facing
surface for suppression is therefore the notice plus the `n/N (budget reached)`
status line (§4.3), both of which read the counter without moving it.

For the same reason the module-private `DropReason` union (`reviewer.ts:116`)
and its `DROP_DETAIL` map (`:865`) are **not** extended: nothing is dropped here.
All five existing members describe a review that was in flight or pending.

Four properties this shape buys, each of which a simpler one loses:

1. **It is `info`, not `warn`.** D-24 reserves the alarming register for a
   *misconfigured* tier, because that is the case that never fixes itself. A
   budget reached is the system working as configured. Warning here would train
   the user to ignore the register that matters.
2. **`consecutiveFailures` is untouched.** A budget stop is neither a success
   that clears the strike counter nor a failure that raises it — the exact
   distinction IF-7 was filed for, applied to a second cause. Round 1 got this
   wrong once for cancellation; this round must not reintroduce it for budget.
   AC-H6 pins it.
3. **`selfDisabled` is untouched.** The reviewer is not broken and must revive
   the moment the budget rises. `budgetLimit()` reads live config, so raising it
   takes effect on the next sealed frame with no restart and no re-resolution.
4. **It says what is *not* affected.** "Delegation is unaffected" is one clause
   that prevents the reasonable wrong inference that the fast tier just switched
   off.

Because no card is emitted (above), C-5's monotonic-settled-boundary hazard is
not reached at all: the transcript gains no entry that could fail to settle. The
notice goes through the same `deps.notify` channel round 1 already uses for the
tier's other one-line messages.

#### 3.1.4 Why delegation is deliberately not budgeted

Stated positively, because "we didn't get to it" and "it would be wrong" look
identical in a spec that omits the paragraph.

Delegation is **user-initiated within a run** (the lead chose it, in service of a
message the user sent), **already bounded** (`team.maxSubagents: 5`,
`team.maxConcurrent: 3` per dispatch), and **cost-reducing by construction** — a
fast child exists so that a 240 KB file body is summarised into the lead's
context instead of pasted into it. Capping it would make the tier fall back to
main-model children, which costs *more*, in the name of spending less. The budget
therefore applies to exactly the class of call the user did not ask for, and the
notice says so.

### 3.2 W2 — a dedicated provider registry for background calls

**The problem.** `FastReviewerDeps.complete` (`reviewer.ts:78`) is wired to the
controller's registry, built at `controller.ts:241` with the user's `retry`
config. `ProviderRegistry.complete()` routes through a retrying `stream()`, the
policy is per-registry, and `LLMRequest` has no override — so the reviewer
inherits up to ten attempts with backoff. During the one condition where the fast
tier is most likely to be failing (a rate-limited or overloaded provider), the
background advisory competes with the foreground for the same quota.

**The fix, with no core change.** `initProviders()` is exported from
`@aragon-agent/core` and constructs a fresh `ProviderRegistry` per call with all
three adapters registered. `FastWiring` builds a second one, lazily:

```ts
/** One retry, not ten and not zero (D-H3). Zero loses a review to a single
 *  connection reset; ten is what makes a background advisory compete with the
 *  user's own work for a rate-limited provider's quota. */
const FAST_RETRY_POLICY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 1 };

private fastRegistry: ProviderRegistry | null = null;

/** Lazy: OFF STAYS BYTE-IDENTICAL (I-2). Nothing is constructed until a tier
 *  resolves `ok` AND `review` is on, so a session that never uses the tier
 *  allocates nothing and registers no adapters. */
private getFastRegistry(): ProviderRegistry {
  if (this.fastRegistry === null) {
    this.fastRegistry = initProviders({ retryPolicy: FAST_RETRY_POLICY });
    this.log.info('fast_registry_created', { maxRetries: FAST_RETRY_POLICY.maxRetries });
  }
  return this.fastRegistry;
}
```

The reviewer's `complete` dep is bound to this registry instead of the
controller's. **Nothing else changes inside `reviewer.ts`** — it already receives
`complete` by injection, so no code there learns that a second registry exists.
That is the whole reason the dep was injected.

`FastWiringDeps.complete` (`wiring.ts:58`) is **kept, and becomes unused by the
review path** (RV-H6). Its only consumer today is the forward at `:128`, which is
the line W2 replaces. Deleting the dep would be tidier and is deliberately not
done: the field is populated at `FastWiring`'s construction site inside
`controller.ts`, and removing it means editing a file §6 commits to leaving alone
for a cosmetic gain. It is annotated in place —

```ts
/** NOT the reviewer's transport since round 2 (W2 / §3.2): the reviewer calls
 *  through `getFastRegistry()`, which is fail-fast and does not observe the
 *  user's `/retry`. Retained because the only alternative is a `controller.ts`
 *  edit that §6 forbids; the next caller that needs the LEAD's registry from
 *  here already has it. Do not "clean up" without reading §3.2. */
complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
```

— so that AC-H17's check is against a documented decision rather than a leftover.

**Consequences, all intended:**

- `FAST_LIMITS.reviewTimeoutMs` drops **30 000 → 20 000**, not to 12 000
  (RV-H2 / D-H11). The 30 s figure exists as IF-3's fallback: a budget for
  `attempts × (call + backoff)` with attempts up to eleven, and with two attempts
  that term collapses to roughly one call plus a ~1 s first backoff. But the
  retry term is not the only one in the budget, and dropping `maxRetries` does
  nothing to the other: **the fast model's own generation latency**. The review
  asks for up to 512 output tokens (`limits.ts:47`) against a 4 000-char digest,
  and the tier is by construction pointed at the cheapest endpoint the user has —
  the population where a 15-25 s completion is ordinary rather than pathological.
  Because a timeout is a strike (`:571`) and `maxConsecutiveFailures` is 3, a
  12 s bound would convert *slow but healthy* into a tier that self-disables for
  the session and reports itself as misconfigured, which is the one register D-24
  reserves for faults that never self-heal. 20 s keeps a comfortable margin over
  a slow completion, still cuts a stuck review's occupancy of the single-flight
  slot by a third, and leaves AC-H14's timeout-is-a-strike rule intact rather
  than trading it away. If field data later shows p99 review latency well under
  12 s, lowering it is a one-constant change with a manual row already written
  for it (§7.3 row 6).
- **The timeout is authoritative over the retry layer's sleep, and that is not
  automatic** (RV-H12). `FAST_RETRY_POLICY` spreads `DEFAULT_RETRY_POLICY`, so it
  inherits `respectRetryAfter: true` and `maxElapsedMs: 240_000`; and a
  `Retry-After` is applied with `Math.max` **after** the `maxDelayMs` clamp
  (`retry.ts:316-324`), so one honoured retry may ask to sleep up to the 60 s
  `retryAfterCeilingMs`. Two existing properties are what stop that from pinning
  the single-flight slot for a minute: `defaultSleep` resolves on either the
  timer or the signal's `abort` (`retry.ts:417-427`, guard G2), and the reviewer
  already passes `signal: controller.signal` into the `LLMRequest`
  (`reviewer.ts:589`), which `ProviderRegistry.stream()` forwards into `withRetry`
  (`providers/index.ts:100-105`). Both are inherited, neither is modified here,
  and W2's timing guarantee rests on them — so a future change to either is a
  change to this design.
- The fast registry does **not** observe the user's `retry` config or `/retry`.
  This is deliberate and is the point of the change, not an oversight: the
  foreground policy is a statement about how hard to fight for *the user's*
  answer. It is logged at construction so a support reader can see it.
- `TRANSIENT_ERROR_TYPES` handling is unchanged — a `rate_limit` or `overloaded`
  still does not increment `consecutiveFailures` (IF-3). With fail-fast this
  matters *more*, since fewer retries means transients surface more often; the
  strike counter must keep ignoring them or W2 would cause the self-disable that
  round 1 worked to prevent.
- Provider coverage is identical: `initProviders()` registers Anthropic, OpenAI
  and Google, which is exactly what `isAdapterProvider` gates on in
  `resolveFastTier` rule 4.

### 3.3 W3 — splitting `reviewer.ts`, and the file-cap debt

`reviewer.ts` is **871** lines against this repo's 1 000-line cap. W1 adds ~45
and W2 ~5, landing at ~921 — under the cap but with 8 % headroom, which is not a
margin, it is a countdown. The split happens in this round, before the additions,
so that the round that needs the room is the round that makes it.

| New file | Holds | Est. |
|---|---|---|
| `fast/frames.ts` | `TurnFrame`, the bounded ring, `recordDelta` / `onTurnEnd` / `onToolEnd` / `sealFrame`, the `toolArgs` map, `maxFramesRetained` trimming | ~250 |
| `fast/review-call.ts` | Request construction, the timeout timer, failure classification against `TRANSIENT_ERROR_TYPES`, usage accumulation | ~280 |
| `fast/reviewer.ts` (remainder) | Event subscription, run lifecycle, **the drain-confirmation guards**, **the call-cancellation protocol**, pending/staleness, the budget | ~400 |

**The first constraint that governs where the line is drawn:** `awaitingDrain`,
`awaitingReviewIndex`, `recoverStranded()` and the two abort guards of §3.5.4a
**stay in `reviewer.ts`, together, and do not move to either new file.** Round
1's review verdict closes with the sentence that a second design review is
warranted only if §3.5.4a changes, "the drain confirmation is the one part of
this document where a 'simplification' reopens a P0". A split that puts half the
P0 guard behind a module boundary is that simplification wearing a refactor's
clothes. The split is drawn along *data* (frames) and *transport* (the call),
both of which are leaves; the *protocol* stays whole.

**The second constraint, and the reason this round has a P0 at all (RV-H1):
`callAbort` and `callAbortReason` stay in `reviewer.ts` too, and
`review-call.ts` must NOT own an `AbortController`.**

This is not a second instance of the same rule, it is a different invariant that
the first one's phrasing does not cover — "transport is a leaf" is exactly the
reasoning that moves the abort controller, and moving it is the bug. The two
fields are shared mutable state *between* the call and the lifecycle:

```
written by the call      reviewer.ts:564-565  (arm)   :571-572 (timeout)   :603-604 (clear)
written by the lifecycle reviewer.ts:280      (cancelCall stamps 'cancelled')
  reached from           :261 abort()   :456 endRun()   :285 dispose()
read by the call         reviewer.ts:595      (the catch, to choose the branch)
```

`review-call.ts` is the natural home for the `new AbortController()` at `:563`,
and encapsulating it there is the obvious tidy-up — which is precisely why it has
to be forbidden in writing. Once the controller is private to the call module,
`cancelCall()` can no longer stamp `'cancelled'` **before** aborting, every
cancelled review falls into the `else` branch at `:597`, and each one scores a
strike. Three ordinary runs reach `maxConsecutiveFailures`, and the tier
self-disables for the rest of the session behind a warn that names a transport
error.

**Round 1 already shipped this exact defect and fixed it as IF-7.** It is not
recoverable at the catch: the retry layer returns silently on abort (`retry.ts:553`,
G3), so a cancellation and a timeout arrive as byte-identical bare `Error`s with
no `errorType`. Recording the reason *at the call site, in state the lifecycle can
reach* is the entire fix, and a module boundary between the two halves deletes it
while every test that does not cancel mid-call stays green.

So `review-call.ts` receives the controller (and the `reviewTimeoutMs` timer it
arms) as parameters and returns the outcome; it does not create, own, or classify
the abort. AC-H16 pins the four symbols to `reviewer.ts` the way AC-H11 pins the
three drain symbols, and test 14 (§7.1) is the behavioural guard: a cancel
mid-call must still leave `consecutiveFailures` untouched after the split.

**The three files this round does not touch.** `controller.ts` (1 266),
`reducer.ts` (1 416) and `App.tsx` (1 669) are all over cap. IF-1 recorded this
as jointly caused by two features developed in one tree and therefore
unattributable; both are now committed, so it is attributable — but it is still
not *this* round's to fix, because the overage in all three is majority
`llm-api-retry-backoff` and majority pre-existing, and refactoring a shared
1 400-line reducer as a side effect of a budget key is how a small change becomes
a merge conflict with the next feature. What this round owes is the negative
commitment, and it is testable: **zero net lines added to any of the three**
(AC-H10). The debt is restated in §8 with a named discharge condition rather than
being quietly re-inherited.

### 3.4 W4 — the `fast` log scope

`LogScope` (`logging/logger.ts:35-47`) gains `| 'fast'`. `FastReviewer.log` and
`FastWiring.log` change from `.child('agent')` to `.child('fast')`, and the two
comments IF-2 left explaining the compromise are replaced with nothing — the
compromise is gone.

This is a three-line change with no config work, because `LogConfig`
(`config/schema.ts:439-457`) filters by **level**, not by scope: there is no
enumerated scope list to keep in sync, which is the usual reason a change like
this is bigger than it looks. The event names (`fast_review_start`,
`fast_review_injected`, `fast_review_stranded`, and the two added here) are
unchanged, so every existing grep in `manual-test.md` still works; the scope makes
them *filterable* rather than merely findable.

### 3.5 Sequence — a session that reaches its budget

Read the trace with `turns` in mind: it is reset by `beginRun()` (`:332`), so
"turn 40" means turn 40 **of the current run**, while "40 reviews this session"
spans every run before it. The two are consistent but not automatic — a 40-turn
run at cadence 5 would ordinarily have *started* 8 reviews and been stopped at 6
by `maxReviewsPerRun`, so the `2 < 6` below is a run in which six cadence hits
were skipped by the single-flight guard. That is the interesting case precisely
because it is the one where the per-run cap is **not** binding and the session
budget is the only thing left (RV-H8).

```
turn 40 OF THIS RUN, cadence 5, budget 40, 40 reviews already started this session
  agent-loop            reviewer                       user surface
  ---------             --------                       ------------
  tool_execution_end -> sealFrame()
                        maybeStartReview()
                          canReviewAgain()      -> true  (per-run: 2 < 6)
                          inFlight/pending      -> false
                          40 % 5 === 0          -> cadence hit
                          reviewIndex(40) >= budgetLimit(40) -> SUPPRESSED
                          announceBudgetReached()
                            budgetAnnouncedAt: -1 -> 40
                            notify('info', ...)   -> ONE notice, no card
                            log.info('fast_review_budget_reached')
                            reviewIndex UNCHANGED -> status still reads 40/40
  turn 45               maybeStartReview()
                          cadence hit, still >= 40
                          announceBudgetReached() -> latched, returns silently
  user: /fast budget 80
                        config write -> onConfigChanged()
  turn 50               maybeStartReview()
                          50 >= 80? NO -> runReview(50)  -> normal review resumes
```

The run-level gate is still checked first and still wins when it is the binding
constraint; the two bounds compose without either needing to know about the
other.

---

## 4. Interface design

### 4.1 Config — one new key in the existing `fast` section

```ts
export interface FastConfig {
  // ... ten existing keys, unchanged ...
  /**
   * Reviews STARTED per session, across all runs. The one bound on spend the
   * user never asked for; `reviewEveryTurns` controls pace, this controls total.
   *
   * DENOMINATED IN REVIEWS, NOT CURRENCY (D-H1): the fast tier is the likeliest
   * place in the product to name a model with no price table, and
   * `buildRuntimeModel` prices those at zero (C-11). A dollar budget would
   * silently never trigger for exactly the configuration that most needs it.
   */
  reviewMaxPerSession: number;
}

// DEFAULT_FAST_CONFIG
reviewMaxPerSession: 40,

const REVIEW_SESSION_RANGE = { min: 1, max: 500 };
```

Default 40: at `reviewEveryTurns: 5` that is 200 reviewed turns, comfortably
past a full working session, while capping the worst case at roughly
`40 × (4 000 chars in + 512 tokens out)` — a number `/fast status` can state.
There is **no** "unlimited" sentinel; `500` is the ceiling and a magic `0` that
means "no limit" is the kind of value that reads as "disabled" to the next person.

Clamped in `clampFastConfig`, which already gates read **and** write (schema.ts
comment at `:934`), so a hand-edited `config.json` value of `9999` becomes 500 on
disk rather than reverting on every launch.

`store.ts`: **no change**. `FastConfig` stays scalars-only one level deep, so both
hand-written merges (C-3) already carry the section wholesale. This is worth
stating explicitly because "add a config key" and "touch both merges" have been
coupled in the last three features — the coupling is to a *new section*, not a
new key.

### 4.2 `/fast budget [n]`

```
/fast budget          -> "Fast review budget: 12 of 40 used this session."
/fast budget 80       -> "Fast review budget: 80 per session. 12 used."
/fast budget 0        -> warn: "Usage: /fast budget <1-500>"
/fast budget abc      -> warn: "Usage: /fast budget <1-500>"
```

Implemented as a verb in the existing `fast` command (`builtins.ts:326-486`),
following `review <n|off>` line for line. **Both** of the mutating calls, in this
order, then the notice (RV-H4):

```ts
// The local `persist()` helper at :341 already does exactly these two.
// Enumerated here because writing only the second is a bug the package has
// seen before: builtins.ts:337-343 - "Persist alone reports success and
// changes nothing until relaunch; the setter alone forgets by morning."
controller.setFastConfig({ reviewMaxPerSession: requested });  // (1) LIVE
ctx.persistConfig({ fast: { reviewMaxPerSession: requested } }); // (2) SURVIVES
```

Call (1) is what makes AC-H4 true and is not optional: `budgetLimit()` reads
`deps.getConfig()`, which resolves to the controller's in-memory config, never to
disk. It also runs `clampFastConfig` on the way through (`controller.ts:1236`) and
then `onConfigChanged()` (`:1241`), which re-emits `tier_changed` with a fresh
snapshot (`wiring.ts:205`) — that emission is how the new denominator reaches the
status chip without a restart. Read the **applied** value back from
`setFastConfig`'s return (it returns the clamped `FastConfig`) and notify with
that rather than with `requested`, so a clamp is visible.

**The mid-dispatch guard needs one edit, not zero.** The condition at `:353` is
`verb && verb !== 'status' && controller.isTeamBusy()`, so leaving it alone would
**refuse** a bare `/fast budget` mid-dispatch — a read, blocked for the same
reason a write is (RV-H3). Grouping the read with `status` is an explicit change
to the condition:

```ts
const isRead = verb === 'status' || (verb === 'budget' && !value);
if (verb && !isRead && controller.isTeamBusy()) { /* refuse, unchanged text */ }
```

`/fast budget 80` — a write — is still refused mid-dispatch, unchanged, for the
reason `/team` records: half a dispatch under one budget and half under another
produces a report nothing can afterwards explain.

The command's `description` string gains `budget <n>`, and so does the unknown-verb
help at `:485` — both are the same literal list and both are user-visible.

### 4.3 `/fast status`

One line changes, from

```
This session: 12 reviews, 3 delegated subagents, in 8.1k / out 2.4k, cost $0.0031.
```

to

```
This session: 12/40 reviews, 3 delegated subagents, in 8.1k / out 2.4k, cost $0.0031.
```

and when exhausted:

```
This session: 40/40 reviews (budget reached - raise with /fast budget <n>),
  3 delegated subagents, in 27.4k / out 8.1k, cost unknown (no price table for glm-4-flash).
```

The `n/N` form is the whole HCI argument for W1's surface: a bare `12` answers
"what have I spent" only if you already know the ceiling, which is precisely what
the user does not know. `12/40` answers "what have I spent" and "how much is
left" in the same three characters, and it makes the budget discoverable to
someone who never read the config schema. The exhausted form names the remedy
inline, because a status line that reports a stop without its escape hatch just
relocates the question.

Note the two facts coexisting on the last line: an exact review count and an
unknown cost. That pairing is D-H1's justification rendered as UI.

### 4.4 Settings screen

One new row in the `fast` group, immediately after `Fast review`, so the pace and
the total sit together. **No new interaction pattern** — but "one row" is the
user-visible half of a six-part edit, and the other five are not optional
(RV-H5). `SettingsScreen.tsx` keeps the row *descriptor*, the *value shape* and
the two *config adapters* in separate places, and a row added to only the first
compiles and then silently never round-trips:

| # | Site | Change |
|---|---|---|
| 1 | `SettingsValues` (`:45-56`) | `fastReviewBudget: string`. The screen edits **text**, by design (`:49`) — the value is a string here and a number only after `readFastSettings`. |
| 2 | Row descriptor list (`:188-191`) | `{ key: 'fastReviewBudget', label: 'Fast review budget', kind: 'text' }`. **There is no numeric `kind`**: the union is `'enum' \| 'text' \| 'secret'` (`:89`). The model to copy is `maxTokens` (`:184`) / `fastReview` (`:191`), both `'text'` rows that parse in the adapter. |
| 3 | `readFastSettings` (`:151`) | Parse and clamp into the patch. An unparseable or out-of-range entry resolves through `clampFastConfig`'s `REVIEW_SESSION_RANGE`, i.e. it behaves exactly as a hand-edited `config.json` would (§4.1) — no second validation policy. |
| 4 | `fastSettingsFrom` (`:168`) | Seed the row: `fastReviewBudget: String(fast.reviewMaxPerSession)`. Omitting this is the silent half — the row renders empty and an untouched save writes the clamp's default over the user's value. |
| 5 | The two `Pick<SettingsValues, …>` unions (`:114`, `:151`, `:168`) | Extend. `fastTierLine` (`:113`) does **not** need the new key and does not get it: the derived line describes what the tier *is*, not what it is allowed to spend. |
| 6 | The four "the four fast rows" comments (`:105`, `:138`, `:167`, `:186`) | Now five. `:186` also carries the layout rationale (the fast group sits between `Max tokens` and `API key` so the key row is not buried) — that rationale survives a fifth row, but the count in it does not. |

The range hint `1-500` rides in the label's help text the way the other bounded
text rows do; it is not a new affordance.

### 4.5 No new flag, no new environment variable

D-14 (`config/env.ts:244-250`) states the package's rule verbatim: an environment
variable exists only where a flag **and** a config file are both unreachable — a
container, an ssh session, being spawned by another tool — and it names
"tuning a review cadence" as a case that fails the test. A session review budget
is the same class of value: set once, persisted, never the thing that differs
between two invocations of the same install. Adding `ARAGON_FAST_REVIEW_BUDGET`
would be a fifth place for the value to disagree with itself.

The four existing vars (`ARAGON_FAST`, `_PROVIDER`, `_MODEL`, `_BASE_URL`) and
the four flags are unchanged.

---

## 5. Data model

**Persisted** (`config.json`, section `fast`) — one added scalar:

```jsonc
{ "fast": { /* ...10 existing... */ "reviewMaxPerSession": 40 } }
```

Absent on every existing user's disk, which is why `DEFAULT_FAST_CONFIG` supplies
it and `clampFastConfig` repairs it — the same path that gave every pre-feature
user a `fast` section at all (schema.ts `:1100-1104`).

**Runtime** (`fast/types.ts`):

The type is `FastSnapshot` (`types.ts:74`) — there is no `FastStatusSnapshot`,
and `DropReason` lives module-private in `reviewer.ts:116`, not here. Two fields
are appended; the eight existing ones are untouched:

```ts
export interface FastSnapshot {
  live: boolean;
  model: string;
  sameAsMain: boolean;
  reviews: number;          // = reviewer.reviewCount() = reviewIndex (§3.1.1)
  reviewBudget: number;     // NEW - the live limit, for the n/N render
  budgetReached: boolean;   // NEW - derived once here, not re-derived by callers
  delegated: number;
  usage: TokenUsage;
  pricingUnknown: boolean;
  inFlight: boolean;
}
```

Both are populated in `FastWiring`'s snapshot builder (`wiring.ts:286`, beside
the existing `reviews: this.reviewer.reviewCount()`), so the numerator, the
denominator and the reached-flag are read in **one expression** and cannot
describe different moments. `budgetReached` is carried rather than left to
`formatFastStatus` to compute, so the status line and any future consumer agree
by construction.

The zero-value snapshot inside the exported `offFastStatus()` (`wiring.ts:79-95`,
the tier-off placeholder — a free function, not a `FastWiring` method) gains
`reviewBudget: 0, budgetReached: false` — the object is a struct literal assigned
to a typed field, so omitting them is a compile error rather than a silent
`undefined`.

`0` there is a placeholder for "there is no tier", not a limit, and it is the one
place where re-deriving the flag would give the wrong answer: `reviews >=
reviewBudget` is `0 >= 0` → `true`, contradicting the `budgetReached: false`
beside it (RV-H10). That is not a defect to fix by picking a different sentinel —
`40` would be a lie about a session that has no tier — it is the reason
`budgetReached` is carried at all. The rule goes on the field so the next
consumer reads it where they need it:

```ts
/** Whether the session budget is exhausted. CARRIED, NOT DERIVED: callers MUST
 *  NOT recompute `reviews >= reviewBudget`. In `offFastStatus()` both numbers
 *  are 0 placeholders for "no tier", and that comparison would report a budget
 *  reached for a session that never had one (RV-H10). */
budgetReached: boolean;

**Reviewer state** (private, not persisted): **one** new field,
`budgetAnnouncedAt: number`. The counter it is compared against is the existing
`reviewIndex` (§3.1.1). Both survive `beginRun()`.

**Not persisted:** review counts reset when the process does. A budget that
survived restart would need a session identity the CLI does not have, and
"restart to reset" is a comprehensible rule.

---

## 6. File / module change plan

### New files

| File | Intent |
|---|---|
| `packages/cli/src/fast/frames.ts` | Turn-frame ring extracted from `reviewer.ts`: type, append, tail-clip, `maxFramesRetained` trim, `toolArgs` map. |
| `packages/cli/src/fast/review-call.ts` | The bounded review call extracted from `reviewer.ts`: request build, timeout, abort-reason stamping, failure classification, usage accumulation. |
| `packages/cli/src/__tests__/fast-budget.test.ts` | W1's behaviour: enforcement, single announcement, latch re-arming, no strike, delegation unaffected. |
| `packages/cli/src/__tests__/fast-registry.test.ts` | W2: the reviewer's registry is separate and fail-fast; the lead's policy is untouched. |
| `docs/plans/fast-model-tier-hardening/spec.md` | This document. |
| `docs/plans/fast-model-tier-hardening/manual-test.md` | Authored with the implementation; rows in §7.3. |

### Modified files

| File | Change |
|---|---|
| `packages/cli/src/config/schema.ts` | `FastConfig.reviewMaxPerSession`, its default, `REVIEW_SESSION_RANGE`, clamp in `clampFastConfig`. |
| `packages/cli/src/fast/limits.ts` | `reviewTimeoutMs` 30 000 → **20 000** (RV-H2 / D-H11) with the rationale rewritten from IF-3's retry budget to W2's two terms — retries *and* the fast model's own generation latency, which `maxRetries` does not shrink; bump `FAST_BLOCK_VERSION` only if prompt wording changes (it does not — so it does **not** move). |
| `packages/cli/src/fast/types.ts` | `FastSnapshot += reviewBudget, budgetReached`. `DropReason` is **not** here and is **not** extended (§3.1.3). |
| `packages/cli/src/fast/reviewer.ts` | Remove what moves to `frames.ts` / `review-call.ts`; add `budgetAnnouncedAt`, `budgetLimit()`, `announceBudgetReached()`, the `reviewIndex >= budgetLimit()` gate in `maybeStartReview()`; one clause on the reset comment in `beginRun()`. **No new counter** (§3.1.1). **Drain guards stay. `callAbort` / `callAbortReason` / `cancelCall()` stay** (§3.3, RV-H1). |
| `packages/cli/src/fast/wiring.ts` | `FAST_RETRY_POLICY`, lazy `getFastRegistry()`, bind the reviewer's `complete` dep to it, annotate the now-unused `FastWiringDeps.complete` (§3.2, RV-H6); **both** snapshot sites gain `reviewBudget` + `budgetReached` — the live builder (`:280`) and the `offFastStatus()` placeholder (`:79-95`). One row, not two (RV-H9). |
| `packages/cli/src/commands/builtins.ts` | `budget` verb (both mutating calls, §4.2 / RV-H4); the `isRead` widening of the mid-dispatch guard at `:353` (RV-H3); `n/N` + exhausted clause in `formatFastStatus`; two help literals (`description` at `:327-329`, unknown-verb text at `:484-485`). |
| `packages/cli/src/ui/entries/FastCard.tsx` | **No change.** Suppression emits no card (§3.1.3). Listed here so its absence is a decision on the record rather than an omission. |
| `packages/cli/src/logging/logger.ts` | `LogScope += 'fast'`. |
| `packages/cli/src/ui/overlays/SettingsScreen.tsx` | The six-part row addition of §4.4: `SettingsValues` key, `'text'` row descriptor (**no numeric kind exists**), `readFastSettings` parse, `fastSettingsFrom` seed, two `Pick<>` unions, four "four fast rows" comments (RV-H5). |
| `packages/cli/src/__tests__/fast-reviewer.test.ts` | Update imports for the split; add the no-strike-on-budget case. |
| `packages/cli/src/__tests__/fast-config.test.ts` | Clamp cases for the new key; default round-trip. |
| `packages/cli/src/__tests__/glyphs.test.ts` | **No change** — `src/fast/` is already `inScope` (AC-27), which is what makes two new files in that tree automatically scanned. Verify, do not edit. |

### Explicitly not touched

`packages/core/**` (C-1 — W2's whole design is this constraint's consequence);
`agent/controller.ts`, `agent/reducer.ts`, `ui/App.tsx` (§3.3, AC-H10);
`config/env.ts`, `config/flags` (§4.5); `config/store.ts` (§4.1);
`team/**`, `todo/**`.

---

## 7. Testing & acceptance criteria

### 7.1 Unit tests (Vitest, offline, no network)

`fast-budget.test.ts`

1. With `reviewMaxPerSession: 2`, three runs each hitting cadence start exactly
   **2** review calls.
2. `beginRun()` does not reset the session counter: two runs of one review each,
   with the budget at 2, leave the third suppressed.
3. Exhaustion emits **one** `notify` across five subsequent cadence hits, and
   **no** `review_end` event (no card — §3.1.3).
3a. Suppression does not advance `reviewCount()`: at budget 2, after five further
   cadence hits, `reviewCount()` is still exactly `2`, so `/fast status` renders
   `2/2` and never `3/2`. **This is the regression guard on §3.1.1** — it fails
   the moment someone mints an index for a suppressed review.
4. Raising the budget via config re-arms: after `/fast budget 4`, the next cadence
   hit calls `complete()` and a later exhaustion announces again.
5. Suppression does **not** touch `consecutiveFailures` — three suppressions then
   one genuine transport failure leaves the reviewer alive (strike count 1).
6. Suppression does **not** set `selfDisabled`.
7. The announcement fires only on a turn where cadence was hit (turns 1-4 at
   cadence 5 produce no notice).
8. Delegation is unaffected: with the budget exhausted, a `task` spec carrying
   `model: 'fast'` still resolves to `tier: 'fast'`.

`fast-registry.test.ts`

9. The reviewer's `complete` does not go through the controller's registry
   (spy on both).
10. The fast registry's policy is `maxRetries: 1`; the controller's is whatever
    `config.retry` says, unchanged by the reviewer existing.
11. The registry is **not** constructed when the tier is off or `review: false`
    (lazy — the byte-identity guarantee).

`fast-config.test.ts` (extended)

12. `reviewMaxPerSession` clamps `0 → 1`, `9999 → 500`, `'x' → 40`, and the
    clamped value is what `updatePersistedConfig` writes.

`fast-reviewer.test.ts` (extended, after the split)

13. All existing cases pass unchanged against the split modules — this is the
    regression guard on §3.3, and the split is not done until they do.
14. **A cancellation is still not a strike, after the split.** Start a review,
    then call `abort()` (and, as separate cases, `endRun()` and `dispose()`)
    while the `complete` stub is still pending; assert the reviewer emits a
    `dropped` card and that `consecutiveFailures` is **unchanged**, then assert a
    subsequent genuine transport failure raises it to exactly 1. **This is the
    behavioural guard on RV-H1** — it is the round-1 IF-7 case re-pinned across
    the new module boundary, and it fails the moment `review-call.ts` owns its
    own `AbortController`. Round 1's rule applies: write it before the split and
    confirm it passes on the pre-split code, so a green result after the split
    means something.
15. **A timeout still is a strike, after the split** — the same setup with the
    timer firing instead of a cancel raises `consecutiveFailures` by 1. Pairs
    with 14: together they prove the two paths are still distinguishable, which
    is the property the retry layer's silent-on-abort return (`retry.ts:553`)
    makes impossible to recover from the error object alone.

### 7.2 Acceptance criteria

| # | Criterion |
|---|---|
| AC-H1 | A session started with the tier on and `review: true` starts at most `reviewMaxPerSession` review calls, regardless of run count. |
| AC-H2 | The budget is enforced after the cadence test, so a suppressed session produces one notice, not one per turn. |
| AC-H3 | Exhaustion is `info`, names the remedy, states that delegation is unaffected, and emits **no** transcript card. |
| AC-H3b | Suppression never advances `reviewCount()`, so the status numerator can never exceed the budget (`2/2`, never `3/2`). Guards §3.1.1's single-counter rule. |
| AC-H4 | Raising the budget mid-session resumes reviews with no restart. |
| AC-H5 | Lowering the budget below the current count suppresses immediately and announces once. |
| AC-H6 | Budget suppression changes neither `consecutiveFailures` nor `selfDisabled`. |
| AC-H7 | `/fast status` renders `n/N`, and the exhausted form names `/fast budget`. |
| AC-H8 | `/fast budget` reports; `/fast budget <n>` clamps to 1-500, persists, and reports the **applied** value. |
| AC-H9 | The reviewer's calls use a registry with `maxRetries: 1`; the lead's registry and its policy are unchanged. |
| AC-H10 | `controller.ts`, `reducer.ts` and `App.tsx` have **zero net added lines**; every file under `src/fast/**` is ≤ 1 000, and `reviewer.ts` is ≤ 600 after the split. |
| AC-H11 | The §3.5.4a drain guards (`awaitingDrain`, `awaitingReviewIndex`, `recoverStranded`) are all still in `reviewer.ts`. |
| AC-H12 | `getLogger().child('fast')` compiles; `fast_*` records carry `scope: 'fast'`. |
| AC-H13 | With `fast.enabled: false`, the diff is inert: no registry, no counters, no config read beyond the default section — byte-identical to round 1's off path. |
| AC-H14 | `reviewTimeoutMs` is **20 000** (RV-H2), a timeout is still a strike, and a cancellation still is not (IF-7's distinction survives both W2 and the split). |
| AC-H15 | Full suite green: both `packages/cli` tsconfigs `tsc --noEmit` clean, all tests pass, `npm run build` green. |
| AC-H16 | `callAbort`, `callAbortReason`, `cancelCall()` and the `new AbortController()` are all still in `reviewer.ts`; `review-call.ts` contains no `AbortController` construction. Guards RV-H1's P0 the way AC-H11 guards the drain protocol. |
| AC-H17 | `/fast budget <n>` takes effect **without a restart** (it calls `controller.setFastConfig` as well as `ctx.persistConfig`), and bare `/fast budget` is answerable mid-dispatch while `/fast budget <n>` is still refused (RV-H3 / RV-H4). |
| AC-H18 | The settings row round-trips: `fastSettingsFrom(config).fastReviewBudget` renders the persisted value, an untouched save preserves it, and an out-of-range entry lands clamped — no key left seeded-but-unread (RV-H5). |

### 7.3 Manual test rows (`manual-test.md`)

1. Set `reviewMaxPerSession: 2`, `reviewEveryTurns: 1`; send four messages;
   confirm two review cards, exactly one notice, and **no third card**; then
   `/fast status` reads `2/2 reviews (budget reached ...)`.
2. `/fast budget 6`; send another message; confirm reviews resume.
3. `/fast status` before, during and after exhaustion; confirm `n/N` and the
   remedy clause.
4. With an unpriced fast model, confirm `12/40 reviews` and `cost unknown (…)` on
   the same line.
5. With the budget exhausted, dispatch a `task` with `model: "fast"`; confirm the
   child still runs on the fast tier.
6. Point the fast tier at an unreachable `baseUrl`; confirm the review fails
   fast (a refused connection resolves in well under a second even with the one
   retry) and that three failures still self-disable with the round-1 message.
   Then the case that sets the bound: point it at a **reachable but slow** model
   and confirm a review that takes ~15 s still **succeeds** rather than being
   timed out and scored as a strike (RV-H2). If this row is ever observed to
   take the full 20 s on healthy hardware, that is the datum for lowering
   `reviewTimeoutMs`, not a reason to lower it in advance.
6a. Cancel a review in flight three times (Esc mid-turn, then a turn that ends
   the run with a review open, then quit) and confirm the tier is **still
   alive** — `/fast status` does not report it disabled and no warn appears.
   This is IF-7's manual counterpart and the human-visible form of AC-H16; it is
   the row that catches a bad split when the unit test was written to match the
   implementation rather than the invariant.
7. `--log-scope`-equivalent grep: confirm `fast_review_*` records carry
   `scope: "fast"`.
8. `fast.enabled: false`: confirm no `fast` output anywhere and no registry line
   in the log.

---

## 8. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| **R-H1** | The default of 40 is too low for a genuinely long session, and a user loses reviews they wanted. | It announces itself, names the remedy, and is raisable live to 500 without restart. The failure is visible and one command from fixed — unlike the current failure, which is invisible and on the invoice. |
| **R-H2** | The split of `reviewer.ts` moves part of the P0 drain guard and reopens the round-1 P0. | AC-H11 asserts the three symbols are still in `reviewer.ts`; the split line is drawn along data and transport only; test 13 requires every existing reviewer case to pass unchanged before the split is considered done. |
| **R-H3** | A second registry doubles adapter state or leaks between tiers. | Adapters are stateless and constructed per registry by `initProviders()`; the fast registry is lazy and private to `FastWiring`, and is dropped for collection when the wiring is (`ProviderRegistry` holds no handles and exposes no `dispose()`; `FastWiring.dispose()` at `:267` disposes the reviewer and clears listeners — RV-H7). AC-H9 spies on both to prove no crossover. |
| **R-H10** | The split relocates the abort controller into `review-call.ts` as a natural encapsulation, and every cancelled review is scored as a strike — round 1's IF-7, verbatim. | The P0 of this review. §3.3's second constraint forbids the move in writing and says why the tidier shape is wrong; AC-H16 pins the four symbols structurally; tests 14/15 pin the behaviour from both directions and are written before the split; manual row 6a is the human-visible form. The failure is silent and session-long, so it gets four independent guards rather than one. |
| **R-H11** | 20 s is now too *long*, and a genuinely stuck review holds the single-flight slot for a third of a minute. | Accepted, and it is the cheaper direction to be wrong in: the cost is one skipped review, versus a self-disabled tier misreported as misconfigured (RV-H2). The slot is per-run and the run cap is 6, so the worst case is bounded; §7.3 row 6 is written to produce the datum that would justify lowering it. |
| **R-H4** | Fail-fast makes transient failures reach the strike counter more often and self-disables a healthy tier. | `TRANSIENT_ERROR_TYPES` already excludes `rate_limit` / `overloaded` from strikes (IF-3) and is explicitly retained; AC-H14 keeps the timeout-is-a-strike case so the exclusion is not over-widened. |
| **R-H5** | The exhaustion latch keys on a limit value, so an oscillating budget (40 → 80 → 40) re-announces. | Correct behaviour, not a defect: each transition back into exhaustion is a new suppression the user caused. Documented at the field. |
| **R-H6** | Counting at start means a review that fails before sending still consumes budget. | Deliberate (§3.1.1): counting completions lets a tier that fails every call run unbounded. The alternative loses the budget's only guarantee. |
| **R-H7** | `controller.ts` / `reducer.ts` / `App.tsx` stay over cap, and this round's spec normalises that. | Named here with a discharge condition rather than re-inherited silently: the next change to each owes the extraction, and AC-H10 makes this round's non-contribution mechanically checkable. |
| **R-H8** | `reviewBudget` on the snapshot drifts from config. | It is read from live config at snapshot construction, in the same expression as `reviews`; `formatFastStatus` is forbidden from reading config for the limit (§5). |
| **R-H9** | A future round adds a currency budget "for completeness" and reintroduces the zero-price lie. | D-H1 is recorded as a decision with C-11 as its evidence, not as a deferral. |

---

## 9. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D-H1** | The budget is denominated in **reviews**, never currency. | C-11: unpriced models price at zero, and the fast tier is where they live. A budget that cannot be computed for the likeliest configuration silently never fires. Per-review cost is already structurally bounded, so a count is an honest ceiling. |
| **D-H2** | Default **40**, range **1-500**, no unlimited sentinel. | 40 ≈ 200 reviewed turns at the default cadence: past a full session, short of a runaway. A magic `0` for "unlimited" reads as "off". |
| **D-H3** | Fast registry retries **once**, not zero and not ten. | Zero loses a review to one connection reset; ten is what makes a background advisory compete with the user's own work for a rate-limited quota. |
| **D-H4** | The fast registry ignores the user's `retry` config. | That policy states how hard to fight for the *user's* answer. Inheriting it for an unrequested call is the bug W2 exists to fix. Logged at construction. |
| **D-H5** | The budget gate sits **after** the cadence test. | Ties the notice to a genuinely suppressed review; before it, the check runs every turn and the notice needs a second latch to stay quiet. |
| **D-H6** | Exhaustion is `info` and touches neither `consecutiveFailures` nor `selfDisabled`. | D-24 reserves the alarming register for misconfiguration, which never self-heals. A budget stop is the system obeying the user, and IF-7 already paid for conflating "not a fault" with "a strike". |
| **D-H7** | Delegation is not budgeted. | User-initiated, already bounded by `team.*`, and cost-*reducing*. Capping it would force main-tier children and raise total spend. |
| **D-H8** | No env var, no CLI flag. | D-14's stated rule, applied to a value that is set once and persisted. |
| **D-H9** | The split is along data (`frames.ts`) and transport (`review-call.ts`); the protocol stays in `reviewer.ts`. | The drain confirmation is the one part of round 1 whose "simplification" reopens a P0; a module boundary through it is exactly that. |
| **D-H10** | `controller.ts` / `reducer.ts` / `App.tsx` are not refactored here. | The overage is majority pre-existing and majority another feature's; discharging it as a side effect of a config key trades a line count for a merge conflict. Named, with AC-H10 as the negative guarantee. |
| **D-H11** | `reviewTimeoutMs` becomes **20 000**, not 12 000. | The timeout budgets two terms, and only one of them shrinks with `maxRetries`: the fast model's own generation latency for 512 tokens is unchanged by W2, and the tier points at the cheapest endpoint the user has. Since a timeout is a strike and three strikes self-disable, a 12 s bound turns "slow but healthy" into "reported as misconfigured" — D-24's alarming register spent on a fault that self-heals. 20 s still cuts stuck-slot occupancy by a third and keeps AC-H14 intact (RV-H2). |
| **D-H12** | The settings row is a `'text'` row parsed in the adapter, not a new numeric row kind. | `SettingsRow.kind` is `'enum' \| 'text' \| 'secret'`; `maxTokens` and `fastReview` are both bounded numbers already living as `'text'` + adapter parse. Adding a fourth kind for one row would be a new interaction pattern in a screen whose whole design is that it edits text (RV-H5). |
| **D-H13** | `FastWiringDeps.complete` is retained-and-annotated rather than deleted. | Deleting it edits `controller.ts`, which §6 commits to leaving untouched, for a cosmetic gain. The annotation carries the reason so the next author does not re-open the question by "cleaning up" (RV-H6). |

---

## 10. Definition of done

1. `docs/plans/fast-model-tier-hardening/spec.md` exists and is reviewed.
2. `reviewMaxPerSession` ships with its default, clamp and range; `/fast budget`
   reports and sets it **through both `setFastConfig` and `persistConfig`**, so
   it is live without a restart (RV-H4); the bare read is answerable mid-dispatch
   (RV-H3); `/fast status` renders `n/N` and the exhausted clause; the settings
   screen has its row **and the five non-visible parts of §4.4** (RV-H5).
3. The session budget is enforced in `maybeStartReview()` after the cadence test
   against the **existing** `reviewIndex` (no second counter, §3.1.1), announced
   once per limit value with a notice and no card, and re-arms when the limit
   rises.
4. The reviewer calls through its own `maxRetries: 1` registry, built lazily;
   `reviewTimeoutMs` is **20 000** (D-H11); the lead's registry is untouched;
   `FastWiringDeps.complete` is retained and annotated (D-H13).
5. `reviewer.ts` is split into three files, all ≤ 600 lines, with the drain guards
   **and the call-cancellation protocol** (`callAbort`, `callAbortReason`,
   `cancelCall()`, the `AbortController` construction) intact in `reviewer.ts`,
   and every pre-existing reviewer test passing unchanged.
6. `LogScope` carries `fast`; both fast loggers use it; IF-2's compromise comments
   are deleted.
7. AC-H1 … AC-H18 all pass, including AC-H3b's counter-inflation guard,
   AC-H10's zero-net-lines, AC-H13's off-is-inert check and **AC-H16's
   cancellation-protocol containment**.
8. `manual-test.md` carries the ten rows in §7.3; rows 1, 5, 6 and **6a** are not
   optional (they cover the budget's enforcement, the delegation asymmetry, the
   slow-model timing bound and the cancellation-is-not-a-strike invariant).
9. IF-1's fast-owned share and IF-2 / IF-3 are marked closed in the round-1 spec
   with a pointer here; IF-1's repo-level remainder is restated as open with
   D-H10 as its owner.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

*(Recorded rather than silently worked around, per the implementation node's
constraint and the round-1 document's convention. Numbered `IF-Hn` so they do not
collide with round 1's `IF-1 … IF-7`, which this document cites by their own
names. Each names what the design said, what the tree contained, and what was
done instead.)*

### IF-H1 — AC-H10's "`reviewer.ts` ≤ 600 after the split" is unreachable inside this design's own constraints

**What the design said.** §3.3 estimates the post-split remainder at ~400 lines
(`frames.ts` ~250 + `review-call.ts` ~280 + remainder ~400), and AC-H10 makes
≤ 600 a pass criterion.

**What the tree contained, measured after the split:**

| file | total | code | comment | blank |
|---|---|---|---|---|
| `fast/reviewer.ts` | **799** | 469 | 273 | 57 |
| `fast/frames.ts` | 197 | 101 | 79 | 18 |
| `fast/review-call.ts` | 168 | 75 | 81 | 13 |

The remainder is **469 lines of code before a single comment**. Reaching 600
would therefore require deleting roughly **75 % of the file's rationale** — and
the rationale is not decoration here: the drain-confirmation paragraphs are what
AC-H11 protects, and the `cancelCall()` / `callAbortReason` paragraphs are what
AC-H16 protects. §3.3 itself argues that a reader who "tidies" those is how the
P0 comes back, so trading them for a line count would defeat the criterion's own
purpose.

The three estimates in §3.3 also do not sum the way a pure move would: 250 + 280
+ 400 = 930 against an 871-line original, i.e. the design already anticipated
~60 lines of split overhead. The realised overhead is larger (two new module
headers that have to *state the prohibition*, the ring's accessor surface, and
W1's own ~70 lines) — none of which is removable without removing the thing it
documents.

**What was done.** The split was performed exactly as §3.3 draws it — data
(`frames.ts`) and transport (`review-call.ts`), with the protocol whole in
`reviewer.ts`. Comments that had become **literal duplicates** of the new
modules' headers were condensed at `callAbortReason` and `cancelCall()`, which is
the only reduction available that does not delete a fact. The rest of AC-H10
holds and was checked mechanically:

- every file under `src/fast/**` is ≤ 1 000 (largest: `reviewer.ts` at 799) — the
  repo rule AC-H10's second clause exists to serve;
- `controller.ts`, `reducer.ts` and `App.tsx` show **zero** lines in
  `git diff --stat` (verdict condition 5).

**What is left.** Getting `reviewer.ts` under 600 needs a **third** module — the
pending-critique concern (`PendingReview`, the staleness test, `dropPending`,
`DROP_DETAIL`) is the natural candidate at ~90 lines. That file is not in §6's
change plan, and the implementation node's constraint forbids introducing files
the design does not list, so it is recorded here for the next round rather than
invented in this one.

### IF-H2 — a fifth `SettingsValues` key forces one unlisted test file to change

**What the design said.** §4.4 enumerates six sites for the new settings row;
§6's "explicitly not touched" list covers `App.tsx`.

**What the tree contained.** `SettingsValues` is a **required-field** interface,
and `max-tokens-ui.test.tsx:110` builds one as an object literal to render the
overlay. Adding `fastReviewBudget` therefore breaks that file at compile time —
a seventh site §4.4 does not list.

**What was done.** One line added to the fixture (`fastReviewBudget: '40'`). No
behaviour of that test changed. `App.tsx` itself needed **no** edit, which is the
design working as intended: it seeds through `...fastSettingsFrom(cfg.fast)` and
saves through `readFastSettings(values)`, so both halves of the round trip
absorbed the new key by spread.

**Left deliberately stale:** `App.tsx:1370`'s comment still reads "The four fast
rows". Correcting one word would put `App.tsx` into `git diff --stat` with an
insertion, which is precisely the mechanical check verdict condition 5 and AC-H10
specify. The authoritative count now lives on `fastSettingsFrom`'s own docstring;
the stale word is the cheaper of the two costs and is recorded rather than fixed.

### IF-H3 — `TurnFrame` stays in `types.ts`; only the ring moved

**What the design said.** §3.3's table lists `frames.ts` as holding
"`TurnFrame`, the bounded ring, …", while §6's `types.ts` row states that file's
only change is `FastSnapshot`.

**What the tree contained.** `TurnFrame` is imported by `digest.ts` as well as by
the reviewer, and `types.ts` is the module whose stated job is "runtime shapes
for the fast tier".

**What was done.** The **type** stayed in `types.ts` and the **ring** moved to
`frames.ts`, which satisfies §6 exactly and leaves `digest.ts` untouched. Moving
the interface would have edited two files for no behavioural gain and made
`digest.ts` — a pure function with no interest in the ring — depend on the module
that mutates it.

### IF-H4 — `errorText` has one home, and it is `review-call.ts`

**What implementation showed.** Both new modules need `unknown -> string`:
`frames.ts` for a `text_delta` stream error, `review-call.ts` for failure
classification. Neither position is obviously superior and a second copy is a
second answer to one question, so it lives with the module that classifies errors
and `frames.ts` imports it. Both are leaves and `review-call.ts` does not import
`frames.ts`, so there is no cycle. Noted because the import reads as odd at first
glance and is a plausible target for a future "tidy-up" that would duplicate it.

### IF-H5 — `aragon config set fast.reviewMaxPerSession` was rejected: §4.1 named one config surface and the package has three

*(Found by the review node, against the implemented tree, and fixed there.)*

**What the design said.** §4.1 is titled "Config — one new key in the existing
`fast` section" and reasons entirely about `config.json`: the default, the range,
`clampFastConfig` gating read and write, and `store.ts` needing no change. §4.5
then argues *against* a flag and an env var, so the change plan's config work is
`schema.ts` and nothing else.

**What the tree contained.** `aragon config set` does not write dotted keys
generically — it cannot, because a generic writer would put `"fast.model"` at the
top level of the file where the section never takes effect. It carries an explicit
allowlist, `FAST_CONFIG_SET_KEYS` (`config/cli-commands.ts:103`), which
`cli.tsx:610` folds into `KNOWN_SET_KEYS`, plus a paired `switch` in
`applyFastConfigSet` (`:252`). A key missing from the list is refused as
`Unknown config key`; a key in the list but missing from the switch prints
`Set fast.x = y` and writes nothing. So the round's one new key reached
`config.json` and `/fast budget` and the settings screen, and was **rejected by
the package's own config CLI** — the surface the README's "Turning it on" section
tells the user to use.

That it was silent is structural: `retry` and `team` each carry a
list-versus-switch parity test (`retry-config.test.ts:236`,
`team-config.test.ts:185`), and `fast` had none. Round 1 shipped ten keys and ten
cases by hand, which works exactly until the eleventh.

**What was done.** The key was added to both halves (one line each, routed
through `clampOne` like every other numeric), and `fast-config.test.ts` gained
the guard the other two sections already had — extended one assertion further,
because a name-parity test is what actually catches this class: every field of
`FastConfig` must have a `fast.<field>` entry, so key twelve cannot be
half-added either. Both new cases were mutation-checked (removing the `switch`
case turns them red) before the fix was kept. `manual-test.md` row 2 gained the
third-surface check.

**The general form, for the next round.** "One new config key" is three edits in
this package, not one: `schema.ts` (the value), `cli-commands.ts` (the CLI
surface), and — if it is user-facing — `README.md` plus `CHANGELOG.md`. §6's
change plan listed only the first, and §6 is the document the implementation node
is told not to exceed.

### IF-H6 — the two shipped documentation surfaces were outside §6, and one of them became false

*(Found by the review node, fixed there.)*

**What the design said.** §6's file plan lists source and tests. It does not list
`packages/cli/README.md` or `packages/cli/CHANGELOG.md`, and §10's definition of
done does not mention them.

**What the tree contained.** Round 1 documented the tier in both, in the same
commit as the code (`3f9dbd0f`: +128 README, +130 CHANGELOG) — and both are
shipped in the npm package (`files` in `package.json`). The README enumerates
every `fast.*` key in a table and every `/fast` verb in a block; the CHANGELOG
entry, still under `Unreleased`, ends with the sentence "Ten `fast.*` config
keys, four flags, four environment variables and a settings-screen row".

So this round did not merely leave the docs behind: it made a shipped sentence
**false** (eleven keys now), while the budget that stops a user's reviews at 40,
the verb that raises it, the `20 s` timeout and the fail-fast registry appeared
nowhere a user reads.

**What was done.** The README gained the key row, the `budget [n]` verb with its
read/write distinction, a paragraph on the session budget and why delegation is
deliberately not budgeted, and the fail-fast policy beside the existing failure
paragraph. The CHANGELOG entry — the feature is unreleased, so this belongs in
the *same* entry rather than in a `Changed` note about something no user has had
— was corrected to eleven keys and five rows and extended with the budget, the
one-retry registry, the cancellation-is-not-a-strike rule and the `fast` log
scope. No new entry was opened.

### IF-H7 — §4.4's label carries a range hint the row has no room for, and the overflow is silent

*(Found by the review node, fixed there.)*

**What the design said.** §4.4 row 2 gives the descriptor literally —
`{ key: 'fastReviewBudget', label: 'Fast review budget', kind: 'text' }` — and
closes: "The range hint `1-500` rides in the label's help text the way the other
bounded text rows do; it is not a new affordance." The implementation followed
that to `'Fast review budget (1-500)'`.

**What the tree contained.** There is no help text. Every row is one truncating
line and the label is padded to a fixed column: `(… f.label).padEnd(18)`
(`SettingsScreen.tsx:368`), value immediately after. `padEnd` does not shorten,
so a label of 18 or more does not truncate and does not wrap — it pushes **its
own** value right while every other row's stays put. At 26 characters the budget
row's value sat eight columns out of line; at exactly 18 it would abut its value
with no gap. And no bounded row carries its range today: `Max tokens` (whose
range is wider and whose clamp is louder) does not, nor does `Fast review`. The
sentence describes a screen this is not.

**What was done.** The label is `Fast budget` — inside the column budget, still
prefixed `Fast` so the group reads as one block, and named after the command that
sets it (`/fast budget`), which is where a user meets the range: the refusal
prints `Usage: /fast budget <1-500>`. The range also stays in the README table
and in `clampFastConfig`, which is the actual enforcement. The rule is now pinned
by a rendering test that asserts every value shares one column
(`max-tokens-ui.test.tsx`), mutation-checked against the 26-character label, and
by a comment at the descriptor. Manual row 9 gained the column check.

**Why a test and not just a shorter string.** The failure mode is that nothing
fails: no wrap, no truncation, no warning — a screen whose whole design is
aligned rows quietly stops having a column. The next hint-in-a-label would land
exactly the same way, and this one arrived from the design document itself.

---

## 评审结论 (Review Verdict)

### 有条件通过 — approved with conditions

The design is sound, correctly scoped, and unusually well grounded: the evidence
table survived a line-by-line re-read, the two structural claims the whole round
rests on (`runReview()` has exactly one call site; `complete` reaches the reviewer
by injection, so `controller.ts` need not change) both hold, and W1's central
insight — that `reviewIndex` *is already* the session counter, so the gate's
left-hand side and the status numerator are the same expression — is the kind of
decision that removes a class of bug rather than fixing an instance. The
right-sizing is right: four items, one new config key, one new field, no new
capability, and three of the four are debts round 1 recorded rather than
discoveries this round invented.

The scope is also correct in what it refuses. Not budgeting delegation (§3.1.4),
not denominating in currency (D-H1), and not refactoring the three over-cap
shared files (D-H10) are each argued positively, with the argument that would be
missing if the real reason were "we ran out of time".

Every P0 and P1 raised above is **resolved in the body of this document**, so
nothing below blocks implementation. The conditions are the things a reviewer can
assert about a document but only an implementer can make true about a tree:

1. **The P0 is a discipline, not a diff (RV-H1 / §3.3 / AC-H16).** The single
   highest-value line in this round is the prohibition on `review-call.ts` owning
   an `AbortController`. It will look like an omission to whoever writes that
   file, because encapsulating a controller with the call it aborts is correct
   everywhere else in this codebase. Write tests 14 and 15 **before** the split
   and confirm they pass on the pre-split code, per the repo's TDD rule — a test
   authored after the split will be written to match whatever the split produced.

2. **Do not lower `reviewTimeoutMs` below 20 000 without the measurement**
   (RV-H2 / D-H11). 12 000 is defensible only if p99 review latency is known, and
   it is not. §7.3 row 6 exists to produce that number. Lowering it silently is
   how a slow-but-healthy tier starts reporting itself as misconfigured.

3. **§4.4's six parts are one unit** (RV-H5 / AC-H18). Parts 1, 2 and 3 alone
   produce a screen that compiles, renders, and quietly writes the default over
   the user's value on the next untouched save. Part 4 (`fastSettingsFrom`) is
   the one that is silent when omitted.

4. **`/fast budget` writes twice** (RV-H4 / AC-H17). `setFastConfig` **and**
   `persistConfig`. This package has a comment about this failure mode sitting in
   the very function the new verb is being added to; do not become its third
   citation.

5. **AC-H10 is checkable and should actually be checked** — `git diff --stat` on
   `controller.ts`, `reducer.ts`, `App.tsx` must show zero added lines. It is the
   only mechanical evidence that D-H10 was honoured rather than drifted from, and
   D-H13 exists specifically to keep `controller.ts` out of the diff.

6. **`manual-test.md` is a deliverable of the implementation node** and is
   currently referenced but absent (§6 lists it as a new file). Rows 1, 5, 6 and
   6a are not optional.

7. **Report anything found during implementation as `IF-n` in a
   「实施过程发现的方案缺陷」 section**, following the round-1 convention. Round 1's
   IF-7 was found that way, and it is the reason this round has a P0 to raise.

No P0 or P1 issues remain open. Cleared for implementation.

---

*Section 「评审记录」 was added by the design-review node; 「实施过程发现的方案缺陷」
is added by the implementation node, following the round-1 document's convention.
IF-H1 … IF-H4 are the implementation node's; IF-H5 … IF-H7 were found by the
code-review node against the implemented tree and fixed there.*
