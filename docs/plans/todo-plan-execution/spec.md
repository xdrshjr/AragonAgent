# TODO planning and step-by-step execution — design specification

- **Feature slug**: `todo-plan-execution`
- **Target**: `@aragon-agent/cli` (`packages/cli`) only. **Zero files under `packages/core/` change.**
- **Version**: **v2** — design-review pass (v1 = solution-architect first draft)
- **Status**: 有条件通过 — approved with conditions, see [§14](#14-评审结论-review-verdict).
  Design complete, not implemented. This document is the whole decision surface;
  a downstream engineer should need no further judgement calls.
- **Prompt-block version**: `TODO_BLOCK_VERSION = 'v1-2026-07'`
- **Reviewer**: design-review node (design only — no code for this feature exists yet)

---

## 0. 评审记录 (Review Notes)

Held against the tree as committed on `master`, not against the design's account
of itself. Files read in full or in the relevant part:
`packages/cli/src/{cli.tsx, agent/{controller,reducer,system-prompt,headless}.ts,
ui/{App,Transcript,TeamPanel,StatusBar,glyphs,gauge}.tsx?,
ui/layout/{AppShell,ScrollViewport,ScrollIndicator,budget}.tsx?,
tools/index.ts, team/panel-rows.ts, commands/builtins.ts,
config/{schema,load,env,store}.ts, session/persist.ts,
__tests__/{tools,glyphs,app,mouse-routing,transcript-static,team-session}.test.tsx?}`
plus `node_modules/ink@5.x/build/{components/Box.js, styles.js}` and
`packages/core/package.json`.

**The architecture is right and every load-bearing constraint in §2 checks out.**
C-1 through C-10 were verified individually rather than taken on trust, and all
ten are true as written: the tool array really is built once in the constructor
(`controller.ts:218-280`) with a comment forbidding rebuilds; `tools.test.ts::C7`
really does compare `HOST_TOOL_NAMES` against factory output (`tools.test.ts:186-212`)
and the count really is 14 today; the floor/blocked partition really is asserted
(`tools.test.ts:260-271`); the glyph scanner's `inScope` really is
`ui/ | ^(agent|commands|config|team|tools)/ | cli.tsx` (`glyphs.test.ts:180-183`),
so a new `src/todo/**` tree really would be invisible to it; `computeSettledCount`
really does `break` on `kind === 'team' && e.active` (`Transcript.tsx:60`) and
`normalizeLoadedEntries` really does settle it on load (`persist.ts:76-80`);
`bottomRef` really is the measured box and the rail's middle-band placement is
therefore correct (`AppShell.tsx:105-113`); `ScrollViewport` and `StatusBar`
really are the only two components reading `stdout.columns`
(`ScrollViewport.tsx:60-61`, `StatusBar.tsx:120-121`); `ajv` really is an
`optionalDependencies` entry of core, so C-8's schema discipline is required;
`withPausedWatchdog` really is non-re-entrant (`controller.ts:607-619`); and the
system prompt really is spliced conditionally (`system-prompt.ts:112-115`).

Two things deserve saying before the findings, because they are the reason this
review is short on architecture and long on wiring:

1. **D-10 is correct and was checked case by case.** Suppressing only
   `tool_call_start` is sufficient: `toolCallDelta` / `toolCallEnd` /
   `toolExecStart` / `toolExecEnd` each resolve through `findToolEntryId` and each
   early-returns on `undefined` (`reducer.ts:461-513`). There is no fifth handler.
2. **The rail's layout primitive already ships.** `ScrollViewport` is *already* a
   `flexDirection="row"` band containing a growing column plus a fixed-width
   right-hand strip (`ScrollViewport.tsx:129-148` with
   `ScrollIndicator.tsx:57`'s `width={1} flexShrink={0}`), and it measures its
   own clip box correctly inside that row today. §3.9's `AppShell` change is the
   same shape one level up, and Ink's `alignItems` is unset so yoga's `stretch`
   default gives the inner column full height. Feasibility of the headline UI
   element is therefore not in question.

The findings are of three kinds: two places where a supported user action
silently destroys the feature because the change plan is missing a file
(**P0**); a set of seams where a correct-looking implementation does the wrong
thing with no error (**P1**); and a set of statements that are true but scoped
more narrowly than the document claims (**P2**).

### P0

**P0-1 · §7.2 omits `src/config/store.ts`, and the omission silently unregisters
the tool.** The `todo` section is the fifth nested object in `PersistedConfig`,
and *both* of that file's hand-written merges have to learn about it. They do
not merge sections generically: `loadPersistedConfig` spreads the raw file over
`DEFAULT_CONFIG` and then re-merges `apiKeys` / `skills` / `log` / `team`
one at a time (`store.ts:133-151`), and `updatePersistedConfig` does the same on
the write path (`store.ts:180-199`). Without two new lines there:

- `/todo panel off` sends `{ todo: { panel: false } }`, the shallow top-level
  spread **replaces the whole section**, and `enabled` is written to disk as
  absent;
- on the next launch `loadPersistedConfig` spreads that file over the defaults,
  `config.todo.enabled` is `undefined`, `todoRegistered` is false — and
  `todo_write` is **not registered at all** because the user turned a *panel*
  off. No crash, no log line, no notice.

This is the exact failure the file's own header describes for `skills` ("the
user's symptom would be that disabling one skill quietly makes every previously
trusted project folder prompt again, with nothing anywhere explaining why") and
that its `log` line records for `redactSecrets`. It has now bitten three
sections; a fourth omission is not a new risk, it is a known one. **Fixed in
§7.2 (the file is added to the change plan, with the two call sites named), §4.2
(the one-level-deep rule is restated as a precondition of that merge) and §8.2
(AC-35).**

**P0-2 · `/resume` leaves the previous conversation's plan on screen, and §3.13
names the wrong file.** `/save` and `/resume` are slash commands
(`commands/builtins.ts:319-358`), not `App` code: `/resume` calls
`controller.replaceMessages(session.messages)` and dispatches `restoreEntries`.
§3.13 says "`App` calls `controller.restoreTodos(parsed.todos ?? [])`", which is
a call site that does not exist, and §7.2's `commands/builtins.ts` row lists only
`/todo`. Two consequences, and the second is worse than the first:

- `saveSession(filePath, data)` takes `{ model, messages, entries }`
  (`persist.ts:45-59`). Adding `todos?` to the `SavedSession` *type* without
  extending that parameter and its one call site means `/save` never writes the
  field, and AC-33 fails with a message about a missing key.
- `replaceMessages` discards the conversation the list belonged to. If
  `/resume` loads a session with no `todos` and nothing clears the store, the
  rail keeps rendering a plan whose entire justification — "the model still
  believes in it" — has just been deleted. That is **I-2 inverted**: a panel that
  disagrees with the model, which §1.2 calls worse than no panel. No acceptance
  criterion covers it, and nothing raises an error.

`restore()` therefore needs a defined empty case, and it must be "clear", not
"no-op". **Fixed in §3.5 (`restore()` contract), §3.13 (correct call sites and
the `saveSession` signature), §7.2 and §8.2 (AC-36).**

### P1

**P1-1 · `/todo off` must rebuild the system prompt, or the model is told to use
a tool that refuses it.** §4.4 says the verb "flips the live flag and persists"
and stops there. The precedent it cites does more:
`setTeamEnabled()` is `this.teamEnabled = enabled; this.rebuildSystemPrompt();`
(`controller.ts:648-651`), and `composeSystemPrompt()` gates `teamBlock` on
`teamRegistered && teamEnabled` (`controller.ts:366-372`) precisely so the prompt
never advertises a capability the session does not have. Without the rebuild,
`<todo_planning>` stays in the prompt after `/todo off` and every call comes back
`TODO_OFF_REFUSAL` — a refusal loop the model cannot diagnose, because the
instructions it is following are still in its own context. **Fixed in §3.6a,
§4.4 and §8.2 (AC-37).**

**P1-2 · `/todo panel off` has no runtime path.** §4.4 says it "flips
`cfg.todo.panel`, persists, takes effect on the next frame", and §7.2 gives the
controller `setTodoEnabled` but no config mutator. `App` reads
`const cfg = controller.getConfig()` on every render (`App.tsx:203`), and
`getConfig()` returns the controller's own `this.config`, which `persistConfig`
does not touch — it only writes the file (`App.tsx:555-568`). `/team max` shows
the required shape: it calls **both** `controller.setTeamConfig(...)` (runtime)
and `ctx.persistConfig(...)` (file) (`builtins.ts:239-253`). Without the first
call, `/todo panel off` does nothing until the next launch while reporting
success. **Fixed in §3.6a (`setTodoConfig`), §4.4 and §8.2 (AC-38).**

**P1-3 · The rail's row budget is never derived, and the one composition §3.11
calls "the intended composition" is the one that breaks it.** §3.9 uses
`viewportBudget` only as a mount gate and §3.10 takes `maxRows` as a given;
nothing anywhere says what that number is. It cannot be `viewportBudget`:
`viewportRows()` subtracts the *static* chrome only (`budget.ts:35-59`) and the
team roster is mounted inside the measured bottom box, where it costs 1 header
row + up to `TEAM_LIMITS.panelMaxRows` rows + `+N more` + a mail line — up to 8
rows that `viewportBudget` does not know about (`TeamPanel.tsx:187-249`).
`ScrollViewport` is immune because it measures itself; the rail, as specified,
does not measure and would over-request. Ink clips the overflow from the bottom,
so the first casualty is the `+N more` footer — the one row whose absence is
indistinguishable from "the list is short". And the case that triggers it is
exactly §3.11's `▸ 3 Researching the four call sites` above a five-child roster.
**Fixed in §3.9 (`todoRailRows()`), §4.2 (`railReservedRows`) and §8.2 (AC-39).**

**P1-4 · The rail must set `flexShrink={0}`, or `todoRailWidth()` is advisory.**
Ink's `Box.defaultProps` is `{ flexWrap:'nowrap', flexDirection:'row',
flexGrow:0, flexShrink:1 }` (`ink/build/components/Box.js:13-18`). A `width={n}`
box inside a shrinking row therefore *shrinks* under pressure, and every piece of
arithmetic in §3.9 — R-e's entire answer, AC-20, AC-21, I-7 — becomes a
suggestion yoga is free to overrule at exactly the narrow widths where the
guarantee matters. The codebase already spells the correct pair one level down
(`ScrollIndicator.tsx:57`: `flexShrink={0} width={1}`). A spec that claims to
leave "no further judgement calls" has to say this. **Fixed in §3.9 and §8.2
(AC-40).**

**P1-5 · A required `subscribeTodos` breaks a test the plan never mentions, and
TypeScript will not catch it.** There are **two** hand-written `FakeController`s
that render `<App>`: `app.test.tsx:125` and `mouse-routing.test.tsx:400`. Both
are handed over as `fc as unknown as AgentController`
(`app.test.tsx:238`, `mouse-routing.test.tsx:459` and `:596`), so a missing
member is not a compile error — it is `controller.subscribeTodos is not a
function` at mount, in a wheel-routing suite that has nothing to do with todos.
§8.1 lists `app.test.tsx` and not the other. **Fixed in §8.1 and §8.2 (AC-43).**

**P1-6 · The prompt block asserts a panel that four supported paths do not
have.** "The user sees this list in a panel beside the conversation, so it is the
only place they can watch a long task progress" is false under `-p` (§3.12),
in inline mode (non-goal 4), under `--no-todo-panel` (§4.3), and below 80 columns
or 6 viewport rows (§6.4) — and in the first three of those it is false for the
whole session, decided before the prompt is composed. This is the same error
`composeSystemPrompt` already guards against for team mode with its
*two* flags (`controller.ts:366-372`, whose comment is "advertising in either
case would describe a capability the model does not have"). The fix is not to
drop the block — the planning discipline is worth having with no panel, which is
why `enabled` and `panel` are separate keys — but to vary one sentence.
**Fixed in §3.7 (`buildTodoBlock({ panelVisible })`) and §8.2 (AC-42).**

**P1-7 · A partially-completed list is immortal.** §3.2 clears at
`beginUserTurn()` only when every item is `completed`; §1.2 and D-6 argue
correctly that a partial list must survive "continue" / "now do the rest". But
there is no upper bound anywhere. Plan seven steps, finish three, then change the
subject: the rail holds a fifth of the terminal, for the rest of the session,
showing a plan nobody is working on, and the only exit is a slash command the
user has to know exists. The spec's own R-g ("no furniture when idle") and §6.4's
"no list → no rail, zero layout cost" both point at a bound that §3.5 never
supplies. **Fixed in §3.2, §3.5 and §4.2 (`TODO_LIMITS.staleTurns`), plus §8.2
(AC-41).**

**P1-8 · `--no-todo-panel` has no positive counterpart, which is the defect this
repo has already shipped twice.** `commander` materializes a lone `--no-x` as
`opts.x = true` when the flag is absent, so `true` is indistinguishable from
silence and a config-file `panel: false` would be overwritten by a user who
passed no flag at all. §4.3 declares `--todo` / `--no-todo` as a pair (correctly
— that is the `--team` / `--no-team` lesson, `cli.tsx:749-750`) and then declares
`--no-todo-panel` alone. `load.ts` records the rule explicitly at lines 172-176:
a truthiness test cannot tell `--no-team` from "not passed", and `--no-skills`
only gets away with a one-directional test because nothing needs to distinguish
`--skills` from silence. `panel` is a persisted setting, so it does. **Fixed in
§4.3 (one-directional resolution, spelled out) and §8.2 (AC-44).**

### P2

**P2-1 · C-5 and R-4 are true, but only in inline mode.** `<Static>` is used by
`Transcript` (inline) and *not* by `TranscriptList` (full-screen), whose header
says so and explains why `computeSettledCount` is deliberately not called there
(`Transcript.tsx:198-215`). Since the rail is full-screen-only, R-4's "single
highest-severity failure mode in the feature" cannot occur in the mode the
feature is designed for. Both mitigations remain necessary — inline sessions save
and resume too — but the severity ranking will mislead whoever schedules the
work. **Scope noted in §3.8 and §9 (R-4).**

**P2-2 · `-p` prints each `todo_write` twice.** `runHeadless` writes
`▸ <toolName>` on `tool_execution_start` and a duration on
`tool_execution_end` for every tool (`headless.ts:73-80`), so a 7-step task adds
~14 lines of `▸ todo_write (1ms)` around the `[todo]` lines §3.12 designs. Not
wrong, but the stderr transcript §3.12 shows is not the one a user will see.
**Noted in §3.12.**

**P2-3 · The rail is 16-34 columns wide and the model writes in the user's
language.** The system prompt ends with "Respond in the language the user writes
in" (`system-prompt.ts:127`), so CJK item text in an 18-column rail is the normal
case, not the edge case. Ink's `wrap="truncate"` is display-width aware, so
nothing overflows; but no arithmetic in `TodoPanel` may be denominated in code
units for user text — the lesson `TeamPanel`'s `WIDE_CHAR_ALLOWANCE` records at
length (`TeamPanel.tsx:64-91`). **Noted in §6.1.**

**P2-4 · `TodoSnapshot.updatedAt` needs an injectable clock,** or
`todo-panel.test.tsx` depends on wall time. `TeamPanel` takes `now?` for exactly
this (`TeamPanel.tsx:44-45`). **Noted in §5.1.**

**P2-5 · A wheel notch over the rail scrolls the transcript.** `hitTestWheel`
routes by ROW and the rail shares the transcript's rows, which is the right
behaviour for a non-scrolling column — but it is a behaviour, and §3.10's "the
rail never scrolls" reads as though the question had not come up. **Noted in
§3.10.**

**P2-6 · A resumed mid-run card should say it was interrupted.**
`normalizeLoadedEntries` sets `active: false` **and** `aborted: true` for a team
entry, because the children died with the process (`persist.ts:76-80`). A todo
card forced to `live: false` still reads `2/7` with no indication that the run
behind it ended. **Noted in §3.8.**

**P2-7 · `/todo continue` during a run steers rather than submits.**
`ctx.submit` is `submitMessage`, which routes to `controller.steer()` when the
status is `running` (`App.tsx:641-646`). §4.4 refuses the verb when nothing is
unfinished but says nothing about a live run, where "Continue with the remaining
todo items." arrives as a mid-turn interjection into the run that is already
doing exactly that. **Noted in §4.4.**

**P2-8 · Count drift.** §0.1's R-h row said "32 acceptance criteria" while §8.2
listed 34 and §13 asserted 34. **Corrected, and both now say 44.**

---

## 0.1 需求映射 (Requirement trace)

| # | Requirement (verbatim intent) | Where it is answered |
|---|---|---|
| R-a | 复杂任务先规划 TODO 执行计划 | §3.3 `todo_write`, §3.7 prompt block (the 3-step threshold), §4.5 |
| R-b | 按照 TODO 计划一个一个执行 | §3.4 exactly-one-`in_progress` repair, §3.3 tool-result wording, §3.10 |
| R-c | 简单任务直接执行，不规划 | §3.7 the "do not use it for" clause, §3.3 the `< 2` fresh-list refusal, §6.4 (no list ⇒ no rail, zero layout cost) |
| R-d | TODO 计划显示在 TUI 最右边 | §3.9 `AppShell` right rail, §6.1 |
| R-e | 占用 20% 的宽度即可 | §3.9 `todoRailWidth(cols)` — exactly `round(cols * 0.2)`, clamped `[18, 36]`, `0` below 80 columns |
| R-f | 和 Anthropic 的 Claude Code 类似 | §3.3 tool named `todo_write` with a full-replacement payload and `content` / `activeForm` / `status` — the same shape a model already has priors for (the argument `team/task-tool.ts` records for mirroring `Task`) |
| R-g | 美观、优雅、顶级设计，符合人机交互最佳实践 | §6.1 (present-continuous active row, wrap budget spent on the current step, calm colour, no furniture when idle), §6.4 degradation matrix |
| R-h | 稳健、可靠、顶级 | §3.4 repair-never-reject, §3.5 no-I/O store, §3.13 resume, §8.2 44 acceptance criteria, §9 risks |

---

## 1. Overview

### 1.1 What is being built

Three things, in one feature, none of which exists today.

**A tool.** `todo_write` is a new host tool registered alongside the seven
built-ins. Its parameter is the **complete** todo list — every item, every time —
and calling it is the only way the list ever changes. There are no incremental
operations (`add`, `complete`, `reorder`), because a delta protocol lets the
model's belief and the rendered panel drift apart with nothing anywhere able to
notice; a full replacement is idempotent, order-free, and self-healing. The
call is pure state: no filesystem, no network, no child process, no human wait.

**A store and its event stream.** `TodoStore` (`src/todo/store.ts`) holds the
current list for the session, normalizes every write, and emits a CLI-local
`TodoEvent`. `AgentController` owns it exactly as it owns `TeamRuntime`, and
exposes `subscribeTodos()` / `getTodoSnapshot()` / `clearTodos()`. Like
`TeamEvent`, `TodoEvent` is **not** a member of core's `AgentEvent` union: core
freezes its runtime export list (`public-api.test.ts`) and forbids host coupling
(`no-host-coupling.test.ts`), so a new event member would break the first and
teach core about a host shape it has no business defining.

**A right rail.** In full-screen mode the middle region of `AppShell` becomes a
row: the transcript viewport on the left, and — whenever a list exists — a
fixed-width panel on the right occupying 20% of the terminal. It renders the
checklist with one marker per state, spends its wrapping budget on the item
currently in progress, and windows around that item when the list is longer than
the available rows. When there is no list it is not mounted at all, so a session
that never plans has byte-identical layout to today.

The user-visible loop is then: ask for something substantial → the agent writes
a plan into the rail → each step lights up as it is worked, ticks off when it is
done, and the next one lights up → the rail empties itself on the next request.
Ask for something small and nothing appears.

### 1.2 Why this shape

The single most important decision is that **the list is a projection of what
the model believes, and nothing that does not tell the model may change it**
(invariant I-2). Every other decision falls out of it:

- `/clear` wipes the transcript but not the conversation. It nonetheless **does**
  clear the list, because an explicit user instruction is this invariant's
  standing exception (reason `'user'`, the same door `/todo clear` uses): the
  rail is on the screen the user just asked to be cleared. What is left is
  "panel absent, model still remembers", the direction I-9 calls safe, and the
  model's next full-replacement write heals it.
  *(Revised by `docs/diagnoses/slash-clear-leaves-todo-panel/analysis.md`; the
  original rule kept the list and left it stranded on a cleared screen.)*
- `/reset` clears `messages`, so the model's belief is gone with them, and the
  list goes too. Same call site, same line.
- `/save` must persist the list, because `/resume` restores `messages` — the
  belief comes back and the panel has to come back with it.
- `/todo clear` is a user override of a projection, so it is refused while a run
  is in flight (§4.4): between turns the model's next `todo_write` is a full
  replacement anyway, which bounds the disagreement window to zero.

The second decision is that **the panel is not a second scroll model**. Ink has
no absolute positioning and this codebase already owns one hand-rolled viewport
(`ScrollViewport`) whose invariants took a whole spec to pin down. A second
scrollable region with its own offset, its own intent nonce and its own wheel
band would be the largest source of new bugs in this feature by a wide margin.
The rail therefore never scrolls: `selectTodoRows()` is a pure function that
windows the list around the active item and reports `+N above` / `+N below`,
exactly as `team/panel-rows.ts::selectPanelRows` already does for the roster.

The third is that **structure enforces what a prompt can only ask for**.
"One item at a time" is not left to the model's discipline: `normalizeTodos()`
repairs any payload with two `in_progress` items down to one, and promotes the
first unfinished item when there are none. The panel therefore always has
exactly one current row, whatever the model sends, and the property is provable
by a unit test rather than by inspection of a transcript.

### 1.3 Non-goals (v1)

1. **No auto-continue.** A run that ends with unfinished items produces a notice
   and a one-keystroke affordance (`/todo continue`), not an automatic new
   prompt. Auto-continuation is an unbounded cost loop wearing a helpful hat.
2. **No user editing of items.** The rail is read-only. Editing an item would
   put the user and the model in a write conflict over one array with no merge
   rule, and the user already has the strongest possible editor: the next
   message.
3. **No nested / hierarchical todos.** One flat list, `TODO_LIMITS.maxItems`
   long. Sub-steps belong in the step's own text.
4. **No inline-mode rail.** Inline mode has no fixed frame and its output is a
   document flow; a side column there would fight the terminal's own scrollback.
   The transcript card (§6.2) and `/todo status` cover it.
5. **No per-subagent lists.** Children do not get the tool (§3.11).
6. **No persistence outside the session file.** The list does not survive a
   process exit unless the user `/save`d.

---

## 2. Constraints inherited from the shipped code

These are load-bearing facts about the current tree. Violating any of them
produces a failure that is silent, which is why they are enumerated before the
design rather than discovered during it.

**C-1 · The tool array is immutable for the life of a session.**
`AgentController`'s constructor builds `this.tools` once and its own comment
forbids rebuilding: `Agent.setTools()` mutates the live `ToolRegistry`, and
`submit_plan` flips the session mode from *inside* a tool execution. `todo_write`
therefore must be registered at construction and gated by a closure, never
added or removed later. `/todo off` flips a flag; it cannot unregister.

**C-2 · `tools.test.ts::C7` asserts that `HOST_TOOL_NAMES` equals exactly what
`createBuiltinTools()` produces.** Appending `todo_write` in the controller
after the factory returned turns C7 red with a message about two lists of names
that says nothing about todos. It goes through the factory via a new
`todoTools?: AgentTool[]` option — the shape `planTools` / `teamTools` already
established (D-15 of team-subagents).

**C-3 · `SKILL_TOOL_FLOOR` and `PLAN_MODE_BLOCKED_TOOLS` must partition
`HOST_TOOL_NAMES`,** and a test asserts it. Every new tool name must be
consciously placed in one of the two. `todo_write` joins the **floor** (§3.11).

**C-4 · `glyphs.test.ts` scans a fixed list of directories** — `ui/`,
`agent|commands|config|team|tools/`, and `cli.tsx` — for non-ASCII literals. A
new `src/todo/**` tree is **invisible to that scan** until its `inScope` regex
is extended. This is precisely the I-6 hole the team feature had to close for
`team/`, and the failure mode is a guard rail that silently stops guarding.

**C-5 · `computeSettledCount()` (`ui/Transcript.tsx`) is monotonic and
`<Static>` cannot un-print.** An entry that is rewritten after it has been
promoted to `<Static>` duplicates on screen; an entry that never settles is
re-rendered on every frame for the rest of the session. The `kind: 'team'` entry
solves this with an `active` flag that the load path (`normalizeLoadedEntries`)
forces false. The todo entry (§3.8) is rewritten in place for a whole turn and
needs **the same treatment, including the load-path normalization** — a session
saved mid-run otherwise resumes with an entry that can never settle.

**C-6 · `AppShell`'s measured bottom box is the wheel router's contract.**
`geometryRef.current.bottom` is measured from `bottomRef`, and `hitTestWheel()`
routes a wheel notch by terminal ROW. The rail is a COLUMN and must be mounted
in the middle region, never inside `bottomRef` — a rail in the bottom box would
inflate the measured composer band and start routing transcript scrolls into
prompt history.

**C-7 · Only one component inside the viewport subtree reads
`stdout.columns` directly:** `ScrollViewport` (its terse-hint threshold and its
`MIN_INDICATOR_COLS` gate). `StatusBar` also reads it, but the status bar spans
the full frame width and is therefore correct as-is. Everything else that needs
a width takes it as a prop from `App`. §3.9 defines `contentCols` and lists
every call site that must switch to it.

**C-8 · Schemas declare shape, not policy** (`tools/plan-tools.ts` header).
`ajv` is an OPTIONAL dependency of core: with it present `ToolExecutor` rejects
a payload that violates `maxItems`/`enum`; without it the same payload sails
through to the repair path. One design, two behaviours, selected by whether an
optional install step succeeded. So `todo_write`'s schema carries `type`,
`required` and `default` only; every bound lives in the `description` (which is
what the model reads) and is enforced by `normalizeTodos()`.

**C-9 · `IdleWatchdog.pause()` is a boolean, not a counter.** `todo_write`
returns synchronously and must **not** be routed through `withPausedWatchdog` —
a nested pause/resume around an instant call would re-arm the watchdog inside an
outer human wait.

**C-10 · The system prompt is spliced conditionally** so that every "feature
off" path stays byte-identical (invariants I-S1 / I-P1 / I-8). `todoBlock`
follows the identical pattern, and AC-30 pins it.

---

## 3. Technical design

### 3.1 Module map

```
packages/cli/src/
  todo/                          # NEW TREE - add to glyphs.test.ts inScope (C-4)
    limits.ts                    # TODO_LIMITS + TODO_BLOCK_VERSION. ASCII only.
    types.ts                     # TodoItem / TodoSnapshot / TodoEvent. ASCII only.
    normalize.ts                 # normalizeTodos() - repair, never reject
    store.ts                     # TodoStore: state + event stream, zero I/O
    todo-tool.ts                 # createTodoTool() - the only writer
    prompt.ts                    # buildTodoBlock() - when to plan, when not to
    panel-rows.ts                # selectTodoRows() - pure windowing
  ui/
    TodoPanel.tsx                # the right rail
    entries/TodoCard.tsx         # the transcript checklist card
    layout/rail.ts               # todoRailWidth() + the four constants
```

Dependency direction: `todo/*` imports from `@aragon-agent/core` (tool types
only) and from itself. `ui/*` and `agent/*` import from `todo/*`. Nothing in
`todo/*` imports from `ui/*` — the store has no terminal, and the panel owns
every width decision (the same split `SubagentRun.activity` documents).

### 3.2 The lifecycle of one list

```
  user prompt
      |
      | AgentController.prompt()
      |   skills.beginUserTurn()      <- existing
      |   askRounds = 0               <- existing
      |   todos.beginUserTurn()       <- NEW: archives a fully-completed list
      v
  model decides: 3+ distinct steps?
      |                    \
      | yes                  \ no  -> works directly, never calls the tool,
      v                       \      rail is never mounted (R-c)
  todo_write([...all pending, first in_progress])
      |
      |  TodoStore.write() -> normalize -> emit {type:'updated'}
      |     App: dispatch todoUpdate  -> ViewState.todos  -> TodoPanel
      |                               -> ViewState entry (kind:'todo') -> TodoCard
      |     tool result: "0/7 done. In progress: <activeForm>. Call again when done."
      v
  ... work ... todo_write(...) ... work ... todo_write(...) ...
      |
      v
  agent_end
      |  App: entry.live = false      (C-5: the card may now reach <Static>)
      |  App: if unfinished items remain -> notice + /todo continue affordance
      v
  next user prompt
      |  beginUserTurn(): every item completed?     -> clear {reason:'turn'}
      |                   stale for staleTurns?     -> clear {reason:'stale'}
      |                   otherwise                 -> keep (a follow-up continues it)
      v
```

Three rules in that diagram carry the whole "does the panel feel alive or does it
feel like litter" question, and all three are deliberate:

- **A fully-completed list is dropped at the START of the next turn, not at the
  end of the run that completed it.** Ending the run is exactly when the user
  wants to see `7/7 done`; wiping it there would replace a moment of feedback
  with a blank column.
- **A partially-completed list survives the turn boundary.** "continue", "now do
  the rest", "what about step 4" are the most common follow-ups in the world,
  and destroying the plan on the way into them is unforgivable.
- **…but not forever (P1-7).** `beginUserTurn()` counts the consecutive user
  turns in which no `todo_write` arrived and clears an unfinished list once that
  count exceeds `TODO_LIMITS.staleTurns` (3). Without a bound, a plan abandoned
  mid-way holds a fifth of the terminal for the rest of the session, showing work
  nobody is doing — which is the same "furniture when idle" R-g rules out and
  §6.4 spends a whole row of its matrix avoiding. Three turns is chosen so the
  common interruption sequence (*"wait, explain X"* → *"and Y?"* → *"ok,
  continue"*) never loses the panel; the fourth unrelated turn does.

  This is a bounded, one-directional retreat from I-2 rather than a hole in it.
  Clearing the panel does not clear the model's belief — the tool results are
  still in `messages` — so the two disagree from the moment of the clear until
  the model's next write. That write is a FULL REPLACEMENT, so it re-materializes
  the list exactly (`restore`-free, no merge, no id matching), which bounds the
  disagreement to "the panel is absent while the model still knows the plan".
  That is the safe direction: §1.2's objection is to a panel that *contradicts*
  the model, not to a panel that is not there. `/todo clear` (§4.4) is refused
  mid-run for the same reason and buys the same bound.

### 3.3 `todo_write` — the only writer

```ts
// src/todo/todo-tool.ts
export interface TodoToolDeps {
  store: TodoStore;
  /** Read LIVE, never cached: `/todo off` flips this; it cannot unregister (C-1). */
  isEnabled: () => boolean;
}
```

Execution order, and each step's reason:

1. **Disabled mid-session** → `textResult(TODO_OFF_REFUSAL)`. Non-error: the
   user turned a display off, the model did nothing wrong, and an error result
   invites a retry.
2. **Fresh list shorter than `TODO_LIMITS.minFreshItems` (2)** →
   `textResult(TOO_SMALL_REFUSAL)`: *"A one-step list is not a plan. Just do the
   work and summarize when you are done."* **Gated on `store.isEmpty()`** — this
   is the structural half of R-c. Shrinking an EXISTING list to one item is
   legitimate (the model merged two steps), so the guard must not fire there.
3. **Normalize** (§3.4). Zero survivors is the one hard failure →
   `errorResult('No usable todo items: each needs a non-empty content string.')`.
4. **Commit** `store.write(items)`, which emits `{type:'updated', snapshot}`.
5. **Return a result that names the next action.** This is the single strongest
   lever on R-b, because unlike the system prompt it is re-read on every call:

```
Todos updated. 2/7 done.
In progress: Wiring the rail into AppShell
Next: Add the panel-rows unit test
Call todo_write again the moment that item is finished - exactly one item in
progress at a time, and do not batch several completions into one call.
```

Repairs are appended as `Note:` lines so the model can correct itself:

```
Note: 23 items were sent; the last 3 were dropped (maximum 20).
Note: 2 items were marked in_progress; only the first was kept.
```

There is **no rate limit** on calls. A cap would fire exactly when the model is
being most diligent, and produce a refusal it cannot act on. The costs a cap
would have contained are already gone: §3.8 collapses N calls into ONE transcript
entry, and the store is memory-only.

### 3.4 Normalization: repair, never reject

`normalizeTodos(raw: unknown, max: number): NormalizeResult` is pure,
synchronous, never throws, and is the only path into the store — including the
session-resume path (§3.13), because a file on disk is untrusted input.

```ts
export interface NormalizeResult {
  items: TodoItem[];
  /** How many entries the payload contained BEFORE the cap - the "n of m" note. */
  requested: number;
  /** Human-readable repair notes, already bounded. Empty when nothing was wrong. */
  repairs: string[];
}
```

Rules, in order:

| Input | Repair |
|---|---|
| `raw` is not an array | `items: []` (the one hard failure, handled by the caller) |
| entry is not an object, or `content` is missing / not a string / empty after trim | drop that entry |
| `content` longer than `TODO_LIMITS.contentChars` | clamp, no ellipsis (the panel adds one at render) |
| `activeForm` missing or empty | fall back to `content` |
| `activeForm` longer than `TODO_LIMITS.activeFormChars` | clamp |
| `status` not one of the three | `'pending'` |
| more than `max` entries | keep the first `max`, record a repair note |
| **more than one `in_progress`** | keep the first; demote the rest to `pending` |
| **zero `in_progress` while at least one item is not `completed`** | promote the first non-completed item |

Two notes on the last two rules. They are what makes "one at a time" a property
of the state rather than a request (R-b), and they are also why the panel can
render an unconditional "current step" without a null branch. And the promotion
rule deliberately fires on the **initial all-pending write** — a model that
writes its plan and then starts step 1 is doing the right thing, and the panel
should say so on the first frame rather than one tool call later.

Whitespace: `content` and `activeForm` are collapsed (`\s+` → single space) and
trimmed before clamping. A newline inside a rail row would break the layout, and
sanitizing at STORE rather than at render means the transcript card, the
headless writer and `/todo status` all get the same guarantee for free (the
argument `sanitizeActivity` records).

### 3.5 The store and its event stream

```ts
export class TodoStore {
  snapshot(): TodoSnapshot | null;      // null = no list; the rail is unmounted
  isEmpty(): boolean;
  write(raw: unknown): NormalizeResult; // normalizes, commits, emits; resets the stale counter
  /**
   * `/resume`. Runs through `normalizeTodos` — a session file is user-editable
   * input and gets a model payload's treatment.
   *
   * AN EMPTY (or all-dropped) ARRAY CLEARS, IT DOES NOT NO-OP (P0-2). `/resume`
   * has just called `replaceMessages`, so the conversation the current list
   * belonged to is gone; leaving it on screen is I-2 inverted — a panel that
   * disagrees with the model, which §1.2 calls worse than no panel. Emits
   * `{type:'cleared', reason:'reset'}` in that case and `{type:'updated'}`
   * otherwise, so the panel and the transcript card come back (or go away)
   * through exactly one code path either way.
   */
  restore(items: unknown): void;
  clear(reason: TodoClearReason): void;
  /**
   * Clears IFF every item is `completed`, OR the list has gone unwritten for
   * more than `TODO_LIMITS.staleTurns` consecutive turns (§3.2 / P1-7).
   * Increments the stale counter on every call; `write()` resets it to 0.
   */
  beginUserTurn(): void;
  subscribe(listener: TodoEventListener): () => void;
}
```

`TodoStore` performs **no I/O of any kind** and holds no timers. It cannot fail,
which is what lets `todo_write` be the one tool in the array with no error path
beyond a malformed payload (R-h). Listener errors are caught and swallowed per
listener so one bad subscriber cannot take down a tool call.

`beginUserTurn()` is called from `AgentController.prompt()` **and not from
`steer()`** — the same asymmetry, for the same reason, that `askRounds = 0`
already has: a steer is a mid-turn interjection, not a new task. The stale
counter inherits that asymmetry for free, which is the behaviour you want: a
steer must not age out the plan it is steering.

### 3.6 How the tool reaches the tool array

```ts
// tools/index.ts — new option, placed beside planTools / teamTools
  /**
   * `todo_write`, appended verbatim. An empty array leaves the tool list
   * byte-identical to the pre-todo build, provable by object identity exactly
   * as `--no-skills` and `--no-team` are (AC-31).
   */
  todoTools?: AgentTool[];
```

Splice point: **after `planTools`, before `teamTools`**, so a lead's `task`
tool stays last and the existing `HOST_TOOL_NAMES` order changes by one
insertion rather than a reshuffle. `HOST_TOOL_NAMES` gains `'todo_write'` in the
same position, and `tools.test.ts::C7`'s expected count moves 14 → 15.

`SKILL_TOOL_FLOOR` gains `'todo_write'`. The floor's stated membership rule is
"everything that cannot write to disk", and a todo list is a display; more
concretely, a skill whose `allowed-tools` omits `todo_write` would otherwise make
the planning UI unreachable inside that skill's frame — the identical dead end
that put `ask_user` / `submit_plan` / `task` on the floor. `PLAN_MODE_BLOCKED_TOOLS`
is unchanged, which keeps the partition test true by construction.

### 3.6a The controller surface, and why two of these are not optional

```ts
// AgentController — the full todo surface
isTodoRegistered(): boolean;          // fixed at construction (C-1)
isTodoEnabled(): boolean;             // flipped live by /todo on|off
setTodoEnabled(enabled: boolean): void;
getTodoConfig(): TodoConfig;
setTodoConfig(patch: Partial<TodoConfig>): TodoConfig;
getTodoSnapshot(): TodoSnapshot | null;
subscribeTodos(listener: TodoEventListener): () => void;   // no-op unsub when unregistered
restoreTodos(items: unknown): void;
clearTodos(): void;
```

Two of these carry a correctness argument rather than a convenience one.

**`setTodoEnabled` MUST call `rebuildSystemPrompt()` (P1-1).** The precedent is
literal: `setTeamEnabled` is two lines, `this.teamEnabled = enabled;
this.rebuildSystemPrompt();`, and `composeSystemPrompt()` gates `teamBlock` on
`teamRegistered && teamEnabled` for the reason its own comment gives —
"advertising in either case would describe a capability the model does not have".
`todoBlock` is gated the same way, on `todoRegistered && todoEnabled`. Flip the
flag without the rebuild and `<todo_planning>` survives `/todo off`: every call
returns `TODO_OFF_REFUSAL`, and the instructions telling the model to keep
calling are still in its own context, so it cannot diagnose the loop.
`rebuildSystemPrompt()` is a live path (unlike the tool array), so this costs
nothing beyond the call.

**`setTodoConfig` exists because `persistConfig` does not touch the runtime
(P1-2).** `App` reads `controller.getConfig()` on every render, and that returns
the controller's own `this.config`; the App's `persistConfig` only writes the
file. `/team max` therefore calls BOTH `controller.setTeamConfig(...)` and
`ctx.persistConfig(...)`, and `/todo panel on|off` must do the same. With only
the persist call the command reports success and changes nothing until the next
launch. `setTodoConfig` clamps through `clampTodoConfig` before adopting, so a
bad value can reach neither the runtime nor the file — the same double gate
`setTeamConfig` documents.

### 3.7 Prompt block: when to plan and when not to

`buildTodoBlock({ panelVisible })` returns the block below; `buildSystemPrompt()`
splices it conditionally (`...(todoBlock ? ['', todoBlock] : [])`) exactly as it
splices `teamBlock`.

```
<todo_planning>
For work that takes three or more distinct steps, keep a visible plan with the
todo_write tool. {{VISIBILITY}}

Use it when:
- the request has three or more steps that must happen in order;
- the user gave you several things to do in one message;
- you are part-way through a long task and the user asks what is left.

Do NOT use it for:
- anything you can finish in one or two steps - just do it and say what you did;
- a question, an explanation, or a search with no work attached;
- restating a step you are already in the middle of.

How to use it:
- Send the COMPLETE list every time. The tool replaces the whole list; it has no
  add or update operation.
- Exactly one item is in_progress at a time. Mark an item completed the moment
  it is done and mark the next one in_progress in the SAME call.
- Do not batch. Finishing three steps and reporting them together hides where you
  are RIGHT NOW, which is the whole point of keeping the list.
- Give each item a content ("Add the rail to AppShell") and an activeForm
  ("Adding the rail to AppShell"). The list shows activeForm for the step in
  progress and content for the rest.
- Only mark an item completed when it is really finished. If you hit a blocker,
  leave it in_progress, add an item describing what is blocking, and say so.
</todo_planning>
```

`{{VISIBILITY}}` is exactly one of two sentences, chosen by `panelVisible`
(P1-6). **It is the only sentence in the block that mentions a display at all**
— the rest was rewritten in v2 to talk about "the list" rather than "the panel",
which is what makes AC-42's "the two variants differ in exactly one sentence"
checkable instead of approximate:

| `panelVisible` | Sentence |
|---|---|
| `true` | `The user sees this list in a panel beside the conversation, so it is the only place they can watch a long task progress.` |
| `false` | `The user cannot see this list in this session, but keeping it is still how you stay on one step at a time and report what is left.` |

**A block that claims a panel the session does not have is the error
`composeSystemPrompt` already guards against for team mode with its two flags.**
Four supported paths have the tool and no rail — `-p` (§3.12), inline mode
(non-goal 4), `--no-todo-panel` (§4.3), and a terminal under 80 columns or 6
viewport rows (§6.4) — and in the first three the answer is fixed for the whole
session, before the prompt is composed. The right fix is one sentence, not
dropping the block: `enabled` and `panel` are separate keys precisely because
the planning discipline is worth having without the column (§4.2), and a
screen-reader user is the case that argument was written for.

`panelVisible` is therefore resolved at COMPOSE time as
`cfg.todo.panel && interactive && fullscreen`, where `interactive` is the flag
`makeController` already threads for the approval gate and `fullscreen` is
`decideRenderMode(...) === 'fullscreen'`. The two dynamic causes (a resize below
`TODO_RAIL_MIN_TOTAL_COLS`, an overlay) deliberately do NOT re-compose the
prompt: `rebuildSystemPrompt()` on every resize would rewrite the system prompt
mid-run, which §3.9 of the plan-mode spec rules out for its own block, and the
sentence is guidance rather than a contract.

The block's threshold (**3+ steps**) is deliberately STRICTER than the
structural guard (**refuse a fresh list under 2**, §3.3). A backstop that is
looser than the guidance never argues with a judgement call the model made on
purpose — a 2-step list for two genuinely separate deliverables is fine, and the
prompt simply does not encourage it.

### 3.8 Transcript rendering: one card per turn

Every tool call today produces a `kind: 'tool'` entry. A 7-item list updated
twice per item is 14 cards of near-identical noise, which is a real cost to the
one surface the user reads most.

The answer is **one `kind: 'todo'` entry per user turn, rewritten in place** —
the mechanism `kind: 'team'` already uses. It is reached in two moves:

**(a) Suppress the generic card, in one named line.** In `reduceEvent`:

```ts
/**
 * Tools that render their own transcript entry, so the generic tool card would
 * be a duplicate. EXACTLY ONE MEMBER; read §3.8 before adding a second.
 *
 * Suppressing ONLY `tool_call_start` is sufficient and is the whole reason this
 * is safe: every later handler (`toolCallDelta` / `toolCallEnd` /
 * `toolExecStart` / `toolExecEnd`) resolves its target through
 * `findToolEntryId`, which returns `undefined` when no entry was created, and
 * every one of them already early-returns on that. No second suppression rule
 * is needed, and adding one would be the bug.
 */
const SELF_RENDERING_TOOLS: ReadonlySet<string> = new Set(['todo_write']);
```

**(b) Drive the entry from the store, not from the tool events.** The App's
`subscribeTodos` handler dispatches `{ type: 'todoUpdate', snapshot }`. The
reducer holds `todoEntryId`: present → rewrite that entry; absent → append a new
one. `submit` clears `todoEntryId` (so the next turn gets its own card, in that
turn's position); `runEnd` sets `live: false` on the current card.

A refused write (`{type:'rejected', reason}`) becomes an ordinary
`notice` at `warn` level. That is the compensating path for suppressing the tool
card — without it, the one case where `todo_write` produces nothing visible
would be the case that most needs to be visible.

**C-5 consequences, both mandatory:**

1. `computeSettledCount()` gains `if (e.kind === 'todo' && e.live) break;`.
2. `normalizeLoadedEntries()` (`session/persist.ts`) forces `live: false` on
   every loaded todo entry, exactly as it settles a mid-dispatch team entry, and
   sets `interrupted: true` on it — the todo analogue of the team entry's
   `aborted: true`, and true for the same reason: the run behind the card died
   with the process (P2-6). `TodoCard` renders that as a muted
   `interrupted` suffix beside the counter, so a resumed `2/7` does not read as
   a run still in flight. Without the `live: false` half, a session saved mid-run
   resumes with a card that can never reach `<Static>` and is re-rendered on
   every frame for the rest of the session.

**Which mode C-5 actually protects (P2-1).** `<Static>` is used by `Transcript`
(inline) and NOT by `TranscriptList` (full-screen), whose own header explains
that a frame occupying `rows - 1` lines leaves one visible line above it, so
`<Static>` stops being a history view and becomes a leak — and that
`computeSettledCount` is therefore deliberately not called there. Both fixes
above stay mandatory, because inline sessions save and resume too and the todo
CARD renders in both modes (only the RAIL is full-screen-only). But the failure
they prevent cannot occur in the mode this feature is designed for, and R-4's
severity should be read with that scope attached.

### 3.9 The right rail: layout arithmetic

```ts
// src/ui/layout/rail.ts — pure, React-free, unit-tested (mirrors budget.ts)

/** R-e, literally: the rail asks for a fifth of the terminal. */
const RAIL_FRACTION = 0.2;

/** Below this the marker + a two-word title do not fit and the column is noise. */
export const TODO_RAIL_MIN_COLS = 18;

/**
 * Above this, 20% is being spent on whitespace: at 36 columns a step title
 * already fits on one line, and the transcript is the surface that benefits
 * from a 200-column terminal. A deliberate, revertible deviation from a literal
 * reading of R-e; it only binds above 180 columns.
 */
export const TODO_RAIL_MAX_COLS = 36;

/** Under 80 columns the transcript needs every column; no rail at all. */
export const TODO_RAIL_MIN_TOTAL_COLS = 80;

/** Below this rail width the 2-column index prefix is dropped for content. */
export const TODO_RAIL_INDEX_MIN_COLS = 22;

export function todoRailWidth(cols: number): number {
  if (!Number.isFinite(cols) || cols < TODO_RAIL_MIN_TOTAL_COLS) return 0;
  return Math.min(
    TODO_RAIL_MAX_COLS,
    Math.max(TODO_RAIL_MIN_COLS, Math.round(cols * RAIL_FRACTION)),
  );
}

/**
 * How many rows the rail may actually draw (P1-3).
 *
 * IT IS NOT `viewportBudget`, AND THE DIFFERENCE IS NOT COSMETIC.
 * `viewportRows()` subtracts the STATIC chrome only, and says so; the live team
 * roster is mounted inside `AppShell`'s measured bottom box, where it costs a
 * header row, up to `TEAM_LIMITS.panelMaxRows` child rows, a `+N more` row and a
 * mail row that `viewportBudget` knows nothing about. `ScrollViewport` is immune
 * because it MEASURES itself; the rail does not measure (a second
 * measure -> setState -> measure loop is exactly what §1.2 refuses), so it has to
 * subtract.
 *
 * Ink clips overflow from the BOTTOM, so an over-request does not error, it
 * silently eats the last row — which is the `+N below` marker, the one row whose
 * absence is indistinguishable from "the list is short". That is why this is
 * arithmetic rather than a shrug at `overflow: hidden`.
 */
export function todoRailRows(viewportBudget: number, teamActive: boolean): number {
  const reserved = teamActive ? TODO_LIMITS.railReservedRows : 0;
  return Math.max(0, viewportBudget - reserved);
}
```

Two properties are pinned by tests, for the reason `budget.ts` records about the
viewport being non-monotonic before anyone measured it:

- **Non-decreasing in `cols`** across `[40, 300]`. A user dragging a window
  wider must never see the rail get narrower.
- **`cols - todoRailWidth(cols) >= 62`** for every `cols >= 80`. The transcript's
  own degradation thresholds (`TERSE_HINT_COLS = 42`, the status bar's 60/72
  breakpoints) sit below that floor, so no existing width heuristic changes
  behaviour because a rail appeared.

**`AppShell`** gains one optional prop and one wrapper box in the full-screen
branch only:

```tsx
export interface AppShellProps {
  // ...
  /**
   * The right-hand region of the MIDDLE band (todo-plan-execution §3.9), or
   * nothing.
   *
   * NAMED FOR ITS POSITION, NOT ITS CONTENT: this file is a layout primitive and
   * has no business knowing what a todo is.
   *
   * IT MUST NOT BE RENDERED INSIDE `bottomRef` (C-6). That box is MEASURED and
   * the wheel router reads the composer band boundary from it; a column added
   * there would inflate the measurement and start routing transcript scrolls
   * into prompt history.
   */
  rail?: React.ReactNode;
}
```

```tsx
  // full-screen branch, middle band:
  <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      {viewport}
    </Box>
    {rail}
  </Box>
```

The wrapper is **unconditional**, present whether or not `rail` is. A wrapper
that appeared only when a list existed would change the React tree's SHAPE the
moment the model first called `todo_write`, remounting `ScrollViewport` and
throwing away the scroll offset and the intent nonce it is careful to seed on
mount. Yoga lays a single-child row out identically to the column it replaces, so
AC-24's byte-identical claim survives the extra node.

`TodoPanel`'s own root box is **`<Box flexDirection="column" flexShrink={0}
width={railWidth}>`, and `flexShrink={0}` is load-bearing (P1-4)**. Ink's
`Box.defaultProps` is `{ flexWrap:'nowrap', flexDirection:'row', flexGrow:0,
flexShrink:1 }`, so a `width={n}` box inside a shrinking row is squeezed under
pressure — and every piece of arithmetic above (R-e's whole answer, AC-20,
AC-21, I-7) silently becomes a suggestion at exactly the narrow widths where the
guarantee matters. The codebase already spells the correct pair one level down,
in `ScrollIndicator`: `flexShrink={0} width={1}`. Cross-axis height needs no
prop: `alignItems` is unset everywhere in this tree, and yoga's default is
`stretch`.

The inline branch **does not include `{rail}` at all** — a structural guarantee
rather than a promise that the caller passes `null` (non-goal 4).

**`contentCols`.** `App` computes:

```ts
const railWidth = showRail ? todoRailWidth(cols) : 0;
const contentCols = cols - railWidth;
```

and every consumer *inside the viewport slot* switches from `cols` to
`contentCols`. The exhaustive list, which is short only because C-7 was checked
rather than assumed:

| Call site | Before | After |
|---|---|---|
| `pickOpenerVariant(viewportBudget, cols, caps)` | `cols` | `contentCols` |
| `<SessionOpener>` (no `cols` prop today; unchanged) | — | — |
| `<ScrollViewport>` | reads `stdout.columns` | new optional `cols` prop, passed `contentCols` |
| `<Header>` / `<Composer>` / `<StatusBar>` / `<ToastStack>` | `cols` | **unchanged** — full-frame width |
| every `overlayNode` (`maxRows` / `cols`) | `cols` | **unchanged** — see below |

Overlays keep the full width because **the rail is hidden while an overlay is
open** (`showRail` includes `overlay === null`). An overlay is a modal surface;
splitting the screen with a status panel behind a modal is both worse design and
a second source of width-contract bugs in six components that each take `cols`
for their own wrapping arithmetic.

`showRail` in full:

```ts
const railRows = todoRailRows(viewportBudget, state.team !== null);
const showRail =
  fullscreen &&                       // non-goal 4
  cfg.todo.panel &&                   // /todo panel off
  overlay === null &&                 // modal owns the screen
  state.todos !== null &&             // no list -> no furniture
  todoRailWidth(cols) > 0 &&          // too narrow
  railRows >= TODO_LIMITS.panelMinRows;  // too short to say anything useful
```

`railRows` is both the mount gate and the value passed to `<TodoPanel rows={…}>`,
which then hands `selectTodoRows` whatever is left after its own header, gauge
and overflow rows. ONE number, computed once: the gate and the window arithmetic
disagreeing is how a panel mounts and then renders nothing.

### 3.10 Row selection and degradation

```ts
// src/todo/panel-rows.ts
export interface TodoRowSelection {
  visible: { item: TodoItem; index: number }[];
  hiddenAbove: number;
  hiddenBelow: number;
}
export function selectTodoRows(items: TodoItem[], maxRows: number): TodoRowSelection;
```

Algorithm: anchor on the `in_progress` index (or the first non-`completed`, or
the last item when everything is done); reserve one row for each of the `+N`
markers that will be non-zero; then take a window around the anchor, biased so
that **completed context above the anchor is sacrificed before upcoming work
below it** — the user's question is "what is next", not "what is behind me".
The anchor is always inside `visible`; that is an invariant, and it is asserted
for every `(listLength, anchorIndex, maxRows)` triple in a small exhaustive test
rather than for a handful of hand-picked cases.

This is the direct descendant of `selectPanelRows`'s F-2 lesson: the team panel
originally used `slice(0, 5)`, which showed the five children that finished
FIRST and hid everything still working.

**A wheel notch over the rail scrolls the transcript, and that is the intended
behaviour (P2-5).** `hitTestWheel` routes by terminal ROW, and the rail occupies
the same rows as the viewport, so every notch anywhere in the middle band reaches
`ScrollViewport`. For a column that has no scroll model of its own this is the
only sensible outcome — the alternative is a dead zone a fifth of the screen wide
— but it is a behaviour rather than an absence of one, and `use-wheel-routing.ts`
stays unchanged only because the answer happens to be right. Say so in the manual
matrix (§8.3) so a future reader does not "fix" it.

### 3.11 Interaction with plan mode, the skills ceiling, team mode, `--confirm`

| Subsystem | Behaviour | Why |
|---|---|---|
| **Plan mode** | `todo_write` is allowed in BOTH modes | It writes no file and runs no shell. In plan mode it is how the model shows its research proceeding; after approval the same list becomes the build checklist — which is the feature at its best. |
| **Skills ceiling** | on `SKILL_TOOL_FLOOR`; never refused | §3.6 |
| **`--confirm`** | not in `MUTATING_TOOLS`; never gated | Asking a human to approve a display update once per step would be an act of hostility. |
| **Team mode (lead)** | lead has both `task` and `todo_write` | A dispatch is naturally one todo item; the rail showing `▸ 3 Researching the four call sites` above a five-child roster is the intended composition. |
| **Team mode (child)** | children get **no** `todo_write` | Children run concurrently against ONE list with a full-replacement protocol: the last writer would win and the lead's plan would be destroyed by a subagent's private checklist. `createSubagent` passes `todoTools: []` **explicitly, with a comment**, even though the option's absence already yields that — a silent default is not a decision anyone can find later. |
| **Headless** | tool registered; §3.12 | |

### 3.12 Headless (`-p` / `--print`)

`HeadlessController` gains an **optional** `subscribeTodos?()` member, for the
identical reason `subscribeTeam?()` is optional: the interface is minimal so
tests can satisfy it with an object literal, and making it required would break
every existing stub for no benefit. `runHeadless` calls it with `?.`, which
keeps a controller without a store byte-identical to today.

Output, to stderr, suppressed by `--quiet`, mirroring `[team]`:

```
[todo] 7 steps planned
[todo] 1/7 Wiring the rail into AppShell
[todo] 2/7 Adding the panel-rows unit test
[todo] 7/7 done
```

One line per transition of the active item, not one per call — a model that
rewrites the list without moving the cursor produces no output.

Interleaved with these, `runHeadless` also writes its generic per-tool lines
(`▸ todo_write` on `tool_execution_start`, ` (1ms)` on
`tool_execution_end`), because that loop keys on the event, not on the tool name
(P2-2). A 7-step task therefore produces roughly 14 of those around the `[todo]`
lines above. This is left alone deliberately: `SELF_RENDERING_TOOLS` is a
TRANSCRIPT concept and teaching the headless writer about it would put the same
name in two places for a cosmetic gain on a stream that is already `--quiet`-able
in full. The sample above is the `[todo]` subset, not a literal transcript.

`panelVisible` is `false` on this path (§3.7), so the model is not told about a
panel it does not have.

### 3.13 Session save / resume

`SavedSession` gains `todos?: TodoItem[]`. `SESSION_VERSION` **stays 1**: the
field is additive and optional, `loadSession` validates only that `messages` and
`entries` are arrays, and an older file simply yields `undefined`. A newer file
read by an older build is ignored harmlessly.

**Three call sites, all in `commands/builtins.ts`, none of them in `App`
(P0-2).** `/save` and `/resume` are slash commands; `App` has no part in either.
The v1 text named `App` and §7.2 listed only `/todo` under `builtins.ts`, which
would have shipped a `SavedSession.todos` field that nothing ever writes.

1. **`saveSession`'s parameter type** — it takes
   `{ model, messages, entries }` today, and gains `todos: TodoItem[]`.
   Widening `SavedSession` alone is not enough; the writer builds its payload
   from the parameter, not from the type.
2. **`/save`** passes `ctx.controller.getTodoSnapshot()?.items ?? []`.
3. **`/resume`** calls `ctx.controller.restoreTodos(session.todos ?? [])`
   immediately after `replaceMessages`, in the same `try` block, so a malformed
   file fails the whole resume rather than half of it.

**An absent or empty `todos` on resume MUST clear, not skip.** `replaceMessages`
has just discarded the conversation the current list belonged to, so the belief
that justifies the panel is gone; leaving the rail up produces a panel that
disagrees with the model, which §1.2 ranks below having no panel at all. That is
why `restore()` (§3.5) treats "zero survivors" as `clear('reset')` rather than as
the hard failure `write()` treats it as: the two entry points get the same
normalization and deliberately different empty cases, because a model sending an
empty list is a bug and a session file without one is a fact.

Otherwise the restore emits `{type:'updated'}` like any other write, so the panel
and the transcript card come back through exactly one code path.

### 3.14 Logging

`installLogging`'s agent-event bridge does not see `TodoEvent` (it is CLI-local).
`TodoStore.write()` therefore logs directly, at `debug`:

```ts
getLogger().debug('todo', 'todo_write', {
  total, done, active: activeIndex, repairs: repairs.length,
});
```

**Item text is not logged.** It is user-task content, it is unbounded in
aggregate, and it buys nothing an operator needs: the counts answer every
question a log can answer here ("did the list move?", "was the payload
repaired?"). The same reasoning `SubagentRun.activity` records for never being
logged.

---

## 4. Interface design

### 4.1 `todo_write`

```ts
{
  name: 'todo_write',
  label: 'Update todos',
  description: TODO_WRITE_DESCRIPTION,   // see below
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description:
          'The COMPLETE list, every time. This replaces the previous list; there is ' +
          'no add or update operation.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description:
                'Imperative, <= 80 chars. What the step is. e.g. "Add the rail to AppShell".',
            },
            activeForm: {
              type: 'string',
              description:
                'Present continuous, <= 80 chars, shown while this step is in progress. ' +
                'e.g. "Adding the rail to AppShell".',
            },
            status: {
              type: 'string',
              description: 'pending | in_progress | completed. Exactly one item may be in_progress.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
}
```

No `enum`, no `maxItems`, no `minItems` — C-8. `activeForm` is not `required`
for the same reason: a missing one is repaired to `content`, whereas a required
one is a rejection under `ajv` and a repair without it.

Description (what the model actually reads):

> Record and update the plan for a multi-step task. Send the complete list every
> time — this tool replaces the whole list. Use it for work with three or more
> distinct steps, and skip it entirely for anything you can finish in one or two.
> Exactly one item may be `in_progress`; mark an item `completed` and the next
> one `in_progress` in the same call, the moment the step is done. At most 20
> items; extras are dropped, so keep within it. This list is how the user follows
> a long task, so keep it current.

The description is **panel-neutral, deliberately, and does not take a second
`panelVisible` variant** (P1-6). A tool description is part of the tool object;
varying it would put the same conditional in two places, and the block already
carries the one sentence that depends on the answer. "How the user follows a long
task" is true on every path — through the rail, the transcript card, the status
cluster or `[todo]` on stderr.

### 4.2 Config keys (`config.json`, section `todo`)

The **fifth** nested section, after `apiKeys`, `skills`, `log` and `team`, and
like all of them **scalars only, exactly one level deep** — `store.ts` merges
these sections by hand and that merge is only correct while nesting stays flat.

**Both of `store.ts`'s hand-written merges must learn about it, and the omission
is silent (P0-1).** The merge is not generic: `loadPersistedConfig` spreads the
raw file over `DEFAULT_CONFIG` and then re-merges `apiKeys` / `skills` / `log` /
`team` one at a time, and `updatePersistedConfig` repeats the same list on the
write path. Two lines are required, one in each:

```ts
// loadPersistedConfig — `todo` is the fifth. Same one-level rule, same merge.
todo: clampTodoConfig({ ...DEFAULT_CONFIG.todo, ...(partial.todo ?? {}) }),

// updatePersistedConfig — the fifth section, and it needs the merge because
// `/todo panel off` sends `{ todo: { panel: false } }`, which a shallow spread
// turns into "turning the panel off silently unregisters the tool".
todo: clampTodoConfig({ ...current.todo, ...(patch.todo ?? {}) }),
```

Without them the top-level spread REPLACES the section: `enabled` is written to
disk as absent, `config.todo.enabled` reads `undefined` on the next launch,
`todoRegistered` is false, and `todo_write` is never registered — because the
user turned a *panel* off. No crash, no log line, no notice. This exact failure
is what that file's header records for `skills` and its inline comment records
for `log.redactSecrets`; a fourth omission would be a known bug, not a new one.
`DEFAULT_CONFIG.todo = DEFAULT_TODO_CONFIG` in `schema.ts` is the third piece and
is equally required — the load path's first spread is what supplies the section
to a user with no `todo` key at all.

```ts
export interface TodoConfig {
  /** Register `todo_write` at all. Default TRUE. */
  enabled: boolean;
  /** Render the right rail. Default TRUE. Independent of `enabled` on purpose:
   *  a screen-reader user wants the planning discipline without the column. */
  panel: boolean;
}

export const DEFAULT_TODO_CONFIG: TodoConfig = { enabled: true, panel: true };

export function clampTodoConfig(raw: unknown): TodoConfig;  // read AND write path
```

`clampTodoConfig` gates both directions, mirroring `clampSkillsConfig` /
`clampLogConfig` / `clampTeamConfig` for the reason those record: hardening only
the read path leaves a bad value on disk that reverts on every launch, which
presents to the user as "my setting will not stick".

Everything else is structural and lives in `TODO_LIMITS`, not in config:

```ts
export const TODO_LIMITS = {
  maxItems: 20,
  contentChars: 80,
  activeFormChars: 80,
  /** Below this, a FRESH list is refused - the structural half of R-c. */
  minFreshItems: 2,
  /** Rows the in-progress row may wrap to. Every other row truncates. */
  activeWrapRows: 2,
  /** Below this many AVAILABLE rail rows (`todoRailRows`, not `viewportBudget`)
   *  the rail is not mounted. */
  panelMinRows: 6,
  /** Below this many terminal columns the status-bar counter degrades to `[3/7]`. */
  statusCompactCols: 100,
  /**
   * Rows `todoRailRows()` subtracts while a team dispatch is live (§3.9 / P1-3).
   *
   * `TEAM_LIMITS.panelMaxRows` (5) + header + `+N more` + the mail line = 8, and
   * this is deliberately the FULL worst case rather than a measurement: an
   * over-subtraction costs one item row, an under-subtraction eats the `+N
   * below` marker, and those two mistakes are not equally bad.
   */
  railReservedRows: 8,
  /**
   * Consecutive user turns an UNFINISHED list survives without a `todo_write`
   * before `beginUserTurn()` drops it (§3.2 / P1-7). Three keeps the common
   * interruption sequence ("wait, explain X" / "and Y?" / "ok, continue")
   * intact and returns the column on the fourth unrelated turn.
   */
  staleTurns: 3,
} as const;

export const TODO_BLOCK_VERSION = 'v1-2026-07';
```

### 4.3 CLI flags and environment

| Channel | Effect |
|---|---|
| `--todo` | Enable for this run (the default) |
| `--no-todo` | Do not register `todo_write` at all; no rail, ever |
| `--todo-panel` | Render the rail (the default) |
| `--no-todo-panel` | Register the tool, do not render the rail |
| `ARAGON_TODO=0` | Same as `--no-todo` |

`ARAGON_TODO` is parsed by the **positive list** (`'0' | 'false' | 'off' | 'no'`
→ off) exactly as `ARAGON_FULLSCREEN` / `ARAGON_MOUSE` / `ARAGON_PLAN` /
`ARAGON_TEAM` are, and **not** by `envBool` — `config/env.ts` already records
that the two readers disagree on values like `ARAGON_TEAM=disable`.

**Both flags are declared as PAIRS, and the resolution is `!== undefined`
(P1-8).** `commander` materializes a lone `--no-x` as `opts.x = true` when the
flag is absent, so `true` becomes indistinguishable from silence and a
config-file `panel: false` is overwritten by a user who passed no flag at all.
`load.ts` states the rule at its `resolveTeamConfig` header: a truthiness test
cannot tell `--no-team` from "not passed", and `--no-skills` only escapes it
because nothing needs to distinguish `--skills` from silence. Both `enabled` and
`panel` are persisted, so both do:

```ts
// config/load.ts — defaults > file > env > flags, mirroring resolveTeamConfig
function resolveTodoConfig(flags, env, file): TodoConfig {
  return clampTodoConfig({
    ...DEFAULT_CONFIG.todo,
    ...(file.todo ?? {}),
    ...(env.todo ?? {}),
    ...(flags.todo !== undefined ? { enabled: flags.todo } : {}),
    ...(flags.todoPanel !== undefined ? { panel: flags.todoPanel } : {}),
  });
}
```

The three-site reminder, because this package has paid for it twice (`mouse`
P1-2, `team` P1-4): a flag needs the `.option()` declaration in `cli.tsx`, a
field on `CliFlags` in `config/load.ts`, **and** a line in `cli.tsx`'s `toFlags()`
mapping. Miss the third and the flag is inert with no compile error and no
runtime error.

### 4.4 Slash command `/todo`

`/todo [status | on | off | panel on|off | clear | continue]`

| Verb | Behaviour |
|---|---|
| *(none)* / `status` | Notice: `Todos: 3/7 done. In progress: "Wiring the rail". Panel: on.` — or `No todo list.` |
| `on` / `off` | `controller.setTodoEnabled(...)` **then** `ctx.persistConfig({ todo: { enabled } })`. The controller call is what re-splices the prompt block (§3.6a / P1-1); the persist call is what survives the session. In a session started with `--no-todo` the tool was never registered (C-1), so the command says so honestly and saves the preference for next launch without touching the runtime — the exact branch `/team on` already documents, including its two-sentence wording. |
| `panel on` / `panel off` | `controller.setTodoConfig({ panel })` **then** `ctx.persistConfig({ todo: { panel } })`. BOTH, in that order (§3.6a / P1-2): the App reads `controller.getConfig()` at render time and `persistConfig` only writes the file, so the persist call alone reports success and changes nothing until the next launch. Takes effect on the next frame, which the command's own toast triggers. |
| `clear` | Empties the store. **Refused while a run is in flight** (`controller.isRunning()`), which bounds the model/panel disagreement window to zero (§1.2). |
| `continue` | `ctx.submit('Continue with the remaining todo items.')` — the affordance the end-of-run notice advertises. Refused when nothing is unfinished, **and refused while a run is in flight** (P2-7): `ctx.submit` is the App's `submitMessage`, which routes to `controller.steer()` when the status is `running`, so the un-refused form would inject "continue the remaining items" into the run that is already doing exactly that. `Already running.` is the whole message. |

### 4.5 Keybindings

**None.** Every existing key is spoken for, the rail is not focusable, and
adding a modal focus concept to reach a read-only column would be the largest
HCI regression available here. `Ctrl+O` continues to expand the last tool or
team card and is unaffected (the todo card renders complete).

---

## 5. Data model

### 5.1 Runtime shapes (`src/todo/types.ts`)

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Imperative, sanitized, <= TODO_LIMITS.contentChars. */
  content: string;
  /** Present continuous, shown while in progress. Falls back to `content`. */
  activeForm: string;
  status: TodoStatus;
}

/** The immutable projection the UI renders. Rebuilt on every write. */
export interface TodoSnapshot {
  items: TodoItem[];
  total: number;
  doneCount: number;
  /** Index of the single in_progress item, or -1 when everything is completed. */
  activeIndex: number;
  /**
   * Stamped by an INJECTED clock (`TodoStore`'s constructor takes
   * `now?: () => number`, defaulting to `Date.now`), for the reason `TeamPanel`
   * takes a `now?` prop: a snapshot test that reads the wall clock is a test
   * that fails on a slow machine and nowhere else (P2-4).
   */
  updatedAt: number;
}

/** Why a list went away. `'stale'` is §3.2's turn bound; the rest are explicit. */
export type TodoClearReason = 'user' | 'reset' | 'turn' | 'stale';

export type TodoEvent =
  | { type: 'updated'; snapshot: TodoSnapshot }
  | { type: 'rejected'; reason: string }
  | { type: 'cleared'; reason: TodoClearReason };
```

**No item ids.** Identity is positional, because a full-replacement protocol
gives an id nothing to do except go stale: a field the model must keep stable
across calls is a field it will eventually get wrong, and the UI's only use for
identity (React keys on a list of plain text rows) is served perfectly by the
index.

### 5.2 View-state additions (`agent/reducer.ts`)

```ts
// Entry union gains:
  | {
      id: string;
      kind: 'todo';
      items: TodoItem[];
      doneCount: number;
      total: number;
      /**
       * The turn that owns this card is still running, so it may be rewritten.
       * MUST be forced false on load (C-5 / session/persist.ts) - a card that
       * never settles is re-rendered on every frame for the rest of the session.
       */
      live: boolean;
      /**
       * Set by `normalizeLoadedEntries` on a card that was saved while its run
       * was live (P2-6). The todo analogue of the team entry's `aborted`, and
       * true for the same reason: the run behind it died with the process.
       * Absent on every card this session produced.
       */
      interrupted?: boolean;
    }

// ViewState gains:
  /** The live list, or null. NEVER persisted here - `entries` is the history. */
  todos: TodoSnapshot | null;
  /** The `kind: 'todo'` entry this turn is writing into. */
  todoEntryId?: string;

// Actions gain:
  | { type: 'todoUpdate'; snapshot: TodoSnapshot }
  | { type: 'todoCleared' }
```

Reducer changes, in full:

- `todoUpdate` → set `state.todos`; rewrite `todoEntryId`'s entry, or append a
  new one and record its id.
- `todoCleared` → `todos: null`, `todoEntryId: undefined`. **The entry stays**:
  it is history, and history is not retracted.
- `submit` → `todoEntryId: undefined` (next turn gets its own card).
- `runEnd` → mark `todoEntryId`'s entry `live: false`.
- `clearTranscript` → `todoEntryId: undefined` (its entry is gone), **`todos:
  null`** — the mirror half of the `'user'` clear the `/clear` command performs
  on the store (revised; see the I-2 note above).
- `resetConversation` → `todos: null`, `todoEntryId: undefined`.
- `restoreEntries` → `todoEntryId: undefined`, as it already does for `team`.

### 5.3 Persisted shapes

```ts
// config.json
{ ..., "todo": { "enabled": true, "panel": true } }

// session file — SESSION_VERSION stays 1 (§3.13)
{ version: 1, savedAt, model, messages, entries, todos?: TodoItem[] }
```

---

## 6. UI design

### 6.1 The rail

At 120 columns (rail width 24), 7 items, step 3 running:

```
                                          │ TODO             2/7
                                          │ ####------
                                          │
                                          │ v  1 Read the reducer
                                          │ v  2 Design the store
                                          │ >  3 Wiring the rail into
                                          │      AppShell
                                          │ o  4 Add the panel-rows
                                          │ o  5 Update the README
                                          │      +2 more
```

(Markers shown in their ASCII tier; the Unicode tier is `✔ ▸ ○`.)

Composition, top to bottom:

1. **Separator column** — `glyphs.railVertical`, `theme.border`, full height. One
   column, plus one space of padding. Content width is `railWidth - 2`.
2. **Header** — `TODO` in `theme.accent`, bold, with `doneCount/total` right-
   aligned in `theme.muted`. When everything is done: `7/7 done` in
   `theme.toolDone`.
3. **Gauge** — `buildGauge(pct, width, theme, caps)`, the existing helper, only
   when `railWidth >= 20 && rows >= 8`. It is the one purely decorative element
   and the first to go.
4. **One blank row.**
5. **Item rows** from `selectTodoRows()`:
   - marker cell, `padEnd(3)` — this is what makes the Unicode tier (1 column)
     and the ASCII tier (3 columns) line up without a per-tier branch;
   - index cell (`padStart(2)` + space), dropped below
     `TODO_RAIL_INDEX_MIN_COLS`;
   - text: `activeForm` for the in-progress row, `content` for the rest.
6. **Overflow markers** — `+N above` / `+N more`, `theme.muted`.

Colour and motion:

| State | Colour | Marker |
|---|---|---|
| `completed` | `theme.muted` | `glyphs.todoDone` |
| `in_progress` | `theme.primary`, bold | `<Spinner type="dots"/>` when `running && !reducedMotion && caps.unicode`, else `glyphs.todoActive` |
| `pending` | `theme.hintFg ?? theme.muted` | `glyphs.todoPending` |

Three deliberate choices, each of which is the kind of thing that gets
"cleaned up" later:

- **The in-progress row is the only one allowed to wrap** (up to
  `TODO_LIMITS.activeWrapRows = 2`); every other row is `wrap="truncate"`. The
  wrapping budget of a narrow column is a scarce resource and it belongs to the
  step the user is watching.
- **The spinner is gated on `running`.** A spinner while the agent is idle is a
  lie about the state of the world, and this panel outlives the run that filled
  it.
- **No `strikethrough` on completed items.** `chalk` emits SGR 9 for it, which
  legacy `conhost` does not implement and can leak as raw bytes. Muted colour
  carries the same meaning with none of the risk — the same conservatism the
  glyph tiers exist for.

**Width is measured in COLUMNS, never in code units (P2-3).** This rail is 16-34
columns wide and the system prompt's last line is "Respond in the language the
user writes in", so CJK item text in an 18-column rail is the normal case rather
than the edge case. Two consequences, and the first is free:

- every text cell is `wrap="truncate"` (except the in-progress row's two), and
  Ink's truncation is display-width aware, so nothing can overflow the box;
- **no arithmetic in `TodoPanel` may budget user text by `.length`.** The
  `padEnd(3)` / `padStart(2)` cells above are ASCII markers and indices, which is
  why they are safe; a "characters that fit" calculation over `content` would not
  be. This is the whole of the lesson `TeamPanel`'s `WIDE_CHAR_ALLOWANCE` records
  at length — a budget denominated in code units against a terminal denominated
  in columns — and the mitigation here is to have no such budget at all and let
  truncation do it.

New glyph fields (`ui/glyphs.ts` — the file's own header mandates adding a field
rather than a literal or an exemption):

| Field | Unicode | ASCII |
|---|---|---|
| `todoPending` | `○` | `[ ]` |
| `todoActive` | `▸` | `>` |
| `todoDone` | `✔` | `[x]` |
| `tool.todo_write` | `☰` | `=` |

The ASCII tier uses bracketed forms for the two settled states because a bare
single letter cannot distinguish "done" from "failed" on a monochrome terminal;
`padEnd(3)` in the panel makes the mixed widths irrelevant.

### 6.2 The transcript card (`ui/entries/TodoCard.tsx`)

One card per turn, `glyphs.tool.todo_write` as its rail marker, rendered through
the existing `EntryFrame`:

```
= Todos  2/7
  v Read the reducer
  v Design the store
  > Wiring the rail into AppShell
  o Add the panel-rows unit test
  o Update the README
  o Run the full test suite
  o Update the CHANGELOG
```

Full list, no windowing (the transcript scrolls; the rail does not) and **never
animated** even while `live` — a resumed session would otherwise spin forever on
a card whose run ended days ago.

### 6.3 Status bar

An optional `todoActive?: { done: number; total: number }` cluster, placed in
the LEFT cluster after the team counter, degrading below
`TODO_LIMITS.statusCompactCols` from `todo 2/7` to `[2/7]` — the same treatment,
and the same justification, as the team counter's `agents 3/5` → `[3]`.

It is rendered only when a list exists AND the rail is not (`!showRail`): with
the rail on screen the numbers are already there in a larger typeface, and
duplicating them costs the context gauge columns it cannot spare. This is the
inline-mode and narrow-terminal fallback for R-d.

### 6.4 Degradation matrix

| Condition | Rail | Card | Tool |
|---|---|---|---|
| No list yet | not mounted | none | registered |
| `cols < 80` | not mounted | rendered | registered |
| `viewportRows < 6` | not mounted | rendered | registered |
| Overlay open | hidden for its duration | rendered | registered |
| Inline mode | never | rendered | registered |
| `todo.panel = false` | never | rendered | registered |
| `--no-todo` / `ARAGON_TODO=0` | never | never | **not registered** |
| `reducedMotion` / no Unicode | static marker | unchanged | registered |
| Terminal too small (`rows < 12`) | placeholder frame; nothing else renders | — | registered |

---

## 7. File / module change plan

### 7.1 New files (10)

| File | Intent |
|---|---|
| `src/todo/limits.ts` | `TODO_LIMITS` + `TODO_BLOCK_VERSION`; the single authority on every structural bound. |
| `src/todo/types.ts` | `TodoStatus` / `TodoItem` / `TodoSnapshot` / `TodoEvent` / `TodoEventListener`. |
| `src/todo/normalize.ts` | `normalizeTodos()` — the repair table of §3.4, pure and never throwing. |
| `src/todo/store.ts` | `TodoStore` — state, event stream, turn boundary, restore. Zero I/O. |
| `src/todo/todo-tool.ts` | `createTodoTool()` — the five-step execute of §3.3. |
| `src/todo/prompt.ts` | `buildTodoBlock()` — the `<todo_planning>` system-prompt block. |
| `src/todo/panel-rows.ts` | `selectTodoRows()` — anchored windowing, pure. |
| `src/ui/layout/rail.ts` | `todoRailWidth()` + the four width constants. |
| `src/ui/TodoPanel.tsx` | The rail (§6.1). |
| `src/ui/entries/TodoCard.tsx` | The transcript checklist card (§6.2). |

### 7.2 Modified files (20)

| File | Change |
|---|---|
| `src/agent/controller.ts` | Own `TodoStore`; build `todoTools` through the factory; the §3.6a surface (`subscribeTodos` / `getTodoSnapshot` / `restoreTodos` / `clearTodos` / `isTodoRegistered` / `isTodoEnabled` / `setTodoEnabled` / `getTodoConfig` / `setTodoConfig`); `todos.beginUserTurn()` in `prompt()`; `todoBlock` in `composeSystemPrompt()` gated on `todoRegistered && todoEnabled`; **`setTodoEnabled` and `setTodoConfig` both call `rebuildSystemPrompt()`** (P1-1); clear the store in `clearMessages()`. |
| `src/agent/system-prompt.ts` | New optional `todoBlock?: string`, spliced conditionally (C-10). |
| `src/agent/reducer.ts` | `Entry` `kind:'todo'`; `ViewState.todos` / `todoEntryId`; `todoUpdate` / `todoCleared`; `SELF_RENDERING_TOOLS` suppression; the six existing-case edits of §5.2. |
| `src/agent/headless.ts` | Optional `subscribeTodos?()` on `HeadlessController`; `[todo]` stderr lines (§3.12). |
| `src/tools/index.ts` | `todoTools?` option + splice; `HOST_TOOL_NAMES` += `todo_write`; `SKILL_TOOL_FLOOR` += `todo_write`. |
| `src/team/subagent.ts` | Explicit `todoTools: []` with the §3.11 comment. |
| `src/ui/App.tsx` | `subscribeTodos` effect (NOT routed through the streaming coalescer, for the reason the team subscription records); `showRail` / `railWidth` / `railRows` / `contentCols`; pass `rail`; end-of-run unfinished notice. |
| `src/ui/layout/AppShell.tsx` | `rail?` prop; **unconditional** middle-band row wrapper in the full-screen branch only (§3.9). |
| `src/ui/layout/ScrollViewport.tsx` | Optional `cols?` prop overriding `stdout.columns` (C-7). |
| `src/ui/Transcript.tsx` | `case 'todo'` in `EntryView`; `kind === 'todo' && live` in `computeSettledCount` (C-5). |
| `src/ui/StatusBar.tsx` | Optional `todoActive?` cluster (§6.3). |
| `src/ui/glyphs.ts` | Three new fields + `tool.todo_write` in both tiers. |
| `src/commands/builtins.ts` | `/todo` (§4.4); **`/save` passes `todos`, `/resume` calls `restoreTodos(session.todos ?? [])`** (§3.13 / P0-2). |
| `src/config/schema.ts` | `TodoConfig` / `DEFAULT_TODO_CONFIG` / `clampTodoConfig`; `PersistedConfig.todo`; `CliConfig.todo`; **`DEFAULT_CONFIG.todo`**. |
| `src/config/store.ts` | **The two hand-written merges** — one line in `loadPersistedConfig`, one in `updatePersistedConfig` (§4.2 / P0-1). Omitting either turns `/todo panel off` into a permanent, silent unregistration of the tool. |
| `src/config/load.ts` | `CliFlags.todo` / `CliFlags.todoPanel`; `resolveTodoConfig` (defaults → file → env → flags, `!== undefined` on both flags, clamped on the way out — §4.3). |
| `src/config/env.ts` | `ARAGON_TODO`, positive-list parsing (§4.3). |
| `src/cli.tsx` | `--todo` / `--no-todo` / `--todo-panel` / `--no-todo-panel`, **plus the matching lines in `toFlags()`** — the third site the `mouse` and `team` incidents were both about. |
| `src/session/persist.ts` | `SavedSession.todos?`; **`saveSession`'s `data` parameter gains `todos`**; settle todo entries (`live: false` + `interrupted: true`) in `normalizeLoadedEntries` (C-5 / P2-6). |
| `src/__tests__/glyphs.test.ts` | Add `todo` to the `inScope` regex (C-4). |

Docs: `packages/cli/README.md` gains a **TODO planning** section between *Plan
mode* and *Built-in tools*, plus rows in *Slash commands*, *Global flags* and
*Configuration*; `packages/cli/CHANGELOG.md` gains an `### Added` entry under
`## Unreleased`.

### 7.3 Files deliberately NOT changed

- **Everything under `packages/core/`.** The tool is a host tool, the event
  stream is CLI-local, the panel is CLI-only. AC-32 asserts this by diff.
- `src/ui/layout/regions.ts` / `use-wheel-routing.ts` — the rail is a column and
  the router bands are rows (C-6).
- `src/ui/layout/budget.ts` — the rail consumes columns, not rows; `viewportRows`
  is unchanged and stays a function of `rows` alone.
- `src/agent/agent-mode.ts`, `src/tools/plan-tools.ts` — plan mode gains no
  vocabulary and no gate.

---

## 8. Testing and acceptance criteria

### 8.1 New test files (9)

`todo-normalize.test.ts`, `todo-store.test.ts`, `todo-tool.test.ts`,
`todo-panel-rows.test.ts`, `todo-rail.test.ts`, `todo-panel.test.tsx`,
`todo-reducer.test.ts`, `todo-config.test.ts`, `todo-session.test.ts`.

Updated: `tools.test.ts` (C7 count 14 → 15, the hard-coded `SKILL_TOOL_FLOOR`
array literal, and the floor/blocked partition), `glyphs.test.ts` (scan scope +
the three new fields are covered by the existing both-tiers loop),
`reducer.test.ts` (suppression), `app.test.tsx` (rail mounting),
`config.test.ts` (the two `store.ts` merges), and — **easy to miss, and it will
not fail at compile time (P1-5)** — `mouse-routing.test.tsx`. There are TWO
hand-written `FakeController`s that render `<App>`, one in each of those two
files, and both are handed over as `fc as unknown as AgentController`. A
required `subscribeTodos` on the real controller is therefore not a type error
in either; it is `controller.subscribeTodos is not a function` at mount, in a
wheel-routing suite that has nothing to do with todos.

### 8.2 Acceptance criteria

**Tool and normalization**

- **AC-1** A payload of 7 well-formed items commits 7 items, `requested = 7`,
  `repairs = []`.
- **AC-2** 23 items commit 20, and the result text contains the "last 3 were
  dropped" note.
- **AC-3** Two `in_progress` items commit with exactly one; the second is
  `pending`; a repair note says so.
- **AC-4** An all-`pending` list commits with item 0 promoted to `in_progress`.
- **AC-5** An all-`completed` list commits with `activeIndex === -1` and no
  promotion.
- **AC-6** `status: 'blocked'` is repaired to `pending`, not rejected.
- **AC-7** `content: '  '` drops that item; `content` of 200 chars is clamped to
  80; a `content` containing `\n` is collapsed to a single space.
- **AC-8** A missing `activeForm` is filled from `content`.
- **AC-9** `todos: 'nope'` returns an **error** result (the one hard failure) and
  leaves the previous list untouched.
- **AC-10** A 1-item list against an EMPTY store returns the non-error
  "just do the work" refusal and commits nothing.
- **AC-11** The same 1-item list against a NON-empty store commits.
- **AC-12** The result text names the in-progress item and the next pending one.
- **AC-13** `todo_write` never rejects, never throws, and performs no `fs`,
  `net` or `child_process` call (asserted by injecting throwing fakes).

**Store and lifecycle**

- **AC-14** `beginUserTurn()` with every item completed clears and emits
  `{type:'cleared', reason:'turn'}`.
- **AC-15** The FIRST `beginUserTurn()` with one `pending` item keeps the list
  and emits nothing (the staleness bound is AC-41's; this pins that it does not
  fire early).
- **AC-16** `controller.steer()` does **not** call `beginUserTurn()`.
- **AC-17** `controller.clearMessages()` (`/reset`) clears the store; so does
  `/clear`, via `controller.clearTodos()` (reason `'user'`) — I-2's user-override
  exception (revised; see the I-2 note above). `/clear` still leaves `messages`
  alone.
- **AC-18** A listener that throws does not prevent the other listeners from
  running, and does not fail the tool call.

**Layout**

- **AC-19** `todoRailWidth` is non-decreasing over `cols ∈ [40, 300]`.
- **AC-20** `todoRailWidth(cols) === 0` for `cols < 80`; `=== 18` at 80;
  `=== 24` at 120; `=== 36` at 200.
- **AC-21** `cols - todoRailWidth(cols) >= 62` for every `cols >= 80`.
- **AC-22** `selectTodoRows` always includes the anchor, for every
  `(length ≤ 20, anchor, maxRows ∈ [1, 20])` triple.
- **AC-23** With the rail mounted, `AppShell`'s measured `bottom` is unchanged
  from the same tree without it (C-6), asserted through `geometryOverride`.

**Rendering**

- **AC-24** With no list, `TodoPanel` is not mounted and the rendered frame is
  byte-identical to the pre-feature frame.
- **AC-25** The in-progress row renders `activeForm`; the others render
  `content`.
- **AC-26** With `caps.unicode: false` the frame contains no non-ASCII byte
  (the `glyphs.test.ts` scan plus a rendered-frame assertion).
- **AC-27** `reducedMotion` or `status: 'idle'` renders the static marker, never
  a spinner.
- **AC-28** A 20-item list at 10 available rows renders the anchor plus
  `+N above` / `+N more`, and never more rows than it was given.

**Integration**

- **AC-29** A `todo_write` call produces **no** `kind:'tool'` entry and exactly
  one `kind:'todo'` entry per turn; a second call in the same turn rewrites it;
  a call in the next turn appends a second card.
- **AC-30** `todo.enabled: false` produces a system prompt byte-identical to the
  pre-feature output for a fixed tool array, and a tool array byte-identical by
  object identity (the `--no-skills` / `--no-team` proof shape).
- **AC-31** `HOST_TOOL_NAMES` equals what `createBuiltinTools` produces, and
  `SKILL_TOOL_FLOOR ∪ PLAN_MODE_BLOCKED_TOOLS` still partitions it.
- **AC-32** `git diff --stat packages/core` is empty.
- **AC-33** A session saved mid-run and resumed has `live: false` and
  `interrupted: true` on its todo card (C-5 / P2-6) and a restored, normalized
  list.
- **AC-34** A subagent's tool array contains no `todo_write`.

**Review-round additions (v2)**

- **AC-35** (P0-1) `updatePersistedConfig({ todo: { panel: false } })` returns
  and writes `{ enabled: true, panel: false }`; `loadPersistedConfig()` over a
  file whose only content is `{"todo":{"panel":false}}` yields
  `enabled: true`. Both directions, because the read path and the write path are
  separate merges.
- **AC-36** (P0-2) `/save` writes a `todos` array matching the live snapshot;
  `/resume` of a file WITHOUT `todos` clears a non-empty store and emits
  `{type:'cleared', reason:'reset'}`; `/resume` of a file WITH `todos` emits
  `{type:'updated'}` with the normalized list.
- **AC-37** (P1-1) `controller.getSystemPrompt()` contains `<todo_planning>`
  after construction, does NOT contain it after `setTodoEnabled(false)`, and
  contains it again after `setTodoEnabled(true)`.
- **AC-38** (P1-2) `/todo panel off` makes `controller.getConfig().todo.panel`
  false **without a relaunch**, and the next rendered frame has no rail.
- **AC-39** (P1-3) `todoRailRows(b, true) === b - TODO_LIMITS.railReservedRows`
  and `todoRailRows(b, false) === b`, both floored at 0; and a rendered frame
  with a 5-child roster plus a 20-item list still contains the `+N more` marker.
- **AC-40** (P1-4) With the rail mounted at 80 columns and a 200-character item,
  the transcript column's measured width is exactly `cols - todoRailWidth(cols)`
  — i.e. the rail did not shrink and did not grow.
- **AC-41** (P1-7) A list with one `pending` item survives
  `TODO_LIMITS.staleTurns` `beginUserTurn()` calls and is cleared with
  `{type:'cleared', reason:'stale'}` on the next one; a `write()` anywhere in
  that sequence resets the counter; an all-`completed` list still clears with
  `reason:'turn'` on the first call.
- **AC-42** (P1-6) `buildTodoBlock({ panelVisible: false })` contains neither
  the word `panel` nor `beside`; `buildTodoBlock({ panelVisible: true })` does;
  the two differ in exactly one sentence.
- **AC-43** (P1-5) Both `FakeController`s satisfy the todo surface, and
  `mouse-routing.test.tsx`'s existing cases still mount `<App>` without throwing.
- **AC-44** (P1-8) With no todo flags passed, a config file containing
  `panel: false` resolves to `panel: false` (the flag default must not overwrite
  it); `--todo-panel` resolves to `true` and `--no-todo-panel` to `false`.

### 8.3 Manual verification

A companion `manual-test.md` covers, at minimum: a 7-step task on an 80-column
and a 200-column terminal; a resize from 200 → 70 → 200 mid-run; `--no-todo`;
`/todo panel off` then `on` **without relaunching** (P1-2); an overlay opened and
closed while a list is active; `/save` + `/resume` mid-plan **and** a `/resume`
of a session saved before this feature existed (P0-2); `-p` with `--quiet` and
without; a legacy `cmd.exe` for the ASCII tier; and a run aborted with `Esc` at
step 3 (the notice and `/todo continue`).

Four cases added by the v2 review, each of which is invisible to the unit suite:

1. **A `task` dispatch with five children while a 20-item list is on screen**
   (P1-3) — the `+N more` marker must still be the last visible rail row.
2. **`/todo panel off`, then quit and relaunch** (P0-1) — `todo_write` must still
   be registered, which is only observable through `/tools`.
3. **A wheel notch over the rail** (P2-5) — the transcript scrolls; the rail does
   not move and nothing is routed into prompt history.
4. **A Chinese-language session** (P2-3) — CJK item text must truncate cleanly at
   the rail edge on a 80-column terminal, with no wrapped fragment and no row
   wider than its box.

---

## 9. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **The model over-plans**, producing a rail for trivial requests and making the tool feel like ceremony. | The prompt's explicit "do NOT use it for" list, the 3-step threshold, and the structural refusal of a fresh 1-item list (AC-10). If it persists in the field, tighten `minFreshItems` to 3 — a one-constant change. |
| R-2 | **The model under-updates**, marking three steps done in one call so the panel jumps. | The tool result says "do not batch" on every single call — the highest-frequency channel available. Detectable: a write whose `doneCount` advances by more than 1 is logged. |
| R-3 | **Width regression**: some component inside the viewport still assumes full width. | C-7 was verified by grep, not assumed; `contentCols` has an exhaustive call-site table (§3.9); AC-21 guarantees the transcript never drops below 62 columns, which is above every existing breakpoint. |
| R-4 | **`<Static>` duplication** from a rewritten todo card — **in inline mode only** (P2-1: `TranscriptList` renders no `<Static>` and deliberately never calls `computeSettledCount`, so the full-screen path cannot hit this). | C-5: the `live` flag in `computeSettledCount` **and** the load-path settle. Both are asserted (AC-29, AC-33). Two independent guards, on the one mode that needs them. |
| R-5 | **A new tree escapes the glyph scanner** and ships mojibake. | C-4: `todo` is added to `inScope` in the same commit; AC-26 asserts a rendered ASCII frame as a second line of defence. |
| R-6 | **Panel and model disagree** after a `/todo clear`. | Refused mid-run (§4.4), and the next write is a full replacement, so the window is zero-length in practice. |
| R-7 | **A subagent destroys the lead's list.** | Children do not get the tool, explicitly and with a comment (§3.11), asserted by AC-34. |
| R-8 | **`ajv` present vs absent changes behaviour.** | C-8: no `enum`, no `maxItems`, no `minItems` in the schema; every bound is in `normalizeTodos`, which is unit-tested without a provider. |
| R-9 | **The rail steals columns on a 80-column terminal** and the transcript feels cramped. | `TODO_RAIL_MIN_TOTAL_COLS = 80` is the floor at which a rail appears at all, and AC-21 pins what is left. A user who disagrees has `/todo panel off`, persisted. |
| R-10 | **Feature creep into a second scroll model.** | Non-goal 2 and §1.2; `selectTodoRows` is deliberately a pure windowing function with no offset state anywhere. |
| R-11 | **A config section that is spread rather than merged** silently unregisters the tool, permanently, in response to a display preference (P0-1). | §4.2 names both merge call sites verbatim; AC-35 asserts the read and the write path separately; §7.2 lists `config/store.ts` as a modified file so the change plan cannot be executed without it. |
| R-12 | **A resumed session shows the previous conversation's plan** (P0-2). | §3.5's `restore()` contract makes the empty case a `clear`, §3.13 names all three call sites, and AC-36 asserts both the with-`todos` and the without-`todos` resume. |
| R-13 | **The rail out-requests its band** while a team dispatch is live and loses the `+N below` marker, which is indistinguishable from a short list (P1-3). | `todoRailRows()` subtracts the full worst case rather than measuring (§3.9); AC-39 pins the arithmetic and a rendered frame; manual case 1 covers the composition end to end. |
| R-14 | **The model is told about a panel that does not exist** under `-p`, inline, `--no-todo-panel` or a small terminal (P1-6). | `panelVisible` selects one of two sentences at compose time (§3.7); AC-42 pins both variants. |
| R-15 | **An abandoned plan holds a fifth of the screen for the rest of the session** (P1-7). | `TODO_LIMITS.staleTurns` (§3.2 / §4.2), self-healing because the next `todo_write` is a full replacement; AC-41. |

---

## 10. Decision log

| # | Decision | Alternative rejected, and why |
|---|---|---|
| D-1 | Full-list replacement | Incremental ops (`todo_add` / `todo_complete`): three tools, an id the model must keep stable, and a drift mode nothing can detect. |
| D-2 | Tool named `todo_write`, fields `content` / `activeForm` / `status` | A bespoke name and schema. R-f is explicit, and a model's priors about `TodoWrite` are worth more than our naming taste — the same argument `task-tool.ts` records. |
| D-3 | Exactly-one-`in_progress` enforced by repair | Trusting the prompt. R-b would then be a hope with no test. |
| D-4 | No item ids | Model-supplied ids: a stability requirement the model will break. Store-assigned ids: unused, since React keys on index are sufficient for text rows. |
| D-5 | The list is a projection of the model's belief (I-2) | Making the panel authoritative and letting the user edit it: a write conflict over one array with no merge rule. |
| D-6 | Clear a completed list at the START of the next turn | Clearing at `agent_end`: destroys the `7/7 done` moment. Never clearing: permanent litter. |
| D-7 | Rail hidden while an overlay is open | Keeping it: six overlays each take `cols` for their own wrapping arithmetic, and all six would need a new width contract. |
| D-8 | Rail width `round(cols*0.2)` clamped `[18, 36]`, `0` below 80 columns | A literal unclamped 20%: 40 columns of whitespace at 200, and an unreadable 8-column strip at 40. |
| D-9 | Suppress the generic tool card; one `kind:'todo'` card per turn | Keeping N tool cards: 14 near-identical entries in a 7-step task. Suppressing the entry entirely: the one tool whose failures would be invisible. |
| D-10 | Suppress only `tool_call_start` | Suppressing all five tool events: four redundant rules, each a place to get the id matching wrong, when `findToolEntryId` already returns `undefined` and every handler already early-returns. |
| D-11 | `TodoEvent` is CLI-local | Extending core's `AgentEvent`: breaks `public-api.test.ts` and teaches core a host shape. |
| D-12 | `todo_write` on `SKILL_TOOL_FLOOR` | The blocked set: a skill's `allowed-tools` would make the planning UI unreachable — the dead end the floor exists to prevent. |
| D-13 | Allowed in plan mode | Blocking it: plan mode is exactly where a visible research checklist earns its keep, and it writes nothing. |
| D-14 | Children get no `todo_write` | Sharing the lead's list: last-writer-wins destroys the plan. A per-child list: a second panel and a second scroll model. |
| D-15 | Notify on unfinished, never auto-continue | Auto-continuation: an unbounded cost loop, and one the user did not ask for. |
| D-16 | Two config keys only (`enabled`, `panel`) | A `railWidthPercent` key: R-e fixes the proportion, and a knob nobody turns is a knob that rots. |
| D-17 | Muted colour for completed, no strikethrough | SGR 9 is unimplemented on legacy `conhost` and can leak raw bytes. |
| D-18 | `AppShell` prop named `rail`, not `todo` | `team` already leaks content vocabulary into a layout primitive; there is no reason to repeat it. |
| D-19 | Counts only in logs, never item text | Unbounded user-task content in a log file for no operational gain (the `activity` precedent). |
| D-20 | `SESSION_VERSION` stays 1 | A bump forces a migration path for a field whose absence already means exactly the right thing. |
| D-21 (v2) | An unfinished list expires after `staleTurns` (3) | Never expiring: 20% of the terminal held indefinitely for work nobody is doing, escapable only through a slash command the user has to know about. Expiring at 1 turn: destroys the plan on "wait, explain X", which D-6 exists to prevent. |
| D-22 (v2) | `restore([])` CLEARS | Treating it as `write()`'s hard failure: `/resume` would leave the previous conversation's plan on screen with its justification deleted — I-2 inverted. The two entry points share normalization and differ only here, which is the difference between "the model sent nothing" (a bug) and "the file has nothing" (a fact). |
| D-23 (v2) | `todoRailRows()` subtracts a CONSTANT worst case | Measuring the bottom box: a second `measureElement` → `setState` → measure loop, which §1.2 refuses on principle. Ignoring the team panel: loses the `+N below` marker in the one composition §3.11 calls intended. Over-subtracting costs one item row; under-subtracting costs the marker, and those are not equally bad. |
| D-24 (v2) | One sentence of the prompt block varies with `panelVisible` | Dropping the block when there is no panel: the planning discipline is worth having without the column, which is why `enabled` and `panel` are separate keys. Leaving the sentence unconditional: telling the model something false about the user's screen on four supported paths. |
| D-25 (v2) | `panelVisible` is resolved once, at compose time | Re-composing on resize / overlay: rewrites the system prompt mid-run, which plan mode's §3.9 rules out for its own block, and buys a guidance sentence rather than a contract. |
| D-26 (v2) | The `AppShell` row wrapper is unconditional | Mounting it only when a rail exists: changes the React tree's shape the first time the model calls `todo_write`, remounting `ScrollViewport` and discarding the scroll offset and the intent nonce it seeds on mount. |

---

## 11. Invariants

- **I-1** `todo_write` is the only writer of `TodoStore` outside `restore()` and
  `clear()`; nothing in `ui/**` mutates a list.
- **I-2** The panel is a projection of what the model believes. Nothing that does
  not tell the model may change it, EXCEPT an explicit user instruction, marked
  reason `'user'` — today `/todo clear` and `/clear` (revised; `/clear` was
  formerly forbidden from clearing). `/reset` clears it because the belief is
  gone with `messages`.
- **I-3** Exactly one item is `in_progress` whenever at least one item is not
  `completed` — a property of the stored state, not of the payload.
- **I-4** The rail lives in `AppShell`'s middle band and never inside
  `bottomRef` (C-6).
- **I-5** With `todo.enabled: false`, the tool array is object-identical and the
  system prompt byte-identical to the pre-feature build.
- **I-6** A `kind:'todo'` entry with `live: true` never reaches `<Static>`, and
  no loaded session contains one.
- **I-7** `todoRailWidth` is non-decreasing in `cols`, and leaves the transcript
  at least 62 columns.
- **I-8** `src/todo/**` and `src/ui/**` contain no non-ASCII literal outside
  `glyphs.ts` — enforced by the scanner, whose scope this feature extends.
- **I-9** (v2) The panel is never a **contradiction** of the model. It may be
  absent while the model still holds a plan (`/todo clear`, the `staleTurns`
  expiry, `panel: false`); it may never show a list the model has moved past.
  Every clear path is therefore a full removal and every write is a full
  replacement — there is no partial update anywhere, which is what makes this
  provable rather than argued.
- **I-10** (v2) Whatever `showRail` gates on is what `TodoPanel` is given.
  `railWidth` and `railRows` are each computed once in `App` and used both for
  the gate and for the render; a panel that mounts on one number and lays out
  against another renders nothing and reports nothing.

---

## 12. Open questions and bounded follow-ups

1. **An inline-mode summary line.** Non-goal 4 leaves inline mode with the card
   and the status cluster. A one-line `todo 2/7 · Wiring the rail` above the
   composer would be cheap; it is deferred because inline mode has no fixed
   frame and every row there is a row of the user's scrollback.
2. **Persisting a list across process restarts** (a `todos.json` beside
   `state.json`), so `aragon` resumed in the same directory offers to pick the
   plan back up. Deferred: it needs a scoping rule (per directory? per session?)
   that no requirement here constrains.
3. **`/todo continue` as a keybinding.** Deferred until the notice's discovery
   rate is known; §4.5's argument against new keys stands until then.
4. **Emitting a todo item per `task` subagent automatically.** Attractive, and
   exactly the kind of implicit write that D-5's projection rule exists to keep
   out of v1.

---

## 13. Definition of done

1. All 44 acceptance criteria pass; `npm test` is green in both workspace
   packages; `npm run build` is clean. Green includes `mouse-routing.test.tsx`,
   which the v2 review found is silently broken by the controller change
   (AC-43).
2. `git diff --stat packages/core` is empty.
3. `aragon --no-todo` produces an object-identical tool array and a
   byte-identical system prompt to the pre-feature build.
4. The manual matrix of §8.3 is executed on Windows Terminal, legacy `cmd.exe`
   and one POSIX terminal, and recorded in
   `docs/plans/todo-plan-execution/manual-test.md`.
5. `packages/cli/README.md` and `CHANGELOG.md` are updated.
6. `TODO_BLOCK_VERSION` is `v1-2026-07`, and any later change to the block's
   wording bumps it — **including a change to either `{{VISIBILITY}}` variant**,
   which is part of the block.
7. (v2) The three conditions of §14 are met.

---

## 14. 评审结论 (Review Verdict)

**有条件通过 — approved with conditions.**

The architecture is sound and the research behind it is real. Every one of the
ten constraints in §2 was verified against the committed tree rather than
accepted, and all ten hold; the two decisions the whole feature rests on —
full-list replacement (D-1) and "the list is a projection of what the model
believes" (D-5 / I-2) — are correct and are what make the rest of the document
fall out rather than accumulate. Two things in particular are better than they
needed to be: D-10's suppression of `tool_call_start` alone is not just
sufficient but provably so, handler by handler; and the right rail is not a new
layout idea at all — `ScrollViewport` already ships the identical
`row → growing column + fixed strip` shape one level down, which turns the
riskiest-sounding part of the feature into the least risky.

What the review found was not architecture. It was **wiring**: three of the four
supported ways to turn parts of this feature off did the wrong thing (P0-1,
P1-1, P1-2, P1-8), the session round-trip named a file that does not participate
in it (P0-2), and the rail's row budget — as opposed to its column budget, which
is worked out to the last cell — was never derived at all (P1-3). That
distribution is worth naming, because it says where the remaining risk in the
implementation lives: not in `todo/normalize.ts`, which is fully specified and
fully tested, but in the eight existing files whose conventions this feature has
to join. Every finding above was reachable only by reading those files.

Both P0s and all eight P1s are resolved in the body of this v2. The eight P2s
are recorded in place as scope corrections and notes; none of them blocks
implementation, and none should be "cleaned up" without reading its paragraph.

### Conditions

1. **§7.2 is now the checklist, and `config/store.ts` is on it.** The two merge
   lines of §4.2 and the three call sites of §3.13 are the two places where a
   plausible implementation ships a silent, permanent, user-triggerable failure.
   AC-35 and AC-36 exist to make them impossible to skip; neither may be deferred
   to "a follow-up" without also deferring `/todo panel` and `/save`.
2. **`todoRailRows()` lands with the rail, not after it.** A rail that mounts
   against `viewportBudget` looks correct in every unit test and every
   single-agent manual run, and loses its overflow marker only when a `task`
   dispatch is live — a case that is easy to postpone and hard to notice. §8.3's
   manual case 1 is not optional.
3. **The four manual cases added to §8.3 are executed before the feature is
   called done**, on Windows Terminal *and* a legacy `cmd.exe`. Three of them
   (relaunch after `/todo panel off`, the wheel over the rail, and a
   Chinese-language session) are invisible to the entire unit suite by
   construction.

Nothing else is held back. §12's four open questions are correctly deferred, the
non-goals are the right non-goals, and `packages/core/` genuinely does not need
to change.
---

## 15. 实施过程发现的方案缺陷 (Issues Found During Implementation)

Six places where the design as written could not be executed verbatim. Each one
was corrected rather than worked around, and each correction is commented at the
site so the next reader finds the reasoning without this document.

**IF-1 · §3.14's log scope does not exist, and `logging/logger.ts` is not in the
change plan.** The spec writes `getLogger().debug('todo', 'todo_write', {...})`,
but `LogScope` is a CLOSED UNION (`cli` | `config` | `agent` | `tool` | `skills`
| `llm` | `migrate` | `log` | `history`) and §7.2 does not list that file. Team
mode faced exactly this choice and files its CLI-local events under `'agent'`
(`logging/install.ts::attachTeamEvents`), so `TodoStore.write()` does the same.
**Resolution:** scope `'agent'`, message `'todo_write'`. The record's shape and
the "counts only, never item text" rule of D-19 are unchanged. Adding a tenth
scope would be a one-line change to a file this feature otherwise does not
touch, and it would put todo records in a bucket no existing log filter names.

**IF-2 · AC-26 cannot be true as literally stated, because Ink owns the
truncation ellipsis.** `wrap="truncate"` resolves through `cli-truncate`, which
emits U+2026 whatever `caps.unicode` said. Every item row in the rail is
`wrap="truncate"` (that is P2-3's whole mitigation), so a long item on an ASCII
terminal puts one non-ASCII byte in the frame that no glyph table can reach.
**This is a codebase-wide property rather than anything this feature
introduced**: `TeamPanel`, `TranscriptList` and `StatusBar` all truncate the same
way today, and `team-panel.test.tsx` makes the same whole-frame ASCII claim —
which passes only because its fixtures happen to fit. **Resolution:** AC-26 is
asserted as written on content that fits (the markers, the header and the gauge
are all ASCII), plus a second case that pins the honest bound: the ONLY non-ASCII
byte a long ASCII-tier frame may contain is Ink's ellipsis. Changing that
belongs to a change in the entry layer, not here.

**IF-3 · The prompt block is ~1430 characters, not "under 1200".** §3.7 borrows
`buildTeamBlock`'s budget line, but the `<todo_planning>` block as SPECIFIED —
three bullet lists plus the `{{VISIBILITY}}` sentence — does not fit in it. The
block was not trimmed: every line in it changes a planning decision, which is
the test §3.7 actually states. **Resolution:** the bound is asserted at 1600,
with the reasoning recorded at the assertion. It exists so that adding a
paragraph stays a decision someone makes on purpose.

**IF-4 · §3.7's `panelVisible` has no path into the controller.** The spec
resolves it as `cfg.todo.panel && interactive && fullscreen`, but the controller
knows neither: `interactive` is a `makeController` parameter and `fullscreen`
comes from `decideRenderMode`, which `runInteractive` calls AFTER construction.
**Resolution:** a new `ControllerDeps.todoPanelCapable?: boolean`, defaulting to
`false` so a caller that forgets it gets the honest sentence rather than a false
claim about the user's screen. `makeController` computes it from
`opts.interactive` and its own `decideRenderMode` call; that function is pure, so
`runInteractive` calling it a second time with the same inputs is free. The
controller ANDs it with `config.todo.panel` at compose time, which is what makes
`/todo panel off` move the sentence too (D-25 is preserved: nothing re-composes
on a resize or an overlay).

**IF-5 · §3.5's store surface has no way to emit `{type:'rejected'}` for the two
refusals that never reach `write()`.** §3.8 requires a refused write to become a
`warn` notice, and §5.1 defines the event — but steps 1 and 2 of §3.3
(`TODO_OFF_REFUSAL`, `TOO_SMALL_REFUSAL`) return before the store is touched, so
nothing could emit it. Without a path, the one case where `todo_write` produces
nothing visible would be the case that most needs to be visible. **Resolution:**
`TodoStore.reject(reason)` — emit-only, no state change — called by those two
branches and internally by `write()` on zero survivors, so there is exactly one
emit path.

**IF-6 · §7.2 omits `src/ui/overlays/HelpOverlay.tsx`, and the omission is a
discoverability hole rather than a cosmetic one.** That file carries a
HAND-MAINTAINED command list — every other built-in is in it, `/team` included —
and §4.5 rules out a keybinding on the argument that "the slash palette is the
discoverable surface". The palette (which is registry-driven) picks `/todo` up
for free; the help overlay does not, so `?` would have listed every slash command
except this feature's. **Resolution:** one row added to `COMMANDS`, matching the
`/team` row's shape. No section of its own: `/plan` and `/team` earned theirs by
having tool-level vocabulary to explain, and `todo_write` needs no explanation
the model does not already carry.

### Found in the final code review (v2, pre-commit)

**IF-7 · The cap repair note double-counted whenever a payload was both dirty
and oversized.** `normalizeTodos` drops unusable entries first and caps second
(deliberately — the ordering `normalizeSubagentSpecs` records), but the cap's
note was denominated in `requested`, which is the length BEFORE the drop. A
payload of 25 entries with 2 blanks produced *"25 items were sent; the last 5
were dropped (maximum 20)"* — charging the cap for the two blanks the previous
note had already reported, and naming a number true of no suffix of the list
(the cap took 3 from the end; the blanks came from the middle). AC-2's fixture
is 23 well-formed items, where `requested` and `kept.length` coincide, so the
suite could not see it. **Resolution:** count off `kept.length`. The model reads
these notes to correct itself, so the arithmetic has to describe what happened.

**IF-8 · Two required-field widenings broke five test fixtures that no build
step typechecks.** `packages/cli/tsconfig.json` EXCLUDES `**/__tests__/**`, and
`vitest` transpiles without typechecking, so `npm run build` and `npm test` are
both green while `CliConfig.todo` (new, required) is missing from the four
`team-*.test.ts` config factories and `saveSession`'s new required `todos` is
missing from `team-session.test.ts`. This is **P1-5's failure mode reached by a
second route**: that finding was about `as unknown as AgentController` defeating
the compiler, and the change plan closed it for the two `FakeController`s; the
`tsconfig` exclusion defeats the compiler for the whole test tree and was not
considered. **Resolution:** the five fixtures are updated. Note that the test
tree has PRE-EXISTING errors of this shape (`app.test.tsx`,
`question-overlay.test.tsx`, `skills-*.test.ts`, `fetch-source.test.ts`,
`integrity.test.ts`), so "typecheck the tests" is a standing debt this feature
inherited rather than created — but it is the reason a required-field widening
here has no compile-time safety net, and the next one will need the same manual
sweep.

### Deviations that are NOT defects

- **Marker and index cells are fixed-width `<Box>`es rather than `padEnd`
  strings** (§6.1 describes them as `padEnd(3)` / `padStart(2)`). Ink lays a row
  out by MEASURED width, and the glyph tiers are not all one column — `[x]` is
  three — so a padded string in an auto-width child starts the next column a cell
  late for some markers and not others. The observable defect was a ragged
  checklist, which is the one thing a checklist cannot afford. The cell WIDTHS
  are exactly the spec's, and the padding rule survives inside them.

