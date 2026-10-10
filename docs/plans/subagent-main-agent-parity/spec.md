# Subagent main-agent parity — design specification

- **Feature slug:** `subagent-main-agent-parity`
- **Version:** **v1** (implementation-led; this document records the design as
  shipped, written alongside the code it describes)
- **Status:** shipped
- **Package touched:** `packages/cli` (one documented-semantics change in
  `packages/core`'s `ToolExecutor`, plus its test). Core's export list is
  unchanged.

---

## 0. The requirement

Two sentences, taken literally:

1. **Subagents run the same model as the lead, with the same fast/slow
   cooperation.** When the lead pulls up children, every child is as capable
   as the lead: same provider, same model id, same thinking level, same token
   ambition — and the same periodic `<fast_review>` second opinion.
2. **Subagents have no tighter timeout or context regime than the lead.** Same
   mode, same configuration: no per-child wall clock, no dispatch wall clock,
   no turn cap, and the lead's own compaction policy instead of a tighter
   overlay.

## 1. Model parity

- `SubagentSpec` **loses `tier`**; `normalizeSubagentSpecs` **loses
  `NormalizeOptions`**. A stale `model: "fast"` key in a dispatch is ignored
  silently — there is no tier to downgrade to, and a report line about a
  capability that no longer exists teaches the model a wrong cost model.
- `createSubagent` reads the **live** `config.provider` / `config.model` /
  `config.baseUrl` / `config.thinkingLevel` at dispatch time. The only model a
  child can surprise its lead with is one a settings-screen edit made live
  between two dispatches.
- `FastWiring.resolveTier` and `delegationAvailable` are removed. What remains
  of the tier for children is the **transport** (`completeViaFastRegistry`),
  shared by every child reviewer — one lazy registry per session, the same
  adapter-state-reuse argument `TeamRuntime` makes about the lead's registry.
- `fast.delegate` (config key, `--fast-delegate` / `--no-fast-delegate` flags,
  `/fast delegate`, `config set fast.delegate`) is **removed** in full; there
  is no delegation switch left to flip.

## 2. Per-child fast review

`team/child-reviewer.ts` gives each dispatched child its own `FastReviewer`:

- **Shared:** the tier resolution (re-run live on every use — a mid-dispatch
  `/fast off` stops child reviews at the same instant it stops the lead's),
  the fail-fast transport, and the `fast.*` policy keys.
- **Per child:** one reviewer instance, its own turn-frame ring, its own
  session budget, its own goal (the spec's description).
- The reviewer's protocol is unchanged: steer from exactly one place, never
  into a requested abort, prove delivery at the next `turn_start`.
  `userSteerCount` is always zero for a child (no human can steer one), which
  makes `clearAllQueues` provably safe; `isAbortRequested` reads the
  **handle-level** abort flag `TeamRuntime` sets before `agent.abort()`.
- A child's `<fast_tier>` prompt block is spliced only when that child will
  actually have a reviewer — the prompt can never advertise a capability the
  child lacks, and a child with a reviewer is never surprised by its first
  injection. `FAST_BLOCK_VERSION` is `v2-2026-10`.
- Child reviews emit and notify through the **logger only** — a child has no
  transcript card and no status chip; the panel row and the dispatch report
  are where a child's internals belong.

## 3. The no-limit regime

| Key | Old default | New default | Meaning of `0` |
| --- | --- | --- | --- |
| `team.subagentTimeoutMs` | `300000` | **`0`** | no per-child wall clock |
| `team.dispatchTimeoutMs` | `900000` | **`0`** | no dispatch wall clock; the `task` tool override arms no timer |
| `team.maxTurnsPerSubagent` | `24` | **`0`** | no turn cap |

- The three keys clamp through `clampIntAllowingZero` with `min: 0` — the
  exact trap `scrollResumeMs` records: a plain `clampInt` folds `0` back to
  the fallback and the user's "off" never sticks. `applyTeamConfigSet` routes
  every numeric `team.*` key through `clampTeamConfig` for the same reason
  (`coercePositiveInt` cannot express `0`).
- `TeamRuntime` arms **no timer** when the value is `0`; a wedged child is
  still ended by its own idle watchdog — the exact ceiling the lead runs
  under. `team_wait`'s ceiling falls back to the structural
  `TEAM_LIMITS.waitMaxSeconds` when the child itself has no wall clock, so
  one forgotten peer wait cannot hold a slot forever.
- Core's `ToolExecutor` treats a timeout override of `0` as **no timer**
  (before, `setTimeout(fn, 0)` aborted the tool immediately — a value no
  working caller could ever have wanted). `packages/core` API.md documents
  the semantics; `executor-zero-override.test.ts` pins them.
- Child context compaction keeps only the **connection overlay** (provider /
  model / base URL / manual window follow the model the child actually runs
  on). `keepRecentTurns`, `onFailure`, `useFastTier` and `archive` are read
  live from the same config the lead reads; the per-run bound is the same
  structural `COMPACTION_LIMITS.maxPerRun`. `childKeepRecentTurns` /
  `childMaxPerRun` are gone.

## 4. Reporting

One tier, one table: `DispatchOutcome` carries a single `usage` total
(`fastUsage` and `downgraded` are gone), priced at the lead's cost table —
the only honest price, since every child ran the lead's model. The report has
no `Fast tier:` line, no `[fast]` row marker, and no downgrade sentence. The
team panel and card drop the `~` fast-child marker and the `n fast` note.
`ExecFastTierEvent.delegated` stays in schema v1, pinned to `0` and
documented as deprecated, so machine consumers keep parsing.

## 5. Session compatibility

Old session files and team archives may carry `tier: 'main' | 'fast'`;
`validate-session` keeps accepting it in both directions and renderers treat
absence as main. Nothing is migrated on disk.

## 6. Tests

- `team-model-parity.test.ts` (replaces `fast-task-tier.test.ts`): the stale
  `model` key is silence; children are built with the lead's `ModelRef` even
  while a fast tier is live; one total; no fast report sections; the three
  `0` defaults and the explicit-`0` clamp; `createChildReviewer` gating.
- `team-config.test.ts`: `0` survives the clamp; small positives are kept;
  the upper bounds still clamp.
- `compaction-child.test.ts`: the child keeps the lead's own `keepRecentTurns`
  and runs under the same per-run bound.
- `model-profile-runtime.test.ts`: a dispatched child bills the **main**
  credentials even with a live fast tier.
- `executor-zero-override.test.ts` (core): override `0` arms no timer.
