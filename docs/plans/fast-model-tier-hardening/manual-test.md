# Manual test — fast model tier, round 2 (budget, fail-fast, log scope)

> **Feature:** `fast-model-tier-hardening`
> **Design:** `docs/plans/fast-model-tier-hardening/spec.md` v2 (§7.3)
> **Predecessor rows:** `docs/plans/fast-model-tier/manual-test.md` still apply
> unchanged — this file only covers what round 2 added.

**Rows 1, 5, 6 and 6a are not optional.** They cover, in order: the budget's
enforcement, the delegation asymmetry, the slow-model timing bound, and the
cancellation-is-not-a-strike invariant. Row 6a is the human-visible form of the
P0 this round was written around (RV-H1 / AC-H16); it is the row that catches a
bad `reviewer.ts` split when the unit test was written to match the
implementation rather than the invariant.

## Setup

Two configurations are used. Unless a row says otherwise, start from **A**.

**A — a working fast tier, budget deliberately tiny.** In `<home>/config.json`:

```jsonc
{
  "fast": {
    "enabled": true,
    "model": "claude-haiku-4-5",
    "review": true,
    "reviewEveryTurns": 1,
    "reviewMaxPerSession": 2
  }
}
```

**B — the tier off.** `{ "fast": { "enabled": false } }`.

Logs are at `<home>/logs/`; every row that inspects them greps the current
session's file. `<home>` is `ARAGON_HOME` when set, otherwise the platform
config dir.

---

## 1. The budget stops reviews, once, and says so (AC-H1 / AC-H2 / AC-H3) — REQUIRED

1. Start with configuration **A**.
2. Send four separate messages that each cause at least one tool call
   (`read package.json`, `list the files in src`, …). Each message is one run.

**Pass:**

- Exactly **two** review cards appear in the transcript across the whole session
  — not two per message.
- Exactly **one** notice appears, at `info` level, reading
  `Fast reviews: session budget reached (2). Delegation is unaffected. Raise it
  with /fast budget <n>.`
- No third review card, and **no** card for the suppressed reviews at all.
- No `warn` anywhere, and the tier does not report itself disabled.
- `/fast status` reads `This session: 2/2 reviews (budget reached - raise with
  /fast budget <n>), …`.

**Fail:** a notice on every turn (the gate moved before the cadence test); `3/2`
or higher in the status line (a suppressed review minted an index — AC-H3b); a
`warn` register (D-H6).

## 2. `/fast budget <n>` takes effect without a restart (AC-H4 / AC-H17)

1. Continue from row 1, with the budget exhausted.
2. Run `/fast budget 6`.
3. Send another message that causes a tool call.

**Pass:** the toast reads `Fast review budget: 6 per session. 2 used.`; reviews
resume on the next sealed turn with no restart; a later exhaustion at 6
announces **again** (the latch is keyed on the limit, R-H5).

**Fail:** the toast reports success but no review ever runs again — that is the
`persistConfig`-without-`setFastConfig` failure this package already has a
comment about (RV-H4). Confirm by checking that `<home>/config.json` now holds
`"reviewMaxPerSession": 6` *and* that reviews resumed; one without the other is
the defect.

Also check the clamp: `/fast budget 9999` must report **500**, and
`/fast budget 0` / `/fast budget abc` must warn `Usage: /fast budget <1-500>`
and change nothing.

And check the third surface, outside any session:
`aragon config set fast.reviewMaxPerSession 80` must print
`Set fast.reviewMaxPerSession = 80`, and `9999` must echo the stored **500**.

**Fail:** `Unknown config key "fast.reviewMaxPerSession"` — the key reached
`config.json` and `/fast` but not `config set`, which is IF-H5.

## 3. `/fast status` reads `n/N` before, during and after (AC-H7)

Run `/fast status` at three moments: fresh session, after one review, and once
exhausted.

**Pass:** `0/40`-style before any review (or `0/2` under configuration A),
`1/2` after one, and the exhausted form with the remedy clause. The numerator is
never larger than the denominator.

## 4. An exact count next to an unknown cost (D-H1)

Point the tier at a model the static price table has never seen — any recent
cheap model id, e.g. `/fast model glm-4-flash` with the matching provider and
key.

**Pass:** one line carries both `12/40 reviews` (exact) and
`cost unknown (no price table for glm-4-flash)`. That pairing *is* D-H1's
justification rendered as UI: a currency budget could not have fired here at all.

## 5. The budget never touches delegation (D-H7) — REQUIRED

1. From row 1, with the budget exhausted.
2. Send a message that makes the lead dispatch a subagent with `model: "fast"`
   (e.g. "use a fast subagent to summarise `README.md`").

**Pass:** the child runs on the fast tier — the dispatch report names the fast
model and reports **0 downgrades**, and `/fast status` shows `delegated` going
up while `reviews` stays pinned at the budget.

**Fail:** the child is downgraded to the main model. Delegation is spend the lead
chose in service of a message the user sent, is already bounded by `team.*`, and
is cost-*reducing*; capping it would raise total spend in the name of lowering
it.

## 6. Fail-fast, and the bound that stops it going too far (AC-H9 / AC-H14 / RV-H2) — REQUIRED

**Part 1 — unreachable endpoint.** Point the fast tier at a dead base URL
(`/fast model anthropic:claude-haiku-4-5` with
`"baseUrl": "http://127.0.0.1:9"` in the `fast` section) and send three messages.

**Pass:** each review fails in well under a second — a refused connection plus
**one** retry, not ten; after three failures the tier self-disables with round
1's message (`Fast review disabled for this session after 3 failures. Last
error: …`). The lead's own requests are unaffected throughout.

**Part 2 — reachable but slow.** Point the tier at a genuinely slow endpoint (a
loaded free-tier gateway, or any model that takes ~15 s for 512 tokens).

**Pass:** a review that takes ~15 s **succeeds** and produces a normal card. It
must not be timed out and scored as a strike.

> If this row is ever observed taking the full 20 s on healthy hardware, that is
> the datum for lowering `reviewTimeoutMs` — **not** a reason to lower it in
> advance. 12 000 is defensible only with a measured p99, and a bound that turns
> "slow but healthy" into "reported as misconfigured" spends D-24's alarming
> register on a fault that self-heals.

## 6a. A cancelled review is still not a strike (AC-H16 / IF-7) — REQUIRED

Cancel a review in flight **three times**, by three different routes:

1. Press **Esc** mid-turn while a review is open.
2. Let a run end with a review still open — ask something the lead answers in one
   turn without tools, which ends the run immediately.
3. Quit the CLI with a review open, then restart.

**Pass:** after all three, the tier is **still alive** — `/fast status` does not
report it disabled, **no** `warn` appeared, and the next message still produces a
review. Each cancellation leaves a `dropped` card reading `cancelled`.

**Fail:** a warn quoting `Stream ended without a done event`, and a tier that is
dead for the rest of the session. That is round 1's IF-7 reintroduced, and after
this round it means `review-call.ts` has taken ownership of the `AbortController`
— check that `new AbortController()`, `callAbort`, `callAbortReason` and
`cancelCall()` are all still in `reviewer.ts`.

## 7. `fast` log scope (AC-H12)

With configuration **A**, run a session that produces at least one review, then
inspect today's log file.

**Pass:** every `fast_*` record carries `"scope":"fast"` — `fast_tier_resolved`,
`fast_review_start`, `fast_review_done`, `fast_review_injected`,
`fast_review_budget_reached` and `fast_registry_created`. None of them is under
`agent` any more, and the lead's own records still are.

```bash
grep '"scope":"fast"' <home>/logs/<today>.log | head
grep 'fast_registry_created' <home>/logs/<today>.log   # expect maxRetries: 1
```

## 8. Off is inert (AC-H13)

Start with configuration **B** and work normally for several turns.

**Pass:** no `fast` output anywhere — no cards, no chip, no notices; **no**
`fast_registry_created` line in the log (the registry is lazy, so a session that
never uses the tier allocates nothing); and `/fast status` reports the tier off
for the session. `<home>/config.json` gains `reviewMaxPerSession: 40` on first
write, which is the same defaulting every pre-feature user's `fast` section
already gets.

## 9. The settings screen row round-trips (AC-H18)

1. `/settings`, scroll to **Fast budget** (the row under `Fast review`).
2. Confirm it renders the persisted value (`2` under configuration A, `40` by
   default) rather than an empty field.
3. Save **without touching it**, then reopen.

**Pass:** the value is unchanged. Then set it to `9999`, save, reopen: it reads
`500`. Then set it to `soon`, save, reopen: it is unchanged from `500` — a typo
changes nothing, the discipline `Max tokens` already follows.

**Fail:** an empty row on first open, or an untouched save that resets the value
to 40. That is `fastSettingsFrom` missing its seed — the silent half of §4.4.

Also look at the column, not just the row: every value on the screen must start
at the same offset. A label of 18 characters or more neither wraps nor truncates
— it pushes its own value out of the column and nothing reports it (IF-H7).

## 10. Reads are answerable mid-dispatch; writes are not (RV-H3)

While a `task` dispatch is running (several subagents, so there is time):

- `/fast status` → answers.
- `/fast budget` (no argument) → answers, reporting `n of N used`.
- `/fast budget 80` → refused with `Cannot change fast-tier settings
  mid-dispatch.`

**Fail:** a bare `/fast budget` being refused. It is a read, and blocking a read
for the reason a write is blocked is the contradiction RV-H3 raised.
