# TODO plan follow-through — design specification

- **Feature slug:** `todo-plan-followthrough`
- **Version:** **v2** (round 2 of the todo work; v1 reviewed and revised — see
  §0.0 评审记录)
- **Status:** design only — no implementation code in this node
- **Predecessor:** `docs/plans/todo-plan-execution/spec.md` v2, shipped as
  `bf6aeb1a` ("feat: plan complex work as a TODO list and show it in a
  right-hand rail")
- **Package touched:** `packages/cli` only. `packages/core` gains zero source
  changes, exactly as round 1 (AC-32 there; here it is **I-7 + DoD-2**, which is
  where the claim actually lives).

---

## 0.0 评审记录 (Review notes)

Reviewed against the tree at `bf6aeb1a`. Every line reference in v1 was checked,
and the W3 measurement was **re-run** rather than read. Six findings changed the
design; one of them (P0-1) defeats the round's central premise.

### P0

| # | Finding | Where | Resolution in v2 |
|---|---|---|---|
| **P0-1** | **Both auto-continue caps are defeated simultaneously by a re-planning model, so the loop is not bounded at all.** §3.2's `advanceBudget` rule «`snapshot.total !== prev.anchorTotal` → return a **zeroed** budget» zeroes `used` *and* `noProgressStreak`. A model that emits a differently-sized list on each continuation therefore resets both counters every turn; `TODO_LIMITS.staleTurns` cannot bind either, because that model *is* calling `todo_write`. R-2 asserts "the total cap is not reset by anything", which the design's own rule contradicts. The result is exactly the unbounded cost loop non-goal 1 exists to deny, reachable without any adversarial intent — "re-plan as you learn" is behaviour the prompt encourages. | §3.2, R-2 | `used` is now **monotonic within a list lineage**: an `anchorTotal` change forgives `noProgressStreak` only. Only `snapshot === null` zeroes `used`. §3.2, §5.1, AC-13, AC-35, R-2, D-16 |

### P1

| # | Finding | Where | Resolution in v2 |
|---|---|---|---|
| **P1-1** | **`mode` is read from a stale closure.** §3.4 step 3 passes `cfg.todo.followThrough`, but the controller subscription's deps are `[controller, flushPending, cancelPendingHuman]` (`App.tsx:348`) — the effect never re-runs, so it keeps the `cfg` captured at mount, and `setTodoConfig` *replaces* the object (`controller.ts:831`). `/todo follow auto` would report success and change nothing until relaunch: verbatim the P1-2 defect class this package has already paid for twice. | §3.4 | Read `controller.getTodoConfig().followThrough` at decision time. §3.4, AC-36 |
| **P1-2** | **Headless never charges `used`, so `-p` has no total cap.** §3.4 puts the increment in the TUI arming code; §3.6 does not mention it. With P0-1 fixed the TUI is bounded and `-p` still is not — the one environment with no human to press `Esc`. R-6's "The same caps" is not implementable from the text as written. | §3.6, R-6 | The headless loop increments `used` immediately before each re-prompt, and AC-37 pins the cap in `-p`. |
| **P1-3** | **W3's measured debt is wrong: 12 errors across 10 files, not 8 across 7.** The v1 measurement covered `src/__tests__/**` and missed the **nested** `src/skills/__tests__/**` tree in *both* packages — cli `skills/__tests__/fetch-source.test.ts:186`, `skills/__tests__/integrity.test.ts:258` and `:281`; core `skills/__tests__/skill-find.test.ts:34`. §7.3 calls §3.8's table authoritative and DoD-1 demands a clean `npm run typecheck`, so an implementer who repairs the listed eight lands red with no explanation. (v1's `skills-controller.test.ts:50` fix note was also wrong: the error is `mouse: boolean \| undefined` not assignable to `boolean`, not a missing key.) | §3.8, §7.3 | Table replaced with the re-measured 12, plus the two commands that produced it so the next reader can re-measure instead of trusting. AC-34, AC-38 |
| **P1-4** | **`ARAGON_TODO_FOLLOW` can silently drop `enabled`.** `env.ts:167` writes `partial.todo = { enabled: … } as PersistedConfig['todo']`, and **the cast defeats the compiler**: a second `if` block that assigns `partial.todo` again loses `ARAGON_TODO`'s `enabled` with no error anywhere. `ARAGON_TODO=0 ARAGON_TODO_FOLLOW=auto` would silently re-enable the tool. | §4.2 | One accumulated `section` object, the shape the `team` branch above it already uses, with the cast applied once at the end. AC-39 |
| **P1-5** | **`CommandContext.submit`'s signature is missing from the change plan.** It is `submit: (text: string) => void` (`commands/registry.ts:30`), so AC-17 ("neither `/todo continue` nor the auto path calls `recordPrompt`") cannot be implemented without widening it. §7.2 is billed as the authoritative file list, and C-9's whole lesson is that a surface needs *every* site. | §7.2 | `commands/registry.ts` added to §7.2 and to §4.3. |
| **P1-6** | **§3.4's justification for reading `stateRef.current` is inverted, and the real dependency is unstated.** Ink 5 mounts a **legacy root** (`createContainer(rootNode, 0 /* LegacyRoot */, …)`, `node_modules/ink/build/ink.js:59-61`), so a `dispatch` from the controller's promise context flushes **synchronously** — the read is *post*-commit, not "the last rendered state ... before `runEnd` is committed". The conclusion (both readings agree) survives, but only because legacy roots do not batch there. Under a concurrent root — an Ink major bump, or its `experimental` renderer — the batching returns and `errorNoticed`, set by the `message_update{error}` callback that immediately precedes `agent_end` (core throws the stream error at `agent-loop.ts:175` and emits `agent_end` from `runLoopWithLifecycle`'s `finally` with only microtasks between them), would still read `false`. That auto-continues into a run that just failed with a 401 or a quota error: D-6 defeated silently. R-7 names a different and much less likely hazard. | §1, §3.4, R-7 | End reason comes from an `endReasonRef` mutated **synchronously in the same callback that dispatches the actions**, with the reducer fields kept as the cross-check. C-11, §3.4, AC-40, R-7, D-17 |

### P2 (all fixed in v2 except where noted)

| # | Finding | Resolution |
|---|---|---|
| P2-1 | Grace window is 2.5 s in C-6 and §5.2, 3000 ms in §8.1 and the notice text. | 3 s throughout. |
| P2-2 | Four broken internal cross-references: §0 "(AC-30 here)"; C-10 "re-asserted here as AC-29" (it is AC-2); §3.4 "(AC-13)" for the history fix (it is AC-17); C-10's summary of round-1 AC-31, which is about `HOST_TOOL_NAMES`, not the prompt. | All four corrected. |
| P2-3 | The state type is `ViewState`, not `AppState`, and it lives in `src/agent/reducer.ts`, not `src/ui/`. | Renamed throughout; path stated in §3.1. |
| P2-4 | The strip's `+N done` threshold of 80 columns is an unnamed magic number (`statusCompactCols` is 100, `MIN_FULLSCREEN_COLS` is 40). | Named `TODO_LIMITS.stripDoneCols`, §8.1, AC-41. |
| P2-5 | `theme.symbols` no longer exists (folded into `glyphs.ts`); and it is `ui/` being in the glyph scanner's scope — not `todo/` — that binds `TodoStrip.tsx`. | §3.7 and C-4 corrected. |
| P2-6 | AC-29 asserts a `measureElement` height, which **no test in this package does** (the one mention, `app.test.tsx:594`, is a comment). The established idiom is `stripAnsi(lastFrame()).split('\n')`. | AC-29 restated in the idiom the repo actually uses. |
| P2-7 | `advanceBudget`'s `doneAtRunStart` comment ("when the run that just ended STARTED") contradicts the algorithm, which assigns it at every `agent_end`. | Comment corrected to what the code maintains. |
| P2-8 | `recordHistory: false` also suppresses the `submitCount` bump, which drives the composer's hint fade (`Composer.tsx:80`). Correct — an auto-continuation is not the user demonstrating they have learned a shortcut — but undocumented, and the parameter name hides it. | Stated in §3.4 and renamed `userInitiated`. |
| P2-9 | `Esc` with an overlay open returns at `App.tsx:937-947` and never reaches the idle branch, so it will not cancel an armed continuation. | Precedence stated explicitly in §3.4; overlay first, second `Esc` cancels. |
| P2-10 | §4.3 asserts `/todo follow` does not rebuild the prompt, but `setTodoConfig` rebuilds **unconditionally** (`controller.ts:832`). Harmless — the block does not mention follow-through, so the output is identical — but the claim is false and the "per-turn cost" framing is wrong (it is per-command). | §4.3 corrected. |
| P2-11 | `ARAGON_TODO_FOLLOW` sits against the rule `env.ts:158-163` states in source — env vars exist only where a flag *and* a config file are both unreachable, which is why there is deliberately no `ARAGON_TODO_PANEL`. | Kept, with the argument that passes that test written down (D-18). |
| P2-12 | §3.6 does not say the three `unsubscribe` calls stay **outside** the loop, nor what `aborted` is in headless. | Both stated. |

---

## 0. What round 1 shipped, and what it left open

Round 1 delivered the whole of the requirement's first half and the display:
`todo_write` as a full-replacement host tool, a `TodoStore` that is a projection
of what the model believes, repair-never-reject normalization that enforces
exactly one `in_progress` item, and a right rail that takes a fifth of the
terminal and windows around the step in progress rather than slicing from the
top. That is verified in the tree, not taken on the document's word:
`packages/cli/src/todo/{limits,types,normalize,store,todo-tool,prompt,panel-rows}.ts`,
`src/ui/layout/rail.ts`, `src/ui/TodoPanel.tsx`, `src/ui/entries/TodoCard.tsx`.

What it did **not** deliver is the requirement's second half — *「然后按照 TODO
执行计划，一个一个去完成」*. Today the plan is followed **only because the prompt
asks for it**. `src/todo/prompt.ts` tells the model to mark one item done and the
next in progress in the same call; nothing checks that it did. When a run ends
with four steps unfinished, `src/ui/App.tsx:321-336` prints one notice —

> `4 todo items are unfinished. Use /todo continue to pick up where this run
> stopped, or /todo clear to drop it.`

— and stops. Round 1 filed that under non-goal 1 with a good argument
("auto-continuation is an unbounded cost loop wearing a helpful hat") and a
matching open question. **This round does not overturn that judgement; it bounds
the loop and then permits it**, opt-in, with an economy that makes the worst case
arithmetic rather than trust.

Three further gaps are in scope, each of which round 1 named in writing:

- The notice above fires on **every** `agent_end` with unfinished items,
  including the run the user just killed with `Esc`. Pressing stop and being
  told what you interrupted is the CLI answering a question nobody asked.
- **OQ-1** — inline mode has the tool and no plan surface beyond a `todo 3/7`
  counter in the status bar. The user cannot see *which step* is running in the
  mode that `decideRenderMode` (`src/ui/layout/frame.ts:70-83`) selects for every
  pipe, every `CI=1`, every `TERM=dumb` and every terminal under 12 rows.
- **IF-8** — `packages/cli/tsconfig.json` excludes `**/__tests__/**` and vitest
  transpiles without typechecking, so a required-field widening breaks test
  fixtures while `npm run build` and `npm test` are both green. Round 1 tripped
  this twice in one feature and recorded it as inherited standing debt. It is 12
  errors in total across both packages (**re-measured in review**, §3.8 — v1 said
  8 and had missed a whole nested test directory in each package), which is still
  small enough that leaving it is a choice rather than a constraint.

### 0.1 Requirement trace

| Requirement (original Chinese) | Round 1 | This round |
|---|---|---|
| 复杂任务先规划 TODO | `todo_write` + `<todo_planning>` block | unchanged |
| 简单任务直接执行 | prompt threshold (3+ steps) + `minFreshItems` guard | unchanged |
| 按 TODO 计划一个一个执行 | prompt-only; passive notice at the end | **W1** — end-reason-aware notice, bounded auto-continue, enumerated continuation |
| 显示在 TUI 最右边，占 20% 宽度 | `todoRailWidth` = 20% clamped [18, 36], fullscreen | **W2** — a one-row plan strip for inline mode, where there is no rail |
| 稳健、可靠、顶级 | 44 ACs, 14 test files | **W3** — the test tree is typechecked in CI-able form |

### 0.2 Workstreams and their independence

- **W1 · Follow-through** (§3.2–§3.6). The substance of this round.
- **W2 · Inline plan strip** (§3.7). Closes OQ-1.
- **W3 · Typecheck the test tree** (§3.8). Closes the IF-8 debt.

W2 and W3 touch disjoint files from W1 and from each other. If W1 is cut in
review, W2 and W3 still stand and vice versa; the change plan in §7 is grouped so
that a partial landing is a clean subset rather than a merge exercise.

---

## 1. Overview

**What is being built.** A run that ends with an unfinished plan currently
produces a sentence. This round turns that moment into a decision with three
inputs the CLI already has — *did the user abort it, did it error, did the list
move* — and three possible outcomes: say nothing, say something true, or
continue the plan. The decision is a pure function
(`src/todo/follow-through.ts::decideFollowThrough`) shared by the TUI and by
headless mode, so the two cannot drift; the continuation it produces enumerates
the remaining steps rather than saying "continue", so it survives a context
window that has scrolled the original `todo_write` out of view.

**Why the loop is now allowed.** Round 1's objection was cost, and cost is what
the economy bounds. Auto-continue is off by default (`todo.followThrough:
'notify'` reproduces today's behaviour byte for byte). When a user turns it on it
runs under two counters, both structural constants rather than settings: a
continuation that fails to complete a step buys exactly one more attempt
(`maxNoProgressContinues`), and a single list may be continued at most 25 times
total (`maxAutoContinuesPerList`) however productive it looks. The first counter
is what makes a model that has stopped engaging with its own plan hand control
back to the human after one nudge; the second is the ceiling that holds when
everything else is wrong. In interactive mode the continuation is announced and
then fires after a grace window that `Esc` cancels, so the user is never told
about a decision they cannot reverse. In headless mode there is no grace window,
because there is nobody there to use it — which is precisely why the counters,
not the human, are the protection there.

**Why an end reason, and why it is derived.** `AgentEndEvent`
(`packages/core/src/types.ts:24-27`) carries `messages` and nothing else: the CLI
cannot ask core *why* a run ended, and this round does not change core to make it
possible. It does not need to. `ViewState` (`src/agent/reducer.ts:181-184`)
already distinguishes the three cases for its own silent-failure guard —
`aborted` (set by `abortMark`, `reducer.ts:643`), `errorNoticed` (set by any
`error`-level notice, `reducer.ts:639`) and `turnProduced` — and `runEnd` reads
exactly that triple at `reducer.ts:612` to decide whether a run that produced
nothing was a failure or a cancellation. Follow-through asks the same question of
the same two of those three fields. No new event, no new subscription, no core
change, and the question is one the CLI already answers correctly.

**Where it is read from, and why not from React state.** The reducer is the
*definition* of the end reason; it is not a safe *channel* for it, because the
answer is needed inside a controller callback rather than during a render. v1
read `stateRef.current` there and justified it with React's commit timing, which
review found inverted (P1-6): Ink 5 mounts a **legacy** root, so those dispatches
flush synchronously and the read is post-commit, not pre-commit. It happens to
give the right answer today for that reason and no other. Since the failure mode
under a concurrent root is silent and expensive — auto-continuing into a run that
just failed authentication — the reason is instead carried by an `endReasonRef`
that the event handler mutates **in the same synchronous callback that dispatches
the corresponding action** (C-11). The reducer fields stay exactly as they are
and become the cross-check (AC-40), not the transport.

---

## 2. Constraints inherited from the shipped code

Each one was checked against the tree at `bf6aeb1a`, and each one kills at least
one otherwise-reasonable design.

- **C-1 — The tool array is built once.** `AgentController` fixes
  `todoRegistered` at construction (`controller.ts:232`) and `/todo on` cannot
  add a tool to a session started with `--no-todo`. Follow-through therefore may
  not be implemented as a tool.
- **C-2 — `agent_end` has no reason field, and core is frozen.** See §1. In the
  TUI the reason is defined by `ViewState` and carried by `endReasonRef` (C-11);
  in headless it is the local `errored` flag `runHeadless` already maintains, and
  `aborted` is structurally `false` — `-p` has no `Esc` and installs no signal
  handler that marks one, so there is nothing to derive.
- **C-3 — `TodoStore` is zero-I/O and has no timers** (`store.ts:7-10`). The
  grace-window timer belongs to the App, not to the store. Nothing in
  `src/todo/**` may gain a timer or a file handle.
- **C-4 — the glyph scanner covers `src/todo/**` *and* all of `src/ui/**`.**
  `glyphs.test.ts`'s `inScope` is `rel.startsWith('ui/') || /^(agent|commands|
  config|team|todo|tools)\//.test(rel) || rel === 'cli.tsx'`. So both new files
  are in scope: the continuation message (`todo/`) and the strip (`ui/`). Every
  string either adds is ASCII, and the strip's separator comes from `pickGlyphs`
  rather than a literal (§3.7). Note `agent/headless.ts` is on the `EXEMPT_FILES`
  list — `-p` runs no capability probe — so the new `[todo]` lines are not
  scanner-enforced and must be kept ASCII by hand.
- **C-5 — `prompt()` is the turn boundary.** `controller.prompt()` calls
  `todos.beginUserTurn()` (`controller.ts:565`), which ages the list and drops a
  fully-completed one. An auto-continuation goes through `prompt()`, so it
  **consumes one of `TODO_LIMITS.staleTurns`** (3). See D-9: this is correct
  behaviour, but it is a real interaction and it bounds the continuation count
  independently of anything this round adds.
- **C-6 — `submitMessage` steers while running** (`App.tsx:689-694`). Any
  continuation must re-check `isRunning()` at fire time, not only at decision
  time: the grace window is 3 s and the user can type in it. The check earns its
  place twice over — without it a fired continuation would either be silently
  swallowed into `controller.steer()` (the *quiet* failure) or reach
  `void controller.prompt()`, which **rejects** when the agent is already running
  (`agent.ts:196-198`) and would surface as an unhandled rejection.
- **C-7 — The status bar's left cluster is `flexShrink={0}`**
  (`StatusBar.tsx:169`), and the comment above it records what happens when the
  row over-subscribes: Ink drops a character from *each* cluster and the bar
  renders `idl` / `? hel`. A variable-length step title cannot go there. This is
  what forces W2 into its own row (§3.7).
- **C-8 — `AppShell`'s inline branch omits `rail` structurally**
  (`AppShell.tsx:100-111`), which round 1 chose over trusting the caller to pass
  `null`. W2's `strip` slot mirrors that discipline in the opposite direction:
  it is rendered **only** in the inline branch.
- **C-9 — A flag needs three sites.** `.option()` in `cli.tsx`, a field on
  `CliFlags`, and a line in the `CliFlags` literal (`cli.tsx:172-178` records
  that this package has paid for the omission twice). Both new surfaces in §4.3
  list all three.
- **C-10 — `--no-todo` must stay byte-identical.** Round 1's **AC-30** asserts
  both halves — a system prompt byte-identical to the pre-feature output and a
  tool array identical by object identity. (Round 1's AC-31 is a different claim:
  `HOST_TOOL_NAMES` equals what `createBuiltinTools` produces.) This round adds
  no prompt text at all (D-3), so AC-30 is inherited unchanged and re-asserted
  here as **AC-2**.
- **C-11 — Ink 5 mounts a legacy root, and nothing may depend on that.**
  `node_modules/ink/build/ink.js:59-61` calls
  `reconciler.createContainer(this.rootNode, 0 /* Legacy mode */, …)`, so a
  `dispatch` issued from a promise context flushes synchronously and
  `stateRef.current` is current between two controller callbacks. That is an
  accident of Ink's major version, not a contract, and the concurrent-root
  behaviour it hides is React 18's default. Any state this feature reads inside a
  controller callback is therefore held in a ref this feature mutates itself, in
  the same callback (§3.4). The reducer fields remain the definition and the
  cross-check.
- **C-12 — `CommandContext.submit` is a fixed one-argument function**
  (`commands/registry.ts:30`, `submit: (text: string) => void`), wired to
  `submitMessage` by a lambda at `App.tsx:654`. `/todo continue` cannot opt out of
  prompt history without widening that signature, which makes `registry.ts` a
  fourth site the change plan has to name (§7.2).

---

## 3. Technical design

### 3.1 Module map

```
src/todo/
  limits.ts            MODIFIED  + TODO_FOLLOW_LIMITS, + TODO_LIMITS.stripDoneCols
  follow-through.ts    NEW       pure decision + budget state machine + message builder
  types.ts             MODIFIED  + FollowThroughMode re-export point (type only)
src/ui/
  App.tsx              MODIFIED  agent_end -> decide -> notice | armed continuation
  TodoStrip.tsx        NEW       W2, inline-only one-row plan strip
  layout/AppShell.tsx  MODIFIED  W2, + strip slot (inline branch only)
src/agent/
  headless.ts          MODIFIED  W1 in -p: continuation loop + per-iteration reset
  reducer.ts           UNCHANGED the end reason is DEFINED here and read via a ref (C-11)
src/config/
  schema.ts            MODIFIED  + todo.followThrough, clamped
  load.ts              MODIFIED  + --todo-follow resolution
  env.ts               MODIFIED  + ARAGON_TODO_FOLLOW (accumulated, §4.2)
src/commands/
  builtins.ts          MODIFIED  /todo follow <mode>; continuation text; history fix
  registry.ts          MODIFIED  CommandContext.submit gains the options arg (C-12)
```

`ViewState` and the reducer live in **`src/agent/reducer.ts`**, not under
`src/ui/` — the one path v1 left implicit and got wrong in prose.

### 3.2 The decision (`src/todo/follow-through.ts`)

One exported pure function, no I/O, no timers, no React, no `Date.now()`
(a caller that wants a clock passes one — the discipline `TodoStore`'s injected
`now` already establishes).

```ts
export type FollowThroughMode = 'notify' | 'auto' | 'off';

/** Carried across runs by the caller. Serializable, comparable, inert. */
export interface FollowThroughBudget {
  /**
   * Auto-continuations issued against this list LINEAGE.
   *
   * MONOTONIC UNTIL THE LIST IS GONE (P0-1 / D-16). It is NOT reset by a
   * re-plan: a model that emits a differently-sized list on every continuation
   * would otherwise zero both counters every turn while `staleTurns` also never
   * fires (it IS writing), which is an unbounded loop reachable by ordinary
   * "re-plan as you learn" behaviour rather than by anything adversarial.
   */
  used: number;
  /** Consecutive auto-continuations after which doneCount did not increase. */
  noProgressStreak: number;
  /** `TodoSnapshot.total` the budget was opened against. Identity, not a count. */
  anchorTotal: number;
  /**
   * `doneCount` as observed at the PREVIOUS `agent_end` — which is what
   * `advanceBudget` assigns, in every branch, and therefore what the next call
   * compares against. (v1's comment said "when the run that just ended started";
   * the two coincide in the normal case, but only the former is what the code
   * maintains, and an implementer who captures it at `runStart` instead builds a
   * different state machine.)
   */
  doneAtRunStart: number;
}

export interface FollowThroughInput {
  mode: FollowThroughMode;
  snapshot: TodoSnapshot | null;
  runEnd: { aborted: boolean; errored: boolean };
  budget: FollowThroughBudget;
  /** false in headless: no grace window, and a different notice verb. */
  interactive: boolean;
}

export type FollowThroughDecision =
  | { kind: 'none' }
  | { kind: 'notify'; level: 'info' | 'warn'; text: string }
  | { kind: 'continue'; message: string; graceMs: number; notice: string };
```

`decideFollowThrough(input)` evaluates **in this order, and the order is
semantics, not style** — the same sentence `decideRenderMode` carries:

1. `snapshot === null` or `doneCount >= total` → `none`. Nothing is unfinished;
   round 1 already drops a fully-completed list at the next `beginUserTurn`, so
   this branch must not pre-empt that moment of feedback.
2. `mode === 'off'` → `none`. The user asked for silence and gets silence,
   including no notice.
3. `runEnd.aborted` → `none`. **This is a bug fix, not a policy** (§0): the
   user pressed `Esc`; restating what they interrupted is noise, and offering to
   continue it is worse.
4. `runEnd.errored` → `notify` at `warn`:
   `"N steps left; the run ended with an error. /todo continue to retry, /todo clear to drop it."`
   **Never `continue`, in any mode.** Auto-continuing into a model that just
   failed is the unbounded cost loop with none of the upside.
5. `mode === 'notify'` → `notify` at `info`, with **today's exact string**
   (`App.tsx:328-329`), so the default path is byte-identical (AC-1).
6. `budget.used >= TODO_FOLLOW_LIMITS.maxAutoContinuesPerList` → `notify` at
   `warn`, naming the cap.
7. `budget.noProgressStreak >= TODO_FOLLOW_LIMITS.maxNoProgressContinues` →
   `notify` at `warn`:
   `"N steps left; the last N attempts completed none of them. /todo continue to retry."`
8. Otherwise → `continue`, with `graceMs = interactive ?
   TODO_FOLLOW_LIMITS.graceMs : 0`.

Two helpers travel with it, both pure and both exported for direct test:

```ts
/** Fold a finished run into the budget. Called BEFORE decide, every agent_end. */
export function advanceBudget(
  prev: FollowThroughBudget,
  snapshot: TodoSnapshot | null,
  wasAutoContinuation: boolean,
): FollowThroughBudget;

/** The text an auto-continuation (or `/todo continue`) submits. */
export function buildContinuationMessage(snapshot: TodoSnapshot): string;
```

`advanceBudget` holds the whole state machine and it is four rules:

- `snapshot === null` → return a **zeroed** budget. The list is gone; so is its
  economy. This is the *only* path that clears `used`, and it is not reachable by
  a model on its own: `TodoStore.write` leaves the previous list untouched when a
  payload yields zero usable items (`store.ts:70-78`), and the other three ways a
  list disappears are `/todo clear`, `/reset` and `beginUserTurn` dropping a list
  that is either finished (nothing to continue) or `staleTurns`-stale (which the
  streak rule beats to the punch, §3.5).
- `snapshot.total !== prev.anchorTotal` → re-anchor at the new total and zero
  **`noProgressStreak` only**; `used` carries over. **A re-plan buys forgiveness,
  not a fresh wallet** (D-16). Round-1's instinct was right that replanning is
  engagement rather than looping, and forgiving the streak is how that instinct
  is honoured; zeroing `used` as well is what P0-1 showed makes the hard ceiling
  unreachable — a size change every turn would reset it every turn. `total` is
  still the only identity signal available without giving lists an id, and giving
  lists an id would mean the store minting one, which is state the model does not
  know about (I-2).
- `wasAutoContinuation && snapshot.doneCount <= prev.doneAtRunStart` →
  `noProgressStreak + 1`. Note the guard: **a run the user started themselves
  never charges the streak**, because the user asking a question mid-plan is not
  the model failing to advance it.
- `snapshot.doneCount > prev.doneAtRunStart` → `noProgressStreak = 0`.

In every branch `doneAtRunStart` is then set to the current `doneCount`, which is
what makes the next call's comparison meaningful. `used` increments at the point
of firing — §3.4 in the TUI and §3.6 in headless, and **both are required**
(P1-2) — not here, so a decision that is never acted on costs nothing.

### 3.3 The continuation message

Today `/todo continue` submits the fixed string
`'Continue with the remaining todo items.'` (`builtins.ts:373`). That is a
reference to a `todo_write` call which, in a long session, may be far enough back
that the model reconstructs it wrong or not at all — and reconstructing it wrong
is silent, because whatever it writes next is a full replacement and becomes the
new truth.

`buildContinuationMessage` therefore enumerates:

```
Continue the plan. These steps are not done yet:
1. Wire the rail into AppShell
2. Add the strip for inline mode
3. Update the README
Work the next one, then call todo_write to mark it completed and the following
one in_progress before you move on.
```

Rules: `content` (never `activeForm` — the imperative is what an instruction
wants); numbers are the item's **1-based position in the whole list**, so "step
5" means the same thing here as it does in the rail; completed items are omitted
entirely; the list is capped at `TODO_LIMITS.maxItems` by construction, so the
message is bounded at roughly 80 × 20 + 200 ≈ 1.8 kB worst case. ASCII only
(C-4). Both `/todo continue` and the auto path use this function, which is what
keeps them from drifting.

### 3.4 Arming, firing, and cancelling (TUI)

In `App.tsx`'s `agent_end` handler, replacing lines 318-331:

```
1. budgetRef.current = advanceBudget(budgetRef.current,
                                     controller.getTodoSnapshot(),
                                     autoContinuationRef.current)
2. autoContinuationRef.current = false
3. decision = decideFollowThrough({ mode: controller.getTodoConfig().followThrough,
                                    snapshot: controller.getTodoSnapshot(),
                                    runEnd: { ...endReasonRef.current },
                                    budget: budgetRef.current,
                                    interactive: true })
4. endReasonRef.current = { aborted: false, errored: false }
5. 'none'     -> nothing
   'notify'   -> dispatch({ type: 'notice', level, text })
   'continue' -> dispatch the notice, then arm the timer
```

**The mode comes from the controller, not from `cfg` (P1-1).** This subscription
effect's dependency list is `[controller, flushPending, cancelPendingHuman]`
(`App.tsx:348`) and never re-runs, so it closes over the `cfg` object from the
render in which it mounted; `setTodoConfig` builds a *new* config object
(`controller.ts:831`), which that closure will never see. `cfg.todo.followThrough`
would therefore be pinned to the launch value for the whole session and
`/todo follow auto` would report success and do nothing — the P1-2 defect this
package has already paid for twice. `controller.getTodoConfig()` returns the live
object, so it is the only correct read *inside a callback*. Note the asymmetry:
§3.7's `showStrip` uses `cfg.todo.panel` and is right to, because it runs in
render scope where `cfg` is re-read every frame (`App.tsx:206`).

**The end reason comes from a ref this feature maintains (P1-6 / C-11).**
`endReasonRef.current` is `{ aborted, errored }`, mutated synchronously at the
three points that already know the answer:

- in the action loop, `if (action.type === 'notice' && action.level === 'error')
  endReasonRef.current.errored = true` — the same action that sets
  `ViewState.errorNoticed`, set at the same instant rather than one commit later;
- in the `Esc` handler, next to `dispatch({ type: 'abortMark' })`;
- cleared at step 4 above and in `submitMessage`, mirroring where the reducer
  clears its own copies (`reducer.ts:452` / `:462`).

v1 read `stateRef.current` instead and argued it was a pre-commit read that
happened to agree. It is in fact a *post*-commit read (Ink's legacy root flushes
those dispatches synchronously, C-11) that happens to agree — because `runEnd`
does not clear either field. Both routes give the right answer under Ink 5. The
ref does not stop giving it under a concurrent root, and the failure it forecloses
is the expensive one: a provider stream error is emitted as `message_update` and
then `agent_end` follows from `runLoopWithLifecycle`'s `finally`
(`agent.ts:409-418`) with only microtask boundaries in between, so under React
18's default batching the `errorNoticed` read would be `false` and `auto` mode
would re-prompt a model that just failed authentication. AC-40 pins the sequence
directly, so this cannot regress silently whatever Ink does next.

Arming, in full:

```ts
followTimer.current = setTimeout(() => {
  followTimer.current = null;
  if (controller.isRunning()) return;                 // C-6
  const live = controller.getTodoSnapshot();
  if (!live || live.doneCount >= live.total) return;  // list moved under us
  budgetRef.current = { ...budgetRef.current, used: budgetRef.current.used + 1 };
  autoContinuationRef.current = true;
  submitMessage(decision.message, { userInitiated: false });
}, decision.graceMs);
```

Cancellation has exactly three triggers and they all call one
`cancelFollowThrough()` helper (clear the timer, null the ref, leave the budget
alone):

- **`Esc`** — added to the existing handler at `App.tsx:936-956`, in the branch
  where `status !== 'running'` (today that branch does nothing at all, which is
  what makes it free to take). It toasts `'info', 'Auto-continue cancelled.'`.
  **Overlay precedence is unchanged and deliberate (P2-9):** the handler returns
  early while an overlay is open (`App.tsx:937-947`), so with one open the first
  `Esc` closes the overlay and the second cancels the continuation. Reaching past
  the overlay branch would make "close this dialog" silently also mean "abandon
  the plan", and the case is nearly unreachable anyway — `cancelPendingHuman()`
  on `agent_end` already dismisses the plan and question overlays before any
  continuation is armed.
- **The user submits anything** — first line of `submitMessage`. A user message
  is a new intent and outranks a queued one.
- **Unmount** — the effect's cleanup, next to `flushPending()`.

**No live countdown.** The notice is written once ("Continuing with 4 remaining
steps in 3s — Esc to stop.") and does not tick. A 10 Hz re-render of the whole
frame to animate a number is precisely the repaint cost round 1's §1.2 refused
elsewhere, and Ink's two dedupe gates (`ink.js:132`, `log-update.js:13`) mean the
alternative is not free either.

**`{ userInitiated: false }`.** `submitMessage` currently calls `recordPrompt`
unconditionally (`App.tsx:696`). An auto-continuation the user never typed must
not appear under the composer's up-arrow, and **neither should `/todo
continue`'s canned string** — the user typed `/todo continue`, which the slash
history already has. `submitMessage` gains an optional second parameter
`{ userInitiated?: boolean }` defaulting to `true`; the two todo paths pass
`false`, and `CommandContext.submit` grows the same optional argument so
`builtins.ts` can reach it (C-12). This is an in-passing fix to a round-1 defect
and it carries its own acceptance criterion (**AC-17**) so it cannot be lost in
review.

The parameter is named for the *cause* rather than for one of its effects,
because skipping `recordPrompt` skips two things (P2-8): the history append and
the `submitCount` bump. The second is load-bearing — `submitCount` drives the
composer's hint fade, which exists to "retire things the user has demonstrably
learned" (`Composer.tsx:77-80`). An auto-continuation demonstrates nothing about
the user, so suppressing it is correct rather than incidental, and a flag called
`recordHistory` would have made a reader think it was a bug.

### 3.5 Interaction with the stale-turn counter (C-5)

`prompt()` → `beginUserTurn()` → `turnsSinceWrite += 1`, and at
`TODO_LIMITS.staleTurns` (3) an unfinished list is cleared. An auto-continuation
is a `prompt()`, so it ages the list like any turn.

This is left exactly as it is, and it is a feature: a continuation that produces
no `todo_write` at all is a run that did not engage with the plan, and after
three of those the plan should be gone. It also means the two mechanisms bound
each other — the streak rule (§3.2 rule 7) stops at 2, which is inside the stale
window, so in practice the streak rule always fires first and the user gets a
sentence rather than a silently vanishing rail. An implementer must **not**
"fix" this by exempting continuations from `beginUserTurn`: that would make an
auto-continue loop immortal, which is the one property this design exists to
deny.

### 3.6 Headless (`-p`)

`runHeadless` gains a bounded loop around its single `await controller.prompt()`
(`headless.ts:176-182`). The decision is safe to take the moment `prompt()`
resolves: `agent.prompt()` awaits `runLoopWithLifecycle()`, whose `finally` emits
`agent_end` *before* resolving (`agent.ts:409-418`), and `emit` is synchronous —
so `errored` and `sawTurnEnd` are already final. Five requirements, all of which
are defects if missed:

0. **The loop increments `used` before each re-prompt (P1-2).** §3.4 puts that
   increment in the TUI's timer callback; headless has no timer, so an implementer
   reading only §3.6 would leave `used` at 0 forever and
   `maxAutoContinuesPerList` would never bind — in the one environment with no
   human to press `Esc`. AC-37 pins the cap in `-p` for exactly this reason.

1. **`sawTurnEnd` must reset per iteration.** It is the silent-failure detector
   (`headless.ts:98`): `if (!sawTurnEnd && !errored) errored = true`. Left
   sticky, a swallowed throw on iteration 2 is invisible because iteration 1 set
   the flag. `errored` is deliberately **not** reset — once a run has errored the
   exit code is 1 and the loop must stop.
2. **`HeadlessController` gains `getTodoSnapshot?(): TodoSnapshot | null`**,
   optional for the reason `subscribeTeam?` and `subscribeTodos?` are optional
   and the comment at `headless.ts:21-40` states twice: the interface is
   satisfied by object literals in tests, and a required member breaks every
   existing stub for no benefit. Absent ⇒ the loop never runs ⇒ byte-identical
   to today.
3. **The decision is the same function**, called with `interactive: false` and
   `aborted: false` (C-2 — `-p` has no abort surface, so there is nothing to
   derive and nothing to plumb). A `continue` decision writes
   `[todo] continuing (N steps left)` to stderr and re-prompts; a `notify`
   decision writes `[todo] N steps unfinished` and exits. Both are suppressed by
   `--quiet`, like every other `[todo]` line.
4. **The three `unsubscribe` calls stay outside the loop.** They live in the
   `finally` at `headless.ts:177-181`, and the loop must wrap that whole
   `try/finally` rather than being nested inside it. Unsubscribing per iteration
   would silently cost iteration 2 onwards its `[todo]` progress lines, its team
   usage accounting and — worst — the `agent_end` handler that computes `errored`,
   so a failing second iteration would exit 0.

Exit codes are untouched: 0 / 1 / 2 keep their current meanings, and an
unfinished plan is **not** an error. Changing that would break every script that
pipes `aragon -p`, for a condition the caller can see in the output.

### 3.7 W2 — the inline plan strip

`AppShellProps` gains `strip?: React.ReactNode`, rendered **only in the inline
branch**, between `viewport` and `team`:

```tsx
if (mode === 'inline') {
  return (
    <Box flexDirection="column">
      {header}{viewport}{strip}{team}{toast}{composer}{status}
    </Box>
  );
}
```

The fullscreen branch does not reference `strip` at all — the structural mirror
of C-8, and the reason is the same: a prop that is *supposed* to be null in one
mode becomes non-null eventually, and then the rail and the strip are both on
screen showing the same list. Fullscreen has the rail; that is the whole design.

`TodoStrip` renders one row and never more:

```
todo 3/7  >  Adding the rail to AppShell                        +2 done
```

- Left: `todo D/T`, the same counter and the same
  `TODO_LIMITS.statusCompactCols` degradation the status bar already applies, so
  the two never disagree.
- Middle: the anchor item, chosen by the **existing** `todoAnchorIndex`
  (`panel-rows.ts`) — in-progress, else first unfinished, else last. Shows
  `activeForm` when the anchor is `in_progress` and `content` otherwise, which is
  the rule `TodoPanel` already uses. `wrap="truncate"` inside a
  `flexGrow={1} flexShrink={1}` box, so the row can never wrap: a wrapping strip
  in inline mode would push the composer down by an unpredictable number of rows
  on every keystroke.
- Right: `+N done` when `doneCount > 0`, and nothing below
  **`TODO_LIMITS.stripDoneCols`** (80). v1 wrote that threshold as a bare literal
  (P2-4), which this subsystem's own §8.1 discipline forbids and which would have
  been the only unnamed layout bound in the tree — the two neighbouring constants
  are `statusCompactCols` (100) and `MIN_FULLSCREEN_COLS` (40), so a reader had no
  way to tell whether 80 was a third policy or a typo for one of them. AC-41
  references it.
- The separator comes from `pickGlyphs(caps)` — `glyphs.arrowRight`, which is
  `>` on the ASCII tier — never a literal. (`theme.symbols` no longer exists; the
  former `ThemeSymbols` was folded into `glyphs.ts` verbatim, `glyphs.ts:25`.)
  `TodoStrip.tsx` is inside the glyph scanner's scope because it is under `ui/`,
  not because of the `todo/` clause — see C-4.

Mount gate in `App.tsx`, deliberately **not** `!showRail` (which is true for four
different reasons, three of which mean "do not draw this"):

```ts
const showStrip = !fullscreen && cfg.todo.panel && state.todos !== null;
```

`cfg.todo.panel` is included because `--no-todo-panel` means "keep the planning,
drop the display" and a strip is a display. Overlays are not consulted: inline
mode's overlays are part of the document flow, not a modal that owns the screen.

### 3.8 W3 — typecheck the test tree

Two new tsconfigs and two scripts; no source semantics change.

`packages/cli/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "dist"]
}
```

`packages/core/tsconfig.test.json` is the same without `jsx`/`tsx`. Each package
gains `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"`,
and the root gains `"typecheck": "npm run typecheck --workspaces --if-present"`.
`--noEmit` on the first invocation matters: without it the typecheck writes into
`dist/` and races the build. Two things were checked rather than assumed: the
inherited `exclude` **is** replaced by the child's (which is what pulls
`__tests__` back in), and `types: ["node"]` is safe because every test file
imports `{ describe, it, expect, vi }` from `'vitest'` explicitly — nothing relies
on globals, so no `vitest/globals` entry is needed. `tsBuildInfoFile` is inherited
but inert (neither `incremental` nor `composite` is set anywhere), so the two
invocations cannot stomp each other's build info.

**Re-measured during review (P1-3).** v1 reported 8 errors in 7 files, having
scanned only `src/__tests__/**`; both packages also have a **nested**
`src/skills/__tests__/**`, which the tsconfig above necessarily includes. The
actual debt is **12 errors across 10 files**. Reproduce with the two probes
(temporary configs identical to the ones above, deleted afterwards):

```
cd packages/cli  && npx tsc -p tsconfig.test.json    # 9 errors, 7 files
cd packages/core && npx tsc -p tsconfig.test.json    # 3 errors, 3 files
```

| File | Error | Fix |
|---|---|---|
| `cli/src/__tests__/app.test.tsx:90` | TS2739 `CliConfig` missing `mouse`, `log`, `team` | add the three to the literal |
| `cli/src/__tests__/mouse-routing.test.tsx:369` | TS2739 missing `log`, `team` | same |
| `cli/src/__tests__/question-overlay.test.tsx:200` | TS2345 `colorLevel: 0` vs `3` | widen the helper's parameter to `ColorLevel` |
| `cli/src/__tests__/skills-commands.test.ts:32` | TS2741 `SkillRecord` missing `integrity` | add the field |
| `cli/src/__tests__/skills-controller.test.ts:50` | TS2322 `mouse: boolean \| undefined` not assignable to `boolean` | **not** a missing key (v1 said "complete it"): the fixture's own type is too loose — narrow it, do not touch `CliConfig` |
| `cli/src/__tests__/skills-controller.test.ts:303` | TS2554 2 args, expected 3 | pass the third |
| `cli/src/skills/__tests__/fetch-source.test.ts:186` | TS2322 stub returns `Promise<void>`, needs `Promise<RunProcessResult>` | return a result object from the stub |
| `cli/src/skills/__tests__/integrity.test.ts:258` | TS2554 2 args, expected 3 | pass the third |
| `cli/src/skills/__tests__/integrity.test.ts:281` | TS2554 2 args, expected 3 | same |
| `core/src/__tests__/provider-output-limit.test.ts:282` | TS2741 `ModelInfo` missing `cost` | add it |
| `core/src/__tests__/smoke.test.ts:73` | TS2322 `AgentTool<{text}>` vs `AgentTool<Record<string,unknown>>` | annotate the fixture |
| `core/src/skills/__tests__/skill-find.test.ts:34` | TS2554 2 args, expected 3 | pass the third |

Every one is still fixture drift, and the four newly-found errors are the *same*
drift as `skills-controller.test.ts:303` — one shared helper grew a third
parameter — which is mild evidence that the diagnosis was right even though the
count was not. The lesson worth carrying: **`find src -type d -name __tests__`
before claiming a tree is measured**; `src/__tests__` is a convention here, not a
rule.

**No `@ts-expect-error`, no `as any`, no widening a production type to make a
fixture compile.** Every one of these is the fixture being wrong, and a
suppression here would re-open the exact hole the workstream closes. If a fix
turns out to require a production change, that is a finding to report, not a
change to make.

### 3.9 Logging

One line, at the fire point, reusing the `'agent'` scope that round 1 settled on
for CLI-local todo events (IF-1 — `LogScope` is a closed union and
`logging/logger.ts` is not in either change plan):

```ts
getLogger().debug('agent', 'todo_follow', {
  used, noProgressStreak, total, done, mode,
});
```

Counts only, never item text — D-19's rule, unchanged and for the same reason.
No log line for `none` decisions: the quiet path must stay quiet.

---

## 4. Interface design

### 4.1 Config (`config.json`, section `todo`)

```ts
export interface TodoConfig {
  enabled: boolean;
  panel: boolean;
  /** What happens when a run ends with unfinished steps. Default 'notify'. */
  followThrough: FollowThroughMode;   // NEW
}
export const DEFAULT_TODO_CONFIG: TodoConfig = {
  enabled: true, panel: true, followThrough: 'notify',
};
```

`clampTodoConfig` gains the third line. There is no enum helper in
`config/schema.ts`, so it follows the `isThinkingLevel` shape already there
(`schema.ts:49`):

```ts
const FOLLOW_THROUGH_MODES: FollowThroughMode[] = ['notify', 'auto', 'off'];
function followMode(v: unknown, fallback: FollowThroughMode): FollowThroughMode {
  return typeof v === 'string' && (FOLLOW_THROUGH_MODES as string[]).includes(v)
    ? (v as FollowThroughMode)
    : fallback;
}
```

**`store.ts`'s two hand-written merges need no change** — verified, and worth
stating because round 1's P0-1 was exactly the opposite situation. Both merges
spread the whole section (`{ ...DEFAULT_CONFIG.todo, ...(partial.todo ?? {}) }`
at `store.ts:155` and `{ ...current.todo, ...(patch.todo ?? {}) }` at
`store.ts:208`), so a third scalar key is carried automatically. The section
stays **flat and scalars-only**, which is the condition those merges are correct
under; anything nested here means replacing them first.

### 4.2 CLI flag and environment

`--todo-follow <mode>` — a **value flag, not a pair**, so C-9's `!== undefined`
rule applies to its presence rather than to a commander-materialized `true`:

- `cli.tsx` `.option('--todo-follow <mode>', 'What to do when a run ends with unfinished steps: notify (default) | auto | off')`
- `CliFlags.todoFollow?: string` in `config/load.ts`
- `todoFollow: opts.todoFollow` in the `CliFlags` literal at `cli.tsx:172-178`

`resolveTodoConfig` (`load.ts:222-234`) gains one spread, in the same
defaults › file › env › flags order:

```ts
...(flags.todoFollow !== undefined ? { followThrough: flags.todoFollow } : {}),
```

An unrecognized value is **clamped to the default, not rejected**, by
`clampTodoConfig` — the discipline every other key in this file follows. It is
therefore silent, and that is the trade round 1 already made for `--thinking`.

`ARAGON_TODO_FOLLOW=notify|auto|off` in `config/env.ts`, parsed in the one place
`ARAGON_TODO` is parsed (`env.ts:167-173`) so the two readers cannot disagree.

**It must accumulate into one section object, not assign `partial.todo` twice
(P1-4).** Today that block ends with
`partial.todo = { enabled: … } as PersistedConfig['todo']`, and **the cast is what
makes the mistake silent**: a second `if` block assigning `partial.todo` again
compiles clean and drops `enabled`, so `ARAGON_TODO=0 ARAGON_TODO_FOLLOW=auto`
would quietly re-enable the tool the user turned off. The shape is the one the
`team` branch twenty lines above already uses — build up a local, cast once:

```ts
const section: Record<string, unknown> = {};
const todo = process.env.ARAGON_TODO?.trim().toLowerCase();
if (todo) section.enabled = todo === '1' || todo === 'true' || todo === 'on' || todo === 'yes';
const follow = process.env.ARAGON_TODO_FOLLOW?.trim().toLowerCase();
if (follow) section.followThrough = follow;   // clamped later, never rejected
if (Object.keys(section).length > 0) partial.todo = section as PersistedConfig['todo'];
```

A partial `todo` section is safe downstream because `resolveTodoConfig` spreads it
over the file layer rather than replacing it — the contract the existing comment
calls out. AC-39 asserts the pair.

### 4.3 Slash command

`/todo follow <notify|auto|off>` joins the existing verbs. It follows the
**two-call rule** `builtins.ts:270-281` spells out at length, minus the prompt
rebuild:

```ts
controller.setTodoConfig({ followThrough: mode });   // live runtime (P1-2)
ctx.persistConfig({ todo: { followThrough: mode } as PersistedConfig['todo'] });
```

`setTodoEnabled` is **not** called — nothing in `<todo_planning>` mentions
follow-through (D-3), so `todoEnabled` has no bearing here. What v1 got wrong
(P2-10) is the next sentence: it claimed "the prompt is not rebuilt", but
`setTodoConfig` calls `this.rebuildSystemPrompt()` **unconditionally**
(`controller.ts:832`), so a rebuild happens whether or not this command wants one.
That is harmless and must be left alone: the rebuild is idempotent for this key
(the block does not mention follow-through, so the output is byte-identical,
AC-3), it costs one string composition *per command invocation* rather than per
turn, and `setTodoConfig` is the only method that updates the object `App` reads
at render time (P1-2). An implementer must not add a `/todo follow` branch that
bypasses `setTodoConfig` to avoid the rebuild — that trades a free string
concatenation for the exact "reports success, changes nothing" bug the method
exists to prevent.

`ctx.submit` needs the widened signature from C-12 to pass
`{ userInitiated: false }`, so `commands/registry.ts` is part of this change.

`/todo status` gains one clause: `... Panel: on. Follow-through: auto (2/25 used).`
The counters appear only in `auto` mode; printing `0/25` in `notify` mode would
advertise a budget nothing is spending.

The `/todo` `description` string and the `HelpOverlay` `COMMANDS` row both change
— `HelpOverlay.tsx` carries a **hand-maintained** list (IF-6), and it is the
second time this feature has had to remember it.

### 4.4 Controller surface

```ts
getTodoConfig(): TodoConfig;                              // exists; now 3 keys
setTodoConfig(patch: Partial<TodoConfig>): TodoConfig;    // exists; unchanged
```

No new controller members. The budget lives in the App (a ref) and in
`runHeadless` (a local), because it is a property of *a session's interaction
with the user*, not of the model's plan — the controller owns the latter and
should not learn about the former.

---

## 5. Data model

### 5.1 Runtime

`FollowThroughBudget` (§3.2) is the only new shape. It is held in
`useRef<FollowThroughBudget>` in `App`, initialized to
`{ used: 0, noProgressStreak: 0, anchorTotal: 0, doneAtRunStart: 0 }`.

`anchorTotal: 0` against a first snapshot of any size takes the re-anchor branch
on the first `advanceBudget` — which is correct and is also why the initial value
needs no special case. With the P0-1 fix that branch no longer clears `used`, and
it does not need to here: `used` is already 0.

Two other refs, neither of them state in any meaningful sense: `followTimer`
(`NodeJS.Timeout | null`) and `endReasonRef` (`{ aborted, errored }`, §3.4).

### 5.2 View state

**None.** No new `ViewState` field, no new reducer action. The armed timer is a
ref, the budget is a ref, the end reason is a ref, and the notices go through the
existing `{ type: 'notice' }` action. This is deliberate: every field added to
`ViewState` is a field `restoreEntries`, `/clear`, `/reset` and the session
round-trip each have to have an opinion about, and none of them has an opinion
about a 3-second timer.

### 5.3 Persisted

`SavedSession` is **unchanged**. A saved session does not carry the budget: it is
counting attempts within one live conversation, and a `/resume` a week later
starts a new one. `config.json` gains the one scalar of §4.1.

---

## 6. UI design

### 6.1 Notices

| Situation | Level | Text |
|---|---|---|
| `notify`, clean end | info | *(today's string, unchanged)* |
| any mode, run errored | warn | `N steps left; the run ended with an error. /todo continue to retry, /todo clear to drop it.` |
| `auto`, armed | info | `Continuing with N remaining steps in 3s - Esc to stop.` |
| `auto`, cap reached | warn | `N steps left; auto-continue has run 25 times for this plan. /todo continue to keep going.` |
| `auto`, no progress | warn | `N steps left; the last 2 attempts completed none of them. /todo continue to retry, or take over.` |
| `auto`, cancelled | toast/info | `Auto-continue cancelled.` |
| aborted | — | *(nothing)* |

Every string is ASCII (C-4 covers `src/todo/**`, and these are built there).
Round 1's singular/plural treatment (`item is` / `items are`) is preserved in the
one string it already applies to; the new strings use "steps", which is the noun
`<todo_planning>` and the rail already use.

### 6.2 Degradation matrix

| Mode | Terminal | Rail | Strip | Status counter |
|---|---|---|---|---|
| fullscreen | >= 80 cols, >= 6 rail rows | yes | no | no |
| fullscreen | narrow / short / overlay open | no | no | yes |
| fullscreen | `--no-todo-panel` | no | no | yes |
| inline | any width | no | **yes** | yes |
| inline | `--no-todo-panel` | no | no | yes |
| `-p` | n/a | no | no | `[todo]` stderr lines |

The strip and the status counter deliberately coexist in inline mode: the
counter is in the status bar's left cluster, the strip is its own row, and the
duplication buys the counter's presence during the frames where the strip is
truncated to nothing on a very narrow terminal.

---

## 7. File / module change plan

### 7.1 New files (3)

| File | Intent |
|---|---|
| `packages/cli/src/todo/follow-through.ts` | `decideFollowThrough`, `advanceBudget`, `buildContinuationMessage`; pure, ASCII, no timers |
| `packages/cli/src/ui/TodoStrip.tsx` | W2: the one-row inline plan strip |
| `packages/cli/tsconfig.test.json` (+ `packages/core/tsconfig.test.json`) | W3: typecheck the test tree |

### 7.2 Modified files (13 rows, 16 files — the last two rows cover more than one)

| File | Change | WS |
|---|---|---|
| `src/todo/limits.ts` | `+ TODO_FOLLOW_LIMITS`, `+ TODO_LIMITS.stripDoneCols` (§8.1) | W1+W2 |
| `src/todo/types.ts` | re-export `FollowThroughMode` for config's import path | W1 |
| `src/ui/App.tsx` | replace the 318-331 notice with decide/arm/fire; `endReasonRef`; `cancelFollowThrough` on Esc, submit and unmount; `submitMessage`'s `userInitiated` arg; `showStrip`; pass `strip` | W1+W2 |
| `src/ui/layout/AppShell.tsx` | `+ strip?` slot, inline branch only | W2 |
| `src/agent/headless.ts` | continuation loop (unsubscribes stay outside it); `used` increment; per-iteration `sawTurnEnd` reset; `getTodoSnapshot?` | W1 |
| `src/config/schema.ts` | `+ followThrough` on `TodoConfig`, `DEFAULT_TODO_CONFIG`, `clampTodoConfig` | W1 |
| `src/config/load.ts` | `+ CliFlags.todoFollow` and one spread in `resolveTodoConfig` | W1 |
| `src/config/env.ts` | `+ ARAGON_TODO_FOLLOW`, accumulated into one section (§4.2) | W1 |
| `src/cli.tsx` | `.option()` + the `CliFlags` literal line (C-9, both sites) | W1 |
| `src/commands/builtins.ts` | `/todo follow`; `/todo status` clause; `/todo continue` uses `buildContinuationMessage` and `{ userInitiated: false }` | W1 |
| `src/commands/registry.ts` | `CommandContext.submit` gains the optional options arg (C-12 / P1-5) | W1 |
| `src/ui/overlays/HelpOverlay.tsx` | the hand-maintained `/todo` row (IF-6) | W1 |
| `packages/{cli,core}/package.json` + root | `typecheck` scripts | W3 |
| `packages/cli/README.md`, `CHANGELOG.md` | the new surfaces | all |

### 7.3 Test fixtures repaired (10 files, 12 errors, W3)

Seven in `packages/cli` — `__tests__/app.test.tsx`,
`__tests__/mouse-routing.test.tsx`, `__tests__/question-overlay.test.tsx`,
`__tests__/skills-commands.test.ts`, `__tests__/skills-controller.test.ts` (two
errors, one file), `skills/__tests__/fetch-source.test.ts`,
`skills/__tests__/integrity.test.ts` (two errors, one file) — and three in
`packages/core`: `__tests__/provider-output-limit.test.ts`,
`__tests__/smoke.test.ts`, `skills/__tests__/skill-find.test.ts`. Per the
re-measured table in §3.8, which is the authoritative list; the count and the
`skills/__tests__` half were both wrong in v1 (P1-3).

### 7.4 Deliberately NOT changed

`packages/core/**` (source), `src/todo/store.ts` (C-3), `src/todo/normalize.ts`,
`src/todo/prompt.ts` (D-3), `src/todo/panel-rows.ts`, `src/ui/TodoPanel.tsx`,
`src/ui/layout/rail.ts`, `src/session/persist.ts` (§5.3),
`src/ui/layout/budget.ts` (the strip is inline-only precisely so this stays
true).

---

## 8. Testing and acceptance criteria

### 8.1 Constants

```ts
export const TODO_FOLLOW_LIMITS = {
  /**
   * Auto-continuations for ONE LIST LINEAGE, however productive, and NOT reset by
   * a re-plan (P0-1 / D-16). > maxItems on purpose.
   */
  maxAutoContinuesPerList: 25,
  /** Consecutive auto-continuations that completed nothing before handing back. */
  maxNoProgressContinues: 2,
  /** Interactive grace window before an armed continuation fires. */
  graceMs: 3000,
} as const;
```

`25 > TODO_LIMITS.maxItems (20)` is the point: a fully productive 20-step plan
must never be cut off by the total cap, so the cap only ever binds on pathology.
`2` gives a model that forgot to tick an item exactly one free nudge. `graceMs` is
**3 s** everywhere, including the notice text — v1 said 2.5 s in two prose
passages and 3000 in the constant (P2-1).

One constant joins `TODO_LIMITS`, because it is a display bound rather than an
economy bound and that table is where display bounds live:

```ts
  /** Below this many columns the inline strip drops its `+N done` suffix. */
  stripDoneCols: 80,
```

### 8.2 New test files (4)

| File | Covers |
|---|---|
| `src/__tests__/todo-follow-through.test.ts` | the decision table and the budget machine, exhaustively; **AC-35**'s alternating-size loop |
| `src/__tests__/todo-continuation-message.test.ts` | enumeration, numbering, omission of completed items, ASCII, bound |
| `src/__tests__/todo-strip.test.tsx` | W2 render, truncation, anchor choice, gate, **AC-41** |
| `src/__tests__/headless-follow.test.ts` | the `-p` loop, per-iteration reset, absent-`getTodoSnapshot` no-op, **AC-37**'s cap |
| `src/__tests__/typecheck-scope.test.ts` | **AC-38** — every `src/**/__tests__` directory in the package is inside `tsconfig.test.json`'s `include`, so a future nested test tree cannot fall outside the gate the way `skills/__tests__` fell outside v1's measurement |

Updated: `app.test.tsx` (arming, Esc cancel, abort suppression, **AC-36**'s live
mode read, **AC-40**'s same-tick `error → agent_end`), `builtins-todo.test.ts`
(the new verb + `userInitiated`), `config-schema.test.ts`, `load.test.ts`,
`env.test.ts` (**AC-39**), `appshell.test.tsx`.

### 8.3 Acceptance criteria

**Defaults and compatibility**

1. With `followThrough: 'notify'` and a clean end, the dispatched notice is
   **string-identical** to today's, asserted against the literal.
2. `--no-todo` keeps the tool array object-identical and the system prompt
   byte-identical (round 1's AC-30/31, re-run).
3. `<todo_planning>` is byte-identical to `bf6aeb1a`; `TODO_BLOCK_VERSION` is
   **not** bumped (D-3).
4. A config file written before this round loads with `followThrough: 'notify'`.
5. `ARAGON_TODO_FOLLOW=garbage` yields `'notify'`, no throw.
6. `/todo panel off` still round-trips `enabled` and `followThrough` through both
   `store.ts` merges (round 1's P0-1 re-asserted with a third key).

**The decision**

7. Aborted run + unfinished list ⇒ **no notice at all**, in all three modes.
8. Errored run ⇒ `warn` notice, never `continue`, including in `auto`.
9. `off` ⇒ no notice and no continuation, ever.
10. `auto` + progress ⇒ `continue`.
11. `auto` + 2 consecutive no-progress continuations ⇒ `notify`, and the third
    continuation does not fire.
12. A user-initiated run that completes nothing does **not** charge the streak.
13. `snapshot.total` changing zeroes `noProgressStreak` **and preserves `used`**
    (P0-1 — v1 asserted the opposite, which is what made the cap unreachable).
14. 25 continuations ⇒ capped, with the cap named in the text.
15. `snapshot === null` ⇒ zeroed budget, `used` included — the only path that
    clears it.

**Firing and cancelling**

16. An armed continuation submits `buildContinuationMessage(snapshot)`, not the
    round-1 fixed string.
17. Neither the auto path nor `/todo continue` calls `recordPrompt`.
18. `Esc` during the grace window cancels; no prompt is issued; the budget is
    unchanged.
19. A user submit during the grace window cancels, and the user's message is the
    one that runs.
20. `controller.isRunning()` at fire time ⇒ no submit (C-6).
21. Unmount during the grace window leaves no pending timer (fake timers assert
    zero).
22. The list reaching `doneCount === total` during the grace window ⇒ no submit.

**Headless**

23. `getTodoSnapshot` absent ⇒ exactly one `prompt()` call; stdout, stderr and
    exit code byte-identical to today.
24. `auto` + unfinished ⇒ a second `prompt()` with the enumerated message.
25. A swallowed throw on iteration 2 sets exit code 1 (the per-iteration
    `sawTurnEnd` reset).
26. `--quiet` suppresses every `[todo]` line including the new ones.
27. An unfinished plan alone never changes the exit code.

**W2**

28. `strip` is absent from the fullscreen branch's tree entirely.
29. Inline + list ⇒ **exactly one row**, asserted as
    `stripAnsi(lastFrame()).split('\n')` length against the same tree rendered
    without the strip, for a 40-column terminal and an 80-character item. (v1
    specified a `measureElement` height; nothing in this package asserts layout
    that way — the sole mention is a comment — whereas line counting is the
    established idiom, `overlay-frame.test.tsx:47`, `session-opener.test.tsx:53`.
    P2-6.)
30. The strip's anchor equals `todoAnchorIndex(items)` for every fixture in
    `todo-panel-rows.test.ts` (shared fixtures, so the two surfaces cannot
    disagree).
31. `--no-todo-panel` ⇒ no strip.
32. Fullscreen with a rail ⇒ no strip (no double render).

**W3**

33. `npm run typecheck` exits 0 in both packages.
34. No `@ts-expect-error`, no `as any`, and no production type widened, in the
    **ten** repaired fixture files (P1-3 — v1 said six).

**Added in review (v2)**

35. **P0-1.** Given `auto` and a model that returns a list of a *different size*
    on every continuation while never increasing `doneCount`, the total cap still
    binds: continuation 26 does not fire. Written as a loop over `advanceBudget`
    with alternating totals, so it fails if `used` is ever cleared by a re-anchor.
36. **P1-1.** `/todo follow auto` issued mid-session changes the very next
    `agent_end` decision, with no relaunch — the regression test for reading the
    mode through `controller.getTodoConfig()` rather than a captured `cfg`.
37. **P1-2.** A headless `auto` run against a model that never finishes the plan
    stops at `maxAutoContinuesPerList` prompts (not more, not unbounded), and the
    final stderr line names the cap.
38. **P1-3.** `tsc -p tsconfig.test.json` in each package includes
    `src/skills/__tests__/**` — asserted by a nested-directory glob check, so the
    next person to add `src/<x>/__tests__/` cannot silently fall outside the gate.
39. **P1-4.** `ARAGON_TODO=0 ARAGON_TODO_FOLLOW=auto` resolves to
    `{ enabled: false, followThrough: 'auto' }`; each var alone resolves the other
    key from defaults.
40. **P1-6.** A `message_update{ streamEvent: { type: 'error' } }` followed by
    `agent_end` **in the same tick, with no render between them** yields
    `errored: true` and produces the warn notice, never a continuation — the
    batching-independence guard. Asserted with both events pushed synchronously
    through one `controller.subscribe` fixture.
41. **P2-4.** The strip shows `+N done` at `TODO_LIMITS.stripDoneCols` columns and
    omits it one column below.

### 8.4 Manual verification

Recorded in `docs/plans/todo-plan-followthrough/manual-test.md`, on Windows
Terminal, `cmd.exe` and one POSIX terminal:

1. A 5-step plan under `auto`, watched to completion without touching the
   keyboard; the budget never binds.
2. The same plan with `Esc` pressed during the first grace window.
3. `Ctrl+C` / abort mid-run: **no** unfinished notice.
4. A model forced to stall (`/todo follow auto`, then a prompt that makes it
   answer without ticking): exactly one nudge, then the hand-back notice.
5. Inline mode (`--no-fullscreen`): the strip appears, truncates cleanly at 40
   columns and never wraps.
6. `aragon -p --todo-follow auto "<3-step task>"`: the `[todo] continuing` lines
   appear and the exit code is 0.
7. **The P0-1 scenario, by hand.** A prompt that induces repeated re-scoping
   ("plan this, and revise the plan as you learn") under `auto`: the session must
   end in a hand-back notice, not in an open-ended sequence of runs. Count the
   continuations; 25 is the ceiling and no re-plan may lift it.
8. **The P1-1 scenario, by hand.** Launch with the default `notify`, run
   `/todo follow auto` mid-session, then end a run with steps outstanding: the
   continuation must arm on that very run, with no relaunch.

---

## 9. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Auto-continue burns money on a stuck model | Two structural caps (§8.1), `Esc`, off by default, and `beginUserTurn`'s stale window bounding it a third time (§3.5) |
| R-2 | The model re-plans every turn, resetting the budget forever | **This was live in v1 (P0-1) and is now closed:** a re-anchor forgives `noProgressStreak` but `used` is monotonic, so `maxAutoContinuesPerList` binds regardless of how the plan is reshaped. Only the list disappearing entirely resets it, and §3.2 enumerates the four ways that happens — none of them reachable by a model on its own. AC-35 |
| R-3 | The grace timer fires into a session that moved on | Three cancellation triggers plus two re-checks at fire time (`isRunning`, live snapshot) |
| R-4 | `Esc` in the idle branch collides with a future binding | It is currently a no-op branch; the change is additive and the toast makes it observable |
| R-5 | The strip pushes the composer around in inline mode | `wrap="truncate"` in a fixed-height row, asserted at exactly one rendered line (AC-29) |
| R-6 | Headless loops forever in CI | The same caps — **which requires the `used` increment §3.6 step 0 adds**, absent in v1 (P1-2) — plus `errored` stopping the loop, plus AC-27 pinning exit-code semantics and AC-37 pinning the cap |
| R-7 | **Ink moves to a concurrent root** (major bump, or the `experimental` renderer) and React's automatic batching returns | The end reason is carried by a ref mutated in the dispatching callback, not by `stateRef` (C-11 / §3.4), so the answer does not depend on when React commits. AC-40 asserts the same-tick `error → agent_end` sequence directly. v1 named a future `ViewState` change instead, which is both less likely and less damaging than the batching change it did depend on |
| R-8 | W3's fixture repairs mask a real production bug | §3.8 forbids suppressions and requires reporting rather than fixing if a production change looks necessary |
| R-9 | Two surfaces (rail, strip) drift on which item is "current" | Both call `todoAnchorIndex`; AC-30 shares fixtures |

---

## 10. Decision log

- **D-1** Follow-through is a three-valued mode, not a boolean. `off` exists
  because a user who finds the notice noisy today has no way to silence it, and
  making them choose between "nag me" and "spend my money" is not a choice.
- **D-2** Default `notify` ⇒ this round changes nothing for anyone who does not
  ask for it, and AC-1 makes that assertable rather than asserted.
- **D-3** **No prompt change.** The model is not told about follow-through, so
  `TODO_BLOCK_VERSION` does not move and round 1's byte-identity claims survive.
  Telling the model "you may be auto-continued" invites it to plan for the
  mechanism instead of the task.
- **D-4** The end reason is derived from three fields `runEnd` already reads,
  not added to core's event. C-2.
- **D-5** Aborted ⇒ silence, not a quieter notice. The user's `Esc` is the
  statement; anything after it is the CLI arguing.
- **D-6** Errored ⇒ never auto, in any mode. The one hard exception in the table.
- **D-7** The budget lives in the App/headless, not the controller: it counts
  *interactions*, and the controller owns the *model's* state.
- **D-8** Progress is `doneCount` increasing, not "the model wrote something".
  A model that rewrites an unchanged list is exactly the loop being bounded.
- **D-9** Continuations age the list like any turn (C-5). Exempting them would
  make a loop immortal.
- **D-10** No live countdown; one static notice. Repaint cost, §3.4.
- **D-11** The continuation enumerates the remaining steps, so a scrolled-out
  `todo_write` cannot make "continue" mean nothing.
- **D-12** `/todo continue` stops polluting prompt history — the same fix, taken
  because the two paths now share a code path and shipping one behaviour twice
  is how they diverge.
- **D-13** The strip is inline-only and structurally absent from the fullscreen
  branch, mirroring C-8 rather than trusting a prop.
- **D-14** `maxAutoContinuesPerList` (25) exceeds `TODO_LIMITS.maxItems` (20) so
  the total cap binds only on pathology, never on success.
- **D-15** W3 fixes fixtures, never production types. A green typecheck bought
  by widening a real type is worse than no typecheck.

Added in review (v2):

- **D-16** **`used` is monotonic within a list lineage; a re-plan forgives only
  the streak.** v1 zeroed the whole budget on any `total` change, which left both
  caps resettable every turn by ordinary re-planning and made §9's R-2 claim
  false (P0-1). Forgiving `noProgressStreak` keeps round 1's correct instinct —
  replanning is engagement — while the ceiling stays a ceiling. The cost is that a
  legitimately long, repeatedly re-scoped plan can reach 25 and hand back with a
  notice; that is the right failure, and `/todo continue` is one keystroke.
- **D-17** **The end reason is carried by a ref this feature owns, not by
  `stateRef`.** The reducer stays the definition and becomes the cross-check. This
  costs three one-line mutations and buys independence from React's commit timing,
  which v1 depended on without knowing it (P1-6 / C-11). The alternative — reading
  React state inside a controller callback — is correct only for as long as Ink
  mounts a legacy root, and its failure is silent and billable.
- **D-18** **`ARAGON_TODO_FOLLOW` exists, `ARAGON_TODO_PANEL` still does not**, and
  the distinction is the rule `env.ts:158-163` already states: an env var is
  justified only where a flag *and* a config file are both unreachable. A
  container or CI job whose entrypoint is fixed can reach neither, and
  follow-through is precisely the knob an unattended `-p` run needs — whereas
  `panel` is a per-machine display preference for an interactive terminal, where
  `config.json` is always reachable. Without this paragraph the new var looks like
  the very thing the file declined to add (P2-11).
- **D-19** **`stripDoneCols` is a named constant in `TODO_LIMITS`**, not a literal
  in the component. v1's bare `80` was the only unnamed layout bound the feature
  would have introduced, and it sits between two real constants (100 and 40) with
  nothing to tell a reader it was neither of them (P2-4).

---

## 11. Invariants

- **I-1** The list remains a projection of what the model believes. Nothing in
  this round writes to `TodoStore` (C-3); follow-through only *reads* snapshots
  and *submits messages*, which is the model's own front door.
- **I-2** No decision path can submit while `isRunning()`.
- **I-3** At most one armed continuation exists at a time; arming while armed is
  impossible because the only arm site runs at `agent_end` and every path out of
  the timer nulls the ref.
- **I-4** `mode === 'notify'` produces output byte-identical to `bf6aeb1a` on
  every path except an aborted run, where it produces strictly less (D-5).
- **I-5** Every auto-continuation increments `used`; no path fires without
  charging it. **Both** fire points do so — the TUI timer (§3.4) and the headless
  loop (§3.6 step 0) — and `used` is never cleared while the list lives (I-8).
- **I-8** `used` decreases only by way of the whole budget being zeroed, and the
  budget is zeroed only when `snapshot === null`. No model-driven path reaches
  that (§3.2), which is what makes `maxAutoContinuesPerList` a real ceiling
  rather than a hint.
- **I-6** The rail and the strip never both render.
- **I-7** `packages/core/**` source is untouched.

---

## 12. Non-goals and deferred work

1. **Mid-run nudging.** Injecting "you forgot to tick step 3" during a run
   fights the model's own turn structure and risks derailing a correct
   trajectory. The end-of-run guard covers the observable failure.
2. **User editing of the plan** — round 1's non-goal 2, unchanged, and now with
   a second argument: an edited list would make `advanceBudget`'s `anchorTotal`
   identity meaningless.
3. **Per-subagent plans** — round 1's non-goal 5, unchanged.
4. **Cross-restart persistence (round 1's OQ-2), and the reason it is harder
   than it looks.** A `todos.json` beside `state.json` is easy; restoring it is
   not. Round 1's I-2 says the list is a projection of what the model believes,
   and `/resume` is consistent with that only because it restores the
   *conversation* in the same breath. Restoring a plan into a fresh process,
   whose model believes nothing, puts a panel on screen that the model cannot
   act on and did not write — I-2 inverted, which round 1 ranks below having no
   panel at all. The shape that would work is a `/todo recover` that composes the
   remaining steps into a **message**, so the plan re-enters through the model's
   front door and comes back as a real `todo_write`; that is a coherent round-3
   feature and `buildContinuationMessage` is already most of it. It is out of
   scope here because it needs a scoping rule (per directory? per session? how
   stale is too stale?) that no requirement in front of us constrains.
5. **A follow-through keybinding.** `/todo continue` and `Esc` are the surfaces;
   round 1's §4.5 argument against new keys stands.

---

## 13. Definition of done

1. All **41** acceptance criteria pass (34 from v1, seven added in review);
   `npm test` green in both packages; `npm run build` clean; **`npm run typecheck`
   clean in both packages** (new).
2. `git diff --stat packages/core/src` is empty.
3. `aragon --no-todo` produces an object-identical tool array and a
   byte-identical system prompt; `TODO_BLOCK_VERSION` is unchanged.
4. A default-config session (`followThrough: 'notify'`) is behaviourally
   indistinguishable from `bf6aeb1a` except that an aborted run no longer prints
   the unfinished notice (D-5, AC-7).
5. §8.4's manual matrix is executed and recorded in
   `docs/plans/todo-plan-followthrough/manual-test.md`.
6. `packages/cli/README.md` and `CHANGELOG.md` document `--todo-follow`,
   `ARAGON_TODO_FOLLOW`, `todo.followThrough` and `/todo follow`.
7. Every constant in `TODO_FOLLOW_LIMITS` — **and `TODO_LIMITS.stripDoneCols`** —
   is referenced by at least one test that would fail if it changed.

---

## 14. 评审结论 (Review verdict)

### 有条件通过 — approved with conditions

The design is feasible on this stack, correctly sized, and consistent with the
conventions the tree documents in source. Its central judgement — that round 1 was
right to refuse an unbounded auto-continue loop, and that the way to permit one is
to make the worst case arithmetic — is sound, and the choice to derive the end
reason instead of extending `AgentEndEvent` is the right call for the right
reasons. Every load-bearing line reference in v1 checked out; the module
boundaries (C-1 through C-12) are real constraints rather than decoration, and W1
/ W2 / W3 genuinely land as independent subsets.

What the review found was not a wrong design but a **wrong bound**. v1 shipped its
economy with both counters resettable by ordinary re-planning (P0-1), which left
the feature's one non-negotiable property — "the worst case is arithmetic" —
unenforced while every sentence in the document asserted it. That, together with
the missing headless increment (P1-2), meant the loop was bounded in prose and
unbounded in both modes. Those are fixed in v2 and pinned by AC-35 and AC-37.

The other five P1s share a shape worth naming: each is a place where v1 reasoned
from what the code *should* do rather than from what it *does*. The mode read from
a stale closure (P1-1), the `submit` signature that cannot carry the new argument
(P1-5), the env cast that hides a dropped key (P1-4), the test tree that was
measured in one of its two directories (P1-3), and the React commit timing that
happens to work because Ink 5 mounts a legacy root (P1-6). All five are resolved
in the body, four of them with a new acceptance criterion each.

**Conditions on implementation.** All are already written into the document; they
are repeated here because they are the ones whose omission would be silent:

1. **`used` must never be cleared by a re-anchor** (§3.2, D-16, I-8, AC-35). This
   is the whole ceiling. A refactor that "simplifies" `advanceBudget` back to
   returning a zeroed budget on a `total` change re-opens P0-1, and the symptom is
   a bill rather than a test failure.
2. **Both fire points charge `used`** — the TUI timer *and* the headless loop
   (§3.4, §3.6 step 0, I-5, AC-37). CI is where an uncharged counter costs most.
3. **The mode is read through `controller.getTodoConfig()`, never a captured
   `cfg`** (§3.4, AC-36). Note the asymmetry with §3.7's `showStrip`, which is
   correct to use `cfg` because it runs in render scope.
4. **The end reason travels in `endReasonRef`, mutated in the dispatching
   callback** (C-11, §3.4, AC-40) — not in `stateRef`, and not threaded through
   the `runEnd` action either.
5. **Re-measure W3 before starting** with the two commands in §3.8, and treat the
   table as of that moment rather than of authoring time. The count moved once
   already; `main` may have moved it again.
6. **No suppressions in the fixture repairs** (D-15, AC-34), and
   `skills-controller.test.ts:50` in particular is the fixture's type being too
   loose, not `CliConfig` being incomplete.

**Not blocking, offered as judgement.** `maxAutoContinuesPerList: 25` in headless
is up to 25 full agent runs from one `-p` invocation. It is opt-in, it is capped,
and the exit-code contract is preserved, so it is defensible as specified — but if
the first field report is a surprised CI bill, the answer is a lower ceiling for
`interactive: false` rather than a new setting. Worth deciding before, not after.

**Scope confirmation.** W2 and W3 remain cuttable independently of W1 and of each
other, and the §7 grouping still supports a partial landing. The three non-goals
that matter most — no prompt change (D-3), no core change (I-7), no mid-run
nudging (§12.1) — are intact in v2, and D-3 in particular means round 1's
byte-identity claims survive unexamined rather than re-litigated.

No P0 or P1 findings remain open.

---

## 15. 实施过程发现的方案缺陷 (Issues found during implementation)

Recorded per the implementation node's constraint: where the design turned out
to be wrong or incomplete, the corrected approach is described here rather than
applied silently. Five findings; **none** changes a decision, an invariant or an
acceptance criterion, and the W3 re-measurement CONFIRMED §3.8's table exactly.

### IF-1 — §4.3's `/todo status` clause is unimplementable from §4.4's plumbing

§4.3 specifies `Follow-through: auto (2/25 used).` §4.4 says "No new controller
members" and §5.1/§5.2 put the budget in an `App` ref — deliberately, because it
counts a session's interaction with the user rather than the model's plan. But
`CommandContext` (`commands/registry.ts`) carries `controller`, `state` and
`dispatch`, and the budget is in none of them: a slash command has **no path to
`used` at all**. The two sections are individually right and jointly
unsatisfiable.

**Taken:** `CommandContext` gains one optional read-only field,
`followBudget?: FollowThroughBudget`, supplied by `makeCtx` from
`budgetRef.current`. `registry.ts` was already in the change plan (C-12 / P1-5),
the budget stays in the App, no controller member is added, and the clause reads
as specified. Optional so the many test contexts built as object literals need
no change. The alternative — printing the ceiling without the count — would have
silently downgraded a specified surface, which is what this section exists to
prevent.

### IF-2 — `TodoStrip` needs an explicit `width`, or it can wrap

§3.7 specifies `wrap="truncate"` inside a `flexGrow={1} flexShrink={1}` box and
argues, correctly, that this stops the row wrapping. What it does not say is
what bounds the row. In fullscreen `AppShell`'s root box carries
`width={cols}`; the **inline** branch has no width constraint anywhere (that is
the whole meaning of "no fixed frame"), so the flexible cell is sized by whatever
the parent offers and a long `activeForm` overflows the terminal — at which
point the terminal itself wraps it and the composer moves, which is the one
failure §3.7 exists to prevent.

Caught by AC-29's own assertion: at 40 columns with an 80-character item the row
rendered 88 columns wide.

**Taken:** the strip's root box carries `width={cols}` and `overflow="hidden"`,
exactly as `TodoPanel` does one level up (and for a related reason — that file's
`flexShrink={0}` note records the same class of "the arithmetic silently becomes
a suggestion"). `cols` is already a prop; nothing else changed.

### IF-3 — the `-p` follow-through mode has no route from config to `runHeadless`

§3.6 says the headless loop calls "the same function ... with
`interactive: false`", and §3.6 rule 2 adds `getTodoSnapshot?` to
`HeadlessController`. It never says where `mode` comes from. `HeadlessController`
is deliberately the minimal surface a test can satisfy with an object literal, so
adding `getTodoConfig?` there would widen it for a value that is not a
controller concern.

**Taken:** `HeadlessOptions` gains `followThrough?: FollowThroughMode`
(defaulting to `'notify'`, so an omitted option behaves exactly as the resolved
default config does), and `runOneShot` — which holds the real `AgentController`
— passes `controller.getTodoConfig().followThrough`. Same shape as the existing
`quiet` option.

### IF-4 — a third `FakeController` was needed, and the two existing ones needed a third member

Round 1's P1-5 recorded that this package has **two** hand-written
`FakeController`s rendering `<App>`, both handed over as
`fc as unknown as AgentController`, so a missing member is not a compile error.
This round adds a live `controller.getTodoConfig()` read at every `agent_end`
(§3.4 / P1-1), which is a third such member: both existing stubs needed it, and
the failure was `controller.getTodoConfig is not a function` in six unrelated
cases.

§8.2 also lists `builtins-todo.test.ts` among the files to update. **No such
file exists** — the `/todo` command has never had direct coverage; what exists
is `todo-config.test.ts` / `todo-session.test.ts`, neither of which drives a
slash command.

**Taken:** `getTodoConfig` added to both existing stubs; the App-level
follow-through cases live in a new `app-follow-through.test.tsx` with its own
stub rather than in `app.test.tsx` (those cases wait out a real 3-second grace
window, and folding them into a 5-second suite would quadruple its wall time for
every unrelated change); and the command coverage §8.2 assumed exists was
written as `todo-commands.test.ts`.

### IF-5 — W3's re-measurement confirms §3.8 exactly (no change needed)

Recorded because condition 5 of §14 requires the measurement to be re-run rather
than trusted, and because a confirmation is as much a result as a correction.
Run at `bf6aeb1a` with the two configs as specified:

```
cd packages/cli  && npx tsc -p tsconfig.test.json    # 9 errors, 7 files
cd packages/core && npx tsc -p tsconfig.test.json    # 3 errors, 3 files
```

Twelve errors across ten files, file for file and line for line as §3.8's table
lists them, `skills-controller.test.ts:50`'s diagnosis included (it is
`mouse: boolean | undefined` not assignable to `boolean` — the fixture's own
type being too loose, not `CliConfig` being incomplete). Every fix is a fixture
change; no `@ts-expect-error`, no `as any`, no production type widened (AC-34).

Three **new** errors appeared from this round's own work, which is the gate
doing exactly the job §0 describes. Two came from `TodoConfig` gaining a third
required key and broke two existing todo fixtures. The third is worth naming:
`todo-strip.test.tsx`, written for W2 in this same round, reproduced
`question-overlay.test.tsx`'s defect verbatim — a `caps` parameter whose type was
inferred from a `colorLevel: 3 as const` default, so the ASCII case it exists to
cover would not compile. **Vitest ran it green.** Under `tsconfig.json` alone all
three would have shipped, which is the argument for W3 restated as an
observation rather than a prediction.

---

## 16. Implementation status

- **Landed:** W1, W2 and W3 in full. All 41 acceptance criteria are covered by
  automated tests except the eight manual cases in §8.4, which are recorded in
  `manual-test.md` and **not yet executed** (they need a live provider key and a
  real TTY).
- **Verification at the time of writing:** 1246 CLI tests + 278 core tests green
  (`npm test`); `npm run build` clean; **`npm run typecheck` clean in both
  packages** — the new gate, and the first time this repo has had one.
  `git diff packages/core/src` touches three files, all under `__tests__` (I-7:
  no core *source* change; DoD-2 as written says `--stat` is empty, which is true
  of source and not of the fixtures §7.3 explicitly repairs).
- **Not done, and deliberately:** no `git commit` (the next node owns that), and
  no work outside §7's change plan.
