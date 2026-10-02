# Team Subagents — design specification

> Feature slug: `team-subagents`
> Target: `@aragon-agent/cli` only. **Zero changes to `@aragon-agent/core`** (§2.5).
> Version: **v2** — design review applied (all P0 / P1 resolved; see 评审记录)
> Status: reviewed — 有条件通过 (see §12)
> Author: solution-architect node; reviewed by design-review node
> Related: [`plan-mode/spec.md`](../plan-mode/spec.md) (the human-input bridge,
> the tool-gate wrapper stack, the watchdog-pause contract),
> [`aragon-home-config-and-logging/spec.md`](../aragon-home-config-and-logging/spec.md)
> (the config-section discipline this feature's `team` section follows)

---

## 评审记录 (Review notes)

Design review performed against the working tree at `6c93652c`. Every claim the
v1 document made about existing code was checked against the file it names; the
inherited-constraint audit (§2) is **accurate as written except where noted
below**, which is unusually good and worth saying before the list of defects.

Severity: **P0** = would ship broken behaviour, or is unimplementable as
written. **P1** = would produce a wrong implementation, an untestable acceptance
criterion, or a user-visible defect. **P2** = precision / completeness, does not
block.

All P0 and P1 items are **resolved in the body of this v2**; the "Resolved in"
column names where.

### P0

| ID | Concern | Resolved in |
|---|---|---|
| **P0-1** | **The document never says how `task` reaches the tool array, and one existing test constrains the answer.** `tools.test.ts::C7` (lines 178-195) asserts `HOST_TOOL_NAMES` equals *what `createBuiltinTools` actually produces*. Adding `task` to `HOST_TOOL_NAMES` (I-7 / D-5) therefore forbids the controller from appending it after the factory returns — it must arrive through a factory option. v1's §7.2 also names the wrong test file: the partition assertion is in `__tests__/tools.test.ts` (I-P6), **not** `plan-gate.test.ts`, and three assertions there break, not one. | §3.3.0 (new), §7.2 |
| **P0-2** | **`/team on` mid-session is a dead end.** `controller.ts:155` builds `this.tools` **once** and its own comment (lines 168-177) forbids rebuilding it, because `Agent.setTools()` mutates the live `ToolRegistry` and `submit_plan` flips the mode from *inside* a tool execution. But `rebuildSystemPrompt()` **is** a live path, so v1's §4.5 + §4.6 combine to advertise `<team_mode>` and the `task` tool to a model that has no `task` registered — every call returns "unknown tool". This is the exact dead-end class the skills work spent a round removing. | §4.5 (rewritten), §3.3.0 |
| **P0-3** | **Children share the lead's `SkillRegistry`, and the `skill` tool mutates it.** v1 §3.4 hands each child the lead's `createSkillTools(...)` filtered to `['skill', 'skill_find']`. `skills/tools.ts:186` documents that `createSkillTool` calls `enterFrame()` on `service.getRegistry()` — the **lead's** registry. A child loading a skill therefore pushes a frame onto the lead's turn-scoped ceiling and triggers `onChange` → `refreshSkills()` → `rebuildSystemPrompt()`, changing what the *lead* may do after the report returns, non-deterministically, from three children at once. | §3.4 (skillTools bullet, rewritten), §11 follow-up 6 |
| **P0-4** | **The queued `--confirm` path repeats I-3 one level down.** v1 §3.11 races each queued request against `ctx.signal` but never pauses the **child's** idle watchdog. With `maxConcurrent: 3` and a user who takes four minutes over the first dialog, children 2 and 3 sit in the FIFO past their own 210 s `idleTimeoutMs`, self-abort, print `[Agent] idle watchdog fired` over the TUI, and land in the report as two spurious failures. `controller.ts:158-162` records fixing precisely this bug for the lead; the design reintroduces it for children. | §3.11 (`--confirm` paragraph) |

### P1

| ID | Concern | Resolved in |
|---|---|---|
| **P1-1** | **AC-13 is untestable as specified.** It asserts the scanner covers `src/team/**`, and I-6 says `team/` "is added to the scanner's scope", but §7.2 never modifies `glyphs.test.ts`. Separately, I-6 misstates the current scope: `glyphs.test.ts:174-177` scans `ui/`, `agent/`, `commands/`, `config/`, `tools/` **and** `cli.tsx` — and this feature modifies `commands/builtins.ts` and three `config/` files, all already in scope. | I-6 (corrected), §7.2 |
| **P1-2** | **No logging integration at all.** `logging/install.ts:305` exposes `attachAgentEvents(logger, controller)`, the seam every other subsystem uses, and `redact.ts` already scrubs secrets from records. Because `TeamEvent` is deliberately CLI-local (D-10), a dispatch leaves **zero** trace in the log file — while §11 follow-up 3 proposes a whole new flag to make bad reports debuggable. | §3.13 (new), §7.2, AC-17 |
| **P1-3** | **Child tool-policy refusals are misattributed to the lead.** Children are wrapped with the lead's `toolPolicy` *and* `onToolPolicyEvent` (§3.11). `evaluateToolCall` (core `tool-policy.ts:262`) returns a `notice` that names no agent, and `SkillRegistry`'s deny-escalation counter is turn-scoped on the lead — three children hitting the same refusal escalate three times as fast, and the user sees three unlabelled notices they cannot attribute. | §3.11 (skills-ceiling paragraph) |
| **P1-4** | **`--team` / `--no-team` needs both commander declarations, and `toFlags` must carry the field.** `cli.tsx:149` documents this exact failure — "the flag never reaches `CliFlags` and `--no-mouse` is inert — a failure with no compile error and no runtime error (P1-2)". Declaring only `--no-team` additionally makes `opts.team` default to `true`, which would silently override the config file on every run. | §4.4 (note added), §7.2 |
| **P1-5** | **A session saved mid-dispatch resumes with a card that never settles.** `session/persist.ts:20,56` writes `entries` verbatim and validates only array-ness on load. A `team` entry persisted with `active: true` resumes active; `Transcript`'s settled boundary is monotonic (`Transcript.tsx:249`), so the card spins for the rest of the session and never reaches `<Static>`. | §5.3 (normalize-on-load rule) |
| **P1-6** | **`subscribeTeam` breaks the `HeadlessController` seam.** `headless.ts:16` defines a deliberately minimal structural interface (`subscribe` only) that existing test stubs satisfy. §3.12 calls `controller.subscribeTeam(...)`; adding it as a **required** member breaks every stub. | §3.12 |

### P2 (accepted, not blocking)

| ID | Concern | Disposition |
|---|---|---|
| **P2-1** | The status bar's left cluster is `flexShrink={0}` (`StatusBar.tsx:131-132`), so `agents 3/5` does not shrink — it pushes the **right** cluster (context gauge, cost) off on an 80-column terminal. §6.4's degradation matrix covers the panel but never the status bar. | Addressed in §6.2 with a compact form; matrix row added. |
| **P2-2** | Children need a `providerRegistry`; §3.4 lists model / keys / timeouts but not the registry. `initProviders()` is per-controller and must be **reused**, not re-initialized per child. | One clause added to §3.4. |
| **P2-3** | If the API key is empty when `task` fires (settings-screen edit mid-session), all N children fail with N identical stream errors. `preflight()` only runs before the loop. | One guard added to §3.3 step 3. |
| **P2-4** | §1.2 / I-1 / D-4 cite `agent-loop.ts:210` and `:214` by line number; those drift. | Left as-is — the surrounding prose names the construct (`for…of` with an `await`; the steering checkpoint), which is what a reader matches on. |
| **P2-5** | `team_send` / `team_wait` are deliberately **not** added to `HOST_TOOL_NAMES` (they are never registered on a lead, so `skills doctor` should report a declaration naming them as unenforceable — which is true). | Stated explicitly in §3.3.0 so it is a decision rather than an omission. |

---

## 0. 需求映射 (Requirement trace)

The user's requirement is reproduced verbatim in the left column so that no
clause can be quietly dropped during implementation. Every row names the section
that discharges it and the acceptance criterion that proves it.

| # | 需求 (verbatim) | Discharged by | Proven by |
|---|---|---|---|
| R-a | 给现在的 Agent 添加 TEAM 的 subagents 模式 | §3 whole | AC-1 |
| R-b | 默认开启，可以在配置文件中打开 team 模式开关，默认是开启的 | §4.3 `team.enabled: true` | AC-2 |
| R-c | Agent 接到任务以后，自行判断是否需要派 subagents 去分别完成任务 | §4.6 `<team_mode>` prompt block + §4.1 `task` tool | AC-3 |
| R-d | 各 subagent 完成后，需要执行总结摘要，汇总给主 Agent | §3.7 dispatch report | AC-4 |
| R-e | Agent 之间需要有通讯工具……类似人类电话机制，但不能太频繁 | §3.6 TeamBus + §4.2 `team_send` / `team_wait` + rate limits | AC-5, AC-6 |
| R-f | 和 anthropic 的 claudecode 类似的 subagents 机制 | §1.2 (and where we deliberately differ: D-1) | AC-3 |
| R-g | 数量自适应，最大不超过 10 个，配置文件可配最大数量，一般 5 以内 | §3.5 + §4.3 `maxSubagents: 5`, hard ceiling 10 | AC-7 |
| R-h | 用户 TUI 界面上要有 subagents 执行的显示（当有的时候） | §6 TeamPanel + StatusBar cluster + TeamCard | AC-8, AC-9 |
| R-i | 美观、优雅、顶级设计，符合人机交互最佳实践 | §6 (degradation matrix, glyph discipline, motion budget) | AC-9, AC-13 |
| R-j | 稳健、可靠、顶级 | §3.8 ceiling matrix, §9 risk table, §8 test plan | AC-10 … AC-16 |

---

## 1. Overview

### 1.1 What is being built

AragonAgent today runs exactly one `Agent` instance per session: `AgentController`
constructs it, `runAgentLoop` drives one LLM → tool → LLM cycle at a time, and the
TUI renders that single stream. Any task with three independent halves is
therefore serialized through one context window — the model reads file A, then
file B, then file C, accumulating all three into one history it must keep
re-sending, and the wall-clock cost is the sum rather than the maximum.

**Team mode** gives the lead agent one new tool, `task`, which spawns up to
`team.maxSubagents` short-lived child agents, runs them concurrently against the
same working directory, and hands the lead back a single aggregated report of
what each one found or did. Each subagent is a full `Agent` from
`@aragon-agent/core` with its own message history, its own system prompt, and a
tool set built from the *same* factory the lead uses — minus `task` itself (no
recursion), minus the two human-input tools (no human is attached to a child),
plus two communication tools. The lead decides *whether* to fan out and *how
wide*; nothing forces delegation, and a session that never calls `task` is
byte-for-byte the session that exists today.

Two supporting mechanisms make the fan-out usable rather than merely possible.
First, a **dispatch report** (§3.7): every subagent's final message is captured,
bounded, and folded into one tool result together with per-agent status, timing,
token usage and the list of files each one touched — including a conflict warning
when two agents wrote the same path. Second, a **team bus** (§3.6): subagents can
send each other short, rate-limited messages, delivered by piggy-backing on the
recipient's next tool result, plus a blocking `team_wait` for genuine
request/response. The rate limits are the point, not an afterthought — the
requirement asks for "类似人类交流的电话机制，但不能太频繁", and an unbounded
message channel between five LLMs is a token bonfire.

### 1.2 Why this shape

Claude Code's subagent mechanism is the reference the requirement names, and the
model-facing shape here is deliberately close to it: a single delegation tool, a
one-line `description` naming the subagent's job, a free-form `prompt` carrying
its brief, a child that cannot delegate further, and a final text report that
comes back as the tool result. What a model already knows about Claude Code's
`Task` tool transfers directly.

The one visible difference is that **`task` takes a batch**. Claude Code emits N
parallel `Task` calls in one assistant turn and its harness executes them
concurrently; `agent-loop.ts:210` executes tool calls in a `for…of` with an
`await` inside, strictly sequentially. Five sequential `task` calls would produce
five *serial* subagents — the exact opposite of the feature — and making the core
loop concurrent is not an option, because `plan-mode/spec.md` §9.1 pins that
sequencing as invariant **I-P11**: the human-input bridge holds one outstanding
request slot and is correct *only* because tool calls never overlap. Breaking it
would silently mis-route a plan approval to a question wizard. So the batch lives
inside one tool call, where the fan-out is ours to schedule (D-1).

Everything else follows from constraints the codebase already documents, and §2
lists them before the design so that a reviewer can check the design against the
constraints rather than against taste.

### 1.3 Non-goals (v1)

- **Per-subagent model selection.** Every subagent runs the lead's model,
  provider and thinking level. A `model` field in the spec schema is a documented
  follow-up (§11), not a v1 field, because it multiplies the cost table, the
  preflight surface and the settings screen for a benefit nobody has asked for
  yet.
- **Nested delegation.** Subagents never receive `task` (D-3). Depth is capped at
  one, permanently, by construction rather than by a counter.
- **Mid-dispatch lead interaction.** The lead is blocked inside `task` for the
  duration; messages addressed to `lead` are surfaced live in the TUI panel and
  delivered in the report, not injected into the lead's history mid-tool (§3.6).
- **Persisting subagent transcripts.** `/save` stores the dispatch card and its
  summaries; the children's full histories are discarded when the dispatch ends.
- **Shared-file coordination.** No locking, no write queue. The prompt instructs
  disjoint file ownership and the report *reports* overlaps (§3.7); it does not
  prevent them. Anything needing shared mutable state is work the lead should do
  itself, and the prompt says so.
- **A subagent picker / editor overlay.** The panel is read-only.

---

## 2. Constraints inherited from the existing code

Read this section before §3. Each item is a property of code that already ships;
the design is shaped around them and several of them will silently break the
feature if a later refactor drops them.

**I-1 · Tool calls execute strictly sequentially.** `agent-loop.ts:210` runs
`for (const toolCall of toolCalls) { … await ctx.toolExecutor.execute(…) }`. This
is what forces `task` to be batch-shaped (D-1) and it is *also* the invariant the
plan-mode human bridge depends on (I-P11). Team mode must not weaken it: all
concurrency lives inside one tool execution.

**I-2 · `ToolExecutor`'s timeout is cooperative.** `executor.ts` aborts a
per-call `AbortController` and then keeps `await`ing the tool's promise — there is
no `Promise.race`. A tool that ignores `context.signal` is never timed out, and
any `toolTimeoutOverrides` entry for it is inert. `task` therefore *must* observe
`ctx.signal` itself, exactly as `bash-tool.ts` and the plan tools do.

**I-3 · The idle watchdog fires on event silence, not on inactivity.**
`Agent.emit()` kicks the watchdog; nothing else does. While the lead is blocked
inside `task`, the lead emits nothing, so a 6-minute dispatch under the default
`idleTimeoutMs` of 210 s is aborted at 210 s with a `[Agent] idle watchdog fired`
on stderr and no other explanation. The dispatch must run with the lead's
watchdog paused (§3.8) — this is the single most likely way to ship this feature
broken.

**I-4 · There is one human-input slot.** `App.tsx` holds `humanRequest` as a
single state slot and `resolveHuman` broadcasts one response to *every* pending
entry. Concurrent subagents that could each raise a confirm dialog would
double-resolve it. Team mode serializes subagent confirmations through
`TeamHumanQueue` (§3.11) and gives subagents no `ask_user` / `submit_plan` at all.

**I-5 · Core is host-agnostic and its export surface is frozen.**
`no-host-coupling.test.ts` forbids CLI/host imports and host-brand leakage inside
`packages/core/src/**`; `public-api.test.ts` freezes the runtime export list. The
team subsystem needs the CLI's filesystem/shell tools, so it *cannot* live in
core — and it does not need to. **This feature changes zero files under
`packages/core/`** and adds zero members to `AgentEvent`; team events travel on
their own emitter (§5.2).

**I-6 · Six trees are already ASCII-only, and `team/` is not yet one of them.**
`glyphs.test.ts:174-177` scans `ui/`, `agent/`, `commands/`, `config/`, `tools/`
and `cli.tsx`, and fails the build on a non-ASCII literal outside the exhaustive
`EXEMPT_FILES` list. Three of those six trees are modified by this feature
(`commands/builtins.ts` for `/team`, three `config/` files, `tools/index.ts`), so
every refusal string, help row and prompt block added there is ASCII **today**,
with no test change required.

`src/team/**` is a NEW tree and is therefore **not scanned by anything**. Adding
`rel.startsWith('team/')` to that `inScope` expression is a one-line change to
`glyphs.test.ts`, it is listed in §7.2, and without it AC-13 asserts a property
nothing checks. Every new glyph goes in `ui/glyphs.ts`, never in a component.

**I-7 · `SKILL_TOOL_FLOOR` and `PLAN_MODE_BLOCKED_TOOLS` partition
`HOST_TOOL_NAMES`.** Adding a host tool means classifying it into exactly one of
the two sets, in `tools/index.ts`, next to the other. `task` joins
`HOST_TOOL_NAMES` and `SKILL_TOOL_FLOOR` (D-5).

**I-8 · `buildSystemPrompt` is byte-identical when its optional blocks are
empty** (I-S1 / I-P1). The team block is spliced conditionally, the same way
`skillsBlock` and the plan block are, so a `team.enabled: false` session produces
the pre-team prompt byte for byte.

**I-9 · `ToolExecutor` truncates combined tool text at 100 000 BYTES**
(`DEFAULT_MAX_OUTPUT_SIZE`), appending `\n... [truncated]`. Report budgets are
therefore expressed in **bytes, not characters** — the same lesson the skills
work recorded as D19 (a 24 000-character CJK report is 72 000 bytes, and a
character-denominated cap would let the executor chop the report mid-section).

**I-10 · The full-screen bottom chrome is measured, not computed.**
`AppShell`'s layout effect writes `geometryRef.current.bottom` from
`measureElement(bottomRef)`, and the wheel router reads it to decide whether a
notch belongs to the transcript or to prompt history. Anything added to the
bottom chrome must live *inside* that measured box or the composer band boundary
goes stale the moment the panel appears (§6.1).

---

## 3. Technical design

### 3.1 Module map

```
packages/cli/src/team/               (new)
  limits.ts          TEAM_LIMITS + TEAM_SUBAGENT_TOOL_NAMES — the single authority on bounds
  types.ts           SubagentSpec / SubagentRun / TeamEvent / TeamSnapshot / DispatchOutcome
  normalize.ts       normalizeSubagentSpecs(raw, max) — pure repair, no throw
  prompt.ts          buildTeamBlock() (lead) + buildSubagentBlock() (child) — ASCII, versioned
  bus.ts             TeamBus — mailboxes, quotas, intervals, blocking waits
  human-queue.ts     TeamHumanQueue — serializes child confirmations onto the single human slot
  subagent.ts        createSubagent() — builds a child Agent + its tool set
  runtime.ts         TeamRuntime — dispatch scheduling, budgets, events, abort
  report.ts          buildDispatchReport() — the bounded text the lead receives
  task-tool.ts       the `task` AgentTool (lead-only)
  comm-tools.ts      `team_send` / `team_wait` (subagent-only)

packages/cli/src/ui/
  TeamPanel.tsx      (new) live roster in the bottom chrome
  entries/TeamCard.tsx (new) settled-dispatch transcript card
```

Dependency direction: `team/` imports from `@aragon-agent/core`, `config/`,
`tools/`, `logging/`, `agent/system-prompt.ts`. Nothing under `team/` imports
from `ui/`; the UI subscribes to `TeamEvent`s. Nothing in `core/` learns that
team mode exists.

### 3.2 The dispatch lifecycle

```
 lead Agent                task tool            TeamRuntime          child Agent(s)
     |                        |                      |                     |
  tool_call task(subagents[]) |                      |                     |
     |----------------------->|                      |                     |
     |                        | normalizeSubagentSpecs()                   |
     |                        |--- refuse if 0 survive -->  errorResult    |
     |                        | controller.withPausedWatchdog(...)  [I-3]  |
     |                        |--------------------->|                     |
     |                        |                      | emit dispatch_start |
     |                        |                      | for each slot (<= maxConcurrent):
     |                        |                      |   createSubagent()  |
     |                        |                      |-------------------->| agent.prompt(brief)
     |                        |                      |  <-- turn_end/tool events (per child)
     |                        |                      | emit agent_update / usage / message
     |                        |                      |  <-- agent_end      |
     |                        |                      | capture final text, filesTouched
     |                        |                      | start next queued slot
     |                        |                      | ... until all settled / aborted
     |                        |<---------------------| DispatchOutcome     |
     |                        | buildDispatchReport()|                     |
     |<-----------------------| textResult(report)   |                     |
  (loop continues; lead sees the report as a tool_result message)
```

Concurrency is a simple slot pool inside `TeamRuntime.dispatch()`: an index
cursor plus `maxConcurrent` in-flight promises, awaited with
`Promise.allSettled`. There is no worker abstraction, no queue class, and no
event-loop trickery; the whole scheduler is under 60 lines and every path is
observable from the event stream.

### 3.3.0 How `task` reaches the tool array (P0-1)

This is not a detail. `tools.test.ts::C7` asserts that `HOST_TOOL_NAMES` equals
**what `createBuiltinTools` actually produces** — it builds the factory with stub
skill and plan tools and compares the produced names to the constant. So the
moment `task` joins `HOST_TOOL_NAMES` (I-7 / D-5), appending it to the array
*after* the factory returns turns C7 red, with a failure message about two lists
of names that says nothing about team mode. The registration path is constrained,
and the constraint is worth stating before anyone writes the controller change.

**`task` arrives through a factory option, exactly as `skillTools` and
`planTools` do.** `BuiltinToolsOptions` gains one array:

```ts
/** Team-mode tools. The lead gets `[task]`; a subagent gets the two comm tools. */
teamTools?: AgentTool[];
```

Appended in the same place `planTools` is (`tools/index.ts:299`), i.e. **before**
the `toolPolicy` and `agentMode` wrappers, so the lead's `task` is covered by the
plan gate and the ceiling like everything else. One option serves both sides
because the two call sites are the lead's controller and `createSubagent`, and a
second option would be two names for "extra tools this caller supplies".

`policyExempt?: ReadonlySet<string>` is the second new option and it applies to
the ceiling wrapper only: `if (options.policyExempt?.has(t.name)) return t;`
inside the `toolPolicy` map. It exists for the child's comm tools (§3.11) and for
nothing else.

**Three assertions in `tools.test.ts` change, not one**, and they are the reason
this feature cannot half-land:

1. `SKILL_TOOL_FLOOR` exhaustive array equality (line 163) — add `'task'`.
2. **C7** (line 178) — the invocation gains `teamTools: [stub('task')]`.
3. **I-P6**, the partition assertion (line 201) — holds automatically once `task`
   is in both `HOST_TOOL_NAMES` and the floor, but it is the assertion that
   *forces* the classification, so it must be run, not just reasoned about.

`plan-gate.test.ts` does **not** contain the partition test and needs no change;
v1 named it in error.

**`team_send` / `team_wait` stay OUT of `HOST_TOOL_NAMES` (P2-5).** That constant
answers "can a skill's `allowed-tools` declaration ever take effect?", and these
two are never registered on a lead — a skill naming them genuinely is
unenforceable, so `aragon skills doctor` reporting it as such is correct rather
than a gap. They are reachable inside children through `policyExempt`, which is a
different mechanism answering a different question. C7 is unaffected because it
tests the invocation it is given.

### 3.3 The `task` tool (lead-only)

`team/task-tool.ts::createTaskTool(deps)` returns one `AgentTool`. Its
`execute` is the only place a dispatch begins, and it is written in the same
defensive order the plan tools use:

1. **Guard: already dispatching.** `if (deps.runtime.isBusy()) return
   textResult(BUSY_REFUSAL)`. Unreachable while I-1 holds; present so that the
   guarantee is a property of this module rather than a consequence of another
   package's loop shape.
2. **Guard: team mode turned off mid-session.** `if (!deps.isTeamEnabled())
   return textResult(TEAM_OFF_REFUSAL)`. `task` is registered once at
   construction and the array is immutable (§4.5), so `/team off` cannot
   unregister it; it flips this closure instead. Read live, never cached.
3. **Guard: no usable key (P2-3).** `if (!deps.hasApiKey()) return
   textResult('Team dispatch skipped: no API key for <provider>. Do this work
   yourself, or ask the user to set a key.')`. `preflight()` runs before the
   loop, not before a tool call, and a key emptied through the settings screen
   mid-session would otherwise produce N identical stream failures — N times the
   cost of one refusal, and a report the model may well retry.
4. **Normalize.** `normalizeSubagentSpecs(params.subagents, cfg.maxSubagents)`.
   Repair, never reject (§3.3.1). Zero survivors is the single hard failure →
   `errorResult('No usable subagent specs: each needs a description and a prompt.')`.
5. **Pause the lead watchdog and run.** `await deps.withPausedWatchdog(() =>
   deps.runtime.dispatch(specs, ctx.signal))`. `try/finally` inside
   `withPausedWatchdog`, so a throw cannot leave the watchdog disarmed for the
   rest of the run — the same discipline `withHumanWait` already applies.
6. **Report.** `return textResult(buildDispatchReport(outcome))`. **Always a
   non-error result**, including on abort and on all-children-failed: a
   cancellation or a partial result rendered as a tool failure invites the model
   to retry the whole fan-out, which is the most expensive possible reaction
   (same reasoning as `ask_user`'s cancelled shape).

`ctx.signal` is observed in two places: `runtime.dispatch` registers an
`abort` listener that calls `abortAll()`, and each child's `prompt()` is raced
against its own per-subagent deadline. Per I-2 this is the *only* thing that
makes the `toolTimeoutOverrides: { task: dispatchTimeoutMs }` entry mean
anything.

#### 3.3.1 Normalization rules (`normalizeSubagentSpecs`)

Modelled directly on `human-input.ts::normalizeQuestions`, including the reason
it exists: **the schema declares shape, not policy** (P0-4). `type` / `required`
stay in the JSON Schema; every bound lives in the `description` (which is what
the model reads) and is enforced here (which is deterministic and unit-tested).
Putting `maxItems: 10` in the schema would behave differently depending on
whether `ajv` — an *optional* dependency of core — happened to install.

1. **Drop first, cap second.** Filter blank/unusable entries, *then* slice to
   `max`. Capping first would let a blank entry consume a slot the model meant
   for real work.
2. `description` — required, non-empty, clamped to
   `TEAM_LIMITS.descriptionChars` (60). Empty ⇒ drop the spec.
3. `prompt` — required, non-empty, clamped to `TEAM_LIMITS.promptChars` (8000).
   Empty ⇒ drop the spec.
4. `label` — optional; slugified to `[a-z0-9-]{1,12}`; defaults to `a<index+1>`.
   Deduplicated case-insensitively by appending `-2`, `-3`… Two agents the user
   cannot tell apart in the panel is worse than an ugly label.
5. `readOnly` — optional boolean, default `false`. `true` builds that child with
   the plan-mode gate forced on regardless of session mode (§3.11), which is the
   cheap way for a lead to say "just go read things".
6. Cap to `min(max, TEAM_LIMITS.hardMaxSubagents)` where `hardMaxSubagents = 10`
   — the requirement's ceiling, enforced here as well as in the config clamp so
   that a hand-edited config file cannot raise it (R-g).

Truncation is silent to the model but **visible to the user**: the panel and the
report both state `n of m requested` whenever `n < m`, so a clipped dispatch
cannot masquerade as complete.

### 3.4 Subagent construction (`team/subagent.ts`)

```ts
createSubagent(spec, deps): { agent: Agent; unsubscribe: () => void; run: SubagentRun }
```

- **Tools.** `createBuiltinTools({ … })` — *the same factory the lead uses*, with:
  - `teamTools: [makeTeamSend(bus, key), makeTeamWait(bus, key)]`
  - `planTools: []` (no human is attached; registering tools a child could never
    use burns a turn — the same argument that keeps them out of headless mode)
  - `skillTools: [skillFindTool]` — **`skill_find` only, and this is a
    correctness boundary rather than a conservatism (P0-3).** `skill_find` is a
    pure registry lookup. `skill` is not: `skills/tools.ts:186` records that
    `createSkillTool` calls `enterFrame()` on the registry it is handed, and the
    only registry in the process is the **lead's** — `AgentController` owns one
    `SkillService` and `createSkillTools` closes over `service.getRegistry()`.
    A child loading a skill would therefore push a frame onto the lead's
    turn-scoped ceiling, narrowing what the *lead* may do once the report
    returns, and fire `onChange` → `refreshSkills()` → `rebuildSystemPrompt()`
    — rewriting the lead's system prompt from inside the tool call the lead is
    blocked in. Three children doing it concurrently interleave on one frame
    stack. Nothing in the child's own report would show any of it.

    The capability is not simply dropped: the lead's `alwaysBlock()` (the
    always-on skills, already computed for the lead's own prompt) is spliced into
    every child's system prompt, so global skill knowledge still reaches
    children — they just cannot *load a new frame* from inside one. A child that
    needs a specific skill body says so in its summary and the lead loads it. A
    child-local frame stack is a bounded follow-up (§11 item 6), not v1.

    `skill_install` / `skill_create` are excluded for the original reason: they
    mutate the user's skill root and route to an approval gate no child can
    reach.
  - `agentMode: () => spec.readOnly ? 'plan' : deps.getMode()` — read live, never
    cached, so a mid-dispatch `Shift+Tab` to PLAN tightens every running child at
    its next tool call (tightening is always safe; §3.11).
  - `toolPolicy` / `onToolPolicyEvent`: the lead's closures, so the skills
    ceiling is *re-applied* one level down rather than bypassed (D-5).
  - `policyExempt: TEAM_SUBAGENT_TOOL_NAMES` (new option, §7): `team_send` /
    `team_wait` are not in the lead's registered tool list, so evaluating them
    against the lead's ceiling would refuse them and dead-end comms.
  - `confirm:` the queued confirmation (§3.11), only when `confirmTools` is on.
  - **No `task`.** Depth cap by construction (D-3).
- **System prompt.** `buildSystemPrompt({ cwd, tools, skillsBlock, agentMode,
  planInteractive: false, subagentBlock: buildSubagentBlock({ label, description,
  peers, mail, summary }) })`. The `subagentBlock` parameter is new and spliced
  conditionally, preserving I-8 for the lead.
- **Model / keys / timeouts.** Copied from the lead's `CliConfig`:
  same `providerId` / `modelId` / `baseUrl`, same `getApiKey` closure (so a
  settings-screen key edit reaches children too), `toolTimeout` =
  `config.toolTimeoutMs`, `idleTimeout` = `config.idleTimeoutMs`.
  **`providerRegistry` is the lead's instance, reused, not a fresh
  `initProviders()` per child (P2-2)** — the registry holds adapter state and
  constructing five of them per dispatch is pure waste.
  Children keep their *own* idle watchdogs — that is a feature: a wedged child is
  aborted by its own watchdog without touching the dispatch.
- **Instrumentation.** One `agent.subscribe` per child translates core events into
  `SubagentRun` mutations and `TeamEvent`s:

  | core event | recorded |
  |---|---|
  | `turn_start` | `phase = 'thinking'` |
  | `turn_end` | `turns++`, `usage +=`, turn-cap check (§3.5) |
  | `tool_execution_start` | `phase = 'tool'`, `lastTool = toolName`, `toolCalls++`, and for `write_file` / `edit_file` push `args.path` into `filesTouched` (deduped, capped at 30) |
  | `tool_execution_end` | flush the mailbox tail (§3.6) |
  | `message_update` `error` | `lastError = formatStreamError(...)` |
  | `agent_end` | capture the final assistant text as `summary`; `phase = 'done'` |

  `filesTouched` is derived here and nowhere else, and it is the input to the
  conflict warning in §3.7. It is best-effort by construction (a child that
  writes through `bash` is invisible to it) and the report says so rather than
  implying completeness.

### 3.5 Concurrency, budgets and ceilings

| Bound | Key | Default | Clamp | Enforced by |
|---|---|---|---|---|
| Subagents per dispatch | `team.maxSubagents` | 5 | [1, 10] | `clampTeamConfig` + `normalizeSubagentSpecs` |
| Concurrent children | `team.maxConcurrent` | 3 | [1, 10], then `min(maxSubagents)` | slot pool in `TeamRuntime` |
| One child's wall clock | `team.subagentTimeoutMs` | 300 000 | [30 000, 1 800 000] | per-child `setTimeout` → `agent.abort()` |
| Whole dispatch wall clock | `team.dispatchTimeoutMs` | 900 000 | [60 000, 3 600 000] | `toolTimeoutOverrides.task` **and** a runtime timer (I-2: the executor's abort is only honoured because the tool listens) |
| Turns per child | `team.maxTurnsPerSubagent` | 24 | [4, 100] | `turn_end` counter → `agent.abort()`, run marked `truncated` |
| Report size | `TEAM_LIMITS.reportMaxBytes` | 48 000 | — | `buildDispatchReport` (bytes; I-9) |
| One summary | `TEAM_LIMITS.summaryMaxBytes` | 6 000 | — | `buildDispatchReport` |

**Adaptivity (R-g)** is a two-layer arrangement, and it matters that they are
separate. The *count* is chosen by the model, guided by the prompt block (§4.6),
which is where "自适应" actually lives: the lead sees the task and decides that
three files need reading in parallel, or that this is a one-line fix and no
delegation is warranted. The *ceiling* is mechanical: `maxSubagents` clamps the
count, and `hardMaxSubagents = 10` clamps the clamp. A model asking for 30
subagents gets 5 and a line in the report saying so; it is never an error,
because a refusal here costs a full research turn to regain nothing.

`maxConcurrent` exists separately from `maxSubagents` because provider rate
limits are real: five simultaneous streams against one API key is a reliable way
to collect HTTP 429s, and `formatStreamError` will render each one into the
report as a failed subagent. Three in flight, five total, is the shape that
survives a normal account.

### 3.6 The team bus (`team/bus.ts`)

The requirement asks for "类似人类交流的电话机制，但不能太频繁". The design
takes both halves literally: there is a real channel, and it is expensive on
purpose.

**Addressing.** Every participant has a stable key: `lead`, or a subagent's
`label`. `team_send` accepts `to: "<label>" | "lead" | "all"`.

**Delivery — piggy-back, not interrupt.** A message for child B is appended to B's
**next tool result**, wrapped in a `<team_mail>` block, by
`withMailboxTail(tool, bus, key)` — a `{...tool, execute}` wrapper in the same
family as `withConfirmation` / `withToolPolicy` / `withPlanModeGate`. This is the
central design choice of §3.6 and it is worth stating why the obvious alternative
is wrong: `Agent.steer()` looks like the natural push channel, but
`agent-loop.ts:214` treats steering arriving mid-batch by pushing
`'Tool execution skipped due to steering interrupt.'` for **every remaining tool
call in that batch**. A chatty peer would therefore cancel its colleague's work
as a side effect of saying hello. Piggy-backing costs zero extra turns, cannot
interfere with the loop, and is guaranteed to be seen by any child that is doing
anything at all.

**Delivery — blocking.** `team_wait(fromLabel?, timeoutSeconds)` is the
request/response half of the phone metaphor. It resolves on the first matching
message, on `ctx.signal`, or on its own deadline, and it runs with **that child's**
idle watchdog paused (`agent.pauseIdleWatchdog()` / `resume` in a `try/finally`)
— the same treatment `withHumanWait` gives an overlay, and for the same reason:
a deliberate wait is not a wedged tool. The clamp is [5, 120] seconds, always
also bounded by `subagentTimeoutMs`.

**Rate limits — the "不能太频繁" clause.**

| Rule | Value | Behaviour on breach |
|---|---|---|
| Messages per child per dispatch | 6 | `textResult` (non-error) naming the quota; the model is told to finish and report instead |
| Minimum interval between one child's sends | 15 s | `textResult` stating how many seconds remain |
| `to: "all"` cost | 2 quota units | — |
| Subject / body size | 80 / 800 chars | clamped, not rejected |
| Total messages per dispatch | 24 | further sends refused for everyone |

Every refusal is a **non-error** `textResult`. An `errorResult` here would read as
a malfunction and invite an immediate retry — precisely the "太频繁" behaviour
being designed out.

**Messages to `lead`** are queued into `outcome.leadMail` and appear in a
dedicated section of the report (§3.7), plus live in the TUI panel as a
`mail N` counter and a one-line latest-message preview. The lead cannot consume
them mid-dispatch because it is blocked inside `task` (§1.3), and pretending
otherwise would be worse than saying so.

### 3.7 The dispatch report (`team/report.ts`)

One `textResult` string, budget `reportMaxBytes` (bytes — I-9), assembled in a
fixed order so a model that has seen one report can parse every future one:

```
Team dispatch: 3 of 3 subagents finished (2 ok, 1 failed) in 84.2s.
Tokens: in 41.2K, out 8.9K. Cost: $0.24.
WARNING: agents "api" and "docs" both wrote src/routes.ts - review before trusting either.

### a1 "read the auth middleware"  [ok]  22.1s, 4 turns, 7 tools
files: src/auth/mw.ts, src/auth/session.ts
<summary text, clamped to summaryMaxBytes>

### a2 "map the route table"  [ok]  31.6s, 6 turns, 11 tools
...

### a3 "check the migration"  [failed: idle watchdog aborted the run]  84.0s, 2 turns
<partial summary if any>

### Messages to you
[a1 -> lead] "auth uses a second session store" (12s in)
```

Assembly rules:

- **Header first, always.** If the byte budget is exhausted, the *summaries* are
  trimmed (longest first, each to a floor of 400 bytes, with an explicit
  `[trimmed]` marker); the header, the per-agent status lines and the conflict
  warning are never dropped. A report that loses its own failure count is worse
  than one that loses prose.
- **Conflict detection** is a set intersection over `filesTouched`, emitted only
  when non-empty, and phrased as a warning rather than a fact ("review before
  trusting either") because `filesTouched` cannot see writes made through `bash`.
- **A failed child never fails the dispatch.** Its section carries
  `[failed: <reason>]`, the others are unaffected, and the tool result is still
  non-error.
- **Aborted dispatches** get `Team dispatch ABORTED after 12.0s; partial results
  below.` as the first line, so the model does not present partial work as
  complete.
- **Truncated fan-out** (`n of m requested`) is stated in the header, per §3.3.1.

### 3.8 Watchdog, abort and timeout matrix

The single most dangerous property of this feature is that a long dispatch looks
exactly like a hung agent to three independent ceilings. All three are addressed
explicitly:

| Ceiling | Would fire at | Handled by |
|---|---|---|
| Lead idle watchdog (I-3) | `idleTimeoutMs` (default 210 s) of event silence | `withPausedWatchdog` wraps the whole dispatch; `try/finally` |
| Lead `ToolExecutor` timeout (I-2) | `toolTimeoutMs` (default 180 s) | `toolTimeoutOverrides: { task: team.dispatchTimeoutMs }` **and** `task` observing `ctx.signal` |
| Child idle watchdog | `idleTimeoutMs` per child | Left ARMED on purpose: a wedged child should die without taking the dispatch with it. Its `agent_end` arrives with no summary → `[failed: run produced no output]` |

`withPausedWatchdog<T>(fn)` is extracted from the existing
`AgentController.withHumanWait`, which becomes a one-line alias
(`withHumanWait = withPausedWatchdog`). Renaming the callers is deliberately *not*
part of this change: the plan tools and the `--confirm` gate keep the name that
describes what they do, and the new name describes what the mechanism does.

**Abort propagation.** `Esc` → `App` → `controller.abort()` → core aborts →
`ctx.signal` on the in-flight `task` → `runtime.abortAll()` → per-child
`agent.abort()` + bus `cancelAllWaits()` → children settle → `task` returns a
partial report. `AgentController.abort()` additionally calls
`teamRuntime.abortAll()` directly, as deliberate redundancy: the signal path is
correct today, and the direct call makes "no child survives its dispatch" a
property of the controller rather than a consequence of signal plumbing three
modules away (the same argument `App.tsx` records for `cancelPendingHuman()` on
`agent_end`).

**Process exit.** `TeamRuntime.dispose()` is called from the App's unmount
cleanup and from `cli.tsx`'s exit path; it aborts everything and clears timers.

### 3.9 Usage and cost roll-up

Child `turn_end` usage is real spend and must appear in the status bar, or the
session cost readout under-reports by however much the team consumed — the single
most misleading possible failure of this feature.

Each child's `turn_end` becomes `TeamEvent{ type: 'usage', usage }`; `App`
dispatches `{ type: 'teamUsage', usage, costDelta: computeCost(usage,
controller.getModelInfo().cost) }`; the reducer adds it to `usageTotal` **and to
nothing else**. In particular it must not touch `contextTokens`: that gauge shows
the *lead's* context occupancy against the model's window, and folding children
into it would show 180 % on a perfectly healthy session.

Headless mode adds the same totals into its `[usage]` footer, by the same event.

### 3.10 Config resolution

`team` becomes the **fourth nested section** of the persisted config, after
`apiKeys`, `skills` and `log` — and, like `log`, it is **scalars only, exactly one
level deep**. `store.ts`'s header states that its hand-written merge is only
correct at one level; a nested field here means replacing that merge first. The
section is added to both merge sites (`loadPersistedConfig`,
`updatePersistedConfig`) with `clampTeamConfig`, for the reason that header
gives: hardening only the read path leaves a bad value on disk that reverts every
launch, which presents to the user as "my setting won't stick".

Resolution order matches every other field — defaults › file › env › flags:

```
team.enabled       DEFAULT(true) › file.team.enabled › ARAGON_TEAM › --team / --no-team
team.maxSubagents  DEFAULT(5)    › file.team.maxSubagents › ARAGON_TEAM_MAX › --team-max <n>
(the remaining four keys are file-only; they are tuning knobs, not session switches)
```

`ARAGON_TEAM` is parsed with the **positive** list (`1/true/on/yes`), matching
`ARAGON_FULLSCREEN` / `ARAGON_MOUSE` / `ARAGON_PLAN`, not the negative-list
`envBool` used by the log section. `load.ts` already documents why those two
readers disagree and why copying the wrong one ships a documented-but-dead env
var.

### 3.11 Interaction with plan mode, the skills ceiling, and `--confirm`

**Plan mode.** `task` joins `SKILL_TOOL_FLOOR`, i.e. plan mode permits it, and
children built during a PLAN session receive `agentMode: () => 'plan'` through the
same closure the lead uses — so all five mutating tools are refused inside every
child, by the same `withPlanModeGate` wrapper, with the same refusal text. The
read-only guarantee therefore holds one level down *by construction*, and parallel
research (plan mode's best use) becomes dramatically better rather than being
blocked. Two consequences to preserve:

- The `PLAN_MODE_BLOCKED_TOOLS` ∪ `SKILL_TOOL_FLOOR` = `HOST_TOOL_NAMES`
  partition test must be updated in the same commit that adds `task` to
  `HOST_TOOL_NAMES` (I-7), or the build fails — which is the point.
- `spec.readOnly: true` forces `'plan'` for one child even in a BUILD session.
  Tightening only; there is no field that loosens a child relative to its lead.

**Skills tool ceiling.** Child tools are wrapped with the lead's `toolPolicy`
closure, so a skill that declared `allowed-tools: [read_file, grep]` constrains
the children too — delegation is not a ceiling bypass. The two comm tools are
exempt via `policyExempt` because they are not in the lead's registered tool list
and would otherwise be refused, dead-ending the channel (the same dead end the
floor exists to prevent).

**The notify channel is decorated, not shared verbatim (P1-3).** `evaluateToolCall`
(core `tool-policy.ts:262`) returns a `notice` naming a tool and a skill but no
agent, and `SkillRegistry`'s deny-escalation counter is turn-scoped on the lead.
Passing the lead's `onToolPolicyEvent` straight through would therefore surface
three unlabelled "Blocked bash: …" notices the user cannot attribute to anything,
and would advance the escalation counter three times for what is one refusal
repeated across three agents. So each child receives a wrapper:

```ts
onToolPolicyEvent: (e) => deps.onChildToolPolicyEvent({ ...e, label: spec.label })
```

which renders as `[a2] Blocked bash: …` and — the part that matters — **does not
advance the lead's escalation counter**. The escalation line exists to tell one
agent to stop retrying one tool; a child cannot retry the lead's turn, and
letting children spend the lead's budget makes the escalation fire on the lead's
*next* legitimate call.

**`--confirm`.** When `confirmTools` is on, child mutating tools are wrapped with
`withConfirmation` using a **queued** confirm: `TeamHumanQueue` is a promise chain
(`this.tail = this.tail.then(() => run())`) that admits one request at a time and
prefixes the summary with the child's label — `[a2] Write: src/routes.ts`. This is
what makes concurrency safe against I-4. The queue is FIFO, its depth is bounded
by `maxConcurrent`, and each queued request still races the child's `ctx.signal`,
so an abort does not leave a dialog owed an answer.

**Queued children pause their own watchdogs, and this is I-3 one level down
(P0-4).** A child whose confirm request is sitting behind two others in the FIFO
is emitting nothing, and its own `idleTimeout` (210 s by default) is armed. A
user who takes four minutes over the first dialog therefore loses children 2 and
3 to their own watchdogs, each printing `[Agent] idle watchdog fired` over the
TUI and each landing in the report as a failure that has nothing to do with the
work. `controller.ts:158-162` records fixing exactly this for the lead's
`--confirm` gate; repeating it for children would be a regression of a fix the
codebase already paid for.

So `TeamHumanQueue.request(childAgent, req)` pauses that child's watchdog
**on enqueue, not on display** — the wait starts when the promise is chained, not
when the dialog appears — and resumes it in a `finally`, mirroring
`withPausedWatchdog`'s discipline:

```ts
child.pauseIdleWatchdog();
try { return await this.enqueue(() => confirm({ ...req, summary: `[${label}] ${req.summary}` })); }
finally { child.resumeIdleWatchdog(); }
```

`team_wait` (§3.6) already applies the same rule for the same reason; these are
the only two places a child blocks on something that is not its own LLM or tool.

### 3.12 Headless (`-p` / `--print`)

Team mode is **on** in headless: fan-out needs no human. What changes:

- No `ask_user` / `submit_plan` anywhere (already true).
- `DENY_ALL_APPROVAL` means `skill_install` inside a child is refused — also
  already true, one level down.
- `--confirm` in headless auto-approves through the existing `confirm` fallback;
  the queue is still used, which costs nothing and keeps one code path.
- `runHeadless` prints one stderr line per child transition when not `--quiet`:
  `[team] a1 start "read the auth middleware"` / `[team] a1 ok 22.1s 7 tools`.
  This uses the same `TeamEvent` stream the TUI uses, via
  `controller.subscribeTeam(...)`.

**`subscribeTeam` is OPTIONAL on the seam (P1-6).** `headless.ts:16` defines
`HeadlessController` as a deliberately minimal structural interface — today just
`subscribe(listener)` — precisely so tests can satisfy it with an object literal.
Adding a required member breaks every existing stub for no benefit, and the
subscription is genuinely optional: a controller with no team runtime has no team
events. So the interface gains

```ts
subscribeTeam?(listener: (event: TeamEvent) => void): () => void;
```

and `runHeadless` calls it with `controller.subscribeTeam?.(…)`, keeping the
`--no-team` headless path byte-identical to today's.

### 3.13 Logging (P1-2)

`logging/install.ts:305` already exposes `attachAgentEvents(logger, controller)`,
the seam through which every other subsystem's events reach the log file, and
`logging/redact.ts` already scrubs registered secrets out of records. Because
`TeamEvent` is deliberately CLI-local (D-10), a dispatch would otherwise leave
**no trace whatsoever** in the log — which is the wrong outcome for the one
feature in this CLI that runs five agents the user cannot see.

`attachTeamEvents(logger, controller)` sits beside `attachAgentEvents` and is
installed from the same place, mapping the stream to structured records:

| Event | Level | Record |
|---|---|---|
| `dispatch_start` | `info` | `{ dispatchId, requested, accepted, labels }` |
| `agent_update` (phase transitions only) | `debug` | `{ dispatchId, label, phase, lastTool }` |
| `message` | `debug` | `{ dispatchId, from, to, subject }` — **subject only, never the body** |
| `dispatch_end` | `info` | `{ dispatchId, durationMs, ok, failed, aborted, usage, filesTouched }` |

Two rules, both about not turning a log into a liability:

- **Subagent prompts and summaries are logged at `trace` only**, and go through
  `redactText` like everything else. A `prompt` is up to 8 000 characters of
  whatever the lead decided to say; at `debug` it would dominate the file.
- **`agent_update` is logged on phase transitions, not on the 120 ms throttle
  tick** (§5.2). The throttle exists to protect React; the log needs less than
  that, and five children at 8 events/second each is 40 lines/second of noise
  that would push the retention window down to minutes.

This also retires most of §11 follow-up 3's motivation: the common "why was that
report useless?" question is answered by `aragon logs tail --level debug`, not by
a new flag and a new file format.

---

## 4. Interface design

### 4.1 `task` — the delegation tool (lead only)

**Name.** `task`, matching Claude Code's vocabulary (R-f). **Label.** `Dispatch
subagents`.

```jsonc
{
  "type": "object",
  "properties": {
    "subagents": {
      "type": "array",
      "description":
        "2-5 independent subagents to run in parallel (hard maximum 10; extras are dropped).",
      "items": {
        "type": "object",
        "properties": {
          "label":       { "type": "string",  "description": "Short id, <= 12 chars, e.g. \"api\". Shown in the UI." },
          "description": { "type": "string",  "description": "<= 60 chars. What this subagent is for." },
          "prompt":      { "type": "string",  "description": "The full brief. Self-contained: the subagent cannot see this conversation." },
          "readOnly":    { "type": "boolean", "default": false, "description": "Refuse all writes and shell for this subagent." }
        },
        "required": ["description", "prompt"]
      }
    }
  },
  "required": ["subagents"]
}
```

`description` (the model-facing text, abbreviated here; the full string lives in
`task-tool.ts`):

> Run several independent subagents in parallel and get one combined report.
> Each subagent is a fresh agent with the same tools and working directory but
> NO memory of this conversation — its `prompt` must be self-contained. Use this
> when a task splits into 2 or more parts that do not depend on each other's
> output, especially reading or searching several areas at once. Do NOT use it
> when one part needs another part's result (do those yourself, in order), when
> two parts would edit the same file, or for a change small enough to just make.
> Subagents cannot dispatch further subagents and cannot ask the user anything.
> Give each a `description` of at most 60 characters and a complete `prompt`.
> Beyond `maxSubagents` entries are dropped, so keep within it.

### 4.2 `team_send` / `team_wait` (subagent only)

```jsonc
// team_send
{ "type": "object",
  "properties": {
    "to":      { "type": "string", "description": "A peer label, \"lead\", or \"all\"." },
    "subject": { "type": "string", "description": "<= 80 chars." },
    "body":    { "type": "string", "description": "<= 800 chars." }
  },
  "required": ["to", "subject", "body"] }

// team_wait
{ "type": "object",
  "properties": {
    "from":           { "type": "string", "description": "Only accept a message from this label. Omit for any." },
    "timeoutSeconds": { "type": "number", "default": 30, "description": "5-120." }
  } }
```

Model-facing guidance, embedded in both descriptions:

> Message a teammate only when it changes what they should do — a finding they
> would otherwise duplicate, or a file you are about to change. You get 6
> messages for this whole task and at most one every 15 seconds; spending them on
> status updates means you cannot send the one that matters. Incoming messages
> are appended to your next tool result automatically; you do not need to poll.

Result shapes (all `textResult`, never `errorResult`):

- sent → `Delivered to a2. 4 of 6 messages left.`
- rate-limited → `Not sent: one message every 15s. Try again in 9s, or continue and report instead.`
- quota exhausted → `Not sent: message quota spent (6/6). Finish your work and put it in your final summary.`
- unknown recipient → `Not sent: no subagent labelled "a9". Teammates: a1, a2, lead.`
- `team_wait` timeout → `No message arrived within 30s. Continue without it.`

### 4.3 Config keys (`config.json`, section `team`)

| Key | Type | Default | Clamp | Meaning |
|---|---|---|---|---|
| `team.enabled` | boolean | **`true`** | — | Register `task` at all (R-b) |
| `team.maxSubagents` | number | `5` | [1, **10**] | Hard cap per dispatch (R-g) |
| `team.maxConcurrent` | number | `3` | [1, 10] ∧ ≤ `maxSubagents` | In-flight children |
| `team.subagentTimeoutMs` | number | `300000` | [30 000, 1 800 000] | One child's wall clock |
| `team.dispatchTimeoutMs` | number | `900000` | [60 000, 3 600 000] | Whole dispatch |
| `team.maxTurnsPerSubagent` | number | `24` | [4, 100] | Runaway-loop cap |

`aragon config set team.enabled false` and `aragon config get team.maxSubagents`
work through the dotted-key table in `config/cli-commands.ts`, extended alongside
`LOG_CONFIG_SET_KEYS` with `TEAM_CONFIG_SET_KEYS`.

### 4.4 CLI flags and environment

| Flag | Env | Effect |
|---|---|---|
| `--team` | `ARAGON_TEAM=1` | Force team mode on for this run |
| `--no-team` | `ARAGON_TEAM=0` | Force it off (the `task` tool is not registered at all) |
| `--team-max <n>` | `ARAGON_TEAM_MAX=<n>` | Override `maxSubagents` for this run (still clamped to 10) |

`--no-team` produces a tool array **byte-identical to the pre-team build** — the
same `I-S1`-style provable claim the skills work made for `--no-skills`, and the
same reason: it turns "the off switch really is off" from an argument into an
object-identity assertion (AC-11).

**Both commander options must be declared, and `toFlags` must carry the field
(P1-4).** `cli.tsx:149` documents this failure in the codebase's own words —
"Without this line the flag never reaches `CliFlags` and `--no-mouse` is inert —
a failure with no compile error and no runtime error (P1-2)." Two concrete
requirements follow, and neither is optional:

1. Declare **`--team` and `--no-team` as a pair**, mirroring
   `--mouse` / `--no-mouse` and `--plan` / `--no-plan`. Declaring only the
   negative form makes commander default `opts.team` to `true`, at which point
   the flag is indistinguishable from its own default and would override
   `config.json` on **every** run. (`--no-skills` gets away with being declared
   alone only because `load.ts:287` gates on the one-directional
   `flags.skills === false`.)
2. Resolve with `flags.team !== undefined ? flags.team : …`, the shape
   `resolveMouse` uses at `load.ts:123` — not a truthiness check, which cannot
   tell `--no-team` from "not passed".

`--team-max <n>` is a value flag and needs neither.

### 4.5 Slash command `/team`

```
/team              -> status: on/off, max, concurrency, and the live roster if a dispatch is running
/team on | off     -> flip for this session (when possible - see below) and persist
/team max <n>      -> set maxSubagents (clamped, persisted)
```

**The tool array is immutable for the life of the session, and `/team on` must
not pretend otherwise (P0-2).** `controller.ts:155` builds `this.tools` once, and
lines 168-177 of that file state why it can never be rebuilt: `Agent.setTools()`
unregisters and re-registers entries in the live `ToolRegistry`, and `submit_plan`
flips the session mode from *inside* a tool execution, so a rebuild at that
moment mutates the registry mid-iteration. The array being immutable is what
removes the hazard.

But `rebuildSystemPrompt()` **is** a live path, called on every skill change. So
the naive reading of `/team on` — flip a flag, re-splice `<team_mode>` — produces
a session where the model is told it has a `task` tool that was never registered.
Every call returns "unknown tool", the model has no way to discover why, and the
symptom is a dead end of exactly the kind the skills work spent a round removing
(the `skill` / `ask_user` floor entries exist for this).

The rule is therefore split by what was decided at construction:

| Session started with | `/team off` | `/team on` |
|---|---|---|
| team **on** (`task` registered) | Flips `teamEnabled`. `task` stays registered but refuses via §3.3 guard 1a; `<team_mode>` is dropped from the prompt on the next rebuild. Persists. | Flips back. Both the tool and the block are live again. Persists. |
| team **off** (`--no-team` / `enabled: false`; `task` NOT registered) | Persists `false`; reports "already off". | **Persists `true` and says so explicitly**: `Team mode is off for this session (started with --no-team). Saved for next launch.` The session is not changed: no prompt block, no tool. |

The bottom-right cell is the whole point. It is honest, it is one sentence, and
it keeps AC-11's object-identity claim intact — a `--no-team` session never grows
a wrapper or an entry, whatever the user types afterwards.

Refused while a dispatch is in flight (`Cannot change team settings mid-dispatch.`)
— the same reasoning `/reload` already uses for mid-run config changes: half a
dispatch under one ceiling and half under another produces a result nothing can
afterwards explain.

Help-overlay rows are added to `HelpOverlay.tsx`'s `COMMANDS` table.

### 4.6 System-prompt blocks

**Lead — `buildTeamBlock({ maxSubagents, maxConcurrent })`**, spliced into
`buildSystemPrompt` only when team mode is on (I-8). ASCII, ≤ 1 200 chars,
versioned by a `TEAM_BLOCK_VERSION` constant so a change is greppable:

```
<team_mode>
You can delegate to parallel subagents with the task tool (up to N at once).

Delegate when: the work splits into 2+ parts that do not need each other's
output; several areas must be read or searched at once; a long build or test
run can proceed while another part is investigated.

Do not delegate when: one part needs another part's result (do those in order
yourself); two parts would edit the same file; the whole job is a few edits.
One well-scoped subagent is better than four vague ones. Two to four is the
usual size; more than that is rarely faster.

Each subagent starts with no memory of this conversation, so its prompt must
carry everything it needs: the goal, the files or areas it owns, and what to
report back. Give each one a disjoint set of files to write. Subagents cannot
dispatch further subagents and cannot ask the user anything.

You get one combined report when they all finish. Read it before deciding what
to do next, and tell the user what the team found in your own words.
</team_mode>
```

**Child — `buildSubagentBlock({ label, description, peers })`**, ≤ 900 chars:

```
<subagent_role>
You are subagent "a2" on a team. Your job: <description>.
Teammates: a1, a3. You cannot see their conversations and they cannot see yours.

Work only on your own task. Do not edit files another subagent owns. You cannot
delegate further and there is no user to ask - if something is ambiguous, choose
the most reasonable reading, proceed, and say what you assumed.

To reach a teammate use team_send (at most 6 messages, one every 15 seconds).
Their replies arrive attached to your next tool result. Use team_wait only when
you genuinely cannot continue without an answer.

END WITH YOUR REPORT. Your final message is the only thing your lead sees. It
must state: what you did, what you found, every file you changed, and anything
still open. Be concrete and brief - no preamble, no restating this brief.
</subagent_role>
```

The "final message is the only thing your lead sees" sentence is load-bearing:
`SubagentRun.summary` is literally the last assistant text of the child's history,
so a child that ends with "Let me know if you want more detail!" produces a
useless report entry. Wording is the only enforcement available, and it is
therefore explicit.

---

## 5. Data model

No database, no new file on disk beyond the config section. All runtime state is
in-memory and dies with the dispatch.

### 5.1 Runtime shapes (`team/types.ts`)

```ts
export interface SubagentSpec {
  label: string;          // normalized, unique within the dispatch
  description: string;    // <= 60 chars
  prompt: string;         // <= 8000 chars
  readOnly: boolean;
}

export type SubagentPhase =
  | 'queued' | 'starting' | 'thinking' | 'tool' | 'waiting'
  | 'done' | 'failed' | 'aborted';

export interface SubagentRun {
  label: string;
  description: string;
  phase: SubagentPhase;
  startedAt?: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  lastTool?: string;
  usage: TokenUsage;          // from @aragon-agent/core
  filesTouched: string[];     // <= 30, deduped, best-effort (write_file/edit_file only)
  messagesSent: number;
  summary?: string;           // final assistant text
  error?: string;
  truncated?: boolean;        // hit maxTurnsPerSubagent
}

export interface DispatchOutcome {
  runs: SubagentRun[];
  requested: number;          // before the cap, for the "n of m" line
  startedAt: number;
  endedAt: number;
  aborted: boolean;
  leadMail: TeamMessage[];
  usage: TokenUsage;          // summed
}

export interface TeamMessage {
  from: string; to: string; subject: string; body: string; at: number;
}

/** What the UI renders; a cheap immutable projection, rebuilt per event. */
export interface TeamSnapshot {
  active: boolean;
  runs: SubagentRun[];
  requested: number;
  startedAt: number;
  messageCount: number;
  lastMessage?: TeamMessage;
}
```

### 5.2 `TeamEvent` — a CLI-local event stream

Deliberately **not** part of core's `AgentEvent` union (I-5). `TeamRuntime`
extends a tiny emitter; `AgentController.subscribeTeam(listener)` forwards.

```ts
export type TeamEvent =
  | { type: 'dispatch_start'; requested: number; specs: SubagentSpec[] }
  | { type: 'agent_update'; run: SubagentRun }
  | { type: 'usage'; label: string; usage: TokenUsage }
  | { type: 'message'; message: TeamMessage }
  | { type: 'dispatch_end'; outcome: DispatchOutcome };
```

Emission is **coalesced at the source**: `agent_update` is throttled to one event
per child per 120 ms (phase transitions always pass). Five children streaming
tokens must not push five React renders per token — the streaming coalescer in
`App.tsx` protects the transcript, not this path.

### 5.3 View-state additions (`agent/reducer.ts`)

```ts
// New Entry kind — JSON-serializable, so /save and /resume need no change.
| { id: string; kind: 'team'; dispatchId: string; requested: number;
    runs: SubagentRun[]; aborted: boolean; durationMs?: number;
    active: boolean }

// New ViewState fields
team: TeamSnapshot | null;   // live roster; null when no dispatch is running

// New actions
| { type: 'teamStart'; dispatchId: string; requested: number; specs: SubagentSpec[] }
| { type: 'teamUpdate'; snapshot: TeamSnapshot }
| { type: 'teamUsage'; usage: TokenUsage; costDelta: number }
| { type: 'teamEnd'; outcome: DispatchOutcome }
```

Reducer rules: `teamStart` appends a `team` entry with `active: true` and sets
`state.team`; `teamUpdate` rewrites `state.team` **and** the live entry's `runs`
(one `mapEntry` on the known id — no scan); `teamEnd` sets `active: false`,
stamps `durationMs`, and clears `state.team` to `null` so the panel disappears;
`teamUsage` touches `usageTotal` only (§3.9).

**`active: true` must be normalized away on session load (P1-5).**
`session/persist.ts:20,56` writes `entries` verbatim and validates only
array-ness on read, and `state.team` is not persisted at all — so a session saved
while a dispatch was in flight resumes with a `team` entry that claims to be
running while nothing is. Two things then go wrong at once: the card renders a
spinner forever, and `Transcript`'s settled boundary is monotonic
(`Transcript.tsx:249`), so an entry that never settles never reaches `<Static>`
and is re-rendered on every frame for the rest of the session.

`restoreSession`'s entry mapping therefore rewrites any `kind: 'team'` entry with
`active: true` to `{ active: false, aborted: true }`, and the card renders
`team  3 subagents  interrupted (session resumed)`. That is also simply true: the
children died with the process. This is one `map` in the load path and it belongs
there rather than in the reducer, because the reducer never legitimately sees a
stale-active entry — only the file does.

### 5.4 Persisted config

```jsonc
{
  "team": {
    "enabled": true,
    "maxSubagents": 5,
    "maxConcurrent": 3,
    "subagentTimeoutMs": 300000,
    "dispatchTimeoutMs": 900000,
    "maxTurnsPerSubagent": 24
  }
}
```

Scalars only, one level deep (§3.10). `clampTeamConfig(raw)` is the single gate
for every read *and* write, mirroring `clampSkillsConfig` / `clampLogConfig`.

---

## 6. UI design

### 6.1 `TeamPanel` — the live roster

**Placement.** Inside `AppShell`'s bottom-chrome box, immediately above the toast
stack, via a new `team?: React.ReactNode` prop rendered in both the `inline` and
`fullscreen` branches. It must be *inside* `bottomRef` (I-10) or the wheel
router's composer band goes stale the moment a dispatch starts and the wheel
begins scrolling prompt history over the transcript.

**Rendered only while `state.team !== null`** — the requirement's "（当有的时候）".
Zero rows, zero cost, and no layout shift in a session that never delegates.

```
 team  3 running · 1 done · 84s                          mail 2
 ⠋ a1  read the auth middleware      tool: grep        22.1s
 ⠙ a2  map the route table           thinking          31.6s
 ✔ a3  check the migration           done  4 turns     18.2s
 ✉ a1 -> lead: "auth uses a second session store"
```

- **Row budget.** At most `TEAM_PANEL_MAX_ROWS = 5` agent rows plus a
  `+N more` line. Below 20 terminal rows the panel collapses to its single header
  line (`team  3 running · 84s`). Below `MIN_FULLSCREEN_ROWS` the App already
  renders the too-small placeholder and the panel is not reached.
- **Motion.** One `ink-spinner` per *running* row, suppressed under
  `reducedMotion` or `!caps.unicode` in favour of `glyphs.spinnerStill` — exactly
  the rule `AssistantEntry` and `ToolCard` already follow. Five spinners is the
  documented maximum, which is why the row cap is 5 and not 10.
- **Glyphs.** New `Glyphs` fields only: `teamAgent` (`◆` / `*`),
  `teamMail` (`✉` / `@`). No literal may appear in the component (I-6).
- **Colour.** `theme.toolRunning` for running rows, `theme.toolDone` for done,
  `theme.toolError` for failed, `theme.muted` for the metadata columns. No new
  palette entries; the semantics already exist.
- **Truncation.** Every row is `wrap="truncate"`, and the description column is
  the only flexible one, so the status and elapsed columns never lose characters
  — the same degradation discipline `StatusBar` documents for its left cluster.

### 6.2 Status-bar cluster

`StatusBar` gains one optional prop, `teamActive?: { running: number; total: number }`,
rendered in the **left** cluster after the mode word:

```
◍ running  PLAN  agents 3/5  anthropic:claude-sonnet-4-5
```

Left cluster on purpose: it is `flexShrink={0}` (`StatusBar.tsx:131-132`), so this
readout cannot lose characters under width pressure — the same argument
`StatusBar`'s own comment makes for putting the mode word there and not in the
right cluster. Rendered only while a dispatch is active, so an ordinary session's
bar is unchanged.

**`flexShrink={0}` cuts both ways, and the cost lands on the right cluster
(P2-1).** The left cluster not shrinking means every column it takes comes out of
the context gauge and cost readout opposite it. On an 80-column terminal,
`◍ running  PLAN  agents 3/5  anthropic:claude-sonnet-4-5` leaves the right
cluster visibly squeezed — and the gauge is how a user notices they are about to
run out of context, which is not a good thing to trade for a counter that is
already rendered in full in the panel two rows below.

So the readout has a compact form and one breakpoint, both stated here rather
than left to the implementer:

| Width | Rendered |
|---|---|
| `cols >= 100` | `agents 3/5` |
| `cols < 100` | `[3]` — the running count only, in `theme.toolRunning` |

This does not contradict `StatusBar`'s "no `cols >= N` breakpoint" rule: that
rule is written about `agentMode`, the guaranteed mode indicator, and its reason
is that the mode must never be unreportable. The team counter has a second, more
detailed home in `TeamPanel` and a third in `TeamCard`; it is the one readout on
this bar that can afford to degrade.

### 6.3 `TeamCard` — the transcript entry

The panel is ephemeral; the card is the history. It renders in the transcript
like a `ToolCard` (same `EntryFrame`, rail marker `glyphs.teamAgent`, colour by
aggregate status) and settles into:

```
team  3 subagents  84.2s  (2 ok, 1 failed)
 ✔ a1  read the auth middleware   22.1s  4 turns  2 files
 ✔ a2  map the route table        31.6s  6 turns
 ✖ a3  check the migration        84.0s  failed: idle watchdog aborted the run
 +3 summaries (Ctrl+O)
```

`Ctrl+O` expands to the per-agent summaries. `App.tsx`'s `Ctrl+O` handler
currently searches for the last entry with `kind === 'tool'`; it becomes
`kind === 'tool' || kind === 'team'`. `toggleExpand` is keyed on entry id and
needs no change.

`transcript-text.ts` (plain-text export for `--exit-transcript` and headless)
gains a `team` branch emitting the same rows without colour.

### 6.4 Degradation matrix

| Environment | Panel | Status cluster | Card |
|---|---|---|---|
| Full-screen, Unicode, motion | full roster, spinners | yes | full |
| `--no-color` / `reducedMotion` | static glyphs | yes | full |
| No Unicode (`cmd.exe`) | ASCII glyphs from `glyphs.ts` | yes | ASCII |
| `rows < 20` | one-line header | yes | full |
| Inline mode | full roster (no fixed frame) | yes | full |
| `cols < 100` | full roster (rows truncate) | compact `[3]` (§6.2) | full |
| Headless `-p` | stderr lines (§3.12) | n/a | plain text in the footer |
| `--quiet -p` | nothing | n/a | nothing |
| Resumed session (§5.3) | not rendered (`state.team` is never persisted) | no | `interrupted (session resumed)` |

---

## 7. File / module change plan

### 7.1 New files

| File | Intent |
|---|---|
| `packages/cli/src/team/limits.ts` | `TEAM_LIMITS` + `TEAM_SUBAGENT_TOOL_NAMES` + `TEAM_BLOCK_VERSION` — the single authority on every bound |
| `packages/cli/src/team/types.ts` | `SubagentSpec` / `SubagentRun` / `DispatchOutcome` / `TeamMessage` / `TeamSnapshot` / `TeamEvent` |
| `packages/cli/src/team/normalize.ts` | `normalizeSubagentSpecs(raw, max)` — pure repair, drop-first cap-second, never throws |
| `packages/cli/src/team/prompt.ts` | `buildTeamBlock()` / `buildSubagentBlock()` — ASCII, versioned prompt blocks |
| `packages/cli/src/team/bus.ts` | `TeamBus` — mailboxes, quotas, send intervals, blocking waits, `cancelAllWaits()` |
| `packages/cli/src/team/human-queue.ts` | `TeamHumanQueue` — serializes child confirmations onto the single human slot (I-4) |
| `packages/cli/src/team/subagent.ts` | `createSubagent()` — child `Agent` + tool set + event instrumentation |
| `packages/cli/src/team/runtime.ts` | `TeamRuntime` — slot pool, budgets, `TeamEvent` emission, `abortAll()`, `dispose()` |
| `packages/cli/src/team/report.ts` | `buildDispatchReport()` — byte-budgeted aggregation + file-conflict warning |
| `packages/cli/src/team/task-tool.ts` | the `task` `AgentTool` (lead-only) |
| `packages/cli/src/team/comm-tools.ts` | `team_send` / `team_wait` + `withMailboxTail()` |
| `packages/cli/src/ui/TeamPanel.tsx` | live roster in the bottom chrome |
| `packages/cli/src/ui/entries/TeamCard.tsx` | settled-dispatch transcript card |

### 7.2 Modified files

| File | Change |
|---|---|
| `packages/cli/src/config/schema.ts` | `TeamConfig`, `DEFAULT_TEAM_CONFIG`, `clampTeamConfig`, `HARD_MAX_SUBAGENTS = 10`; add `team` to `PersistedConfig` / `DEFAULT_CONFIG` / `CliConfig` |
| `packages/cli/src/config/store.ts` | Deep-merge `team` in `loadPersistedConfig` **and** `updatePersistedConfig` (§3.10) |
| `packages/cli/src/config/load.ts` | Resolve `team` across defaults › file › env › flags; `--team` / `--no-team` / `--team-max` in `CliFlags` |
| `packages/cli/src/config/env.ts` | `ARAGON_TEAM` (positive-list parse) and `ARAGON_TEAM_MAX` |
| `packages/cli/src/config/cli-commands.ts` | `TEAM_CONFIG_SET_KEYS` + `team.*` cases in the dotted-key get/set table |
| `packages/cli/src/tools/index.ts` | `teamTools?` (appended beside `planTools`, before both wrappers) and `policyExempt?` (skips the ceiling wrapper only); `task` added to `HOST_TOOL_NAMES` and `SKILL_TOOL_FLOOR` (I-7, §3.3.0) |
| `packages/cli/src/agent/controller.ts` | Own `TeamRuntime`; pass `teamTools: [task]` when enabled at construction; live `teamEnabled` flag for `/team` (§4.5); `toolTimeoutOverrides.task`; extract `withPausedWatchdog`; `subscribeTeam`; label-decorating child `onToolPolicyEvent` (§3.11); `abort()` also aborts the team; `dispose()` |
| `packages/cli/src/agent/system-prompt.ts` | Optional `teamBlock` (lead) and `subagentBlock` (child), both spliced conditionally (I-8) |
| `packages/cli/src/agent/reducer.ts` | `team` entry kind, `team` state field, four new actions (§5.3) |
| `packages/cli/src/agent/headless.ts` | `subscribeTeam?` added to the `HeadlessController` seam as an **optional** member (§3.12); stderr transitions; fold child usage into the footer |
| `packages/cli/src/session/persist.ts` | Normalize `kind: 'team'` entries with `active: true` to `{ active: false, aborted: true }` on load (§5.3, P1-5) |
| `packages/cli/src/logging/install.ts` | `attachTeamEvents(logger, controller)` beside `attachAgentEvents`, installed from the same place (§3.13) |
| `packages/cli/src/ui/App.tsx` | Subscribe to `TeamEvent` → dispatch; pass `team` to `AppShell` and `teamActive` to `StatusBar`; extend the `Ctrl+O` finder; `runtime.dispose()` on unmount |
| `packages/cli/src/ui/layout/AppShell.tsx` | New `team?: React.ReactNode` slot, rendered inside the measured bottom box (I-10) |
| `packages/cli/src/ui/StatusBar.tsx` | `teamActive?` prop → left-cluster `agents n/m` |
| `packages/cli/src/ui/Transcript.tsx` | `case 'team'` in `EntryView`; settle rule treats an active dispatch as unsettled |
| `packages/cli/src/ui/transcript-text.ts` | Plain-text branch for `team` entries |
| `packages/cli/src/ui/glyphs.ts` | `teamAgent` / `teamMail` in both tables; `tool.task` icon |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | `/team` rows |
| `packages/cli/src/commands/builtins.ts` | `/team` command (status / on / off / max) |
| `packages/cli/src/cli.tsx` | `--team` **and** `--no-team` declared as a pair, `--team-max <n>`; the three matching lines in `toFlags` (P1-4); `controller.dispose()` on exit |
| `packages/cli/src/__tests__/tools.test.ts` | **Three** assertions, not one (§3.3.0): the exhaustive `SKILL_TOOL_FLOOR` array (line 163) gains `'task'`; **C7** (line 178) gains `teamTools: [stub('task')]`; the I-P6 partition assertion (line 201) is re-run. `plan-gate.test.ts` needs no change — v1 named it in error |
| `packages/cli/src/__tests__/glyphs.test.ts` | Add `rel.startsWith('team/')` to the `inScope` expression, or AC-13 asserts a property nothing checks (I-6, P1-1) |
| `packages/cli/README.md` | Team-mode section: what it is, config keys, flags, `/team`, limits |
| `packages/cli/CHANGELOG.md` | New feature entry |

**`packages/core/**` — no changes.** This is an acceptance criterion (AC-12), not
a stylistic preference: it keeps `@aragon-agent/core` publishable without a
version bump and keeps `public-api.test.ts` / `no-host-coupling.test.ts` green
without edits.

---

## 8. Testing and acceptance criteria

### 8.1 New test files

| File | Covers |
|---|---|
| `team-normalize.test.ts` | drop-then-cap ordering, label dedup/slugging, the 10 ceiling, zero-survivor path |
| `team-bus.test.ts` | quota, interval, broadcast cost, mailbox piggy-back, `team_wait` resolve/timeout/abort |
| `team-runtime.test.ts` | slot pool honours `maxConcurrent`, per-child timeout, turn cap, abort propagation, one failure does not fail the dispatch, `dispose()` |
| `team-report.test.ts` | header-first byte budgeting, conflict warning, aborted header, `n of m` line, CJK byte accounting (I-9) |
| `team-tool-gate.test.ts` | children get no `task`, no `ask_user`/`submit_plan`, no `skill_install`/`skill_create`, **and no `skill`** (P0-3 — the child's registry never gains a frame); plan mode refuses the five in children; comm tools are policy-exempt; child policy notices carry the child's label and do not advance the lead's escalation counter (P1-3) |
| `team-config.test.ts` | clamps, the 10 ceiling from a hand-edited file, deep-merge on partial patch, env/flag precedence, `--team`/`--no-team`/absent resolving to three distinct outcomes (P1-4) |
| `team-panel.test.tsx` | renders only when active, row cap + `+N more`, one-line collapse under 20 rows, ASCII fallback, compact `[3]` status readout under 100 columns (P2-1) |
| `team-session.test.ts` | a saved session with an `active: true` team entry resumes settled and marked interrupted (P1-5) |

All tests use a stub `Agent` factory (injected into `TeamRuntime` through its
options object) so no test touches a network. This mirrors the existing
`HeadlessController` seam — a minimal interface the real class satisfies.

### 8.2 Acceptance criteria

- **AC-1** A lead run that calls `task` with three specs produces three child
  `Agent`s, runs at most `maxConcurrent` at a time, and returns one `textResult`.
- **AC-2** With no config file, `team.enabled` resolves `true` and `task` is in
  `controller.listTools()`. (R-b)
- **AC-3** The system prompt contains `<team_mode>` iff team mode is on; the
  child prompt contains `<subagent_role>` and the child's tool list contains no
  `task`. (R-c, R-f)
- **AC-4** The report contains one section per subagent with its final message,
  status, duration and token usage, and the "n ok / n failed" header. (R-d)
- **AC-5** `team_send` from a1 to a2 is appended to a2's next tool result inside a
  `<team_mail>` block. (R-e)
- **AC-6** The 7th `team_send` from one child, and a second send inside 15 s, both
  return a **non-error** result naming the limit; neither is delivered. (R-e)
- **AC-7** A `task` call with 30 specs runs `maxSubagents` of them and the report
  header says `5 of 30 requested`; a config file with `maxSubagents: 40` resolves
  to 10. (R-g)
- **AC-8** While a dispatch runs, `TeamPanel` renders and `StatusBar` shows
  `agents n/m`; both disappear on `dispatch_end`. (R-h)
- **AC-9** With `caps.unicode === false` the panel emits no non-ASCII byte, and
  `glyphs.test.ts`'s scanner (scope extended to `src/team/**`) passes. (R-i)
- **AC-10** `Esc` during a dispatch aborts every child within 2 s and the tool
  returns a report whose first line says `ABORTED`. (R-j)
- **AC-11** `--no-team` yields a tool array **object-identical** to the pre-team
  build for the same options (no wrapper, no extra entry).
- **AC-12** `git diff --stat packages/core` is empty for this feature.
- **AC-13** No file under `src/team/**` or `src/ui/**` contains a non-ASCII
  literal outside `glyphs.ts`.
- **AC-14** A 10-minute dispatch under the default `idleTimeoutMs` of 210 s
  completes without a watchdog abort (I-3 regression guard — this is the test
  most likely to catch a future refactor breaking the feature).
- **AC-15** Child token usage appears in `usageTotal` and **not** in
  `contextTokens`.
- **AC-16** With `--confirm`, two children writing simultaneously raise exactly
  one dialog at a time, each labelled with its child's label, and an abort while
  a dialog is queued leaves nothing pending. **A child queued behind a dialog
  held open for longer than `idleTimeoutMs` is not aborted by its own watchdog**
  (P0-4 — the I-3 regression guard one level down, and the second-most likely way
  to ship this feature broken).
- **AC-17** A dispatch writes `dispatch_start` and `dispatch_end` records to the
  log file at `info`, carrying `ok` / `failed` / `aborted` counts and aggregate
  usage; no `body` of any `team_send` appears at any level below `trace`; all of
  it passes `redactText`. (P1-2)
- **AC-18** `/team on` in a session started with `--no-team` persists `true`,
  reports that the session is unchanged, and adds neither `<team_mode>` to the
  prompt nor an entry to `controller.listTools()`. (P0-2)
- **AC-19** No child's tool array contains `skill`, and a full dispatch leaves the
  lead's `SkillRegistry` frame stack byte-identical to what it was when `task`
  was called. (P0-3)

### 8.3 Manual verification

A `manual-test.md` companion covering: a real 3-way fan-out on this repository
(`read the tool wrappers` / `map the config resolution` / `list the test files`),
a deliberate mid-dispatch `Esc`, a `--no-team` A/B of `/tools` output, a
`cmd.exe` render check, an 80×24 terminal size check, and a `-p --quiet` run.

---

## 9. Risks and mitigations

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-1** | Someone makes `agent-loop.ts` execute tool calls concurrently to "fix" fan-out, silently breaking the plan-mode human bridge (I-P11) | High | D-1 records the constraint in `task-tool.ts`'s header; AC-16 and the plan-mode overlay tests both fail if it happens |
| **R-2** | `filesTouched` misses `bash`-mediated writes, so the conflict warning under-reports | Medium | Warning is phrased as "review before trusting either", never as a guarantee; the prompt tells the lead to assign disjoint files |
| **R-3** | The lead's idle watchdog kills long dispatches (I-3) | **High** | `withPausedWatchdog` + AC-14, which is written as a regression test rather than a smoke test |
| **R-4** | Five concurrent streams trip provider rate limits; the report is a wall of 429s | Medium | `maxConcurrent` default 3; `formatStreamError` already renders `rate_limit` legibly; each failure is per-child and non-fatal |
| **R-5** | Token spend multiplies without the user noticing | **High** | §3.9 roll-up into the status bar; the report header states aggregate tokens and cost; the prompt discourages delegating small work |
| **R-6** | A child inherits the ceiling of a skill the lead loaded — or does not, becoming a delegation bypass | Medium | §3.11: the lead's `toolPolicy` closure wraps child tools; `team-tool-gate.test.ts` asserts both directions |
| **R-7** | Concurrent confirm dialogs double-resolve the single human slot (I-4) | High | `TeamHumanQueue`; children never get `ask_user` / `submit_plan`; AC-16 |
| **R-8** | The panel eats the screen on a small terminal | Medium | 5-row cap, one-line collapse under 20 rows, `wrap="truncate"` everywhere; `team-panel.test.tsx` |
| **R-9** | A `team_send` storm burns tokens (the "太频繁" failure) | Medium | 6/child, 15 s interval, 24/dispatch, broadcast costs 2; all refusals non-error so no retry loop |
| **R-10** | A CJK-heavy report is chopped mid-section by the executor's 100 KB byte cap (I-9) | Medium | Budgets denominated in bytes; header/status lines never trimmed; explicit CJK test in `team-report.test.ts` |
| **R-11** | The panel lands outside `AppShell`'s measured box and the wheel router mis-routes notches (I-10) | Low | Slot is inside `bottomRef`; a `mouse-routing.test.tsx` case renders with an active dispatch |
| **R-12** | A child's summary is conversational filler, making the report useless | Medium | The `<subagent_role>` block states the contract in imperative terms; the report renders `(no summary)` visibly rather than an empty section |
| **R-13** | `task` in `SKILL_TOOL_FLOOR` looks like a widening of plan mode's read-only guarantee | Medium | Children inherit the mode through the same `withPlanModeGate` closure; the partition test forces a conscious classification; `spec.readOnly` can only tighten |
| **R-14** | Two dispatches overlap (if I-1 ever changes) | Low | `runtime.isBusy()` guard returns a non-error refusal |
| **R-15** | Orphaned children survive `Ctrl+C` | Medium | `dispose()` from both the App unmount and `cli.tsx`'s exit path; children also hold their own idle watchdogs as a backstop |
| **R-16** | A child loads a skill and silently narrows the LEAD's ceiling and system prompt mid-dispatch (P0-3) | **High** | Children get `skill_find` only; §3.4 records the `enterFrame()` mechanism so a later "just add `skill` back" is a conscious act; AC-19 asserts the lead's frame stack is unchanged |
| **R-17** | A queued `--confirm` dialog starves sibling children past their own watchdogs (P0-4) | **High** | `TeamHumanQueue` pauses the child's watchdog on enqueue, not on display; AC-16 holds a dialog open past `idleTimeoutMs` |
| **R-18** | `/team on` advertises a tool that was never registered (P0-2) | **High** | The construction-time / runtime split in §4.5; AC-18 |
| **R-19** | A dispatch that goes wrong is unforensicable — the report is the only artefact and it is written by the thing that failed (P1-2) | Medium | §3.13 logs both ends of every dispatch at `info` and phase transitions at `debug`, through the existing redacting sink |
| **R-20** | Someone adds a non-ASCII glyph under `src/team/**` and no test notices, because the scanner's `inScope` list predates the directory (P1-1) | Medium | One-line `glyphs.test.ts` change listed in §7.2; the scanner's own self-test (`glyphs.test.ts:215`) already guards against a no-op guard |

---

## 10. Decision log

| ID | Decision | Rationale |
|---|---|---|
| **D-1** | `task` takes a **batch** of specs rather than one spec per call | `agent-loop.ts` executes tool calls sequentially (I-1); N single-spec calls would run serially. Making the loop concurrent would break plan-mode's I-P11. The fan-out belongs where we control the scheduling. |
| **D-2** | The whole feature lives in `packages/cli` | Children need the CLI's filesystem/shell tools; core must not learn about a host (I-5). Zero core diff also means no republish. |
| **D-3** | Children never receive `task` | Depth capped at 1 by construction rather than by a counter that can be miscounted; matches Claude Code. |
| **D-4** | Mail piggy-backs on the recipient's next tool result; `steer()` is not used | `agent-loop.ts:214` cancels every remaining tool call in a batch when steering arrives — a chatty peer would silently cancel a colleague's work. |
| **D-5** | `task` joins `SKILL_TOOL_FLOOR`, not `PLAN_MODE_BLOCKED_TOOLS`; children inherit the mode | `task` cannot itself mutate anything, and every child mutation passes through the same wrapper stack one level down. Blocking it would forfeit parallel research, which is plan mode's best use. |
| **D-6** | `maxConcurrent` is a separate knob from `maxSubagents` | Provider rate limits are a different constraint from context economics; folding them into one number makes both wrong. |
| **D-7** | Every rate-limit and quota refusal is a **non-error** `textResult` | An `errorResult` reads as a malfunction and invites retries — the exact behaviour the limits exist to prevent (same reasoning as `ask_user`'s cancelled shape). |
| **D-8** | Report budgets in **bytes**, header never trimmed | `ToolExecutor` truncates at 100 000 bytes (I-9); a CJK report measured in characters would be chopped mid-section, losing the failure count first. |
| **D-9** | Children use the lead's model, keys and thinking level | One cost table, one preflight, one settings surface. Per-child models are a documented follow-up (§11). |
| **D-10** | `TeamEvent` is a CLI-local stream, not a member of core's `AgentEvent` | Keeps `public-api.test.ts` frozen and lets the event carry host-shaped data (`SubagentRun`) that core has no business defining. |
| **D-11** | The panel renders only while a dispatch is active | The requirement says "（当有的时候）"; a permanent zero-row region would be furniture, and the status bar already documents that principle for the mode word. |
| **D-12** | `withHumanWait` is renamed to `withPausedWatchdog` with the old name kept as an alias | The mechanism is not about humans any more, but the plan tools' call sites read correctly with the old name. Renaming both would be churn in a file this change should barely touch. |
| **D-13** | `spec.readOnly` can only tighten a child relative to its lead | There must be no field anywhere that gives a child more permission than the session it was spawned from. |
| **D-14** | A failed child never fails the dispatch | Partial results are the normal outcome of a fan-out; an all-or-nothing tool result would throw away four successes because of one 429. |
| **D-15** | `task` reaches the array through a `teamTools` factory option, never appended by the controller | `tools.test.ts::C7` asserts `HOST_TOOL_NAMES` equals what `createBuiltinTools` produces. Appending afterwards turns that test red with a message about name lists that says nothing about team mode (P0-1). |
| **D-16** | Children get `skill_find` but **not** `skill` | `createSkillTool` calls `enterFrame()` on the one shared `SkillRegistry`; a child loading a skill would narrow the lead's own ceiling and rewrite the lead's system prompt mid-tool-call, from up to `maxConcurrent` places at once (P0-3). Always-on skills still reach children through the spliced `alwaysBlock()`. |
| **D-17** | `/team on` cannot turn team mode on in a session that started without it; it persists and says so | The tool array is immutable by design (`controller.ts:168-177`) while the system prompt is rebuildable. Anything else advertises an unregistered tool (P0-2). |
| **D-18** | Blocking inside `TeamHumanQueue` pauses the **child's** watchdog | Same rule as `withHumanWait` and `team_wait`: a deliberate wait is not a wedged agent. Applied on enqueue rather than on display, because the FIFO is where the time actually goes (P0-4). |
| **D-19** | `TeamEvent` is logged through a dedicated `attachTeamEvents`, not folded into `attachAgentEvents` | D-10 keeps `TeamEvent` off core's union, so the existing attach function cannot see it; a separate function keeps both readable and lets the two use different level policies (P1-2). |
| **D-20** | The status-bar counter degrades to `[3]` under 100 columns | The left cluster cannot shrink, so its columns come out of the context gauge — the one readout on that bar the user cannot reconstruct from elsewhere. The team counter appears in full in two other places (P2-1). |

---

## 11. Open questions and bounded follow-ups

1. **Per-subagent model** (`spec.model`) — a cheap model for search-heavy children
   and the lead's model for reasoning-heavy ones is the obvious next win. Needs
   per-child cost tables in the roll-up and a decision about which providers are
   offerable. Out of scope for v1 (D-9).
2. **Streaming a child's text into the panel.** Today the panel shows phase and
   counters; showing the child's latest sentence would be more informative and
   considerably more expensive to render. Deferred until the coalescing budget in
   §5.2 has been measured on a real terminal.
3. **Persisting subagent transcripts** behind `--team-transcripts`, for debugging
   a bad report. Interacts with the session file format, so it wants its own
   round. **Mostly superseded by §3.13** — `aragon logs tail --level debug` now
   answers the common form of the question without a new flag or file format;
   what remains is the rarer "show me the child's whole history verbatim".
4. **A `team_wait` deadlock detector.** Two children waiting on each other both
   time out correctly today (bounded by `subagentTimeoutMs`), but the report says
   "no message arrived" twice rather than "these two waited on each other". Pure
   diagnostics; no correctness impact.
5. **Reusing a child across dispatches** (a warm pool). Almost certainly not worth
   it: the value of a subagent is a *clean* context, and a pool would leak state
   between unrelated tasks.
6. **Child-local skill frames**, restoring `skill` to subagents (D-16 / P0-3).
   Needs a `SkillRegistry` whose catalog is shared but whose frame stack is
   per-agent, plus a decision about whether a child's frame should tighten that
   child's ceiling only (yes) and whether the lead should be told which skills its
   children loaded (probably, in the report). Bounded and self-contained, but it
   touches the one object in the CLI with the most turn-scoped state, so it wants
   its own round rather than a bullet in this one.

---

## 12. 评审结论 (Review verdict)

**有条件通过 (Approved with conditions).**

The design is unusually well grounded: §2's inherited-constraint audit was
checked item by item against the code it names and is accurate in substance, the
two hardest decisions in the feature (D-1's batch shape and D-4's refusal to use
`steer()`) are both correct and correctly argued from the actual behaviour of
`agent-loop.ts`, and the byte-versus-character discipline in D-8 catches a real
truncation bug before it exists. Feasibility is not in question — every mechanism
this document needs is already present in the codebase, and the "zero changes to
`packages/core`" claim (AC-12) survives scrutiny.

The four P0 findings were all of one kind, and it is worth naming the pattern
rather than just the instances: **the design reasoned carefully about the lead and
then assumed children inherit the lead's safety properties.** They do not. The
watchdog fix (I-3) was applied to the lead and not to a queued child (P0-4); the
skills ceiling was correctly re-applied one level down while the skills
*registry* underneath it was left shared and mutable (P0-3); the tool array's
immutability was quoted as a constraint on the core loop and then contradicted by
a slash command (P0-2). Every one of those is now resolved in the body, and the
regression guards (AC-16, AC-18, AC-19, R-16 … R-18) are written so that a future
refactor that re-breaks them fails a test rather than a user's session.

Conditions on implementation — all four are already written into the document,
and are listed here because they are the ones that will be quietly skipped under
time pressure:

1. **Land §3.3.0's three `tools.test.ts` assertions in the same commit as
   `HOST_TOOL_NAMES`.** They are the mechanism that forces `task` to be classified
   consciously; deferring them means the classification happens by accident.
2. **AC-14 and AC-16 are regression tests, not smoke tests.** Both encode the
   watchdog contract — one for the lead, one for a queued child — and both must
   hold a real timer past a real `idleTimeoutMs`. A test that mocks the clock
   away tests nothing here.
3. **AC-19 must assert the lead's frame stack, not the child's tool list.** The
   tool list is the fix; the frame stack is the property. Asserting only the
   former lets a future change reintroduce the hazard through a different door.
4. **`glyphs.test.ts`'s `inScope` change is one line and has no compile-time
   signal.** Without it AC-13 passes vacuously — the failure mode the scanner's
   own self-test at line 215 exists to prevent, reintroduced at the directory
   level.

Two things the review deliberately did **not** ask for. The scope is right-sized
as it stands: the five non-goals in §1.3 are each defensible, and per-subagent
models (§11 item 1) would multiply the cost table, the preflight surface and the
settings screen for a benefit nobody has asked for. And the communication design
resists the obvious temptation to make the bus richer — the rate limits are the
requirement ("不能太频繁"), not a compromise, and D-7's insistence that every
refusal is a non-error `textResult` is the detail that makes them hold.

Re-review is not required before implementation. A second pass is warranted only
if the implementer needs to reopen D-16 (children and `skill`) or D-17 (`/team on`
semantics), since both were decided here on constraints rather than on taste.

---

## 实施过程发现的方案缺陷 (Issues found during implementation)

Recorded during implementation, in the order they bit. None of them reopens a
decision; each is a gap between what the document said and what the code
required, plus what was done about it.

### IF-1 · §7.2's change plan is missing three test files, and they fail closed

The plan lists `tools.test.ts` and `glyphs.test.ts`. Three more break the moment
this feature lands, and none of them fails in a way that names team mode:

| File | What broke | Fix applied |
|---|---|---|
| `app.test.tsx` | `App` now calls `controller.subscribeTeam(...)` on mount and `controller.dispose()` on unmount. Its `FakeController` is a duck-typed stub cast to `AgentController`, so every one of its 23 render cases threw `controller.subscribeTeam is not a function` before the first frame. | `FakeController` gains `subscribeTeam` / `emitTeam` / `getTeamSnapshot` / `dispose`. |
| `mouse-routing.test.tsx` | Same stub, same failure, 6 cases. | Same three members, no-op. |
| `skills-controller.test.ts` | Its `CliConfig` fixture predates the `team` section, and `AgentController` reads `config.team.enabled` at construction — so all 17 cases threw `Cannot read properties of undefined`. Five more then failed on tool COUNTS (`toHaveLength(7)` / `(11)` / `(13)`) and on the byte-identical-prompt assertions, because team mode is on by default and adds `task` plus a `<team_mode>` block. | Fixture gains `team: DEFAULT_TEAM_CONFIG`. The five count/prompt baselines pass `team: TEAM_OFF` **explicitly at each call site** rather than absorbing the change into the expected numbers: those tests are about the skills and plan-mode surface, and the override doubles as the AC-11 claim that a `--no-team` array really is the pre-team one. |

The pattern is the same one §3.12 already reasoned about for `HeadlessController`
and P1-6 resolved by making `subscribeTeam` OPTIONAL there — the headless stubs
in `app.test.tsx` needed no change at all, which is the counterfactual. What the
document missed is that `App` consumes a CONCRETE `AgentController` through
casts in two test files, so the same "do not break existing stubs" argument
applies without the same mechanism being available. Making `App` call
`subscribeTeam?.()` defensively was rejected: on the real path the method always
exists, and a defensive call would hide a genuine wiring regression.

### IF-2 · `HARD_MAX_SUBAGENTS` would have been the second spelling of one bound

§7.2 asks `config/schema.ts` for `HARD_MAX_SUBAGENTS = 10`, while §3.1 and
§3.3.1 put the same 10 in `TEAM_LIMITS.hardMaxSubagents` as "the single
authority on bounds". Two literals for one requirement-level ceiling (R-g) is
exactly the drift `limits.ts` exists to prevent, and the ceiling is enforced in
two places by design — on the config value and again on what the model asks for
— so the two would have had to agree forever by hand.

`schema.ts` therefore re-exports it: `export const HARD_MAX_SUBAGENTS =
TEAM_LIMITS.hardMaxSubagents;`. The named export §7.2 asked for exists; the
number does not. `config/` importing `team/limits.ts` introduces no cycle —
`limits.ts` imports nothing.

### IF-3 · `IdleWatchdog.pause()` is a BOOLEAN, so the child confirm must not use the lead's wrapper

§3.11 says a child's `--confirm` request goes through `TeamHumanQueue`, and
§3.8 says the whole dispatch runs inside `withPausedWatchdog`. It does not say
WHICH confirm closure the queue is handed — and the obvious one is wrong.

`AgentController` already wraps the caller's `confirm` in
`this.withHumanWait(...)`, and `core/engine/watchdog.ts` implements `pause()` as
`this.paused = true` rather than as a counter. So handing the queue that wrapped
closure means: dispatch starts, lead's watchdog paused; child a1's dialog opens,
paused again (no-op); a1's dialog closes, `finally` **resumes the lead's
watchdog** while the dispatch is still running and still silent; the lead is
aborted at `idleTimeoutMs` with `[Agent] idle watchdog fired`. That is I-3
reintroduced by the very mechanism §3.11 adds to fix I-3 one level down.

`TeamHumanQueue` is therefore constructed with the RAW `deps.confirm`. The
child's own watchdog is paused by the queue itself, which is the one that needs
it (P0-4). The constructor carries a comment saying so, because the wrong
version compiles, passes a smoke test, and only fails on a dispatch longer than
the idle timeout with a `--confirm` user in it.

### IF-4 · `SubagentDeps` mixes per-session and per-dispatch inputs

§3.4's `createSubagent(spec, deps)` signature treats every dependency alike, but
`bus` and the resolved `CliConfig` snapshot are per-DISPATCH while the provider
registry, the skill registry and the policy closures are per-SESSION. Passing
one object through would have made `TeamRuntime` mutate a long-lived structure
between dispatches.

Split into `TeamRuntimeDeps` (session-scoped, held by the runtime, reads config
LIVE through `getConfig()`) and `SubagentDeps` (assembled per dispatch, holds
the bus and a config snapshot). No behaviour changes; it is the shape that makes
"a settings-screen edit reaches the NEXT dispatch" true by construction.

### IF-5 · `0` is "not set", not a floor, for every numeric team key

`clampInt` is built on `coercePositiveInt`, which treats `0`, negatives and
unparseable values as ABSENT and returns the fallback. So
`team.maxSubagents: 0` resolves to the default `5`, not to the range minimum
`1`. This is consistent with every other numeric field in `schema.ts` and was
left alone rather than special-cased: a `0` that resolved to `1` would be a
second, silent way to spell "one subagent". `team-config.test.ts` pins the
behaviour with the reason attached, so a future reader does not "fix" it.

### IF-6 · Implementation context: a concurrent change to the same files

This feature was implemented in a working tree that another change
(`config-state-separation`) was editing at the same time — `config/schema.ts`,
`config/store.ts`, `config/load.ts`, `config/cli-commands.ts`, `cli.tsx`,
`ui/App.tsx` and four test files carry both. Every shared file was re-read
immediately before each edit. The two changes are additive in different places
and the full suite is green with both applied, but a reviewer reading
`git status` should expect changes there that belong to neither feature alone.
