# CLI Integration Surface — design specification

**Feature slug:** `cli-integration-surface`
**Target package:** `@aragon-agent/cli` (0.5.12 → **0.6.0**)
**Status:** **v2** (design, reviewed — see 评审记录 below)
**Scope:** `packages/cli/**`, `README.md`, `packages/cli/README.md`, `packages/cli/CHANGELOG.md`
**Non-scope:** `packages/core/**` (zero changes), the interactive TUI, the published `@aragon-agent/core` API.

---

## 评审记录 (Review Notes)

Reviewed against the tree at `packages/cli/src/**`. Every claim the document makes about existing
code was checked against that code rather than accepted; commander's option-hoisting behaviour was
verified empirically against the installed `commander@12.1.0` rather than argued from memory.

**Severity key.** P0 = the design as written cannot work, or an acceptance criterion contradicts the
design it is meant to test. P1 = it will work but silently do the wrong thing, or a cited precedent
is wrong in a way that misdirects the implementer. P2 = worth fixing, not blocking.

### P0

| # | Concern | Where | Resolution in v2 |
|---|---|---|---|
| **P0-1** | **exec cannot install its own signal listeners.** §3.6 claimed "the existing `setSignalTerminator` machinery in `cli.tsx` is TUI-only" and that exec would `process.on('SIGINT')` itself. `logging/install.ts` registers the `SIGINT` / `SIGTERM` / `SIGHUP` listeners for **every** invocation — its own header says so in those words ("inline mode, `-p`, and every subcommand had no handler at all") — flushes, and calls a *replaceable terminator* whose default is `process.exit(128 + signo)`. A listener exec adds afterwards is later in EventEmitter order and **never runs**: the process is already gone. AC-18 would fail 100% of the time, and it would fail by the process vanishing with no `result` line — precisely the "wrapper has to time out to learn the run ended" failure §3.6 exists to prevent. | §3.6, AC-18, R-10 | §3.6 rewritten: exec owns the signal path through `setSignalTerminator()`, and the terminator contract is extended so returning without exiting is legal. §9 gains R-15. AC-18 gains the mechanism. |
| **P0-2** | **The `plan` baseline contradicts AC-15 and silently changes plan mode.** §4.2 defined `plan` as "the registered set minus `PLAN_MODE_BLOCKED_TOOLS`". `-p --plan` does the opposite: `withPlanModeGate` **registers all five and refuses at call time** with `planRefusal(name)`. So AC-15 ("the same registered tool set … as `-p --plan`") was unsatisfiable against the design's own table, `system/init.tools` would disagree between two spellings of one mode, the model would lose the refusal text that steers it to `submit_plan`, and `I-P6` (floor ∪ blocked = `HOST_TOOL_NAMES`) would stop describing the run. | §4.2, AC-15, D-4 | `plan` now selects `agentMode: () => 'plan'` and contributes **nothing** to the registration filter. D-4 is scoped to `strict` / `--deny-tool`. |

### P1

| # | Concern | Where | Resolution in v2 |
|---|---|---|---|
| **P1-1** | **"Filter applied last, after the plan gate" is unimplementable, and the ordering argument is a category error.** `createBuiltinTools` ends in two returns (`if (!options.agentMode) return tools; return tools.map(withPlanModeGate)`); there is no position "after the plan gate" that is not after both. Worse, ordering is a property of *wrappers* (nesting at call time); a filter removes elements, and because every wrapper preserves `.name` through `{...tool}`, `filter ∘ map === map ∘ filter` here. Citing the file's "the plan gate is applied LAST / OUTERMOST" rule imported an argument that does not apply and pushed the implementer toward restructuring the tail — the exact shape the file records as reintroducing the `--no-skills --plan` bug. | §4.2 inv. 1, R-6 | §4.2 invariant 1 rewritten: the filter is its own `if` **after the last append, before the `toolPolicy` wrapper**, with the commutativity argument stated and both tail returns explicitly untouched. |
| **P1-2** | **`permission` must be a proven no-op when absent, and the document never said so.** Every optional in `BuiltinToolsOptions` follows one house rule with a test behind it — `AC-G17`, "leaves the tool objects UNTOUCHED, proven by identity". Adding `permission?` without restating it invites an unconditional `tools.filter(...)` that changes array identity on every existing path. | §6.2 | Stated in §4.2 and §6.2; new AC-28. |
| **P1-3** | **`EXEC_POLICY_EXEMPT` duplicates a constant that already exists, under a name that already means something else.** `team/comm-tools.ts` exports `TEAM_SUBAGENT_TOOL_NAMES`, passed as `policyExempt` at `subagent.ts:229`. `policyExempt` has a precise documented meaning — "skips the CEILING wrapper only, never the plan gate, never confirmation". A second list of the same two names exempting them from a *third* mechanism is both the two-lists drift this file warns about and a third meaning for one word. | §4.2 inv. 3, §5.3, §6.2 | `EXEC_POLICY_EXEMPT` deleted; `TEAM_SUBAGENT_TOOL_NAMES` reused. |
| **P1-4** | **The lock precedent is wrong on all three specifics.** `update/install-lock.ts` is not `mkdir`-based — it is `openSync(path, 'wx')`; its TTL is `UPDATE_LIMITS.lockTtlMs = 600_000` (10 minutes, not 6 hours); and the two parts that actually carry the design — the **uuid-guarded release** and the `process.kill(pid, 0)` **liveness probe** (`ESRCH` dead, `EPERM` alive) — went unmentioned. Without the probe, a CI job killed mid-run wedges its `--session-id` for the whole TTL and every retry returns `session_busy`: a hang wearing an exit code. | §3.4, R-8 | §3.4 restated against the real mechanism, with the probe and the uuid release made requirements. |
| **P1-5** | **`sessions prune` will delete the user's hand-saved TUI conversations.** The design deliberately shares one directory, and `session/persist.ts::resolveSessionPath` puts every bare-name and default `/save` target in exactly that directory. `aragon sessions prune --older-than 7 --yes` would therefore destroy `/save` files, and `list` would show them with no `meta`. Unrecoverable loss from a maintenance command, and it is the direct cost of the interop §5.2 celebrates. | §4.3, §3.4 | `list` / `prune` are scoped to files carrying `meta.id`; `.last.json` and `*.lock` excluded; `--all` opts in; `show` / `rm` still accept a foreign id explicitly. |
| **P1-6** | **§5.2 requires exec to write `entries`, but nothing in exec can produce them.** `Entry[]` comes from `agent/reducer.ts::reduceEvent` + `viewReducer` driven by `App.tsx`; `AgentController` exposes `getMessages()` and no `getEntries()`, and the team / todo / fast / retry entries arrive through separate dispatch paths in the App. Skipping it is worse than doing it badly: `entries: []` passes `loadSession`'s array check, so the TUI resumes with full model memory and a **blank transcript**, with no error anywhere. | §5.2, §6.1 | Decided rather than left implicit: exec writes `entries: []`, the consequence is documented in §5.2 and the README, and the interop claim is narrowed to what is true. New D-14. |
| **P1-7** | **`inScope()` gains `exec` but not `session`, so half the new code stays unscanned.** The predicate is `/^(agent\|boot\|commands\|config\|fast\|team\|todo\|tools\|update)\//` — `session/` is absent today, and §6.1 adds `session/store.ts` to it. `glyphs.test.ts`'s own doctrine is that a green suite is not evidence for an unscanned tree. | R-3, AC-25, §6.2 | Both trees added; AC-25 asserts both predicates. |
| **P1-8** | **The new commander wiring was placed in `src/commands/`, which is the slash-command tree.** `commands/registry.ts` is "Slash-command registry + dispatcher"; `builtins.ts` is `/help /model /save /resume …`. That directory already owns `/save` and `/resume` — the two names exec's session work sits closest to. The repo's established home for commander-facing runners is `<domain>/cli-commands.ts` (`config/`, `logging/`, `skills/` each have one). | §3.1, §6.1, §6.2 | Moved to `exec/cli-commands.ts` + `session/cli-commands.ts` + `diagnostics/cli-commands.ts`; the departure from "declare in `cli.tsx`, delegate to `run*Command`" is now stated with its reason. |
| **P1-9** | **D-8's justification inverts the rule it cites.** `config/env.ts:348` reads "a container or a wrapper that owns argv can reach **neither** a flag nor a config file" — env exists for the operator *downstream* of a wrapper that owns argv, which is exactly what an embedded `aragon exec` is. D-8 read it as "a caller owning argv does not need env". The conclusion (no new variables) survives; the argument does not. | D-8, §2.2 | Re-argued from the real reason: every existing `ARAGON_*` override already reaches exec through `toFlags(program.opts())` → `loadConfig()`, so a twin would be a duplicate, not a gap. |
| **P1-10** | **Windows is unaddressed, in a package that treats it as first-class.** Node does not deliver `SIGTERM` or `SIGHUP` to listeners on win32; §3.6 and the §8 smoke (`kill -INT`) are POSIX-shaped. `SIGHUP` is in `SIGNAL_NUMBERS` and went unmentioned in either direction. This is the package whose entire glyph tier exists for legacy `cmd.exe` and whose `persist.ts` avoids "punctuation that breaks on Windows". | §3.6, §8 | §3.6 gains a platform matrix covering all three signals and states plainly what a wrapper gets on Windows. |
| **P1-11** | **The exit-code table contradicts the `128 + signo` convention the CLI already implements.** §4.4 said "`130` interrupted (SIGINT / SIGTERM)" and `ExecResultEvent.exitCode` was typed `0 \| 1 \| 2 \| 3 \| 130`. `logging/install.ts` carries `SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }` and exits `128 + signo`, so today SIGTERM yields **143** and SIGHUP **129**. Publishing `exitCode: 130` for a SIGTERM would either be a lie in the JSON or a silent change to an existing convention, and the union type would make the honest value unrepresentable. (The existing README's "`130` interrupted" is a one-signal simplification, fine for prose, not for a wire contract.) | §4.4, §5.1, §3.6 | Both restated as `128 + signo` with the three values named; the union widens to `number` with the enumerated set documented. |

### P2 (recorded; the cheap ones are fixed in v2, none block)

| # | Concern | Disposition |
|---|---|---|
| P2-1 | `--timeout <ms>` lands beside the existing `--tool-timeout` and `--idle-timeout` — three timeouts, the newest with the most generic name. | Renamed **`--max-duration <ms>`** (`--timeout` kept as a hidden alias), and its interaction with the watchdog documented in §3.5. |
| P2-2 | `--allow-tool ask_user` / `submit_plan` validate against `HOST_TOOL_NAMES` but are never registered headlessly (`planTools` is empty), so allowing them is a silent no-op. | §4.2 now says so and emits a stderr warning. |
| P2-3 | `cost.known` had no named source. | Bound to `controller.isPricedModel()` in §5.1. |
| P2-4 | §7 said "500 lines of keybindings"; the CLI README is 1587 lines, keybindings at 156. | Corrected. |
| P2-5 | `aragon exec --print` is accepted and meaningless (the root `-p`). | §4.1 refuses it with exit 2. |
| P2-6 | `saveSession` builds its payload from its `data` parameter, not from the type — the file's own P0-2 comment. §6.2 said "writes it when supplied", which is correct but does not warn. | Precedent cited in §6.2. |
| P2-7 | AC-27 named `npm test` / `npm run typecheck` without noting that `typecheck` covers **two** tsconfigs, and that `typecheck-scope.test.ts` guards new `__tests__` directories. | Named in AC-27. |

### Checked and found correct (recorded so the next reviewer does not re-derive them)

- **Global flags after the subcommand.** §4.1's claim that `aragon exec --model x --output-format json "…"` works was doubted and then **verified empirically** against `commander@12.1.0`: unknown options on a subcommand are hoisted to the parent when the parent declares them, and `program.opts()` sees them. Both orderings work. (`aragon models` re-declares `--provider` for its own reasons, not because hoisting fails.)
- **stdout purity on the exec path.** Every `process.stdout.write` in the package belongs to `config` / `logs` / `history` / `skills` / `models` / `update`, none of which run under `exec`; `boot/guard.ts` and `boot/rollback.ts` write to **stderr**; `runOneShot`'s untrusted-skill notice is already stderr. R-2's mitigation holds.
- **D-7.** `packages/core/src/engine/agent.ts` carries `idleTimeout` and no turn ceiling. Counting `turn_end` CLI-side is the right call.
- **§3.2's delegation.** `runHeadless(controller, prompt, options)` returns `Promise<number>` and takes injectable `stdout` / `stderr`, so `AC-1` is mechanically checkable as claimed.
- **§7's placement.** The root README does have `## CLI` (l.50) immediately before `## Quick start` (l.81), and the CLI README has `## Quick start` at l.50.
- **`SESSION_VERSION` stays 1.** `loadSession` validates only that `messages` and `entries` are arrays; `todos?` set the additive precedent in that file's own comments, exactly as §3.4 says.
- **`session_busy` over blocking.** `skills/lock.ts::acquireRootLock` busy-waits through `Atomics.wait` and throws; `install-lock.ts` already rejected that loop for a background caller. D-11 is consistent with both.

---

## 1. Overview

`@aragon-agent/cli` already installs from npm and already runs from a terminal, so the sentence "it has a CLI" is true. It is nonetheless not *callable* by another program. Everything the package exposes today is shaped for a person: a full-screen Ink TUI, and a `-p` print mode whose stdout is prose, whose stderr interleaves tool traces, todo lines, retry notices and a usage footer, and whose only structured output is the process exit code. A build script, a CI job, a web backend or a second agent that wants to use aragon as a component has to spawn it, capture free text, and guess. There is no way to read the answer without also reading the narration, no way to carry a conversation across two invocations, no way to say "you may read but not write" when there is no human to answer `--confirm`, and no way to bound what a run may spend. The engine underneath is fully dependency-injected and holds no state — the limitation is entirely in the command surface.

This specification adds a second, machine-facing face to the same binary: **`aragon exec`**. It is modelled on the two CLIs the requirement names — `codex exec` and `claude -p --output-format stream-json` — and it reuses every part of the existing stack unchanged: the same `AgentController`, the same builtin tools, the same config resolution, the same skills, teams, todo and fast-tier subsystems. What it adds is a **contract**: a versioned JSON event schema on stdout, a session identifier the caller may mint itself so a conversation survives across process boundaries, a tool-permission policy enforced at the tool boundary rather than promised in a prompt, caller-set budgets (`--max-turns`, `--timeout`) with their own exit code, and a discovery command (`aragon info --json`) so a wrapper can find out what the installed version supports before it depends on it. Three supporting commands round it out: `aragon sessions` to manage the store the new continuity creates, and `aragon doctor` to answer "is this machine configured to run me?" in one exit code.

The human CLI does not change. `aragon`, `aragon -p`, every existing flag, every slash command and every byte of their output stay exactly as they are; this is stated here as a design constraint and discharged in §9 by an equality test (`AC-1`) rather than left as an aspiration. The relationship between the two faces is deliberate and one-directional: `aragon -p` remains the *ergonomic* headless mode for a person at a keyboard, and `aragon exec` is the *contractual* one for a program. `aragon exec --output-format text` is specified to produce the identical stdout and stderr stream that `aragon -p` produces for the same prompt, which is what makes the pair honest rather than two divergent implementations of the same idea.

---

## 2. Goals, non-goals, and the reasons for the non-goals

### 2.1 Goals

| # | Goal | Why it is load-bearing for integration |
|---|---|---|
| G1 | A dedicated `aragon exec` entry point | The root command owns a positional `[prompt]` and 60 human-facing flags. Growing 14 machine-only flags onto it makes `aragon --help` unreadable for the audience it exists for, and creates real ambiguity (`aragon --resume` vs `/resume`). Codex made the same split for the same reason. |
| G2 | `--output-format text\|json\|stream-json`, versioned | Without it a caller cannot separate the answer from the narration, cannot see tool calls, and cannot tell "the model said nothing" from "the process died". |
| G3 | Session continuity across invocations (`--session-id`, `--resume`, `--continue`) | A wrapper that must respawn per turn (CI step, HTTP handler, queue worker) has no other way to hold a conversation. |
| G4 | Non-interactive permission policy | `--confirm` needs a human. Today the only postures available headlessly are "everything" and "plan mode". A program embedding an agent needs "read but do not write", and it needs it enforced by the wiring. |
| G5 | Caller-set budgets with a distinguishable outcome | An unbounded agent in a CI job is an unbounded bill. `--max-turns` / `--max-duration` must be distinguishable from success *and* from failure. |
| G6 | Capability discovery (`aragon info --json`) | "Install and call" across versions is only robust if the caller can ask what it just installed. |
| G7 | README documentation of all of the above | Named explicitly in the requirement. |

### 2.2 Non-goals, and why

- **No filesystem sandbox, and therefore no `--add-dir`.** `tools/fs-tools.ts::resolvePath` returns `p` unchanged when `isAbsolute(p)`; nothing in the CLI confines tool I/O to the session cwd. A `--add-dir` flag would therefore be a directory *allowlist* over a boundary that does not exist — a promise the wiring does not keep, which is worse than no flag. The tool-level policy of §5 is the boundary that is real, and §11 says so in the README's own words.
- **No `--system-prompt` (full replacement).** `--append-system-prompt` is offered; replacing the base prompt is not. The builtin prompt is what carries tool discipline, the todo-planning rules, the skills catalog and the plan-mode block; replacing it silently disables half the product and the symptom is "the model got worse", which is the least diagnosable failure mode available.
- **No MCP, no tool plug-ins.** Out of scope for this iteration; nothing here forecloses it.
- **No programmatic Node API (`import { exec } from '@aragon-agent/cli'`).** The CLI's module graph reaches Ink and React from `cli.tsx`; a subpath export that provably does not is a separate refactor. A subprocess contract is what an SDK would wrap anyway (this is precisely how `@anthropic-ai/claude-agent-sdk` relates to the `claude` binary), so the spawn recipe is documented in **§7** instead. This is the one deferral most likely to be revisited; **§6.1's rule that `exec/index.ts` is wiring only** keeps `runExec()` free of process-global state specifically so that it can be. (v1 pointed at §11 and §5.6; the first is the decision record and the second does not exist.)
- **No new `ARAGON_*` environment variables**, because every existing one already reaches exec. `toFlags(program.opts())` → `loadConfig()` → `readEnvOverrides()` is the same chain `-p` uses, so `ARAGON_MODEL`, `ARAGON_PROVIDER`, `ARAGON_HOME`, `ARAGON_LOG_*` and the rest work under `aragon exec` today; a new twin would be a duplicate channel, not a missing one.

  **This is not the reason v1 gave, and the difference matters (P1-9).** v1 argued that env exists for callers who cannot reach argv, and that an exec caller always owns argv. `config/env.ts:348` says something close to the opposite: "a container or a wrapper that owns argv can reach neither a flag nor a config file" — the party env serves is the operator *downstream* of a wrapper that owns argv, and an `aragon exec` embedded in someone else's build script is exactly that. Kept as written, that argument would have justified declining a future env request that the repo's own rule supports.
- **No change to `-p`.** See `AC-1`.

---

## 3. Technical design

### 3.1 Where the new code sits

```
packages/cli/src/
  exec/
    events.ts        # THE CONTRACT: event types + EXEC_SCHEMA_VERSION. Pure types + builders.
    options.ts       # ExecOptions + resolveExecOptions(raw) -> Ok | UsageError. Pure.
    permission.ts    # ToolPermission + resolveToolAllowList(). Pure.
    emitter.ts       # ExecEmitter interface; TextEmitter / JsonEmitter / StreamJsonEmitter.
    runner.ts        # Subscribes to the controller streams; owns budgets and signals.
    stdin-stream.ts  # NDJSON reader for --input-format stream-json.
    index.ts         # runExec(): wiring only.
    cli-commands.ts  # registerExecCommand(program, toFlags)
  session/
    store.ts         # id-keyed session store + lock + prune. (persist.ts keeps the file format.)
    cli-commands.ts  # registerSessionsCommand(program, toFlags)
  diagnostics/
    info.ts          # the `aragon info` payload builder. Pure apart from version/env reads.
    doctor.ts        # the check list + verdicts.
    cli-commands.ts  # registerInfoCommand / registerDoctorCommand
```

**Not `src/commands/` (P1-8).** That directory is the **slash-command** tree: `commands/registry.ts`
is "Slash-command registry + dispatcher", `commands/builtins.ts` is `/help /model /settings /save
/resume …`. Putting commander wiring there would put two unrelated meanings of "command" in one
directory, and that directory already owns `/save` and `/resume` — the two names exec's session work
sits closest to. The repo's established home for commander-facing code is `<domain>/cli-commands.ts`;
`config/`, `logging/` and `skills/` each already have one, and `config/history-commands.ts` is the
same idea. The new modules follow that convention.

`cli.tsx` is **1603 lines** against the repository's 1000-line guideline, so the new modules also own
their `.command()` / `.option()` declarations rather than declaring them in `cli.tsx` and delegating
to a `run*Command(...)` as `logs` / `history` / `skills` / `update` do. **That is a deliberate
departure from the existing convention and this is the reason:** four new subcommands carrying ~20
declarations between them is ~120 lines, and the file is already 60% over budget. `cli.tsx` gains
four imports and four `register*Command(program, toFlags)` call sites — roughly ten lines. This is
not a refactor of the existing file (out of scope); it is a rule for the new code so the overage does
not grow.

### 3.2 The one-way relationship with `runHeadless`

`agent/headless.ts` is not deleted, not rewritten, and not wrapped. `runExec` with `outputFormat: 'text'` **delegates to `runHeadless` verbatim**, passing the same `HeadlessController`, the same `quiet`, the same `followThrough`. That is the entire text path.

This is the single most important structural decision in the document (**D-1**). The alternative — reimplementing text rendering inside the emitter — would make "the human CLI is unchanged" an argument someone has to trust instead of a fact anyone can check, and the two implementations would drift the first time a retry line changed. Delegation makes `AC-1` provable by construction and reduces the text emitter to zero code.

The consequence to accept: any flag that would need to observe or interrupt the stream `runHeadless` owns is **refused with exit 2 under `--output-format text`**. Precisely: `text` mode supports `--permission-mode` / `--allow-tool` / `--deny-tool` (they act below `runHeadless`, inside tool construction) and `--append-system-prompt`; it refuses `--max-turns`, `--max-duration`, `--input-format stream-json`, `--partial-messages` and `--include-thinking`. Session flags are supported in text mode (see §3.4 — save/resume happen outside the run), so `aragon exec --session-id ci-42 "next step"` works in every format. The refusals are explicit usage errors naming the flag and the format, never silent no-ops.

One thing text mode does still do: it attaches its own **silent** `controller.subscribe(...)` listener to count `turn_end` and accumulate usage for `SessionMeta`. That listener writes nothing to either stream, which is what keeps `AC-1` true — `runHeadless` already tolerates multiple subscribers, and byte-equality is a property of what is *written*, not of how many listeners exist.

### 3.3 Run sequence (`--output-format stream-json`, single turn)

```
1.  main() -> commander -> registerExecCommand action
2.  resolveExecOptions(raw)                       # pure; on error: stderr + exit 2, nothing on stdout
3.  resolvePermission(options)                    # pure; baseline + allow - deny
4.  session: acquire lock (if --session-id/--resume/--continue and saving enabled)
5.  makeController(flags, { interactive: false, permission })
6.  if resuming: controller.replaceMessages(saved.messages); controller.restoreTodos(saved.todos)
7.  emitter = new StreamJsonEmitter(stdout)
8.  emitter.init({ sessionId, model, tools, permissionMode, cwd, cli, schemaVersion })
9.  runner.attach(controller)                     # subscribe / subscribeTeam / subscribeTodos / subscribeFast
9b. prevTerminator = setSignalTerminator(execTerminator)   # NOT process.on(...) -- see 3.6 / P0-1
10. preflight(); on failure -> emitter.result({ isError, stopReason:'error', exitCode:2 }); exit 2
11. loop:  emitter.user(text); await controller.prompt(text)
           (todo follow-through continuation loop, identical policy to runHeadless)
12. budgets: turn counter and wall-clock timer may call controller.abort() -> stopReason
13. finally: detach(); restore terminator; controller.dispose();
             persist session (unless --no-save-session); release lock (uuid-guarded)
14. emitter.result({...})                         # EXACTLY ONE, ALWAYS LAST
15. getLogger().flushSync(); process.exitCode = code
```

Steps 13 and 14 are in that order deliberately (**D-2**): a caller that reads the `result` line and immediately respawns with the same `--session-id` must not race the writer of the file it is about to read. Persist first, announce second.

### 3.4 Session continuity

**Storage.** `~/.aragon-agent/sessions/<id>.json` (`getSessionsDir()`), reusing the existing `SavedSession` shape from `session/persist.ts` with one additive optional field, `meta` (§6.2). `SESSION_VERSION` **stays 1**: the field is optional and `loadSession` validates only that `messages` and `entries` are arrays, which is the precedent `todos` already set in that file's own comments. A session written by `/save` in the TUI is therefore resumable by `aragon exec --resume <path>`, and vice versa — that interoperability is free and worth keeping.

**Identity.** `--session-id <id>` is validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. The rejection of `/`, `\`, `..` and a leading dot is a **security requirement, not tidiness**: the id becomes a filename under the user's home directory, and the caller supplying it is frequently the least trusted input in the pipeline. When no id is given, one is minted with `node:crypto.randomUUID()` and reported in `system.init` and in `result.sessionId`.

**The three resume forms, and how they differ.**

| Form | If the session exists | If it does not |
|---|---|---|
| `--session-id <id>` | resume it | create it (this is the wrapper-friendly upsert) |
| `--resume <id\|path>` | resume it | **exit 2** `session_not_found` |
| `--continue` / `-c` | resume the newest session whose `meta.cwd` equals the current cwd | **exit 2** `no_session_for_cwd` |

`--continue` reads a pointer file `sessions/.last.json` (`{ "<sha256(cwd)[0:16]>": { "id": "...", "updatedAt": 0 } }`) written after every exec save. **The pointer is a cache and is documented as one**: if it is missing, unparseable, or names a file that is gone, `--continue` falls back to reading `sessions/*.json` and choosing the newest whose `meta.cwd` matches. A desync therefore self-heals instead of stranding the user, which is the property that makes it safe to keep a denormalised index at all.

**Concurrency.** Two `aragon exec --session-id x` processes would interleave writes and silently lose a turn. An exclusive lock `sessions/<id>.lock` is acquired for the run by **reusing `update/install-lock.ts`'s pattern, correctly described (P1-4)**: it is not `mkdir`-based — it is a single non-blocking `openSync(path, 'wx')` — and its three load-bearing parts are

1. a payload of `{ pid, host, startedAt, uuid }`;
2. a **uuid-guarded release**, so a process that lost its lock to a staleness sweep cannot delete the successor's;
3. a **liveness probe** on the recorded pid — `process.kill(pid, 0)`, with `ESRCH` read as dead and `EPERM` read as *alive* (an `EPERM` pid belongs to another user, and treating it as dead lets one user steal another's lock).

The probe is not optional polish. Without it, a CI job killed mid-run wedges its `--session-id` until the TTL expires and every retry returns `session_busy` — a hang wearing an exit code, in the one environment this feature exists for. TTL is **10 minutes** (`SESSION_LOCK_TTL_MS = 600_000`, matching `UPDATE_LIMITS.lockTtlMs`; the earlier "6 hours" was wrong in a direction that maximises the wedge). Acquisition is one attempt, no sleep, no retry: a second process **exits 2 with `session_busy`** rather than waiting, because a wrapper that wants a queue can build one, and a CLI that blocks for an unbounded time on a lock it cannot show the user is a hang (D-11).

**Retention, and whose files these are (P1-5).** The sessions directory is **shared with the TUI**: `session/persist.ts::resolveSessionPath` puts every `/save <name>` and every default `/save` into `getSessionsDir()`. That sharing is the point (§5.2), but it means a naive `prune` would delete conversations a human saved by hand — unrecoverable loss from a maintenance command. So:

- `sessions list` and `sessions prune` **operate only on files that carry `meta.id`**, i.e. sessions exec created. `.last.json` and `*.lock` are excluded by name as well.
- `sessions rm <id>` and `sessions show <id>` accept any file in the directory, because the user named it explicitly.
- `sessions prune --all` opts in to foreign files and says how many it will touch; `--dry-run` prints the list and deletes nothing.
- Nothing is ever deleted automatically. `aragon sessions list --json` makes the growth visible; automatic deletion of the user's conversations is not a decision this CLI should make on its own.

### 3.5 Budgets

- `--max-turns <n>` (`n >= 1`): the runner counts `turn_end` events. On reaching `n` it calls `controller.abort()` and sets `stopReason = 'max_turns'`.
- `--max-duration <ms>` (`>= 1000`): a wall-clock `setTimeout` from the first `prompt()` call. On fire it calls `controller.abort()` and sets `stopReason = 'timeout'`. The timer is `unref()`d so it can never hold the event loop open, and it is cleared in the runner's `finally`.

**The flag is `--max-duration`, not `--timeout` (P2-1).** The root command already carries `--tool-timeout <ms>` (the per-tool executor ceiling) and `--idle-timeout <ms>` (the engine watchdog). A third option called simply `--timeout` would be the most generic name attached to the newest and least familiar of the three. `--timeout` is kept as a hidden alias so a caller who guesses it is not punished, and `aragon exec --help` documents the relationship in one line:

> `--max-duration` bounds the **whole run**. `--idle-timeout` bounds a **silent stretch** inside it and still applies — a `--max-duration` longer than the idle watchdog will usually be pre-empted by the watchdog, which surfaces as `stopReason: "error"`, not `"timeout"`. `--tool-timeout` bounds a **single tool call**.

Both budgets abort through the **existing** `controller.abort()` path — the same one `Esc` uses — so subagents are torn down and the engine settles normally. Neither is an error: `result.isError` is `false`, and the exit code is **3** (§4.4). A budget the caller set firing is not a malfunction, but it is also not a complete answer, and a shell script must be able to tell without parsing JSON.

`--max-turns` is enforced CLI-side because the core engine has no turn ceiling (`engine/agent.ts` carries only `idleTimeout`). Pushing one into core would be an API change to a separately published package for a CLI-shaped need; counting `turn_end` is exact and costs one integer.

### 3.6 Interrupts

**Exec must not add a `process.on('SIGINT')` listener. It must replace the terminator (P0-1).**

The v1 text claimed `setSignalTerminator` was TUI-only. It is not. `logging/install.ts` registers the `SIGINT` / `SIGTERM` / `SIGHUP` listeners **once, for every invocation**, and its header says why in those words: "the handlers in `runInteractive()` exist ONLY in its full-screen branch, so inline mode, `-p`, and every subcommand had no handler at all and took Node's default termination". That listener flushes the logger and then calls a *replaceable* terminator whose default is `process.exit(128 + signo)`. A listener exec registered afterwards would be later in EventEmitter order and would **never run** — the process is already gone. AC-18 would fail every time, and it would fail by the process vanishing with no `result` line: exactly the "the wrapper has to time out to learn the run ended" outcome this section exists to prevent.

So exec calls `setSignalTerminator(fn)` in its setup and restores the previous terminator in `finally` (`resetProcessHooksForTest()` is the existing test-side undo). The terminator does:

- **First signal** — `controller.abort()`, `stopReason = 'interrupted'`, record the wall-clock instant, and **return without exiting**. The run settles through the normal path: session persisted, `result` emitted, `process.exitCode = 130`.
- **Second signal within 2 s** — `process.exit(130)` immediately.

**This extends the terminator's contract, and the extension has to be written down.** `install.ts` says of the current default "it must exit itself" — true of that default, and true because nothing before now had anything to settle. Returning is now legal for a terminator that owns an in-flight run. What makes it safe is that the logger has already flushed by the time the terminator is called, so a terminator that returns cannot lose log records; and the second-signal escape means a wedged settle is always one more Ctrl-C away from ending. Any future terminator that returns must own an exit path of its own.

**Platform matrix (P1-10).** This package treats Windows as first-class — the whole glyph tier exists for legacy `cmd.exe` — and signals do not behave the same there.

| Signal | Exit code | POSIX | Windows |
|---|---|---|---|
| `SIGINT` | `130` | Ctrl-C and `kill -INT`; handled as above | Ctrl-C is emulated by Node and **is** delivered; handled as above |
| `SIGTERM` | `143` | `kill`; handled as above | **Not delivered to listeners.** `taskkill` / `process.kill(pid,'SIGTERM')` terminate the process outright |
| `SIGHUP` | `129` | Terminal closed or parent died; handled as above | Not meaningful |

All three take the same path and report `stopReason: 'interrupted'`; only the exit code differs, following the CLI's existing `128 + signo` convention (§4.4 / P1-11).

The honest consequence, and the README says it in these words: **on Windows, only Ctrl-C produces a `result`.** A wrapper that kills the process by any other means gets no final event, so *process exit must always be treated as terminal* regardless of whether a `result` arrived. That is a rule every well-behaved NDJSON consumer needs anyway; stating it removes the temptation to build one that waits forever.

The guarantee this buys, within that matrix, is the one wrappers care about most: **`result` is emitted on Ctrl-C**, so a parent reading NDJSON does not have to time out to learn the run ended.

---

## 4. Interface design

### 4.1 `aragon exec [prompt]`

Prompt resolution order, first match wins: positional argument → `--prompt-file <path>` → stdin when `--input-format text` and stdin is not a TTY. If none resolves and stdin is a TTY, exit 2 with `no_prompt`.

`aragon exec --print` (the root's `-p`) is **refused with exit 2** (P2-5): `exec` is already the headless face, and silently accepting a flag that means "be headless" from a caller who thinks it does something would be the wrong kind of tolerant.

| Flag | Default | Meaning |
|---|---|---|
| `--output-format <fmt>` | `text` | `text` \| `json` \| `stream-json` |
| `--input-format <fmt>` | `text` | `text` \| `stream-json` (requires `--output-format stream-json`) |
| `--partial-messages` | off | emit `text_delta` events (stream-json only) |
| `--include-thinking` | off | emit `thinking` events (stream-json only) |
| `--prompt-file <path>` | — | read the prompt from a file |
| `--session-id <id>` | minted | create-or-resume by id |
| `--resume <id\|path>` | — | resume; fail if absent |
| `-c, --continue` | — | resume the newest session for this cwd |
| `--no-save-session` | off | run statelessly; write nothing to `sessions/` |
| `--max-turns <n>` | unlimited | assistant-turn ceiling (`>= 1`) |
| `--max-duration <ms>` | unlimited | wall-clock ceiling for the whole run (`>= 1000`). Hidden alias: `--timeout` |
| `--permission-mode <m>` | `auto` | `auto` \| `plan` \| `strict` |
| `--allow-tool <names>` | — | repeatable; comma-separated accepted; **adds** to the baseline |
| `--deny-tool <names>` | — | repeatable; comma-separated accepted; **removes**; wins over allow |
| `--append-system-prompt <text>` | — | appended to the builtin prompt |
| `--append-system-prompt-file <path>` | — | same, from a file |

Every existing global flag (`--model`, `--provider`, `--base-url`, `--api-key`, `--cwd`, `--thinking`, `--max-tokens`, `--no-team`, `--no-todo`, `--no-skills`, `--retry-max`, `--fast*`, `--log-*`, `--quiet`, …) is accepted unchanged, because `exec` is registered on the same `program` and reads `toFlags(program.opts())` exactly as `-p` does.

**Position does not matter, and this was verified rather than assumed.** `commander@12.1.0` hoists an option it does not recognise on a subcommand up to the parent that declares it, so both `aragon --model m exec "…"` and `aragon exec --model m --output-format json "…"` parse, and `program.opts()` sees `--model` either way. (`aragon models` re-declares `--provider` for its own reasons — it takes a positional-free provider argument — not because hoisting fails.) This matters more than it looks: the README's spawn recipe hands the caller **one flat argv array**, and a rule like "globals before the subcommand, exec flags after" would be a footgun on the most common invocation there is.

### 4.2 Permission model

Two orthogonal controls, each with exactly one meaning.

**`--permission-mode` selects the baseline set:**

| Mode | Baseline | How it is enforced |
|---|---|---|
| `auto` (default) | every tool the session would register — today's headless behaviour | no filter |
| `plan` | **every tool, same as `auto`** — the five in `PLAN_MODE_BLOCKED_TOOLS` stay *registered* and refuse at call time | `agentMode: () => 'plan'`, i.e. literally what `--plan` does |
| `strict` | the empty set | filter |

**`plan` does not unregister anything, and getting this wrong was P0-2.** The v1 table defined the `plan` baseline as "the registered set minus `PLAN_MODE_BLOCKED_TOOLS`". That is not what `--plan` does: `tools/index.ts::withPlanModeGate` wraps **all** tools and returns `planRefusal(name)` for the blocked five at call time, so they remain in `listTools()`. Three things break if exec unregisters them instead:

1. **AC-15 becomes unsatisfiable against this document's own table** — it asserts the same registered set as `-p --plan`, and the two sets would differ by five names.
2. `system/init.tools` would report a different tool list for two spellings of one mode, so a wrapper reading it could not tell which it got.
3. The model loses the refusal text. `planRefusal()` is the steer that sends it to `submit_plan`; a tool that is simply absent gets planned around silently, which is the outcome D-4 prefers *for a deny list* and the wrong one for plan mode, where the point is that the model knows the write exists and is being deferred.

So `--permission-mode plan` sets `agentMode` and contributes **nothing** to the filter, and D-4 governs `strict` / `--deny-tool` only. `I-P6` (`SKILL_TOOL_FLOOR` ∪ `PLAN_MODE_BLOCKED_TOOLS` = `HOST_TOOL_NAMES`) keeps describing the run.

**`--allow-tool` adds; `--deny-tool` removes; deny wins.** Resolution is a pure function:

```ts
resolveToolAllowList(registered: string[], mode, allow: string[], deny: string[]): ReadonlySet<string>
```

Examples that must each read as one sentence:
- `--permission-mode strict --allow-tool read_file,grep,glob,list_dir` — a research agent that cannot touch anything.
- `--deny-tool bash` — do anything except shell out.
- `--permission-mode plan` — exactly `aragon -p --plan` (documented alias).

**Enforcement (four invariants, each of which fails silently if dropped):**

1. **Filter at construction, in `createBuiltinTools`, in its own `if` — placed after the last append and before the `toolPolicy` wrapper.** A denied tool is not registered at all, so the model never sees it and never plans around it.

   **The v1 instruction "applied last, after the plan gate" was unimplementable and rested on a category error (P1-1).** `createBuiltinTools` ends in *two* returns — `if (!options.agentMode) return tools;` then `return tools.map(withPlanModeGate)` — so there is no position "after the plan gate" that is not after both, and reaching for one pushes the implementer into restructuring exactly the tail whose comment records the `--no-skills --plan` bug ("If you ever collapse these two guards back into one, that is the bug you are reintroducing, and nothing reports it").

   More fundamentally, **ordering is a property of wrappers, not of filters**. The file's ordering rule is about nesting at *call time* — which gate runs before which, and therefore who pays for a human wait. A filter removes array elements and has no call-time position at all; because every wrapper preserves `.name` through `{...tool}`, `filter ∘ map === map ∘ filter` here. The placement below is chosen for a different reason: after the appends means `skillTools` / `planTools` / `todoTools` / `teamTools` are all subject to it, and before the wrappers means neither tail return is touched.

   ```ts
   // ... after the teamTools append, before `if (options.toolPolicy)`:
   if (options.permission) {
     const permission = options.permission;
     tools = tools.filter((t) => permission.isAllowed(t.name));
   }
   ```

2. **Omitting `permission` must leave the array untouched, proven by identity (P1-2).** Every optional in `BuiltinToolsOptions` follows this house rule and `AC-G17` already enforces it for `--no-skills` ("leaves the tool objects UNTOUCHED, proven by identity"). An unconditional `tools.filter(...)` would type-check, behave identically, and quietly allocate a new array on every existing path — forfeiting the ability to *prove* that `-p`, the TUI and every subagent are unchanged. The `if` above is what makes AC-28 checkable.

3. **Children inherit.** `permission` is threaded to `team/subagent.ts::buildSubagentTools`'s `createBuiltinTools` call through `SubagentDeps` in the same two places `toolPolicy` and `agentMode` already occupy (`team/runtime.ts:53,202`, `team/subagent.ts:80,152,213`). Without this, `--deny-tool bash` is bypassed by one `task` call, and nothing anywhere reports it. Plan mode's "reaches one level down" guarantee is the precedent.

4. **`team_send` / `team_wait` are exempt — via the constant that already exists (P1-3).** They are registered only on children and are the mechanism children use to coordinate; filtering them out of a `strict` run would break subagent messaging in a way that reads as a hang. The exemption reuses **`TEAM_SUBAGENT_TOOL_NAMES`** from `team/comm-tools.ts`, which `subagent.ts:229` already passes as `policyExempt`.

   v1 proposed a new `EXEC_POLICY_EXEMPT` beside `SKILL_TOOL_FLOOR`. Two objections, either sufficient: it would be a second list of the same two names, which is the drift `tools/index.ts` keeps `SKILL_TOOL_FLOOR` and `PLAN_MODE_BLOCKED_TOOLS` adjacent to avoid; and `policyExempt` already has a precisely documented meaning — "skips the CEILING wrapper only, never the plan gate, never confirmation" — so a similarly-named constant exempting the same tools from a *third* mechanism would put three meanings behind one word.

Unknown tool names in `--allow-tool` / `--deny-tool` are a **usage error (exit 2)**, validated against `HOST_TOOL_NAMES`. A typo that silently allows nothing is exactly the failure this feature exists to prevent. Two names deserve a note (P2-2): `ask_user` and `submit_plan` are in `HOST_TOOL_NAMES` but are never registered headlessly (`planTools` is empty there), so `--allow-tool ask_user` validates and then does nothing. Rejecting it would be wrong — the name is real and `HOST_TOOL_NAMES` answers "can this ever take effect?" — so exec accepts it and writes one line to **stderr** saying it is not registered in this mode.

### 4.3 `aragon sessions` / `aragon info` / `aragon doctor`

```
aragon sessions list [--json] [-n <count>] [--all]   # id, updatedAt, cwd, turns, model
aragon sessions show <id> [--json]                   # metadata + message count (never the bodies unless --json)
aragon sessions rm <id> --yes
aragon sessions prune [--older-than <days>] [--dry-run] [--all] --yes
aragon sessions path                                 # print the sessions directory

aragon info [--json]                            # capability discovery (§5.4)
aragon doctor [--json] [--probe]                # environment checks; exit 0 all pass, 1 otherwise
```

`list` and `prune` see only exec-managed sessions (files carrying `meta.id`) unless `--all` is given; `.last.json` and `*.lock` are never listed and never pruned. This is the P1-5 guard: the directory is shared with the TUI's `/save`, and a `prune` that swept it would delete conversations a human saved by hand. `show` and `rm` take any id, because the user named it.

`aragon doctor` checks, in order: Node version vs `engines`; `ARAGON_HOME` resolution and writability; `config.json` parses; a provider key is resolvable for the configured provider; the configured model is known to the registry; `sessions/` is writable. `--probe` adds one minimal API call. Every check reports `pass | warn | fail` with a one-line remedy; only `fail` affects the exit code.

### 4.4 Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | agent / runtime error (the run started and failed) |
| `2` | configuration or usage error (the run never started) |
| `3` | **new** — stopped by a caller-set budget (`--max-turns`, `--max-duration`) |
| `128 + signo` | interrupted by a signal — **`130`** SIGINT, **`143`** SIGTERM, **`129`** SIGHUP |

`0`, `1` and `2` are unchanged and continue to mean exactly what the existing README says. `3` is added rather than folded into `0` or `1` because both alternatives lose information a shell script needs and cannot recover without parsing JSON: `0` claims a complete answer that does not exist, `1` claims a malfunction that did not happen.

**The signal row is `128 + signo`, not a flat `130` (P1-11).** v1 wrote "`130` interrupted (SIGINT / SIGTERM)". `logging/install.ts` holds `SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }` and exits `128 + signo`, so SIGTERM already yields **143** on this CLI and always has. Reporting `130` for it would be either a lie in the JSON or an unannounced change to a convention every shell already understands. The existing README's "`130` interrupted" is a fair simplification for prose about a CLI a human Ctrl-Cs; it is not good enough for a wire contract, and the new README section states all three. `stopReason` stays `'interrupted'` for all of them — which signal arrived is an operating-system fact, not an agent outcome.

---

## 5. Data model

### 5.1 The event schema (`exec/events.ts`)

`EXEC_SCHEMA_VERSION = 1`. It appears on `system` and on `result`. Adding a field never bumps it; renaming or removing one does. Consumers are contractually required to ignore unknown event `type`s and unknown fields — this is stated in the README so that adding an event later is not a breaking change.

```ts
export const EXEC_SCHEMA_VERSION = 1;

export type ExecEvent =
  | { type: 'system'; subtype: 'init'; schemaVersion: number; sessionId: string;
      cli: string; cwd: string; startedAt: number;
      model: { provider: string; id: string; baseUrl: string | null };
      permissionMode: 'auto' | 'plan' | 'strict'; tools: string[]; resumed: boolean }
  | { type: 'user'; sessionId: string; turn: number; text: string; source: 'caller' | 'todo_continue' }
  | { type: 'text_delta'; sessionId: string; turn: number; delta: string }
  | { type: 'thinking'; sessionId: string; turn: number; text: string }
  | { type: 'assistant'; sessionId: string; turn: number; text: string }
  | { type: 'tool_call'; sessionId: string; turn: number; id: string; name: string;
      input: Record<string, unknown> }
  | { type: 'tool_result'; sessionId: string; turn: number; id: string; name: string;
      isError: boolean; durationMs: number; output: string }
  | { type: 'todo'; sessionId: string; total: number; done: number; activeIndex: number;
      items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { type: 'team'; sessionId: string; subtype: 'dispatch_start' | 'agent_update' | 'dispatch_end';
      label?: string; phase?: string; description?: string; durationMs?: number;
      toolCalls?: number; ok?: number; total?: number; aborted?: boolean }
  | { type: 'fast_review'; sessionId: string; turn: number; model: string; text: string }
  | { type: 'retry'; sessionId: string; attempt: number; maxRetries: number;
      errorType: string; delayMs: number }
  | { type: 'error'; sessionId: string; fatal: boolean; code: string; message: string }
  | ExecResultEvent;

export interface ExecResultEvent {
  type: 'result';
  schemaVersion: number;
  sessionId: string;
  isError: boolean;
  stopReason: 'end_turn' | 'max_turns' | 'timeout' | 'interrupted' | 'error';
  /**
   * `0` success | `1` agent error | `2` usage/config | `3` budget |
   * `128 + signo` for a signal (130 SIGINT, 143 SIGTERM, 129 SIGHUP).
   * DELIBERATELY `number`, not a union (P1-11): the CLI's existing
   * `128 + signo` convention makes the signal values open-ended, and a
   * union that omitted 143 would make the honest value unrepresentable.
   */
  exitCode: number;
  result: string;                 // the final assistant text; '' when there was none
  turns: number;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  cost: { amount: number; currency: 'USD'; known: boolean };
  model: { provider: string; id: string };
  todos: { total: number; done: number } | null;
  error: { code: string; message: string } | null;
}
```

`cost.known` is `controller.isPricedModel({ providerId, modelId })` (P2-3) — the method already used for this question elsewhere in the CLI, not a second price-table lookup. When it is `false`, `amount` is `0`, mirroring the fast tier's existing rule that "a feature that looks free while it is spending money is worse than one that admits it does not know". `amount` itself comes from `computeCost(total, getModelInfo().cost)`, the same helper `runHeadless`'s `[usage]` footer uses, so the two faces cannot disagree about what a run cost.

**Wire rules.**

- `stream-json`: one JSON object per line, `\n`-terminated, no pretty-printing, UTF-8.
- `json`: the `ExecResultEvent` object alone, pretty-printed with two spaces, on stdout. `aragon exec --output-format json "…" | jq -r .result` is the intended one-liner.
- **In `json` and `stream-json`, stdout carries nothing but the schema.** Migration notices, config-parse warnings, untrusted-skill notices, retry lines, `[usage]`, `[team]`, `[todo]` and every log record go to stderr. `runModels`-style stdout writing must not appear on this path.
- Exactly one `result`, always last, on every exit path including error, budget and signal (**AC-6**). `ExecEmitter.result()` is idempotent: the second call is a no-op, so a `finally` and an error handler racing cannot produce two.
- A `tool_result.output` line can approach 100 KB (the core executor's truncation ceiling). Consumers must use a line reader without a small buffer cap; the README says so. No second truncation is applied — the event carries what the model saw, which is the only faithful choice.

### 5.2 Session file (`session/store.ts` over `session/persist.ts`)

```ts
export interface SavedSession {          // existing; version stays 1
  version: 1;
  savedAt: number;
  model: ModelRef;
  messages: Message[];
  entries: Entry[];
  todos?: TodoItem[];
  meta?: SessionMeta;                    // NEW, additive, optional
}

export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  turns: number;                         // cumulative across invocations
  cli: string;                           // the version that last wrote it
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}
```

**`entries` is written as `[]`, and the interop claim is narrowed to match (P1-6 / D-14).**

v1 said exec writes `entries` "even though exec never renders a transcript", implying it comes for free. It does not. `Entry[]` is produced by `agent/reducer.ts::reduceEvent` → `viewReducer`, driven by `App.tsx`; `AgentController` exposes `getMessages()` and **no `getEntries()`**, and the team, todo, fast and retry entries arrive through separate dispatch paths inside the App rather than from the agent stream. Reconstructing a faithful transcript in exec means porting a meaningful slice of the renderer into the headless path — more work than the whole of the rest of §5.2, for a payoff nobody has asked for.

The alternative was not "leave it undecided": `entries: []` **passes `loadSession`'s validation** (it checks only that both are arrays), so an implementer who skipped the work would ship a session that resumes in the TUI with full model memory and a blank transcript, with no error anywhere. That is the silent outcome, and choosing it deliberately is better than arriving at it by omission.

So: exec writes `entries: []`, and the interoperability claim becomes the true one, stated in the README in these words — **a session created by `aragon exec` and resumed with `aragon --resume` carries the model's full memory, and shows no scrollback for the turns that ran headlessly.** The reverse direction is unaffected and fully faithful: a TUI `/save` resumed by `aragon exec --resume <id>` keeps everything, because exec never reads `entries`.

### 5.3 Permission (`exec/permission.ts`)

```ts
export type PermissionMode = 'auto' | 'plan' | 'strict';
export interface ToolPermission {
  mode: PermissionMode;
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
  /** Resolved per tool array; the only method the tool factory calls. */
  isAllowed(tool: string): boolean;
}
```

`isAllowed` returns `true` unconditionally for every name in **`TEAM_SUBAGENT_TOOL_NAMES`** (imported from `team/comm-tools.ts`; §4.2 invariant 4). There is no `EXEC_POLICY_EXEMPT` — P1-3 removed it as a duplicate of a constant that already exists.

`resolvePermission()` returns `undefined` for `--permission-mode auto` with no `--allow-tool` / `--deny-tool`, so the default path passes no `permission` key at all and §4.2 invariant 2 holds by construction rather than by care.

### 5.4 `aragon info --json`

```jsonc
{
  "cli": "0.6.0",
  "core": "0.2.12",
  "node": "v22.17.0",
  "schemaVersion": 1,
  "home": "/home/u/.aragon-agent",
  "configPath": "/home/u/.aragon-agent/config.json",
  "sessionsDir": "/home/u/.aragon-agent/sessions",
  "provider": "anthropic",
  "model": "claude-...",
  "hasApiKey": true,
  "tools": ["read_file", "write_file", "…"],
  "outputFormats": ["text", "json", "stream-json"],
  "inputFormats": ["text", "stream-json"],
  "permissionModes": ["auto", "plan", "strict"],
  "features": ["exec", "sessions", "permissions", "budgets", "team", "todo", "skills", "fast"]
}
```

`features` is a flat string list on purpose: a wrapper testing `info.features.includes('sessions')` keeps working across versions that add capabilities, which a nested shape with renamed keys would not.

---

## 6. File / module change plan

### 6.1 New files

| File | Intent |
|---|---|
| `packages/cli/src/exec/events.ts` | The versioned event union, `EXEC_SCHEMA_VERSION`, and pure builders. No I/O. |
| `packages/cli/src/exec/options.ts` | `ExecOptions` + `resolveExecOptions(raw)` — validation, clamps, mutual exclusions, usage-error codes. Pure. |
| `packages/cli/src/exec/permission.ts` | `PermissionMode`, `ToolPermission`, `resolveToolAllowList()`, `resolvePermission()`. Pure. Re-exports nothing; the comm-tool exemption comes from `team/comm-tools.ts`. |
| `packages/cli/src/exec/emitter.ts` | `ExecEmitter` interface; `TextEmitter` (no-op passthrough), `JsonEmitter`, `StreamJsonEmitter`. Owns result-once. |
| `packages/cli/src/exec/runner.ts` | Stream translation, turn counting, wall-clock timer, the `setSignalTerminator` swap (§3.6), todo follow-through loop. |
| `packages/cli/src/exec/stdin-stream.ts` | NDJSON stdin reader: `user` / `interrupt` / `end`; tolerant of unknown types and bad lines. |
| `packages/cli/src/exec/index.ts` | `runExec(flags, options): Promise<number>` — wiring only. |
| `packages/cli/src/exec/cli-commands.ts` | `registerExecCommand(program, toFlags)`. |
| `packages/cli/src/session/store.ts` | Id-keyed store: read/write/list/latest-for-cwd/prune + the `wx` lock of §3.4 (uuid-guarded release, `kill(pid,0)` liveness probe, `SESSION_LOCK_TTL_MS`). |
| `packages/cli/src/session/cli-commands.ts` | `registerSessionsCommand(program, toFlags)`. |
| `packages/cli/src/diagnostics/info.ts` | The `aragon info` payload builder. |
| `packages/cli/src/diagnostics/doctor.ts` | The check list, verdicts and remedies. |
| `packages/cli/src/diagnostics/cli-commands.ts` | `registerInfoCommand` / `registerDoctorCommand`. |

### 6.2 Modified files

| File | Change |
|---|---|
| `packages/cli/src/cli.tsx` | Four imports + four `register*Command(program, toFlags)` calls. `makeController`'s options bag gains `permission?: ToolPermission`. Nothing else. |
| `packages/cli/src/agent/controller.ts` | `ControllerDeps.permission?: ToolPermission`; forwarded to `createBuiltinTools` and into the team runtime deps. Add `appendSystemPrompt?: string` handling next to the existing prompt assembly. |
| `packages/cli/src/tools/index.ts` | `BuiltinToolsOptions.permission?`; **one new `if`, placed after the `teamTools` append and before the `toolPolicy` wrapper**, leaving both tail returns byte-identical (§4.2 invariants 1–2). No new exported constant. |
| `packages/cli/src/team/runtime.ts` | Carry `permission?` beside `toolPolicy` (`:53`, `:202`). |
| `packages/cli/src/team/subagent.ts` | Carry `permission?` beside `toolPolicy` (`:80`, `:152`, `:213`). |
| `packages/cli/src/agent/system-prompt.ts` | Append `appendSystemPrompt` verbatim under a stable `## Additional instructions` heading, after everything the CLI generates. |
| `packages/cli/src/logging/install.ts` | Doc-comment only: record that a terminator may now **return without exiting** when it owns an in-flight run (§3.6), and that such a terminator must own an exit path. No behaviour change. |
| `packages/cli/src/session/persist.ts` | `SavedSession.meta?: SessionMeta` (additive; `SESSION_VERSION` unchanged). **`saveSession` must gain a `meta` field on its `data` parameter as well as on the interface** — the file's own P0-2 comment records why: "the writer below builds its payload from THIS parameter, not from the type, so a `todos?` field on the interface with no field here would ship a key nothing ever writes" (P2-6). |
| `packages/cli/src/config/load.ts` | `CliFlags` gains nothing — exec options are their own type. (Listed to record that this was considered and declined: exec options are per-invocation and must not reach `config.json`.) |
| `packages/cli/src/__tests__/glyphs.test.ts` | **`inScope()` must gain `exec`, `session` AND `diagnostics`** — `session/` is not in the predicate today either, so v1's mitigation covered one of three new trees (P1-7). Plus an `AC-52`-style assertion on the predicate itself. See R-3. |
| `packages/cli/package.json` | version → `0.6.0`; keywords += `exec`, `headless`, `automation`, `ci`. |
| `packages/cli/README.md` | New `## Use it from another project` section; `exec` rows in Usage; the exit-code table gains `3`; the event schema; the spawn recipe. |
| `README.md` (root) | A short `## Use it from another project` section with one Node spawn snippet, linking to the CLI README. |
| `packages/cli/CHANGELOG.md` | `0.6.0` entry. |

### 6.3 New tests

| File | Covers |
|---|---|
| `__tests__/exec-options.test.ts` | Every validation branch, every mutual exclusion, every usage code. |
| `__tests__/exec-permission.test.ts` | The three baselines; allow adds; deny wins; unknown name → error; exemptions. |
| `__tests__/exec-emitter.test.ts` | NDJSON framing; result-once idempotence; result-last on every path; `json` mode emits exactly one object. |
| `__tests__/exec-runner.test.ts` | Stubbed controller (the `HeadlessController` object-literal pattern): event translation, `max_turns`, `timeout`, `interrupted`. |
| `__tests__/exec-text-parity.test.ts` | **AC-1**: `runExec({outputFormat:'text'})` and `runHeadless()` produce identical stdout and stderr for the same stub. |
| `__tests__/session-store.test.ts` | Id validation (traversal refused); create/resume round-trip; `--continue` cache-miss fallback; lock contention; **a lock whose pid is dead is reclaimed, and one whose pid is alive is not**; prune leaves a `/save` file (no `meta`) alone. |
| `__tests__/exec-child-permission.test.ts` | A subagent built through `team/subagent.ts` receives the same filtered tool array, and `team_send` / `team_wait` survive `--permission-mode strict`. |
| `__tests__/exec-signals.test.ts` | **AC-18 / P0-1**: the runner installs its behaviour through `setSignalTerminator` and adds **no** `process.on('SIGINT')` listener (asserted on an injected `ProcessHookPort`); first signal settles and emits `result`; second within 2 s exits 130; the previous terminator is restored in `finally`. |

All new tests live in `packages/cli/src/__tests__/`, which `tsconfig.test.json` already covers — `typecheck-scope.test.ts` asserts that mechanically for any `__tests__` directory under `src/`, so a future nested one would be caught (P2-7).

---

## 7. Documentation plan (`README.md` + `packages/cli/README.md`)

The requirement names the README explicitly, so this is a deliverable rather than a courtesy. The CLI README is **1587 lines** and `## Quick start` sits at line 50; the new section goes immediately after it, because a reader evaluating the package for integration should not have to scroll past a thousand lines of keybindings, themes and skills to find out that it is possible. (v1 said "500 lines of keybindings" — P2-4; the real figure makes the point harder, not softer.)

`## Use it from another project` contains, in order: a two-line pitch; `aragon exec` usage; the three output formats with a real transcript of each; the permission table with the three one-sentence examples from §4.2; session continuity with a two-invocation example; the exit-code table; the event schema with the forward-compatibility contract stated plainly ("ignore event types you do not know; fields are added without a version bump"); a Node `child_process.spawn` recipe that reads NDJSON and resolves on `result`; a CI recipe (`--permission-mode plan --max-turns 20 --output-format json`); and an honest **Limits** subsection.

**The Limits subsection is load-bearing and says four things, all of them true:**

1. There is no filesystem sandbox. `tools/fs-tools.ts::resolvePath` returns an absolute path unchanged, so tool permission — not a directory allowlist — is the boundary, and a `bash`-enabled run can reach anything the invoking user can.
2. **Process exit is terminal, `result` or no `result`.** On POSIX, `SIGINT` / `SIGTERM` / `SIGHUP` all produce a final `result`; **on Windows only Ctrl-C does**, because Node does not deliver the other two to listeners (§3.6). A consumer must resolve on process exit as well as on `result`, or a killed run hangs the parent.
3. A session created by `aragon exec` and resumed with `aragon --resume` carries the model's full memory and shows **no scrollback** for headless turns (§5.2 / D-14).
4. `aragon sessions prune` shares a directory with the TUI's `/save` and therefore only touches sessions exec created, unless `--all` is passed.

The root README gains a short `## Use it from another project` between `## CLI` and `## Quick start`, with one spawn snippet and a link. Its existing content is untouched.

---

## 8. Testing & acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | For the same stubbed controller and prompt, `runExec({ outputFormat: 'text' })` writes byte-identical stdout **and** stderr to `runHeadless()`. |
| AC-2 | `aragon -p "x"`, `aragon`, `aragon config …`, `aragon models`, `aragon skills …` are unchanged: no new code executes on those paths (asserted by the delegation in D-1 and by the existing suites staying green without modification). |
| AC-3 | `--output-format json` writes exactly one JSON object to stdout and nothing else, for success, agent error, config error, `max_turns`, `timeout` and SIGINT. |
| AC-4 | `--output-format stream-json` output is valid NDJSON: every line parses independently. |
| AC-5 | The first stream-json line is `system/init` and carries `schemaVersion`, `sessionId`, `tools` and `permissionMode`. |
| AC-6 | Exactly one `result` event is emitted, and it is the last line, on all six exit paths of AC-3. A double `result()` call is a no-op. |
| AC-7 | `--session-id ci-1 "remember X"` then `--session-id ci-1 "what did I ask?"` in a second process: the second run's messages contain the first exchange. |
| AC-8 | `--session-id ../../etc/passwd` exits 2 without touching the filesystem. So do `--session-id ''`, `--session-id .hidden`, and a 65-character id. |
| AC-9 | `--continue` with a deleted `.last.json` still resolves the newest session for the cwd. |
| AC-10 | A second `--session-id x` while the first holds the lock exits 2 with `session_busy`; the first is unaffected. |
| AC-11 | `--permission-mode strict --allow-tool read_file` registers exactly `read_file` (plus exemptions); `write_file` is absent from `system/init.tools`. |
| AC-12 | `--deny-tool bash` is honoured **inside a `task` subagent**: the child's tool array contains no `bash`. |
| AC-13 | `--deny-tool` and `--allow-tool` naming the same tool: deny wins. |
| AC-14 | `--allow-tool nosuchtool` exits 2 and names the valid set. |
| AC-15 | `--permission-mode plan` produces the same registered tool set **and** the same system prompt as `-p --plan` — including the five `PLAN_MODE_BLOCKED_TOOLS`, which stay registered and refuse at call time (P0-2). Asserted by comparing `listTools().map(t => t.name)` from both paths. |
| AC-16 | `--max-turns 2` on a model that would take five turns: exit 3, `stopReason: "max_turns"`, `isError: false`, and the partial answer is present in `result.result`. |
| AC-17 | `--max-duration 1000` against a slow stub: exit 3, `stopReason: "timeout"`; the process exits within 2 s (the timer is `unref`d and cleared). The hidden `--timeout` alias resolves to the same option. |
| AC-18 | SIGINT mid-run: a `result` with `stopReason: "interrupted"` reaches stdout, the session is persisted, exit **130** — **and the runner registered zero `process.on('SIGINT')` listeners**, having gone through `setSignalTerminator` instead (P0-1). Both halves are asserted; the first alone passed in a design that could not work. SIGTERM through the same path yields `stopReason: "interrupted"` and exit **143** (P1-11), asserted separately so the `128 + signo` convention cannot regress to a flat 130. |
| AC-19 | `--input-format stream-json` without `--output-format stream-json` exits 2. `--max-turns` with `--output-format text` exits 2. `exec --print` exits 2. Each error names the flag and the format. |
| AC-20 | `--input-format stream-json` drives three turns from one process; a malformed line yields a non-fatal `error` event and is skipped. |
| AC-21 | `aragon info --json` parses and contains `schemaVersion`, `features`, `tools`. |
| AC-22 | `aragon doctor --json` exits 0 on a configured machine and 1 with a named failing check when the API key is removed. |
| AC-23 | `aragon sessions list --json` returns an array sorted by `updatedAt` descending; `prune --dry-run` deletes nothing; **a file with no `meta` (a TUI `/save`) is neither listed nor pruned without `--all`** (P1-5). |
| AC-24 | `--append-system-prompt "…"` appears verbatim in `controller.getSystemPrompt()`, after the builtin content. |
| AC-25 | `glyphs.test.ts::inScope()` is `true` for `exec/runner.ts`, **`session/store.ts` and `diagnostics/doctor.ts`**, and the scan is green (P1-7). Asserted on the predicate, per that file's `AC-52` doctrine: a green scan proves nothing about a tree nothing looks at. |
| AC-26 | A `tool_result` carrying 100 KB of output serialises to one line and re-parses intact. |
| AC-27 | `npm test` and `npm run typecheck` pass in `packages/cli` — note `typecheck` runs **two** tsconfigs (`tsconfig.json` and `tsconfig.test.json`), so a green `build` is not evidence for it (P2-7). `npm run verify:brand` stays green. |
| AC-28 | **`createBuiltinTools` with no `permission` key returns the same tool objects it does today, proven by identity** — the `AC-G17` discipline extended to the new option (P1-2). |
| AC-29 | A session lock whose recorded pid is dead is reclaimed on the next acquire; one whose pid is alive is not; release is refused when the on-disk `uuid` is not ours (P1-4). |
| AC-30 | A session written by `aragon exec` loads in the TUI with `messages` intact and `entries` empty — the documented D-14 outcome, asserted so it cannot regress into an unnoticed one. |

Manual smoke (to be written as `docs/plans/cli-integration-surface/manual-test.md` by the implementation node): the two-invocation session demo; the CI recipe against a real key; **Ctrl-C during a `bash` tool call on both Windows and a POSIX shell**, plus `kill -TERM` on POSIX only, with the Windows expectation written down as "the process dies without a `result`, and the wrapper must survive that" (P1-10); and `aragon sessions prune --older-than 0 --dry-run` in a directory that also holds a `/save` file.

---

## 9. Risks & mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | The text path silently diverges from `-p`, breaking existing users | High | D-1: text mode **delegates** to `runHeadless`; AC-1 asserts byte equality on both streams. |
| R-2 | Something writes to stdout in JSON mode (a migration notice, a `[skills]` warning, a stray `console.log`), corrupting every consumer | High — silent, and only in the field | All human output on exec paths goes to stderr; `exec-emitter.test.ts` asserts stdout is exactly the schema; the emitter is the only object handed a stdout stream. |
| R-3 | The new trees are invisible to `glyphs.test.ts::inScope()`, so non-ASCII literals ship and render as mojibake on legacy consoles | Medium — **green suite, broken output** | `inScope()` gains `exec`, `session` **and** `diagnostics`; AC-25 asserts the predicate itself. Note `session/` is *already* outside the predicate today, so naming only `exec` (as v1 did) would have left two of three new trees unscanned — P1-7. The test file's own `AC-52` comment records the failure mode: "a new tree that nothing looks at — `scan()` returns `[]` for an unscanned directory exactly as it does for a clean one". |
| R-4 | `--deny-tool` is not threaded into subagents, so one `task` call bypasses the policy | High — a security control that silently does not hold | AC-12; the thread points are enumerated by file and line in §6.2; the precedent (plan mode reaching one level down) is cited in the code comment. |
| R-5 | The permission filter is added to `BuiltinToolsOptions` but not forwarded from `ToolDeps` / the controller, so it type-checks and does nothing | Medium — no error anywhere | This is the documented `recordChange` / `recordOutput` failure mode in `tools/index.ts`'s own comments (the "two-interface rule"). Called out in the change plan; AC-11 fails if it happens. |
| R-6 | The permission filter is folded into an existing early return in `createBuiltinTools`, reintroducing the `--no-skills --plan` class of bug | Medium | §4.2 invariant 1 requires a separate guard; the file already carries the comment "If you ever collapse these two guards back into one, that is the bug you are reintroducing, and nothing reports it". |
| R-7 | `--session-id` becomes a path-traversal write primitive | High | AC-8; validation is a pure function tested independently of the filesystem. |
| R-8 | Concurrent same-id runs corrupt the session | Medium | `openSync(path,'wx')` lock reusing `update/install-lock.ts`'s real pattern — uuid-guarded release, `kill(pid,0)` liveness probe, 10-minute TTL (§3.4 / AC-29); fail fast with `session_busy` rather than block. |
| R-15 | **exec's interrupt handling is added as a second `process.on('SIGINT')` and never runs**, because `logging/install.ts` already owns the listener and its default terminator exits first | High — AC-18 fails silently on every platform; the wrapper sees a bare exit with no `result` | P0-1. §3.6 routes exec through `setSignalTerminator`; AC-18 asserts **zero** `process.on('SIGINT')` registrations on an injected `ProcessHookPort`, so the working design and the broken one are distinguishable by test rather than by inspection. |
| R-16 | `sessions prune` deletes conversations a human saved with `/save`, because both live in `getSessionsDir()` | High — unrecoverable, and triggered by a maintenance command the docs recommend | P1-5. `list` / `prune` are scoped to files carrying `meta.id`; `--all` opts in; AC-23 asserts a `/save` file survives. |
| R-17 | `entries` is quietly shipped as `[]` by an implementer who finds no `getEntries()`, and TUI resume shows a blank transcript with no error | Medium — silent, and only visible to a user who resumes | P1-6. The outcome is now the *decision* (D-14), documented in §5.2, in the README's Limits, and pinned by AC-30 — so it is a stated property rather than an unnoticed one. |
| R-9 | The `.last.json` pointer desyncs and `--continue` resolves the wrong or no session | Low | The pointer is a cache with a documented directory-scan fallback; AC-9. |
| R-10 | `--max-turns` / `--max-duration` abort leaves an orphaned subagent or a live timer, so the process never exits | Medium | Both route through the existing `controller.abort()`; the timer is `unref`d and cleared in `finally`; `controller.dispose()` runs on both branches, as `cli.tsx` already requires for the TUI. |
| R-11 | An unbounded `text_delta` stream makes stream-json unusably chatty | Low | Deltas are **opt-in** (`--partial-messages`); the default is settled `assistant` events, matching Claude Code's `--include-partial-messages` default. |
| R-12 | The event schema ossifies and cannot grow | Medium | `EXEC_SCHEMA_VERSION` + an explicit forward-compatibility contract in the README: unknown types and unknown fields must be ignored, so additive change never bumps the version. |
| R-13 | `cli.tsx` grows further past the 1000-line guideline | Low | All commander wiring lands in `<domain>/cli-commands.ts` modules (§3.1); `cli.tsx` gains ~10 lines. |
| R-14 | Scope: seven new modules and four new commands in one implementation node | Medium | §10 orders the work so that each phase is independently shippable and green; phases 5–7 can be deferred without leaving the tree inconsistent. |

---

## 10. Implementation order

Each phase ends with a green `npm run typecheck && npm test` in `packages/cli`, and each is independently shippable.

1. **Contract first.** `exec/events.ts`, `exec/options.ts`, `exec/permission.ts` + their three unit tests. No wiring, no I/O. This is where the design is actually settled.
2. **Permission enforcement.** The single `tools/index.ts` guard (§4.2 invariants 1–2), `controller.ts` / `team/*` threading, `exec-permission` + `exec-child-permission` tests, and **AC-28 before anything else in this phase** — the identity assertion is what proves the existing paths were not disturbed, so it is worth having before the threading lands rather than after.
3. **Emitters + runner, including signals.** `exec/emitter.ts`, `exec/runner.ts`, `exec/index.ts`; `exec-emitter`, `exec-runner`, `exec-signals` and the **AC-1 parity** test. The `setSignalTerminator` swap (§3.6 / P0-1) belongs here and not later: it is the one part of the runner that cannot be retrofitted without re-testing every exit path.
4. **Command wiring.** `exec/cli-commands.ts` + the `cli.tsx` call site + `glyphs.test.ts::inScope`. At this point `aragon exec` works end to end for text / json / stream-json, stateless.
5. **Sessions.** `session/store.ts` (lock + liveness probe), `session/persist.ts` `meta` on **both** the interface and `saveSession`'s parameter, `session/cli-commands.ts`, `session-store.test.ts`.
6. **`--input-format stream-json`.** `exec/stdin-stream.ts` + test.
7. **`info` / `doctor`.** `diagnostics/*` + their JSON shapes.
8. **Docs + version.** Both READMEs (including the four-point Limits subsection of §7), `CHANGELOG.md`, `package.json` → `0.6.0`, `manual-test.md`.

---

## 11. Decision record

| # | Decision | Alternative rejected, and why |
|---|---|---|
| D-1 | `--output-format text` delegates to `runHeadless` verbatim | Reimplementing text in the emitter — makes "the human CLI is unchanged" unprovable and guarantees drift. |
| D-2 | Persist the session, then emit `result` | Emitting first — a caller that respawns immediately races the writer. |
| D-3 | A new subcommand rather than more root flags | `aragon -p --output-format …` — pollutes the human `--help` with 14 machine flags and collides with the root positional. |
| D-4 | Deny by **not registering**, not by refusing at call time | Refusal wastes turns and teaches the model to retry a tool it can see; the tool array is already fixed at session start. |
| D-5 | `--permission-mode` sets a baseline; allow/deny adjust it | A single flat allowlist — cannot express "everything except bash" without enumerating the whole set, which breaks the day a tool is added. |
| D-6 | Exit code `3` for budgets | `0` claims a complete answer that does not exist; `1` claims a malfunction that did not happen; both force JSON parsing on shell users. |
| D-7 | `--max-turns` counted CLI-side | Adding a ceiling to `@aragon-agent/core` — an API change to a separately published package for a CLI-shaped need. |
| D-8 | No new `ARAGON_*` variables | **Re-argued in v2 (P1-9).** The v1 reason misread `config/env.ts:348`, which says a container or a wrapper that owns argv can reach "neither a flag nor a config file" — i.e. env exists for the operator *downstream* of such a wrapper, which is exactly what an embedded `aragon exec` is. The real reason is simpler and survives: every existing `ARAGON_*` override already reaches exec through `toFlags(program.opts())` → `loadConfig()` → `readEnvOverrides()`, so a new twin would be a duplicate channel, not a missing one. |
| D-14 | `entries: []`, and say so | Porting the renderer's reducer into the headless path — more work than the rest of §5.2 combined, for a payoff nobody asked for. The alternative that was actually on the table was not "do it properly" but "arrive at `[]` by accident", since `loadSession` validates only array-ness (P1-6). |
| D-15 | exec owns the signal path through `setSignalTerminator` | A second `process.on('SIGINT')` — it is registered later than `logging/install.ts`'s and therefore never runs (P0-1). |
| D-16 | `--max-duration`, with `--timeout` as a hidden alias | `--timeout` alone — the most generic of four timeout names for the least familiar of them, next to `--tool-timeout` and `--idle-timeout` (P2-1). |
| D-9 | `--append-system-prompt` only, never `--system-prompt` | Full replacement silently disables tool discipline, todo planning, skills and plan mode; the symptom is "the model got worse". |
| D-10 | Session store reuses `SavedSession` v1 + optional `meta` | A second format — forfeits `/save` ↔ `exec --resume` interop for no gain; the `todos?` field already set the additive precedent. |
| D-11 | `session_busy` fails fast | Blocking on a lock for an unbounded time with no UI is a hang. |
| D-12 | Deltas opt-in | A per-token NDJSON line is thousands of lines per turn and is only wanted by callers rendering a live UI. |
| D-13 | No `--add-dir` / no sandbox claim | `fs-tools.ts` does not confine absolute paths; a directory allowlist would be a promise the wiring does not keep. |

---

## 12. Completeness note

This document specifies the command surface (§4), the wire contract (§5.1), the on-disk contract (§5.2), the enforcement points by file and line (§6.2), **30** acceptance criteria (§8), **17** risks with mitigations (§9), an eight-phase order (§10) and **16** recorded decisions (§11). A downstream engineer should be able to implement it without further design decisions; where a decision was deliberately deferred it is listed as a non-goal in §2.2 with the reason, not left open.

v2 additionally records, in 评审记录 above, the seven claims about existing code that were checked and **confirmed** — commander's option hoisting, stdout purity on the exec path, the absence of a turn ceiling in core, `runHeadless`'s injectable streams, both READMEs' section order, `SESSION_VERSION`'s additive precedent, and `skills/lock.ts`'s blocking loop. Those are listed so the next reviewer spends their time on what changed rather than re-deriving what did not.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Eight places where the design as written could not be implemented literally, or
was literally implementable and wrong. Each is recorded with the correction that
shipped. **IF-3, IF-6 and IF-8 change an observable behaviour** and are the three
worth reading; IF-6 and IF-8 were both found in code review, after the others had
shipped.

The review verdict below closes with "this document's citations of existing code
are now verified, but they are still citations." Two of the five (IF-1, IF-2)
are exactly that species one more time, and both were caught by the code
refusing to compile or a test refusing to pass rather than by inspection.

### IF-1 — `registerExecCommand(program, toFlags)` cannot reach `makeController`

**§6.1 / §6.2.** The design gives the four new registrars a two-argument
signature and separately says `cli.tsx`'s `makeController` gains a `permission?`
option. Those two statements cannot both hold: `cli.tsx` imports
`exec/cli-commands.ts`, so that module reaching back for `makeController` is a
cycle — and `makeController` is not exported, because `runInteractive` and
`runOneShot` are its only callers.

Re-deriving the controller inside `exec/` was the other option and is worse: the
headless wiring is four decisions (`DENY_ALL_APPROVAL`, `DENY_ALL_HUMAN_INPUT`,
the two log attachments) that `makeController`'s own comment says must not be
conflated or duplicated, plus the untrusted-skill notices.

**Shipped:** `registerExecCommand(program, toFlags, { version, makeController })`,
with `cli.tsx` supplying a small `makeExecController(flags, deps)` that
reproduces `runOneShot`'s setup exactly. `runExec` takes the factory in its
context object, which also preserves §2.2's rule that `runExec()` holds no
process-global state — the hedge for a future programmatic API. The other three
registrars keep the signature the design gives them.

### IF-2 — `createRequire(...).resolve('@aragon-agent/core')` throws

**§5.4.** `aragon info` reports the installed core version. Core's `package.json`
declares an `exports` map with an `import` condition only, so
`createRequire(import.meta.url).resolve('@aragon-agent/core')` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED` — on the developer's machine as readily as on a
user's. `import.meta.resolve` is not synchronously available on Node 18 and
`engines` says `>=18`.

Reading the dependency **range** from the CLI's own `package.json` was rejected:
`"^0.2.12"` is what was asked for, and a consumer asking `aragon info` wants what
is loaded — the two differ on every machine that installed a patch release.

**Shipped:** a bounded directory walk for
`<dir>/node_modules/@aragon-agent/core/package.json`, covering the monorepo
symlink, a flat npm install and a nested one, falling back to `'unknown'`. Caught
by `exec-diagnostics.test.ts`, which asserts the field looks like a version.

### IF-3 — `--max-turns` enforced at `turn_end` reports a successful run as over budget

**§3.5.** "The runner counts `turn_end` events. On reaching `n` it calls
`controller.abort()` and sets `stopReason = 'max_turns'`." The counting half is
right. Acting on it at `turn_end` is not, and the end-to-end smoke run is what
surfaced it: `aragon exec --max-turns 1 "Reply with exactly: OK"` produced a
complete, correct answer and then reported `stopReason: "max_turns"` with **exit
3**.

Generalised, that means `aragon exec --max-turns 20 … || fail` in a CI job fails
on a **successful** twenty-turn run. `--max-turns` is a safety bound, not a
target; a bound that reports failure when it is merely reached is a bound people
learn to set one higher, which is the same as not having it.

**Shipped:** the count is still `turn_end`. Enforcement moves to the moment a
**further** turn would begin — `turn_start` with the count already at `n`, or a
further caller message with the count already at `n`. That is unambiguous: the
model asked for turn `n + 1` and the caller said no.

- AC-16 is satisfied unchanged — "a model that would take five turns" with
  `--max-turns 2` still exits 3, `stopReason: "max_turns"`, `isError: false`,
  partial answer in `result.result`.
- The source is polled **before** the exhaustion check
  (`if (next === null) break;` first), so a conversation of exactly `n` turns
  whose caller has nothing more to say exits `0` with `end_turn`.
- A CLI-generated todo continuation is charged like a caller message, because it
  is a turn the caller pays for.
- Three regression cases pin it, including the one this finding is named for:
  *"a run that ENDS in exactly --max-turns turns exits 0, not 3"*.

The README states the resulting rule in one line, because a caller should not
have to infer it.

### IF-4 — `TEAM_SUBAGENT_TOOL_NAMES` lives in `team/limits.ts`, not `team/comm-tools.ts`

**§4.2 invariant 4 / §5.3 / §6.1.** The design names `team/comm-tools.ts` three
times as the constant's home. `comm-tools.ts` only *mentions* it in its module
header; the definition is `team/limits.ts:133`, which is also where
`subagent.ts:36` imports it from.

The substance of P1-3 is untouched — the constant is reused rather than
duplicated, and no `EXEC_POLICY_EXEMPT` exists. Recorded only so the next reader
of §5.3 does not go looking in the wrong file.

**Shipped:** `import { TEAM_SUBAGENT_TOOL_NAMES } from '../team/limits.js'`.

### IF-5 — exit 2 emits no `result`, and the design only says so for one branch

**§3.3 step 2 / §5.1 / AC-3 / AC-5.** The run sequence says option-resolution
failure writes to stderr and puts nothing on stdout. It does not say what a
**session** failure does (`session_not_found`, `no_session_for_cwd`,
`session_busy`, an unreadable `--prompt-file`), and those happen after the format
is known and valid, so emitting a lone `result` for them was available.

It would break AC-5. `system/init` is specified as the FIRST stream-json line;
a `result` with no `init` before it is a shape no consumer is told to expect, and
one that cannot be distinguished from a run that started and failed.

**Shipped:** every exit-2 path — options, prompt resolution, session resolution —
reports on stderr alone and writes nothing to stdout, which makes exit `2` mean
exactly one thing: *the run never started*. A **preflight** failure is different
and keeps the design's behaviour: the format is settled and `init` has already
been written, so it emits a `result` with `exitCode: 2` (this is AC-3's "config
error"). Both READMEs state the rule.

### IF-6 — `--permission-mode plan` was a silent no-op, and AC-15 could not see it

**§4.2 / AC-15. Found in code review, not by the suite.** P0-2 correctly
established that `plan` must contribute **nothing** to the registration filter,
and `resolvePermission()` duly returns `undefined` for it. What neither the
design nor the implementation then supplied was a *carrier*: `AgentController`
reads the mode from exactly one place, `config.startInPlanMode`, which
`loadConfig` resolves from `flags.plan` — and nothing on the exec path ever set
it. So `aragon exec --permission-mode plan` ran in **build** mode: the plan gate
was never armed, the system prompt carried no plan block, and the run could
write files. Meanwhile `system/init` reported `permissionMode: "plan"`, so the
wire contract actively asserted the opposite of what was happening. The
README's own example for the flag — *"read-only research and a written plan, no
edits"* — was the case that broke.

**AC-15 as specified cannot catch this, and that is the part worth keeping.**
It compares `listTools()` from both spellings name by name, but the plan gate
**wraps rather than removes**: the registered names are identical whether the
mode is armed or not. The criterion was written to defend against unregistering
the blocked five (P0-2) and it does that well; it is simply blind to the mode
being absent altogether. The test that shipped for it was blinder still — it
handed `agentMode: () => 'plan'` to *both* sides itself, so it exercised
`createBuiltinTools` and never the wiring that is supposed to produce that
argument. This is the third instance in this document of the species its own
review verdict names: **an outcome asserted where the mechanism was meant.**

**Shipped:** `exec/index.ts::withPermissionMode(flags, mode)` returns
`{ ...flags, plan: true }` for `plan` and the **same object** for `auto` and
`strict`. Routing it through `flags.plan` rather than a new controller option is
what makes `--permission-mode plan` *literally* `--plan`, which is what §4.2
claims; the other two modes returning an unchanged reference keeps text mode
byte-identical to `-p` (AC-1) and leaves a user whose `config.json` sets
`planModeDefault: true` with the plan mode `aragon -p` would have given them —
`--permission-mode` selects a baseline **set**, and was never a switch for plan
mode in the negative direction.

A new case in `exec-permission.test.ts` asserts the mechanism end to end through
`runExec`, capturing the flags handed to the controller factory. It was
confirmed to fail against the pre-fix wiring before being kept.

### IF-7 — the terminator is not restored, because it provably need not be

**§3.3 step 13 / §3.6 / AC-18.** Two statements in the design cannot both hold:
§3.6 and AC-18 require exec to restore the previous terminator in `finally`,
while §6.2 holds `logging/install.ts` to a **doc-comment-only** edit with no
behaviour change. `setSignalTerminator` returns `void` and there is no getter, so
a literal restore needs an API change to that file.

**Shipped:** the implementation resolves it in favour of §6.2, and pays for it
with the `detached` branch in `ExecRunner`'s terminator: once `detach()` has run,
the terminator does `exit(128 + signo)` — byte for byte what the default
terminator does — so a left-behind terminator is *indistinguishable* from a
restored one, and AC-18's other two halves (zero `process.on('SIGINT')`
registrations; first signal settles and emits `result`) are unaffected.

Recorded rather than quietly dropped because the equivalence is conditional:
it holds only while nothing else in the process owns a terminator worth
returning to. The full-screen terminator that restores the terminal, and a
second `runExec` in one process under the programmatic API §2.2 hedges for, are
both cases that would break it. The source comment on `installTerminator()` says
so and names the getter as the fix.

### IF-8 — R-7 guarded one of four ways an id becomes a filename

**§3.4 / R-7 / AC-8. Found in code review, after IF-1..IF-7 had shipped.**

§3.4 states the rule exactly right — "the id becomes a filename under the user's
home directory, and the caller supplying it is frequently the least trusted input
in the pipeline" — and R-7 / AC-8 discharge it for `--session-id`, which
`resolveExecOptions` validates before anything touches the disk. `--session-id`
is not the only way a caller-supplied string reaches `sessionPathFor()`:

1. **`--resume <id|path>`.** The flag accepts a path *by design*, and
   `planSession` used `saved.meta?.id ?? options.resume` as the session id. For
   any file without `meta` — every TUI `/save`, i.e. exactly the interop §5.2
   celebrates — the id became **the path the caller typed**.
2. **`meta.id`.** It is read out of a file, and files are inputs. A session
   carrying `meta.id: "../../escaped"` redirected the write of whatever resumed
   it, through `--resume` or `--continue`.
3. **`aragon sessions rm <id>`.** `removeSession` joined argv straight onto the
   sessions directory and called `unlinkSync`.
4. **`aragon sessions show <id>`.** Same join, on a read.

`join()` normalises `../..` away silently, so an escape leaves nothing behind to
notice. Confirmed by running the code rather than by reading it:
`sessionPathFor('../../evil')` returned a path two levels **above** the sessions
directory, and `removeSession('../victim-outside')` returned `true` having
deleted a file outside it. §4.3's "`rm` and `show` accept any id, because the
user named it" sanctions any file *in the directory*, not any file anywhere —
and the audience for this feature is wrappers passing branch names and ticket
ids straight through.

**The path form of `--resume` was also broken outright, not merely unsafe.** With
the path as the id, `tryAcquireSessionLock` tried to create its lock under a
directory that does not exist; the failure is indistinguishable from contention,
so `runExec` reported **`session_busy` and exit 2** on the first turn. The
documented `/save` -> `exec --resume <path>` direction (README Limits 3) could
not complete a single run.

**Shipped:** the boundary moved to the one function that turns a string into a
path. `sessionPathFor()` and the lock share an `assertSessionId()` guard and
**throw** rather than coerce, so a future caller cannot reintroduce this by
forgetting; `removeSession` returns `false` for an id that cannot name a session
here; `sessions rm` / `sessions show` validate up front and exit 2 with the same
sentence `--session-id` produces. For resume, a new pure
`resumedSessionId(path, saved)` picks — in this order — a **valid** `meta.id`,
else the file's **basename** when that is a valid id, else a freshly minted one.
That keeps every legitimate resume landing where the user expects: an
exec-written session names itself, a TUI `/save` is named by its file (so
`--resume <path>` now updates the file it resumed), and anything else gets a new
id, reported in `system.init.sessionId` and `result.sessionId` rather than
guessed at.

Six regression cases pin it, five on the guard and one — deliberately — on the
**mechanism**: an end-to-end `runExec` with `--resume <path to a meta-less
file>`, confirmed to fail against the pre-fix wiring before being kept. That
distinction is this document's own review verdict, applied to its own fix: the
five unit cases would all pass against a `planSession` that never called the new
helper.

---

## 评审结论 (Review Verdict)

### 有条件通过 (Approved with conditions)

The design is sound and the shape is right. `aragon exec` as a second face on the same binary, `text` mode delegating to `runHeadless` rather than reimplementing it (D-1), deny-by-not-registering (D-4), exit code 3 for budgets (D-6), and the refusal to claim a filesystem sandbox that `fs-tools.ts` does not implement (D-13) are all the correct calls, and the document argues them rather than asserting them. The scope is right-sized: seven modules, four subcommands, zero changes to `packages/core`, and an eight-phase order where phases 5–7 can slip without leaving the tree inconsistent.

Two P0s and eleven P1s were found. **All thirteen are fixed in this document (v2); none remain open.**

Both P0s were of the same species, and naming it is the most useful thing this review can leave behind: **the document asserted a fact about existing code that was plausible, load-bearing, and wrong** — that `setSignalTerminator` was TUI-only, and that plan mode unregisters its blocked tools. Six of the eleven P1s are the same species (the lock is `mkdir`-based; its TTL is six hours; `session/` is already in `inScope()`; `src/commands/` is where commander wiring lives; `env.ts` says env is for callers who own argv; SIGTERM exits 130). None of them would have been caught by a reviewer reading only this document, and none would have been caught by the test suite as v1 specified it, because v1's AC-15 and AC-18 asserted the *outcome* without asserting the *mechanism* — and an outcome can be produced by a stub from a design that cannot work. The v2 criteria assert both.

The lesson for the implementation node is narrow and worth stating: **this document's citations of existing code are now verified, but they are still citations.** Where one turns out to be wrong again, the correct response is to fix the design, not to route around the code.

The approval carries four conditions. They are conditions rather than notes because each one is a place where the implementation can satisfy the letter of this document and still be wrong, and in every case the failure is silent.

1. **The two P0 fixes must be verified by the mechanism, not the outcome.** AC-18 must assert that the runner registers **zero** `process.on('SIGINT')` listeners (through an injected `ProcessHookPort`), not merely that a `result` appeared — a stubbed test can produce the right `result` from the wrong design. AC-15 must compare `listTools()` from `--permission-mode plan` and from `-p --plan` name by name, not compare prose.

2. **AC-28 (the identity assertion) lands in phase 2, before the `team/*` threading.** The claim "`-p`, the TUI and every subagent are unchanged" is worth exactly as much as the test that proves it, and after the threading lands there are four call sites to disturb instead of one. This is `AC-G17`'s discipline; the reason it exists is written in `tools/index.ts` in the file's own words.

3. **The `session/` and `diagnostics/` additions to `inScope()` ship in the same commit as those trees.** This package has now paid for that class of edit five times and the test file says so at length. `session/` is outside the predicate *today*, so this is not a case of extending a guard to new code — it is a case of the guard already having a hole that this feature widens.

4. **§7's Limits subsection is a deliverable, not a courtesy.** Its four points are the honest boundaries of what is being shipped — no sandbox, process exit is terminal on Windows regardless of `result`, exec sessions resume without scrollback, and `prune` shares a directory with `/save`. A README that documents the happy path and omits these would misrepresent the feature to precisely the audience it is built for, which is the one failure this design cannot recover from after publication.

**Not blocking, recorded for the implementation node.** The seven P2s are dispositioned in 评审记录; the four cheap ones (`--max-duration`, `cost.known`, `exec --print`, the README line count) are already applied in this document. The one worth a second thought during implementation is P2-2: `--allow-tool ask_user` validating and then doing nothing is defensible, but if the stderr warning proves noisy in practice, promoting it to a usage error is a reasonable reversal and does not need another design round.

**Deferred by agreement, not overlooked.** §2.2's non-goals are correctly reasoned and none of them was reopened: no filesystem sandbox, no `--system-prompt`, no MCP, no programmatic Node API. The last of these is the one most likely to be asked for first; §6.1's discipline of keeping `exec/index.ts` to wiring only — so `runExec()` holds no process-global state — is the right hedge and should survive implementation even though nothing today depends on it.
