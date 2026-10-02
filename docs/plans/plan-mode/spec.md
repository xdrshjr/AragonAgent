# Plan Mode — design specification

> Feature slug: `plan-mode`
> Target: `@aragon-agent/cli` (primary) + three additive changes in `@aragon-agent/core`
> Version: **v3** — second review pass, held against the shipped implementation
> (v1 = initial draft, v2 = first design review, both preserved below)
> Status: approved with conditions — see [§12](#12-评审结论-review-verdict) (round 1)
> and [§14](#14-第-2-轮评审结论-review-verdict--round-2) (round 2)
> Author: solution-architect node
> Reviewer: design-review node (round 1 — design only; round 2 — design vs. code)

---

## 0. 评审记录 (Review Notes)

Two rounds. Round 1 reviewed a design that did not exist yet; round 2 reviews the
same design now that `74026ff9` has shipped it, which is a different question and
finds different things.

### 第 2 轮 (round 2 — v2 → v3, design vs. shipped code)

Held against the implementation rather than against the design's account of
itself: `packages/cli/src/{tools/plan-tools.ts, tools/human-input.ts,
tools/index.ts, agent/controller.ts, ui/App.tsx, ui/overlays/*}` and
`packages/core/src/{tools/executor.ts, engine/agent-loop.ts, engine/watchdog.ts}`
as committed.

**All four P0 fixes are real code, and the mechanism round 1 was most worried
about works.** `createBuiltinTools` ends in two independent guards with no shared
exit (`tools/index.ts`), so `--no-skills --plan` still refuses — asserted twice,
once on the function and once end-to-end through a controller
(`plan-gate.test.ts:79`, `skills-controller.test.ts:205`). Registration keys off
the static `neverPrompts`. The schemas carry `type` / `required` / `default` and
nothing else, with `QUESTION_LIMITS` / `PLAN_LIMITS` as the single authority. And
the timeout path is now genuinely closed in both directions, which is worth
spelling out because round 1 could only assert it: `ToolExecutor` builds a
**per-call** `AbortController` and merges the external signal into it
(`executor.ts:140-158`), so `toolTimeoutOverrides` aborts *this tool* and not the
run; the bridge's abort listener settles the wait; and because the tool then
*returns* rather than throwing, the executor's catch never fires and the model
receives the ordinary non-error `cancelled: true` shape §4.1 promises. The four
conditions §12 attached to the v2 verdict are all discharged (see §14).

**No P0.** The read-only guarantee holds on every path reachable today, including
the two the design flagged as adjacent: CodeAct is still inert (no `sandbox` is
passed to `new Agent`) and skills contribute no tools of their own.

The findings below are where the *document* now misleads, and where a correct
implementation is resting on an assumption nobody wrote down.

#### P0 — none

#### P1 — fixed in the v3 body

**R2-P1-1 · The normative body still specifies seven things the shipped code
deliberately does not do.** §13 records each of them honestly, and that section is
valuable history — but §13 is not what anyone reads before changing this feature.
§§3–8 are, and they are wrong in seven places: §7.2's `createPlanTools({ gate,
getMode, rounds, withHumanWait })` (shipped: `{ gate, takeAskRound, withHumanWait,
onPlanApproved }`), §7.3's `initialAgentMode` prop (never built, and §5.2 says why
it must not be), §7.3's `planMark` glyph (folded into `tool.ask_user` /
`tool.submit_plan`; the shipped `glyphs.ts` has no `planMark`), §5.1's
cap-then-drop repair ordering (shipped: drop-then-cap), §4.1's one-argument
`formatAnswersResult` example (shipped: `(shape, asked)`), §4.1's round cap listed
above the repair rules (shipped: normalize first, spend the round only when there
is something to render), and §3.8 / §4.2 disagreeing about who performs the
approval mode-flip. A document that claims to be implementable line by line and
then contradicts the lines that were implemented is worse than one that says
nothing: every correction above is a change a maintainer would make *back*.
**Fixed in §3.8 / §4.1 / §4.2 / §5.1 / §7.2 / §7.3**, each carrying a pointer to
the §13 entry that explains it.

**R2-P1-2 · §6.6 instructs the next maintainer to add the one `Esc` handler R-P12
forbids.** It specifies, for the revise-feedback field, "`Enter` sends, `Esc`
returns to the plan". The shipped overlay cannot do that and must not: `App` owns
`Esc` for both plan-mode overlays (`App.tsx:729` → `cancelPendingHuman()`), and
`PlanReviewOverlay`'s own handler opens with `if (key.escape) return; // App owns
dismiss.` Implementing §6.6 literally means registering a second `Esc` consumer
that also resolves the request — precisely the `ConfirmDialog` double-resolve
pattern R-P12 exists to keep out. The implementation resolved the mismatch by
relabelling the hint to `esc dismiss`, which is honest but leaves a real gap:
**from the feedback field there is now no way back to the card at all**, because
the field consumes printable input and `Backspace` and nothing else. **Fixed in
§6.6**: the text now describes the shipped ownership, and the way back is
specified as `←` — the same affordance `QuestionOverlay` already uses for "back",
which needs no `Esc` handler and therefore keeps R-P12 intact.

**R2-P1-3 · The human-input bridge is written for N outstanding requests and is
correct only for exactly one.** §3.5 holds pending entries in a `Set`, and the
shipped App matches it (`pendingHuman: Set<PendingHumanRequest>`, the overlay
clears when the set empties). But `humanRequest` is a **single** state slot, so a
second request would silently overwrite the first's rendering, and `resolveHuman`
broadcasts one response to **every** entry (`App.tsx:578-580`) — so a `questions`
answer would be delivered to a pending `plan` request, which `submit_plan` reads
as a dismissal. None of this is reachable today, and the reason is in a different
package: `agent-loop.ts:210` executes tool calls in a `for…of` with an `await`
inside, and only one run is in flight at a time. That is a real invariant doing
real work, and it is written down nowhere. If the engine ever executes tool calls
concurrently — a normal thing for an agent loop to grow — this feature breaks
silently and the breakage looks like a model error. **Fixed in §3.5 / §9.1**: the
invariant is stated where the `Set` is defined, with the concrete change required
if it ever stops holding, and pinned as I-P11.

**R2-P1-4 · `submit_plan` has no budget, and "dismiss" is not an exit.**
`ask_user` is capped (`planModeMaxAskRounds`, R-P5) precisely so a model cannot
trap the user in a questionnaire. `submit_plan` has no equivalent, and §4.2's
dismissal result explicitly instructs the model to *"refine the plan, then call
submit_plan again"* — so pressing `Esc` on a plan card is an invitation to
resubmit, not a way out. A user who keeps pressing `Esc` keeps getting cards. The
exit does exist — `Esc` closes the card, and a second `Esc` with no overlay open
aborts the run (`App.tsx:734`) — but it is named in no hint, no README paragraph
and no acceptance criterion, and the card's own footer says `esc dismiss`, which
reads like the exit and is not. **Fixed in §4.2 / §6.6 / §9.2 / §10**: the
asymmetry is stated with its rationale, the real exit is documented in the
feature's own docs, and a per-turn submit budget is specified as the bounded
follow-up rather than left as folklore.

#### P2 — recorded, resolved in place, no blocking work

| ID | Concern | Decision |
| --- | --- | --- |
| R2-P2-1 | `normalizeQuestions` slices to 5 **before** validating (`human-input.ts:228`), while `normalizePlan` and `nonEmptyStrings` drop-then-cap per IF-4. A model sending 6 questions with one malformed at index 2 renders 4, not 5 — IF-4's own argument ("noise must not consume slots meant for content") applied unevenly. | Recorded in §5.1 with the reason it is bounded (the cap is 5, each question is independently repairable, and the failure costs one question rather than one plan). Listed as the first candidate if the normalizers are touched again. |
| R2-P2-2 | `IdleWatchdog.pause()` is a boolean, not a counter, and `withHumanWait` is therefore not re-entrant: a nested wait's `finally` would re-arm the watchdog while the outer wait is still blocked. | Unreachable today — tool calls are sequential, and the confirm-wrapped tools and the plan tools are disjoint sets that never nest. Stated as an invariant in §3.6 so the next person to add a second human wait knows the pause must become a counter first. |
| R2-P2-3 | `BuiltinToolsOptions.toolPolicy`'s doc comment still ends "see the early return below". P0-1 removed that early return; the sentence now points at a conditional block. | Noted in §3.3 as a comment-only correction to make on the next touch of `tools/index.ts`; the code is right, only the sentence is stale. |
| R2-P2-4 | "The `BUILD` tool list is byte-identical to today's" is easy to over-read. The controller supplies `agentMode` **unconditionally**, so in every real session all tools are `withPlanModeGate` wrappers; the identity assertions hold because the tests call `createBuiltinTools` directly. | §3.3 / §9.1 now say which claim is which: behaviour is identical in `BUILD`, object identity is only claimed for calls that supply neither option (I-P2 / AC-G17). |
| R2-P2-5 | `/plan status` and the unknown-argument warning both shipped and neither has an acceptance criterion, though `/plan status` is the only read surface for `askRoundsUsed`. | AC-P26 added in §9.2. |

### 第 1 轮 (round 1 — v1 → v2, design only)

Reviewed section by section against the real source tree (`packages/core`,
`packages/cli`) rather than against the description of it: `ink@5.2.1`,
`ajv@8.20.0` declared as an **`optionalDependency`** of core, CLI defaults
`DEFAULT_TOOL_TIMEOUT_MS = 180_000` / `DEFAULT_IDLE_TIMEOUT_MS = 210_000`.

**What v1 got right, and it is most of it.** Every load-bearing claim about the
existing seams checks out: `Shift+Tab` really does arrive as
`{tab: true, shift: true}` with `input === ''` (`parse-keypress.js` lists `'[Z'`
in both the `tab` name map and `isShiftKey`, and `use-input.js:68` blanks the
input for `nonAlphanumericKeys`); `PromptInput.tsx:342` really would fire
`completeSelection()` on `Shift+Tab` with a popup open; `SettingsScreen.tsx:103`
really is `key.downArrow || key.tab`; `ConfirmDialog.tsx:49` really does claim
`Esc` that `App.tsx:533` also claims; `theme.chip` really is defined in all three
palettes and unused; the glyph scanner really does cover `agent/` (so the
`OTHER_OPTION_LABEL` trap in §6.7 is real); `ToolExecutor` really does already
implement `timeoutOverrides` with no way to reach it through `Agent`; `--confirm`
really does have the latent watchdog bug §1 describes; and `public-api.test.ts`
really does assert only export *names*, so the two new `Agent` methods are free.
The wrapper-ordering, static-registration and single-write-path arguments are all
correct and are kept verbatim.

The findings below are where the design and the code disagree, or where the
design under-specifies something whose default outcome is silent.

#### P0 — must fix before implementation

**P0-1 · The read-only gate is skipped entirely on the `--no-skills` path.**
`createBuiltinTools()` ends with `if (!options.toolPolicy) return tools;`
(`tools/index.ts:218`) and §3.3 requires the plan gate to be **outermost**, i.e.
applied *after* the policy map — which is after that return. So
`aragon --no-skills --plan` (or `ARAGON_SKILLS=0`, or any user who turned skills
off) would run with `write_file` / `edit_file` / `bash` fully live while the badge
read `PLAN`. This is the feature's one security-shaped promise failing silently on
a first-class supported flag. **Fixed in §3.3**: the final function body is now
spelled out with two *independent* guards and no shared early exit, and the
AC-G17 identity proof is shown to still hold.

**P0-2 · The 30-minute human-wait ceiling does not exist, and the run can hang
forever.** `ToolExecutor`'s timeout is **cooperative**: it calls
`controller.abort(TIMEOUT_REASON)` and then keeps `await`ing `tool.execute(...)`
(`executor.ts:139-187`). There is no `Promise.race`. A tool that never observes
`context.signal` is never timed out — `bash-tool.ts:112` is the house pattern,
and it subscribes explicitly. `ask_user` as drafted awaits only the bridge
promise, so `toolTimeoutOverrides` changes nothing at all; and because
§3.6 also *pauses the idle watchdog*, both ceilings are gone at once and the
process wedges until `Ctrl+C ×2`. §4.1's timeout row described a mechanism that
does not exist in either direction: `HumanInputGate.request()` took no
`AbortSignal`, so nothing could have closed the overlay. **Fixed in §3.5**:
`request(req, signal?)` now takes `ctx.signal`, the bridge has one `settle()`
resolution point wired to it, and §4.1's row is rewritten.

**P0-3 · `createPlanTools()` as specified registers zero plan tools in the TUI.**
§5.3 gated registration on "`gate.canPrompt()` can never be true", which reads as
`if (!gate.canPrompt()) return []`. But `makeController()` constructs the
controller — and therefore the tool array — while `confirmBridge.handler` is still
`null` (`cli.tsx:149`; the App mounts later and attaches it in an effect). So
`canPrompt()` is **false for every interactive session at construction time**, and
PLAN mode would ship with no `ask_user` and no `submit_plan`, in every session,
with no error. `canPrompt()` is documented in this codebase as a *live* probe that
must never be cached (`cli.tsx:155-160`, `App.tsx:256-261`), and registration is
by definition a one-time decision — the two cannot be the same predicate. **Fixed
in §3.5 / §5.3**: a static `neverPrompts` discriminator on the gate.

**P0-4 · The model-facing schemas pre-empt every repair rule, and do so
differently depending on whether an optional dependency is installed.** `ajv` is
configured with `allErrors` / `coerceTypes` / `useDefaults`
(`validator.ts:114-119`), so `maxItems: 5`, `minItems: 2` and `maxLength: 12` are
hard-enforced and `ToolExecutor` returns `Invalid parameters: …` *before*
`normalizeQuestions()` is ever called. Repair rules 1 and 4 and the `header`
truncation in §5.1 are therefore dead code, and the stated rationale for having
them ("a hard rejection wastes a turn for a cosmetic defect") is defeated by the
schema in the same document. Worse, `ajv` is an **`optionalDependency`**
(`packages/core/package.json:104-107`): without it `FallbackStrategy` checks only
`required` plus primitive types, so the repair path *is* live. Same design, two
behaviors, decided by whether an optional install step succeeded. **Fixed in
§4.1 / §4.2 / §5.1**: the schemas declare *shape* only, the bounds move into the
`description` (where they belong — that is what the model reads), and the
normalizer is the single authority. Deterministic either way.

#### P1 — must fix before implementation

**P1-1 · A mid-run mode flip cannot update the system prompt, which undercuts the
feature's headline flow.** `runLoopWithLifecycle` passes `systemPrompt:
this.systemPrompt` **by value** into `runAgentLoop` (`agent.ts:364`) and the loop
reads `ctx.systemPrompt` on every LLM call (`agent-loop.ts:157`). `setSystemPrompt()`
mid-run has no effect on the run in flight. So after the user approves a plan, the
model still carries `<plan_mode>`'s *"you must not change anything on disk and
must not run commands"* for the rest of the turn, contradicted only by one line of
tool result — precisely the situation in which a well-aligned model refuses to
proceed. AC-P10 (approve → the same run writes files) is the feature's headline
and it was resting on an assumption the engine does not honor. **Fixed in new
§3.9 + §8**: the block's scope is now written as conditional and it names the
`submit_plan` result as the authority that supersedes it, so no core change is
needed; pinned by new invariant I-P9 and AC-P20.

**P1-2 · `/plan` has no route to the single write path, which is R-P7's own
mitigation.** `CommandContext` (`commands/registry.ts:10-32`) exposes `controller`
and `dispatch` but nothing that performs the paired write, so §4.3's `/plan` would
have to re-derive `setAgentMode()` + `dispatch()` inline — a *second* mode write
path, which is exactly what R-P7 forecloses and what §3.1 says the API shape
exists to prevent. §7.3 also did not list `commands/registry.ts` as touched.
**Fixed in §4.3 / §7.3**: `applyAgentMode` joins `CommandContext`, and
`/plan status` gets a named read surface instead of reaching into internals.

**P1-3 · `OverlayFrame` mode A cannot render the plan's prose.** Mode A's contract
is *one element per row, each already `wrap="truncate"`*
(`OverlayFrame.tsx:36-40`, `sliceWindow` slices by element). `summary` is up to
600 characters and each step `detail` up to 400 — paragraphs, not rows — and the
repo has no wrap helper (`grep` for `wrapText` / `wordWrap` finds nothing). As
drafted, every paragraph would render as a single truncated line, which is the
one failure mode a plan review card cannot afford. **Fixed in §6.6 / §7.2**: a
pure `wrapToRows()` module with its own unit test.

**P1-4 · An overlay can outlive its run.** Nothing closed a `question` / `plan`
overlay when the run ended. The reachable path is abort (`Esc` twice, `Ctrl+C`,
watchdog): the run dies, the card stays on screen, and pressing `a` then flips the
session to `build` with no visible cause — a mode-drift bug of exactly the R-P7
class the design opens by ruling out. **Fixed in §3.5 / §6.6 / §7.3**: `ctx.signal`
already covers abort once P0-2 lands, and the App additionally calls
`cancelPending()` on `runEnd` so "no overlay outlives its run" is structural
rather than a consequence of signal plumbing. Pinned by AC-P21.

**P1-5 · I-P1 is over-claimed for a live session.** `buildSystemPrompt` renders
`Available tools:` from `params.tools` (`system-prompt.ts:45-47`), so an
interactive **build**-mode session's prompt gains two tool lines the moment plan
tools are registered. §3.4 knowingly accepts that token cost, but I-P1 as written
("byte-identical to the pre-feature output") does not scope it, so the invariant
test could be written to assert something false and then be "fixed" by weakening
the wrong thing. **Fixed in §9.1**: I-P1 is scoped to a fixed `tools` array, and
new I-P8 pins the paths where the *live* prompt really is byte-identical
(headless, and interactive with no human-input gate — which is what keeps the
existing `AC-10` and `toHaveLength(7)` / `(11)` assertions green).

**P1-6 · Mode visibility is not guaranteed where the badge lives.** The chip sits
on the hint row, which disappears under `showHint = rows >= HINT_MIN_ROWS` **and**
under `hints: false` (`App.tsx:730-732`) — and the inline render path does not
mount `Composer` at all, it mounts bare `PromptInput` (`App.tsx:740-752`). So on a
short terminal, with hints off, or in inline mode, v1 leaves a read-only session
with no mode indicator. For a mode whose entire value is that the user trusts it,
that is not a cosmetic gap. **Fixed in §6.1 / §6.4**: the status-bar word is
designated the *guaranteed* carrier (it renders in both `AppShell` branches and
has no opt-out), the chip is the enhancement, and AC-P22 pins all three
suppression cases.

**P1-7 · Two files claim `PLAN_MODE_BLOCKED_TOOLS`.** §3.3 defines it in
`tools/index.ts` and argues — correctly, and it is the load-bearing argument —
that it must sit adjacent to `SKILL_TOOL_FLOOR` with a test asserting the two
partition `HOST_TOOL_NAMES` (I-P6). §5.1 and §7.2 both list it as an export of
`agent/agent-mode.ts`. A document that claims to be implementable line by line
cannot leave an implementer to pick. **Fixed in §5.1 / §7.2**: it lives in
`tools/index.ts`; `agent-mode.ts` keeps the mode vocabulary and the refusal-message
builders only.

#### P2 — recorded, resolved in place, no blocking work

| ID | Concern | Decision |
| --- | --- | --- |
| P2-1 | `planMark` is declared in §6.7 with no consumer, and `glyphs.tool` gains no `ask_user` / `submit_plan` icon, so both tool cards fall back to `toolDefault`. | Both entries added in §6.7. A declared-but-unused glyph is the kind of thing the next reader deletes. |
| P2-2 | §5.1 gives six repair rules for `normalizeQuestions()` and none for `normalizePlan()`, though it faces the same untrusted input. | Four rules added in §5.1. |
| P2-3 | The ask-round cap resets in `prompt()`, but `steer()` is the *other* place a user message enters the engine (`controller.ts:308`) and was unaddressed. | §4.4 now states that steering does not reset the cap, with the reason. |
| P2-4 | CodeAct (` ```execute-js `) would bypass the gate entirely, since it runs through `ctx.sandbox` and not through any tool. | §3.3 notes the CLI wires no `sandbox` (`controller.ts:138-153`), so the path is inert today, and that adding one would require gating it. Cheap to record, expensive to rediscover. |
| P2-5 | Adding `submit_plan` to `SKILL_TOOL_FLOOR` contradicts the existing test's prose ("read-only work plus the two skill lookups, and nothing else"); `submit_plan` mutates the session mode. | §7.3 now specifies the replacement wording rather than leaving the test author to invent it. |
| P2-6 | §3.6 writes `config.humanTimeoutMs` while §4.4 names the key `planModeHumanTimeoutMs`. | Unified on the §4.4 name in §3.6. |
| P2-7 | §7.3 lists `README.md` / `CHANGELOG.md`; the *Manual smoke checklist* and the CLI changelog are `packages/cli/README.md:544` and `packages/cli/CHANGELOG.md`. | Paths corrected in §7.3 and §9.3. |

Checked and **not** raised, to save the next reviewer the trip: the `--plan` /
`--no-plan` tri-state matches the existing `--fullscreen` / `--no-fullscreen`
precedent including the declare-positive-first comment (`cli.tsx:468-472`);
`STORED_PREVIEW_CHARS` is 8000, so the §6.8 preview parse is not at truncation
risk; `input/keymap.ts` is a line-editing recognizer only, not a global keybinding
registry, so handling `Shift+Tab` in `App`'s `useInput` is the consistent choice;
`AgentTool.parameters` is `JSONSchema7`, so §4.1/§4.2's literal schemas are the
right shape; and no identifier in either package currently collides with
`ask_user`, `submit_plan`, `agentMode` or `AgentMode`.

---

## 1. Overview

`aragon` today has exactly one operating posture: the user types a request and the
agent immediately starts doing it — reading files, writing files, running shell
commands. That is the right default for "rename this symbol", and the wrong
default for "add multi-tenant support". For anything above trivial size the user
wants to see, and steer, the *approach* before a single byte is written; and the
agent frequently needs two or three decisions from the user (which datastore,
which migration strategy, breaking change or not) that no amount of reading the
repository can answer.

**Plan Mode** adds that second posture. `Shift+Tab` toggles between **`BUILD`**
(today's behavior, byte-for-byte unchanged) and **`PLAN`**. In `PLAN`:

1. The agent may only *read* — `write_file`, `edit_file`, `bash`, `skill_install`
   and `skill_create` are refused at the tool boundary, so read-only is a
   property of the wiring rather than a promise in a prompt.
2. When the request is under-specified, the agent calls a new **`ask_user`**
   tool that renders a keyboard-driven multiple-choice wizard: 1–5 questions per
   round, 2–4 options per question, **exactly one marked *Recommended***, plus a
   synthetic `Other…` free-text option. Multiple rounds are allowed, up to a
   configurable cap.
3. When it has enough information it calls **`submit_plan`** exactly once. The
   plan renders as a reviewable card; the user approves it (which flips the
   session to `BUILD` and lets the same run continue straight into
   implementation), asks for a revision with written feedback, or dismisses it.

The design goal beyond the mechanics is that the feature should feel like it was
always there. That means it reuses this codebase's existing seams rather than
inventing parallel ones: the read-only gate is the same `{...tool, execute}`
wrapper shape as `withConfirmation` / `withToolPolicy`; the blocking human
prompt is the same bridge-plus-promise pattern as `ConfirmBridge`; the overlays
are `OverlayFrame` clients; every glyph goes through `glyphs.ts`; the system
prompt is spliced conditionally so that `BUILD` output stays byte-identical to
today's, exactly as `skillsBlock` already does (invariant I-S1).

Two smaller things fall out of the work and are in scope because they are
prerequisites, not extras. First, a tool that waits on a human currently races
two timers it cannot see: `ToolExecutor`'s per-tool ceiling (default 180 s) and
the `IdleWatchdog` (default `toolTimeout + 30 s`). That is a live latent bug in
today's `--confirm` mode — a user who takes four minutes to answer `Proceed?
(y/N)` has their run killed. Plan Mode makes it unavoidable, so core grows a
watchdog pause/resume pair and a per-tool timeout override map, and the existing
confirm path is routed through the same helper. Second, `SKILL_TOOL_FLOOR` gains
the two new tool names, because a skill that declares `allowed-tools` must not be
able to dead-end plan mode by making `ask_user` unreachable.

### Non-goals

- No persistence of the plan to disk (`/plan save`, `PLAN.md`) — a later round.
- No third mode (Claude Code's "auto-accept edits"); `nextMode()` is written as a
  cycle so a third is a one-line change, but two ship.
- No change to `Entry`, `session/persist.ts`, `density.ts` or
  `transcript-text.ts`. Questions and plans surface through the **existing tool
  card** with dedicated `ToolPreview` renderers (§4.6). This is deliberate: a new
  `Entry` kind would force edits in five modules and a session-file version bump
  for a purely cosmetic gain.
- No cloud/telemetry surface. Nothing leaves the machine.

---

## 2. Terminology and public labels

| Concept | Identifier | UI label | Notes |
| --- | --- | --- | --- |
| Execute-immediately posture | `'build'` | `BUILD` | The default. Today's behavior. |
| Research-and-design posture | `'plan'` | `PLAN` | Read-only + question/plan tools. |
| The toggle | `Shift+Tab` | `shift+tab plan` / `shift+tab build` | The hint names the **destination**, not the current state — the correct label for a toggle affordance. |

All user-visible strings are English (repo convention, `system-prompt.ts` header).

---

## 3. Technical design

### 3.1 Mode ownership and the two-source-of-truth rule

The **`AgentController` owns the mode**. It is the object the tools close over,
so it is the only place that can answer "may this tool run?" at execute time.
`ViewState.agentMode` is a *mirror* held for rendering only.

The single write path is:

```ts
// App.tsx
const applyMode = (next: AgentMode) => {
  const applied = controller.setAgentMode(next);   // returns what was ADOPTED
  dispatch({ type: 'setAgentMode', mode: applied.effective, pending: applied.pending });
};
```

`setAgentMode` returns the adopted state rather than `void` because the
controller may **defer** the change (§3.2). Dispatching the requested value
instead of the adopted value is the one way to make the badge lie, so the API
shape forecloses it.

### 3.2 Deferred loosening, immediate tightening (D-P3)

Toggling while a run is in flight is allowed, but the two directions are not
symmetric:

- **`build → plan` applies immediately.** Tightening a permission mid-run is
  always safe; the user pressed the key *because* the agent is about to do
  something they want to stop.
- **`plan → build` is deferred to `agent_end`.** Applying it live would mean a
  run the user launched under a read-only guarantee could start writing files
  because of one stray keypress. The controller stores `pendingMode = 'build'`,
  keeps `effectiveMode = 'plan'`, and the App toasts
  `Build mode applies after this run.` The status bar renders `plan → build`.
- **Exception:** approving a plan through `submit_plan` switches to `build`
  **immediately, mid-run**, because the user has just read the plan and
  explicitly authorized exactly that work. This is an informed act; a stray
  `Shift+Tab` is not. The distinction is the whole justification for the
  asymmetry and must be preserved if this code is ever refactored.

`Esc` on an idle session is unaffected. Toggling while an overlay is open is a
no-op (§3.7).

### 3.3 The read-only gate

`createBuiltinTools()` gains one option:

```ts
/**
 * Read the mode AT CALL TIME. Never cache: the mode can flip mid-run when the
 * user approves a plan, and a cached 'plan' would refuse the very work the user
 * just authorized.
 *
 * Omitting this leaves every tool unwrapped by THIS gate — see the second,
 * independent guard at the end of `createBuiltinTools`, which is what keeps the
 * 7-tool / 11-tool baselines byte-identical (I-S1 / AC-G17).
 */
agentMode?: () => AgentMode;
/** `ask_user` / `submit_plan`, appended verbatim. Empty in headless mode. */
planTools?: AgentTool[];
```

and one wrapper, structurally identical to `withToolPolicy`:

```ts
const PLAN_MODE_BLOCKED_TOOLS = new Set([
  'write_file', 'edit_file', 'bash', 'skill_install', 'skill_create',
]);

function withPlanModeGate(tool: AgentTool, getMode: () => AgentMode): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx) {
      const mode = getMode();
      if (mode === 'plan' && PLAN_MODE_BLOCKED_TOOLS.has(tool.name)) {
        return errorResult(PLAN_REFUSAL(tool.name));
      }
      if (mode !== 'plan' && tool.name === 'submit_plan') {
        return errorResult(
          'submit_plan is only available in Plan mode. You are in Build mode — ' +
          'just do the work and summarize when done.',
        );
      }
      return original(id, params, ctx);
    },
  };
}
```

`PLAN_MODE_BLOCKED_TOOLS` is deliberately the exact complement of
`SKILL_TOOL_FLOOR` minus the skill-loading pair — i.e. "the five that change
something", the set `tools/index.ts` already names in prose. Keeping the two
definitions adjacent in one file, with a test asserting they partition
`HOST_TOOL_NAMES`, is what stops them drifting.

**`bash` is refused wholesale**, including read-only invocations like `git
status`. There is no reliable way to classify a shell string, and a gate that is
right 95 % of the time is worse than one that is always right, because the user
stops trusting the badge. The refusal message names `read_file` / `glob` /
`grep` as the alternatives so the model has somewhere to go.

**Wrapper ordering** (extends D-G11): plan gate → tool policy → confirmation →
tool. The plan gate is outermost because it needs no I/O and no state; asking a
human "run bash?", waiting, and only then saying "actually, plan mode" is the
worst available ordering.

Outermost means *applied last*, and that collides with the function's existing
shape, so the whole body is spelled out here rather than described (**P0-1**):

```ts
export function createBuiltinTools(options: BuiltinToolsOptions): AgentTool[] {
  const deps: ToolDeps = { getCwd: options.getCwd };
  let tools: AgentTool[] = [ /* the seven built-ins, unchanged */ ];

  if (options.confirmTools && options.confirm) { /* unchanged */ }
  if (options.skillTools && options.skillTools.length > 0) {
    tools = [...tools, ...options.skillTools];
  }
  if (options.planTools && options.planTools.length > 0) {
    tools = [...tools, ...options.planTools];
  }

  // The ceiling. Semantics unchanged; only the SHAPE changed, from an early
  // `return` to a conditional block, so that a second wrapper can follow it.
  if (options.toolPolicy) {
    const getDecision = options.toolPolicy;
    tools = tools.map((t) => withToolPolicy(t, getDecision, options.onToolPolicyEvent));
  }

  // TWO OPTIONS, TWO INDEPENDENT GUARDS, NO SHARED EXIT.
  //
  // The v1 draft reused the single `if (!options.toolPolicy) return tools;`
  // early return that used to end this function. That return sits BEFORE this
  // line, and `--no-skills` / `ARAGON_SKILLS=0` supply no decision provider —
  // so `aragon --no-skills --plan` returned before the plan gate was applied
  // and ran with write_file / edit_file / bash fully live while the badge said
  // PLAN. If you ever collapse these two guards back into one, that is the bug
  // you are reintroducing, and nothing reports it.
  if (!options.agentMode) return tools;
  const getMode = options.agentMode;
  return tools.map((t) => withPlanModeGate(t, getMode));
}
```

AC-G17 still holds by construction: its call is
`createBuiltinTools({ getCwd, skillTools: [sentinel] })`, which supplies neither
`toolPolicy` nor `agentMode`, so both guards are skipped and the sentinel comes
back by identity. The proof is now "two guards both declined" instead of "one
early return fired", which is the same fact with the hole closed.

**Two footnotes on that identity claim, because it is easy to over-read
(R2-P2-3, R2-P2-4).** First: the controller supplies `agentMode`
**unconditionally** — it is `() => this.effectiveMode`, not a mode-dependent
option — so in every real session, `BUILD` included, every tool is a
`withPlanModeGate` wrapper. What `BUILD` gets is identical *behaviour* (the
wrapper's only `build`-mode branch is the `submit_plan` refusal); object identity
is claimed only for calls that supply neither option, which is what the tests
exercise. Saying "byte-identical tool list" without that qualifier invites someone
to assert it on a live controller and then weaken the wrong thing when it fails.
Second: `BuiltinToolsOptions.toolPolicy`'s doc comment still ends *"see the early
return below"*, and P0-1 replaced that early return with a conditional block.
Correct the sentence on the next touch of the file; the code itself is right.

**CodeAct is not a hole today, and that is worth writing down** (P2-4). The
`` ```execute-js `` path in `agent-loop.ts:281` runs through `ctx.sandbox`, not
through any `AgentTool`, so no tool wrapper can see it. The CLI passes no
`sandbox` to `new Agent(...)` (`controller.ts:138-153`), which makes the path
inert. Anyone wiring a sandbox later must gate it here as well, or plan mode
gains a shell by the back door.

`ask_user` is available in **both** modes (a clarifying question is never
harmful, and refusing a tool the model can see just burns a turn). `submit_plan`
is refused outside plan mode. That asymmetry is intentional and is spelled out in
both the gate and the prompt.

### 3.4 Tool registration is static; only the prompt is rebuilt

The plan tools are registered **whenever a human-input gate is wired** (i.e. the
interactive TUI), regardless of the current mode. They are *not* added and
removed on each toggle.

Rationale: `Agent.setTools()` calls `syncToolRegistry()`, which unregisters and
re-registers entries in the live `ToolRegistry`. `runAgentLoop` iterates
`toolCalls` synchronously against that registry, and `submit_plan`'s approval
path mutates the mode from *inside* a tool execution. Rebuilding the tool array
at that moment would mutate the registry mid-iteration. Keeping the array
immutable for the session removes the hazard entirely; the mode-dependent
behavior lives in the gate, which is a pure function of `getMode()`.

Cost: in `BUILD` the model sees two extra tool definitions (~200 tokens).
Accepted.

What *is* rebuilt on every toggle is the system prompt, through the existing
single entry point:

```ts
setAgentMode(next: AgentMode): { effective: AgentMode; pending: AgentMode | null } {
  // ...deferral logic (§3.2)...
  this.rebuildSystemPrompt();   // I-S2: still the ONLY caller of setSystemPrompt
  return { effective: this.effectiveMode, pending: this.pendingMode };
}
```

### 3.5 The human-input bridge

`ask_user` and `submit_plan` must block until a human answers. The codebase
already solves this once, for `--confirm`: a `ConfirmBridge` object whose
`handler` field the App sets on mount and nulls on unmount, with the tool
awaiting a promise the overlay resolves. Plan Mode uses the same shape, with two
corrections learned from the confirm path.

```ts
// src/tools/human-input.ts
export type HumanRequest =
  | { kind: 'questions'; questions: NormalizedQuestion[] }
  | { kind: 'plan'; plan: NormalizedPlan };

export type HumanResponse =
  | { kind: 'answers'; answers: Answer[]; cancelled: boolean }
  | { kind: 'planDecision'; decision: 'approved' | 'revise' | 'dismissed'; feedback: string };

export interface HumanInputGate {
  /**
   * STATIC property of the channel: `true` only for a gate that can never
   * acquire a human at all. Set on `DENY_ALL_HUMAN_INPUT` and nowhere else.
   *
   * This — not `canPrompt()` — is what `createPlanTools()` keys registration off
   * (P0-3, §5.3). `canPrompt()` is a LIVE probe and is legitimately `false` for
   * the whole window between `makeController()` and the App's first effect, so
   * a registration decision taken from it would be "no plan tools", forever, in
   * every interactive session, with no error anywhere. The two predicates answer
   * different questions and must not be merged.
   */
  readonly neverPrompts?: boolean;
  /** True only while a TUI is mounted and able to render an overlay. */
  canPrompt(): boolean;
  /**
   * Resolves with `null` when cancelled / unmounted / aborted. NEVER rejects.
   *
   * `signal` is the tool's `ctx.signal` and is REQUIRED in practice — see
   * Correction 3. Passing `undefined` gives a wait with no ceiling of any kind.
   */
  request(req: HumanRequest, signal?: AbortSignal): Promise<HumanResponse | null>;
}

export interface HumanInputBridge {
  handler: ((req: HumanRequest, signal?: AbortSignal) => Promise<HumanResponse | null>) | null;
  /** Resolve every outstanding request with `null`. Called on App unmount. */
  cancelPending(): void;
}

/** Fails CLOSED. The headless default — forgetting to pass a gate must not hang. */
export const DENY_ALL_HUMAN_INPUT: HumanInputGate = {
  neverPrompts: true,
  canPrompt: () => false,
  request: async () => null,
};
```

**Correction 1 — `cancelPending()`.** `ConfirmBridge` nulls its handler on
unmount but leaves any in-flight promise dangling forever. With a 3-second `y/N`
that never mattered. With a question wizard the user might abandon by pressing
`Ctrl+C` twice, the tool would hang until its 30-minute ceiling. The App's
cleanup calls `cancelPending()` **before** nulling `handler`.

**Correction 2 — `canPrompt()` is probed before the work, not discovered
after.** Same reasoning as D17 for skill installs: a `null` handler must mean
"refuse with an actionable message", never "assume yes" and never "wait
forever".

**Correction 3 — the wait must be raced against `ctx.signal`, or there is no
ceiling at all (P0-2).** `ToolExecutor`'s timeout is **cooperative**: it fires
`controller.abort(TIMEOUT_REASON)` and then keeps `await`ing `tool.execute(...)`
(`executor.ts:139-187` — no `Promise.race` anywhere). A tool that ignores
`context.signal` is never timed out; `bash-tool.ts:112` is the house pattern and
subscribes explicitly. Since §3.6 additionally *pauses the idle watchdog*, a
plan tool that awaits only the bridge promise has **both** ceilings removed and
wedges the process until `Ctrl+C ×2` — with the terminal showing an overlay
nobody is going to answer. `toolTimeoutOverrides` on its own is inert.

So the bridge has exactly one resolution point, and abort is one of its callers:

```ts
// Inside the App's humanInputBridge effect.
type Entry = { resolve: (v: HumanResponse | null) => void; done: boolean };
const pending = new Set<Entry>();

/** THE single settle path. Idempotent per entry; also clears the overlay. */
const settle = (e: Entry, value: HumanResponse | null) => {
  if (e.done) return;
  e.done = true;
  pending.delete(e);
  e.resolve(value);
  if (pending.size === 0) dispatch({ type: 'setOverlay', overlay: null });
};

bridge.handler = (req, signal) =>
  new Promise<HumanResponse | null>((resolve) => {
    const entry: Entry = { resolve, done: false };
    pending.add(entry);
    // Covers BOTH the 30-minute per-tool override and Esc-abort / watchdog,
    // because ToolExecutor routes both through this one signal.
    signal?.addEventListener('abort', () => settle(entry, null), { once: true });
    setHumanRequest(req);
    dispatch({ type: 'setOverlay', overlay: req.kind === 'plan' ? 'plan' : 'question' });
  });

bridge.cancelPending = () => {
  for (const e of [...pending]) settle(e, null);
};
```

Four callers of `settle`, and no fifth: the overlay's own submit, `App`'s `Esc`,
the `signal` abort listener, and `cancelPending()`.

**AT MOST ONE REQUEST MAY BE OUTSTANDING, and the reason lives in another
package (R2-P1-3).** The `Set` above is the natural shape for "everything still
pending" and it is what makes `cancelPending()` and the empty-set overlay clear
easy to write — but the rest of the design is single-request: there is one
`humanRequest` render slot, so a second request would silently replace the first
on screen, and the App's submit path resolves **every** pending entry with the
one response it has, so a `questions` answer handed to a pending `plan` request
would come back to `submit_plan` as a dismissal. Nothing guards against that,
and nothing needs to today, because `agent-loop.ts` executes tool calls in a
`for…of` with an `await` inside and only one run is in flight at a time. That is
a real invariant carrying real weight across a package boundary, so it is stated
here rather than left to be re-derived:

> **I-P11.** One human request outstanding at a time. Guaranteed by sequential
> tool execution in `@aragon-agent/core`'s agent loop. If that loop ever runs
> tool calls concurrently, this bridge must key its render slot and its
> resolution on the entry (a `Map<requestId, Entry>` plus a request-id round
> trip) *before* the concurrency lands — otherwise the failure is silent,
> cross-talks between two tools, and presents as a model error.

The tool side is then ordinary:

```ts
if (!gate.canPrompt()) return errorResult(NO_INTERACTIVE_USER);
const answer = await controller.withHumanWait(() => gate.request(req, ctx.signal));
```

**Correction 4 — no overlay outlives its run (P1-4).** Correction 3 already
closes the abort path, since `ToolExecutor` propagates the loop's external signal
to the same controller the tool observes. The App *additionally* calls
`bridge.cancelPending()` from its `runEnd` handling. That is deliberate
redundancy: it makes "the card cannot survive the run that opened it" a property
of the App's lifecycle rather than a consequence of signal plumbing three modules
away. Without it, an aborted run leaves a plan card on screen whose `a` key
silently flips the session to `build` — mode drift with no visible cause, which
is the failure R-P7 exists to prevent.

### 3.6 Timeouts and the idle watchdog (core changes)

Three additive changes in `@aragon-agent/core`. None adds a module-level export,
so `public-api.test.ts` is untouched; `API.md` and the core `CHANGELOG.md` are
updated per the three-sync discipline.

**(a) `IdleWatchdog.pause()` / `resume()`**

```ts
private paused = false;

kick(): void {
  if (!this.running || this.paused) return;   // <- the added guard
  /* ...unchanged... */
}

/** Suspend the idle timer (e.g. while a tool waits on a human). Idempotent. */
pause(): void { this.paused = true; this.clearTimer(); }

/** Resume and restart the idle window from now. Idempotent. */
resume(): void { this.paused = false; this.kick(); }

stop(): void { this.running = false; this.paused = false; this.clearTimer(); }
```

`stop()` clearing `paused` is load-bearing: a run aborted while paused would
otherwise leave the watchdog permanently deaf for the next run, and nothing would
ever report it.

**(b) `Agent.pauseIdleWatchdog()` / `Agent.resumeIdleWatchdog()`** — thin
delegations. Public because the host, not the engine, is the only party that
knows a human is being waited on.

**(c) `AgentConfig.timeouts.toolTimeoutOverrides?: Record<string, number>`**,
forwarded to the executor:

```ts
this.toolExecutor = new ToolExecutor(this.toolRegistry, {
  defaultTimeout: this.toolTimeout,
  ...(config.timeouts?.toolTimeoutOverrides
    ? { timeoutOverrides: config.timeouts.toolTimeoutOverrides }
    : {}),
});
```

`ToolExecutor` already implements `timeoutOverrides`; this is pure wiring of a
capability that was previously unreachable through `Agent`.

The controller then supplies (key name per §4.4 — P2-6):

```ts
toolTimeoutOverrides: {
  ask_user: config.planModeHumanTimeoutMs,      // default 30 min
  submit_plan: config.planModeHumanTimeoutMs,
},
```

A ceiling remains — an unattended terminal must not wedge a CI job or a stale ssh
session forever — but 30 minutes is far outside "the user went to get coffee".

**This override only bites because of Correction 3 in §3.5.** `ToolExecutor`
expresses a timeout by aborting `context.signal`, never by rejecting the
`execute` promise, so the number above is a no-op for any tool that does not
listen. The two changes are one mechanism and must land together.

Finally the controller exposes the pause pair and **the existing confirm path is
routed through it too**, fixing the latent `--confirm` bug:

```ts
async withHumanWait<T>(fn: () => Promise<T>): Promise<T> {
  this.agent.pauseIdleWatchdog();
  try { return await fn(); } finally { this.agent.resumeIdleWatchdog(); }
}
```

`try/finally` rather than sequential calls: a throw inside the overlay path must
not leave the watchdog disarmed.

**`pause()` is a flag, not a counter, so `withHumanWait` is not re-entrant
(R2-P2-2).** A nested wait's `finally` would call `resume()` while the outer wait
is still blocked, re-arming the watchdog against a human who is still typing —
exactly the bug R-P3 exists to remove, reintroduced from the inside. It cannot
happen today: tool calls are sequential, and the only two wait sites are the
confirm wrapper and the plan tools, which wrap disjoint sets of tools and never
nest. Anyone adding a third human wait must first make `paused` a depth counter
(`pause()` increments, `resume()` decrements and only re-arms at zero) — and
`stop()` must then reset the counter to `0` for the same reason it clears the
flag today.

### 3.7 Keyboard routing for `Shift+Tab`

Ink 5 (`parse-keypress.js`, `'[Z': 'tab'` + `isShiftKey('[Z')`) delivers
`Shift+Tab` as `{ tab: true, shift: true }` with `input === ''` — `'tab'` is in
`nonAlphanumericKeys`, so Ink blanks the input string. Two handlers see it.

**In `App.tsx`**, placed *after* the overlay block (which owns the keyboard when
an overlay is up) and with an explicit guard rather than relying on ordering
alone:

```ts
if (key.tab && key.shift) {
  if (stateRef.current.overlay) return;   // an overlay owns the keyboard
  applyMode(nextMode(controller.getAgentMode()));
  return;
}
```

The explicit guard matters because the overlay block only `return`s for the keys
it recognizes; everything else falls through today.

**In `PromptInput.tsx`**, two edits, both required:

```ts
// (1) FIRST statement of the handler, before the popup branch:
if (key.tab && key.shift) return;   // App owns the mode toggle
```

Without (1), pressing `Shift+Tab` while the `/` command palette or `@` file
popup is open would *both* accept the highlighted completion (`if (key.tab || …)
completeSelection()`) and toggle the mode. The user would watch their draft get
rewritten as a side effect of changing modes — a bug that only appears with a
popup open and is therefore easy to ship.

```ts
// (2) the terminal insert guard already reads `!key.tab`, so no change needed
//     there; `input` is '' for Shift+Tab in any case.
```

`SettingsScreen` treats bare `Tab` as "next field" (`key.downArrow || key.tab`);
that branch must gain `&& !key.shift` so `Shift+Tab` inside Settings does not
move the cursor. It is a one-token change but it is a real key collision.

### 3.8 Sequence: an under-specified request in plan mode

```
user            App/Ink              Controller            Agent/loop         Overlay
 |  Shift+Tab      |                     |                      |                |
 |---------------->| applyMode('plan')   |                      |                |
 |                 |-------------------->| effective=plan       |                |
 |                 |                     | rebuildSystemPrompt()|                |
 |                 |<-- toast "PLAN" ----|                      |                |
 |  "add SSO"      |                     |                      |                |
 |---------------->| submitMessage()---->| prompt() ----------->| agent_start    |
 |                 |                     | resetAskRounds()     | (reads files)  |
 |                 |                     |                      | tool: ask_user |
 |                 |                     |   gate.canPrompt()?  |<---------------|
 |                 |                     |   withHumanWait(     |                |
 |                 |                     |     bridge.request)  |                |
 |                 |<-- setOverlay('question') ------------------|                |
 |                 |------------------------------------------------------------>| render
 |  ↑↓ Enter ×3    |                                                             |
 |------------------------------------------------------------------------------>|
 |                 |<-- resolve(answers) ---------------------------------------- |
 |                 |                     |   watchdog.resume()  |                |
 |                 |                     |   -> ToolResult JSON |                |
 |                 |                     |                      | (loop continues)
 |                 |                     |                      | tool: submit_plan
 |                 |<-- setOverlay('plan') ----------------------|                |
 |  a (approve)    |                                                             |
 |------------------------------------------------------------------------------>|
 |                 |  controller.setAgentMode('build', {force:true})              |
 |                 |                     | effective=build      |                |
 |                 |                     |  -> ToolResult       |                |
 |                 |                     |     "approved"       | writes files   |
 |                 |                     |                      | agent_end      |
```

Note the two `withHumanWait` windows are the only times the watchdog is paused,
and each is bounded by `planModeHumanTimeoutMs` **via `ctx.signal`** (§3.5,
Correction 3).

**Who writes the approval flip, precisely (IF-6 / R2-P1-1).** The diagram shows
the App calling `setAgentMode('build', { force: true })` and §4.2 lists the same
call as `submit_plan`'s side effect. Both happen, in that order, and the order is
not incidental: the App writes through its single `applyMode` path **before**
resolving the bridge promise, because the tool's continuation runs a microtask
later and a badge that reads the mode back in between would render one frame of
`PLAN` for work the user has already authorized. `submit_plan` still calls
`onPlanApproved()` when its wait returns, and that call is idempotent — forcing
`build` on a session already in `build` is a no-op — because it has to work even
if the App unmounted between the keypress and the continuation. One writer
function, two callers, no divergent state.

### 3.9 The system prompt is frozen for the duration of a run (P1-1)

`rebuildSystemPrompt()` is the right single write path, and it is enough for
every *between-run* transition. It is **not** enough mid-run, and the design must
say so rather than assume otherwise:

```ts
// agent.ts:346 — runLoopWithLifecycle()
await runAgentLoop({ /* … */ systemPrompt: this.systemPrompt /* BY VALUE */ });
// agent-loop.ts:157 — every LLM call in the loop
systemPrompt: ctx.systemPrompt,
```

`ctx` is built once per run, so `Agent.setSystemPrompt()` called from inside a
tool has **no effect on the run in flight**. Two consequences, both handled here
rather than by changing the engine:

**`build → plan` (immediate tightening).** The gate applies at once, but the
model's prompt for the rest of that run still lacks the `<plan_mode>` block. It
will therefore keep trying to mutate and collect refusals. That is acceptable —
the refusal is the enforcement, and the prompt is only guidance — but it makes
the refusal text load-bearing, so it names the mode explicitly: *"Plan mode is
active; `write_file` is refused. Use read_file / glob / grep, and finish the
plan."* A refusal that does not explain itself reads as a tool malfunction and
the model retries.

**`submit_plan` approval (immediate loosening) — the headline flow.** Here the
stale prompt actively contradicts the thing the user just authorized: it says
*"you must not change anything on disk"* while the tool result says *"implement
the plan"*. A well-aligned model resolves that standoff by refusing, which would
break AC-P10. The fix is in the block's own wording (§8): its read-only rule is
scoped to *"while plan mode is active"*, and it states that a `submit_plan`
result reporting approval is authoritative and supersedes the rule for the rest
of the run. The prompt then never contradicts the tool result, whichever order
the model reads them in.

**Rejected alternative:** threading `getSystemPrompt: () => string` through
`AgentLoopContext` so the loop re-reads it per call. It is a small change and it
would be *more* correct, but it touches the loop's contract, is not additive, and
buys nothing the wording above does not — the model needs one unambiguous
instruction, not a re-rendered prompt. Revisit only if a third mode arrives.

---

## 4. Interface design

### 4.1 `ask_user` (model-facing tool)

**Bounds live in the `description`, not in the schema, and the reason is
structural (P0-4).** `ToolParamValidator` prefers `ajv` with `allErrors` /
`coerceTypes` / `useDefaults` (`validator.ts:114-119`) and falls back to a
primitive-type-only checker when `ajv` is absent — and `ajv` is an
**`optionalDependency`** of core (`packages/core/package.json:104-107`). A
schema carrying `maxItems: 5` therefore behaves two different ways: with `ajv`,
a six-question call is rejected by `ToolExecutor` as
`Invalid parameters: /questions: must NOT have more than 5 items` and
`normalizeQuestions()` never runs, making repair rules 1 and 4 and the `header`
truncation dead code; without `ajv`, the same call sails through to the repair
path. One design, two behaviors, selected by whether an optional install
succeeded.

Since §5.1 already argues that a cosmetic defect must be *repaired* rather than
cost the user a turn, the resolution is to make that true unconditionally: the
schema declares **shape** (`type`, `required`, `default`), the description
declares the **limits** the model should respect, and `normalizeQuestions()` is
the single authority that enforces them. The model reads the description anyway;
`ajv` never was the audience.

```jsonc
{
  "name": "ask_user",
  "label": "Ask the user",
  "description": "Ask the user 1-5 multiple-choice questions when a decision would change the work. Give each question a stable id, a header of at most 12 characters, and 2-4 options; exactly one option must set recommended:true, with the reason in its description. Extra questions or options beyond these limits are dropped, so keep within them. Do not ask anything you could answer by reading the workspace.",
  "parameters": {
    "type": "object",
    "properties": {
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id":       { "type": "string",
                          "description": "Stable key echoed back in the answer." },
            "header":   { "type": "string",
                          "description": "Very short chip label (<= 12 chars), e.g. \"Datastore\"." },
            "question": { "type": "string", "description": "<= 300 chars." },
            "allowMultiple": { "type": "boolean", "default": false },
            "options": {
              "type": "array",
              "description": "2-4 options. Exactly one must be recommended.",
              "items": {
                "type": "object",
                "properties": {
                  "label":       { "type": "string", "description": "<= 60 chars." },
                  "description": { "type": "string", "description": "<= 120 chars. Why this option." },
                  "recommended": { "type": "boolean", "default": false }
                },
                "required": ["label"]
              }
            }
          },
          "required": ["id", "header", "question", "options"]
        }
      }
    },
    "required": ["questions"]
  }
}
```

`type` and `required` stay because they are shape, not policy: a `questions`
value that is not an array has nothing for the normalizer to repair, and both
validator strategies agree on that check. Everything a well-formed-but-excessive
call could get wrong is now clamped in one pure, unit-tested function whose
behavior does not depend on the install.

**Result** (`textResult`, never `isError` for a user cancellation):

```json
{
  "answers": [
    { "id": "store", "question": "Which datastore?", "selected": ["Postgres"], "custom": null },
    { "id": "api",   "question": "API shape?",       "selected": ["Other"],    "custom": "gRPC" }
  ],
  "cancelled": false,
  "roundsUsed": 1,
  "roundsRemaining": 3
}
```

Preceded by one human-readable line so the transcript preview is readable
without parsing:
`User answered 2 of 2 questions.` / `User dismissed the questions.`

That line is rendered by `formatAnswersResult(shape, asked)` — **two arguments,
and the second is not derivable from the first (IF-5)**. The shape carries only
the answers, and a cancelled wizard returns fewer answers than it asked for;
`answered 1 of 3` *is* the information content of the line, so the asked count is
passed in rather than inferred. The JSON body is unchanged.

**Order of operations inside `execute` (IF-7).** `canPrompt()` first, then
`normalizeQuestions()`, and the round is spent **only once there is something to
render**. Listing the cap above the repair rules, as v2 did, reads as
"consume, then normalize" — under which a malformed call that repairs to zero
usable questions would burn one of the user's four rounds without ever putting a
question on screen, i.e. the user pays for the model's mistake.

**Failure and edge results** (all non-error except the first two):

| Condition | Result |
| --- | --- |
| `canPrompt() === false` (headless) | `errorResult('No interactive user is attached (-p/--print mode). Do not ask questions: state your assumptions explicitly and continue.')` |
| Nothing survives normalization | `errorResult('No usable questions: each needs 2-4 distinct options.')` — checked **before** the round cap, so it costs no budget. |
| Round cap exhausted | `errorResult('You have already asked N rounds of questions (the configured maximum). Proceed with your best assumptions and state them in the plan.')` |
| User pressed `Esc` | **non-error** `{cancelled: true}` + `Proceed with your best assumptions and say what you assumed.` A cancellation rendered as a tool *failure* invites a retry loop. |
| Timeout (`planModeHumanTimeoutMs`, default 30 min) | `ToolExecutor` aborts `ctx.signal`; the bridge's abort listener calls `settle(entry, null)`, which resolves the wait **and closes the overlay** (§3.5, Correction 3). The tool then returns the same non-error `{cancelled: true}` shape as `Esc` — from the model's point of view an unanswered question and an abandoned one are the same situation and want the same guidance. |
| Run aborted (`Esc` ×2 / `Ctrl+C` / watchdog) | Same path: the loop's external signal reaches the tool's `ctx.signal`, the overlay closes, the wait resolves `null`. Nothing is left on screen and nothing is left pending. |

### 4.2 `submit_plan` (model-facing tool)

```jsonc
{
  "name": "submit_plan",
  "label": "Submit plan",
  "description": "Present the implementation plan for approval. Call this exactly once, after you have read enough of the workspace to be specific. Steps must be ordered and independently verifiable. Limits, enforced by truncation rather than rejection: title <= 80 chars, summary <= 600, at most 20 steps (title <= 100, detail <= 400), at most 30 filesTouched, 10 risks, 10 openQuestions.",
  "parameters": {
    "type": "object",
    "properties": {
      "title":   { "type": "string" },
      "summary": { "type": "string" },
      "steps": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "title":  { "type": "string" },
            "detail": { "type": "string" }
          },
          "required": ["title"]
        }
      },
      "filesTouched":   { "type": "array", "items": { "type": "string" } },
      "risks":          { "type": "array", "items": { "type": "string" } },
      "openQuestions":  { "type": "array", "items": { "type": "string" } }
    },
    "required": ["title", "summary", "steps"]
  }
}
```

Same shape-only rule as §4.1, and for the same reason (P0-4). A plan that is one
step over the cap is a plan, and rejecting it costs a full research turn to
regain nothing; `normalizePlan()` (§5.1) clamps instead.

**Result:**

| Decision | Result text | Side effect |
| --- | --- | --- |
| `approved` | `Plan approved. You are now in Build mode — implement the plan step by step, in order.` | `setAgentMode('build', { force: true })` **immediately**. The App writes it first and the tool's own call is the idempotent second (§3.8). |
| `revise` | `Plan rejected. The user's feedback: "<text>". Revise and call submit_plan again.` | stays in `plan` |
| `dismissed` (Esc) | `The user dismissed the plan review without a verdict. Ask a clarifying question or refine the plan, then call submit_plan again.` | stays in `plan` |
| no gate (headless) | non-error: `No interactive reviewer is attached. Emit the full plan as your final answer in markdown instead.` | none |

**Dismissal is not an exit, and that asymmetry has to be stated (R2-P1-4).**
`ask_user` is bounded — `planModeMaxAskRounds`, four by default — precisely so a
model cannot trap the user in a questionnaire (R-P5). `submit_plan` has no such
budget, and the `dismissed` text above deliberately tells the model to try again,
so pressing `Esc` on a plan card asks for a *better* plan rather than for the run
to stop. That is the right default — a user who dismisses a plan usually wants a
different plan — but it means the card's `esc dismiss` footer names the loop, not
the way out. The way out is:

- **`Esc`, then `Esc` again** while no overlay is open: the first closes the card,
  the second aborts the run (`App.tsx`'s idle-`Esc` branch). This is the intended
  exit and it must be documented in the README next to the plan-mode section,
  because nothing on screen implies it.
- **`Ctrl+C` twice** — the universal exit, unchanged.

Bounded follow-up, deliberately not shipped in this round: give `submit_plan` a
per-turn budget of its own (`planModeMaxPlanRounds`, same clamp discipline as the
ask cap, refusal text pointing the model at "state the disagreement and stop").
It is the symmetric fix and it is small, but it changes a model-facing refusal
surface, so it belongs to its own change with its own acceptance criterion rather
than being smuggled in as a review edit.

### 4.3 `/plan` slash command

| Invocation | Behavior |
| --- | --- |
| `/plan` | Toggle, identical to `Shift+Tab`. |
| `/plan on` / `/plan off` | Set explicitly (idempotent). |
| `/plan status` | Notice: `Mode: PLAN (pending BUILD after this run). Ask rounds used: 1/4.` |

Registered in `commands/builtins.ts` alongside `/theme`; it exists because
`Shift+Tab` is intercepted by a small number of terminal multiplexer
configurations and because slash commands are the discoverable surface (`/` opens
the palette).

**It routes through the App's `applyMode`, not through its own pair of calls
(P1-2).** `CommandContext` today carries `controller` and `dispatch`
(`commands/registry.ts:10-32`), so a command *could* write the controller and
dispatch the mirror itself — and that would be a second mode write path, which is
the one thing §3.1 shaped its API to forbid and R-P7 lists as the risk. One line
in the context type instead:

```ts
// commands/registry.ts — CommandContext
/**
 * Apply a mode change through the App's single write path (§3.1 / R-P7).
 * Returns the ADOPTED state, because `plan -> build` may be deferred and the
 * command has to report what actually happened, not what it asked for.
 */
applyAgentMode: (next: AgentMode) => { effective: AgentMode; pending: AgentMode | null };
```

`App.tsx` populates it from the same `applyMode` that `Shift+Tab` calls, so the
two affordances are the same code path and cannot drift. `/plan status` reads
`controller.getPlanStatus()` — a named accessor returning
`{ effective, pending, askRoundsUsed, maxAskRounds }` — rather than reaching into
controller internals from a command module.

### 4.4 CLI flags / env / config

| Channel | Name | Meaning |
| --- | --- | --- |
| Flag | `--plan` | Start the session in `PLAN`. Works in `-p` too (§5.3). |
| Flag | `--no-plan` | Start in `BUILD` (overrides the config default). |
| Env | `ARAGON_PLAN=1` | Same as `--plan`. Parsed with the existing `1/true/on/yes` rule. |
| Config | `planModeDefault` (bool, default `false`) | Start every session in `PLAN`. |
| Config | `planModeMaxAskRounds` (int, default `4`, clamp `[1,10]`) | `ask_user` calls allowed per user turn. |
| Config | `planModeHumanTimeoutMs` (int, default `1_800_000`, clamp `[60_000, 7_200_000]`) | Ceiling on one human wait. |

Resolution order matches every other field: **defaults → config file → env →
flags** (`load.ts::pick`). All three keys are **flat, not nested**. `store.ts`
documents that its nested-object merge is hand-written and capped at one level;
three scalars do not justify a second `clampXConfig` gate plus two more merge
sites, and flat keys mean `store.ts` needs **zero** changes.

`CONFIG_SET_KEYS` in `cli.tsx` gains all three so `aragon config set
planModeDefault true` works, with `coercePositiveInt` + clamp on the two numbers
(same "harden the write path too" reasoning as `skills.integrity`).

**The ask-round cap is per `prompt()`, and steering does not reset it (P2-3).**
`controller.ts` has *two* places a user message enters the engine — `prompt()` and
`steer()` (lines 295 and 308) — and the skill subsystem deliberately treats them
differently: `prompt()` begins a new turn, `steer()` only absorbs pending frames,
because otherwise "ask a follow-up" would be the way around a per-turn scope
(D-G3). The same reasoning applies here: `resetAskRounds()` is called from
`prompt()` only. A user steering *"actually, use Postgres"* into a running plan is
answering the questions, not buying four more rounds of them.

---

## 5. Data model

### 5.1 In-memory shapes

```ts
// src/agent/agent-mode.ts — pure, no React, no I/O, no node builtins.
export type AgentMode = 'build' | 'plan';
export const AGENT_MODES: readonly AgentMode[] = ['build', 'plan'] as const;
export const MODE_LABEL: Record<AgentMode, string> = { build: 'BUILD', plan: 'PLAN' };
/** Written as a cycle so a third mode is a one-line change. */
export function nextMode(current: AgentMode): AgentMode {
  return AGENT_MODES[(AGENT_MODES.indexOf(current) + 1) % AGENT_MODES.length]!;
}
export const PLAN_TOOL_NAMES = ['ask_user', 'submit_plan'] as const;
/** Refusal text builders. ASCII only — `agent/` is inside the glyph scanner. */
export function planRefusal(tool: string): string;
export const OTHER_OPTION_LABEL = 'Other';    // the ellipsis is appended at render time (§6.7)

// PLAN_MODE_BLOCKED_TOOLS is NOT here. It lives in `tools/index.ts` beside
// SKILL_TOOL_FLOOR, because I-P6 asserts the two PARTITION HOST_TOOL_NAMES and a
// partition test is only as trustworthy as the distance between the two
// definitions (§3.3, P1-7). This file owns the mode vocabulary; that file owns
// which tools the modes act on.
```

```ts
// src/tools/human-input.ts — normalized, post-validation shapes.
export interface NormalizedOption {
  label: string;
  description: string;          // '' when absent
  recommended: boolean;         // exactly one true per question, post-repair
  isOther: boolean;             // the synthetic free-text option
}
export interface NormalizedQuestion {
  id: string;
  header: string;               // <= 12 chars, truncated
  question: string;
  options: NormalizedOption[];  // 3..5 = 2..4 given + 1 synthetic Other
  allowMultiple: boolean;
}
export interface Answer {
  id: string;
  question: string;
  selected: string[];           // option labels; length 1 unless allowMultiple
  custom: string | null;        // set only when `Other…` was chosen
}
export interface NormalizedPlan {
  title: string;
  summary: string;
  steps: { title: string; detail: string }[];
  filesTouched: string[];
  risks: string[];
  openQuestions: string[];
}
```

**`normalizeQuestions()` repair rules** (pure, unit-tested — the model *will* get
these wrong, and a hard rejection wastes a turn for a cosmetic defect):

1. Trim to the first 5 questions; drop questions with fewer than 2 options; trim
   each question to its first 4 options.
2. If **zero** options are `recommended`, mark the first one and append
   ` (assumed default)` to nothing — the flag alone is the UI signal.
3. If **more than one** is `recommended`, keep the first and clear the rest.
4. Deduplicate option labels case-insensitively; if a duplicate leaves fewer than
   2 options, drop the question.
5. Append the synthetic `Other…` option with `isOther: true`, unless a supplied
   label already matches `/^other/i`.
6. If **all** questions were dropped, the tool returns
   `errorResult('No usable questions: each needs 2-4 distinct options.')`

Rules 1 and 4 are reachable *because* §4.1's schema stopped declaring
`minItems` / `maxItems` (P0-4). With the bounds in the schema, `ajv` rejected the
call first and these lines never executed.

**Rule 1 caps before it drops, and that is the one place this file does
(R2-P2-1).** `normalizeQuestions` slices the raw array to five and *then* discards
the unusable ones, so a six-question call whose third question has one option
renders four. `normalizePlan` and `nonEmptyStrings` do the opposite, for the
reason IF-4 gives: noise must not consume slots the model meant for content.
Left as-is rather than "fixed" during a review, because the blast radius is one
question out of five and the alternative reading — repair everything, then keep
the best five — is a behaviour change that wants its own test matrix. It is the
first thing to align if these functions are touched again.

**`normalizePlan()` repair rules** (P2-2 — the same input, so the same
discipline; a plan is worth more than a question and must not be thrown away for
being one step long):

1. Clamp the scalars: `title` to 80 chars, `summary` to 600, each step `title` to
   100 and `detail` to 400 — truncating on a word boundary where one exists
   within the last 12 characters, else hard.
2. **Drop first, cap second (IF-4).** Discard steps whose `title` is blank after
   trimming, *then* keep the first 20 of what survives. The reverse ordering —
   which v2 spelled out — lets a blank step consume one of the twenty slots and
   silently pushes a real step off the far end: a 25-step plan with one blank at
   index 3 comes back with 19 steps and nothing says so. Truncation is silent to
   the model but **visible to the user**: the overlay footer shows the real
   count, so a clipped plan cannot masquerade as complete.
3. Same ordering for the string lists: drop blanks, deduplicate, *then* keep the
   first 30 `filesTouched`, 10 `risks`, 10 `openQuestions`. Deduplication of
   `filesTouched` is exact, not case-insensitive — POSIX paths are case-sensitive
   and two casings are two files.
4. If **no** step survives, return
   `errorResult('A plan needs at least one step with a title.')` — the only hard
   failure, because there is nothing left to review..

### 5.2 View state

```ts
export type Overlay = null | 'settings' | 'model' | 'help' | 'confirm'
                    | 'question' | 'plan';          // + 2

export interface ViewState {
  /* ...unchanged... */
  agentMode: AgentMode;                  // mirror of the controller's effective mode
  pendingAgentMode: AgentMode | null;    // set only by a deferred plan -> build
}

export type ViewAction =
  /* ...unchanged... */
  | { type: 'setAgentMode'; mode: AgentMode; pending: AgentMode | null };
```

`initialViewState()` seeds `agentMode: 'build'`, `pendingAgentMode: null`; the
App overrides it once on mount from `controller.getAgentMode()` so `--plan`
renders correctly on the first frame.

`Entry` is **unchanged** (§1 non-goals), therefore `session/persist.ts`,
`SESSION_VERSION`, `density.ts::separationRows`, `transcript-text.ts` and
`computeSettledCount` are all untouched. A session saved by a plan-mode run
loads in an older build with no migration: the plan simply renders as a generic
tool card.

### 5.3 Headless (`-p` / piped stdin)

`makeController(flags, { interactive: false })` passes
`humanInput: DENY_ALL_HUMAN_INPUT`, and `createPlanTools()` returns `[]` for a
gate whose **static** `neverPrompts` is true — so in headless the tool list stays
exactly the 7 (or 11 with skills) it is today, and the model is never shown a
tool it cannot use.

```ts
export function createPlanTools(opts: PlanToolsOptions): AgentTool[] {
  // `neverPrompts`, NOT `canPrompt()` (P0-3). This function runs inside
  // `makeController()`, and in the interactive path `confirmBridge.handler` is
  // still null there — the App attaches it later, in an effect. So
  // `canPrompt()` is false for EVERY session at this moment, and gating on it
  // would ship plan mode with no ask_user and no submit_plan, in every
  // interactive session, with nothing anywhere reporting it.
  //
  // Registration is a one-time structural question ("can this channel ever
  // reach a human?"); `canPrompt()` answers a live one ("is one attached right
  // now?") and is checked again inside each tool, where it belongs.
  if (opts.gate.neverPrompts) return [];
  return [makeAskUser(opts), makeSubmitPlan(opts)];
}
```

`aragon -p --plan "add SSO"` is nonetheless a genuinely useful combination: the
read-only gate still applies, so it means *"tell me how you would do this, and do
not touch my repository"*. `buildPlanModeBlock({ interactive: false })` emits a
variant whose last paragraph reads: *"There is no interactive user. Do not ask
questions and do not call submit_plan; write the finished plan as your final
message in markdown."*

---

## 6. UI design

The brief asks for something elegant. Concretely that means: one badge, one hint,
one overlay style shared with the rest of the app, and **no duplicated state
readouts** — the codebase already deleted a duplicated keybinding cluster from
the status bar for exactly that reason (§4.6 of the CLI spec), and this feature
must not reintroduce the pattern.

### 6.1 Mode badge — `src/ui/ModeChip.tsx`

`theme.chip = { fg, bg }` exists in every palette and is currently unused. It is
the natural home for a mode badge:

```
╭──────────────────────────────────────────────────────────╮
│ ❯ Describe what you want to build; I'll plan it first…   │
╰──────────────────────────────────────────────────────────╯
  PLAN   shift+tab build · ⏎ send · / commands · @ files
  ^^^^ chip: theme.chip.bg background, theme.chip.fg text
```

- Rendered by `Composer` on the hint row, left of the keys, so it costs **zero
  extra rows** on a 24-row terminal.
- Shown **only in `PLAN`** (`BUILD` is the default; a badge that is always on is
  furniture, not signal). This also means the `BUILD` rendering of the composer
  is pixel-identical to today's.
- `Box` with `backgroundColor` degrades to plain text at `colorLevel === 0`; at
  that tier the chip renders as `[PLAN]` instead. One branch, `caps.colorLevel > 0`.

**The chip is an enhancement, not the guarantee (P1-6).** It disappears in three
supported configurations, all of which a read-only session must still be
legible in:

| Configuration | Chip | Why |
| --- | --- | --- |
| `rows < HINT_MIN_ROWS` | gone | `showHint={rows >= HINT_MIN_ROWS}` (`App.tsx:730`) |
| `hints: false` / `--no-hints` | gone | `hintsEnabled={cfg.hints}` (`App.tsx:732`) |
| inline render mode | gone | the inline branch mounts bare `PromptInput`, never `Composer` (`App.tsx:740-752`) |

The **status-bar word (§6.4) is therefore the guaranteed carrier**: `StatusBar`
renders in both `AppShell` branches (`AppShell.tsx:38-48`) and has no opt-out or
width gate on its left cluster. Design intent, stated so it survives a later
refactor: *the status bar must always name a non-default mode; the chip may.*
Pinned by AC-P22.

### 6.2 Composer border

`Composer` already picks a border color from a 4-way ternary
(`inactive → running → draft → idle`). Plan mode inserts one branch **above
`draft`** and below `running`: `theme.accent`. Ordering matters — an in-flight
run's border must stay `toolRunning`, because "is it running" is more urgent than
"which mode".

### 6.3 Hint row

`hintText()` gains a mode parameter:

| State | Hint |
| --- | --- |
| running | `⏎ steer · esc abort · ctrl+c×2 exit` — **unchanged, never abbreviated** (A-14). |
| idle, `submitCount < 8`, build | `⏎ send · ⇧⏎ newline · / commands · @ files · shift+tab plan · ? help` |
| idle, `submitCount < 8`, plan | `⏎ send · ⇧⏎ newline · / commands · @ files · shift+tab build · ? help` |
| idle, faded (`>= 8`) | `shift+tab <destination> · ? help` |

The faded form keeps the mode toggle. Progressive disclosure exists to retire
things the user has demonstrably learned; `submitCount` counts *submissions*, and
a user can submit fifty messages without ever discovering `Shift+Tab`. The same
argument the codebase already makes for keeping `esc abort` un-faded applies
here.

### 6.4 Status bar

Left cluster only, immediately after `idle`/`running`, `theme.accent`:

- `PLAN` in plan mode.
- `PLAN → BUILD` when a deferred switch is pending (§3.2).
- nothing in build mode.

No width breakpoint: five columns for the mode is worth more than the tokens
readout it might displace at 60 columns, and the left cluster is already
`flexShrink={0}`. This is the one indicator with **no** suppression path (§6.1,
P1-6) — it must not acquire a `cols >= N` gate, and it must not move into the
right cluster, whose children are flexible and drop characters under pressure
(`StatusBar.tsx:99-104`).

### 6.5 Question overlay — `src/ui/overlays/QuestionOverlay.tsx`

`OverlayFrame` **mode B** (self-managed): the content is a small state machine,
not a list of rows, and slicing it by element would be meaningless.

```
╭ Clarify the request ─────────────────────────────── 2/3 ─╮
│  Datastore                                               │
│  Which datastore should the new service use?             │
│                                                          │
│  ❯ ● Postgres        Matches the existing stack   RECOMMENDED
│    ○ SQLite          Simplest for local dev              │
│    ○ DynamoDB                                            │
│    ○ Other…          type your own                       │
│                                                          │
╰ ↑↓ choose · ⏎ next · ← back · esc cancel ────────────────╯
```

State machine (all inside the component; `App` owns only `Esc`):

| State | Keys |
| --- | --- |
| `choosing` | `↑`/`↓` move · `Enter` confirm + advance · `←` previous question (no-op on the first) · `Space` toggles when `allowMultiple` |
| `typingOther` | printable input appends · `Backspace` deletes · `Enter` commits (empty input falls back to the recommended option) · `←` returns to `choosing` |
| `review` (after the last question) | compact one-line-per-question summary · `Enter` submits · `←` back to the last question |

Details that matter:

- The **recommended option is the initial highlight** for every question, so
  `Enter Enter Enter` is a correct, deliberate "use your judgement" path. This is
  the single highest-value HCI decision in the feature.
- The `RECOMMENDED` badge uses `theme.chip`; radios use the existing
  `glyphs.keyOn` / `keyOff` (`●`/`○` → `*`/`o`), checkboxes need two **new**
  glyph fields (§6.7).
- One question per screen, not all at once. Three questions × four options × a
  description line is 20+ rows; the viewport on a 24-row terminal is ~15.
- The `review` step exists because a wizard that fires on the last `Enter` with
  no confirmation makes a mis-keyed answer unrecoverable.
- `Esc` is handled by `App` **only** (it resolves the bridge promise with `null`
  and clears the overlay). The overlay must **not** also handle `Esc`: the
  `ConfirmDialog` does, which means both paths call `resolve` — harmless there
  only because a settled promise ignores the second call. Not a pattern to copy.

### 6.6 Plan review overlay — `src/ui/overlays/PlanReviewOverlay.tsx`

`OverlayFrame` **mode A** (`rows`), because a 20-step plan must scroll, and mode
A is the only mode with a position indicator.

```
╭ Review plan ─────────────────────────────────────────────╮
│ Add SSO via OIDC                                         │
│ Introduces an oidc provider module, wires it into the    │
│ existing session store, and adds a callback route.       │
│                                                          │
│ Steps                                                    │
│  1  Add the oidc client dependency and config keys       │
│  2  Implement src/auth/oidc.ts                           │
│     Token exchange + JWKS caching; no session writes.    │
│  3  Wire the callback route                              │
│                                                          │
│ Files      src/auth/oidc.ts · src/routes/auth.ts · …     │
│ Risks      Token refresh races with the existing timer   │
│ Open       Do we need PKCE for the desktop client?       │
╰ a approve · r revise · esc dismiss ·  ↑↓ 1-14/22 ────────╯
```

**Mode A slices by ELEMENT, so the prose must be pre-wrapped (P1-3).**
`OverlayFrame` mode A's contract is *one element per row, each already
`wrap="truncate"`* (`OverlayFrame.tsx:36-40`), and `sliceWindow` counts elements,
not lines. `summary` is up to 600 characters and each step `detail` up to 400 —
so handing them over as single `<Text>` children renders each paragraph as one
truncated line, which is the single worst failure available to a plan review
card. The repo has no wrapper (no `wrapText` / `wordWrap` anywhere), so this
feature adds one:

```ts
// src/ui/layout/wrap-rows.ts — pure, no Ink, unit-tested.
/**
 * Break `text` into lines of at most `width` columns, preferring spaces and
 * hard-breaking any single token longer than `width`. Returns `[]` for empty
 * input so callers can splice the result without an emptiness branch.
 */
export function wrapToRows(text: string, width: number): string[];
```

`PlanReviewOverlay` maps each wrapped line to its own `<Text wrap="truncate">`,
which is what makes `1-14/22` in the footer a true statement. `width` is
`cols - 4` (the frame's border plus its one-column padding on each side).

- Actions live in the **frame hint**, not in `rows`. Mode A slices `rows`; an
  action row placed there would scroll off exactly when a long plan needs it
  most. Single-key actions also avoid a second selection cursor competing with
  the scroll cursor.
- The overlay registers **no `Esc` handler and no pending-request resolution of
  its own**: `App` owns `Esc`, and the bridge's `settle()` is the only place a
  human request is answered (§3.5, Corrections 3 and 4). An overlay that also
  resolved would be the `ConfirmDialog` double-resolve pattern, which is harmless
  there only by accident of promise semantics.
- `a` → approve; `r` → a one-line feedback field (mode-B sub-state, same editor
  as `typingOther`), `Enter` sends the revision request.

  **`Esc` belongs to `App` in both sub-states, and the way back to the card is
  `←` (R2-P1-2).** v2 wrote "`Esc` returns to the plan" for the feedback field
  and "`Esc` at the top level → dismiss", which cannot both be true here: `App`
  owns `Esc` for this overlay and settles the pending request with it, and the
  overlay's own handler must therefore open with `if (key.escape) return;`.
  Implementing the v2 sentence literally means registering a second `Esc`
  consumer that also resolves the request — the `ConfirmDialog` double-resolve
  pattern R-P12 exists to keep out. So `Esc` dismisses from *either* sub-state,
  the footer says `esc dismiss` in both, and the back affordance is `←`, which
  is what `QuestionOverlay` already uses for "back" and costs no key ownership.
  Without it the feedback field is a one-way door: it consumes printable input
  and `Backspace`, and the only other exit throws the whole review away.

  *Implementation status:* the `Esc` ownership above is what shipped in round 1;
  the `←` back key was the one behavioural delta this review added (condition 1
  of the round-2 verdict, §14) and shipped in round 2 —
  `PlanReviewOverlay.tsx`'s feedback branch handles `key.leftArrow` by clearing
  the draft back to `null`, the hint reads `⏎ send · ← back · esc dismiss`, and
  `question-overlay.test.tsx` asserts both that `←` returns to the card and that
  `Esc` inside the overlay still changes nothing.
- `App`'s overlay branch must add `'plan'` to its `controlled` set so `PgUp` /
  `PgDn` scroll it, and must **not** add it to the `help`-only `↑`/`↓` branch —
  the plan overlay uses `↑`/`↓` for line scrolling of its own via the same
  `setOverlayScroll` mechanism, one line at a time. (Concretely: extend the
  existing `overlay === 'help'` arrow condition to `overlay === 'help' || overlay
  === 'plan'`.)

### 6.7 Glyphs (`src/ui/glyphs.ts`)

`glyphs.test.ts` fails the build on any non-ASCII literal outside this file, and
its exemption list is declared exhaustive. Every new character therefore goes
here, in **both** tiers:

| Field | Unicode | ASCII |
| --- | --- | --- |
| `boxChecked` | `☑` | `[x]` |
| `boxEmpty` | `☐` | `[ ]` |
| `tool.ask_user` | `?` | `?` |
| `tool.submit_plan` | `◈` | `#` |
| `otherEllipsis` | `…` | `...` (reuse `ellipsis`; **no new field** — listed here so the implementer does not add a duplicate) |

The two tool icons go into the existing `glyphs.tool` map, which is what
`toolGlyph()` reads for a tool card's leading glyph; without them both new cards
fall back to `toolDefault` and look like an unrecognized tool. v1 declared a
consumer-less `planMark` instead (P2-1) — a glyph with no caller is the kind of
thing the next reader deletes, so it is folded into `tool.submit_plan`. Note that
`tool` is the one field `glyphs.test.ts` skips in its per-field loop, but its
ASCII tier **is** scanned separately (`glyphs.test.ts:32-34`), so `?` and `#` are
required to be ASCII-safe — they are.

Radios reuse `keyOn` / `keyOff`. `arrowRight` supplies the `→` in `PLAN → BUILD`.
`OTHER_OPTION_LABEL` in `agent-mode.ts` must be plain `'Other'` (ASCII) with the
ellipsis appended at render time from `glyphs.ellipsis` — `agent/` is inside the
scanner's scope (`/^(agent|commands|config|tools)\//`), so a `'Other…'` literal
there fails the build.

### 6.8 Tool-card previews (`src/ui/entries/ToolPreview.tsx`)

Two new cases in the existing tool-specific preview switch, which is why no new
`Entry` kind is needed:

- `ask_user`: parse the stored JSON preview; render
  `3 questions · Postgres · REST · yes` (dim), or `dismissed` when cancelled.
- `submit_plan`: render `Add SSO via OIDC · 6 steps · approved` with the verdict
  colored (`toolDone` / `noticeWarn`).

Both must fail soft: an unparseable preview falls through to the existing generic
renderer rather than throwing inside a render pass.

---

## 7. File / module change plan

### 7.1 `@aragon-agent/core`

| File | New? | Intent |
| --- | --- | --- |
| `src/engine/watchdog.ts` | mod | Add `paused` flag, `pause()`, `resume()`; `kick()` guard; `stop()` clears `paused`. |
| `src/engine/agent.ts` | mod | Add `pauseIdleWatchdog()` / `resumeIdleWatchdog()`; accept and forward `timeouts.toolTimeoutOverrides`. |
| `src/__tests__/watchdog-pause.test.ts` | **new** | pause suppresses the timer, resume restarts it, `stop()` clears `paused`, both are idempotent. |
| `packages/core/API.md` | mod | Document the two `Agent` methods and the new timeout field — **including** that a per-tool timeout is expressed by aborting `context.signal` and is therefore a no-op for a tool that does not observe it (`executor.ts:139-187`). That is the single most surprising fact about this API and the one P0-2 was made of. |
| `packages/core/CHANGELOG.md` | mod | Minor entry; explicitly note "no change to the export surface". |

### 7.2 `@aragon-agent/cli` — new files

| File | Intent |
| --- | --- |
| `src/agent/agent-mode.ts` | `AgentMode`, `AGENT_MODES`, `MODE_LABEL`, `nextMode()`, `PLAN_TOOL_NAMES`, `OTHER_OPTION_LABEL`, refusal-message builders. Pure; no imports outside core types. **Not** `PLAN_MODE_BLOCKED_TOOLS` — that lives in `tools/index.ts` (P1-7, §3.3). |
| `src/agent/plan-prompt.ts` | `buildPlanModeBlock({ interactive, maxAskRounds })` → the English `<plan_mode>` block; `PLAN_MODE_BLOCK_VERSION`. |
| `src/tools/human-input.ts` | Gate/bridge types incl. `neverPrompts` + the `signal` parameter, `DENY_ALL_HUMAN_INPUT`, `normalizeQuestions()`, `normalizePlan()`, `formatAnswersResult()`. Pure except the types. |
| `src/tools/plan-tools.ts` | `createPlanTools({ gate, takeAskRound, withHumanWait, onPlanApproved })` → `[askUser, submitPlan]`, or `[]` when `gate.neverPrompts` (P0-3). Both tools race `ctx.signal` (P0-2). **No `getMode`** (IF-2): the only mode question either tool faces is "is `submit_plan` allowed?", and `withPlanModeGate` already answers it — a second arbiter is the shape §3.1 forbids. `takeAskRound` replaces the under-specified `rounds` and returns a ticket (`{ok, used, remaining, max}`); `onPlanApproved` names the side effect §4.2 previously left anonymous. |
| `src/ui/layout/wrap-rows.ts` | `wrapToRows(text, width)` — the mode-A prose wrapper (P1-3, §6.6). Pure, no Ink. |
| `src/ui/ModeChip.tsx` | The `PLAN` badge; `caps.colorLevel === 0` fallback to `[PLAN]`. |
| `src/ui/overlays/QuestionOverlay.tsx` | The 3-state question wizard (§6.5). |
| `src/ui/overlays/PlanReviewOverlay.tsx` | The plan card + verdict keys (§6.6); wraps prose through `wrapToRows`. |
| `src/__tests__/plan-mode.test.ts` | `nextMode`, deferral logic, system-prompt byte-identity (I-P1 / I-P8), the frozen-prompt wording (I-P9), `/plan` routing through `applyAgentMode`. |
| `src/__tests__/plan-tools.test.ts` | `normalizeQuestions` + `normalizePlan` repair matrices (including the over-cap inputs that v1's schema would have rejected first), round cap, headless refusal, cancel-is-not-an-error, **abort-via-`ctx.signal` resolves the wait** (I-P10). |
| `src/__tests__/plan-gate.test.ts` | The five refusals, build-mode passthrough, identity when both options are absent, **and the gate applied with no `toolPolicy` supplied** (P0-1 regression). |
| `src/__tests__/wrap-rows.test.ts` | Word boundaries, over-long single token, empty input, exact-width input. |
| `src/__tests__/question-overlay.test.tsx` | Keyboard flow via `ink-testing-library`. |

### 7.3 `@aragon-agent/cli` — modified files

| File | Intent |
| --- | --- |
| `src/agent/system-prompt.ts` | `SystemPromptParams.agentMode?: AgentMode` + `planInteractive?: boolean`; splice the plan block **only** when `'plan'`. Build-mode output byte-identical (I-P1). |
| `src/agent/controller.ts` | Own `effectiveMode` / `pendingMode` / `askRounds`; `getAgentMode()`, `setAgentMode()`, `applyPendingMode()` (called on `agent_end`), `withHumanWait()`; pass `agentMode` + `planTools` to `createBuiltinTools`; pass `toolTimeoutOverrides` to `new Agent`; reset `askRounds` in `prompt()` next to `skills.beginUserTurn()`. |
| `src/agent/reducer.ts` | `Overlay` +2; `ViewState.agentMode` / `pendingAgentMode`; `setAgentMode` action; **subscribe `agent_end` → the App calls `applyPendingMode()`** (the reducer stays pure; the App does the call in its event effect). |
| `src/tools/index.ts` | `withPlanModeGate`; `PLAN_MODE_BLOCKED_TOOLS` (beside `SKILL_TOOL_FLOOR` — P1-7); `agentMode` / `planTools` options; the two-independent-guards body from §3.3 (P0-1); add both names to `HOST_TOOL_NAMES` **and** `SKILL_TOOL_FLOOR` with the dead-end rationale in the comment. |
| `src/commands/registry.ts` | `CommandContext.applyAgentMode` — the single mode write path reaching slash commands (P1-2, §4.3). |
| `src/ui/App.tsx` | `Shift+Tab` (post-overlay, guarded); `humanInputBridge` effect with the `settle()` resolution point, the `signal` abort listener and `cancelPending()` on unmount **and on `runEnd`** (P1-4); two new overlay branches; `'plan'` added to `controlled`; `Esc` settles pending human requests; mode toast; seed `agentMode` on mount; `applyPendingMode()` on `runEnd`; pass `applyAgentMode` into `makeCtx`. |
| `src/ui/Composer.tsx` | `agentMode` prop; border branch; `<ModeChip>`; `hintText(mode, …)`. |
| `src/ui/PromptInput.tsx` | `Shift+Tab` early return (first statement); mode-aware placeholder. |
| `src/ui/StatusBar.tsx` | `agentMode` / `pendingAgentMode` props; left-cluster mode word. |
| `src/ui/overlays/SettingsScreen.tsx` | `key.tab` → `key.tab && !key.shift` (key collision). |
| `src/ui/overlays/HelpOverlay.tsx` | `Shift+Tab` keybinding row; `/plan` command row; a short "Plan mode" section naming `ask_user` / `submit_plan`. |
| `src/ui/glyphs.ts` | `boxChecked`, `boxEmpty` in both tiers, plus `tool.ask_user` / `tool.submit_plan` in the existing `glyphs.tool` map. **No `planMark`** — §6.7 folded it in (P2-1), because a glyph with no consumer is what the next reader deletes, and without the two `tool.*` entries both new cards fall back to `toolDefault`. |
| `src/ui/entries/ToolPreview.tsx` | `ask_user` + `submit_plan` preview cases, failing soft. |
| `src/commands/builtins.ts` | `/plan [on\|off\|status]`. |
| `src/config/schema.ts` | Three flat keys + defaults + `clampAskRounds()` / `clampHumanTimeout()`; extend `PersistedConfig` and `CliConfig`. |
| `src/config/load.ts` | `CliFlags.plan`; resolve `startInPlanMode` through `pick()`; carry the two numeric keys. |
| `src/config/env.ts` | `ARAGON_PLAN`. |
| `src/cli.tsx` | `--plan` / `--no-plan` (positive first, to keep the tri-state); build `humanInputBridge` for interactive and `DENY_ALL_HUMAN_INPUT` for headless; three `CONFIG_SET_KEYS` entries + switch cases. **No `initialAgentMode` prop** (IF-3): §5.2's mount-seed from `controller.getAgentMode()` is the single source, and the controller has already resolved `--plan` / `ARAGON_PLAN` / `planModeDefault` before the App exists — a prop could only restate that, or disagree with it. |
| `src/__tests__/tools.test.ts` | Update the `SKILL_TOOL_FLOOR` and C7 `HOST_TOOL_NAMES` assertions (C7 now passes `planTools` too); **keep** the `toHaveLength(7)` and the sentinel-identity assertions untouched — they are the I-S1 / AC-G17 proofs and both still hold under §3.3's body. The floor test's prose changes from *"read-only work plus the two skill lookups, and nothing else"* to *"read-only work, the two skill lookups, and the two human-input tools — everything that cannot write to disk"* (P2-5): `submit_plan` does mutate the session mode, so the old sentence would become false while the test stayed green. |
| `src/__tests__/skills-controller.test.ts` | Add a plan-mode case asserting 13 tools with the gate wired, 11 without, plus the end-to-end half of AC-P20. |
| `src/__tests__/app.test.tsx` | **Was missing from v2's plan (IF-1).** `FakeController` is a hand-written stub, and `App` now calls `getAgentMode()` on mount and `applyPendingMode()` on `agent_end`, so all 24 of its tests fail with `controller.getAgentMode is not a function` the moment the `App.tsx` row lands. The stub gains `getAgentMode` / `setAgentMode` / `applyPendingMode` / `getPlanStatus`, with `setAgentMode` reproducing §3.2's asymmetry so the stub cannot drift into agreeing with a wrong App. |
| `packages/cli/README.md` | Plan-mode section; keybinding table row; flags; three config rows; the `bash`-is-refused note (R-P13). |
| `packages/cli/CHANGELOG.md` | Minor entry. |

**Not modified, and deliberately so:** `config/store.ts` (flat keys), `agent/reducer.ts`'s
`Entry` union, `session/persist.ts`, `ui/density.ts`, `ui/transcript-text.ts`,
`ui/Transcript.tsx`, `ui/Header.tsx`, `agent/headless.ts`.

---

## 8. The plan-mode prompt block

`buildPlanModeBlock({ interactive: true, maxAskRounds: 4 })` returns (verbatim,
subject only to the `maxAskRounds` substitution):

```
<plan_mode>
You are in PLAN MODE. The user toggled it with Shift+Tab. This is a research and
design mode: you must not change anything on disk and must not run commands.

Work in this order:
1. Ground yourself in the real code. Use read_file, list_dir, glob, grep and any
   relevant skill. Never plan against a directory structure you have not read.
2. If a decision would change the work and you cannot settle it by reading, call
   ask_user with 3-5 multiple-choice questions in ONE call. Mark exactly one
   option recommended:true and put the reason in its description. You may ask up
   to 4 rounds; each round costs the user time, so make them count.
3. Call submit_plan exactly once, with ordered steps a reviewer could check off.
   Name the real files you intend to touch. State the risks you actually found.

Rules:
- While PLAN MODE is active, write_file, edit_file, bash, skill_install and
  skill_create are refused. Do not attempt to work around a refusal; finish the
  plan instead.
- Never ask a question the workspace already answers.
- Never invent a path. Cite files you have read.
- After submit_plan, wait for the verdict. If it is rejected, address the
  feedback and call submit_plan again.
- This block is written once, when the run starts, and is NOT re-issued if the
  mode changes during the run. A submit_plan result reporting that the plan was
  APPROVED is therefore authoritative and supersedes the read-only rule above
  for the remainder of this run: you are in Build mode, the tools are available,
  and you should implement the plan in order without asking again.
</plan_mode>
```

The last rule is load-bearing, not boilerplate (**P1-1**, §3.9). The system
prompt handed to a run is a snapshot: `runLoopWithLifecycle` passes
`systemPrompt: this.systemPrompt` by value (`agent.ts:364`) and every LLM call in
the loop reads that same string (`agent-loop.ts:157`), so the block cannot be
rewritten mid-run. Without this sentence the model finishes the run holding *"you
must not change anything on disk"* alongside a tool result telling it to start
implementing, and the well-aligned resolution of that conflict is to refuse —
which would break AC-P10, the feature's headline. Any edit to the block must
preserve both halves: the read-only rule is **scoped**, and the approval result
is named as the authority.

The headless variant replaces the closing paragraph as described in §5.3.

Splicing follows the existing `hasSkills` pattern in `buildSystemPrompt`:

```ts
const planBlock = params.agentMode === 'plan' ? buildPlanModeBlock({...}) : '';
// ...
...(planBlock ? ['', planBlock] : []),
```

so `agentMode !== 'plan'` produces a byte-identical prompt (**I-P1**).

---

## 9. Testing & acceptance criteria

### 9.1 Invariants (each gets a named test)

| ID | Invariant |
| --- | --- |
| **I-P1** | For a **fixed `tools` array**, `buildSystemPrompt()` with `agentMode` absent or `'build'` is byte-identical to the pre-feature output (snapshot). Scoped deliberately (P1-5): the builder renders `Available tools:` from `params.tools` (`system-prompt.ts:45-47`), so registering plan tools does add two lines to a live interactive prompt in *either* mode. §3.4 accepts that cost; this invariant is about the plan **block**, not the tool list. |
| **I-P8** | The *live* prompt is byte-identical on the paths that have no human-input gate: headless (`-p`), and any controller constructed without one. This is what keeps `AC-10`, `toHaveLength(7)` and `toHaveLength(11)` green, and it is the assertion to reach for when someone asks "did this feature change the default session?". |
| **I-P2** | `createBuiltinTools({ getCwd })` still returns exactly 7 tools, by object identity where already asserted. Adding `agentMode` alone (no `planTools`) returns 7 *wrapped* tools with the same names and order. |
| **I-P3** | In `plan`, each of the five blocked tools returns `isError: true` and never invokes the underlying `execute` (spy asserts zero calls) — **including when no `toolPolicy` was supplied** (P0-1). |
| **I-P4** | In `build`, none of the five is blocked, and `submit_plan` is. |
| **I-P5** | The watchdog is paused for exactly the duration of a human wait, and resumed even when the wait throws. |
| **I-P6** | `PLAN_MODE_BLOCKED_TOOLS ∪ SKILL_TOOL_FLOOR ⊇ HOST_TOOL_NAMES` and the two sets are disjoint. |
| **I-P7** | `normalizeQuestions()` never returns a question with 0 or >1 recommended options, and never fewer than 2 real options — for inputs that violate every documented bound, since §4.1's schema no longer rejects them first (P0-4). |
| **I-P9** | `buildPlanModeBlock()` scopes its read-only rule (`/while PLAN MODE is active/`) and names the approval result as superseding it. A static assertion on the string, because the failure it prevents is a model refusing to implement an approved plan — invisible in every unit test and expensive to diagnose from a transcript (P1-1). |
| **I-P10** | Aborting the `ctx.signal` handed to `gate.request()` resolves the wait with `null` and clears the overlay, and does so exactly once even if `Esc` and the abort race (P0-2 / P1-4). |
| **I-P11** | **At most one human request is outstanding at a time** (§3.5, R2-P1-3). The bridge renders through a single `humanRequest` slot and resolves every pending entry with one response, so this is a correctness precondition, not an optimization. It is guaranteed by sequential tool execution in `@aragon-agent/core` (`agent-loop.ts`, `for…of` with an inner `await`) plus one run in flight at a time — i.e. by a *different package*, which is why it is written down here. The test asserts the bridge's behaviour under a second overlapping `request()` (last-writer-renders, both entries settled) so the day the guarantee disappears, a test says so instead of a user. |

### 9.2 Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC-P1 | `Shift+Tab` on an idle session toggles the badge, the border color, the hint destination and the status-bar word, and toasts once. |
| AC-P2 | `Shift+Tab` while any overlay is open does nothing. |
| AC-P3 | `Shift+Tab` while the `/` palette or `@` popup is open toggles the mode and **does not** modify the draft buffer. |
| AC-P4 | `Shift+Tab` inside the settings screen does not move the field cursor. |
| AC-P5 | In plan mode, asking the agent to edit a file yields a refusal in the transcript and no filesystem change (assert via `fs.statSync` mtime). |
| AC-P6 | `ask_user` renders the wizard; `Enter Enter Enter` selects every recommended option; the tool result lists exactly those labels. |
| AC-P7 | Choosing `Other…` opens the inline editor; committing puts the text in `custom` and `"Other"` in `selected`. |
| AC-P8 | `Esc` in the wizard returns a **non-error** result with `cancelled: true`. |
| AC-P9 | A 5th `ask_user` call in one user turn (default cap 4) is refused with the "proceed with assumptions" message; the counter resets on the next user message. |
| AC-P10 | `submit_plan` renders the plan; `a` approves, flips the mode to `build` **within the same run**, and the next `write_file` succeeds. |
| AC-P11 | `r` + feedback returns the feedback verbatim to the model and leaves the mode at `plan`. |
| AC-P12 | `plan → build` pressed during a run does not take effect until `agent_end`; the status bar shows `PLAN → BUILD` meanwhile; a `write_file` attempted before `agent_end` is still refused. |
| AC-P13 | `build → plan` pressed during a run takes effect immediately: the next mutating tool call is refused. |
| AC-P14 | A human wait longer than the old `idleTimeoutMs` does not abort the run (regression test with a 1 s watchdog and a 3 s scripted wait). |
| AC-P15 | `aragon -p --plan "…"` produces a markdown plan, registers **no** plan tools, and makes no filesystem writes. |
| AC-P16 | Ctrl+C ×2 during the question overlay exits cleanly; the pending promise resolves via `cancelPending()` and no timer keeps the process alive. |
| AC-P17 | With `caps.unicode === false`, no overlay emits a non-ASCII byte (`glyphs.test.ts` static scan stays green, plus a render assertion on the wizard). |
| AC-P18 | `aragon config set planModeDefault true` then relaunch starts in plan mode; `--no-plan` overrides it. |
| AC-P19 | A session saved in plan mode loads on a build without the feature (tool cards render generically; no exception). |
| AC-P20 | With plan mode on, `aragon --no-skills --plan` still refuses `write_file` (P0-1). Asserted directly on `createBuiltinTools` **and** end-to-end through a controller built with `skills.enabled: false`, because the two could diverge only through the wiring this criterion exists to check. |
| AC-P21 | Aborting a run while the question or plan overlay is open closes the overlay, resolves the pending request, and leaves no timer holding the process open (P0-2 / P1-4). Also asserted with a 1 s `toolTimeoutOverrides` value, which is the timeout path in miniature. |
| AC-P22 | `PLAN` is visible in all three chip-suppression configurations — `rows < HINT_MIN_ROWS`, `hints: false`, inline render mode — via the status-bar word (P1-6). |
| AC-P23 | An `ask_user` call with 7 questions, one of them holding 6 options and a 40-character `header`, is **repaired** and rendered rather than rejected, with `ajv` installed (P0-4). |
| AC-P24 | `/plan` and `Shift+Tab` produce identical state, asserted by driving both and comparing `controller.getAgentMode()` **and** `state.agentMode` (P1-2 — two write paths would show up as a mismatch in exactly one of the two). |
| AC-P25 | Dismissing a plan card leaves the run alive and the mode at `plan`; pressing `Esc` a second time with no overlay open aborts the run (R2-P1-4). The pair is one criterion on purpose: the first half is the documented behaviour, the second half is the only exit from a resubmit loop, and testing either alone would leave the user-visible gap unpinned. |
| AC-P26 | `/plan status` reports the effective mode, any pending mode, and `askRoundsUsed/maxAskRounds` from `getPlanStatus()`, and `/plan <garbage>` warns without changing the mode (R2-P2-5). `/plan status` is the only read surface for the ask budget, so a silent regression there is invisible everywhere else. |

### 9.3 Manual smoke additions (`packages/cli/README.md` → *Manual smoke checklist*)

1. `Shift+Tab` at 40, 80 and 120 columns — badge, hint and status bar all legible,
   no wrapped rows.
2. The question wizard at 24 rows with 5 questions × 4 options — no clipping, the
   position indicator matches.
3. Approve a plan and watch the same run start writing files.
4. `--no-color` and a legacy `cmd.exe` — chip renders `[PLAN]`, radios render
   `*`/`o`, no mojibake.
5. A plan with a 600-character summary and a 400-character step detail — the text
   wraps and scrolls, the footer count matches the real number of rows, nothing is
   truncated to a single line (P1-3).
6. `--no-hints` and a 20-row terminal in plan mode — the status bar still says
   `PLAN` with no chip on screen (P1-6).
7. Dismiss a plan card with `Esc`, let the model resubmit, then press `Esc` twice
   — the run aborts and the session returns to an idle prompt (R2-P1-4). Do this
   one by hand as well as in a test: the point of the check is whether the exit
   is *findable*, which no assertion can tell you.

---

## 10. Risks & mitigations

| ID | Risk | Mitigation |
| --- | --- | --- |
| R-P1 | **Terminal eats `Shift+Tab`.** Some multiplexers and remote-desktop stacks never send `CSI Z`. | `/plan` is a first-class equivalent, documented next to the keybinding in both the README and the help overlay. `--plan` covers the startup case. |
| R-P2 | **Double-handling of `Shift+Tab`** silently rewrites the user's draft when a completion popup is open. | `PromptInput` returns on `key.tab && key.shift` as its **first** statement, before the popup branch; AC-P3 pins it. |
| R-P3 | **A blocked human wait kills the run** via the tool ceiling or the idle watchdog. | `pause()`/`resume()` around every wait (in `try/finally`) + a 30-minute per-tool override; AC-P14. Also fixes today's `--confirm` bug. |
| R-P14 | **A blocked human wait wedges the run forever** — the mirror image of R-P3, and the more dangerous half, because pausing the watchdog *creates* it. `ToolExecutor`'s timeout is cooperative, so the override alone is inert. | `gate.request(req, ctx.signal)` + the bridge's single `settle()` path (§3.5, Correction 3); I-P10, AC-P21. Reviewed as P0-2. |
| R-P15 | **The gate is silently absent** on a supported flag combination, so the badge promises read-only and the tools write. | Two independent guards in `createBuiltinTools`, never a shared early exit (§3.3); I-P3, AC-P20. Reviewed as P0-1. |
| R-P16 | **The plan tools are never registered**, because registration was gated on a live probe that is false at construction time. | Static `neverPrompts` on the gate; `canPrompt()` stays the per-call probe (§3.5 / §5.3). Reviewed as P0-3. |
| R-P17 | **The model refuses to implement its own approved plan**, because the run's frozen system prompt still forbids writing. | The block scopes its rule and names the approval result as authoritative (§3.9 / §8); I-P9, AC-P10. Reviewed as P1-1. |
| R-P4 | **A dangling promise wedges the tool** after the App unmounts. | `HumanInputBridge.cancelPending()` runs *before* `handler = null`; AC-P16. |
| R-P5 | **Model loops on `ask_user`** and the user is trapped in a questionnaire. | Hard per-turn cap (`planModeMaxAskRounds`, default 4), an explicit "rounds remaining" field in every result, and a refusal message that tells the model what to do instead. |
| R-P6 | **A cancelled wizard reads as a tool failure** and the model retries forever. | Cancellation returns a **non-error** result carrying explicit next-step guidance; AC-P8. |
| R-P7 | **Mode drift between controller and view** — the badge says one thing, the gate does another. | `setAgentMode()` returns the *adopted* state and the App dispatches that value, never the requested one. Single write path (§3.1). |
| R-P8 | **Registry mutation mid-loop** if tools were rebuilt on toggle. | Tools are registered once per session; only the prompt is rebuilt (§3.4). |
| R-P9 | **`SKILL_TOOL_FLOOR` change weakens the skill ceiling.** | The two additions are non-mutating and interactive-only; without them a skill declaring `allowed-tools` would make `ask_user` unreachable and dead-end plan mode — the exact dead end iteration 2 of the skills work removed. Recorded in the comment beside the constant. |
| R-P10 | **Prompt bloat** — the plan block plus two tool schemas is ~700 tokens. | The block is spliced only in plan mode (I-P1); the two schemas are the only unconditional cost and only in the interactive TUI, never headless. |
| R-P11 | **`glyphs.test.ts` build break** from a stray `…` or `●` in a new file. | Every new character is added to `glyphs.ts` up front (§6.7), including the `OTHER_OPTION_LABEL` trap in `agent/`, which is inside the scanner's scope. |
| R-P12 | **Overlay key double-binding** — `App` and the overlay both claim `Esc`, resolving twice. | `App` owns `Esc` for both new overlays; the overlays register no `Esc` handler. Called out explicitly because `ConfirmDialog` does the opposite. |
| R-P13 | **`bash` refusal frustrates users** who wanted `git status` in plan mode. | Documented in the README and named in the refusal message, which points at `read_file` / `glob` / `grep`. Revisit only with a real allowlist, never with substring matching. |
| R-P18 | **A `submit_plan` resubmit loop with no budget.** Dismissal tells the model to try again and nothing counts the attempts, so a user pressing `Esc` keeps getting cards (R2-P1-4). | The exit exists (`Esc` closes the card, a second `Esc` aborts the run) and is now documented in §4.2, the README and AC-P25. A per-turn `planModeMaxPlanRounds` is the symmetric fix and is specified as a scoped follow-up rather than a review edit, because it changes a model-facing refusal surface. |
| R-P19 | **Concurrent tool calls would cross-wire the human bridge** — one render slot, one broadcast resolution, two waiting tools (R2-P1-3). | Not reachable while `@aragon-agent/core` executes tool calls sequentially; stated as I-P11 with the concrete `Map<requestId, Entry>` change required *before* any such concurrency lands, because the failure is silent and looks like a model error. |

---

## 11. Implementation order

Each step compiles and its tests pass before the next begins.

1. **Core** — watchdog `pause`/`resume`, `Agent` delegations, `toolTimeoutOverrides`, `watchdog-pause.test.ts`, `API.md`, `CHANGELOG.md`.
2. **Pure CLI foundations** — `agent-mode.ts`, `plan-prompt.ts` (with the §8 scoping sentence, I-P9), `human-input.ts` (types incl. `neverPrompts` + `signal`, normalizers), `wrap-rows.ts`, config schema/load/env. Tests: `plan-mode.test.ts` (I-P1 / I-P8 / I-P9), both normalizer matrices, `wrap-rows.test.ts`.
3. **The gate** — `withPlanModeGate` + `PLAN_MODE_BLOCKED_TOOLS` + the two-guard `createBuiltinTools` body (§3.3); `plan-gate.test.ts` **including the no-`toolPolicy` case** (AC-P20); update `tools.test.ts`.
4. **The tools** — `plan-tools.ts` against a fake gate, racing `ctx.signal`; `plan-tools.test.ts` (I-P10). Still no UI: everything above is testable headlessly.
5. **Controller** — mode ownership, deferral, `withHumanWait`, `getPlanStatus()`, tool wiring, `toolTimeoutOverrides`; `skills-controller.test.ts` update.
6. **UI chrome** — `glyphs.ts`, `ModeChip`, `Composer`, `PromptInput`, `StatusBar` (the guaranteed carrier — AC-P22), `SettingsScreen` fix, `Shift+Tab` in `App`. This is the first point at which the feature is visible.
7. **Overlays** — `QuestionOverlay`, `PlanReviewOverlay`, `App` wiring, the bridge with `settle` / `signal` / `cancelPending` on unmount **and** `runEnd`; `question-overlay.test.tsx`.
8. **Polish** — `ToolPreview` cases, `/plan` + `CommandContext.applyAgentMode`, `HelpOverlay`, `packages/cli/README.md`, `packages/cli/CHANGELOG.md`, manual smoke.

Steps 1–5 are ~60 % of the work and carry ~90 % of the correctness risk; they are
all unit-testable without a terminal, which is why they come first. All four P0
fixes land in steps 2–4, i.e. before any pixel exists — which is the point: every
one of them is a silent failure, and a silent failure found by a test is cheap
while the same failure found by a user is a trust problem.

---

## 12. 评审结论 (Review Verdict)

### 有条件通过 — approved with conditions

This is a strong design. It reasons from the codebase's actual seams rather than
from a generic idea of how a TUI mode ought to work, and the parts that are hard
to get right — wrapper ordering, static tool registration versus a live gate,
asymmetric deferral, the single mode write path, the glyph scanner's reach into
`agent/` — are not only correct but correct *for stated reasons that survive
being re-derived*. The keyboard-collision analysis in §3.7 in particular found two
real bugs (`PromptInput.tsx:342`, `SettingsScreen.tsx:103`) that a less careful
design would have shipped. Nothing in the review changed the architecture; all
eleven P0/P1 findings were gaps between the design and the engine's actual
behavior, and all eleven are fixed in the v2 body above.

The verdict is conditional on four things, none of which is a redesign:

1. **The four P0 fixes land in implementation steps 2–4, before any UI exists**
   (§3.3 two-guard body, §3.5 Correction 3 + `neverPrompts`, §4.1/§4.2 shape-only
   schemas). Each has a named regression test (AC-P20, AC-P21, AC-P23, and the
   `plan-tools.test.ts` registration case). All four fail *silently* — no
   exception, no log, a badge that says the opposite of the truth — so a manual
   smoke pass cannot substitute for the tests.

2. **I-P9 ships as a static assertion on the prompt string.** It is the only
   guard on the frozen-prompt problem (§3.9), and the failure mode — a model
   declining to implement a plan the user just approved — presents as "the LLM is
   being unhelpful today" rather than as a bug in this feature. A one-line regex
   test now costs less than one transcript investigation later.

3. **The `bash` refusal (R-P13) gets its README paragraph in the same PR**, not a
   follow-up. `git status` being refused in a mode called "plan" is the single
   most likely support question this feature generates, and §3.3's reasoning for
   refusing wholesale is sound but is not self-evident from the terminal.

4. **`packages/cli/README.md`'s keybinding table names `/plan` next to
   `Shift+Tab`.** R-P1 is a real risk on multiplexed and remote terminals, and a
   documented equivalent is the entire mitigation — an undiscoverable escape
   hatch is not one.

Two things are explicitly **out of scope and stay that way**: threading a
`getSystemPrompt` callback through `AgentLoopContext` (§3.9's rejected
alternative — more correct, not additive, and buys nothing the §8 wording does
not), and any form of `bash` allowlisting (R-P13 — revisit with a real allowlist
or not at all, never with substring matching).

No P0 or P1 concern remains unresolved in this document.

---

## 13. 实施过程发现的方案缺陷 (Issues Found During Implementation)

Recorded per the implementation brief: where the design was wrong, incomplete or
under-specified, what was built instead, and why. None of these changed the
architecture; all four P0 fixes and all seven P1 fixes landed as written.

### IF-1 · `§7.3` omits `src/__tests__/app.test.tsx`, which the feature breaks

The change plan lists `tools.test.ts` and `skills-controller.test.ts` as the two
tests needing updates. It misses `app.test.tsx`, whose `FakeController` is a
hand-written stub — and `App` now calls `controller.getAgentMode()` in a mount
effect and `controller.applyPendingMode()` on `agent_end`. Every one of its 24
tests failed with `controller.getAgentMode is not a function` the moment §7.3's
`App.tsx` row landed.

**Built:** `FakeController` gains `getAgentMode` / `setAgentMode` /
`applyPendingMode` / `getPlanStatus`, with `setAgentMode` implementing the same
§3.2 asymmetry as the real controller so the stub cannot drift into agreeing
with a wrong App. This is a mechanical consequence of the design, not a
deviation from it — but an implementer following §7.3 literally would have been
surprised by it, which is what this note is for.

### IF-2 · `createPlanTools`'s `getMode` option has no consumer

§7.2 specifies `createPlanTools({ gate, getMode, rounds, withHumanWait })`.
`getMode` is never needed: the only mode-dependent decision either tool faces is
"is `submit_plan` allowed right now?", and §3.3 already answers it in
`withPlanModeGate`, which wraps the plan tools along with everything else. A
second mode check inside `submit_plan` would be a second arbiter of the same
question — the shape §3.1 exists to forbid — and an unused parameter is the kind
of thing the next reader deletes without knowing whether it was load-bearing.

**Built:** `PlanToolsOptions = { gate, takeAskRound, withHumanWait,
onPlanApproved }`. `takeAskRound` replaces the under-specified `rounds`, and
`onPlanApproved` was implicit in §4.2's "side effect" column but had no name.

### IF-3 · `§7.3` asks `cli.tsx` to pass `initialAgentMode` to `<App>`, which §5.2 makes redundant

§5.2 says the App "overrides `initialViewState()` once on mount from
`controller.getAgentMode()`". §7.3's `cli.tsx` row additionally asks for an
`initialAgentMode` prop. Both would be two sources for one fact, and the prop is
the worse of the two: the controller already resolved `--plan` / `ARAGON_PLAN` /
`planModeDefault` before the App exists, so a prop could only ever restate what
`getAgentMode()` already knows — or disagree with it.

**Built:** the §5.2 mount-seed only. No `initialAgentMode` prop.

### IF-4 · The normalizers' cap-then-drop ordering discards good content

§5.1 writes the repair rules as "keep the first 20 steps; drop steps whose title
is blank" and "keep the first 30 `filesTouched` … deduplicate". Read literally,
that caps the RAW array first, so a blank step or a duplicate path consumes one
of the slots and a real entry falls off the far end. A 25-step plan with one
blank at index 3 comes back with 19 steps, and nothing says so.

**Built:** drop-and-deduplicate first, cap second, in `normalizePlan` and in
`nonEmptyStrings`. The caps are unchanged; only noise stops competing with
content for the slots. `plan-tools.test.ts` pins both orderings.

### IF-5 · §4.1's `formatAnswersResult` example cannot be produced from its own inputs

The example result line is `User answered 2 of 2 questions.`, but the shape it
is formatted from (`{answers, cancelled, roundsUsed, roundsRemaining}`) carries
only the number of ANSWERS. After a cancellation those two numbers differ, and
"answered 1 of 3" is the entire information content of that line.

**Built:** `formatAnswersResult(shape, asked)` takes the asked count as a second
argument. The JSON body is unchanged, so nothing the model parses moved.

### IF-6 · The approval mode-flip needs the App to write first, not to mirror after

§3.8's sequence diagram shows the App calling `setAgentMode('build', {force:
true})` on approval; §4.2's result table lists the same call as `submit_plan`'s
side effect. Only one of the two can be the writer, and the naive reading — the
tool writes, the App mirrors — does not work: the App resolves the bridge
promise synchronously, and the tool's continuation runs a microtask later, so
`controller.getAgentMode()` read straight after `resolveHuman()` still returns
`'plan'` and the badge lags a frame behind the mode the user just authorized.

**Built:** the App writes through its single `applyMode` path BEFORE resolving,
and `submit_plan` still calls `onPlanApproved()` when its wait returns. The
second call is idempotent (`setAgentMode('build', {force:true})` on a session
already in `build` is a no-op), and it stays because it must work even if the App
unmounted between the keypress and the tool's continuation. One writer function,
two callers, no divergent state.

### IF-7 · `ask_user`'s round cap has to be spent AFTER normalization

§4.1 lists the round-cap refusal above the repair rules, which reads as
"consume, then normalize". A malformed call that normalizes to zero usable
questions would then burn one of the user's four rounds without ever rendering
anything — the user pays for the model's mistake.

**Built:** `normalizeQuestions()` runs first, and the round is taken only once
there is something to show. `plan-tools.test.ts` asserts the budget is untouched
by a call with no usable questions.

### Not a defect, recorded to save the next reader the trip

`§7.2` lists `glyphs.ts` as gaining `planMark`; §6.7 (post-review) correctly
folds that into `tool.submit_plan` and adds `tool.ask_user`. The implementation
follows §6.7. `boxChecked` / `boxEmpty` landed as specified, in both tiers.

*(v3 note: every entry above has now been folded back into the normative body —
§3.8, §4.1, §4.2, §5.1, §7.2, §7.3 — per R2-P1-1. This section stays as the
record of why those sections read the way they do; the body stays as the thing
you implement from. If the two ever disagree again, the body is wrong.)*

---

## 14. 第 2 轮评审结论 (Review Verdict — round 2)

### 有条件通过 — approved with conditions

The second pass asked a different question from the first: not *"can this be
built?"* but *"is the thing that was built the thing this document describes, and
does the document still lead the next person to the right place?"*

**On the first half — yes, and unusually so.** All four P0 fixes are load-bearing
code rather than prose: two independent guards with no shared exit, a bridge that
races `ctx.signal` through one idempotent `settle()`, registration keyed on the
static `neverPrompts`, and shape-only schemas with the bounds in normalizers that
are the sole authority. Each carries the named regression test the v2 verdict made
a condition (`plan-gate.test.ts:79` and `skills-controller.test.ts:205` for
AC-P20, `plan-tools.test.ts:207` for I-P10, `:303` for AC-P23,
`plan-mode.test.ts:70` for I-P9). The mechanism the design was least able to
verify on paper — that a per-tool timeout is expressed by aborting a signal and
therefore needs a listener — is correct in both directions in the shipped code:
`ToolExecutor` aborts a **per-call** controller merged with the external signal,
so the 30-minute ceiling ends the *wait* and not the run, and because the tool
returns rather than throws, the model gets the non-error `cancelled: true` shape
§4.1 promises rather than a timeout error.

**All four conditions attached to the v2 verdict are discharged**, verified
against the tree rather than the commit message: (1) the P0 tests exist and are
named; (2) I-P9 ships as a static assertion on the prompt string; (3)
`packages/cli/README.md` carries the `bash`-is-refused-in-full paragraph in the
same change; (4) the README keybinding table names `/plan` on the `Shift+Tab` row
and again in the "If `Shift+Tab` does nothing" section.

**On the second half — not yet, which is what this round fixes.** The body of the
document had drifted from the code in seven places (R2-P1-1), all of them
recorded honestly in §13 and none of them corrected where anyone would look; §6.6
told the next maintainer to add the one `Esc` handler R-P12 exists to forbid
(R2-P1-2); the bridge's correctness rested on a sequential-execution guarantee
owned by the other package and written down nowhere (R2-P1-3); and `submit_plan`
had no budget while its dismissal text asked for a resubmit, making `esc dismiss`
name the loop rather than the exit (R2-P1-4). All four are fixed in the v3 body.
No P0 was found, and no P0 or P1 remains unresolved in this document.

The verdict is conditional on three things, all small and all scoped:

1. **`←` returns from the revise-feedback field to the plan card** (§6.6). This is
   the only behavioural delta this review adds, and it is a one-branch change in
   `PlanReviewOverlay`. It must not be implemented by giving the overlay an `Esc`
   handler — that is the double-resolve pattern R-P12 rules out, and it is exactly
   the "fix" the v2 text invited. Today the feedback field is a one-way door.

2. **AC-P25 ships with the change that adds it** — dismissal keeps the run alive,
   and a second `Esc` aborts it — together with one README sentence naming that
   exit next to the plan-mode section. A resubmit loop whose only escape is
   undocumented is a support question waiting to happen, and the manual smoke item
   (§9.3 #7) is there because findability is not something a test can assert.

3. **I-P11 ships as a test, not as a paragraph.** The invariant is owned by
   `@aragon-agent/core` and consumed by `@aragon-agent/cli`; a comment in the CLI
   cannot fail when the engine changes. Assert the bridge's behaviour under two
   overlapping requests so the guarantee's disappearance is a red test rather than
   a user watching one tool answer another tool's question.

Deliberately **not** conditions, recorded so they are not re-litigated: the
`normalizeQuestions` cap-then-drop asymmetry (R2-P2-1 — bounded, costs one
question out of five, and realigning it is a behaviour change wanting its own
matrix); the non-re-entrant watchdog pause (R2-P2-2 — unreachable today, with the
counter change specified for whoever adds a third human wait); the stale
`toolPolicy` doc comment (R2-P2-3); and `planModeMaxPlanRounds` (R-P18 — the
symmetric fix to the ask cap, correct but model-facing, so it belongs to its own
change with its own criterion rather than to a review edit).

Still out of scope and staying that way, unchanged from §12: threading a
`getSystemPrompt` callback through `AgentLoopContext`, and any form of `bash`
allowlisting.

### Status of the three conditions (written by the implementation node)

All three landed in the round that followed this verdict. Recorded here rather
than in §13, which is for defects found while implementing; nothing in the round-2
body turned out to be wrong.

| # | Condition | Where it lives now |
| --- | --- | --- |
| 1 | `←` returns from the feedback field to the plan card, with no `Esc` handler added | `ui/overlays/PlanReviewOverlay.tsx` (one branch in the feedback sub-state; the hint gained `← back`), asserted by `question-overlay.test.tsx`'s *"`<-` returns from the feedback field to the card, and Esc is left alone"* — which also presses `Esc` inside the overlay and asserts nothing moves, so the double-resolve "fix" R-P12 forbids cannot be reintroduced silently |
| 2 | AC-P25 ships with the README sentence naming the exit | `app.test.tsx`'s *AC-P25* drives both halves against a real bridge (dismiss → `settled === null`, run still alive, mode still `plan`; second `Esc` → `controller.abort()`); `README.md` gains the **"Dismissing a plan is not how you stop"** paragraph in the plan-mode section and smoke item 7 in the *Manual smoke checklist*; the `CHANGELOG.md` plan-mode entry says the same in one sentence |
| 3 | I-P11 ships as a test, not a paragraph | `app.test.tsx`'s *I-P11* issues two overlapping `request()` calls and asserts last-writer-renders plus **both** entries settled. Verified to fail rather than pass vacuously: with `cancelPending()` mutated to settle only the first entry the second promise never resolves and the test times out |

One P2 was taken along with them because it was a comment on a file this round
had reason to be accurate about: `BuiltinToolsOptions.toolPolicy`'s doc comment
no longer says *"see the early return below"* (R2-P2-3). The other four P2s and
`planModeMaxPlanRounds` (R-P18) are untouched, as §14 intended.
