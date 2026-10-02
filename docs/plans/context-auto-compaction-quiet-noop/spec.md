# Context auto-compaction — quiet no-op (speak only when something was compacted)

**Feature slug:** `context-auto-compaction-quiet-noop`
**Document version:** v2 (round 3 of the compaction loop; design review applied)
**Predecessors, read in order:**

1. `docs/plans/context-auto-compaction/spec.md` v2 — the feature (shipped `553827ca7`)
2. `docs/plans/context-auto-compaction-hardening/spec.md` v2 — the hardening round (`e5cd5d863`)

This document is a **delta**. Every decision, guard, limit and invariant recorded
in those two stands unless a row below says otherwise. Exactly one published rule
is narrowed — the §6.4 honesty rule *"it did nothing is never the observable
outcome"* — and §9 states the narrowing precisely.

**Scope of the change:** the CLI event boundary in
`packages/cli/src/compaction/`. `packages/core/` is **not touched** (D-4).

**v2 changes** (all from the review below, every one of them a narrowing or a
correction, none of them new scope): `no_anchor` is recorded as structurally
unreachable and AC-Q2 is rewritten around what is actually reachable (P0-1); the
per-call announcement stops being instance state and becomes a local threaded
into `finish()`, exactly where `index` is threaded today (P1-1); `/compact
status` gains a `declined` count so the transcript can go quiet without
`§6.5`'s guaranteed surface going quiet with it (P1-2, D-9); R-1's bound is
given the proof it depends on and a standing rule for future decline reasons
(P1-3).

---

## 0. 评审记录 (Review Notes)

Reviewed against the working tree at `c60a175d5`, reading every file and line the
document cites. The design's core judgement is right and I would ship it: moving
the announcement from the attempt point to a commit point is the correct shape,
it defaults to quiet in exactly the place where "nothing happened" is true, and
D-2's decision to leave `manual` and `overflow` byte-identical keeps the blast
radius to one trigger. E-1 through E-22 all check out, including the two that
carry the most weight — E-13 (core's pair is emitted from a `finally` and is the
watchdog contract) and E-22 (the existing decline tests assert the outcome, not
the event stream). Every statement in E-1 … E-22 is true as written; E-3 is the
only one that is true but incomplete, and P0-1 is what that omission cost.
§7.2's five entries do stay green: `conversation(10)` against the default
`keepRecentTurns: 4` reaches commit point B synchronously, so the abort-race
test at `compaction-wiring.test.ts:173-205` still finds an open card.

Four findings are load-bearing. Every P0 and P1 below is fixed in the body of
this v2, and every P2 is applied as well — none of them needed more than a
sentence.

### P0

**P0-1 — `no_anchor` is structurally unreachable, so AC-Q2 cannot be written and
the Definition of Done cannot be met.**
*Where:* §2 (E-3), §3.1, §3.4, §7.1 (AC-Q2), §7.4.

`buildAnchor` returns `null` only when the history contains **no** `user` message
anywhere (`summary-prompt.ts:143-144`). But it is reached only after
`plan !== null`, and `planCompaction` returns a plan only when some cut index
leaves `retainedTurns >= keep` behind it, where `countTurns` counts **`user`-role
messages** and `keep = Math.max(1, ...)` is therefore at least 1
(`core/src/engine/compaction.ts:106`, `:114-121`, `:64-70`). A plan *proves* at
least one `user` message exists, which is exactly what `buildAnchor` looks for.
The `if (!anchor)` branch at `compactor.ts:431-435` is dead code.

Consequences: §3.1's `no_anchor` row describes behaviour that cannot occur; AC-Q2
asks for a fixture that cannot exist (any history with zero `user` messages exits
at `plan === null`, as relief or as `nothing_to_drop`); and §7.4's "AC-Q1 … AC-Q14
present and passing" is unachievable as written. The dangerous outcome is not the
red test — it is the *green* one, where an implementer reaches for a zero-`user`
history, gets `nothing_to_drop`, sees zero events, and ships an AC-Q2 that
duplicates AC-Q1 while claiming to cover a second decline path.

*Resolved in v2:* E-3 rewritten with the proof, new **E-23** recording the
`countTurns` mechanism, §3.1's row marked unreachable, §3.4 keeps the branch
un-announced and says why that is still the right default, and **AC-Q2 rewritten**
to assert what is reachable.

### P1

**P1-1 — the announcement is proposed as per-instance state, and the
justification given for that is factually wrong.**
*Where:* §3.2, §3.3, §3.5, §6.1.

§3.2's doc comment says the field is safe because "`compact()` is not re-entrant -
the engine awaits it and guard 1 forbids two compactions on one turn." Guard 1
lives in `shouldCompact()` (`compactor.ts:308-310`), and the idle `/compact` path
calls `compactor.compact()` **directly through `wiring.compactNow()`
(`wiring.ts:357`), bypassing `shouldCompact` entirely**. The property that
actually holds is a different one: `command.ts:372-379` routes to `queueManual()`
whenever `ctx.state.status === 'running'`, so `compactNow` only ever runs while
the loop is idle.

The invariant is real; the stated reason is not, and a wrong load-bearing comment
is how a future refactor breaks an invariant confidently. If it ever does break,
the failure mode is the worst one this feature has: compaction B entering
`compact()` resets `this.announced = null`, compaction A's `finish()` then sees
`null` and returns silently, and A's card **never settles** — the permanently
`live` entry that pins `Transcript`'s monotonic boundary and re-renders the tail
for the rest of the session (`Transcript.tsx:112-115`). That is R-4's own
nightmare arriving through a different door.

*Resolved in v2:* the field is **removed**. The announcement becomes a `let` local
inside `runCompaction()` and is passed into `finish()` as a parameter — the same
slot `index` occupies today, so this is a *smaller* delta than v1's, and
re-entrancy stops being a question anyone has to answer. The eager `manual` /
`overflow` announce moves to the top of `runCompaction()`, which preserves E-21's
synchrony (an async function's body runs synchronously to its first `await`).

**P1-2 — the design removes the only user-visible trace of a decline, and then
cites a surface that does not carry one.**
*Where:* §3.5, §4, §5.3, §6.2, §7.1, §8, §9.

§9 lists `/compact status` as surface #2 keeping the capability visible, and the
parent spec's §6.5 promises it "answers every question about the feature's state
at any width, in any mode, including after the fact." It does not answer this
one. `command.ts:83-88` renders `This session: N compactions` from
`snapshot.compactions`, which D-5 redefines to count **announced** compactions;
nothing in `CompactionSnapshot` counts attempts or declines
(`types.ts:145-168`). After the change, a user whose auto-compaction declined
twice sees `This session: 0 compactions` and, only once guard 4 trips, a
`self-disabled (nothing_to_drop)` string. Between the first decline and the
self-disable there is no human-readable surface at all — the diagnostic log is
not one, and the chip (`StatusBar.tsx:312-318`) renders two words that never
change. Quiet is the goal; invisible is not, and §6.5 is a published guarantee
this change would silently hollow out.

*Resolved in v2:* new session counter `declined`, incremented on `finish()`'s
silent return, surfaced through `sessionTotals()` / `CompactionSnapshot` and
rendered as one clause on the existing `/compact status` line. Roughly six lines,
no new command, no new event. Recorded as **D-9**, pinned by **AC-Q15** and **AC-Q16**, and §9's
surface list corrected to say what each surface actually shows.

**P1-3 — R-1's bound is asserted without the proof it rests on.**
*Where:* §9, §10 (R-1, R-2).

"Impossible for more than `stuckLimit` (2) checkpoints" is true, but *only*
because `nothing_to_drop` is the sole reachable pre-commit decline and
`noteNoProgress` is called on exactly that branch (`compactor.ts:427`). The
`no_anchor` branch charges nothing (`:431-435`), and neither would any pre-commit
decline added later. As written, R-1 reads as a property of the *design* when it
is a property of *one call site*, and R-2 — the checklist for future decline
reasons — talks only about where a new reason is decided, not about whether it
charges guard 4. A new pre-commit decline that skips `noteNoProgress` would
produce the exact failure R-1 declares impossible: a safety net that declines
forever and says nothing, on any surface, until the run dies on
`context_overflow`.

*Resolved in v2:* R-1 restated with the proof inline and the dependency named;
R-2 extended with the standing rule that **any new pre-commit decline must either
charge guard 4 or be proven unreachable, and the proof goes in §2 as evidence**.
P1-2's `declined` counter is the second, weaker net under both.

### P2

| # | Concern | Where | Resolution in v2 |
|---|---|---|---|
| **P2-1** | §4's ASCII reminder claims `glyphs.test.ts` forbids non-ASCII bytes "comment prose included". It does not: `scan()` runs `stripComments()` before matching (`glyphs.test.ts:230-239`), and the compaction tree already carries 28 em-dashes in `compactor.ts` comments alone. The advice (keep the `->` arrows) is still right for house style; the reason given is wrong, and a wrong reason invites someone to check it, find it false, and discard the whole reminder. | §4 | Corrected: the scanner checks code and string literals, comments are stripped, and the arrows are a style convention rather than a gate. |
| **P2-2** | AC-Q11 and AC-Q4 describe the guards as if `compact()` enforced them. It does not — guards 1 and 2 are read in `shouldCompact()`, and `compact()` charges them unconditionally. AC-Q11 as phrased ("a second `pressure` compaction on the next turn is refused by guard 1") would be written as two `compact()` calls and fail; AC-Q4's setup note ("`onRunStart()` between them to clear guard 2") is inert, because the direct `compact()` calls the test makes never consult guard 2. | §7.1 | Both rewritten to name `shouldCompact` explicitly; AC-Q4's inert setup note removed. |
| **P2-3** | §3.7's sequence diagram names `attemptTailRelief` at a step whose call site is `this.relieveInPlace(...)` (`compactor.ts:405`, a thin wrapper that supplies the budget). Harmless, but it is the one line someone will `grep` for. | §3.7 | Corrected to `relieveInPlace`. |
| **P2-4** | §7.2 says `compaction-wiring.test.ts:173-205` must stay green "without modification" while §4 lists the same file as `modify` (AC-Q13). Consistent if "unmodified" is read as scoped to those lines, but it is not said. Separately, that test's inline comment at `:177-178` becomes true only *because that fixture is compactable*, and will read as a general claim to the next person. | §7.2 | §7.2 scoped explicitly to the named line ranges, with the one comment edit called out as expected and allowed. |
| **P2-5** | D-6 oversells the `settlePending` snapshot. `turn_end` already emits a snapshot every turn (`wiring.ts:504`), and the decline path is bounded at two per session, so "leaves the chip one turn stale" overstates what is being fixed. Keep it — one cheap event, and it preserves the "every settle refreshes the surfaces" invariant — but do not present it as closing a real staleness gap. | §8 (D-6) | Rationale rewritten to the honest version: invariant preservation, not bug fix. |
| **P2-7** | Two citation drifts, both in §9. The `limits.ts` "guaranteed reporting surface" comment is at `:147-148`, not `:135-140`, and the phrase is lower-case; guard 4's notice starts at `compactor.ts:708`, not `:713`. Trivial on their own, and worth fixing because this document's credibility rests on its citations being checkable — a reader who bounces off one wrong line number starts re-deriving the rest. | §9 | Both corrected. |
| **P2-6** | A throwing `shouldCompact()` already emits a core `compaction_start` / `compaction_end` pair **without** `cm.compact()` ever running (`agent-loop.ts:211-232`), so `manager_threw` from the predicate has no CLI card today and gets none after this change. Pre-existing, untouched, correctly out of scope — but it is the one hole in §3.1's otherwise exhaustive table, and it should be named rather than left for a reader to find. | §12 | Listed in Out of scope. |

### Reviewed and found sound (no action)

- **D-3, commit point B before `buildDigest`.** Verified end to end: a throw in the
  digest renderer unwinds through `compact()`'s `finally` into core's
  `catch (err) { outcome = { action: 'keep', reason: 'manager_threw: ...' } }`
  (`agent-loop.ts:261-263`), core emits its `compaction_end`, and `settlePending`
  synthesizes a skeleton **only if `this.open` is set** — which it is, precisely
  because B announced first. Moving B below `buildDigest` really would make that
  fault invisible on every human surface.
- **Balanced pairs (§5.1).** Checked all three CLI consumers. `this.pending` is
  only ever written under the `if (!this.open) return;` guard (`wiring.ts:480`),
  and `skeletonRecord()` returns `null` unless `this.open` is set, so a CLI
  `compaction_end` cannot exist without a preceding CLI `compaction_start` on any
  path, declined or not.
- **E-15 / the child.** `child.ts`'s `emit` never looked at `compaction_start` and
  already dropped `!applied && mode === 'none'`; each child owns its own
  `Compactor`, so nothing about the announcement is shared across concurrent
  children. D-8's "keep it" is right.
- **E-14.** `logging/install.ts:351` types the event as
  `{ trigger?, messageCount? }` — core's shape, not the CLI's `{ index, model }`.
  It genuinely is on the other stream.
- **Guard 4 test fixtures.** The existing self-disable tests drive
  `unreclaimable()`, which is a *post*-commit `insufficient_reclaim` decline, and
  assert notices rather than events. They are unaffected in both directions.

---

## 1. Overview

### 1.1 What the user reported

A long unattended run prints a red card into the transcript that reads

```
[c]  context not compacted #2: nothing_to_drop
```

and the instruction is: *do not show this; show compaction content only when a
compaction actually happened.*

The card is not wrong. It is accurate, and that is not the problem. The problem
is **who asked** — nobody did. Auto-compaction is a background safety net that
evaluates itself at every turn boundary; when it evaluates itself and concludes
there is nothing worth dropping, it currently files a red, error-coloured report
into the user's conversation. A smoke alarm that announces "no fire" twice an
hour is not being honest, it is being loud. Worse, it announces with a machine
reason (`nothing_to_drop`) rendered in `theme.toolError`, so the one thing a user
reliably takes away is *something went wrong* — the opposite of the truth.

### 1.2 What is being built

One rule, applied at one boundary:

> **A compaction announces itself if and only if it commits to doing work.**

"Commits to doing work" is a *position in the control flow*, not a string
blacklist. `Compactor.compact()` decides in three synchronous steps whether there
is anything to do (`planCompaction`, tail relief, `buildAnchor`). Everything
decided **before** that point is a *decline*: no history changed, no model
called, no money spent, and nothing distinguishes it from the far more common
case of `shouldCompact()` simply returning `false`. Everything **after** that
point either spends money, rewrites the history, or faults — and all three are
the user's business.

So the CLI-local `compaction_start` event moves from the top of `compact()` down
to the commit point, **for the `pressure` trigger only**. When a compaction
declines before reaching it, no `compaction_start` and no `compaction_end` is
emitted on the CLI stream, no transcript entry is created, nothing settles, and
the turn is indistinguishable from a turn on which the threshold was never
crossed. The `manual` and `overflow` triggers keep announcing eagerly and are
**byte-identical to round 2** — a user who typed `/compact` is owed an answer,
and a reactive compaction running after the provider has already refused the
request is the one moment the diagnosis matters most.

### 1.3 Why this shape rather than "hide the card when `reason === 'nothing_to_drop'`"

A string blacklist in the renderer is one line, and it is the wrong line. It
defaults to **loud**: every decline reason invented later — and the two that
exist today, `nothing_to_drop` and `no_anchor`, are unlikely to be the last —
reappears in the transcript until someone remembers to extend the list. It also
only silences the *card*: the same no-op still prints `[compaction] skipped:` on
`-p` stderr and still emits a start/end pair on the `--output-format json`
stream.

The control-flow placement defaults to **quiet** for anything decided before work
begins and **loud** for anything decided after, which is the policy actually
asked for, expressed structurally so it cannot rot. It fixes a second-order wart
for free: card numbering becomes contiguous again, because the index is minted at
the announce point instead of the attempt point (D-5).

Observability is not reduced. Every attempt — declined or not — is still written
to the JSONL diagnostic log through **core's** `AgentEvent` pair, still charged
to guards 1 and 2, still reported by `/compact status`, and still able to trip
guard 4's self-disable notice, which is the one surface that must stay loud
because it is the only one that says *the safety net has given up* (§9).

---

## 2. Evidence — the tree as it stands

Verified against the working tree at `c60a175d5`. Paths are relative to
`packages/`.

| # | Fact | Where |
|---|---|---|
| **E-1** | `compact()` increments the session counter and emits the CLI `compaction_start` **before** it knows whether anything can be dropped. | `cli/src/compaction/compactor.ts:342-353` |
| **E-2** | `runCompaction()` reaches the `nothing_to_drop` verdict after three synchronous calls and **no** `await`. | `compactor.ts:400` (`planCompaction`), `:405` (relief), `:427-428` |
| **E-3** | `no_anchor` is the second pre-work decline, also synchronous — and it is **structurally unreachable**, see E-23. | `compactor.ts:431-435` |
| **E-4** | The first spend in the function is `await this.runLadder(...)`. | `compactor.ts:450` |
| **E-5** | `finish()` unconditionally emits `compaction_end` with the record. | `compactor.ts:783` |
| **E-6** | The wiring holds the compactor's record and drops it when no card is open. | `cli/src/compaction/wiring.ts:469-483` |
| **E-7** | `settlePending()` already tolerates "no record at all" and returns early. | `wiring.ts:543-552` |
| **E-8** | `skeletonRecord()` returns `null` when `this.open` is `null`. | `wiring.ts:633-635` |
| **E-9** | `App` is the **sole** dispatcher of the compaction reducer actions; `reduceEvent` gains no cases for them. | `cli/src/ui/App.tsx:833-870`, `cli/src/agent/reducer.ts:566-567` |
| **E-10** | The transcript card is rendered from `Entry.kind === 'compaction'`, created only by `case 'compactionStart'` / `case 'compactionEnd'`. | `reducer.ts:1641`, `:1710` |
| **E-11** | The offending string is built in two places: the card and the text exporter. | `cli/src/ui/entries/CompactionCard.tsx:101`, `cli/src/ui/transcript-text.ts:154` |
| **E-12** | A `live: true` compaction entry is **never** promoted into `<Static>`, so anything suppressed before settling was never printed to scrollback. | `cli/src/ui/Transcript.tsx:113-115` |
| **E-13** | **Core** emits its own `compaction_start` / `compaction_end` pair around every attempt, from a `finally`, and `compaction_end` is what resumes the idle watchdog. | `core/src/engine/agent-loop.ts:238`, `:287-301`; `core/src/engine/agent.ts:413-418` |
| **E-14** | The JSONL diagnostic log subscribes to **core's** events, not the CLI's. | `cli/src/logging/install.ts:351-353`, `:420-429` |
| **E-15** | The child (sub-agent) compactor **already** discards `!applied && mode === 'none'` records — the same filter, applied locally, one round earlier. | `cli/src/compaction/child.ts:176-177` |
| **E-16** | The idle `/compact` path already prints its own prose on a decline, so the card there is a second copy. | `cli/src/compaction/command.ts:391` |
| **E-17** | `stuckLimit` is **2**: at most two `pressure` declines occur before the proactive trigger self-disables and stops attempting. | `cli/src/compaction/limits.ts:78` |
| **E-18** | Guard 1 (`lastCompactionTurn`) and guard 2 (`compactionsThisRun`) count **attempts** and are separate fields from the session counter. | `compactor.ts:120-125`, `:342-343` |
| **E-19** | `/compact status` prints `This session: N compactions`, sourced from `snapshot.compactions`. | `command.ts:84-86` |
| **E-20** | Archive filenames are `compaction-<date>-<time>-<runId>-<index>.json`; only `applied: true` compactions are archived. | `cli/src/compaction/archive.ts:128-132`, `wiring.ts:562-565` |
| **E-21** | `compaction-wiring.test.ts` asserts, in prose, that `compact()` emits its CLI `compaction_start` **synchronously, before its first await**. | `cli/src/__tests__/compaction-wiring.test.ts:177-178` |
| **E-22** | The existing decline tests assert the **`CompactionOutcome`**, not the event stream. | `cli/src/__tests__/compaction-compactor.test.ts:530`, `compaction-tail-relief.test.ts:206` |
| **E-23** | **`buildAnchor` cannot return `null` where it is called.** It is reached only after `plan !== null`; `planCompaction` returns a plan only when `countTurns(messages, cutIndex) >= keep`; `countTurns` counts **`user`-role messages**; and `keep = Math.max(1, Math.floor(keepRecentTurns))` is at least 1, including on the halved overflow path. A plan therefore proves a `user` message exists, which is the only thing `buildAnchor` looks for. | `core/src/engine/compaction.ts:106`, `:114-121`, `:64-70`; `cli/src/compaction/summary-prompt.ts:143-144`; `compactor.ts:395-430` |

E-21 and E-22 together are why this change is cheap: what the suite pins is the
outcome contract, and the outcome contract does not move.

E-23 is why §3.1's `no_anchor` row is a description of dead code, and why AC-Q2
had to be rewritten in v2 (P0-1). The branch is kept, and kept un-announced, for
the reason §3.4 gives.

---

## 3. Technical design

### 3.1 The classification, stated once

| Outcome | `reason` | Decided | Work done | Announced? |
|---|---|---|---|---|
| nothing to drop | `nothing_to_drop` | before commit | none | **no** (pressure) / yes (manual, overflow) |
| no goal anchor *(unreachable, E-23)* | `no_anchor` | before commit | none | **no** (pressure) / yes (manual, overflow) |
| relief only | `tail_relief_only` | at commit | history changed | **yes**, always |
| summarized | — | after commit | model called | **yes**, always |
| truncated | `truncated: <r>` | after commit | model called, history changed | **yes**, always |
| summarize failed, `onFailure: stop` | `summarize_failed: <r>` | after commit | call attempted | **yes**, always |
| aborted (Esc) | `aborted` | after commit | call in flight | **yes**, always |
| engine refused the splice | `invalid_history: <r>` | after commit | model called | **yes**, always |
| host threw / timed out | `manager_threw`, `manager_timeout` | after commit | fault | **yes**, always |

The `no_anchor` row is dead code today and is listed anyway, because the table
is the checklist R-2 points future authors at: a reason that *would* be decided
before the commit point belongs in the silent half whether or not anything
reaches it. What changes in v2 is only the honesty of the row — see §3.4 for why
the branch keeps its placement and §10's R-1 for what its unreachability is
load-bearing for.

The `manager_threw` row says **after commit**, and that is where a host fault is
normally decided — but it is not the only place one can happen. The synchronous
region between the top of `runCompaction()` and commit point B
(`countProtectedPrefix`, `planCompaction`, `relieveInPlace`, `buildAnchor`) can
throw too, and such a throw reaches the engine as `manager_threw` with no card
open. On `pressure` it is therefore silent, and — unlike every decline in the
table — it charges no guard and does not advance `declined`, so it is also
**unbounded**. §12 records why this round does not close it. `manager_timeout`
cannot arrive there: that region holds no `await`, which is the same property
AC-Q12 pins.

Two rows look like suppression candidates and are not:

- **`summarize_failed: no_summarizer_model`** costs nothing (`runLadder` returns
  it without a call, `compactor.ts:575`) yet is announced, because it is a
  *misconfiguration the user must fix*, it already carries an `error` notice
  (`compactor.ts:465-471`), and it can only occur when the user explicitly set
  `compaction.onFailure: 'stop'` — i.e. asked to be told.
- **`aborted`** is the user's own Esc. The card records that a compaction was
  running and was cancelled — information about work that really happened.
  Suppressing it would leave the run's occupancy unexplained.

### 3.2 The announce point

One new private method becomes the **only** emitter of `compaction_start` and the
**only** place the session compaction counter advances. It **returns** the
announcement; it does not store one (P1-1):

```ts
/** What `compaction_start` was emitted under. `null` is silence. */
interface Announcement {
  index: number;
}

/**
 * Open the card (quiet-noop §3.2).
 *
 * THE ONLY EMITTER OF `compaction_start`, AND THE ONLY PLACE `this.compactions`
 * ADVANCES. A compaction that never reaches an announce point is a DECLINE: it
 * changed nothing, called nothing and spent nothing, and it is deliberately
 * indistinguishable - on every human surface except `/compact status`'s
 * `declined` count (D-9) - from a turn at which `shouldCompact` returned false.
 * `finish` is the other half of that rule.
 *
 * IT RETURNS THE ANNOUNCEMENT RATHER THAN STORING IT (P1-1), and the caller keeps
 * it in a LOCAL for the lifetime of one `runCompaction` call - the same slot
 * `index` occupied before this change. An instance field would have needed a
 * no-re-entrancy argument, and the obvious one is WRONG: guard 1 lives in
 * `shouldCompact`, while the idle `/compact` path calls `compact()` straight
 * through `wiring.compactNow()` (`wiring.ts:357`) without consulting it. What
 * actually keeps two compactions apart is that `command.ts:372-379` QUEUES
 * instead of calling `compactNow` while the loop runs - a property of a different
 * file, which is exactly why this one must not depend on it. A clobbered field
 * would leave `finish` unable to settle the card it opened, and a card that never
 * settles pins `Transcript`'s monotonic boundary for the rest of the session.
 */
private announce(
  trigger: CompactionUiTrigger,
  summarizer: SummarizerChoice | null,
): Announcement {
  this.compactions += 1;
  this.deps.emit({
    type: 'compaction_start',
    index: this.compactions,
    trigger,
    model: summarizer?.ref.modelId ?? '',
  });
  return { index: this.compactions };
}
```

**No new instance field.** `runCompaction()` owns one local and one closure over
it, and `??=` is what makes the eager path and the two commit points idempotent
with respect to each other (`manual` and `overflow` announce eagerly and would
otherwise announce a second time at a commit point):

```ts
let announced: Announcement | null = null;
const announce = (model: SummarizerChoice | null): void => {
  announced ??= this.announce(args.uiTrigger, model);
};
```

One session counter *is* added, and it is a different thing entirely — see D-9
and §6.1.

### 3.3 `compact()` — what moves and what does not

`compact()` only gets **smaller**. Nothing is added to it:

```ts
async compact(ctx: CompactionContext): Promise<CompactionOutcome> {
  const manual = this.pendingManual;
  const instructions = manual?.instructions;
  this.pendingManual = null;

  const uiTrigger: CompactionUiTrigger = manual ? 'manual' : ctx.trigger;
  const config = this.deps.getConfig().compaction;
  const summarizer = this.resolveSummarizer();

  // GUARDS 1 AND 2 COUNT *ATTEMPTS*, NOT ANNOUNCEMENTS, and they stay here
  // (E-18). A decline still consumed a checkpoint: it still has to serve the
  // cooldown and it still has to be charged to the per-run cap, or a history
  // that can never be compacted would re-attempt on every turn for the whole
  // run. `inFlight` stays for the same reason - the chip reports what the
  // compactor is DOING, not what it has decided to say.
  this.compactionsThisRun += 1;
  this.lastCompactionTurn = ctx.turnIndex;
  this.inFlight = true;

  const started = Date.now();
  try {
    return await this.runCompaction({
      ctx,
      uiTrigger,
      config,
      summarizer,
      ...(instructions ? { instructions } : {}),
      started,
    });
  } finally {
    this.inFlight = false;
    this.callAbort = null;
    this.callAbortReason = null;
  }
}
```

Removed from this function: `this.compactions += 1`, `const index = this.compactions`,
the `this.deps.emit({ type: 'compaction_start', ... })` block, and `index` from
the `runCompaction` argument object (and therefore from `runCompaction`'s
parameter type and from `finish`'s `args`).

The eager announcement for the two loud triggers moves to the **top of
`runCompaction()`**, next to the local it writes:

```ts
// A REQUESTED compaction and a REACTIVE one announce BEFORE they know the
// answer, for two different reasons. `manual` is a user instruction, and its
// QUEUED form (`/compact` typed mid-run) has NO other reporting surface - a
// silent decline there would be a command that did nothing and said nothing.
// `overflow` runs after the provider has ALREADY refused the request; if it
// cannot recover, the card is the only place that says why the run is about to
// die. Both paths stay byte-identical to round 2.
if (args.uiTrigger !== 'pressure') announce(summarizer);
```

**The synchronous-emit property is preserved (E-21).** Calling an async function
runs its body up to the first `await`, and `compact()`'s only statement after the
`try` opens is `return await this.runCompaction(...)`; `runCompaction`'s body then
runs synchronously through the eager announce, `planCompaction`, the relief
attempt and `buildAnchor` — none of which awaits — so on every path that
announces at all, `compaction_start` is *still* emitted before `compact()` yields.
`compaction-wiring.test.ts`'s abort-race test continues to hold unmodified (its
`conversation(10)` fixture reaches commit point B against the default
`keepRecentTurns: 4`), and AC-Q12 pins the property so that a future refactor
inserting an `await` above the commit point fails loudly instead of producing a
card that never settles.

### 3.4 `runCompaction()` — the two commit points

**Commit point A — relief only.** Inside the `if (reliefOnly)` branch
(`compactor.ts:405-421`), as its first statement:

```ts
// COMMIT POINT A (quiet-noop §3.4). Relief changes the history the run continues
// from - a bounded, announced data loss - so it is announced even though no
// model was called. `null` summarizer for the same reason `finish` writes
// `model: ''` on a relief-only record: naming a model here would claim a call
// that never ran.
announce(null);
```

**Commit point B — the main path.** Immediately after the `if (!anchor)` guard
returns (`compactor.ts:431-436`) and **before** `buildDigest`:

```ts
// COMMIT POINT B (quiet-noop §3.4). Everything below this line either spends
// money (`runLadder`), rewrites the history, or faults - and all three are the
// user's business.
//
// BEFORE `buildDigest`, NOT AFTER. A throw inside the digest renderer reaches
// the engine as `manager_threw`, and the engine settles the card from the
// verdict alone (`wiring.ts:543`); with no card open, that fault would be
// invisible on every human surface. Announcing first costs one event on a path
// that is about to spend seconds and dollars.
announce(summarizer);
```

Neither the `nothing_to_drop` branch (`:427-428`) nor the `no_anchor` branch
(`:431-435`) gains a call. That absence *is* the feature.

**`no_anchor` is unreachable and still gets the un-announced treatment (E-23 /
P0-1).** Deleting the branch is out of scope — it is the local statement of D-6's
"the anchor is non-negotiable", and a `!anchor` guard that is provably dead is
worth strictly more than a non-null assertion. Leaving it *above* the commit
point is the correct default for the same reason R-2 gives: if the plan/anchor
relationship ever changes, the reason that appears is one decided before any work
began, and silence is what it should get. What must **not** happen is treating it
as a live decline path in the tests — AC-Q2 asserts the reachable outcome
instead.

`this.noteNoProgress(args.uiTrigger, 'nothing_to_drop')` at `:427` stays exactly
where it is — guard 4 is unaffected and remains the escape valve (§9).

### 3.5 `finish()` — the gate

`finish()` does three things today: build the record, log it, emit it. It is
split so that **logging always happens and emission is conditional**, and it takes
the announcement as its fifth parameter — the slot `args.index` vacated (P1-1):

```ts
private finish(
  args: {...},           // `index` removed
  outcome,
  applied,
  keepRecentTurnsUsed,
  announced: Announcement | null,
): CompactionOutcome {
  const before = args.ctx.messages.length;
  const after = outcome.action === 'replace' ? outcome.messages.length : before;
  const tokensBefore = this.lastPressure?.occupied ?? 0;
  const mode: CompactionMode =
    reliefOnly(outcome) ? 'relieved' : outcome.action === 'replace' ? outcome.mode : 'none';
  const model = reliefOnly(outcome) ? '' : args.summarizer?.ref.modelId ?? '';
  const durationMs = Date.now() - args.started;

  // THE ON-DISK RECORD OF EVERY ATTEMPT IS UNCHANGED (quiet-noop §9). This
  // feature makes the TRANSCRIPT quiet, not the logs: a declined compaction is
  // still one `compaction` line here, still one `compaction_start` /
  // `compaction_end` pair from CORE in the JSONL sink (E-13, E-14), and still
  // reflected in `/compact status`.
  this.log.info('compaction', {
    trigger: args.uiTrigger,
    announced: announced !== null,
    before,
    after,
    droppedMessages: applied?.droppedMessages ?? 0,
    mode,
    model,
    durationMs,
  });

  // A SILENT DECLINE (quiet-noop §3.1). No card was opened, so there is nothing
  // to settle and nothing to say IN THE TRANSCRIPT. Returning here is what makes
  // a declined checkpoint indistinguishable from one at which `shouldCompact`
  // said no.
  //
  // `declined` IS THE ONE THING THAT STILL SPEAKS (D-9). Quiet is the goal;
  // invisible is not, and `/compact status` is a published guaranteed surface
  // (`context-auto-compaction` §6.5). One integer here is what keeps that
  // promise true while the card goes away.
  if (!announced) {
    this.declined += 1;
    return outcome;
  }

  const record: CompactionRecord = {
    index: announced.index,
    trigger: args.uiTrigger,
    mode,
    applied: outcome.action === 'replace',
    ...(outcome.action === 'keep' ? { reason: outcome.reason } : {}),
    ...(outcome.action === 'replace' && outcome.reason ? { reason: outcome.reason } : {}),
    messagesBefore: before,
    messagesAfter: after,
    tokensBefore,
    tokensAfter: 0, // filled by the wiring from the engine's own estimator
    ...(applied?.summary ? { summary: applied.summary } : {}),
    model,
    durationMs,
    ...(args.ctx.trigger === 'overflow' ? { keepRecentTurnsUsed } : {}),
    ...(args.tailRelief ? { tailRelief: args.tailRelief } : {}),
  };

  this.deps.emit({ type: 'compaction_end', record });
  return outcome;
}
```

Note that `mode` and `model` are hoisted out of the record literal only so the
log line can name them on the declined path too; their expressions are copied
verbatim from the current code, including the `reliefOnly(outcome)` guards and
the comments that justify them.

All six `this.finish(...)` call sites in `runCompaction()` gain a trailing
`announced` argument. That is mechanical, and it is also the point: the value is
read where it was written, one function away, instead of surviving on `this`
between a write in one method and a read in another.

`this.deps.notify(...)` elsewhere in `runCompaction` — the `onFailure: 'stop'`
error at `:465`, the truncation warning at `:504`, guard 4's self-disable warning
at `:718` — is **not** touched. The first two fire only on announced paths; the
third deliberately fires on a path that did not announce (§9).

### 3.6 `wiring.settlePending()` — the receiving end

The engine emits its `compaction_end` for **every** attempt, declines included
(E-13), so `settlePending` still runs. It already handles "no record" by
returning (E-7). One line is added so the status surfaces stay current:

```ts
const record = this.pending ?? this.skeletonRecord();
this.pending = null;
this.open = null;
const dropped = this.compactor.takeLastDropped();
if (!record) {
  // A SILENT DECLINE (quiet-noop §3.6). No card - but the gauge and the chip are
  // still refreshed: `inFlight` has just gone false and `/compact status` reads
  // this same snapshot. `snapshot()` uses the CACHED pressure
  // (`compactor.lastMeasured()`), so this costs no re-measurement, and guard 4
  // caps the number of declines per session at `stuckLimit` (E-17).
  this.emit({ type: 'snapshot', snapshot: this.snapshot() });
  return;
}
```

No other change to `wiring.ts`. In particular, `onCompactorEvent`'s
`if (!this.open) return;` at `:480` stays: it is unreachable for declines now
(nothing is emitted) but remains correct for the abort race it was written for.

### 3.7 Sequence — a declined `pressure` checkpoint, end to end

```
turn boundary
  |
  +- core runCompaction()                                agent-loop.ts:197
  |    +- cm.shouldCompact(probe) -> true
  |    +- emit AgentEvent compaction_start        <-- watchdog PAUSES  (unchanged)
  |    +- await cm.compact(ctx)
  |         +- Compactor.compact()
  |              +- guards 1/2 charged; inFlight = true; announced = null
  |              +- uiTrigger === 'pressure'  -> no eager announce       [NEW]
  |              +- runCompaction()
  |                   +- planCompaction -> null
  |                   +- relieveInPlace -> null
  |                   +- noteNoProgress('nothing_to_drop')  (guard 4 charged)
  |                   +- finish(): log.info(announced:false); declined++; RETURN [NEW]
  |              +- finally: inFlight = false; announced = null
  |         <- { action: 'keep', reason: 'nothing_to_drop' }             (unchanged)
  |    +- emit AgentEvent compaction_end          <-- watchdog RESUMES  (unchanged)
  |         +- CompactionWiring.onAgentEvent -> settlePending()
  |              +- pending = null; skeletonRecord() = null
  |              +- emit CompactionEvent snapshot                        [NEW]
  |              +- return   (no compaction_end on the CLI stream)       [NEW]
  |
  +- App: receives only `snapshot` -> dispatch compactionSnapshot
  +- reducer: no `compactionStart`, no `compactionEnd`, NO ENTRY         [NEW]
  +- Transcript: unchanged; nothing was appended, nothing to un-print    (E-12)
```

The same diagram for an *announced* compaction is identical down to
`runCompaction()`; then `announce()` fires at commit point B and every downstream
step is byte-identical to round 2.

### 3.8 What is deliberately **not** changed

| Thing | Why it stays |
|---|---|
| `packages/core/**` | The engine's `compaction_start` / `compaction_end` pair is the idle-watchdog contract (E-13) and is emitted from a `finally` precisely so it cannot be skipped. Suppressing it would leave a run permanently deaf. The engine has no card and no opinion about one. |
| `CompactionCard.tsx` copy, incl. `context not compacted #N: <reason>` | Still reachable (manual, overflow, and every post-commit decline) and still correct there. Rewriting the copy is a separate change with its own churn — D-7 / R-A. |
| `transcript-text.ts:154` | Same string, same reasoning. An exported transcript that contains a compaction card contains it because a compaction ran. |
| `reducer.ts` `compactionStart` / `compactionEnd` cases | No logic change. A declined checkpoint simply never dispatches, exactly as a checkpoint below the threshold never dispatches. |
| Guards 1, 2, 3, 4 | All four count attempts and outcomes, not announcements. Charging them from the announce point would let an uncompactable history re-attempt every turn forever. |
| `child.ts:176-177`'s local `!applied && mode === 'none'` filter | Now redundant on the new path (the event never arrives) but retained as defence in depth — and as the in-tree record that this project already agreed a no-op compaction is a non-event. One comment is added pointing here. |
| `command.ts:391`'s `Compaction did not run: <reason>` notice | The idle `/compact` path's prose answer. `manual` still announces, so that path is unchanged end to end. |

---

## 4. File / module change plan

| File | Kind | Intent |
|---|---|---|
| `packages/cli/src/compaction/compactor.ts` | modify | Add the `Announcement` type and the `announce()` method; remove the eager emit + counter increment from `compact()`; announce eagerly (only for `manual` / `overflow`) at the top of `runCompaction()`, into a **local**; announce at the two commit points; gate `finish()`'s emit while keeping its log unconditional and counting `declined`; drop `index` from `runCompaction` / `finish` argument types and add `announced` as `finish`'s fifth parameter; add the `declined` session counter to `sessionTotals()`. |
| `packages/cli/src/compaction/wiring.ts` | modify | `settlePending()` emits a `snapshot` before its no-record early return; `snapshotWith()` carries `declined` through when it is non-zero; header comment records the "declined compactions produce no CLI events" contract. `offCompactionSnapshot()` omits `declined` (it is optional, so the off-session literal is unchanged). |
| `packages/cli/src/compaction/types.ts` | modify | Doc comment on `CompactionEvent`: the pair is emitted **only** for announced compactions; `CompactionSnapshot.compactions` counts announced ones. **One type change:** `CompactionSnapshot.declined?: number` (optional, D-9 / P1-2) — optional precisely so the three existing construction sites, one of which is in a §7.2 suite, stay untouched. `CompactionEvent` itself is unchanged. |
| `packages/cli/src/compaction/child.ts` | modify | One-line comment on the `!applied && mode === 'none'` filter noting it is now defence in depth. **No logic change.** |
| `packages/cli/src/agent/reducer.ts` | modify | Comment only, above `case 'compactionStart'`: a declined checkpoint dispatches nothing, so this case is not a total function over compaction attempts. |
| `packages/cli/src/compaction/command.ts` | modify | One clause on the existing `This session: N compactions` line, rendered only when `declined > 0` (D-9). No new subcommand, no new output block. |
| `packages/cli/src/__tests__/compaction-quiet-noop.test.ts` | **create** | AC-Q1 … AC-Q12 from §7.1. |
| `packages/cli/src/__tests__/compaction-wiring.test.ts` | modify | Add AC-Q13. |
| `packages/cli/src/__tests__/compaction-e2e.test.ts` | modify | Add AC-Q14. |
| `packages/cli/src/__tests__/compaction-quiet-noop.test.ts` | *(same new file)* | AC-Q16 lives here too — it needs only a stub `CommandContext`, not a new suite. |
| `packages/cli/CHANGELOG.md` | modify | One entry: declined auto-compactions are no longer reported in the transcript, on `-p` stderr, or on the `--output-format json` stream; `/compact status` and the diagnostic log are unchanged. |
| `docs/plans/context-auto-compaction/spec.md` | modify | §6.4 honesty rule amended per §9 (one paragraph, plus a pointer here). |

**Line-budget estimate:** ~62 lines added / ~15 removed under `src/`, ~250 lines
of new test. No new files under `src/`. (v2: the announcement local costs a line
or two less than v1's field plus its two resets; `declined` costs about eight
across five files.)

**ASCII-only reminder.** `src/compaction/**` and `src/ui/**` are inside
`glyphs.test.ts::inScope`, so no **code or string literal** in that tree may hold
a non-ASCII byte. Comments are **not** scanned — `scan()` runs `stripComments()`
first (`glyphs.test.ts:230-239`), which is why `compactor.ts` already carries 28
em-dashes in its prose (P2-1). The `->` arrows in the code comments above are
therefore a house-style convention rather than a gate; keep them anyway, because
the whole tree reads that way and a lone `→` is noise in a diff.

---

## 5. Interface design

### 5.1 CLI event stream (`CompactionEvent`) — contract narrowed, shape unchanged

No member of the union is added, removed or re-shaped. What changes is the
**emission contract**, documented on the union itself:

```ts
/**
 * THE COMPACTION EVENT STREAM.
 *
 * `compaction_start` and `compaction_end` are emitted ONLY for compactions that
 * COMMITTED TO WORK (quiet-noop §3.1): a `pressure` compaction that declines
 * before calling a model or changing the history emits NEITHER, and is
 * deliberately indistinguishable from a turn at which `shouldCompact` returned
 * false. `manual` and `overflow` always emit both.
 *
 * The pair is still BALANCED: every `compaction_start` is followed by exactly
 * one `compaction_end` (a `finally` in the engine guarantees the verdict, and
 * `settlePending` synthesizes a skeleton record when the compactor's own has not
 * arrived). Consumers that count PAIRS are unaffected; consumers that counted
 * ATTEMPTS must read `/compact status` or the JSONL diagnostic log instead.
 */
export type CompactionEvent = /* unchanged */;
```

Downstream consumers and their observable delta:

| Consumer | Delta |
|---|---|
| `ui/App.tsx:833-870` | Fewer dispatches. No card for a declined `pressure` compaction. |
| `exec/runner.ts:202-235` (`--output-format json`) | No `{ type: 'compaction', subtype: 'start' \| 'end' }` pair for a declined `pressure` compaction. Pairs stay balanced. **Documented behaviour change.** |
| `agent/headless.ts:272-282` (`-p`, stderr) | `[compaction] skipped: nothing_to_drop` no longer printed for a declined `pressure` compaction. Still printed for manual, overflow, and every post-commit decline. |
| `compaction/child.ts:170-183` | No event for a declined child compaction; its local filter already discarded it (E-15). |
| `logging/install.ts` | **Unchanged** — it subscribes to core's `AgentEvent`, not this stream (E-14). |

### 5.2 Core `AgentEvent` — unchanged

`compaction_start` / `compaction_end` on the engine stream keep firing for every
attempt. This is load-bearing (idle watchdog, E-13) and is asserted by AC-Q14.

### 5.3 Slash commands — signatures unchanged

`/compact`, `/compact status`, `/compact history`, `/compact show <n>`,
`/compact on|off`, `/compact threshold <r>`, `/compact keep <n>` all keep their
current signatures. Two observable differences on `/compact status`, both on the
one existing line:

1. `This session: N compactions` (E-19) now counts compactions that **ran**
   rather than checkpoints that were **attempted** — see §6.2.
2. When `declined > 0`, that line gains a parenthetical (D-9 / P1-2):

   ```
   This session: 1 compaction (2 checkpoints declined), 94.2k tokens reclaimed
   ```

   Rendered only when non-zero, so a healthy session's output is byte-identical
   to round 2 and nobody reads `(0 checkpoints declined)`. This is the surface
   that keeps `context-auto-compaction` §6.5's "answers every question about the
   feature's state" true after the card goes away.

### 5.4 No REST / WebSocket surface

`aragon-agent-core` is a library plus a terminal UI. There is no network
interface in scope for this change.

---

## 6. Data model

### 6.1 New in-memory state

**No new per-call instance field (P1-1).** The announcement is a `let` local in
`runCompaction()`, passed to `finish()` as an argument, so it cannot outlive the
call that made it and cannot be clobbered by another one.

One new *session* counter, never persisted:

| Field | Type | Lifetime | Meaning |
|---|---|---|---|
| `Compactor.declined` | `number` | session; **not** reset by `onRunStart()` | How many `compact()` calls returned without announcing. Surfaced through `sessionTotals()` → `CompactionSnapshot.declined?` → `/compact status` (D-9). |

`declined` deliberately follows `compactions`, not `compactionsThisRun`: both
answer a question about the *session*, and `/compact status` is the only reader.
It is **not** reset by `clearSelfDisable()` either — `/compact on` overrides a
guard, it does not rewrite history.

And one module-local type:

| Type | Shape | Meaning |
|---|---|---|
| `Announcement` | `{ index: number }` | What `compaction_start` was emitted under. `null` in the caller's local means this compaction is still silent, and must stay silent. |

### 6.2 Changed semantics of existing state

| Field | Was | Becomes |
|---|---|---|
| `Compactor.compactions` (session) | number of `compact()` **calls** | number of **announced** compactions |
| `CompactionSnapshot.compactions` | mirrors the above | mirrors the above |
| `CompactionRecord.index` | 1-based over calls; visible card numbers could skip | 1-based over announced compactions; visible card numbers are **contiguous** |
| `CompactionSnapshot` (shape) | 12 fields | 13 — one optional addition, `declined?: number` (D-9 / P1-2) |
| `finish()` signature | 4 parameters, `index` carried on `args` | 5 parameters, `announced` passed explicitly (P1-1) |

`compactionsThisRun`, `lastCompactionTurn`, `consecutiveNoProgress`,
`selfDisabled`, `selfDisabledReason`, `generation`, `tokensReclaimed`,
`sessionUsage`, `pricingUnknown`, `estimateOffset`, `lastPressure`,
`measuredPrefixLength` and `lastDropped` are **all unchanged**.

### 6.3 Persistence

None. `SavedSession` (`{ model, messages, entries, todos }`) is untouched; a
suppressed compaction produces no `Entry`, so `/save` and `/resume` need no
format change and old files load unchanged. `session/persist.ts:214-226`'s fifth
clause (normalize `live` to `false` on load) is unaffected.

### 6.4 On-disk artefacts

| Artefact | Delta |
|---|---|
| JSONL diagnostic log (`<home>/logs/`) | Core's event pair unchanged. The CLI-side `compaction` line gains one boolean field, `announced`, so a support thread can distinguish "never fired" from "fired and declined" with one grep. |
| `/compact status` output | One parenthetical clause when `declined > 0` (§5.3). Not a file, listed here because it is the only *persistent-across-the-session* user-facing artefact this change adds. |
| Archives (`<home>/compaction/compaction-<date>-<time>-<runId>-<index>.json`) | Written only for `applied: true`, which always implies announced, so no archive can reference an index that was never minted. Indices are now contiguous, which makes `/compact show <n>` easier to use. Filenames still carry `runId` **and** a timestamp, so no cross-run collision is possible (E-20). |

---

## 7. Testing & acceptance criteria

### 7.1 Automated — `packages/cli/src/__tests__/compaction-quiet-noop.test.ts`

Reuse the `harness()` / `ctx()` / `conversation()` helpers already used by
`compaction-compactor.test.ts`, and the `unsplittable()` fixture from
`compaction-tail-relief.test.ts:156`.

| # | Assertion |
|---|---|
| **AC-Q1** | `pressure` + a history that yields `nothing_to_drop`: `events` contains **zero** `compaction_start` and **zero** `compaction_end`; the returned outcome is still `{ action: 'keep', reason: 'nothing_to_drop' }`. |
| **AC-Q2** | **The zero-`user` history, asserted for what it actually does (P0-1 / E-23).** `pressure` + a history containing no `user` message: zero `compaction_start`, zero `compaction_end`, **and** the outcome is `{ action: 'keep', reason: 'nothing_to_drop' }` — *not* `no_anchor`, because `planCompaction` refuses first (`countTurns` counts `user` roles and `keep >= 1`). The `reason` assertion is the load-bearing half: it is what fails if the plan/anchor relationship ever changes and `no_anchor` becomes live, which is the moment someone must re-read §3.4. |
| **AC-Q3** | `pressure` + a compactable history: exactly one `compaction_start` and one `compaction_end`; `start.index === 1`. |
| **AC-Q4** | **Index contiguity.** One declining `pressure` compaction, then one succeeding `pressure` compaction on the same compactor: the succeeding one announces `index === 1`, not `2`. No guard setup is needed — `compact()` charges guards 1 and 2 but never consults them; only `shouldCompact()` does (P2-2). |
| **AC-Q5** | `manual` (via `queueManual()`) + `nothing_to_drop`: exactly one `compaction_start` with `trigger: 'manual'` and one `compaction_end` with `applied: false`, `reason: 'nothing_to_drop'`. **Byte-identical to round 2.** |
| **AC-Q6** | `overflow` + `nothing_to_drop`: exactly one start and one end. **Byte-identical to round 2.** |
| **AC-Q7** | `pressure` + relief-only (`unsplittable()`): one start with `model: ''`, one end with `mode: 'relieved'` and `applied: true`. |
| **AC-Q8** | `pressure` + `onFailure: 'stop'` + a summarizer that always fails: one start, one end with `applied: false` and a `reason` beginning `summarize_failed:`; the `error` notice still fires through `deps.notify`. |
| **AC-Q9** | `sessionTotals().compactions` is `0` after a declined `pressure` compaction and `1` after an announced one. |
| **AC-Q10** | **Guard 4 still speaks.** `COMPACTION_LIMITS.stuckLimit` consecutive declining `pressure` compactions still set `isSelfDisabled() === true` and still emit exactly one `warn` notice through `deps.notify`. This is the surviving signal (§9); its absence would make the feature genuinely silent. |
| **AC-Q11** | **Guards still count attempts.** Assert through `shouldCompact()`, which is where guards 1 and 2 live (P2-2): after a declined `pressure` `compact()` at `turnIndex: t`, `shouldCompact({ trigger: 'pressure', turnIndex: t + 1, ... })` is `false` (guard 1, cooldown); and after `maxPerRun` declining `compact()` calls, `shouldCompact()` is `false` at any turn index (guard 2). Both would pass vacuously if the increments moved to the announce point, which is exactly the regression this pins. |
| **AC-Q12** | **Synchrony is preserved (E-21).** For a compactable history, `compaction_start` is present in `events` **before** the promise returned by `compact()` resolves — assert immediately after the call expression, without awaiting it. |
| **AC-Q15** | **The count exists (D-9 / P1-2).** After two declining `pressure` compactions and one succeeding one, `sessionTotals()` reports `{ compactions: 1, declined: 2 }`. Also: `onRunStart()` does **not** reset it (it is a session total, like `compactions`), and `clearSelfDisable()` does not either. |

Wiring level, added to `compaction-wiring.test.ts`:

| # | Assertion |
|---|---|
| **AC-Q13** | A `pressure` decline driven through `settlePending` (via a synthetic core `compaction_end`) produces **no** `compaction_end` on the CLI stream but **one** `snapshot`. |

Engine level, added to `compaction-e2e.test.ts`:

| # | Assertion |
|---|---|
| **AC-Q14** | Core still emits its own `compaction_start` / `compaction_end` pair for a declined attempt, so the idle watchdog still pauses and resumes (E-13). |

Render level. `formatCompactionStatus(ctx)` is already exported
(`command.ts:41`), so this needs a stub `CommandContext` whose
`getCompactionSnapshot()` returns a chosen snapshot — no new production seam:

| # | Assertion |
|---|---|
| **AC-Q16** | **The count reaches the screen (D-9 / P1-2).** `formatCompactionStatus` with `declined: 2` contains `2 checkpoints declined` on the `This session:` line; with `declined: 0` — and with the field **absent**, which is what `offCompactionSnapshot()` produces — that line is byte-identical to round 2, with no empty parenthetical and no trailing space. The negative half is the one that matters: a counter that renders `(0 checkpoints declined)` in every healthy session has replaced one piece of noise with another. |

### 7.2 Regression assertions that must stay green **without modification**

Scoped to the line ranges named, not to whole files — `compaction-wiring.test.ts`
and `compaction-e2e.test.ts` are both listed as `modify` in §4 because they gain
AC-Q13 and AC-Q14 (P2-4).

- `compaction-compactor.test.ts:517-532` — the third-pass `nothing_to_drop` case
  asserts the outcome, not the events (E-22).
- `compaction-tail-relief.test.ts:199-208` — same. Note that the two tests just
  above it (`:161-197`) *do* read `events`, and stay green because relief
  announces at commit point A.
- `compaction-render.test.tsx` — renders `CompactionCard` from props; the card is
  unchanged, and `CompactionSnapshot.declined` is optional so its `snapshot()`
  fixture at `:59` needs no field added (P1-2).
- `compaction-wiring.test.ts:173-205` — the abort race, protected by AC-Q12. Its
  `conversation(10)` fixture reaches commit point B against the default
  `keepRecentTurns: 4`, so the card is open when the synthetic verdict lands.
  **One allowed edit:** the inline comment at `:177-178` should gain "(this
  fixture reaches commit point B)", because after this change the synchrony it
  states is a property of announced compactions rather than of `compact()` as
  such. Comment only; no assertion moves.
- `compaction-child.test.ts` — the child's own filter is unchanged.

If anything else in these needs editing, the implementation has gone further than
this design intends; stop and re-read §3.8.

### 7.3 Manual acceptance

1. **The reported symptom.** Run a long session whose recent turns alone exceed
   the threshold (the shape `unsplittable()` models). *Expected:* no
   `context not compacted` card ever appears; after two checkpoints the single
   `Auto-compaction is off for this session: ...` warn notice appears, once.
2. **Normal compaction is unchanged.** Fill a window past
   `compaction.threshold` with ordinary conversation. *Expected:* the live
   `compacting context #1` card with its spinner and `esc to cancel` hint,
   settling to
   `context compacted - 112 -> 9 messages - 118.4k -> 23.1k tokens - 4.2s`.
3. **Numbering, and the count that survives.** After scenario 1 followed by
   scenario 2 in one session, the card reads `#1` and `/compact status` reads
   `This session: 1 compaction (2 checkpoints declined), ... tokens reclaimed`.
   The parenthetical is the whole of D-9: the transcript is quiet, the status
   line is not.
3a. **A healthy session says nothing extra.** With `declined === 0`, the
   `/compact status` line must be byte-identical to round 2 — no empty
   parenthetical, no trailing space.
4. **`/compact` still answers.** With nothing worth dropping: type `/compact`
   while idle (*expected:* `Compaction did not run: nothing_to_drop` **and** a
   settled card) and while the agent is running (*expected:* a settled card — the
   queued form has no other surface).
5. **Overflow still explains itself.** Force a `context_overflow` from the
   provider with an uncompactable history. *Expected:* the info notice
   `Context window exceeded - compacting and retrying.` followed by a
   `context not compacted #N` card.
6. **Esc.** Press Esc during a live compaction. *Expected:* the card settles to
   `context not compacted #N: aborted` and does **not** stay live.
7. **`-p` mode.** `echo "hi" | aragon -p` against a session with an uncompactable
   history. *Expected:* no `[compaction] skipped:` line on stderr; stdout
   unchanged.
8. **The logs still know.** After scenario 1, grep the session log for
   `compaction`. *Expected:* one `compaction` line per declined attempt with
   `announced: false`, plus core's `compaction_start` / `compaction_end` pair.

### 7.4 Definition of done

- `npm run build`, `npm run typecheck` and `npm test` green at the workspace root.
  (`npm run build` is not a typecheck here — `tsconfig.json` excludes
  `__tests__`, so the new suite is only checked under `tsconfig.test.json`.)
- AC-Q1 … AC-Q16 present and passing.
- The assertions named in §7.2 unmodified, save the one comment edit §7.2 allows.
- No `announced` field on `Compactor` — `grep -n "this.announced" packages/cli/src`
  returns nothing (P1-1).
- CHANGELOG entry present; `context-auto-compaction/spec.md` §6.4 amended per §9.

---

## 8. Decisions

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| **D-1** | Suppression is expressed as a **position in the control flow** (the announce point), not as a reason-string filter. | Defaults to quiet for anything decided before work and loud for anything after. A blacklist defaults to loud and rots the moment a new decline reason is added; it also silences only the card, leaving `-p` stderr and the JSON stream noisy. | `if (reason === 'nothing_to_drop') return;` in `CompactionCard`. |
| **D-2** | Only the `pressure` trigger is affected; `manual` and `overflow` are byte-identical. | The complaint is about content that appears when the user did nothing. A `/compact` they typed, and an overflow that already broke their request, are not that. It also shrinks the blast radius to one trigger. | Suppressing all triggers uniformly — the queued `/compact` form would then have **no** reporting surface at all. |
| **D-3** | Commit point B sits **before** `buildDigest`, not immediately before `runLadder`. | A throw in the digest renderer arrives as `manager_threw`; with no card open it would be invisible on every human surface. One event on a path about to spend seconds is free. | Announcing immediately before `runLadder`: one event cheaper on a path that never runs, and it silently swallows digest faults. |
| **D-4** | `packages/core/**` is not touched. | The engine's event pair is the idle-watchdog contract and is emitted from a `finally` so it cannot be skipped. The engine has no card and no opinion about one. | A `silent` flag on `CompactionOutcome` so the engine could skip its own pair — couples a UI concern to the loop and risks a permanently deaf run. |
| **D-5** | The session compaction counter advances at the announce point, not the attempt point. | Makes card `#N` contiguous and makes `/compact status`'s `N compactions` mean "N compactions ran". Guards 1/2/4 keep their own attempt counters (E-18), so no anti-loop behaviour moves. | Leaving the counter at the attempt point: the user sees `#1` then `#3` with nothing on screen explaining the gap. |
| **D-6** | `settlePending` emits a `snapshot` on the no-record path. | Preserves the invariant "every settle refreshes the status surfaces", so nobody has to reason about which settle paths do and do not. It is **belt and braces, not a bug fix** (P2-5): `turn_end` already emits a snapshot every turn (`wiring.ts:504`), and the decline path is bounded at `stuckLimit` per session (E-17), so no user-visible staleness is actually being closed. It costs one cached-pressure read on a path that runs at most twice a session, and it is what makes the `declined` count of D-9 reach the chip's snapshot without a second mechanism. | Returning silently: correct today, and one exception a future reader has to rediscover. |
| **D-7** | Card copy (`context not compacted #N: <reason>`) is unchanged. | It is still reachable and still correct on every path that keeps it. Rewriting churns `compaction-render.test.tsx` and `transcript-text.ts` for a string the user did not complain about *when it is warranted*. | Rewording to prose in the same change — mixes a behavioural fix with a copy change, and the machine reason must be kept anyway for diagnosis. Tracked as R-A. |
| **D-8** | `child.ts`'s local `!applied && mode === 'none'` filter is retained. | Defence in depth, and the in-tree precedent that a no-op compaction is a non-event. Removing it would make the child depend on this document holding forever. | Deleting it as now-dead code. |
| **D-9** *(v2, P1-2)* | `/compact status` gains a `declined` count; the announcement itself stays a local rather than becoming instance state. | Two halves of one rule — **quiet is the goal, invisible is not.** The transcript loses the only human-readable trace of a decline, and `context-auto-compaction` §6.5 promises `/compact status` "answers every question about the feature's state at any width, in any mode, including after the fact". Without a counter that promise is false between the first decline and guard 4's self-disable, and the honest options are to add six lines or to weaken a published guarantee. The field is optional on `CompactionSnapshot` so the three existing construction sites — one of them inside a §7.2 suite — stay untouched, and the clause renders only when non-zero so a healthy session's output does not change at all. | (a) Leaving `/compact status` alone and relying on the JSONL log: a log is not a user surface, and "run with `--log-level` and grep" is not an answer to "is compaction working". (b) A new `/compact declines` subcommand: a whole command for one integer, on a surface that already has a line about session totals. (c) Keeping the announcement on `this` (v1): needs a no-re-entrancy argument, and the obvious one is wrong — see §3.2. |

---

## 9. The honesty rule, narrowed

`docs/plans/context-auto-compaction/spec.md` §6.4 currently reads:

> A **failed** compaction produces a card and a notice. "It did nothing" is never
> the observable outcome — the rule `fast-model-tier` states as R-8.

R-8 in `fast-model-tier/spec.md:1432` is *"a quiet capability — the user enables
the tier and cannot tell whether it ever did anything"*. That risk is about
**capability visibility**, and it is fully answered without a card for every
declined checkpoint. Amend §6.4 to:

> A **failed** compaction produces a card and a notice. A **declined** one — one
> that changed nothing, called nothing and spent nothing, decided before any work
> began — produces neither. In the transcript it is indistinguishable from a turn
> at which the threshold was never crossed. It is still *reported*, on two
> surfaces that are not the transcript: `/compact status` counts it
> (`This session: N compactions (M checkpoints declined)`), and the diagnostic log
> records it in full. If declines keep happening, guard 4 says so out loud, once
> (§3.8 guard 4). See
> `docs/plans/context-auto-compaction-quiet-noop/spec.md` §9. "It did nothing" is
> never the observable outcome of a compaction that **did** something, and "it is
> declining every time" is never something the user has to infer.

The surfaces that keep the capability visible, none of which may be weakened.
v2 states, for each, **what it actually says about a decline** — v1 credited
`/compact status` with more than it carried (P1-2):

1. **Guard 4's warn notice** (`compactor.ts:708-725`) — fires once, on the
   transition, naming the cause (`keepRecentTurns` is too high for this history)
   and the remedies (lower it, `/clear`, `/reset`). After at most `stuckLimit`
   declines (E-17) this is the *only* thing the user needs, and it is far more
   useful than the two red cards it replaces. **AC-Q10 pins it.** Says: *the
   safety net has given up, and here is why.*
2. **`/compact status`** — the documented "guaranteed reporting surface"
   (`limits.ts:147-148`, the comment that justifies dropping the chip below 100
   columns): live / self-disabled state, occupancy, threshold,
   summarizer, session compactions, spend and tail relief — **plus the `declined`
   count added by D-9**. Without that count this surface said nothing whatsoever
   about a decline, which is the gap P1-2 found. Says: *N checkpoints fired and
   chose to do nothing.* **AC-Q15 and AC-Q16 pin it.**
3. **The status-bar chip** (`StatusBar.tsx:312-318`) — `compact` / `compacting`,
   unchanged. Says: *the feature is on.* Nothing about declines, by design; two
   words at the edge of the screen are not a diagnostic.
4. **The diagnostic log** — core's pair (E-13, E-14) plus the CLI's own
   `compaction` line, now carrying `announced: false`. Says: *everything*, and it
   is the only surface that does. It is also not a user interface, which is why
   surfaces 1 and 2 have to stand on their own.

---

## 10. Risks & mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-1** | **The safety net fails silently** — auto-compaction declines every checkpoint and the user learns nothing until the run dies on `context_overflow`. | **High** | Impossible for more than `stuckLimit` (2) checkpoints — **and v2 states why, because the bound is a property of one call site rather than of the design** (P1-3). `nothing_to_drop` is the *only reachable* pre-commit decline (`no_anchor` is unreachable, E-23), and that branch calls `noteNoProgress` at `compactor.ts:427`, which self-disables and emits a warn notice naming cause and remedy. AC-Q10 pins the notice; D-9's `declined` count is the second net, and it holds even for a decline reason that forgets to charge guard 4. This is strictly *better* than today, where that notice is buried under two red cards reading `nothing_to_drop`. |
| **R-2** | A future decline reason is added **before** the commit point and inherits silence **without** inheriting guard 4's bound — reproducing R-1 through a new door. (v2 restates this risk: v1's version was about a reason added *after* the commit point, which is the harmless direction.) | Medium | §3.1's table is the checklist, and both announce points carry comments naming the rule. A reason added *after* the commit point is loud by default, which is right — by then work has happened. A reason added *before* it is silent by default, which is also right, but silence is only safe while the attempt is bounded. **Standing rule: any new pre-commit decline must either call `noteNoProgress` or be proven unreachable, and the proof goes in §2 as evidence** (E-23 is the worked example). D-9's `declined` count catches the case where someone forgets, at the cost of the user having to type `/compact status`. |
| **R-3** | **The `-p` / JSON-stream contract changes** for wrapper scripts that counted compaction events. | Medium | Documented in §5.1 and the CHANGELOG. Pairs stay balanced, so only consumers counting *attempts* are affected, and those were already reading a number the JSONL log reports more accurately. No consumer in this repository counts attempts (checked: `exec/runner.ts`, `agent/headless.ts`, `compaction/child.ts`). |
| **R-4** | `compaction_start` stops being emitted synchronously, breaking the abort-race assumption (E-21) and leaving a card `live: true` forever — which pins `Transcript`'s monotonic boundary and re-renders the tail on every frame for the rest of the session. | Medium | The path from `compact()` to commit point B contains no `await` today. **AC-Q12** asserts the synchrony directly, so a future `await` inserted above the commit point fails a test instead of shipping. |
| **R-5** | The incidental seal of a stale `streamingId` performed by `case 'compactionStart'` (`reducer.ts:1646-1650`) no longer happens on declined checkpoints. | Low | That seal is documented as defensive, and the overwhelmingly common path — `shouldCompact` returning `false` — never performed it either. The stale entry is still sealed by `turnEnd` and by the run's own error handling. A declined checkpoint becomes exactly as safe as a checkpoint that did not fire, which is the invariant §3.7 states. |
| **R-6** | Index contiguity (D-5) confuses someone correlating a card against an archive written by an older build. | Low | Archive filenames carry `runId` **and** a timestamp (E-20), so files from different runs never collide, and only `applied: true` compactions are archived — a set this design does not change. |
| **R-7** | A reviewer reads §9 as licence to suppress *failures* too. | Low | §3.1's table is exhaustive and marks every post-commit outcome `yes, always`; §3.8 lists what must not change; AC-Q8 fails if a post-commit failure stops announcing. |
| **R-8** | Test churn beyond the intended blast radius. | Low | §7.2 names the five suites that must stay green untouched. If one needs editing, the implementation has drifted from this design. |
| **R-A** *(deferred; not a risk of this change)* | The surviving `context not compacted #N: <raw reason>` copy is still machine-flavoured and error-coloured on the paths where it is warranted. | — | Out of scope by D-7. If taken up later: keep the raw reason (diagnosis, and `compaction-render.test.tsx:114-127` asserts it) and prefix prose, e.g. `context not compacted #2 - nothing worth dropping yet (nothing_to_drop)`. Its own change, its own acceptance criteria. |

---

## 11. Rollback

Single-commit revert. The change adds no persisted state, no schema and no file
format; the one type change is an **optional** field on an internal interface
(`CompactionSnapshot.declined?`, D-9), which no consumer outside this repository
sees. Round-2 behaviour is recovered exactly by restoring the five edited files
under `src/`.

A **partial** rollback is also available and safe: deleting the
`if (uiTrigger !== 'pressure')` condition in `compact()` — i.e. announcing
unconditionally — restores round-2 behaviour on every trigger while keeping the
new structure, the contiguous indices and the tests. Only AC-Q1, AC-Q2, AC-Q4,
AC-Q9 and AC-Q13 would then fail, and they would fail loudly rather than change
behaviour quietly.

---

## 12. Out of scope

- Card copy and colour (D-7 / R-A).
- The duplicate reporting on the idle `/compact` path — a `warn` notice *and* a
  card for the same decline (E-16). Pre-existing, unchanged, harmless.
- **A throwing `shouldCompact()` (P2-6).** `agent-loop.ts:211-232` emits core's
  `compaction_start` / `compaction_end` pair *without* ever calling
  `cm.compact()`, so `manager_threw` from the predicate reaches
  `settlePending()` with `this.open === null` and has no card today. It gains
  none here, and it is the first of the two holes in §3.1's table (IF-2). Named
  rather than fixed: the predicate is `Compactor.shouldCompact`, it does not
  throw, and giving the engine's throw-guard a CLI card is a change to a path
  that only a host bug can reach.
- **A throw above commit point B.** The pre-commit region is four pure,
  synchronous calls over the message array, so a throw there is a host bug — but
  on `pressure` it now reaches `settlePending()` with `this.open === null` and
  gets no card, where round 2 gave it one. It is worse than the hole above it,
  because `noteNoProgress` is never reached and `finish` is never called: guard 4
  does not charge it and `declined` does not count it, so it would repeat at every
  checkpoint until the run dies on `context_overflow` — the exact shape R-1
  declares impossible and R-2 was written to prevent. Named rather than fixed:
  the only fix that keeps the feature is to hoist the announcement into
  `compact()` so a `catch` there can announce before rethrowing, and that puts the
  announcement back behind an indirection P1-1 removed on purpose. IF-2 carries
  the trade for the next round; the announce point in `compactor.ts` carries the
  note.
- **Removing the dead `no_anchor` branch (E-23).** It is D-6's "the anchor is
  non-negotiable" stated locally, and a provably-dead guard is worth more than
  the non-null assertion that would replace it. §3.4 records the reasoning.
- Any change to when compaction *fires* (`shouldCompact`, thresholds, guards).
- Any change to `packages/core/**` (D-4).
- Sub-agent compaction reporting: children have no card by design (W3 of the
  hardening round) and this change does not give them one.

---

## 13. 评审结论 (Review Verdict)

### 有条件通过 (Approved with conditions)

The design is sound and the shape is right. The central judgement — that
"announce" is a *position in the control flow* rather than a string blacklist —
is the correct one, and it is the difference between a fix that holds and a fix
that rots the next time someone invents a decline reason. D-2's refusal to touch
`manual` and `overflow`, D-3's placement of commit point B above `buildDigest`,
and D-4's refusal to touch `packages/core/**` are each the choice I would have
argued for. The evidence table is unusually good: I checked all 22 rows against
the tree and every one holds.

All four blocking findings (P0-1, P1-1, P1-2, P1-3) are **resolved in this v2**.
No P0 or P1 remains open. Approval is conditional on the four items below, which
are verification obligations rather than open design questions — each one has a
named artefact that makes it checkable rather than remembered.

| # | Condition | Discharged by |
|---|---|---|
| **C-1** | **`no_anchor`'s unreachability must be asserted, not assumed.** E-23's proof is a statement about two functions in two packages, and the whole of R-1's bound now leans on it. AC-Q2's `reason === 'nothing_to_drop'` assertion is what turns it into a tripwire: if the plan/anchor relationship ever changes, that assertion fails and points the reader at §3.4 instead of letting a new silent-and-unbounded decline path open quietly. | AC-Q2, in the form given in §7.1 — the `reason` half is not optional. |
| **C-2** | **No `announced` field may reappear on `Compactor`.** The whole of P1-1 is that a per-call value must not live on per-session state; a reviewer who finds `this.announced` in the implementation should send it back regardless of whether the tests pass, because the failure it enables (a card that never settles) is invisible until the session it happens in. | §7.4's `grep -n "this.announced" packages/cli/src` returning nothing, run as part of the DoD. |
| **C-3** | **`declined` must reach the screen, not just the snapshot.** The counter is worthless if it stops at `sessionTotals()`, and it is worse than worthless if it renders in sessions that had no declines. | AC-Q15 **and** AC-Q16, including AC-Q16's negative half. |
| **C-4** | **Manual rows 1, 3 and 3a must be run on a real terminal before merge.** This change is defined by an absence, and an absence is the one thing a unit test cannot fully vouch for: AC-Q1 proves no event was emitted, but only a human watching a long unattended run can confirm that nothing appears in the transcript, that guard 4's notice arrives exactly once, and that the status line then explains what happened. Rows 1 and 3 together are the reported bug and its replacement answer. | §7.3 rows 1, 3, 3a, recorded in the PR description. |

### Not conditions, but worth carrying forward

- **R-A (D-7's deferred copy fix) is now the largest remaining wart.** After this
  change every surviving `context not compacted #N: <raw reason>` card is one the
  user asked for or one the provider forced, and each is still rendered in
  `theme.toolError`. Deferring it here is right — mixing a behavioural fix with a
  copy change doubles the review surface — but the follow-up is worth scheduling
  rather than filing.
- **The `-p` / JSON-stream contract change (R-3) is real and correctly
  documented.** No consumer in this repository counts attempts; the CHANGELOG
  entry required by §7.4 is what covers the ones outside it.
- **§6.5's "guaranteed surface" claim in the parent spec is now load-bearing in a
  way it was not before.** D-9 keeps it true. Anyone who later trims
  `/compact status` should read §9 first.

**Reviewer's summary.** The user asked for one thing: stop telling me about
compactions that did not happen. This design does that, and it does it in the
place where the sentence "nothing happened" is actually true rather than in the
place where it is cheapest to intercept. What v2 adds is the other half of the
same sentence — a compaction that did not happen should be *quiet*, not
*unrecorded* — and one integer on a status line is a small price for keeping the
project's own honesty rules intact.

---

## 14. 实施过程发现的方案缺陷 (Issues Found During Implementation)

Recorded per the implementation brief: the design was followed, not silently
deviated from. One finding, and it is a budget/threshold miss rather than a
behavioural one — nothing in §3, §5 or §6 changed as a result.

### IF-1 — §4's line budget is ~3x low, and it lands `compactor.ts` past the project's 1000-line file cap

*Where:* §4, "Line-budget estimate".

§4 estimates **~62 lines added / ~15 removed under `src/`**. The delivered change
is **+281 / -39** across the six `src/` files, of which `compactor.ts` alone is
**+198 / -37** (the last 12 of those are the IF-2 note the review round added at
commit point B). The estimate counted the *statements* the design introduces —
which really are about 60 — and not the **doc comments §3.2, §3.4, §3.5 and §3.3
prescribe verbatim**, which are roughly two thirds of the delta and are the part
this document argues hardest for keeping (P1-1 exists precisely because a wrong
load-bearing comment is how a future refactor breaks an invariant confidently).

The consequence is not the arithmetic. `packages/cli/src/compaction/compactor.ts`
was **927 lines** before this change and is **1088** after, and `CLAUDE.md`'s
Clean Code Guidelines cap a source file at **1000 lines** ("超过即按职责拆分到新
模块"). The design nowhere notices that the one file it prescribes ~150 lines of
mandatory commentary for was already at 93 % of that ceiling.

**What was done, and why.** The change was implemented as specified and the file
is over the cap. The three alternatives were each worse:

- *Trim the comments to fit.* They are the substance of this round — C-2, R-2 and
  the `no_anchor` unreachability proof live in them, and the DoD asks a reviewer
  to check for `this.announced` rather than for a test. Deleting the reasoning to
  satisfy a line count inverts the priority the document itself sets.
- *Split `Compactor`.* A real refactor, out of scope by the implementation brief
  ("do not rename, refactor, or clean up anything not called for in the design")
  and not listed in §4's change plan. It would also mix a structural change into
  the one commit whose value is that it is small and revertible (§11).
- *Move `announced` onto the `args` object* to avoid the ~20 lines of pure
  formatting that a fifth positional parameter forces on four previously
  single-line `this.finish(...)` call sites. Rejected: §3.5 puts it in the slot
  `args.index` vacated on purpose, so that the value is "read where it was
  written, one function away", and `finish` is at exactly five parameters — the
  documented ceiling, not past it.

**Recommendation for the next round** (not this one): split the reporting helpers
— `finish`, `sessionTotals`, `measure`, `lastMeasured`, `recordApplied`,
`noteUsage` — out of `Compactor` into a `compaction/reporting.ts`, or move the
failure ladder (`runLadder` and its helpers) into its own module. Either brings
the file back under 1000 without touching a single invariant. It is deliberately
**not** done here, because a threshold breach that is visible and recorded is
cheaper than a structural refactor smuggled into a behavioural fix.

**Everything else in §4 held.** The other five `src/` files are within a few lines
of the estimate, no file outside the change plan was touched, the ASCII rule
(§4's reminder) is satisfied — `glyphs.test.ts` passes — and §7.2's five named
regression suites are green with only the one comment edit §7.2 explicitly
allows.

### IF-2 — §3.1 and §12 both treat `manager_threw` as a post-commit-only outcome

*Where:* §3.1 (the classification table), §12 (P2-6), §10 (R-1, R-2).

Found in review, after the change was implemented as designed. §3.1 files
`manager_threw` under **after commit** and marks it `yes, always`; §12 named a
throwing `shouldCompact()` as *the* one hole in that otherwise exhaustive table.
There is a second. `runCompaction()`'s pre-commit region — `countProtectedPrefix`,
`planCompaction`, `relieveInPlace`, `buildAnchor` — can throw, and
`agent-loop.ts:265-267` turns any throw out of `cm.compact()` into `manager_threw`.
Round 2 announced eagerly on every trigger, so `this.open` was always set and
`settlePending` had a skeleton to settle; after this change a `pressure` compaction
that throws there settles nothing and shows nothing.

The severity is not the missing card. That path calls neither `noteNoProgress` nor
`finish`, so guard 4 never charges it and `declined` never counts it: it is the one
failure in the feature that is both **silent and unbounded**, repeating at every
checkpoint until the run dies on `context_overflow`. That is the failure R-1
declares impossible, reached through the door R-2 was written to watch — R-2
requires a new pre-commit *decline* to charge guard 4 or be proven unreachable, and
says nothing about a pre-commit *throw*.

**What was done, and why.** Recorded, not closed. The fix that preserves the
feature is to move the `announced` local and its closure up into `compact()` so a
`catch` there can `announce(summarizer)` before rethrowing — but `finish()` would
then read the announcement through a getter instead of the argument P1-1 put it in,
trading a real hole for a weakened version of the invariant this round exists to
establish. Announcing unconditionally from a `catch` is strictly worse: a throw
*below* commit point B would announce twice and leave a card that never settles.
Both are design changes, and a reviewer should not make one against an explicit,
reasoned decision on a latent host-bug path. §3.1 and §12 are corrected to say what
is true, and the announce point in `compactor.ts` carries the note where someone
considering moving it will read it.

**Recommendation for the next round** (not this one): hoist the announcement into
`compact()` behind `catch { announce(summarizer); throw err; }`, and pin it with an
AC that makes `planCompaction` throw and asserts exactly one `compaction_start`. It
is about ten lines and one test, and it retires the last un-carded fault path.
