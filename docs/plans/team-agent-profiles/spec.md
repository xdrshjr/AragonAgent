# Team agent profiles — design specification

**Feature slug:** `team-agent-profiles`
**Package:** `@aragon-agent/cli` (zero changes under `packages/core/src`)
**Status:** **v2**, design review complete — approved with conditions (see §12)
**Builds on:** `docs/plans/team-subagents/spec.md` v2, shipped as commit `7a6bf563`

---

## 评审记录 (Review notes)

Design review of v1, performed against the tree at commit `7a6bf563`. Every claim
v1 made about existing code was opened at the file and line it named. Twenty
concerns; all four P0 and all nine P1 are resolved in the body below and each row
says where. The seven P2 rows are recorded, four are fixed in passing, and three
are left as stated non-blockers (see §12).

### P0 — must be resolved before implementation

| ID | Concern | Resolved in |
|---|---|---|
| **P0-1** | **`.claude/agents/*.md` does not parse into the §3.2 format, so the interop premise of §0 and §1.1 is unachievable as written.** Claude Code writes `tools:` as a **comma-separated scalar** (`tools: Read, Grep, Bash`), not a YAML array — `parseFrontmatter` returns it as one string, which §3.2 accepts only as an array. Its tool namespace is also different (`Read` / `Bash` / `Glob`, not `read_file` / `bash` / `glob`), and its `model:` is an **alias** (`sonnet` / `opus` / `haiku` / `inherit`), not a model id. v1's own rules then compound each miss: an unrecognized `tools:` fell open to "all tools" (P0-2), and an unrecognized `model:` ran anyway under I-13, so `model: sonnet` would reach the provider verbatim and fail every child of that type. AC-P3 asserted a property the design could not deliver. | §3.2 (field forms), new §3.2.1 (`profile-compat.ts` mapping tables), §3.6 (model aliases), AC-P3 / AC-P23 / AC-P24 |
| **P0-2** | **The unresolvable-`tools:` fallback resolves in the widening direction.** §3.5 said a `tools:` list naming nothing recognizable "resolves to all tools with a doctor warning". That is exactly the failure D-P3 and R-P2 exist to forbid: a profile whose entire purpose is restriction silently becomes a child with `write_file`, `edit_file` and `bash`. The stated rationale (a zero-tool child burns a turn discovering it can do nothing) is real but argues for refusing the profile, not for granting it everything. | §3.5 (rule 3 + the fallback table), §5.1 (`TOOLS_UNRESOLVABLE`), AC-P9, R-P2 |
| **P0-3** | **`baseUrl` is never mentioned, and the §3.6 ModelRef construction carries the session's across a provider switch.** `subagent.ts:241-245` builds `{providerId, modelId, ...(config.baseUrl ? {baseUrl} : {})}`. A session on a custom gateway plus a profile saying `model: anthropic/claude-x` yields providerId `anthropic` pointed at the gateway URL. An implementer following §3.6 literally ships it, and it presents as every child of that type failing with a transport error. | §3.6 (`resolveChildModel`, the baseUrl rule), AC-P25 |
| **P0-4** | **The trust prompt has no owner, and the only existing site cannot serve profiles.** §3.3 says `pendingTrust()` "is what the trust prompt is raised from" without naming a site. The one site is `ui/App.tsx:469-495`; it is gated on `cfg.skills.enabled`, it reads the **skills** service's `untrustedDirs()`, and it latches a one-shot `trustAsked` ref. With `--no-skills` and profiles on — a supported combination — no prompt ever fires and a project's `.aragon/agents` is invisible forever with nothing explaining why. `App.tsx` did not appear in the §7.2 change plan at all. | §3.3 (trust prompt ownership), §7.2 (`ui/App.tsx`), AC-P2 / AC-P21 / AC-P26 |

### P1 — must be resolved before implementation

| ID | Concern | Resolved in |
|---|---|---|
| **P1-1** | **Shape repair drops an entry before a profile can complete it.** `normalize.ts:105-108` `continue`s past any entry whose `description` or `prompt` is empty. Once a profile carries a description, the natural model behaviour is to omit the inline one — and that entry vanishes with no `unknownTypes` record, no report line and no explanation. §3.4's pseudo-code left the ordering of "shape repair" and "resolve profile" unspecified. | §3.4 (explicit four-step order), §3.5 (`description` fallback row) |
| **P1-2** | **`agentsBlockMaxBytes` is used but never defined.** §4.5 and AC-P20 both bound the roster block with it; §4.2's `TEAM_LIMITS` list has six entries and it is not among them, and §7.2 says "six new bounds". | §4.2 |
| **P1-3** | **`DispatchOutcome.usageByModel` was declared required, which stops every existing fixture compiling.** `team-report.test.ts:23` builds outcomes from a complete literal, as do the runtime and session suites; §7.2 listed only `skills-controller.test.ts` under the IF-1 lesson. | §5.2 (optional field), §7.2 (three test files) |
| **P1-4** | **The report header's cost line stays single-table under mixed models.** §3.6 replaced `TaskToolDeps.modelCost` with `getModelCost(providerId, modelId)` and added a per-model breakdown, but `report.ts:119-124` computes the headline `Cost:` from `outcome.usage` times one table — which is the arithmetic §3.6 set out to fix. Nothing said what supplies that line once `modelCost()` is gone. | §3.6 (header rule), §6.2, AC-P12 |
| **P1-5** | **An unknown model reports `$0.00`, not "unknown".** `ModelRegistry.buildRuntimeModel` returns `cost: { input: 0, output: 0 }` (`model-registry.ts:126`), so I-13's fallback makes `computeCost` return a confident zero. A dispatch that really did spend money renders as free — precisely R-P5's under-reporting, reintroduced by the mitigation. | §3.6 (`getModelCost` uses `getModel`, never the fallback), §5.2, §6.2, AC-P12 |
| **P1-6** | **§3.7 specifies a bespoke enumerated-tag denylist where core already exports the general solution.** `sanitizeForPromptBlock` (`core/src/index.ts:176`, `skills/disclosure.ts:72-90`) is the established treatment for untrusted prose entering a tagged prompt block — it substitutes fullwidth `<` / `>` rather than enumerating six tag names, and additionally strips the zero-width and bidirectional-override class (Trojan Source), which v1's sanitizer did not. A persona is the same problem as a skill body; a second, weaker mechanism for it is drift. | §3.7 |
| **P1-7** | **`readOnly` arrives as a string and no coercion rule was stated.** `ParsedFrontmatter.data` is `Record<string, string \| string[]>` (`frontmatter.ts:15-16`), so `readOnly: false` is the **truthy** string `"false"`. A profile author who writes it explicitly gets a child locked into the plan gate with nothing explaining why. | §3.2 (boolean coercion rule), AC-P27 |
| **P1-8** | **AC-P17's 80-column degradation is unimplementable as scoped.** `TeamPanelProps` carries `rows`, not columns (`TeamPanel.tsx:30-38`), and `App.tsx:1101-1107` passes only `rows`. The width already exists there as `cols` (`App.tsx:119`) but must be threaded, and `App.tsx` was absent from §7.2. | §6.1, §7.2, AC-P17 |
| **P1-9** | **The roster overflow line instructs the model to run a command only the user can run.** `- ...and N more (run /agents to list)` is rendered into the model's system prompt; `/agents` is a slash command handled by the CLI, never a tool. | §4.5 |

### P2 — recorded; four fixed in passing, three accepted

| ID | Concern | Disposition |
|---|---|---|
| **P2-1** | A `profile.name` may be 32 chars but `TEAM_LIMITS.labelChars` is 12 and the bus addresses children **by label** (`normalize.ts:63-79`), so a name used as a default label must still pass through `slugLabel` + `dedupeLabel`. | Fixed — §3.5 `label` row. |
| **P2-2** | `TASK_DESCRIPTION` still tells the model each subagent has "the same tools" (`task-tool.ts:66`), which stops being true the moment a profile filters. The lead writes the child's brief, so it will write briefs the child cannot execute. | Fixed — §4.1, §4.5 (restriction marker in the roster). |
| **P2-3** | `schema.ts:427-431` says the `team` section is "SCALARS ONLY, exactly one level deep". Adding `profileDirs: string[]` is legal for the merge (I-4) but contradicts that comment, and R-P11 cited it as if it already permitted arrays. | Fixed — §4.2 note; §7.2 lists the comment amendment. |
| **P2-4** | Citation drift: `controller.ts:366` is inside `composeSystemPrompt`, not `rebuildSystemPrompt` (376); the trust list is `service.ts:777-799`, not `777-808` (805-813 is `trustForSession`, which no production call site uses). | Fixed — I-3, D-P1, §1.2. |
| **P2-5** | `aragon agents doctor`'s "a body that never asks for a final report" check (§4.3, R-P7) is a heuristic with no definition. An undefined heuristic in a doctor command becomes whatever the first implementer guesses. | Accepted with a narrowed definition — §4.3. |
| **P2-6** | `--no-agent-profiles` is inconsistent with the existing `--no-team` / `--no-skills` shape. | Accepted as-is; renaming is a one-line follow-up and the longer form is unambiguous next to `--no-team`. |
| **P2-7** | Right-sizing: 9 new files, 18 modified and two full command surfaces (`aragon agents` x3 verbs, `/agents` x4 verbs) in one round, with the model/cost work folded in. | Accepted — the cost work is genuinely forced by `model:` (I-12), and the command surfaces are the only way a user can see why a profile did not load. §12 records the splittable seam. |

---

## 0. 需求映射 (Requirement trace)

The user requirement that produced `team-subagents` had seven clauses. Six of
them shipped in v2. This document exists because of the seventh, and because one
of its own follow-ups (§11 item 1) turned out to be the same feature seen from a
different angle.

| ID | Requirement clause | v2 status | This round |
|---|---|---|---|
| R-a | Add a TEAM subagents mode | shipped | unchanged |
| R-b | Default on, switchable in the config file | shipped (`team.enabled: true`) | two new keys, same shape |
| R-c | The agent decides for itself whether to delegate | shipped (`<team_mode>` guidance + `task`) | the roster becomes part of that decision |
| R-d | Combined execution summary back to the lead | shipped (`buildDispatchReport`) | gains type + per-model cost columns |
| R-e | A communication tool, telephone-like, not too frequent | shipped (`team_send` / `team_wait` + quotas) | unchanged |
| **R-f** | **"和 anthropic 的 claudecode 类似的 subagents 机制"** | **partial** | **the subject of this document** |
| R-g | Adaptive count, hard max 10, configurable, usually <= 5 | shipped | unchanged |
| R-h | TUI shows subagents running when there are any | shipped (`TeamPanel`) | one column added |

**What "partial" means for R-f.** v2 reproduced the *shape* of Claude Code's
mechanism — a `Task`-like tool, one level of depth, a fresh context per child, a
combined report. What it did not reproduce is the part users actually configure:
Claude Code subagents are **named, reusable definitions stored as markdown files
with YAML frontmatter** (`.claude/agents/*.md`), each carrying its own
description, tool allowlist, model and system prompt, which the lead selects by
name through the tool's `subagent_type` parameter. In v2 every child is
anonymous and identical: `normalizeSubagentSpecs` produces
`{label, description, prompt, readOnly}` (`team/types.ts:17-30`) and every child
gets the lead's model, the lead's tool set and a generic
`<subagent_role>` block. A user who has already written agent definitions for
Claude Code gets nothing from them here, and a user who wants a consistent
"reviewer" persona has to paste it into every `prompt`.

This round closes that gap, and in doing so absorbs follow-up §11 item 1 of the
previous document (per-subagent model): a `model:` field is one line of
frontmatter once profiles exist, and pointless without them.

---

## 1. Overview

### 1.1 What is being built

**Agent profiles**: named subagent definitions discovered from markdown files on
disk, selectable per delegation. A profile is a file such as
`.aragon/agents/reviewer.md` whose frontmatter declares `name`, `description`,
an optional `tools` allowlist, an optional `model`, and an optional `readOnly`
flag, and whose body is the persona — the standing instructions that child gets
on top of the per-dispatch brief. The lead sees the available names in its
`<team_mode>` system-prompt block and picks one per entry through a new
`subagent_type` field on the existing `task` tool. Everything else about a
dispatch is unchanged: one batch, one slot pool, one combined report.

Discovery mirrors the skills subsystem exactly, because that subsystem already
solved this problem in this codebase: four scopes in ascending precedence
(bundled, user, project, env), `.claude/agents` read alongside `.aragon/agents`
for drop-in interop, and project-scope directories inert until the user trusts
them (`skills/paths.ts:61-94`, `skills/service.ts:777-799`). Reusing that model
rather than inventing a second one is the single largest source of correctness
in this design: the trust prompt, the path normalization on Windows
(`skills/paths.ts:105-113`), and the precedence layering are all code that
already exists and is already tested.

**Interop is a translation, not a coincidence** (P0-1). `.claude/agents/*.md` is
not a file this format happens to also accept: Claude Code writes `tools:` as a
comma-separated scalar over its own tool namespace and `model:` as a size alias.
Reading those files therefore needs an explicit, greppable mapping layer
(`profile-compat.ts`, §3.2.1) that is applied to **every** scope, not only to
`.claude/agents` — a user who copies a working Claude Code profile into
`.aragon/agents` must not get different behaviour from the same bytes.

The second half of the round is what a per-child `model:` forces: the report and
the status bar can no longer assume one cost table. `TaskToolDeps.modelCost` is
a single `() => ModelCost | undefined` today (`team/task-tool.ts:40`,
`agent/controller.ts:263`) and the report multiplies aggregate tokens by it once
(`team/report.ts`). With three children on the lead's model and two on a cheap
one, that number is simply wrong. Cost therefore moves to per-child, computed at
the moment a child settles, and the report gains a per-model breakdown that
degrades to today's exact single line when every child shares the lead's model.

### 1.2 Why this shape

**Why files rather than config keys.** A persona is prose — often several hundred
words of it. `config.json` is a flat scalar store merged one level deep
(`config/store.ts:121-127`) and hand-edited by users (`config/store.ts:48-51`);
multi-paragraph prompts do not belong in it. Files also give the thing users
actually want: a `reviewer.md` committed to the repository so the whole team
delegates the same way, and `.claude/agents` compatibility for free.

**Why the roster lives in the system prompt, not the tool description.** This is
the one non-obvious structural decision and it is forced by an existing
constraint. The tool array — and every tool object in it, `description`
included — is built exactly once per session, and `controller.ts:231-246`
forbids rebuilding it because `Agent.setTools()` mutates the live `ToolRegistry`
while `submit_plan` flips the session mode from inside a tool execution.
`rebuildSystemPrompt()`, by contrast, is a live path already exercised by
`/skills` and `/team` (`controller.ts:376`, rendering the `teamBlock` at
`controller.ts:366`). Putting the profile roster in the
tool description would make `/agents reload` advertise a stale list, which is the
same failure mode P0-2 caught for `/team on` in the previous round: the model is
told about a capability the runtime does not have, every call comes back wrong,
and nothing explains why. The roster is therefore rendered into `<team_mode>`,
which is rebuilt on demand; the tool description says only that valid values are
listed there.

**Why a profile can only tighten.** D-13 of the previous round states that no
field anywhere may give a child more permission than the session that spawned
it, and it is enforced today by `spec.readOnly` forcing the plan gate on but
never off (`team/subagent.ts:183`). Profiles are read from files that arrive with
a cloned repository, so the same rule must hold with more force: `tools` can only
subtract from the child's built-in array, `readOnly: true` can only add the
restriction, and there is no field that grants a tool, raises a quota or exempts
a child from the skills ceiling.

### 1.3 Non-goals

1. **Nested delegation.** Children still never receive `task` (D-3). A profile
   cannot request it; `task` is not in the filterable set.
2. **Adding tools a child would not otherwise have.** `tools:` is an
   intersection, never a union. MCP servers, per-profile scripts and custom tool
   registration are out.
3. **Child-local skill frames.** Still deferred exactly as the previous
   document's §11 item 6 describes; children keep `skill_find` only (D-16).
4. **Authoring UI or a profile generator.** `aragon agents init <name>` writing a
   stub is a two-line follow-up, not part of this round.
5. **Per-profile API keys or provider credentials.** A profile may name a model;
   keys stay session-level (`controller.resolveKey`).
6. **Warm pools, streaming child text, deadlock detection.** Unchanged from the
   previous document's follow-up list.

---

## 2. Constraints inherited from the existing code

Every row was checked against the file it names, at the line it names, in the
tree at commit `7a6bf563`.

| ID | Constraint | Evidence | Consequence for this design |
|---|---|---|---|
| **I-1** | `parseFrontmatter` is already exported from core and is a strict YAML subset: scalars, inline arrays, block arrays, **no nested maps**; returns `null` (never throws) on malformed input. **Every value is a `string` or a `string[]`** — `ParsedFrontmatter.data` has no boolean or number member — and the block itself is capped at `FRONTMATTER_MAX_BYTES` (8 KiB) / `FRONTMATTER_MAX_LINES` (200). | `core/src/index.ts:166`; `core/src/skills/frontmatter.ts:15-21,88-105`; `core/src/skills/constants.ts:151-152` | The profile format is one level deep by construction. Reuse it; do not add a YAML dependency (core ships zero required runtime deps). Every non-string field needs an explicit coercion rule (P1-7, §3.2). |
| **I-2** | Skill roots resolve through four scopes in ascending precedence, with `.claude/skills` marked non-writable for interop. | `skills/paths.ts:56-94` | `profile-paths.ts` is a near-copy. `.claude/agents` is read-only in exactly the same sense. |
| **I-3** | Project-scope directories are **trust-gated by skipping the scan entirely** — an untrusted root is pushed onto `pendingTrust` and `continue`d past before any file is opened. The list is `skills.trustedProjectDirs`, normalized for case and symlinks. | `skills/service.ts:156-167` (the gate), `777-799` (the list); `skills/paths.ts:105-113`; `config/schema.ts:255,303` | Profiles reuse that list rather than adding a second one (D-P6); untrusted files are never read (§3.3 / AC-P2); the trust prompt copy must name both kinds of content (R-P4). |
| **I-3b** | The trust prompt exists in **exactly one place**, `ui/App.tsx:469-495`. It is gated on `cfg.skills.enabled`, it reads `SkillService.untrustedDirs()`, it latches a one-shot `trustAsked` ref, and on approval it calls `service.trustDir(dir)` + `service.reload()`. `SkillService.trustForSession()` exists but has **no production call site**. | `ui/App.tsx:463-495`; `skills/service.ts:389,805-813` | The effect must become subsystem-agnostic or profiles are unreachable under `--no-skills` (P0-4, §3.3). `App.tsx` is therefore a modified file. Session-only trust is out of scope because it is dead code today. |
| **I-3c** | `SkillService.trustDir()` **persists** to `skills.trustedProjectDirs` through `updatePersistedConfig`, and `isTrusted()` re-normalizes both sides on every call. | `skills/service.ts:777-789` | One approval covers both subsystems with no extra state, which is what makes D-P6 cheap as well as correct. |
| **I-4** | An array value inside a persisted config section is fine; a nested **object** is not. `skills.projectDirs` is precedent and the merge is a one-level spread. | `config/schema.ts:254`; `config/store.ts:121-127,162-170` | `team.profileDirs: string[]` is legal. A `team.profiles: {…}` object would break the merge. |
| **I-5** | `TEAM_LIMITS` is the single authority on structural bounds; a second literal of the same bound is the drift IF-2 already caught. | `team/limits.ts:8-34` | Every new cap goes there. `config/schema.ts` re-exports if it needs a name. |
| **I-6** | `src/team/**` is inside the glyph scanner's scope: **no non-ASCII byte in any source literal**. | `team/limits.ts:3-6`; `glyphs.test.ts` | New modules under `src/team/` inherit the rule. Profile *content* is runtime data, not a literal, but anything rendered into the panel must be width- and control-char-sanitized. |
| **I-7** | The tool array is immutable per session; the system prompt is rebuildable. | `controller.ts:231-246,366`; previous D-17 / P0-2 | The roster goes in `<team_mode>` (D-P1). |
| **I-8** | `createBuiltinTools` composes wrappers in a fixed order and `tools.test.ts::C7` pins `HOST_TOOL_NAMES` to its output. | `tools/index.ts:341-392`; previous D-15 / P0-1 | `tools:` is applied as a filter on the returned array inside `buildSubagentTools`, not as a new option on the factory. |
| **I-9** | A child's tool array is built (`subagent.ts:239`) **before** its system prompt (`subagent.ts:248`), and the prompt is derived from that array. | `team/subagent.ts:239-262` | Filtering before `buildSystemPrompt` makes the child's prompt describe its real tools with no extra work. |
| **I-10** | Session-scoped and per-dispatch dependencies are already split, and mixing them was IF-4. | `team/runtime.ts:42-61` vs `team/subagent.ts:59-88` | The registry is session-scoped (`TeamRuntimeDeps`); the resolved profile snapshot is per-dispatch (`SubagentSpec`). |
| **I-11** | `SubagentRun.summary` is the last non-empty assistant text; a child that produces nothing settles as `failed` with `run produced no output`. | `team/subagent.ts:311-328`; `team/runtime.ts:263-271` | A profile whose persona suppresses a final message would silently produce failed children. The persona template and `aragon agents doctor` both warn about it (R-P7). |
| **I-12** | Cost is computed once, from the lead's single `ModelCost`. | `team/task-tool.ts:39-40,159-160`; `agent/controller.ts:263`; `agent/usage.ts:9` | Per-child models make that arithmetic wrong; §3.6 replaces it. |
| **I-13** | `ModelRegistry.getModel(providerId, modelId)` returns `ModelInfo \| undefined`, with `buildRuntimeModel` as the fallback for unknown ids. **`buildRuntimeModel` returns `cost: { input: 0, output: 0 }`**, so it is a valid fallback for *running* a model and an invalid one for *costing* it. | `core/src/llm/model-registry.ts:59,112-129`; `controller.ts:779-783` | Running an unknown id stays tolerant; costing it must go through `getModel()` and yield `undefined`, never a confident zero (P1-5, §3.6). |
| **I-14** | `TeamEvent` is a CLI-local union and core's public API is frozen. | `team/types.ts:1-12,115-120`; `public-api.test.ts` | No new event member; new data rides `SubagentRun` on `agent_update` (D-P12). |
| **I-15** | `/team` refuses configuration changes mid-dispatch. | `commands/builtins.ts:135-138` | `/agents reload` copies the guard verbatim. |
| **I-16** | The child's `ModelRef` is built from three config fields, `baseUrl` included, and `baseUrl` is meaningful only relative to the provider it was configured for. | `team/subagent.ts:241-245`; `controller.ts:282-286` | A per-child provider switch must drop the session `baseUrl` (P0-3, §3.6). |
| **I-17** | `sanitizeForPromptBlock` is exported from core and is the codebase's established treatment for untrusted prose entering a tagged prompt block: it substitutes fullwidth `<` / `>` rather than enumerating tag names, and strips the zero-width / bidirectional-override class. | `core/src/index.ts:176`; `core/src/skills/disclosure.ts:8-18,72-90` | The persona reuses it instead of a second, narrower sanitizer (P1-6, §3.7). |
| **I-18** | `TeamPanelProps` carries `rows`, `reducedMotion`, `theme`, `caps` and an injectable `now` — **no width**. `TermCapabilities` is `{colorLevel, unicode}`; the width lives in `App` as `cols`. | `ui/TeamPanel.tsx:29-38`; `ui/capabilities.ts:13-18`; `ui/App.tsx:119,1101-1107` | A width-dependent column needs a new prop threaded from `App` (P1-8, §6.1). |
| **I-19** | `normalizeSubagentSpecs` `continue`s past any entry whose clamped `description` or `prompt` is empty, before anything else can see it, and the surviving `label` is slugified to `[a-z0-9-]{1,12}` then deduped case-insensitively because the bus addresses children by label. | `team/normalize.ts:100-116`, `44-79` | Profile resolution must run **before** the empty-field drops (P1-1, §3.4), and any name used as a default label goes through the same slug + dedupe (P2-1, §3.5). |
| **I-20** | Existing team fixtures construct `DispatchOutcome` from a complete object literal. | `__tests__/team-report.test.ts:23-40`; `team-runtime.test.ts`; `team-session.test.ts` | A new **required** member of that interface is a compile break across three suites; new members are optional (P1-3, §5.2). |

---

## 3. Technical design

### 3.1 Module map

```
packages/cli/src/team/
  profile-types.ts      AgentProfile, ProfileScope, ProfileIssue, ProfileRoot   (new)
  profile-paths.ts      root resolution, ascending precedence                   (new)
  profile-compat.ts     Claude Code tool/model name maps (pure, data only)      (new)
  profile-parse.ts      one file  -> AgentProfile | issues   (pure, no I/O)     (new)
  profile-registry.ts   scan, index, collisions, trust gate, reload             (new)
  profile-resolve.ts    profile + inline spec -> resolved SubagentSpec (pure)   (new)
  profile-cost.ts       per-child + per-model cost roll-up (pure)               (new)
  agents-cli.ts         `aragon agents [list|show|doctor]`                      (new)
  limits.ts             + 6 bounds, TEAM_BLOCK_VERSION bump                     (modified)
  types.ts              + spec/run/outcome fields                               (modified)
  normalize.ts          + subagent_type resolution                              (modified)
  task-tool.ts          + subagent_type schema, unknown-type refusal            (modified)
  subagent.ts           + per-child model, tool filter, persona splice          (modified)
  runtime.ts            + registry dep, per-child cost, usageByModel            (modified)
  prompt.ts             + buildTeamAgentsBlock, persona section                 (modified)
  report.ts             + type/model columns, per-model cost block              (modified)
packages/cli/src/commands/
  agents.ts             `/agents` slash command                                 (new)
```

The split between `profile-parse` (pure), `profile-registry` (I/O) and
`profile-resolve` (pure) is deliberate and mirrors `normalize.ts`: the two
decision-making halves are unit-testable without touching a filesystem, and the
half that touches the filesystem contains no policy.

`profile-compat.ts` is a fourth, even smaller piece: two frozen lookup tables and
nothing else. It is a separate file rather than three `const`s inside
`profile-parse.ts` so that "which Claude Code names do we understand?" is one
`cat` away when a user reports that their profile did not load, and so that
adding a name is a data change with a data test.

### 3.2 The profile file format

```markdown
---
name: reviewer
description: Reviews a diff for correctness and convention drift
tools: [read_file, list_dir, glob, grep, bash]
model: inherit
readOnly: true
---

You are a code reviewer. Read before you conclude...
```

| Field | Type | Required | Default | Rule |
|---|---|---|---|---|
| `name` | scalar | no | file basename, slugified | `[a-z0-9][a-z0-9-]*`, <= `profileNameChars`. Slugified with the same helper `normalize.ts` already uses for labels. |
| `description` | scalar | **yes** | — | <= `profileDescriptionChars`. This is what the lead reads when choosing; a profile without one is `invalid`. |
| `tools` | inline array, block array **or comma-separated scalar** | no | inherit all | Every form normalizes to `string[]`, then each entry goes through the §3.2.1 alias map, then §3.5 rule 3 decides. |
| `model` | scalar | no | `inherit` | `inherit` \| a §3.2.1 size alias \| `<modelId>` \| `<providerId>/<modelId>` (§3.6). |
| `readOnly` | scalar | no | `false` | **String comparison, not truthiness** (see below). Only `true` has an effect (tighten-only). |
| body | markdown | no | `''` | The persona. Capped at `profileBodyMaxBytes`, sanitized per §3.7. |

Unknown frontmatter keys are preserved by `parseFrontmatter` and **ignored** —
the same forward-compatibility contract SKILL.md has (`frontmatter.ts:6-8`), so
a file carrying a future Claude Code field still loads here.

**Boolean coercion is a string comparison** (P1-7). `ParsedFrontmatter.data` is
`Record<string, string | string[]>` (I-1): there is no boolean in it, so
`readOnly: false` arrives as the string `"false"`, which is truthy. The rule is
therefore explicit and total:

```ts
// profile-parse.ts
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

function parseBoolField(raw: string | string[] | undefined): boolean | 'invalid' {
  if (raw === undefined) return false;
  if (Array.isArray(raw)) return 'invalid';
  const word = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return 'invalid';                     // -> BAD_BOOLEAN issue, field ignored
}
```

An unrecognized word is a `BAD_BOOLEAN` issue and the field is **ignored**
(treated as absent), not silently coerced in either direction. Ignoring is the
right failure here precisely because both coercions are wrong in a way the user
cannot see: truthiness would lock a child into the plan gate the author did not
ask for, and `Boolean(word) === false` would drop a restriction the author did
ask for. The issue is what makes the state visible.

### 3.2.1 Claude Code compatibility (`profile-compat.ts`)

The interop claim in §0 is only worth making if a file written for Claude Code
actually works, and the two fields that carry policy are exactly the two whose
on-disk form differs (P0-1). A real `.claude/agents/reviewer.md` looks like this:

```markdown
---
name: code-reviewer
description: Expert code review specialist
tools: Read, Grep, Glob, Bash
model: sonnet
---
```

`tools:` is a **comma-separated scalar**, so `parseFrontmatter` yields the single
string `"Read, Grep, Glob, Bash"` — an array-only reader sees no tools at all.
The names are Claude Code's, not this project's. And `model:` is a **size alias**,
not a model id, so passing it through would reach the provider verbatim.

Three rules, applied to **every** scope rather than only to `.claude/agents`
(§1.1): the same bytes must mean the same thing wherever a user puts them.

**1. `tools` normalizes to an array first.**

```ts
function toolList(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = Array.isArray(raw) ? raw : raw.split(',');
  const out = parts.map((s) => s.trim()).filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;   // `tools:` present but empty = absent
}
```

**2. Each entry goes through a case-insensitive alias map**, then must match a
name the child's array actually contains:

| Claude Code | this project | Claude Code | this project |
|---|---|---|---|
| `Read` | `read_file` | `Bash` | `bash` |
| `Write` | `write_file` | `Glob` | `glob` |
| `Edit` / `MultiEdit` | `edit_file` | `Grep` | `grep` |
| `LS` | `list_dir` | `Skill` / `SlashCommand` | `skill_find` |
| `Task` | *dropped* (D-3: children never delegate) | `WebFetch` / `WebSearch` / `NotebookEdit` / `TodoWrite` | *dropped, no equivalent* |

A dropped name is a `UNKNOWN_TOOLS` issue naming it, and the profile still loads
on whatever did resolve. `Task` is called out separately in `doctor`'s wording,
because "your reviewer profile cannot dispatch subagents here" is a real
behavioural difference a migrating user should be told about once rather than
discover from a report.

**3. `model` aliases resolve against the session provider** (§3.6): `opus`,
`sonnet`, `haiku` and `inherit`. `inherit` is `null`. The other three map to the
highest-, middle- and lowest-tier model the `ModelRegistry` lists for the session
provider (`getModels(providerId)`, ordered as registered); a provider that lists
fewer than three collapses to what it has. An alias with **no** match is
`UNKNOWN_MODEL` and falls back to inherit — the D-P8 direction, and the reason
I-13's "run it anyway" tolerance is explicitly **not** extended to profile
models: the lead's `--model` is typed by a user watching the result, a profile's
is fired N children deep inside one tool call.

The tables are data, so they are exhaustively asserted (AC-P23). They are also
deliberately one-directional: nothing in this project ever writes a
`.claude/agents` file.

### 3.3 Discovery and precedence

`resolveProfileRoots(cwd, profileDirs)` returns, in ascending precedence:

| Scope | Directory | Writable | Trust-gated |
|---|---|---|---|
| `user` | `~/.aragon-agent/agents` (`getUserDataDir()/agents`) | yes | no |
| `project` | `<cwd>/.aragon/agents` | yes | **yes** |
| `project` | `<cwd>/.claude/agents` | no (interop) | **yes** |
| `env` | each entry of `ARAGON_AGENTS_PATH`, split on the platform delimiter | no | no |

There is no bundled scope: shipping opinionated personas in the npm package is a
product decision nobody has made, and an empty roster is a coherent state.

`AgentProfileRegistry.discover()` walks each existing root, reads every `*.md`
entry at depth 1 (no recursion; `profileScanMaxFiles` cap), parses it, and
indexes by `name`. A later root **replaces** an earlier one with the same name,
and the replacement is recorded on the surviving record as `shadows: string[]`
so `aragon agents doctor` can report it. Files that fail to parse are kept as
`invalid` records with their issues attached rather than dropped — same rule as
skills (`frontmatter.ts:82-87`): a broken profile stays visible to the user.

**Trust.** An untrusted project root is **not scanned at all** — its files are
never opened. This is a verbatim copy of `SkillService.discover()`
(`skills/service.ts:156-167`), where a project-scope root whose directory is
absent from `skills.trustedProjectDirs` is pushed onto `pendingTrust` and
`continue`d past before `scanRoot` runs. Copying the *shape* (scan, then hold the
records back) would be strictly worse: profile bodies are untrusted prose, and
parsing them into memory and into `doctor` output before the user has approved
the directory puts attacker-authored text on a screen the user is reading in
order to decide whether to trust it.

So an untrusted directory contributes **no records and no names**. It appears in
`/agents dirs` as `untrusted`, and `/agents list` says how many roots were
skipped for that reason. `AgentProfileRegistry.pendingTrust()` returns those
directories.

Reusing the skills trust list means a directory the user already trusted for
skills loads profiles with no second prompt; that is the intended behaviour (one
decision per directory, `skills/paths.ts:97-103`) and its cost is R-P4.

**Who raises the prompt** (P0-4). There is exactly one trust prompt in the
product, at `ui/App.tsx:463-495`, and as written it cannot serve profiles: it
returns early on `!cfg.skills.enabled`, it reads `SkillService.untrustedDirs()`,
and it latches a single `trustAsked` ref (I-3b). Left alone, `--no-skills` with
profiles on means a project's `.aragon/agents` is never offered, never loaded,
and never explained. The effect becomes subsystem-agnostic:

```tsx
// ui/App.tsx — one effect, two subsystems, still one question per directory.
const skillsOn = cfg.skills.enabled;
const profilesOn = cfg.team.enabled && cfg.team.profiles;
if (trustAsked.current || (!skillsOn && !profilesOn)) return;

const skillService = controller.getSkillService();
const pending = dedupeByNormalizedPath([
  ...(skillsOn ? skillService.untrustedDirs() : []),
  ...(profilesOn ? controller.getAgentProfiles()?.pendingTrust() ?? [] : []),
]);
```

Three properties this shape has to keep, each of which is a way it has gone
wrong before:

1. **One question per directory, whatever is in it.** `.aragon/skills` and
   `.aragon/agents` are two roots under one repository the user is deciding
   about once. The list is deduped on `normalizeTrustPath` (`skills/paths.ts:105-113`),
   not on the raw string, or a Windows user is asked twice about `C:\Repo` and
   `c:\repo\` — the exact "trains them to click yes" failure that helper exists
   to prevent.
2. **Approval writes once and reloads both.** `skillService.trustDir(dir)`
   persists to the shared `skills.trustedProjectDirs` (I-3c); the handler then
   calls `skillService.reload()` **and** `controller.reloadAgentProfiles()`,
   whichever subsystems are on. Reloading only the one that raised the entry
   leaves the other still holding an empty registry until the next launch.
3. **The copy names whatever is actually pending**, and both when both are
   (R-P4 / AC-P21). Three strings, selected by what the directory contributes,
   because a prompt that says "skills" while loading agent profiles is worse
   than one that is merely long:
   - skills only: today's wording, unchanged.
   - profiles only: `Load project agent profiles from <dir>? Agent profiles in this directory define subagents and can inject instructions into this session.`
   - both: `Load project skills and agent profiles from <dir>? Both can inject instructions into this session.`

Session-only trust is **not** wired in. `SkillService.trustForSession()` exists
but has no production call site (I-3b), so extending a mechanism nobody reaches
would be inventing behaviour rather than mirroring it. Declining still means
"skipped this session, asked again next launch", which is the right default for a
repository the user has not read yet.

### 3.4 The dispatch lifecycle, with profiles

```
session start
  controller ctor: if (config.team.enabled && config.team.profiles)
                     registry = new AgentProfileRegistry({...}); registry.discover()
  rebuildSystemPrompt -> buildTeamBlock({..., agents: registry.roster()})
                         -> <team_mode> now contains <available_agents>

model calls task({subagents: [{subagent_type: "reviewer", label, description, prompt}, ...]})
  task.execute
    (existing guards 1-3 unchanged: busy / team off / no key)
    normalizeSubagentSpecs(raw, max, registry)
      per entry, IN THIS ORDER (P1-1):
        1. resolve subagent_type
             hit  -> profile
             miss -> DROP the entry, record in `unknownTypes`, next entry
        2. shape repair: clamp label / description / prompt as today
        3. fill from the profile: description falls back to profile.description
        4. drop test: still no description OR still no prompt -> drop  (as today)
        5. applyProfile(spec, profile)                      [tighten-only, §3.5]
      returns {specs, requested, unknownTypes}
    if specs.length === 0 -> non-error refusal listing valid names   (D-P4)
    withPausedWatchdog -> runtime.dispatch(specs, requested, signal)

runtime.dispatch
  per child: createSubagent(spec, subDeps, hooks)
    tools   = filter(buildSubagentTools(...), spec.toolAllowlist)    [§3.5]
    model   = resolveChildModel(spec, config)                        [§3.6]
    prompt  = buildSystemPrompt({..., subagentBlock: buildSubagentBlock({..., persona})})
  on settle: run.costUsd = computeRunCost(run.usage, getModelCost(run.model))
  outcome.usageByModel = foldByModel(runs)

report: header (summed per-child cost) + per-child "[type . model]"
        + per-model cost block when > 1 model
```

**Steps 1 and 4 are in that order for a reason** (P1-1). `normalize.ts:105-108`
`continue`s past any entry with an empty `description` or `prompt`, and the whole
point of a profile carrying a `description` is that the model stops writing one.
Repairing shape first would delete typed entries before anything knew they were
typed: no `unknownTypes` record, no "n of m requested" line, no report section —
a subagent the model asked for and believes ran, gone with nothing anywhere
saying so. Resolving first also means a `subagent_type` typo is reported as a
typo even when the entry was malformed in some second way.

`prompt` has **no** profile fallback and step 4 still drops on it (§3.5): a
persona is standing instructions, and a child dispatched with no job is a
guaranteed wasted turn.

Every arrow above already exists except the three marked steps; the feature is
additive at four call sites (`normalize`, `subagent`, `runtime`, `prompt`) plus
the registry itself.

### 3.5 Resolution: tighten-only, field by field

`applyProfile(spec, profile)` in `profile-resolve.ts` is pure and total:

| Field | Rule | Rationale |
|---|---|---|
| `readOnly` | `spec.readOnly \|\| profile.readOnly` | Boolean OR is the tighten-only operator (D-13). |
| `toolAllowlist` | `profile.tools` if present, else `undefined` (= all) | An inline spec has no tool field, so there is nothing to intersect with yet; when one is added later the operator is set intersection, and the type is written to make that the only possible extension. |
| `model` | `profile.model` if resolvable, else inherit + one warn | §3.6. |
| `persona` | `profile.body` | Spliced into `<subagent_role>`; never replaces the brief. |
| `type` | `profile.name` | Carried on the spec and the run, for the panel and the report. |
| `description` | **spec wins; profile fills in** | The inline description is about *this* dispatch ("audit the auth middleware"); the profile's is about the role ("reviews a diff"). The panel shows the former, `/agents list` the latter. But an empty inline description is a **drop** (I-19), so the profile's is used rather than losing the child (P1-1). Applied at step 3 of §3.4, before the drop test. |
| `label` | **spec wins**, defaulting to `slugLabel(profile.name, i)` then `dedupeLabel` | Two children of the same type in one dispatch must still be distinguishable (`normalize.ts:63-79`), and the bus **addresses children by label** — so a 32-char `profileNameChars` name cannot become a label directly. It goes through the same 12-char slug + case-insensitive dedupe as any other label (P2-1); `reviewer` and `reviewer-2`, never two `reviewer`s. |
| `prompt` | **spec wins, always; no fallback** | The persona is standing instructions; the prompt is the job. A profile cannot supply the job, and an entry without one is still dropped. |

The tool filter itself lives in `buildSubagentTools` and has three hard rules:

1. `team_send` / `team_wait` are **never** filtered out, whatever `tools:` says.
   Same reasoning as their policy exemption (`limits.ts:89-102`): removing them
   dead-ends the bus, and a child that cannot receive is worse than a child with
   one tool too many.
2. Filtering happens **after** `createBuiltinTools` returns and **before**
   `buildSystemPrompt` (I-8 / I-9), so wrappers compose exactly as they do today
   and the child's prompt describes its real tool set with no second code path.
   It runs on `t.name`, which every wrapper preserves, so its position relative
   to `withMailboxTail` (`subagent.ts:208`) does not matter.
3. **The filter never widens, and neither does its failure path** (P0-2). This is
   the rule v1 got backwards, so it is stated as a table over what
   `applyProfile` produces:

| `tools:` after §3.2.1 | `spec.toolAllowlist` | Profile state |
|---|---|---|
| absent, or present but empty | `undefined` (= every tool the child would get) | `active` |
| >= 1 name resolved | exactly those names | `active`; unresolved names are a `UNKNOWN_TOOLS` issue |
| present, non-empty, **zero** names resolved | — | **`invalid`** (`TOOLS_UNRESOLVABLE`); the profile is not in the roster and `subagent_type` refuses it |

The last row is the P0-2 fix and it is worth being explicit about why it is not
the obvious alternative. v1's rule — fall open to "all tools" with a doctor
warning — turns the one field whose entire purpose is restriction into its
opposite, silently, on the file most likely to hit it: a `.claude/agents`
reviewer whose `tools: Read, Grep` failed to map would be handed `write_file`,
`edit_file` and `bash`. That is the widening D-P3 and R-P2 forbid, delivered by
the mechanism meant to prevent it.

v1's stated worry about the other direction — a zero-tool child burning a turn to
discover it can do nothing — is real, which is why the answer is **`invalid`**
rather than an empty array. An invalid profile never reaches a dispatch at all:
it is absent from `<available_agents>`, so the model does not select it; if it
does anyway (a stale roster, a guess), the entry is dropped by the existing
unknown-type path and §4.1's refusal names the valid types. Nothing is
dispatched, nothing is silently widened, and `doctor` says which names it could
not resolve. After §3.2.1, this row should be rare; when it fires it means the
file's `tools:` line is meaningless here, and refusing to guess what the author
meant is the only safe reading.

### 3.6 Per-child model and the cost roll-up

**Resolution.** `resolveProfileModel(raw, session, deps)` returns
`{providerId, modelId}` or `null`:

- `inherit` / absent -> `null` (child uses `config.provider` + `config.model`,
  exactly as today, `subagent.ts:241-245`).
- a §3.2.1 size alias (`opus` / `sonnet` / `haiku`) -> session provider + the
  resolved tier, or `UNKNOWN_MODEL` + inherit when the provider lists no match.
- `<modelId>` -> session provider + that id.
- `<providerId>/<modelId>` -> that provider + that id, **only if**
  `getApiKey(providerId)` returns a key. No key -> `null` + one `warn` notice
  naming the profile.
- An id the registry has never heard of still **runs** (I-13), the same tolerance
  the lead has for a hand-set `--model`; it does not get costed (below).

**The child `ModelRef`, in full** (P0-3). v1 wrote the construction as
`spec.model ?? {config.provider, config.model}`, which drops the third field the
existing code sets. `subagent.ts:241-245` builds
`{providerId, modelId, ...(config.baseUrl ? {baseUrl} : {})}`, and a `baseUrl` is
meaningful only for the provider it was configured against (I-16). Carried across
a provider switch it points, say, an `anthropic` child at a custom OpenAI-shaped
gateway — five children failing at the transport with nothing connecting the
failure to a one-word line in a markdown file:

```ts
// team/subagent.ts
function resolveChildModel(spec: SubagentSpec, config: CliConfig): ModelRef {
  const providerId = spec.model?.providerId ?? config.provider;
  const modelId = spec.model?.modelId ?? config.model;
  // The session baseUrl belongs to the SESSION provider. Keep it only while the
  // child stays on that provider; a per-child provider switch must reach that
  // provider's own default endpoint.
  const keepBaseUrl = config.baseUrl && providerId === config.provider;
  return { providerId, modelId, ...(keepBaseUrl ? { baseUrl: config.baseUrl } : {}) };
}
```

Note that this keeps the two common cases exactly as they are today: no profile
model at all, and a bare `<modelId>` on the session provider, both retain the
session `baseUrl`. Only the explicit `<providerId>/<modelId>` cross-provider form
drops it, which is the only form for which it was ever wrong.

**Cost.** `TaskToolDeps.modelCost: () => ModelCost | undefined` is replaced by
`getModelCost: (providerId: string, modelId: string) => ModelCost | undefined`.
It resolves through **`ModelRegistry.getModel()` only, never
`getModelInfo()` / `buildRuntimeModel()`** (P1-5). That is the opposite of what
v1 said and the distinction is the whole point: `buildRuntimeModel` returns
`cost: {input: 0, output: 0}` (`model-registry.ts:126`), so routing through it
makes `computeCost` return a confident `$0.00` for a model whose price is simply
unknown — a dispatch that really did spend money rendering as free, which is
R-P5's under-reporting delivered by R-P5's own mitigation. `undefined` is the
honest answer and it is one the report can print.

```ts
// agent/controller.ts
getModelCost(providerId: string, modelId: string): ModelCost | undefined {
  return this.modelRegistry.getModel(providerId, modelId)?.cost;
}
```

`SubagentRun` gains `model?: {providerId, modelId}` and `costUsd?: number`. The
latter is computed once at settle time in `runtime.runOne` via the existing
`computeCost(usage, cost)` (`agent/usage.ts:9`) and is left **`undefined` when
no cost table exists** — `undefined` means "unknown", `0` means "genuinely
free", and the two must not collapse. `DispatchOutcome` gains an **optional**
`usageByModel?: Array<{providerId, modelId, usage, costUsd?}>` (I-20 / P1-3).

**What supplies the header's cost line** (P1-4). `report.ts:119-124` multiplies
`outcome.usage` by one table, which is the arithmetic this section exists to
fix; and `deps.modelCost()`, its current source, is being removed. The header
line is therefore recomputed from the per-child numbers:

- Every child has a `costUsd` -> `Cost: $X` where X is their sum. For a
  single-model dispatch this is arithmetically identical to today's
  `computeCost(total, table)`, so `team-report.test.ts`'s golden output stays
  byte-identical.
- Some child has `costUsd === undefined` -> `Cost: $X (partial; N subagents on
  models with no price table)`. Never a bare number that quietly omits them.
- No child has one -> `Cost: unavailable (no price table for <model>)`, which is
  strictly more informative than today's `$0.00`.

`ReportOptions.cost` stays on the interface for callers that still pass a single
table (it is what makes the single-model path provably unchanged) and is used
only when `usageByModel` is absent.

The per-model breakdown block is appended when `usageByModel.length > 1`; below
that the report is byte-identical to today. The status bar is unchanged: it
already folds `teamUsage` events into the session counter
(`ui/App.tsx:314-322`), and those events carry tokens, not cost.

### 3.7 Untrusted content: what the sanitizer does and does not claim

A profile body is prompt text authored by whoever wrote the repository. It is
**instructions by design** — that is the feature — so the security boundary is
the trust gate (§3.3), not a content filter. What the sanitizer does is narrower
and worth stating precisely so nobody mistakes it for more.

**It is core's `sanitizeForPromptBlock`, not a new function** (P1-6). A skill
body is untrusted prose concatenated into a tagged prompt block; a persona is
untrusted prose concatenated into a tagged prompt block. They are the same
problem, and core already exports the answer (`core/src/index.ts:176`,
`skills/disclosure.ts:8-18,72-90` — I-17). v1 specified a bespoke replacement
that was weaker in two ways that matter:

- It **enumerated six tag names**. The child's system prompt also contains
  `<available_skills>`, `<team_mode>` and whatever core's builder adds next; a
  denylist is stale the first time someone adds a block and nothing fails
  loudly when it is. `sanitizeForPromptBlock` substitutes fullwidth `<` / `>`
  for *every* angle bracket, so there is no list to keep current.
- It did not touch the **zero-width and bidirectional-override class**
  (`disclosure.ts:78-85`) — Trojan Source. That is the one attack whose whole
  point is that a reviewer reading the file in a terminal or on a code-review
  page cannot see it, which makes it precisely the wrong thing to omit from
  content that arrives with a cloned repository and is approved by a human
  reading a one-line prompt.

So `parseAgentProfile` calls, in this order:

1. `truncateBytes(body, TEAM_LIMITS.profileBodyMaxBytes)` — bytes, not
   characters (D-8's rule applies wherever a budget meets CJK); over-budget
   raises `BODY_TRUNCATED`.
2. `sanitizeForPromptBlock(...)` — fullwidth angle-bracket substitution, plus
   the invisible-format and control-character stripping it already performs.

The accepted cost is that a persona legitimately containing `<placeholder>`
renders with fullwidth brackets. Skill bodies have paid that cost since D18 and
nobody has reported it; paying it twice, differently, is worse than paying it
once.

What this does **not** do, stated plainly so nobody treats it as the control: it
does not stop a body from instructing the child to do something. Nothing can —
that is what a persona is. The trust prompt is the question the user is actually
answering, and §3.3 is where the boundary lives.

Names and descriptions get a stricter treatment because they reach the panel and
the tool-facing roster: slugified (names) or control-stripped and length-capped
(descriptions), and rendered through `wrap="truncate"` like every other panel
column.

### 3.8 Live reload, and what it may not touch

`/agents reload` re-scans every root and calls `rebuildSystemPrompt()`. It is
refused mid-dispatch with the same message `/team` uses
(`commands/builtins.ts:135-138`), for the same reason: half a dispatch resolved
against one roster and half against another produces a report nothing can
afterwards explain.

Reload **cannot** register or unregister tools (I-7). It changes three things:
the roster in `<team_mode>`, what `subagent_type` resolves to on the next
dispatch, and what `/agents list` prints. A profile deleted from disk mid-session
disappears from the roster; a dispatch already running with it finishes
untouched, because `SubagentSpec` carries a resolved snapshot rather than a
registry reference (I-10).

### 3.9 Headless

`runHeadless` constructs the registry the same way and gets the same
`<team_mode>` block. The per-child stderr transition lines gain the type in
brackets when one is set (`[reviewer] a1 started`), and the usage fold is
unchanged. `-p --quiet` prints nothing extra. No new flags are consumed in
headless mode beyond the shared `--no-agent-profiles`.

### 3.10 Logging

`attachTeamEvents` already records dispatch start and end at `info` and phase
transitions at `debug` through the redacting sink. Two additions, both at
`info`: the resolved `type` and `model` per child on `dispatch_start`, and one
line per unknown `subagent_type` that was dropped. Profile **bodies** are never
logged at any level — they are user content of unbounded size and the log is not
where they belong; the file path is logged instead.

---

## 4. Interface design

### 4.1 `task` — one new field

Added to each item of the existing `subagents` array (`task-tool.ts:89-112`):

```jsonc
"subagent_type": {
  "type": "string",
  "description": "Optional. Name of a configured agent profile; the available names are listed in the <team_mode> section of your system prompt. Omit it for a general-purpose subagent."
}
```

The parameter is named `subagent_type` rather than `agent_type` or `profile` for
the reason `TASK_DESCRIPTION` already records at `task-tool.ts:59-63`: what a
model already knows about Claude Code's `Task` tool transfers directly, and a
gratuitously different name spends that transfer for nothing.

`TASK_DESCRIPTION` gains two sentences and **no list** (I-7 / D-P1):

> "Some subagent types are configured for this project; they are listed in your
> system prompt under <team_mode>. A type may narrow the tools its subagent gets,
> so keep a typed subagent's brief within what its listed role covers."

The second sentence is the P2-2 fix. Today's description asserts each subagent is
"a fresh agent with the same tools and working directory" (`task-tool.ts:66`),
which stops being true the first time a profile filters — and the lead is the
thing that writes the child's brief, so a stale claim there produces briefs the
child cannot execute ("run the test suite" to a reviewer with no `bash`), one
wasted dispatch at a time. The "same tools" clause in the existing sentence is
narrowed to "the same working directory"; the roster carries the per-type marker
(§4.5) because that is the part that is rebuildable.

**Unknown type behaviour.** Each entry naming an unresolvable type is dropped;
`requested` still counts it, so the report's existing "n of m requested" line
reports the loss. When every entry was dropped the tool returns a **non-error**
`textResult`:

```
No subagents dispatched: unknown subagent_type "securty-auditor".
Available types: reviewer, researcher, test-writer. Omit subagent_type for a
general-purpose subagent.
```

Non-error for D-7's reason (an `errorResult` invites a retry of the whole
fan-out); explicit list because one turn of correction is cheaper than any
number of guesses.

### 4.2 Config keys

Two additions to the `team` section (`config/schema.ts:434-455`), both clamped
in `clampTeamConfig` (`config/schema.ts:494-522`):

| Key | Type | Default | Clamp |
|---|---|---|---|
| `team.profiles` | boolean | `true` | `bool()` |
| `team.profileDirs` | string[] | `['.aragon/agents', '.claude/agents']` | `stringArray()` (`schema.ts:277-281`) |

`profileDirs` is an array inside a persisted section, which `skills.projectDirs`
already establishes as legal (I-4): the one-level spread at `store.ts:127,170`
replaces an array wholesale, which is the correct merge for an array. It is
**not** a nested object, and it must not become one.

The section header at `schema.ts:427-431` currently says the `team` section is
"SCALARS ONLY, exactly one level deep" (P2-3). That is stricter than the merge
requires and stricter than `skills` is; leaving it while adding an array makes
the next reader distrust either the comment or the code. It is amended to the
wording `store.ts:144-148` already uses for `SkillsConfig` — "scalars and string
arrays only; a nested object requires replacing the hand-written merge first" —
and §7.2 lists that edit.

Structural bounds go to `TEAM_LIMITS` (I-5), not here — **seven**, not six
(P1-2: `agentsBlockMaxBytes` was used by §4.5 and AC-P20 but never defined):

```ts
profileNameChars: 32,
profileDescriptionChars: 200,
profileBodyMaxBytes: 8_000,
profilesMax: 50,
profileFileMaxBytes: 65_536,
profileScanMaxFiles: 200,
/**
 * The `<available_agents>` roster block. Paid for on EVERY turn of every
 * team-enabled session with profiles, so it is budgeted like the `<team_mode>`
 * block it nests inside (`prompt.ts:27-30`). 1200 bytes is ~12 entries at the
 * one-line-per-profile shape of 4.5; the entry cap bites first for normal
 * descriptions and this bites first for pathological ones.
 */
agentsBlockMaxBytes: 1_200,
```

### 4.3 CLI and environment

| Surface | Behaviour |
|---|---|
| `--no-agent-profiles` | Session runs with team mode on and the registry empty. Roster block absent; `subagent_type` always unknown. |
| `ARAGON_TEAM_PROFILES=0` | Same, via environment. Same precedence position as `ARAGON_TEAM`. |
| `ARAGON_AGENTS_PATH` | Extra read-only roots, platform delimiter, highest precedence. Mirrors `ARAGON_SKILLS_PATH` (`skills/paths.ts:73`). |
| `aragon agents list` | Table: name, scope, model, tools count, description. |
| `aragon agents show <name>` | Full record including resolved path and body. |
| `aragon agents doctor` | Every issue, grouped by `ProfileIssue.code`: invalid frontmatter, missing description, unrecognized boolean, unknown tool names (naming the dropped ones, with the `Task` case worded separately per §3.2.1), an unresolvable `tools:` list, unknown model, no key for a named provider, shadowed names, untrusted directories, bodies over budget, and the `NO_REPORT_CUE` check below. |

**The `NO_REPORT_CUE` check, defined** (P2-5). v1 asked `doctor` to flag "a body
that never asks for a final report", which is a heuristic with no definition —
and an undefined heuristic in a diagnostic command becomes whatever the first
implementer guesses, then becomes a false-positive users learn to ignore. It is
narrowed to a literal, cheap, explainable test: a **non-empty** persona of more
than 200 characters that contains none of `report`, `summar`, `final`,
`findings` or `conclu` (case-insensitive substring, ASCII only). That is a weak
signal and it is deliberately worded as one:

> `NO_REPORT_CUE  reviewer.md: the persona never mentions reporting. The lead
> only ever sees a subagent's final message (see <subagent_role>), so a persona
> that ends by asking a question produces "[failed: run produced no output]".`

It is a `doctor`-only warning. It never blocks loading, never affects
resolution, and the real defence remains the ordering rule in §4.6 — the
operating rules, final-report clause included, are read **after** the persona.

Registered in `cli.tsx` next to `skills` (`cli.tsx:839`) as
`.command('agents [subcommand] [argument]')`, dispatching to
`runAgentsCommand(...)` in `team/agents-cli.ts` — the same shape as
`runSkillsCommand` (`skills/cli-commands.ts:118`).

### 4.4 Slash command `/agents`

```
/agents             list  (name, scope, model, one-line description)
/agents show <name> full record, body truncated to 40 lines
/agents reload      re-scan + rebuildSystemPrompt; refused mid-dispatch
/agents dirs        every root, existence, trust state
```

Registered in `commands/builtins.ts` alongside `/team`. `/agents` deliberately
has **no** `on|off` verb: the switch is `team.profiles`, changing it needs a
session restart to matter for the tool description, and adding a verb that
silently means "next session" is the P0-2 pattern again.

### 4.5 The `<available_agents>` prompt section

Rendered inside `<team_mode>` by `buildTeamBlock`, and only when the roster is
non-empty (so a user with no profiles gets a byte-identical prompt to today —
the same conditional-splice discipline `prompt.ts:6-11` already records):

```
<available_agents>
Named subagent types you can pass as subagent_type:
- reviewer: Reviews a diff for correctness and convention drift (read-only)
- researcher: Searches the codebase and summarizes findings
- test-writer: Writes vitest cases for a named module (limited tools)
- migrator: Applies a codemod across a package
...and 3 more types exist; the user can list them all with the /agents command.
Pick one when it fits the work. Omit subagent_type for a general-purpose
subagent. Do not invent names.
</available_agents>
```

Two markers per entry, both only when they apply: `(read-only)` as before, and
`(limited tools)` when the profile carries a resolved `toolAllowlist` (P2-2).
The lead writes the child's brief, so the one property of a type that changes
what a brief may ask for has to be visible where the lead is choosing. It is a
marker rather than a tool list because the list is unbounded and this block is
paid for every turn; a lead that needs the detail can be told by the user.

Capped at 12 entries and `agentsBlockMaxBytes` (§4.2), ordered by scope
precedence then name so the block is deterministic across runs. Overflow renders
the line shown above — **not** `(run /agents to list)` (P1-9). That block is the
model's system prompt and `/agents` is a slash command the CLI handles; only the
user can run it. Telling a model to run a command it has no tool for produces a
turn spent trying, which is the same class of mistake as advertising a stale
roster (D-P1) in a cheaper package. The wording names the user as the actor.

The cap exists because this block is paid for on every turn of every
team-enabled session, which is the budget rule the `<team_mode>` block already
states at `prompt.ts:27-30`.

Overflow does **not** restrict resolution: all `profilesMax` profiles stay
selectable by `subagent_type`, because a name the model learned from `/agents
show` output the user pasted is a legitimate name. The roster is what the model
can discover, not what it may use.

`TEAM_BLOCK_VERSION` is bumped to `v2-2026-07` (`limits.ts:104-108`).

### 4.6 The persona in `<subagent_role>`

`buildSubagentBlock` gains an optional `persona` parameter, spliced as its own
section immediately after the role line and **before** the operating rules, so
the rules a persona must not override are read last:

```
<subagent_role>
You are subagent "a1" (type: reviewer) on a team. Your job: audit auth middleware.
Teammates: a2, a3. ...

<persona>
You are a code reviewer. Read before you conclude...
</persona>

Work only on your own task. ...
END WITH YOUR REPORT. Your final message is the only thing your lead sees. ...
</subagent_role>
```

The final-report clause stays last for the reason `prompt.ts:71-80` records: it
is the only enforcement available for `SubagentRun.summary` (I-11), and a persona
that ends with "always ask a clarifying question first" must not be the last
instruction the child reads.

---

## 5. Data model

### 5.1 `team/profile-types.ts` (new)

```ts
export type ProfileScope = 'user' | 'project' | 'env';

export interface ProfileRoot {
  dir: string;
  scope: ProfileScope;
  /** False for `.claude/agents` and every env root. */
  writable: boolean;
  /** Project roots only: inert until `skills.trustedProjectDirs` contains it. */
  trustRequired: boolean;
}

export interface AgentProfile {
  name: string;
  description: string;
  /** Absent = inherit every tool the child would otherwise get. */
  tools?: string[];
  /** Absent = inherit the session model. */
  model?: { providerId: string; modelId: string };
  readOnly: boolean;
  /** Sanitized body (§3.7). May be empty. */
  persona: string;
  scope: ProfileScope;
  path: string;
  /** Same-name records this one shadows, lower precedence first. */
  shadows: string[];
}

export interface ProfileIssue {
  /** A file path, except for `PENDING_TRUST` / `LIMIT_REACHED`, where it is a directory. */
  path: string;
  /** Machine-stable; `aragon agents doctor` groups on it. */
  code:
    | 'NO_FRONTMATTER' | 'NO_DESCRIPTION' | 'BAD_NAME' | 'BODY_TRUNCATED'
    | 'UNKNOWN_TOOLS' | 'UNKNOWN_MODEL' | 'NO_KEY_FOR_PROVIDER'
    | 'SHADOWED' | 'PENDING_TRUST' | 'TOO_LARGE' | 'LIMIT_REACHED'
    // --- added in review ---
    /** A `tools:` list that resolved to zero known names -> `invalid` (P0-2, §3.5). */
    | 'TOOLS_UNRESOLVABLE'
    /** `readOnly:` held a word that is neither true-ish nor false-ish (P1-7, §3.2). */
    | 'BAD_BOOLEAN'
    /** Persona over 200 chars that never mentions reporting (P2-5, §4.3). */
    | 'NO_REPORT_CUE';
  message: string;
}

export interface ProfileRecord {
  profile?: AgentProfile;      // absent when the file failed to parse
  issues: ProfileIssue[];
  /**
   * No `pending-trust` member ON PURPOSE (§3.3): an untrusted root is never
   * scanned, so it produces no record for a state to describe. The pending
   * directories are a separate list, and keeping them out of this union is what
   * makes "a record exists" imply "the user approved reading this file".
   */
  state: 'active' | 'invalid' | 'shadowed';
}
```

### 5.2 Extensions to `team/types.ts`

```ts
export interface SubagentSpec {
  label: string;
  description: string;
  prompt: string;
  readOnly: boolean;
  // --- new, all optional so today's specs stay valid ---
  /** Resolved profile name. Panel column, report column, log field. */
  type?: string;
  /** Resolved override; absent = session model. */
  model?: { providerId: string; modelId: string };
  /** Absent = every tool. Never a union with anything (§3.5). */
  toolAllowlist?: string[];
  /** Sanitized persona body. */
  persona?: string;
}

export interface SubagentRun {
  /* ...existing 14 fields unchanged... */
  type?: string;
  model?: { providerId: string; modelId: string };
  /**
   * Computed once at settle time.
   *
   * `undefined` means "no price table for this model" and `0` means "genuinely
   * free". Collapsing them is P1-5: `buildRuntimeModel` hands out
   * `cost: {input: 0, output: 0}` for any id the registry has never seen, so a
   * number here that came from the fallback would render a real spend as $0.00.
   * `getModelCost` therefore goes through `getModel()` only (3.6).
   */
  costUsd?: number;
}

export interface DispatchOutcome {
  /* ...existing 8 fields unchanged... */
  /**
   * OPTIONAL, and that is load-bearing (P1-3 / I-20). `team-report.test.ts:23`,
   * `team-runtime.test.ts` and `team-session.test.ts` all build this interface
   * from a complete object literal; a required member is a compile break in
   * three suites for a field every one of them would set to the same
   * single-entry array. Absent = "not computed", which is exactly what a
   * pre-change fixture means.
   */
  usageByModel?: Array<{
    providerId: string;
    modelId: string;
    usage: TokenUsage;
    /** Absent = no price table; see `SubagentRun.costUsd`. */
    costUsd?: number;
  }>;
}
```

`TeamEvent` and `TeamSnapshot` are **unchanged in shape**: the new fields ride
inside `SubagentRun`, which both already carry (I-14 / D-P12).

### 5.3 Registry shape

```ts
export class AgentProfileRegistry {
  constructor(deps: {
    getCwd: () => string;
    profileDirs: () => string[];
    isTrusted: (dir: string) => boolean;
    getApiKey: (providerId: string) => string | undefined;
    resolveModel: (providerId: string, modelId: string) => boolean;
    notify?: (level: 'warn' | 'info', text: string) => void;
    host?: ProfileHost;              // test seam: readdir/readFile/stat
  });

  discover(): void;                  // full re-scan; idempotent
  roster(): AgentProfile[];          // active only, precedence applied
  get(name: string): AgentProfile | undefined;
  records(): ProfileRecord[];        // everything scanned, for doctor / show
  issues(): ProfileIssue[];
  /** Project roots skipped for lack of trust; what the trust prompt is raised from. */
  pendingTrust(): string[];
  roots(): Array<ProfileRoot & { exists: boolean; trusted: boolean }>;
}
```

`host` exists for the same reason `SubagentAgentFactory` does
(`subagent.ts:40-56`): the registry's whole surface must be testable without a
real filesystem.

---

## 6. UI design

### 6.1 `TeamPanel`

One column added between label and activity, rendered only when at least one run
in the dispatch has a `type`:

```
  team  3 agents  1m12s                                    mail 2
  a1  reviewer    tool: grep          4 turns   12 calls
  a2  researcher  thinking            2 turns    5 calls
  a3  -           done  6 turns                 [dim]
```

Type is truncated to 10 columns with `wrap="truncate"`, and the whole column is
dropped below 80 columns — the same degradation ladder the panel already applies
(`TeamPanel.tsx` header, `TEAM_LIMITS.panelCollapseRows`). A child with no
profile renders `-` rather than a blank, so the column reads as "none" rather
than "unknown".

**The width has to be threaded in** (P1-8). `TeamPanelProps` carries `rows`,
`reducedMotion`, `theme`, `caps` and an injectable `now` — no width — and
`TermCapabilities` is `{colorLevel, unicode}` (I-18). `App` already holds it as
`cols` (`App.tsx:119`, `useTerminalSize()`) but passes only `rows`
(`App.tsx:1101-1107`). So:

```tsx
// ui/TeamPanel.tsx
export interface TeamPanelProps {
  /* ...unchanged... */
  /** Terminal columns, for the 80-column type-column drop. Defaults to 80. */
  cols?: number;
}

// ui/App.tsx
<TeamPanel snapshot={state.team} rows={rows} cols={cols} ... />
```

`cols` is optional with an 80 default so `team-panel.test.tsx`'s existing cases
keep compiling and keep their current expectations; the two new width cases pass
it explicitly, like `now`. `App.tsx` is a modified file for this and for §3.3
(P0-4), and §7.2 lists it.

### 6.2 `TeamCard` and the report

Per-child header lines gain the type and, when it differs from the session
model, the model:

```
### a1 "audit the auth middleware"  [reviewer]  [ok]  22.1s, 4 turns, 7 tools
### a2 "map the route table"  [researcher · haiku-4-5]  [ok]  31.6s, 6 turns
```

And when more than one model ran:

```
Cost by model: opus-5 4.2k in / 1.1k out $0.09 | haiku-4-5 12.0k in / 3.4k out $0.01
```

A model with no price table renders `n/a`, never `$0.00` (P1-5), and the header
line says so too (§3.6):

```
Tokens: in 16.2k, out 4.5k. Cost: $0.09 (partial; 1 subagent on a model with no price table).
Cost by model: opus-5 4.2k in / 1.1k out $0.09 | my-local-model 12.0k in / 3.4k out n/a
```

Both blocks are appended inside the existing byte budget and after the header
lines that D-8 forbids trimming. The `Cost by model:` line is part of the header
group for trimming purposes for the same reason the failure count is: a report
that drops its own cost breakdown while keeping prose has trimmed the wrong
thing.

### 6.3 Degradation matrix

| Condition | Behaviour |
|---|---|
| No profiles found | Roster block absent, prompt byte-identical to today, panel column absent, `/agents` prints "no agent profiles found" plus the roots it looked in. |
| `team.profiles: false` | Registry never constructed; identical to the row above but `/agents` says why. |
| `--no-team` | Nothing changes; the registry is not constructed because there is no `TeamRuntime` (`controller.ts:185`). |
| Profiles present, none used in a dispatch | Column absent for that dispatch; roster still in the prompt. |
| Terminal < 80 cols | Type column dropped from the panel, retained in the report. |

---

## 7. File / module change plan

### 7.1 New files

| File | Intent |
|---|---|
| `packages/cli/src/team/profile-types.ts` | `AgentProfile`, `ProfileRecord`, `ProfileIssue`, `ProfileRoot`, `ProfileScope`. |
| `packages/cli/src/team/profile-paths.ts` | `resolveProfileRoots` / `resolveEnvAgentDirs` / `getUserAgentsDir`; mirrors `skills/paths.ts`. |
| `packages/cli/src/team/profile-compat.ts` | The two Claude Code mapping tables of §3.2.1 plus `toolList()`. Data only, no I/O, no policy. |
| `packages/cli/src/team/profile-parse.ts` | `parseAgentProfile(text, path, scope)` -> record + issues. Pure; wraps core's `parseFrontmatter` and `sanitizeForPromptBlock`. |
| `packages/cli/src/team/profile-registry.ts` | `AgentProfileRegistry`: scan, precedence, trust gate, reload, `roster()`. |
| `packages/cli/src/team/profile-resolve.ts` | `applyProfile(spec, profile)` and `resolveProfileModel(...)`. Pure, tighten-only. |
| `packages/cli/src/team/profile-cost.ts` | `computeRunCost`, `foldUsageByModel`. Pure. |
| `packages/cli/src/team/agents-cli.ts` | `runAgentsCommand(subcommand, argument, deps)` for `aragon agents`. |
| `packages/cli/src/commands/agents.ts` | The `/agents` slash command definition. |
| `docs/plans/team-agent-profiles/manual-test.md` | Companion manual script (§8.3). |

### 7.2 Modified files

| File | Change |
|---|---|
| `packages/cli/src/team/limits.ts` | **Seven** new bounds (`agentsBlockMaxBytes` included — P1-2); `TEAM_BLOCK_VERSION` -> `v2-2026-07`. |
| `packages/cli/src/team/types.ts` | Four optional fields on `SubagentSpec`, three on `SubagentRun`, **optional** `usageByModel` on `DispatchOutcome` (P1-3). |
| `packages/cli/src/team/normalize.ts` | Accept `subagent_type`; resolve through an injected registry **before** the empty-field drops (P1-1); profile `description` fallback; `slugLabel`+`dedupeLabel` on a name-derived label (P2-1); return `unknownTypes`. |
| `packages/cli/src/team/task-tool.ts` | Schema field; the two roster-free description sentences of §4.1 and the narrowed "same tools" clause (P2-2); unknown-type refusal; registry + `getModelCost` deps. |
| `packages/cli/src/team/subagent.ts` | Tool filter, `resolveChildModel` incl. the `baseUrl` rule (P0-3), persona into `buildSubagentBlock`. |
| `packages/cli/src/team/runtime.ts` | `profileRegistry` + `getModelCost` in `TeamRuntimeDeps`; per-child cost at settle, `undefined` when untabled (P1-5); `usageByModel` in the outcome. |
| `packages/cli/src/team/prompt.ts` | `buildTeamAgentsBlock` incl. the `(limited tools)` marker and the user-addressed overflow line (P1-9 / P2-2); `persona` parameter on `buildSubagentBlock`; type in the role line. |
| `packages/cli/src/team/report.ts` | Type/model in per-child headers; per-model cost block with `n/a`; header cost summed from per-child figures with the partial/unavailable branches (P1-4); unknown-type note. |
| `packages/cli/src/agent/controller.ts` | Construct the registry; pass it to `TeamRuntime` and `createTaskTool`; `getAgentProfiles()` / `reloadAgentProfiles()`; `getModelCost(providerId, modelId)` via `getModel()` only (P1-5); roster into `buildTeamBlock` at line 366. |
| `packages/cli/src/agent/headless.ts` | Type in the stderr transition lines. |
| `packages/cli/src/config/schema.ts` | `TeamConfig.profiles` + `profileDirs`; defaults; clamps; **amend the "SCALARS ONLY" section comment at 427-431** to the `store.ts:144-148` wording (P2-3). |
| `packages/cli/src/commands/builtins.ts` | Register `/agents`; `/team status` mentions the profile count. |
| `packages/cli/src/cli.tsx` | `agents [subcommand] [argument]`; `--no-agent-profiles`. |
| `packages/cli/src/ui/TeamPanel.tsx` | Type column; optional `cols` prop defaulting to 80; the width degradation (P1-8). |
| **`packages/cli/src/ui/App.tsx`** | **Was missing from v1.** Pass `cols` to `TeamPanel` (P1-8); make the trust effect subsystem-agnostic per §3.3 — gate on `skills.enabled \|\| profiles on`, union + `normalizeTrustPath`-dedupe both pending lists, reload both registries on approval, three-way copy (P0-4). |
| `packages/cli/src/ui/overlays/HelpOverlay.tsx` | `/agents` entry. |
| `packages/cli/src/config/store.ts` | Nothing structural — verify the `team` merge still round-trips an array value (I-4). |
| `packages/cli/CHANGELOG.md` | Unreleased entry, including the `.claude/agents` mapping table (a migrating user needs to know `Task` and `WebFetch` are dropped). |
| `packages/cli/src/__tests__/skills-controller.test.ts` | Fixture gains the two new `team` keys (the IF-1 lesson: fixtures predating a config section fail closed). |
| `packages/cli/src/__tests__/team-report.test.ts` | Cost-line branches; `usageByModel` cases; the existing golden output must stay byte-identical (P1-3 / P1-4). |
| `packages/cli/src/__tests__/team-runtime.test.ts` | Per-child model + cost at settle; the outcome fold (P1-3). |
| `packages/cli/src/__tests__/team-session.test.ts` | End-to-end typed dispatch through the real controller wiring (P1-3). |
| `packages/cli/src/__tests__/team-panel.test.tsx` | Type column presence/absence and the 80-column drop (P1-8). |

---

## 8. Testing and acceptance criteria

### 8.1 New test files

| File | Covers |
|---|---|
| `team-profile-parse.test.ts` | Every field rule in §3.2: all three `tools` forms, unknown keys preserved, `null` frontmatter -> `invalid` not throw, body byte cap, the `readOnly` coercion table incl. `BAD_BOOLEAN` (P1-7), and sanitizer cases including a body that tries to close `</subagent_role>` and one carrying a bidi override (P1-6). |
| `team-profile-compat.test.ts` | The §3.2.1 tables exhaustively: every Claude Code tool name maps or is deliberately dropped; a comma-separated `tools:` scalar; case-insensitivity; the three model aliases against a provider with 3, 1 and 0 listed models (P0-1). |
| `team-profile-paths.test.ts` | Root order, `.claude/agents` non-writable, env splitting on both delimiters, Windows case-insensitive trust normalization. |
| `team-profile-registry.test.ts` | Precedence and `shadows`, `profilesMax` / `profileScanMaxFiles` caps, pending-trust exclusion, reload after a file is deleted, a root that does not exist. |
| `team-profile-resolve.test.ts` | The §3.5 table row by row, including the two directions of every tighten-only rule and all three rows of the `toolAllowlist` table (P0-2). |
| `team-profile-cost.test.ts` | Per-child cost; `usageByModel` folding; `undefined` vs `0` (P1-5); the header line's three branches (P1-4); single-model output identical to the pre-change aggregate. |
| `agents-command.test.ts` | `/agents` verbs, the mid-dispatch refusal, `aragon agents doctor` issue codes. |
| `agents-trust.test.tsx` | The §3.3 prompt: fires under `--no-skills` with profiles on, one question for a repo with both roots, approval reloads both registries, the three copy variants (P0-4). |

### 8.2 Acceptance criteria

| ID | Criterion |
|---|---|
| **AC-P1** | A `.aragon/agents/reviewer.md` in a **trusted** cwd appears in `/agents`, in `<team_mode>`, and resolves as `subagent_type: "reviewer"`. |
| **AC-P2** | The same file in an **untrusted** cwd is never opened (assert on the injected `ProfileHost`: zero `readFile` calls for that root), contributes no name to `/agents list` or `<team_mode>`, does not resolve as a `subagent_type`, and its directory is listed by `/agents dirs` as untrusted. |
| **AC-P3** | A **verbatim** Claude Code profile — `tools: Read, Grep, Glob, Bash` as a comma-separated scalar and `model: sonnet` — placed in `.claude/agents/` loads with the same semantics an equivalent `.aragon/agents/` file has, is reported as non-writable, and yields a child whose tools are exactly `read_file, grep, glob, bash` (+ the two comm tools) on the session provider's mid-tier model. The same bytes in `.aragon/agents/` behave identically (P0-1). |
| **AC-P4** | With no profiles anywhere, the system prompt is **byte-identical** to the pre-change build for the same tool array. |
| **AC-P5** | `team.profiles: false` and `--no-agent-profiles` both produce AC-P4's prompt and an empty roster. |
| **AC-P6** | `subagent_type: "typo"` drops that entry only; siblings run; the report says "n of m requested". |
| **AC-P7** | Every entry unknown -> a **non-error** `textResult` listing valid names; no children start. |
| **AC-P8** | `tools: [read_file, grep]` yields a child whose array is exactly those two **plus** `team_send` / `team_wait`, and whose system prompt describes only those. |
| **AC-P9** | `tools:` naming only unresolvable tools makes the profile **`invalid`** with a `TOOLS_UNRESOLVABLE` issue: it is absent from `<available_agents>`, `subagent_type` naming it is refused by the AC-P7 path, and **no child is dispatched with a widened tool set** (P0-2). Asserted in both directions — the roster omits it, and a forced dispatch produces zero children rather than a fully-tooled one. |
| **AC-P9b** | An entry with a **missing inline `description`** but a valid `subagent_type` survives normalization using the profile's description, and appears in the report (P1-1). Asserted against the real `normalizeSubagentSpecs`, not a stub. |
| **AC-P10** | `readOnly: true` in a profile forces the plan gate on in a BUILD session; `readOnly: false` in a profile **cannot** turn it off in a plan session or when the spec set it. |
| **AC-P11** | `model: <id>` produces a child whose `ModelRef` uses it while the lead's stays untouched; `model: prov/id` with no key falls back to inherit plus exactly one warn notice. |
| **AC-P12** | A dispatch with two models yields a `usageByModel` of length 2, a report cost block, and a **header cost equal to the sum of the per-child figures** (P1-4); a dispatch on one model yields the pre-change single line, byte for byte. A child on a model the registry does not list has `costUsd === undefined`, renders `n/a` in the block, and makes the header say `partial` — never `$0.00` (P1-5). |
| **AC-P13** | A persona body appears inside `<subagent_role>` **before** the operating rules, and the final-report clause is still the last line of the block. |
| **AC-P14** | A persona containing `</subagent_role>` cannot close the section (sanitizer test on the rendered prompt, not on the helper). |
| **AC-P15** | `/agents reload` mid-dispatch is refused with the `/team` wording and changes nothing. |
| **AC-P16** | `/agents reload` after adding a file changes `<team_mode>` on the **next** turn without touching the tool array (assert tool-array identity, as AC-11 does for `--no-team`). |
| **AC-P17** | The panel shows the type column only when some run has a type, and drops it below 80 columns — asserted by rendering with an explicit `cols` prop at 79 and 80 (P1-8). Existing `team-panel.test.tsx` cases that omit `cols` still compile and still pass. |
| **AC-P18** | `packages/core/src` has **zero** diff (the AC-12 rule, re-asserted). |
| **AC-P19** | `tools.test.ts::C7`'s `HOST_TOOL_NAMES` assertion is untouched and green: the filter never reaches the lead's array. |
| **AC-P20** | 50 profiles on disk -> `profilesMax` respected, one `LIMIT_REACHED` issue, roster block within `agentsBlockMaxBytes`. |
| **AC-P21** | A directory trusted for skills loads profiles with no second prompt, and the trust dialog copy names both (string assertion). A repo with both `.aragon/skills` and `.aragon/agents` untrusted asks **once**, and `C:\Repo` vs `c:\repo\` do not produce two questions (P0-4). |
| **AC-P22** | `glyphs.test.ts` still passes with the new `src/team/**` files, and fails if one of them gains a non-ASCII literal (non-vacuity check, per the previous round's condition 4). Note the fullwidth characters `sanitizeForPromptBlock` emits are runtime output of a **core** helper, not literals in this tree, so P1-6's fix does not touch this scanner. |
| **AC-P23** | Every entry in both §3.2.1 tables is asserted, in both directions: each supported Claude Code name maps to the stated tool, and each deliberately-dropped name (`Task`, `WebFetch`, ...) produces a `UNKNOWN_TOOLS` issue rather than a silent omission (P0-1). |
| **AC-P24** | `tools:` in all three on-disk forms — inline array, block array, comma-separated scalar — produces the identical `toolAllowlist` (P0-1). |
| **AC-P25** | With a session `baseUrl` set: a child with no profile model, and a child whose profile names a bare `<modelId>`, both keep it; a child whose profile names `<otherProvider>/<modelId>` gets a `ModelRef` with **no** `baseUrl` (P0-3). |
| **AC-P26** | With `--no-skills` and `team.profiles: true`, an untrusted `.aragon/agents` still raises the trust prompt, and approving it loads the profiles in that session (P0-4). This is the case v1 could not satisfy at all. |
| **AC-P27** | `readOnly: false` yields a child that is **not** forced read-only in a BUILD session; `readOnly: maybe` yields a `BAD_BOOLEAN` issue and behaves as absent (P1-7). |

### 8.3 Manual verification

`manual-test.md` covers: authoring a profile in an untrusted repo and answering
the trust prompt; a real three-way dispatch mixing one typed and one untyped
child; a `model:` pointing at a cheap model with the cost block checked against
the provider dashboard; a deliberate `</subagent_role>` injection attempt; a
`cmd.exe` render of the type column at 80 and 120 columns; `/agents reload`
during a dispatch; and `aragon agents doctor` against a directory containing one
valid, one invalid and one shadowed profile.

Three steps added in review, each covering something no unit test can reach:

8. **A real Claude Code profile, unmodified.** Copy an actual
   `.claude/agents/*.md` from a repository that uses Claude Code — not one
   written for this test — and confirm it loads, that `doctor` names exactly the
   tools it dropped, and that a dispatch through it produces a child with the
   expected array (P0-1). A hand-written fixture proves the mapping; only a real
   file proves the mapping is of the right thing.
9. **`--no-skills` with profiles on**, in an untrusted repo: the trust prompt
   must appear, and approving it must load the profiles (P0-4).
10. **A cross-provider `model:` against a session using a custom `baseUrl`**:
    the child must reach the named provider's own endpoint, not the gateway
    (P0-3). This one needs two real endpoints and is the reason it is a manual
    step rather than a unit test.

---

## 9. Risks and mitigations

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| **R-P1** | The roster is put in the tool description "because that is where tool docs go", and `/agents reload` starts advertising stale names (P0-2 again). | **High** | D-P1 and AC-P16; the tool-array identity assertion fails if anyone rebuilds the array instead. |
| **R-P2** | A profile field is made able to *widen* a child (a `tools` union, `readOnly: false` overriding a plan session), turning delegation into a permission bypass. | **High** | §3.5's table is one-directional; AC-P10 asserts both directions; the `toolAllowlist` type is written so a union is a compile error rather than a judgement call. **The review found this risk already realized in v1's own fallback rule** (P0-2): "unrecognized `tools:` -> all tools" is the widening, arriving through the mechanism meant to prevent it. §3.5 rule 3's third row now makes that case `invalid`, and AC-P9 asserts it from both ends. The lesson generalizes: for any future field, name the failure direction explicitly, because "fall back to the permissive default" is the reflex. |
| **R-P2b** | A *reading* gap widens a child: a restriction the author wrote is not understood, so it is not applied. | **High** | Distinct from R-P2 and it is what P0-1 was. Every unparsed field must fail toward restriction (§3.2.1 drops unknown tools and reports them; §3.5 refuses a wholly unresolvable list). A field that cannot be understood is never a field that is not there. |
| **R-P3** | Prompt injection through a repository's `.claude/agents/*.md`. | **High** | Trust gate (§3.3) is the boundary; §3.7 states plainly what the sanitizer does and does not claim, so nobody treats it as the control. The sanitizer itself is core's `sanitizeForPromptBlock` (P1-6), which covers the Trojan-Source class v1's enumerated denylist missed — the class that specifically defeats the human reading the file to decide whether to trust it. |
| **R-P4** | Trusting a directory for *skills* silently also trusts it for *agent profiles*. | Medium | Deliberate (one decision per directory), but the dialog copy must name both — AC-P21 asserts the string, because this is the kind of copy that gets shortened later. |
| **R-P5** | Cost silently under- or over-reports once models differ. | Medium | Per-child cost at settle time; AC-P12 pins the multi-model case, the byte-identical single-model case, **the header total** (P1-4) and **`undefined` vs `0`** (P1-5). The last two were holes in v1's own mitigation: the breakdown was per-model while the headline stayed single-table, and `buildRuntimeModel`'s zero-cost table turned "unknown price" into "free". |
| **R-P5b** | A future contributor routes `getModelCost` through `getModelInfo()` because it is the obvious existing helper, silently restoring the `$0.00` bug. | Medium | The one-line implementation in §3.6 and the comment on `SubagentRun.costUsd` both say why; AC-P12's `n/a` assertion fails if it happens. |
| **R-P6** | The roster block grows with every profile a user adds and is paid for on every turn. | Medium | 12-entry cap + `agentsBlockMaxBytes` (§4.2) + the user-addressed overflow line (§4.5 / P1-9); AC-P20. |
| **R-P7** | A persona ends with "ask a clarifying question" and every child of that type settles as `failed: run produced no output` (I-11). | Medium | Ordering rule in §4.6 (rules last), a `doctor` heuristic, and the failure is already visible per child in the report. |
| **R-P8** | `tools:` filtering removes a comm tool and dead-ends the bus. | Medium | Hard rule 1 in §3.5; AC-P8 asserts the two survive an exclusive allowlist. |
| **R-P9** | A profile names a model whose provider has no key; five children each fail with an auth error. | Medium | Key check at resolution time, fall back to inherit with one notice (D-P8), never five stream failures. |
| **R-P10** | Scanning a huge or hostile directory tree stalls startup. | Medium | Depth 1, `profileScanMaxFiles`, `profileFileMaxBytes`, and every I/O error is an issue rather than a throw. |
| **R-P11** | A future contributor adds `team.profileConfig: { ... }` and breaks the one-level config merge (I-4). | Low | The comment at `schema.ts:427-431` already says it; `team-config.test.ts` gains a round-trip case for the array. |
| **R-P12** | Fixtures that predate the two new `team` keys fail closed and confusingly, exactly as IF-1 described. | Medium | The change plan lists `skills-controller.test.ts` explicitly; `clampTeamConfig` supplies defaults for any partial section. |
| **R-P13** | A non-ASCII profile name reaches the panel and mojibakes a legacy console. | Low | Names are slugified to `[a-z0-9-]`; descriptions are control-stripped and truncated. |
| **R-P14** | Two profiles with the same name in different scopes, and the user cannot tell which one ran. | Low | Precedence is fixed and `shadows` is reported by `doctor`; the report prints the type, and `/agents show` prints the resolved path. |
| **R-P15** | The §3.2.1 alias tables go stale as Claude Code adds or renames tools, and a profile silently loses a restriction it used to carry. | Medium | An unmapped name is dropped **and reported** (`UNKNOWN_TOOLS`), never ignored, and a wholly unmapped list refuses the profile (P0-2) — so staleness degrades toward refusal, which is visible, rather than toward permissiveness, which is not. The tables are data with an exhaustive test (AC-P23), so adding a row is a two-line change. |
| **R-P16** | The trust prompt is later re-narrowed to skills — a copy shortening, a refactor that moves the effect back behind `cfg.skills.enabled` — and project profiles become silently unreachable again. | Medium | AC-P26 asserts the `--no-skills` case specifically, which is the one nobody exercises by hand; AC-P21 asserts the copy. Both live in `agents-trust.test.tsx` rather than being spread across suites, so the property has one home. |
| **R-P17** | The model picks a type from a stale `/agents show` list the user pasted, after that profile was deleted. | Low | Unknown types drop the entry and §4.1 lists the valid names, which is the same one-turn correction as a typo. This is the reason §4.5's overflow rule keeps all profiles resolvable rather than restricting resolution to the advertised 12. |

---

## 10. Decision log

| ID | Decision | Rationale |
|---|---|---|
| **D-P1** | The roster lives in `<team_mode>`, never in the `task` tool description. | The tool array is built once (`controller.ts:231-246`); the system prompt is rebuildable (`controller.ts:366`). Anything else re-creates P0-2. |
| **D-P2** | The parameter is `subagent_type`. | Same argument `TASK_DESCRIPTION` already makes at `task-tool.ts:59-63`: transfer from what the model knows about Claude Code is worth more than a prettier name. |
| **D-P3** | Profiles can only tighten (extends D-13). | A profile arrives with a cloned repo. There must be no field anywhere that gives a child more permission than its session. |
| **D-P4** | An unknown `subagent_type` **drops** that entry rather than downgrading it to a generic child. | A persona is a capability claim. A generic child's summary would be read as the specialist's, and nothing downstream could detect the substitution. "Repair, never reject" (`normalize.ts`) is about *shape*, not about semantics. |
| **D-P5** | Zero survivors returns a non-error `textResult` listing the valid names. | D-7: an `errorResult` invites a retry of the whole fan-out. One turn of correction is the cheapest possible recovery. |
| **D-P6** | Profiles reuse `skills.trustedProjectDirs` instead of a second trust list. | Two prompts for one directory trains "yes" clicking, which `skills/paths.ts:97-103` already identifies as strictly worse than never asking. |
| **D-P7** | Discovery is eager at construction and re-run only by `/agents reload`. | Mirrors `this.skills.discover()` (`controller.ts:175-178`). A per-dispatch re-scan would put filesystem latency inside a tool call and let the roster change between the prompt the model read and the call it made. |
| **D-P8** | An unresolvable **model** falls back to inherit; an unresolvable **type** does not fall back. | A type is a claim the model made and can correct in one turn. A missing key is an environment fact the model cannot fix mid-dispatch, and five auth failures cost more than one run on the wrong model. |
| **D-P9** | `tools:` is a post-construction filter in `buildSubagentTools`, not an option on `createBuiltinTools`. | Keeps `tools.test.ts::C7` and `HOST_TOOL_NAMES` untouched (D-15 lineage) and keeps the wrapper composition order at `tools/index.ts:341-392` unchanged. |
| **D-P10** | Comm tools are never filtered out. | Same reasoning as their policy exemption (`limits.ts:89-102`): a child that cannot receive mail is a worse failure than a child with two extra tools. |
| **D-P11** | Cost moves per-child; `TaskToolDeps.modelCost` becomes `getModelCost(providerId, modelId)`. | With mixed models the single-table multiplication is arithmetically wrong, and R-5 of the previous round makes spend visibility a stated requirement. |
| **D-P12** | No new `TeamEvent` member; new data rides `SubagentRun`. | D-10: the stream stays CLI-local and its shape stays frozen, so `App`, `runHeadless` and `attachTeamEvents` need no new cases. |
| **D-P13** | No bundled profiles ship in the package. | An empty roster is coherent; shipping opinionated personas is a product decision nobody has made, and a bundled scope would need its own update story. |
| **D-P14** | `/agents` has no `on`/`off` verb. | The switch is `team.profiles`, and a verb whose effect is "next session" is the previous round's P0-2 pattern with better manners. |
| **D-P15** | The Claude Code mapping (§3.2.1) applies to **every** scope, not only to `.claude/agents`. | Scope is where a file sits, not what dialect it is written in. A user who copies a working profile into `.aragon/agents` to edit it must not watch it change behaviour on the way; and the alternative — sniffing the dialect per root — is a branch with no observable benefit and two code paths to keep in step. |
| **D-P16** | An unresolvable `tools:` makes the profile `invalid` rather than unrestricted or empty. | The three options are: grant everything (v1 — a silent widening, P0-2), grant nothing (a child that burns a turn discovering it is useless, which is the objection v1 correctly raised), or refuse. Refusing is the only one where nothing is dispatched, nothing is widened, and the user is told which names failed. |
| **D-P17** | Profile models get **less** id tolerance than the lead's `--model` (I-13), while still running unknown ids. | A `--model` typo is typed by a person watching the next response. A profile's model is fired N children deep inside one tool call the lead is blocked in, so an alias that resolves to nothing falls back to inherit with a notice rather than producing N transport failures — the D-P8 argument, applied to the alias case §3.2.1 introduced. |
| **D-P18** | Cost lookups go through `getModel()`, so an unknown model has **no** cost rather than zero cost. | `buildRuntimeModel` returns `cost: {input: 0, output: 0}` (I-13). Reusing it for costing would make "we do not know the price" indistinguishable from "this was free" in the one artifact the user reads to find out what a dispatch cost. |
| **D-P19** | The trust prompt becomes subsystem-agnostic rather than gaining a second prompt for profiles. | Same argument as D-P6 one layer up: the user is deciding about a *directory*. Two prompts for one repository is the "trains them to click yes" failure `skills/paths.ts:97-103` already names, and it would arrive at the exact moment the user is being asked to approve untrusted prose. |

---

## 11. Open questions and bounded follow-ups

1. **`aragon agents init <name>`** — write a commented stub into
   `.aragon/agents/`. Two lines of work; excluded only to keep this round's
   surface to discovery + resolution.
2. **Profile-scoped skills** (`skills: [x, y]` in frontmatter). Blocked on the
   previous round's §11 item 6 (child-local skill frames), unchanged.
3. **Per-profile timeouts and turn caps.** Plausible (`maxTurns:` for a
   research profile), deferred because every one of them is a *widening* knob
   unless it is clamped against the session value, and that argument deserves
   its own pass rather than a default in this table.
4. **A `proactive: true` hint** so the lead delegates to a profile without being
   asked, as Claude Code's descriptions encourage. Needs evidence that it does
   not cause spurious fan-out; the honest experiment is a wording change in
   `<available_agents>` first.
5. **Shadowing UX.** Today `doctor` reports it. Whether a shadowed profile should
   be addressable as `project:reviewer` is an open question with no user demand
   yet.
6. **`aragon agents init <name>` and the `.claude/agents` importer.** Once the
   §3.2.1 mapping exists, `aragon agents import` — read a Claude Code profile,
   write the equivalent `.aragon/agents` file with the dropped tools noted in a
   comment — is a small addition on top of code this round already ships. It is
   the natural home for the migration story the CHANGELOG entry starts.

---

## 12. 评审结论 (Review verdict)

**有条件通过 — approved with conditions.**

The design is sound in its structure and the structure is where designs of this
kind usually fail. Mirroring the skills subsystem rather than inventing a second
discovery model is the right call and pays for itself three times over (trust,
Windows path normalization, precedence). Putting the roster in `<team_mode>`
rather than the tool description is correct and correctly argued from
`controller.ts:231-246`. The tighten-only principle is the right invariant, the
`profile-parse` / `profile-registry` / `profile-resolve` split is the right
seam, and folding the per-child model in with the cost roll-up is right because
`model:` genuinely forces it.

The four P0s share one root cause, and it is worth naming because it is the same
shape as the previous round's: **the design reasoned rigorously about the parts
of the system it had read, and assumed the parts it had not.** v1 opened
`normalize.ts`, `subagent.ts` and `controller.ts` and its claims about them are
accurate to the line. It did not open a real `.claude/agents/*.md` (P0-1), did
not follow `baseUrl` through `subagent.ts:241-245` (P0-3), did not open
`App.tsx` to find where the trust prompt actually lives (P0-4), and reasoned
about the `tools:` fallback from convenience rather than from direction (P0-2).
Every one of those is a boundary between this feature and something adjacent.

All four P0 and all nine P1 concerns are resolved in the body above; the document
is marked **v2**. Approval carries five conditions, all verifiable:

1. **Do not implement §3.2.1 from this document alone.** Open a real
   `.claude/agents/*.md` from a repository that uses Claude Code and reconcile
   the tables against it before writing the map. The tables here were derived
   from the format's published shape; a name that has changed since would
   reintroduce P0-1 in the quietest possible way, and the whole feature is sold
   on that file loading.

2. **The `TOOLS_UNRESOLVABLE` path is not optional and is not a warning.** If
   implementation finds it awkward — and it will, because "fall back to
   everything" is one line and refusal is a state — the correct response is to
   escalate, not to soften it. AC-P9 asserts it from both ends specifically so
   the softening shows up as a red test rather than a review comment on a diff.

3. **`getModelCost` must go through `getModel()`.** `getModelInfo()` is the
   obvious existing helper, it is one character shorter to reach, and it
   silently reintroduces P1-5. The comment on `SubagentRun.costUsd` says why;
   keep it in the code, not only here.

4. **Land the trust-prompt change and the profile registry in the same commit.**
   A registry whose `pendingTrust()` nothing reads is a feature that appears to
   work in every developer's already-trusted cwd and fails for every user on
   first contact with a cloned repository. AC-P26 is the guard; it must be green
   in the commit that introduces project scope, not in a follow-up.

5. **Re-run the non-vacuity check on `glyphs.test.ts`** as the previous round's
   condition 4 required, now that `src/team/**` gains seven more files. A scanner
   that has silently stopped covering the tree it names is worse than no scanner,
   and this is the second round in a row to add files under it.

Two observations that are **not** conditions:

- **Right-sizing (P2-7).** This round is large: 10 new source files, 19 modified,
  9 test files, two command surfaces. It is defensible as one unit because the
  cost work is forced by `model:` and the command surfaces are the only way a
  user learns why a profile did not load. If it needs splitting under schedule
  pressure, the clean seam is **`aragon agents` (the CLI trio) deferred, `/agents`
  kept** — the slash command is what a user reaches for mid-session, and
  `doctor` is the one of the three with real diagnostic value, so `/agents
  doctor` could carry it alone for a release.

- **The `.claude/agents` mapping deserves user-facing documentation**, not only a
  CHANGELOG line. A migrating user's first question is "which of my tools
  survived", and §3.2.1's table answers it. Follow-up 6 is where that goes.

Reviewed against the tree at `7a6bf563`. Only `spec.md` was modified; no source
code was touched and nothing was committed.
