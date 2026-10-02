# Background service supervision — start a server, see it come up, stop it

Version: **v2** (design, reviewed)
Status: proposed — not implemented. Reviewed; see `## 评审记录` below.
Scope: `packages/cli/src/**` (new tree `proc/`, plus `tools/`, `agent/`, `ui/`,
`commands/`, `config/`, `session/`) and **one** additive hardening in
`packages/core/src/tools/executor.ts`. No persisted-session format break, no
change to Core's frozen public export surface, no new dependency.
Feature slug: `background-service-supervision`

---

## 评审记录 (Review Notes)

Reviewed against the codebase at `packages/cli/src` and `packages/core/src`.
Every claim below was checked against the source rather than inferred from the
design; line references are to the tree as reviewed.

The diagnosis in §3.1 is correct and unusually well-evidenced — all four causes
reproduce in the source (`bash-tool.ts:146` settles on `'close'`;
`bash-tool.ts:79` leaves stdin an unanswerable pipe; `executor.ts:169` is a bare
`await tool.execute` with no race; `DEFAULT_TOOL_TIMEOUT_MS = 180_000` at
`config/schema.ts:120` reaches the executor through `agent.ts:183`). The layering
— `proc/` as a CLI-local tree, one additive Core option, a config section that
clamps rather than rejects — matches this package's conventions closely enough
that most of §4 can be implemented as written.

What follows are the places where it cannot. The four P0s are one family: this
design introduces a new **entry kind** and a new **view/engine divergence**, and
this package enforces both through *closed lists* and *prefix scans* that fail
**silently** when a new member is not added to them.

### P0 — must be resolved before implementation

**P0-1 · Force-stop makes the view idle while the engine still runs, and the next
user message crashes the CLI.**
`submitMessage` (`ui/App.tsx:1499`) branches on the **view's** `status`, not the
engine's. Rung two dispatches `runEnd` locally (§3.6 / D-6), so `status` is
`idle` while `Agent.running` is still `true`. The next submit therefore reaches
`controller.prompt()` → `Agent.prompt()` (`core/engine/agent.ts:220-222`), which
**throws synchronously**: `Agent is already running. Call abort() first or wait
for idle.` `AgentController.prompt` returns that promise unwrapped
(`agent/controller.ts:906`) and `App` calls it as `void controller.prompt(...)`,
so the rejection is unhandled — and `logging/install.ts:227` routes
`unhandledRejection` into `handleFatal`, which **exits the process**. Force-stop
therefore turns "Esc, Esc, then type" into a hard crash, on exactly the screen
this feature exists to rescue. AC-27 asserts only that the status bar reads
`idle` one frame later, so nothing in §7 catches it.
*Fixed in §3.6 (`runGeneration` + the `prompt()` totality rule), §4 (controller
row), I-7, AC-35 / AC-36.*

**P0-2 · Registering `bash_output` / `bash_kill` turns two existing tests red,
and the three constants they guard are absent from the change plan.**
`__tests__/tools.test.ts::C7` asserts `HOST_TOOL_NAMES` equals **what
`createBuiltinTools` actually produces**; `I-P6` asserts `SKILL_TOOL_FLOOR` and
`PLAN_MODE_BLOCKED_TOOLS` **partition** `HOST_TOOL_NAMES` with zero overlap.
`HOST_TOOL_NAMES` also feeds `aragon skills doctor`, `aragon info` and
`--allow-tool` validation (`exec/options.ts`). Two consequences §4 misses: each
new name must be classified into exactly one of floor/blocked, and the tools must
arrive through a **factory option** — `tools/index.ts` says in capitals, twice
(once for `teamTools`, again for `todoTools`), that appending a tool after the
factory returns turns C7 red "with a message about two lists of names that says
nothing about" the feature. §4's `procs?: ProcSupervisorPort` plus internal
construction walks straight into that trap.
*Fixed in §4 (three new rows), §5.1 (`procTools`), AC-37 / AC-38.*

**P0-3 · The new `Entry` kind must be added to five closed switches; §4 names one
and files another under the wrong module.**
`entryRevision` does **not** live in `agent/reducer.ts` — it is
`ui/layout/virtual-window.ts:72`, a file absent from §4 entirely. Both switches
there fall through silently: `entryRevision`'s `default: return 'x'` freezes the
height-cache key, and `estimateEntryRows`'s `default: return separation + 1`
calls a multi-row card one row tall. That module's own I-L3-1 comment states the
consequence — the entry "freezes at a stale height **AND** a stale rendered
subtree with nothing anywhere reporting it" — and `virtual-window.test.ts`
hand-enumerates kinds, so a new one is simply not covered. A second silent drop
is `ui/transcript-text.ts::renderEntry` (`default: return []`), which renders the
exit snapshot printed to the real terminal on quit: service cards would vanish
from the user's only post-session record. Related: because the tail is a
**fixed-size ring**, the revision term must carry the monotonic `rowsSeen`
cursor, never `rows.length` — verbatim the non-append mutation the `tool`
branch's `liveSeq` comment was written for.
*Fixed in new §3.11, §4 (two new rows + corrected reducer row), §6, AC-39.*

**P0-4 · A live service pins the transcript's settled boundary for the rest of
the session.**
`Transcript.tsx::computeSettledCount` is a **prefix scan that `break`s** at the
first non-settled entry, and the component holds the result monotonic
(`highWater`). Each of the five existing live clauses is bounded by an operation
— a dispatch, a turn, one LLM call, one countdown — and each carries a comment
saying an entry that never settles is "re-rendered on every frame for the rest of
the session". A service is bounded by the **user's intent**: a dev server left up
for an hour is the normal case, not the pathological one. "Extend the
settled-boundary clauses" (§4) therefore conceals a decision whose wrong branch
re-renders the whole transcript from the card onward, every frame, forever, with
nothing reporting it — and it does so on long sessions, which is where it is
least likely to surface in testing.
*Fixed in new §3.11 / D-11 (only `starting` blocks; the card commits its body at
first settle and terminal transitions are re-emitted), AC-40.*

### P1 — must be resolved before implementation

**P1-1 · POSIX tree-kill is not implementable as specified, so G5 fails there.**
Today's `killTree` (`bash-tool.ts:27`) is `child.kill('SIGKILL')` on POSIX, which
signals **the shell only**; `npm run dev` re-execs into node children that survive
it. Hoisting the function does not change that. §3.5 chooses `detached: false`
"(we want the tree, so we can kill it)" — inverted reasoning: with
`detached: false` the child shares the CLI's own process group, so there is no
group to signal, and `process.kill(-pid, sig)` is unavailable. R-2 discusses only
Windows.
*Fixed in §3.5, §4 (`kill-tree.ts` intent), R-2, AC-41.*

**P1-2 · Exit reaping cannot work through the mechanisms named.**
`setSignalTerminator` is a **single-slot global** (`logging/install.ts:60,97`),
already claimed by `cli.tsx:774` for screen restore — and only in the alt-screen
branch, so inline sessions have no terminator at all. Registering from `proc/`
would *replace* the restore, which `cli.tsx` documents as the bug that leaves the
user staring at a blank alternate screen. The terminator also calls
`process.exit()` synchronously, so an async `stopAll` with a 3 s SIGTERM→SIGKILL
escalation never runs; `process.on('exit')` permits only synchronous work, yet
`killTree` **spawns** `taskkill` asynchronously; and `doExit` (`ui/App.tsx:1406`)
awaits nothing.
*Fixed in §3.6 (reaping rewritten around a compose-able hook and a synchronous
primitive), §4 (`logging/install.ts` row), R-10, AC-42.*

**P1-3 · `Ctrl+O` is promised in §5.5 and drawn in §3.8's mock, but has no
implementation site in §4.**
`ui/App.tsx:1830`'s `find` is a closed list (`tool | team | compaction`). The
failure mode is the one that code comment already spells out in capitals: the
card renders its own `ctrl+o log` hint, the keystroke silently expands an **older
tool card**, and nothing errors.
*Fixed in §3.8, §4 (App.tsx row), AC-24.*

**P1-4 · The proposed running hint deletes the only visible exit affordance.**
`Composer.tsx::hintText`'s running branch is
`enter steer · esc abort · ctrl+c×2 exit`, and that file's header states the
branch is never abbreviated because the composer is "the only place that names
the abort key". §3.8 replaces the exit clause with `ctrl+c stop 2` — precisely
when Ctrl+C has stopped meaning exit — leaving no visible way to quit. It also
never names Esc's second rung.
*Fixed in §3.8 with literal strings for both rows, AC-43.*

**P1-5 · The abort force-settle discards everything the command printed.**
§3.4 rule 4 settles with `errorResult('Command aborted.')`. Today an abort kills
the tree, `'close'` fires, and the model receives
`$ cmd` + everything captured + `[signal SIGTERM]`. The executor's own 180 s
ceiling aborts through this same `ctx.signal`, so after W1 a command that hits the
ceiling returns three words and no output — on the exact path this feature exists
to make informative, and it destroys the evidence the model needs in order to
reach for `background: true`.
*Fixed in §3.4 rule 4, §3.7 (the executor supplies the reason), AC-12 / AC-13.*

**P1-6 · `forceStop` is gated behind `bash.background`, so G3 regresses when the
feature is switched off.**
§4 constructs `ProcSupervisor` only when `cfg.bash.background`, and §3.6's
`forceStop()` calls `this.procs.killForeground('force')`. With the flag off, rung
two kills nothing — yet G6 promises an off-build identical to today "except for
the G2 hardening", and G2/G3 are advertised as unconditional.
*Fixed in §3.6, §4 (controller row), I-2, AC-44.*

**P1-7 · Engine events arriving after a local `runEnd` are unspecified.**
Between rung two and the engine actually unwinding — up to `abortGraceMs`, and
unbounded if it never does — `turn_start`, `tool_call_start`, `turn_end` and
`agent_end` still reach `App`'s subscription. `runStart` / `turnStart` set
`status: 'running'` again, so the view can bounce straight back out of the `idle`
AC-27 checked one frame earlier, and stray entries append to a transcript the
user believes is finished.
*Fixed in §3.6 (`runGeneration`), I-7, AC-36.*

**P1-8 · Headless (`aragon exec` / `-p`) is undefined although `autoBackground`
defaults to `true` there.**
Both paths build tools from the same factory, so `aragon -p "npm run dev"` will
now background the server, return within `startupSettleMs`, and reap it at
process exit — with no card, no `/bg`, no event, and no note in the tool result.
§2 says only that no new event *type* is emitted, which is not the same as saying
what happens.
*Fixed in §2 non-goals, §3.5 (headless resolution), AC-45.*

### P2 — recorded, not blocking

- **P2-1** §3.5's readiness pattern is written as a regex but is not one: `[::1]`
  is a character class matching `:` or `1`, and the dots are unescaped. Restated
  as prose plus one real anchored pattern.
- **P2-2** AC-7 is vacuous as written: `https://example.com/docs` does not match a
  `localhost|127.0.0.1|0.0.0.0` host alternation, so it passes without exercising
  anything. The real false positive is a *loopback* URL printed in help text or a
  banner before the process binds. Restated.
- **P2-3** W2's race never clears its grace timer or removes its listener when the
  tool wins. `agent-loop.ts:158 raceCompaction` is the in-repo precedent and does
  both in a `finally`; §3.7 now mirrors it.
- **P2-4** `proc/log-ring.ts` overlaps `tools/tool-output-store.ts` (bounded,
  sanitised, owner-scoped, `LIVE_TAIL_ROWS` / `TOOL_OUTPUT_STORE_CAP`). The
  differences are real — 200 vs 8 rows, cursor paging, service-scoped lifetime —
  and §4 now records them so the next reader does not merge the two by reflex.
- **P2-5** `bash_kill`'s relationship to `MUTATING_TOOLS` / `--confirm` was
  unstated; §5.1 now states it.
- **P2-6** R-2 promises to report `stopped (may have left a detached child)`, but
  `killTree` spawns `taskkill` fire-and-forget and inspects nothing. The liveness
  check (`process.kill(pid, 0)`) is now named.
- **P2-7** "No animated spinner, ever" is *stricter* than
  `single-spinner-while-running` D-1, which suppresses only while the activity
  line is mounted — and a service can be `starting` while the agent is idle.
  Recorded as D-14 rather than left looking like a misreading of D-1.
- **P2-8** `PROC_LIMITS.maxServices` evicts "the oldest EXITED" service, which is
  undefined when all 16 are live. §3.5 now says what `start()` does.
- **P2-9** Whether a background launch still calls `deps.recordOutput` was
  unstated; it must not — the ServiceCard owns that tail. Said in §3.5.
- **P2-10** §10's manual walk names "Windows PowerShell", but `bash` spawns
  through `process.env.ComSpec` — cmd.exe on a default box. Both are now named.
- **P2-11** `hintText` would reach six parameters (P1-4); this repo's own
  guideline caps it at five. Noted at the fix site in §3.8.

---

## 1. Overview

Today the agent can write a web app but it cannot *run* one. The moment it tries
— `npm run dev`, `uvicorn main:app`, `next start`, `vite`, `docker compose up` —
the `bash` tool call never returns, the turn stalls, and after `idleTimeoutMs`
the engine prints `[Agent] idle watchdog fired — aborting` straight over the TUI
(`packages/core/src/engine/agent.ts:191`). What the user is left with is the
worst possible screen: a red abort line, a tool card still reading
`Running bash`, a status bar still reading `running`, and a session that will
never return to `idle` again — because the promise the agent loop is awaiting
was never settled by anybody. The attached screenshot is exactly this state at
46 minutes elapsed. The run cannot be resumed, cannot be interrupted, and the
servers the agent did manage to spawn are invisible, unnamed and unkillable from
inside the product.

This design closes that hole in three moves, which map one-to-one onto the three
sentences of the requirement. **First**, long-running commands become a
first-class concept instead of an accident: a `background` mode on the `bash`
tool, a supervisor that owns the child processes, a readiness watcher that
notices when a port starts answering or a server prints its URL, and a
transcript card that says *"service s1 · npm run dev · ready ·
http://localhost:3000"* — so "started the project" produces a visible, truthful
result rather than silence. **Second**, the interrupt path is made
unconditional: the foreground `bash` contract is rewritten so it can never hang
(settle on process *exit*, not on stream *close*; never inherit a readable
stdin; force-settle on abort after a bounded grace), and `Esc` gains a second
rung — the first `Esc` requests an abort as it does today, a second `Esc` while
the run is *still* running force-stops it and returns the view to `idle` no
matter what the engine is blocked on. **Third**, `Ctrl+C` acquires the meaning a
terminal user already expects it to have: while background services are live,
`Ctrl+C` stops *them*, and only once nothing is running does it fall through to
the existing `Ctrl+C ×2 exit`.

The design is deliberately conservative about where new machinery lives. All of
it is CLI-local, following the pattern `team/`, `todo/`, `fast/`, `update/` and
`compaction/` already established in this package: a new `proc/` tree with its
own `limits.ts`, its own event stream that is *not* a member of Core's
`AgentEvent` union, its own conditionally-spliced system-prompt block, and a
config section whose absence produces a build byte-identical to today's. The one
Core change is a short race in `ToolExecutor` so that an abort is always
answerable even when a tool misbehaves — because "Esc must work" cannot be a
promise that every present and future tool has to keep individually.

---

## 2. Goals and non-goals

### Goals

- **G1** A command that does not exit on its own can be started, and the user
  sees a card that transitions `starting → ready` (with the URL) or
  `starting → exited (code 1)` (with the failing tail). Never silence.
- **G2** A foreground `bash` call *always* settles. No input, no output stream,
  no orphaned grandchild and no abort can leave the promise pending.
- **G3** `Esc` once aborts; `Esc` twice force-stops, the view returns to
  `idle` unconditionally, **and the session stays usable** - the very next
  message the user types starts a new run rather than crashing the CLI (P0-1).
  This holds whether or not `bash.background` is on (P1-6).
- **G4** `Ctrl+C` stops the services the agent started, before it means "exit".
- **G5** No service outlives the CLI process. Quitting, `SIGINT`, `SIGTERM`
  and a fatal crash all reap the tree on a best-effort basis, on **both**
  platform families - which requires a synchronous kill primitive and a
  process-group spawn on POSIX, not the `detached: false` of v1 (P1-1 / P1-2).
- **G6** With `bash.background: false` the build is behaviourally identical to
  today except for the G2 hardening, which is a strict improvement with no
  user-visible surface.

### Non-goals

- Not a process manager that survives the CLI (no daemon, no PID file, no
  reattach across launches). Sessions are the persistence story in this package
  and a live process is not session state.
- No log files on disk for services. The tail is a bounded in-memory ring; users
  who want files redirect themselves.
- No port allocation, no proxying, no browser opening, no container awareness.
- No change to `aragon exec`'s event schema, and **no automatic backgrounding
  without an interactive view**: `autoBackground` resolves to `false` in `exec`
  and `-p` (§3.5 / P1-8). An explicit `background: true` still works there and is
  reaped at process exit, which the result text says in so many words. What is
  out of scope is a `service.*` NDJSON event type; see §10.

---

## 3. Technical design

### 3.1 Why it wedges today — four distinct causes

Read `packages/cli/src/tools/bash-tool.ts` end to end; there are four separate
ways for a call to never come back, and a fix that addresses only the obvious
one leaves the screenshot reproducible.

1. **The tool settles on `close`, not on `exit`** (`bash-tool.ts:146`).
   `'close'` fires only when the process has exited **and** every stdio stream
   has been closed. A child that spawns a detached grandchild which inherits the
   pipe — `Start-Process` on Windows, `&`/`nohup` on POSIX, and every
   `npm run dev` that re-execs — keeps that pipe open after the shell itself is
   long gone. The shell exited; the promise did not. This is the root cause of
   the reported screenshot and it is invisible to every existing test, because
   tests spawn commands that close their own pipes.
2. **stdin is a pipe nobody ever writes or ends.** `spawn` defaults to
   `stdio: 'pipe'` for all three descriptors (`bash-tool.ts:79`), so a command
   that prompts — `npm init`, a package manager asking to install something,
   `sudo`, a git credential prompt — blocks on a read that can never be
   satisfied.
3. **The command may simply never exit.** `npm run dev` is not a bug; it is the
   correct behaviour of a dev server. The executor's 180 s ceiling
   (`DEFAULT_TOOL_TIMEOUT_MS`) does eventually kill it, but only after burning
   three minutes, and it returns "timed out" — which teaches the model to retry
   with `Start-Process`, which is how the screenshot's command was written.
4. **Abort is advisory.** `ToolExecutor` does `result = await tool.execute(...)`
   (`packages/core/src/tools/executor.ts:169`) with no race against its own
   `controller.signal`. If the tool's promise never settles, the abort signal is
   delivered, `killTree` runs, and the loop still waits forever. `Esc` therefore
   does nothing at all in exactly the situation where the user most needs it.

Causes 1, 2 and 4 make the UI unrecoverable. Cause 3 makes the user's actual
task impossible. All four are addressed below.

### 3.2 The four defences, in dependency order

| # | Defence | Fixes | Lives in |
|---|---|---|---|
| W1 | Foreground `bash` settles on `exit` + bounded drain; `stdin: 'ignore'`; abort force-settles after a grace | 1, 2, partially 4 | `tools/bash-tool.ts` |
| W2 | `ToolExecutor` races `tool.execute` against abort + `abortGraceMs` | 4, for every tool present and future | `packages/core/src/tools/executor.ts` |
| W3 | `background: true` + `ProcSupervisor` + readiness watcher + service card | 3, and G1 | `packages/cli/src/proc/**` |
| W4 | Interrupt ladder: `Esc`/`Esc`, `Ctrl+C` | G3, G4, G5 | `ui/App.tsx`, `agent/controller.ts` |

W1 and W2 are independent on purpose. W1 makes the shipped tool well-behaved; W2
makes the *engine* robust to a tool that is not. Shipping only W1 leaves the next
long-running tool free to re-open the hole with nothing reporting it.

### 3.3 The new tree: `packages/cli/src/proc/`

`proc/` is a CLI-local subsystem in the exact shape of `todo/` and `team/`.
Adding the tree and adding the word `proc` to
`__tests__/glyphs.test.ts::inScope`'s hard-coded directory regex are **the same
change** — a scanner that silently stops scanning is worse than no scanner, and
this package has paid for that edit ten times already.

```
proc/
  limits.ts       PROC_LIMITS — every structural bound (rows, cap, timers)
  types.ts        ServiceRecord / ServiceSnapshot / ProcEvent / ports
  classify.ts     looksLongRunning(cmd) + extractPortHint(cmd)   (pure)
  readiness.ts    detectReadyUrl(rows) (pure) + ReadinessWatcher (net probe)
  log-ring.ts     bounded sanitised tail per service
  supervisor.ts   ProcSupervisor — spawn, registry, kill, stopAll, events
  kill-tree.ts    killTree(pid) — hoisted out of bash-tool.ts, one owner
  prompt.ts       buildBackgroundServicesBlock() + BLOCK_VERSION
```

`ProcSupervisor` owns **both** kinds of child: foreground `bash` children
(tracked so `forceStop()` can reach them) and background services (tracked so
`Ctrl+C` and exit can reach them). One registry, two lifetimes. Splitting them
into two registries is how a force-stop ends up killing the user's dev server,
or how a quit leaves it running.

### 3.4 Foreground contract (W1) — `bash` must always settle

Rewrite `execute` around a single `settle(result)` funnel that is idempotent and
reachable from five places. The spawn becomes:

```ts
child = spawn(command, {
  shell: true, cwd, env: process.env, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],   // <- W1.2: no unanswerable read
});
```

Settlement rules, in precedence order:

1. `'error'` → `errorResult('Failed to run command: ...')` (unchanged).
2. `'close'` → the happy path, byte-identical result text to today
   (`$ cmd\n<output>\n[exit code N]`), so every existing assertion holds.
3. `'exit'` **without** a subsequent `'close'` → start a `PROC_LIMITS.drainMs`
   (250 ms) timer; when it fires, settle with the same body plus one extra line
   before the status footer:
   `[note] the command exited but a background child is still holding its output stream.`
   That sentence is the whole of defence 1 and it is also a *diagnosis handed to
   the model*: it is the phrasing that should make it re-run with
   `background: true` rather than reach for `Start-Process`.
4. Abort (`ctx.signal`) -> `killTree(child.pid)`, then a
   `PROC_LIMITS.killGraceMs` (2000 ms) timer that force-settles **whether or
   not the child ever reported exit**. A pending promise after an abort is the
   bug; a possibly-premature result is not.

   **The force-settled body carries the captured output, and names the cause
   (P1-5).** v1 settled with the bare string `Command aborted.`, which is a
   regression in the only case that matters. Today an abort kills the tree,
   `'close'` fires, and the model receives `$ cmd`, everything captured, and
   `[signal SIGTERM]`. The executor's own 180 s ceiling
   (`DEFAULT_TOOL_TIMEOUT_MS`, `config/schema.ts:120`) aborts through this
   *same* `ctx.signal`, so a bare string would hand the model three words and no
   evidence at exactly the moment it needs to learn that the command is
   long-running. The body is therefore:

   ```
   $ <command>
   <captured output, or (no output)>
   [aborted after 180000ms - the command was still running]
   ```

   with the trailing line chosen from `ctx.abortCause` (§3.7): `'timeout'` gives
   the wording above plus one sentence naming `background: true`; `'external'`
   (an `Esc`) gives `[aborted]` and no advice, because the user did not ask the
   model for a workaround.
5. `params.timeout` -> as today, plus the same force-settle grace and the same
   output-carrying body.

`settle` clears every timer and removes the abort listener. The recorder
(`deps.recordOutput`) is untouched **on the foreground path**: the string handed
to the model, its truncation and its footer stay byte-identical on the happy
path, which is what keeps the existing `bash-tool` tests meaningful rather than
rewritten. A **background** launch does not call `recordOutput` at all (P2-9) -
the tool call settles within `startupSettleMs` and `tool_execution_end` then
clears the store slot, so a tail written there would flash and vanish while the
`ServiceCard`, which owns the service's output for its whole life, is the only
surface that can keep it.

### 3.5 Background launches (W3)

**Deciding.** `bash` gains an optional `background?: boolean`. Resolution:

- `background === true` → background. Always.
- `background === false` → foreground. Always. (The escape hatch; nothing
  overrides it.)
- `undefined` → `cfg.bash.autoBackground && looksLongRunning(command)`.

`looksLongRunning` is a **conservative allowlist over the command's leading token
and script name**, never a verb heuristic, and it refuses to fire on a chained
command (`&&`, `||`, `;`, or a top-level `|`) because a chain's tail is what the
model actually wants the result of. Matches include
`npm|pnpm|yarn|bun run (dev|start|serve|watch|preview)`, `next dev|start`,
`vite`, `nuxt dev`, `astro dev`, `remix dev`, `ng serve`, `webpack serve`,
`nodemon`, `tsc --watch`/`-w`, `uvicorn`, `gunicorn`, `hypercorn`, `flask run`,
`manage.py runserver`, `python -m http.server`, `rails server|s`, `php -S`,
`cargo watch`, `docker compose up` **without** `-d`, `serve`, `http-server`,
`tail -f`, and `watch `. The table lives in `classify.ts` as an exported `const`
array so a test can enumerate it and a reviewer can read it in one screen.

**Starting.** `supervisor.start({ command, cwd, toolCallId })` assigns a short
id (`s1`, `s2`, ...; short because the model has to quote it back), pipes both
streams through `sanitizeChunk` into a `log-ring.ts` ring of
`PROC_LIMITS.serviceTailRows` (200) rows, and emits `{type:'started'}`. The
spawn options are:

```ts
spawn(command, {
  shell: true, cwd, env: process.env, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  // P1-1. NOT `false`. On POSIX this makes the child a process-group leader, so
  // `process.kill(-pid, sig)` reaches the whole tree; with `detached: false` the
  // child shares THIS process's group and there is no group to signal, which is
  // why today's `killTree` (bash-tool.ts:27) only ever kills the shell and lets
  // every `npm run dev` grandchild survive. On Windows the flag is irrelevant to
  // reaping - `taskkill /t` walks the parent-child table - so it is off there to
  // avoid detaching a console.
  detached: process.platform !== 'win32',
});
```

`detached: true` on POSIX does **not** mean "survives us": the child is still
reaped by `stopAll` and by the exit reaper (§3.6), and `child.unref()` is
deliberately **not** called. It buys the process group and nothing else.

**When the registry is full (P2-8).** `PROC_LIMITS.maxServices` (16) counts
*records*, and eviction only ever removes ones in a terminal state
(`exited|failed|stopped`). When all 16 are live, `start()` does **not** evict and
does **not** silently foreground: it returns an error result naming the oldest
live ids and telling the model to `bash_kill` one first. Evicting a live record
would orphan a running server that nothing can any longer name or stop.

**Readiness.** `ReadinessWatcher` races two detectors and stops at the first:

- *URL detector* (pure, testable). Prose first, because v1 wrote a pattern that
  is not one (P2-1): `[::1]` inside a regex is a character class matching `:` or
  `1`, and the dots were unescaped. The detector accepts an `http`/`https` URL
  whose **host is a loopback or wildcard literal** - `localhost`, `127.0.0.1`,
  `0.0.0.0`, `[::1]`, `::1` - with an optional port and path. As a single
  anchored source of truth in `readiness.ts`:

  ```ts
  export const READY_URL_RE =
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::(\d{1,5}))?(\/\S*)?/i;
  ```

  plus a small phrase table for servers that print a bare port
  (`listening on port N`, `Server running at`, `started server on`, `Local:`).
  `0.0.0.0`, `::1` and `[::1]` are normalised to `127.0.0.1` so the URL is one a
  human can click.

  **A matched URL is a candidate, not a verdict (P2-2).** Two guards, because a
  loopback URL in a banner or a `--help` blurb is printed *before* anything
  binds, and a bare regex would call that service ready in the first 40 ms:
  1. only rows emitted **after** spawn are scanned (the ring starts empty, so
     this is free), and
  2. when the match yields a port, readiness is confirmed by **one TCP connect**
     to it before the status flips. A refused connect leaves the service
     `starting` and the row is not re-considered. When the match yields no port
     the URL is accepted as-is - there is nothing to probe, and a hostname-only
     loopback URL in a banner is rare enough to trade against the complexity.
- *Port probe*: only when `extractPortHint(command)` found a port (`--port N`,
  `-p N`, `PORT=N`, `:N` in the command text). A **pre-flight probe runs once
  before spawning**: if the port already answers, the probe detector is disabled
  for this service and the card is annotated `port N was already in use before
  start` - otherwise an unrelated process on 3000 makes every launch instantly
  and falsely "ready". After spawn, probe every `PROC_LIMITS.probeIntervalMs`
  (500 ms) with a 1 s socket timeout until `PROC_LIMITS.readyTimeoutMs`. Every
  timer and socket is `unref()`d: readiness detection must never be the reason
  the CLI does not exit.

On success: status `ready`, `url`, `port`, `detectedBy: 'url' | 'probe'`, event
`{type:'ready'}`. On `readyTimeoutMs` with the process still alive: status
`running` — an honest third state for `tsc --watch` and friends, which never
listen on anything. On early exit: status `exited` with the code and the tail.

**Returning to the model.** The tool resolves when the *first* of these happens:
ready, exit, or `cfg.bash.startupSettleMs` (4000 ms). Never later. The result:

```
$ npm run dev
[background] service s1 started (pid 24188)
[ready] http://localhost:3000  (detected from output after 1.4s)
[log tail]
  > my-app@0.1.0 dev
  > next dev
    - Local:  http://localhost:3000
    ready - started server on 0.0.0.0:3000
Read more with bash_output({ service: "s1" }); stop it with bash_kill({ service: "s1" }).
```

and, for the failure the user actually cares about:

```
$ uvicorn main:app --port 8000
[background] service s2 started (pid 9012)
[exited] code 1 after 0.4s
[log tail]
  ModuleNotFoundError: No module named 'fastapi'
```

The failing case returns in 400 ms with the error in the tool result. That is G1:
"started the project" now has a visible outcome in both directions.

**Two companion tools**, registered only when `cfg.bash.background` is on and
**supplied through a factory option** (`procTools`, §5.1 / P0-2):

- `bash_output({ service, since? })` - the tail (or everything after a cursor),
  plus current status/url/exit code. This is how the model verifies the app works
  after it has requested a page.
- `bash_kill({ service })` - stop one service, or `"all"`.

**Headless resolution (P1-8).** `aragon exec` and `aragon -p` build their tools
from the same factory, so without a rule `aragon -p "npm run dev"` would
background a server, return in `startupSettleMs`, and reap it at process exit -
with no card, no `/bg`, no event, and nothing in the result saying so. The rule
is: **`autoBackground` resolves to `false` when there is no interactive view.**
An explicit `background: true` is still honoured (the model asked for it, and
`bash_output` / `bash_kill` are registered), but the result text then carries one
extra line, `[note] this service will be stopped when the run ends`, because in
headless mode there is no user who can keep it alive. `background === false` and
the foreground path are byte-identical to today either way. The signal is the
same one `planTools` already uses to decide that no overlay can be rendered, so
this costs one boolean on `BuiltinToolsOptions`, not a new capability probe.

### 3.6 The interrupt ladder (W4)

**`Esc` — the agent's task.** `ui/App.tsx:1840`'s `key.escape` branch gains one
rung ahead of the existing one. The overlay branch above it is untouched and
still returns first.

```
running && !escArmed  -> controller.abort(); abortMark; escArmed := true (4s);
                         toast 'Run aborted. Esc again to force-stop.'
running &&  escArmed  -> controller.forceStop();
                         dispatch({ type: 'runEnd' });      // local, unconditional
                         toast 'warn', 'Force-stopped.'
idle                  -> unchanged (cancel auto-continue)
```

`escArmed` is cleared by `runEnd`/`agent_end` as well as by its own timer, so a
healthy run that ended between the two presses cannot be force-stopped
retroactively.

`AgentController.forceStop()`:

1. `this.abort()` (everything it does today, unchanged).
2. `this.procs.killForeground('force')` - hard-kills every tracked foreground
   `bash` child. This is what actually unblocks a wedged `await tool.execute`.
   **The foreground registry is NOT gated on `cfg.bash.background` (P1-6).** v1
   constructed `ProcSupervisor` only when the background feature was on, which
   would have made rung two a no-op for every user who switched it off - while G2
   and G3 are advertised as unconditional and G6 promises an off-build that
   differs from today *only* by the W2 hardening. The supervisor is therefore
   always constructed; `cfg.bash.background` gates the **service** half of it
   (the `background` param, `procTools`, the prompt block, the chip), never the
   foreground half. With the flag off the registry holds foreground children,
   nothing else, and allocates no timers.
3. `this.runGeneration += 1` - see below.
4. **Does not touch background services.** `Esc` interrupts the *agent*;
   `Ctrl+C` stops the *services*. This asymmetry is the user's own two sentences
   and it is the kind of thing a later reader will "fix" by making `forceStop`
   kill everything, so it is stated as invariant I-4 below.

**The run generation, and why the local `runEnd` is not enough on its own
(P0-1 / P1-7).** v1 dispatched `runEnd` at the App layer and stopped there. That
makes the *view* idle while the *engine* is still unwinding, and this package has
two mechanisms that read those as the same thing:

- `submitMessage` (`ui/App.tsx:1499`) branches on the **view's** `status`. With
  the view idle and `Agent.running` still `true`, the next message reaches
  `Agent.prompt()` (`core/engine/agent.ts:220-222`), which **throws
  synchronously**. `AgentController.prompt` returns that promise unwrapped
  (`agent/controller.ts:906`), `App` calls it as `void controller.prompt(...)`,
  and `logging/install.ts:227` turns the unhandled rejection into `handleFatal`,
  which **exits the process**. "Esc, Esc, then type" would kill the CLI.
- The engine keeps emitting. `turn_start`, `tool_call_start`, `turn_end` and
  `agent_end` all still arrive, and `runStart`/`turnStart` set `status:
  'running'` again - so the view bounces back out of the `idle` that AC-27
  checked one frame earlier, appending entries to a transcript the user believes
  is finished.

Three changes close both, and all three are required:

1. **`AgentController.runGeneration: number`**, incremented by `forceStop()`.
   `App` captures it when it subscribes to a run and **drops every engine event
   whose generation is stale**. This is the same shape as the `abortRequested`
   guard the controller already keeps for the fast reviewer
   (`agent/controller.ts:325`), for the same reason: the loop legitimately emits
   after an abort lands.
2. **`AgentController.prompt()` becomes total.** It is documented as "never
   rejects" and is called as `void`; that has to be true rather than nearly
   true. It now: (a) if the engine is still running, `abort()`s and awaits
   `agent.waitForIdle()` bounded by `PROC_LIMITS.killGraceMs + abortGraceMs`;
   (b) wraps the engine call so no rejection escapes, surfacing failure through
   the existing `notify('error', ...)` channel instead. A message that cannot be
   started must produce a visible sentence, never a crash and never silence.
3. The unconditional `dispatch({ type: 'runEnd' })` stays. It is the
   belt-and-braces: even if the engine is blocked somewhere W2 cannot reach, the
   view returns to `idle`, the composer is usable, and the transcript's live
   tails are released (the reducer already clears them on every path to `idle`).

**`Ctrl+C` — the services.** `ui/App.tsx:1712` gains a first rung:

```
live services > 0 -> controller.stopAllServices(); toast 'Stopped N service(s).'
                     (does NOT arm exit)
otherwise         -> unchanged arm / exit
```

**Exit reaping (G5) - rewritten, because v1's mechanisms cannot do it
(P1-2).** Three separate problems with the original sentence:

- `setSignalTerminator` is a **single-slot global** (`logging/install.ts:60,97`),
  already claimed by `cli.tsx:774` for screen restore - and only on the
  alt-screen branch, so an inline session has no terminator at all. Registering
  from `proc/` would *replace* the restore, which `cli.tsx`'s own comment names
  as the bug that leaves the user staring at a blank alternate screen.
- That terminator calls `process.exit()` **synchronously**, and
  `process.on('exit')` permits only synchronous work. An async `stopAll` with a
  3 s `SIGTERM -> SIGKILL` escalation cannot run in either.
- `killTree` **spawns** `taskkill`. `spawn` is asynchronous; a process that is
  already exiting will not live long enough for it.

So:

1. `logging/install.ts` gains `addSignalHook(fn: () => void)` - an append-only
   list, run in registration order **before** whatever `signalTerminator` does.
   `setSignalTerminator` keeps its exact current single-slot meaning and
   `cli.tsx` keeps owning it; nothing about the screen path changes. The hook
   list also runs from `handleFatal`, so a crash reaps too.
2. `ProcSupervisor.reapSync()` is the **only** thing those hooks and
   `process.on('exit')` call. It is synchronous end to end: `taskkill /pid <p>
   /t /f` via **`spawnSync`** with a 2 s timeout on Windows,
   `process.kill(-pid, 'SIGKILL')` (then `process.kill(pid, 'SIGKILL')` as a
   fallback) on POSIX. No escalation ladder, no promises, no logging - a reaper
   that can block or throw is worse than one that misses a child.
3. `doExit` (`ui/App.tsx:1406`) calls `controller.stopAllServices({ force:
   true })`, and `force: true` means **`reapSync()` semantics**: immediate
   `SIGKILL`, no `stopGraceMs`. `doExit` awaits nothing today and this must not
   change it. The graceful `SIGTERM -> SIGKILL` ladder belongs to `Ctrl+C`,
   `bash_kill` and `/bg stop`, where there is a live event loop to run it on.
4. `reapSync()` is idempotent and safe to call twice - it will be, since
   `doExit` and the `exit` hook both fire on a normal quit.

### 3.7 Core hardening (W2)

`ToolExecutorOptions` gains `abortGraceMs?: number` (default 5000). Step 5 of
`ToolExecutor.execute` becomes a race:

```ts
const abandoned = new Promise<typeof ABANDON>((res) => {
  const onAbort = () => { const t = setTimeout(() => res(ABANDON), this.abortGraceMs); t.unref?.(); };
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener('abort', onAbort, { once: true });
});
const outcome = await Promise.race([
  tool.execute(toolCallId, validatedParams, context).then((r) => r, (e) => e),
  abandoned,
]);
```

The race must be **cleaned up in a `finally`**, not left to `{ once: true }`
(P2-3). `agent-loop.ts:158 raceCompaction` is the in-repo precedent and does
exactly this: it clears its timer and removes its listener whichever branch wins.
Without it the grace timer still fires ~5 s after a tool that won the race
settled - harmless today only because it is `unref()`d, which is a property of
the timer rather than of the design.

On `ABANDON`: return
`errorResult('Tool "x" did not stop within 5000ms of abort; abandoned.')`, and
attach a no-op `.catch()` to the orphan so a later rejection is not an
`unhandledRejection`. The orphan's eventual result is discarded.

**`ToolExecutionContext` also gains `abortCause?: 'timeout' | 'external'`
(P1-5).** The executor already distinguishes the two - `TIMEOUT_REASON` is its
own private symbol (`executor.ts:48`) and `controller.signal.reason` carries it -
but a tool cannot read it, because the symbol is not exported and must not be.
Publishing the *cause* rather than the symbol keeps Core's export surface frozen
(`public-api.test.ts` asserts exactly 86 runtime exports) while letting `bash`
write the honest footer §3.4 rule 4 requires. It is set on the context object at
abort time, before the tool's own listener runs; a tool that ignores it behaves
as it does today.

This adds no export, imports no `node:*` module (global `setTimeout` only, as
`llm/retry.ts` already requires), and therefore breaks neither
`public-api.test.ts` nor `no-host-coupling.test.ts` - `abortGraceMs` and
`abortCause` are both fields on existing interfaces, not new exported names.

### 3.8 UI surfaces

- **`ServiceCard`** (`ui/entries/ServiceCard.tsx`), a new `Entry` kind rendered
  by `Transcript.tsx`. Collapsed it is two rows; `Ctrl+O` expands the tail like
  every other card.

```
  * service s1  npm run dev                                 ready . 1.4s
    http://localhost:3000                       ctrl+c stop . ctrl+o log
```

  Status -> glyph/colour: `starting` `toolPending`/muted, `ready` `toolDone`
  glyph and colour, `running` `toolRunning`, `exited(code!=0)`/`failed`
  `toolError`, `stopped`/`exited(0)` muted. **No animated spinner, in any
  state.** That is *stricter* than `single-spinner-while-running` D-1, which
  suppresses animation only while the activity line is mounted, and the extra
  strictness is deliberate (D-14 / P2-7): a service can sit at `starting` while
  the agent is **idle**, and D-1's "one owner" argument does not reach that case
  because there is no owner on screen. A card that animated only when the agent
  happened to be idle would be the worst of both. The card uses
  `glyphs.spinnerStill` throughout and still accepts `reducedMotion` for
  consistency with `EntryView`'s comparator.
- **`Ctrl+O` needs an implementation site, and §4 must name it (P1-3).**
  `ui/App.tsx:1830` picks its target from a **closed list**
  (`e.kind === 'tool' || 'team' || 'compaction'`). `'service'` joins it. Omitting
  this is not a missing feature but an actively wrong one, and that exact failure
  is written into the code at that line in capitals: the card draws its own
  `ctrl+o log` hint, the keystroke silently expands **an older tool card**, and
  nothing errors. The `Nothing to expand.` toast copy already covers the empty
  case unchanged.
- **Status bar chip** `svc 2` after the todo chip, degrading to `[2]` below
  `PROC_LIMITS.statusCompactCols` (92). Counts `starting|ready|running`. This
  follows `todoActive`'s degrade-don't-hide ladder rather than
  `compactionActive`'s hide-below-threshold one, because a running server is
  state the user must be able to see on a narrow terminal.
- **Composer hint (P1-4).** v1 replaced the running row's `ctrl+c*2 exit` clause
  with `ctrl+c stop 2`, which deletes the only visible way to quit at exactly the
  moment `Ctrl+C` stops meaning "quit" - and `Composer.tsx`'s own header says
  that branch is never abbreviated because it is "the only place that names the
  abort key". Both rows keep an exit affordance, and the running row now also
  names Esc's second rung. The four literal forms:

  | state | hint row |
  |---|---|
  | running, no services | `enter steer . esc abort . ctrl+c*2 exit` (unchanged) |
  | running, N services | `enter steer . esc abort*2 force . ctrl+c stop N . ctrl+c*2 exit` |
  | idle, no services | unchanged (full or faded) |
  | idle, N services | the current row plus a leading `ctrl+c stop N` |

  Neither new clause is ever faded, for the rule the file already states: they
  are the only visible way to stop something. On a terminal too narrow for the
  running row the composer's existing `wrap="truncate"` applies; the clauses are
  ordered most-urgent-first so truncation drops `ctrl+c*2 exit` last-resort
  rather than the abort key. `hintText` takes an **options object** rather than a
  sixth positional parameter - five is this repo's documented ceiling (P2-11).
- **`/bg`** - `list` (default) | `logs <id> [n]` | `stop <id|all>` | `status`.

### 3.9 Sequence — the reported scenario, after this change

```
model  bash({command:'npm run dev'})            (no `background` given)
tool   looksLongRunning -> true, autoBackground -> background
supv   pre-probe :3000 -> refused (good, port free)
supv   spawn -> s1 pid 24188 -> emit started ------> App: ServiceCard 'starting'
ring   '> next dev' , '- Local: http://localhost:3000'
watch  URL detector hits -> emit ready ----------> App: card 'ready' + URL
tool   resolves at 1.4s with the block in 3.5
model  bash({command:'curl -s http://localhost:3000'})   (foreground, 40ms)
model  "the app is up at http://localhost:3000"
user   Ctrl+C -> stopAllServices -> SIGTERM tree -> card 'stopped'
```

### 3.10 Transcript integration - the five closed switches (P0-3 / P0-4)

Adding an `Entry` kind is not one edit in `reducer.ts`. This package routes
entries through **five closed switches and one prefix scan**, every one of which
has a `default` branch that swallows an unknown kind without erroring. v1's §4
named one of them and filed a second under the wrong module. The full list, with
what each silently does to a `service` entry that is not added to it:

| Site | `default` today | What a missing clause does |
|---|---|---|
| `ui/Transcript.tsx::EntryViewImpl` | `return null` | The card never draws. Loud enough to catch. |
| `ui/layout/virtual-window.ts::entryRevision` | `return 'x'` | The height-cache key is **constant**, so the card freezes at its first measured height *and* its first rendered subtree, for the session. Silent. |
| `ui/layout/virtual-window.ts::estimateEntryRows` | `separation + 1` | A multi-row card is windowed as one row, so it is mis-clamped or never mounted - and an unmounted entry is never measured, so the estimate never self-corrects. Silent. |
| `ui/transcript-text.ts::renderEntry` | `return []` | Service cards vanish from the exit snapshot (`cli.tsx:723`) - the user's only record after the alternate screen is torn down. Silent. |
| `session/persist.ts::normalizeLoadedEntries` | falls through | A resumed card claims a process that died with the last session. Covered in v1 (§6). |

`entryRevision` lives in **`ui/layout/virtual-window.ts:72`**, not in
`agent/reducer.ts` where v1 filed it. Its own I-L3-1 comment states the
consequence of a missing clause in capitals, and `virtual-window.test.ts`
hand-enumerates kinds, so nothing turns red. The `service` term is:

```ts
case 'service':
  return `v${entry.status}.${entry.rowsSeen}.${entry.url ? 1 : 0}.${entry.exitCode ?? -1}`;
```

**`rowsSeen`, never `rows.length` (P0-3).** The tail is a **fixed-size ring**: it
evicts its oldest row while appending a new one, so the joined length is
unchanged while the content is not. That is verbatim the non-append mutation the
`tool` branch's `liveSeq` comment was written for, and a length term would go on
matching while the card changed underneath it.

**The settled boundary (P0-4).** `Transcript.tsx::computeSettledCount` is a
prefix scan that `break`s at the first non-settled entry, and the component holds
the result **monotonic**. Every existing live clause - `assistant.streaming`, a
running `tool`, an active `team`, a live `todo`/`fast`/`compaction`, a counting
`retry` - is bounded by **an operation**: a dispatch, a turn, one LLM call, one
countdown. Each carries a comment saying that an entry which never settles is
"re-rendered on every frame for the rest of the session".

A service is bounded by **the user's intent**. A dev server left up for an hour
is the normal case. Treating it like the other five would pin the boundary at the
card and re-render the entire transcript from there on every frame, forever, on
long sessions, with nothing reporting it. The rule is therefore **D-11**:

- **`starting` blocks the boundary.** It is bounded by `readyTimeoutMs` (60 s
  default, clamped to 600 s), which is the same shape as every other clause.
- **`ready` / `running` do NOT block it.** The card reaches `<Static>` with its
  body committed: command, id, status at commit time, URL, and the tail rows it
  had. `<Static>` cannot un-print, so that text is final by construction.
- **A terminal transition re-emits.** When a service later `exited` or was
  `stopped`, the supervisor emits `serviceEnd` and the reducer appends a **new**
  one-row terminal entry (`service s1 stopped after 12m`) rather than trying to
  rewrite a printed card. This is honest - it is a second event, at a second
  time - and it is the only thing `<Static>` permits.
- The **live** view of a service is the status chip, `/bg`, and `bash_output`.
  Those three are where "what is running right now" belongs; the transcript is a
  log of what happened.

Full-screen mode has no `<Static>` and `computeSettledCount` is not called there
(the file says so), so this costs nothing on that path.

### 3.11 Invariants

- **I-1** `bash` never leaves its promise pending. Every exit path goes through
  `settle`, and `settle` is reachable from `error`, `close`, `exit+drain`,
  `abort+grace` and `timeout+grace`.
- **I-2** With `cfg.bash.background === false`: no `background` property in the
  tool schema, no `bash_output`/`bash_kill` registered, no prompt block spliced,
  no status chip, no readiness timer, no service ever spawned, and
  `buildSystemPrompt` output byte-identical to today for a fixed tool array.
  **The interrupt ladder is NOT part of this (P1-6):** `Esc`/`Esc`, the
  foreground registry and `forceStop()` are unconditional, because G2 and G3 are
  unconditional. The flag governs *services*, never *interruptibility*.
- **I-3** No timer or socket owned by `proc/` may keep the event loop alive.
  Everything is `unref()`d; only the child processes themselves hold the loop,
  and they are reaped on exit.
- **I-4** `forceStop()` kills foreground children only. `stopAllServices()` kills
  background services only. Neither ever does the other's job.
- **I-5** A `ProcEvent` listener that throws is caught and logged at `debug`,
  never propagated — it runs inside `child.stdout.on('data')`, and a render bug
  must not kill a ten-minute build. (Same rule, same reason, as `emitToolOutput`
  in `agent/controller.ts:1345`.)
- **I-6** Service ids are per-session and monotonic (`s1`, `s2`, ...). An id is
  never reused after the service exits, so a stale `bash_kill({service:'s1'})`
  can only ever be a no-op, never a kill of something else.
- **I-7** The view never reports `idle` while it will still act on engine events
  from the run it just force-stopped, and it never hands a message to an engine
  that is still running. `runGeneration` is what makes the first true and
  `prompt()`'s totality is what makes the second true; either one alone leaves
  the crash in P0-1 reachable.
- **I-8** `AgentController.prompt()` never rejects. It is called as `void` from
  `App`, and `logging/install.ts` turns an unhandled rejection into a process
  exit - so "never rejects" has to be a property of the method, not a comment
  above it.
- **I-9** Anything reachable from a signal handler, `process.on('exit')` or
  `handleFatal` is **synchronous**. `reapSync()` is the only entry point those
  three use, and it neither awaits, spawns asynchronously, nor throws.

---

## 4. File / module change plan

### New files

| File | Intent |
|---|---|
| `packages/cli/src/proc/limits.ts` | `PROC_LIMITS` — every structural bound in one place (tail rows, registry cap, drain/kill/probe/ready timers, `statusCompactCols`). |
| `packages/cli/src/proc/types.ts` | `ServiceStatus`, `ServiceRecord`, `ServiceSnapshot`, `ProcEvent`, `ProcEventListener`, `ProcSupervisorPort`, `ServiceStartRequest`. |
| `packages/cli/src/proc/classify.ts` | Pure `looksLongRunning(command)`, the exported `LONG_RUNNING_PATTERNS` table, `hasTopLevelChain(command)`, `extractPortHint(command)`. |
| `packages/cli/src/proc/readiness.ts` | Pure `detectReadyUrl(rows)` + `normalizeHost(url)`; `probePort(port, host, timeoutMs)`; the `ReadinessWatcher` class. |
| `packages/cli/src/proc/log-ring.ts` | Bounded sanitised per-service tail, cursor-addressable so `bash_output({since})` can page. **Deliberately not `tools/tool-output-store.ts` (P2-4)**, which is the closest existing thing: that store is 8 rows keyed by tool-call id, cleared at `tool_execution_end`, with no cursor. A service needs 200 rows, a lifetime longer than the tool call that started it, and paging. It reuses `sanitizeChunk` and follows the same "two bounds are two different literals" rule. |
| `packages/cli/src/proc/supervisor.ts` | `ProcSupervisor`: spawn, registry (foreground + service), `killForeground`, `stop(id)`, `stopAll`, `snapshot()`, event fan-out, exit reaper. |
| `packages/cli/src/proc/kill-tree.ts` | `killTree(pid, signal)` and `killTreeSync(pid)`, hoisted out of `bash-tool.ts` so one owner serves both kinds of child. **The POSIX branch is a process-group kill** (`process.kill(-pid, sig)`), not `child.kill()` (P1-1); the sync variant uses `spawnSync` on Windows so it is usable from an exit hook (P1-2). Both report liveness via `process.kill(pid, 0)` so R-2's honest "may have left a detached child" is an observation rather than a guess (P2-6). |
| `packages/cli/src/proc/prompt.ts` | `buildBackgroundServicesBlock()` + `BACKGROUND_SERVICES_BLOCK_VERSION`. |
| `packages/cli/src/tools/proc-tools.ts` | `makeBashOutput(deps)`, `makeBashKill(deps)`. |
| `packages/cli/src/ui/entries/ServiceCard.tsx` | The transcript card: status row, URL row, expandable tail. |

### Modified files

Rows marked **[new in v2]** were absent from v1; each is a site whose omission
fails silently or turns an existing test red (see `## 评审记录`).

| File | Intent |
|---|---|
| `packages/cli/src/tools/bash-tool.ts` | W1 rewrite (`settle` funnel, `stdio` stdin ignore, exit+drain, abort/timeout grace **carrying the captured output and the `abortCause` footer**) and the `background` branch that delegates to the supervisor. |
| `packages/cli/src/tools/fs-tools.ts` | `ToolDeps` gains optional `procs?: ProcSupervisorPort` (the two-interface rule: it must be added here *and* forwarded in `tools/index.ts`, or the tools silently never see it). |
| `packages/cli/src/tools/index.ts` | `BuiltinToolsOptions.procs?` + `procTools?: AgentTool[]` + `interactive?: boolean`; conditional spread into `deps`; append `procTools` **through the factory** beside `todoTools`/`teamTools`, before the permission filter and the wrappers. **[new in v2]** `HOST_TOOL_NAMES` gains `bash_output` and `bash_kill`; `SKILL_TOOL_FLOOR` gains `bash_output`; `PLAN_MODE_BLOCKED_TOOLS` gains `bash_kill`. All three are forced by tests, see the row below and §5.1. |
| `packages/cli/src/__tests__/tools.test.ts` | **[new in v2 / P0-2]** `C7` builds the expected list by calling the factory, so its invocation must pass `procTools: ['bash_output','bash_kill'].map(stub)` or `HOST_TOOL_NAMES` and the produced array disagree. `I-P6` asserts floor and blocked-set **partition** `HOST_TOOL_NAMES` with zero overlap, so both names must be classified. Neither failure is about background services and neither message would say so. |
| `packages/cli/src/agent/controller.ts` | Construct `ProcSupervisor` **unconditionally** (P1-6 - `cfg.bash.background` gates only its service half); pass `procs`/`procTools`/`interactive` to `createBuiltinTools`; add `subscribeProc`, `getServiceSnapshot`, `stopAllServices`, `stopService`, `forceStop`, `runGeneration`; make `prompt()` total (I-8) and have it wait out a still-running engine (P0-1); splice the prompt block in `rebuildSystemPrompt`; track foreground children for `forceStop`. |
| `packages/cli/src/agent/reducer.ts` | `Entry` kind `'service'`; actions `serviceStart` / `serviceUpdate` / `serviceEnd` (the last appends a **new terminal entry** rather than rewriting a printed card, D-11); clear tails on every path to `idle` (already the rule - extend the existing clauses). **The `entryRevision` term is NOT here** - see the `virtual-window.ts` row. |
| `packages/cli/src/ui/layout/virtual-window.ts` | **[new in v2 / P0-3]** `entryRevision` gains a `'service'` case keyed on `status` + **`rowsSeen`** (a monotonic cursor, never `rows.length` - the ring evicts while appending, which is exactly the non-append mutation I-L3-1 forbids leaving out); `estimateEntryRows` gains one. Both `default` branches swallow an unknown kind silently, and `virtual-window.test.ts` hand-enumerates kinds, so neither omission turns anything red. |
| `packages/cli/src/ui/transcript-text.ts` | **[new in v2 / P0-3]** `renderEntry` gains a `'service'` case. Its `default: return []` means a missing clause drops service cards from the exit snapshot printed on quit (`cli.tsx:723`) - the user's only record once the alternate screen is gone. |
| `packages/cli/src/agent/system-prompt.ts` | `SystemPromptParams.backgroundBlock?`, spliced conditionally beside `teamBlock`/`todoBlock`. |
| `packages/cli/src/ui/App.tsx` | Subscribe to `ProcEvent`; the `Esc` second rung + `escArmed` ref; the `Ctrl+C` first rung; `doExit` reaping via `reapSync` semantics; pass service counts to `StatusBar`/`Composer`. **[new in v2]** add `'service'` to the `Ctrl+O` target `find` at `:1830` (P1-3), and drop engine events whose `runGeneration` is stale (P1-7). |
| `packages/cli/src/ui/Transcript.tsx` | Render `kind: 'service'`; extend the memo comparator; add **only** the `status === 'starting'` clause to `computeSettledCount` (D-11 / P0-4) - `ready` and `running` must NOT block the boundary. |
| `packages/cli/src/ui/StatusBar.tsx` | The `svc N` chip and its width ladder (degrade, do not hide). |
| `packages/cli/src/ui/Composer.tsx` | `services?: number`; the four hint forms in §3.8; `hintText` moves to an options object (already at five parameters). |
| `packages/cli/src/logging/install.ts` | **[new in v2 / P1-2]** `addSignalHook(fn)` - an append-only list run before the existing single-slot `signalTerminator`, and also from `handleFatal`. `setSignalTerminator` keeps its exact current meaning; `cli.tsx:774` keeps owning the screen restore. Registering a second terminator instead would replace it. |
| `packages/cli/src/commands/builtins.ts` | The `/bg` command. |
| `packages/cli/src/config/schema.ts` | `BashConfig`, `DEFAULT_BASH_CONFIG`, `clampBashConfig`, `PersistedConfig.bash`, `DEFAULT_CONFIG.bash`. Scalars only, one level deep. |
| `packages/cli/src/config/store.ts` | The two hand-written section merges (the read merge and the patch merge) gain a `bash:` line each. Omitting either is the documented `/todo panel off` failure. |
| `packages/cli/src/config/env.ts` | `ARAGON_BASH_BACKGROUND` / `ARAGON_BASH_AUTO_BACKGROUND` as **one** accumulated section assigned once (the `ARAGON_TODO` shape at `env.ts:250-273`, not two `if` blocks each assigning `partial.bash`). |
| `packages/cli/src/session/persist.ts` | `stripServiceTail` beside `stripLiveToolOutput`; a `normalizeLoadedEntries` clause turning any non-terminal restored service into `stopped`. |
| `packages/cli/src/__tests__/glyphs.test.ts` | Add `proc` to `inScope`'s directory regex - same commit as the tree. |
| `packages/core/src/tools/executor.ts` | W2: `abortGraceMs`, the abort race with a `finally` cleanup, and `ToolExecutionContext.abortCause`. |
| `packages/core/src/tools/types.ts` | **[new in v2 / P1-5]** `ToolExecutionContext.abortCause?: 'timeout' \| 'external'`. A field on an existing interface, so the frozen 86-export surface is untouched. |
| `packages/cli/README.md` | Background services: the tool params, `/bg`, the two keys, and the "services die with the CLI" sentence R-10 relies on. |

---

## 5. Interface design

### 5.1 Tool schemas

```jsonc
// bash — one new optional property; everything else unchanged.
{
  "command": "string",
  "timeout": "number?",       // ms, shrinks within the ceiling (unchanged)
  "cwd":     "string?",       // unchanged
  "background": "boolean?"    // NEW. true = supervise and return immediately.
                              // false = never background. omitted = auto-detect.
}

// bash_output — read a supervised service's log tail and status.
{ "service": "string", "since": "number?" }   // `since` = cursor from a prior call

// bash_kill — stop one service, or every service.
{ "service": "string" }                       // an id, or "all"
```

`bash`'s description gains exactly two sentences (they are model-facing policy,
so their wording is versioned with the prompt block): *"Set `background: true`
for anything that does not exit on its own — dev servers, watchers,
`docker compose up`. Never use `Start-Process`, `&`, `nohup` or `screen` to
detach a command yourself; the runtime supervises background commands, and a
self-detached process cannot be reported on or stopped."*

**Registration is not a local decision (P0-2).** Two tests in
`__tests__/tools.test.ts` make the tool list a closed system, and both fail with
a message that says nothing about background services:

- **C7** asserts `HOST_TOOL_NAMES` equals **what `createBuiltinTools` actually
  produces**. So the two tools must arrive through a **factory option** -
  `procTools?: AgentTool[]`, the shape `todoTools` and `teamTools` already use,
  each of whose comments says in capitals that appending anywhere else turns C7
  red - and C7's own invocation must be extended to pass them.
- **I-P6** asserts `SKILL_TOOL_FLOOR` and `PLAN_MODE_BLOCKED_TOOLS`
  **partition** `HOST_TOOL_NAMES`: zero overlap, nothing left out. So each name
  must be classified, consciously:

| Tool | Classification | Why |
|---|---|---|
| `bash_output` | `SKILL_TOOL_FLOOR` | It reads a buffer. It cannot write to disk or run a shell, which is the floor's stated membership test, and blocking it in plan mode would let the agent start a service it then cannot read - the dead end the floor exists to prevent. |
| `bash_kill` | `PLAN_MODE_BLOCKED_TOOLS` | It terminates a process. That is a mutation of the world, it is the complement's stated membership test ("the ones that change something"), and `Ctrl+C` and `/bg stop` both remain available to the *user* in plan mode, so nothing is dead-ended. |

`HOST_TOOL_NAMES` is the **superset** of what this host can register - it answers
"can a skill's `allowed-tools` declaration ever take effect?", not "is it
registered right now" - so both names belong in it even though
`cfg.bash.background: false` registers neither. That is the same relationship
`skills doctor` already has with `--no-skills`.

**Confirmation (P2-5).** Neither joins `MUTATING_TOOLS`. `bash_output` is a read.
`bash_kill` stops something *this session started and is showing on screen*, and
the plan gate already refuses it in plan mode; adding a `--confirm` prompt would
put a modal between the user and stopping their own runaway server. `bash`
itself stays in `MUTATING_TOOLS` unchanged, including when `background: true` -
the command is still arbitrary.

### 5.2 `<background_services>` prompt block

Spliced only when `cfg.bash.background`. English, ASCII, about 20 lines,
carrying: the `background: true` rule; the ban on manual detaching; that a
background launch returns a service id; that verification means `bash_output`
**and** an actual request against the URL; that services must be stopped with
`bash_kill` when finished unless the user asked for them to stay up; and that
`[note] the command exited but a background child is still holding its output
stream` means "re-run it with `background: true`". Constant
`BACKGROUND_SERVICES_BLOCK_VERSION = 'v1'`.

### 5.3 Slash command

```
/bg                     list services: id, status, uptime, url, command
/bg logs <id> [n]       last n rows (default 40, capped at the ring size)
/bg stop <id|all>       stop and report
/bg status              one-line summary (same data as the status chip)
```

### 5.4 Config and environment

```ts
export interface BashConfig {
  background: boolean;      // default true   — register the tools + honour the param
  autoBackground: boolean;  // default true   — the classifier fires when unset
  startupSettleMs: number;  // default 4000   — clamp [500, 30_000]
  readyTimeoutMs: number;   // default 60_000 — clamp [5_000, 600_000]
}
```

`ARAGON_BASH_BACKGROUND=0` and `ARAGON_BASH_AUTO_BACKGROUND=0` map onto the two
booleans. Clamped, never rejected — a garbage value resolves to the default and
throws nothing, the discipline every other key in `config/schema.ts` follows.

### 5.5 Keys

| Key | Precondition | Effect |
|---|---|---|
| `Esc` | overlay open | close it (unchanged, still first) |
| `Esc` | running, not armed | abort; arm for 4 s; toast names the second press |
| `Esc` | running, armed | `forceStop()`; view forced to `idle`; `runGeneration` bumped so the unwinding engine can no longer move the view (P1-7). **Unconditional on `bash.background` (P1-6).** |
| `Esc` | idle | unchanged |
| *(any)* | after a force-stop | the composer accepts input and the next submit starts a new run - `prompt()` waits out a still-running engine rather than throwing into `void` (P0-1 / I-8). |
| `Ctrl+C` | live services | stop them all; do **not** arm exit. The hint row still names an exit clause, so quitting stays discoverable (P1-4). |
| `Ctrl+C` | no services | unchanged arm / exit |
| `Ctrl+O` | last expandable entry | now also expands a service card - which requires adding `'service'` to the closed `find` at `ui/App.tsx:1830`, or the card's own `ctrl+o log` hint lies and an older tool card expands instead (P1-3). |

---

## 6. Data model

Nothing goes to disk. Two in-memory shapes and one event union.

```ts
export type ServiceStatus =
  | 'starting'   // spawned, not yet ready, still alive
  | 'ready'      // a URL was printed, or the hinted port answered
  | 'running'    // alive past readyTimeoutMs with nothing to detect (watchers)
  | 'exited'     // the process ended on its own
  | 'failed'     // spawn itself failed
  | 'stopped';   // we killed it (Ctrl+C, bash_kill, exit)

export interface ServiceRecord {
  id: string;                 // 's1', 's2', ...
  toolCallId: string;         // the bash call that started it
  command: string;
  cwd: string;
  pid: number | undefined;
  status: ServiceStatus;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  url?: string;
  port?: number;
  detectedBy?: 'url' | 'probe';
  portPreoccupied?: boolean;  // the pre-flight probe already answered
  rows: readonly string[];    // bounded ring, sanitised
  rowsSeen: number;           // monotonic cursor for `bash_output({since})`
  truncated: boolean;
}

export type ProcEvent =
  | { type: 'started'; service: ServiceSnapshot }
  | { type: 'output';  service: ServiceSnapshot }   // coalesced, see below
  | { type: 'ready';   service: ServiceSnapshot }
  | { type: 'exited';  service: ServiceSnapshot }
  | { type: 'stopped'; service: ServiceSnapshot };
```

`ServiceSnapshot` is a frozen, JSON-serialisable projection of `ServiceRecord`
carrying only the last `PROC_LIMITS.cardTailRows` (8) rows. Listeners get
snapshots, never the record, so a render-side bug cannot mutate supervisor state.
`output` events are coalesced at `PROC_LIMITS.outputCoalesceMs` (100 ms) inside
the supervisor — a webpack build emitting thousands of lines a second must not
become thousands of React renders. (`agent/coalesce.ts` already exists for view
actions and is the model for this, but the coalescing happens at the source here
because the same event is also consumed by `/bg` and by `bash_output`.)

`PROC_LIMITS`:

```ts
export const PROC_LIMITS = {
  serviceTailRows: 200,      // ring per service
  cardTailRows: 8,           // rows a snapshot/card carries
  maxServices: 16,           // records; only TERMINAL ones are evicted (P2-8).
                             // All 16 live -> start() errors and names them.
  drainMs: 250,              // after 'exit' with pipes still open
  killGraceMs: 2000,         // after abort/kill before force-settling
  probeIntervalMs: 500,
  probeSocketTimeoutMs: 1000,
  outputCoalesceMs: 100,
  stopGraceMs: 3000,         // SIGTERM -> SIGKILL escalation
  statusCompactCols: 92,
} as const;
```

**The transcript entry, and the one field the render layer needs (P0-3).** The
`Entry` variant carries `id`, `serviceId`, `command`, `status`, `url?`, `port?`,
`exitCode`, `startedAt`, `readyAt?`, `endedAt?`, the capped `rows`, and
**`rowsSeen: number`** - the monotonic cursor. `rowsSeen` exists for
`entryRevision` (§3.10), not for display: the ring evicts its oldest row while
appending a new one, so `rows.length` can be identical across two different
tails and a length-based revision term would go on matching while the card
changed underneath it. This is the same trap, and the same fix, as the `tool`
branch's `liveSeq`.

Session persistence: a `service` entry is written like any other, then
`stripServiceTail` removes `rows`/`tailSeq` on save (the process died with the
session; a resumed multi-row card describing a dead server is a lie), and
`normalizeLoadedEntries` rewrites any restored `starting|ready|running` to
`stopped`. This is exactly the clause shape `team`'s `aborted` and `todo`'s
`interrupted` already carry, and it exists for the same reason.

---

## 7. Testing and acceptance criteria

### 7.1 Unit — pure modules (no processes)

`proc/classify.test.ts`
- **AC-1** every entry of `LONG_RUNNING_PATTERNS` matches its canonical command.
- **AC-2** `npm run build`, `npm test`, `git status`, `ls`, `python script.py` do
  **not** match.
- **AC-3** `npm run dev && npm test` does not match (top-level chain).
- **AC-4** `extractPortHint` finds `--port 8000`, `-p 3000`, `PORT=5173 vite`,
  `php -S 127.0.0.1:8080`; returns `undefined` for `-p` with a non-number.

`proc/readiness.test.ts`
- **AC-5** `detectReadyUrl` recognises Next (`- Local: http://localhost:3000`),
  Vite (`Local:   http://localhost:5173/`), Uvicorn
  (`Uvicorn running on http://127.0.0.1:8000`), Flask, `php -S`, and a bare
  `Listening on port 4000` (returns a port, no URL).
- **AC-6** `0.0.0.0` and `[::1]` normalise to `127.0.0.1`.
- **AC-7** (restated, P2-2) A **loopback** URL printed before anything binds
  does not produce readiness. `see https://example.com/docs` - v1's case - is a
  vacuous assertion: `example.com` never matched the host alternation to begin
  with, so it passed without exercising the detector. The real false positive is
  a banner or `--help` blurb containing `http://localhost:3000`, and the case is:
  that row plus a refused connect on 3000 leaves the service `starting`; the
  same row plus an accepted connect flips it to `ready`. A URL with no port at
  all is accepted without a probe, and the test says so, so the trade is
  recorded rather than assumed.

`proc/log-ring.test.ts`
- **AC-8** the ring never exceeds `serviceTailRows`; `since` paging returns each
  row exactly once and reports `truncated` when the cursor fell off the ring.

### 7.2 Unit — supervisor and tool (real child processes, via `process.execPath`)

`__tests__/bash-settle.test.ts` — the regression suite for §3.1. Every case
asserts the promise settles **within a bounded time**, which is the property that
is missing today.
- **AC-9** a command that exits normally returns the byte-identical body to the
  pre-change build (`$ cmd\n<out>\n[exit code 0]`).
- **AC-10** a command whose child holds the stdout pipe open after the parent
  exits (a `node -e` script that spawns a detached sleeper inheriting stdio)
  settles within `drainMs + 1s` and its body carries the `[note]` line. **This
  case fails on `main` and is the reproduction of the reported screenshot.**
- **AC-11** a command that reads stdin (`node -e "process.stdin.on('data',...)"`)
  settles rather than blocking, because stdin is `ignore`.
- **AC-12** (revised, P1-5) abort mid-run settles within `killGraceMs + 1s`,
  the child is gone (`process.kill(pid, 0)` throws), **and the body contains the
  output the command printed before the abort** followed by an `[aborted]`
  footer. A bare `Command aborted.` fails this: today's build returns the
  captured output via `'close'`, so dropping it is a regression on the path the
  executor's own 180 s ceiling takes.
- **AC-13** the `timeout` param still produces the existing timeout message, and
  a ceiling abort (`abortCause: 'timeout'`) produces a footer naming the elapsed
  ceiling and `background: true` - so the model can tell "the user stopped me"
  from "this command does not terminate", which is the whole point of W3.

`__tests__/proc-supervisor.test.ts`
- **AC-14** a service that prints a URL reaches `ready` with `detectedBy: 'url'`.
- **AC-15** a service that only listens reaches `ready` with
  `detectedBy: 'probe'` (spawn a tiny `node -e` http server on an ephemeral port
  passed via `--port`).
- **AC-16** a pre-occupied port disables the probe detector and sets
  `portPreoccupied`.
- **AC-17** a service that exits immediately with code 1 emits `exited` and the
  tool result carries the tail.
- **AC-18** `stopAll` terminates every child; `SIGTERM` first, `SIGKILL` after
  `stopGraceMs`; `process.kill(pid, 0)` throws for all of them afterwards.
- **AC-19** after `stopAll` the Node event loop is empty enough for the test
  process to exit unaided (the `unref` guarantee, I-3).
- **AC-20** a listener that throws does not stop the output stream (I-5).

### 7.3 Core

`packages/core/src/__tests__/executor-abort.test.ts`
- **AC-21** a tool whose promise never settles returns an abandoned error result
  within `abortGraceMs` of the signal firing.
- **AC-22** a well-behaved tool that settles during the grace returns its own
  result, not the abandoned one.
- **AC-23** `public-api.test.ts` and `no-host-coupling.test.ts` still pass.

### 7.4 View and keys (`ink-testing-library`)

`__tests__/service-card.test.tsx`
- **AC-24** `starting` / `ready` / `exited(1)` / `stopped` each render their
  documented glyph, colour and rows; the ready card shows the URL.
- **AC-25** no braille frame appears on a service card while a run is in flight
  (the one-spinner rule).

`__tests__/interrupt-ladder.test.tsx`
- **AC-26** one `Esc` while running calls `controller.abort` once and toasts the
  second-press hint.
- **AC-27** a second `Esc` within the window calls `forceStop` and the rendered
  status bar reads `idle` afterwards **even when the controller emits no
  `agent_end`** (the wedged-engine simulation).
- **AC-28** a second `Esc` *after* the run ended normally does not call
  `forceStop`.
- **AC-29** `Ctrl+C` with two live services calls `stopAllServices` and does not
  arm exit; a subsequent `Ctrl+C ×2` exits.
- **AC-30** `Ctrl+C` with no services behaves exactly as today.

### 7.5 Config and prompt

- **AC-31** `clampBashConfig` clamps out-of-range and garbage values to the
  defaults and never throws.
- **AC-32** `/bg stop all` then `/bg` reports an empty list.
- **AC-33** with `bash.background: false`, `buildSystemPrompt` output is
  byte-identical to the pre-feature build for a fixed tool array, the `bash`
  schema has no `background` property, and `bash_output`/`bash_kill` are absent
  (I-2).
- **AC-34** `glyphs.test.ts` scans `proc/` (assert `inScope('proc/limits.ts')`).

### 7.6 Regressions the review found (AC-35 .. AC-45)

Every criterion here corresponds to a P0 or P1 in `## 评审记录`. They are grouped
separately because each one **fails on a v1 implementation** and none of them is
covered by AC-1..AC-34.

`__tests__/interrupt-ladder.test.tsx` (extended)
- **AC-35** (P0-1) After a force-stop, submitting a new message starts a new run
  and **does not reject**: the test asserts no `unhandledRejection` fires and the
  transcript gains the user entry. A v1 build crashes the process here, because
  `Agent.prompt()` throws while `Agent.running` is still true and
  `logging/install.ts` routes that to `handleFatal`.
- **AC-36** (P1-7) Engine events emitted **after** a force-stop - a
  `turn_start`, then an `agent_end` - leave the view at `idle` and append no
  entries. The stale `runGeneration` is what drops them.
- **AC-44** (P1-6) The whole of `interrupt-ladder.test.tsx` is parameterised over
  `bash.background: true | false` and passes identically. A v1 build fails the
  `false` half at rung two, because `forceStop` has no supervisor to call.

`__tests__/tools.test.ts` (extended)
- **AC-37** (P0-2) `C7` still passes: `HOST_TOOL_NAMES` equals what the factory
  produces when `procTools` is supplied.
- **AC-38** (P0-2) `I-P6` still passes: `SKILL_TOOL_FLOOR` and
  `PLAN_MODE_BLOCKED_TOOLS` partition `HOST_TOOL_NAMES` with `bash_output` in the
  floor and `bash_kill` in the blocked set. Plus: in plan mode `bash_output`
  executes and `bash_kill` is refused.

`__tests__/virtual-window.test.ts` + `transcript-render.test.tsx` (extended)
- **AC-39** (P0-3) `entryRevision` changes when a service card's `status`
  changes **and** when a row is appended to a full ring (same `rows.length`, new
  content); `estimateEntryRows` returns more than `separation + 1` for a
  multi-row service card; `renderTranscriptText` emits a non-empty line for a
  service entry. Each assertion fails on a v1 implementation, and none of the
  three failures is otherwise visible.
- **AC-40** (P0-4) With a service at `ready` and 50 entries appended after it,
  `computeSettledCount` advances **past** the card. With a service at
  `starting`, it stops **at** it. This is the assertion that keeps a dev server
  left up for an hour from re-rendering the whole transcript every frame.

`__tests__/proc-supervisor.test.ts` (extended)
- **AC-41** (P1-1) On POSIX, a service whose command spawns a grandchild
  (`sh -c 'node child.js & wait'`) is fully reaped by `stopAll`:
  `process.kill(grandchildPid, 0)` throws afterwards. The test is skipped on
  `win32`, where AC-18 already covers `taskkill /t`.
- **AC-42** (P1-2) `reapSync()` is synchronous and total: called with three live
  services it returns having killed all three, and calling it twice does not
  throw. Plus a unit test that `addSignalHook` does **not** displace an existing
  `signalTerminator`.

`__tests__/bash-settle.test.ts` (extended)
- **AC-12** (revised, P1-5) Abort mid-run settles within `killGraceMs + 1s`, the
  child is gone, **and the body contains the output captured before the abort**
  plus an `[aborted]` footer. With `abortCause: 'timeout'` the footer names the
  elapsed ceiling and mentions `background: true`.

`__tests__/composer.test.tsx` (extended)
- **AC-43** (P1-4) The running hint row with two services contains `esc abort`,
  `ctrl+c stop 2` **and** an exit clause; the running hint with zero services is
  byte-identical to today's.

`__tests__/exec-*.test.ts` (extended)
- **AC-45** (P1-8) In headless mode `looksLongRunning('npm run dev')` is still
  true but the launch is **foreground**, and an explicit `background: true`
  returns a result whose text contains the "stopped when the run ends" note.

### 7.7 Manual acceptance (the requirement, verbatim)

1. Ask the agent to start a Next.js dev server. Within about 5 s a service card
   shows `ready` and a clickable `http://localhost:3000`; the run continues; the
   status bar never sticks at `running`.
2. Break the app so the server exits on boot. The card shows `exited code 1` with
   the stack, and the agent reads it and fixes it without a three-minute stall.
3. While a long tool call runs, press `Esc` twice: the view is `idle` within a
   second and the composer accepts input. **Then type a message and press Enter**
   - it must start a new run. (Added in v2: this is the step that catches P0-1,
   and it is the one an implementer is most likely to skip, because the screen
   looks correct right up until the keystroke.)
4. Press `Ctrl+C` with a dev server up: the server dies (verify with
   `netstat`/`lsof`), the card reads `stopped`, and the app does not exit.
5. Quit with `Ctrl+C` twice; no orphan node/python process remains **and the
   terminal is left on the normal screen** (the alt-screen restore must survive
   the new signal hook - P1-2).
6. **[new in v2]** Start a dev server, then keep working for ~30 more messages.
   The transcript stays responsive and the earlier entries stop re-rendering
   (P0-4). On a slow terminal a v1 build is visibly, progressively laggier.
7. **[new in v2]** Run the same flow in **inline** mode (not full-screen) and
   quit with `Ctrl+C` twice: services are still reaped. Inline has no
   `signalTerminator` at all, so this is a different code path from step 5.

---

## 8. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Auto-background misfires** and a build returns before finishing, so the model reads a half-empty log as success. | The classifier is a closed allowlist over leading tokens and script names, refuses chained commands, and is enumerated by AC-1/AC-2/AC-3. The result text always says `[background]`, and the prompt block tells the model that a background result is provisional and must be confirmed with `bash_output`. `background: false` and `bash.autoBackground: false` both override. |
| R-2 | **Process trees, on BOTH platform families (revised, P1-1).** On Windows `taskkill /t` cannot reach a grandchild that re-parented itself (`Start-Process`). On POSIX the hole is worse and v1 did not name it: today's `killTree` signals only the shell, so every `npm run dev` node child survives. | The supervisor spawns services itself with `detached: process.platform !== 'win32'` (§3.5), so POSIX gets a process group and `process.kill(-pid, sig)` reaches the whole tree, while Windows keeps `taskkill /t`; `child.unref()` is never called, so `detached` buys the group and nothing else. The prompt block bans `Start-Process`/`&`/`nohup`. `stopAll` escalates `SIGTERM -> SIGKILL` after `stopGraceMs`, then **checks** `process.kill(pid, 0)` and reports honestly (`stopped (may have left a detached child)`) when the pid is still alive (P2-6) - an honest warning beats a silent leak. |
| R-3 | **False `ready` from a port already in use** by an unrelated process. | The one-shot pre-flight probe before spawn disables the probe detector and annotates the card. URL detection is preferred and is what `detectedBy` records. |
| R-4 | **Force-settling on abort returns before the child is dead**, so the next command hits a locked cwd or a taken port. | `killGraceMs` is 2 s, and the supervisor keeps killing after the settle (the registry outlives the tool call). `stopAll` at exit is the backstop. The trade is deliberate: a stuck UI is worse than a lingering child. |
| R-5 | **W2 abandons a slow-but-correct tool.** | `abortGraceMs` defaults to 5 s, which is 2.5× `killGraceMs`; nothing in the shipped toolset can legitimately need longer to unwind after an abort. The option exists so a host that disagrees can raise it. |
| R-6 | **Event storms** from a chatty build re-render the transcript every frame. | Source-level coalescing at `outputCoalesceMs`, the 8-row snapshot, the 200-row ring, and the existing `entryRevision` memo boundary. |
| R-7 | **The new entry kind breaks `/save` + `/resume`.** | `stripServiceTail` on write and the `normalizeLoadedEntries` clause on read, both mirroring existing precedents; covered by extending the `session-persist` tests. |
| R-8 | **A new tree escapes the ASCII scanner.** | `proc` is added to `inScope` in the same commit; AC-34 asserts it. |
| R-9 | **Two `Esc` presses become a footgun** for users who currently expect one. | Rung two only fires while the run is *still* running after rung one — i.e. only when the first press provably failed. In every healthy run the second press lands on the idle branch and does nothing. |
| R-10 | **Services leak on a hard crash.** | `process.on('exit')` plus `addSignalHook` (P1-2: an append-only list, so the screen restore that already owns the single `signalTerminator` slot is not displaced), both calling the synchronous `reapSync()`; `handleFatal` runs the same hooks. A `SIGKILL` of the CLI itself is unrecoverable by construction; `/bg` on the next launch honestly reports nothing, and the README says so. |
| R-11 | **A future `Entry` kind repeats P0-3.** Five closed switches accept an unknown kind silently. | §3.10 tabulates all five with their `default` behaviour, so the next kind is a checklist rather than an archaeology exercise. AC-39 asserts three of them for `service`; the stronger fix (exhaustive `never` checks instead of `default`) is named as follow-up in §10 rather than smuggled into this round. |
| R-12 | **The view and the engine disagree about `idle`.** Force-stop creates that divergence deliberately. | `runGeneration` (I-7) makes stale events inert and `prompt()`'s totality (I-8) makes the divergence survivable; AC-35 / AC-36 assert both. The alternative - making the view wait for the engine - is what produced the reported screenshot. |
| R-13 | **A card already printed to `<Static>` needs to change.** | D-11: only `starting` blocks the boundary, a printed card is final, and a terminal transition appends a NEW one-row entry. `<Static>` cannot un-print, so any design that rewrites a printed card is wrong whatever it claims. |

---

## 9. Decision log

- **D-1** New `proc/` tree rather than growing `tools/`. The supervisor outlives
  any single tool call and is consumed by the UI, the key handler, `/bg` and
  exit — a lifetime `tools/` does not have.
- **D-2** Three-valued `background` rather than two. `undefined` is what lets the
  classifier help a model that forgot, and `false` is what lets a user who
  disagrees with the classifier win outright.
- **D-3** Return on the *first* of ready/exit/`startupSettleMs` rather than after
  a fixed delay: a 400 ms crash is reported in 400 ms, and a slow server never
  costs more than 4 s of turn time.
- **D-4** `running` is a real status, distinct from `ready`. Watchers listen on
  nothing; calling them `ready` would be a lie and calling them `starting`
  forever would be worse.
- **D-5** `Esc` and `Ctrl+C` own different objects (agent vs services). Any design
  where one key does both makes "stop the server" and "stop the agent"
  indistinguishable at the moment the user most needs them separated.
- **D-6** The App dispatches `runEnd` locally on force-stop instead of waiting for
  the engine. The view's job is to be usable; making that conditional on the
  engine recovering is what produced the reported screenshot.
- **D-7** W2 lives in Core even though W1 makes the shipped `bash` safe. The
  invariant being protected is "an abort is always answerable", and an invariant
  that depends on every tool author remembering is not an invariant.
- **D-8** No disk log files. The ring is bounded and in-memory; a file store
  would need naming, rotation, pruning and a cleanup story for a feature whose
  entire value is on screen.

Added in v2, from the review:

- **D-9** The interrupt ladder is not gated on `bash.background` (P1-6). G2 and
  G3 are promised unconditionally, and a user who turns background services off
  has not asked for a less interruptible agent. The flag governs *services*; the
  ladder governs the *agent*.
- **D-10** The view force-stops **and** the controller reconciles (P0-1 / P1-7).
  Neither half suffices: dispatching `runEnd` alone leaves an engine the next
  keystroke collides with, and waiting for the engine alone is what produced the
  screenshot. `runGeneration` plus a total `prompt()` is the smallest pair that
  makes "the view is usable" and "the engine is consistent" both true.
- **D-11** Only `starting` blocks the settled boundary; `ready`/`running` do
  not, and a terminal transition appends a new entry (P0-4). Every other live
  clause in `computeSettledCount` is bounded by an *operation*; a service is
  bounded by the *user's intent*, and treating the two alike re-renders the
  transcript every frame for the rest of a long session. The cost is that the
  transcript records **events** about a service rather than mirroring its live
  state - which is what a transcript is. Live state lives in the chip, `/bg` and
  `bash_output`.
- **D-12** `bash_output` joins `SKILL_TOOL_FLOOR`, `bash_kill` joins
  `PLAN_MODE_BLOCKED_TOOLS` (P0-2). The partition test forces the choice to be
  conscious; reading a buffer is not a mutation, terminating a process is.
- **D-13** POSIX services spawn `detached: true` (P1-1). It is the only way to
  get a process group, and a process group is the only way to reach a
  grandchild. It does not mean "survives us": `unref()` is never called, and
  both reapers signal the group.
- **D-14** A service card never animates, in any state (P2-7). Stricter than
  `single-spinner-while-running` D-1, which suppresses animation only while the
  activity line is mounted - and a service can sit at `starting` while the agent
  is idle, where D-1's "one owner" argument does not reach. A card that animated
  only when the agent happened to be idle would be the worst of both.
- **D-15** `autoBackground` resolves to `false` without an interactive view
  (P1-8). The classifier's value is rescuing a model that forgot; headless has
  no card, no `/bg` and no user to keep a service alive, so the rescue would be
  a surprise instead. An explicit `background: true` is still honoured - that
  one the model asked for.

---

## 10. Definition of done and out of scope

**Done** when: all acceptance criteria in §7 pass, **including §7.6's AC-35 to
AC-45**, each of which fails on a v1 implementation; `npm run build` and
`npm test` are green at the workspace root **and `tsc --noEmit` is clean for both
tsconfigs** (a green build is not a typecheck in this workspace);
`docs/plans/background-service-supervision/spec.md` and the
`packages/cli/README.md` section describe the shipped behaviour; and the seven
manual steps in §7.7 have been walked on **Windows** (both `cmd.exe`, which is
what `process.env.ComSpec` resolves to by default and therefore what `bash`
actually spawns, and PowerShell as the reported environment - P2-10) and on one
POSIX shell, in **both** full-screen and inline modes.

**Out of scope this round**, listed so it is a decision rather than an omission:
`aragon exec` gaining `service.*` NDJSON events; reattaching to services across
CLI launches; a full-screen log viewer overlay; automatic restart on crash;
health-check URLs beyond a TCP connect; and any browser-opening affordance.

**Named follow-up (from the review, R-11).** The five `default` branches
catalogued in §3.10 are the reason P0-3 was possible at all. Replacing them with
exhaustive `never` checks would turn "a new `Entry` kind was not added here" from
a silent runtime defect into a compile error - across `entryRevision`,
`estimateEntryRows`, `renderEntry`, `EntryViewImpl` and `computeSettledCount`.
That is a worthwhile change and it is **not** in this round: it touches five
files this feature is already touching, for a reason unrelated to background
services, and mixing it in would make this diff impossible to review as one
thing. It should be its own commit, before the next entry kind rather than after.

---

## 评审结论 (Review Verdict)

**有条件通过 (Approved with conditions).**

The design is sound and the diagnosis is better than sound: §3.1 identifies four
independent causes where most write-ups would have found one, and each of the
four was confirmed in the source. The layering decisions (D-1, D-3, D-5, D-7) are
right, and D-7's argument in particular - that "an abort is always answerable"
cannot be an invariant which depends on every future tool author remembering - is
the kind of reasoning that should survive into the code comments verbatim.

What v1 got wrong was consistently one thing: it treated this package's *closed
lists* as if they were open. A new `Entry` kind, a new tool name, and a new
view/engine divergence each have to be registered in several places that fail
**silently** when they are not - and v1's change plan named roughly half of them.
That is also why the four P0s are worth their severity: not one of them produces
an error message. They produce a frozen card, a vanished record, a transcript
that gets slower for an hour, and - in P0-1's case - a CLI that exits when the
user types their next message, on the very screen this feature exists to rescue.

All P0 and P1 concerns are resolved in the body of this document; §3.10, §3.6,
§4, §5.1 and §7.6 carry the substantive changes. The conditions below are on
**implementation and verification**, not on further design work.

### Conditions

1. **§7.6 is not optional.** AC-35 to AC-45 each fail on a v1 implementation and
   none is covered by AC-1..AC-34. In particular AC-35 (submit after force-stop),
   AC-39 (`entryRevision` / `estimateEntryRows` / `renderEntry`) and AC-40 (the
   settled boundary) must exist and be red before the corresponding fix lands -
   they are the only mechanical evidence that the P0s are actually closed.
2. **The tool-registration changes ship in one commit** with the `tools.test.ts`
   edits (P0-2). A commit that registers `bash_output`/`bash_kill` without
   updating `HOST_TOOL_NAMES`, `SKILL_TOOL_FLOOR` and `PLAN_MODE_BLOCKED_TOOLS`
   turns two unrelated-looking tests red, and the natural next move - loosening
   the assertions - would silently disable both.
3. **`proc` joins `glyphs.test.ts::inScope` in the same commit as the tree**
   (v1's R-8, restated here because this package's own comment says it has paid
   for that edit ten times).
4. **The manual walk covers inline mode and a long session** (§7.7 steps 6 and
   7). Both new failure modes - the un-hooked signal path and the pinned settled
   boundary - are invisible in a short full-screen smoke test.
5. **Any deviation from D-11 comes back for re-review.** It is the one decision
   here that trades a user-visible behaviour (a service card stops mirroring live
   state once printed) for a performance property, and it is the decision a later
   reader is most likely to "fix" without knowing what it was protecting.
6. **W1 and W2 land as separate commits, W2 first.** They are independent by
   design (§3.2), and W2 alone is a strict improvement that can ship even if the
   rest of the round slips - which matters, because W2 is what makes `Esc` work
   against a tool nobody has written yet.

Nothing in this document is blocked on further design. Implement it.

---

## 实施过程发现的方案缺陷 (Issues Found During Implementation)

Nine places where the design as written could not be implemented literally, or
was silent about something the implementation had to decide. Each records what
the design said, what was done instead, and why. Nothing here changes a decision
in §9; IF-5 is the only one that changes behaviour the design specified, and it
restores behaviour the *pre-change* build already had.

### IF-1 — `config/load.ts` is missing from the change plan, and without it the CLI does not start

§4 lists `config/schema.ts`, `config/store.ts` and `config/env.ts` for the config
work. Those three give `PersistedConfig.bash` a shape, a clamp, two merges and
two env vars — and none of them puts a `bash` on **`CliConfig`**, which is what
`AgentController` and `bash` actually read (`config.bash.background`,
`config.bash.readyTimeoutMs`). Every section in this file is resolved across its
layers by a `resolve*Config` function in `load.ts`, and `bash` needs one too;
without it `config.bash` is `undefined` on every `CliConfig` and the controller
throws on its first line.

Added `resolveBashConfig(env, file)` beside `resolveTodoConfig`. **Three layers,
not four**, and that is a decision rather than an omission: there is deliberately
no `--no-background` flag, because both switches are already reachable from
`config.json` (a per-machine preference) and from the environment (the channel a
container entrypoint has), which is the two-part test every knob in that file is
held to. A third spelling would be a third place for the answer to differ.

### IF-2 — a required `CliConfig.bash` forces 16 test fixtures, and the failure says nothing about services

The field is required, like `todo` / `fast` / `team` / `compaction` before it, so
every fixture that builds a `CliConfig` by literal fails to compile. Fifteen of
them plus `tool-output-store.test.ts` were updated with
`bash: DEFAULT_BASH_CONFIG`.

This is the same class as P0-2 and deserves the same billing: the edit is
mechanical and unavoidable, and its failure message is about a missing property
on an object literal — nothing in it mentions background services, so an
implementer meeting it cold is one keystroke from making the field optional,
which would put `config.bash?.background` (falsy) in the constructor and ship the
feature switched off for everyone.

### IF-3 — four `App` controller stubs need the new members, and TypeScript cannot catch it

`App` subscribes to the `ProcEvent` stream on mount **unconditionally** — the
supervisor exists whether or not services are on — so a stub without
`subscribeProc` throws `controller.subscribeProc is not a function` before the
first frame. `forceStop`, `runGeneration` and `stopAllServices` are reached from
the key handler on the same terms. `app.test.tsx`, `app-follow-through.test.tsx`,
`mouse-routing.test.tsx` and `single-spinner.test.tsx` all gained them.

The controller reaches `App` through `as unknown as AgentController`, so this is
exactly the trap `app.test.tsx`'s own stub already documents for
`subscribeToolOutput` and `takeFilePatch`. The new stubs carry the same note.

### IF-4 — the byte-identity baselines need a `BASH_OFF`, next to `TEAM_OFF` and `TODO_OFF`

`skills-controller.test.ts` asserts "the seven", "the eleven" and
"byte-identical to the pre-Skills builder output"; `todo-session.test.ts::AC-30`
asserts the same for the pre-todo prompt. Background services are ON by default,
so they add two tools, a schema property, two sentences of tool description and a
prompt block to every one of those baselines.

Pinned off explicitly with `const BASH_OFF = { ...DEFAULT_BASH_CONFIG,
background: false }`, which is what `TEAM_OFF` and `TODO_OFF` already exist for
and whose own comments say the numbers must never absorb a default-on subsystem.
Doing it this way is also how I-2 gets asserted at all: those tests now *are* the
claim that a `bash.background: false` session's tool array is the pre-feature one
and its prompt is byte-identical.

### IF-5 — §3.4's "precedence order" is wrong about `'close'`, and implementing it literally loses both new footers

§3.4 lists the settlement rules "in precedence order" with `'close'` at rule 2
and abort / timeout at rules 4 and 5. Read literally that means a `'close'` that
arrives after a kill produces the ordinary `$ cmd … [signal SIGTERM]` body.

**Killing a tree usually DOES produce a prompt `'close'`.** So the ordinary body
would win the race in the common case, and the two footers this round exists to
add — `[aborted - the command was still running]` with its `background: true`
advice, and the timeout message — would only ever be seen in the rare case where
a grandchild held the pipe. AC-12 and AC-13 would fail non-deterministically, and
worse, the model would be told "the command was signalled" instead of "the
command does not terminate on its own", which is precisely the sentence that
stops it reaching for `Start-Process`.

The pre-change build already knew this: it checked `killedByTimeout` **inside**
the `'close'` handler. Implemented as a `killReason: 'timeout' | 'abort'` flag
that outranks `'close'`, plus a single `buildBody()` used by all five settle
paths — so a footer can never depend on which of them got there first. The happy
path is untouched, which is what keeps AC-9's byte-identity claim true.

### IF-6 — AC-10's reproduction does not reproduce unless the grandchild is `detached` **and** `unref`'d

§7.2 describes AC-10 as "a `node -e` script that spawns a detached sleeper
inheriting stdio". Measured on Windows / `cmd.exe`, `detached: false` does not
produce the divergence at all: the parent `node` keeps its own event loop alive
for the child it spawned, so it does not exit early either, and `exit` / `close`
fire together (3178 ms / 3179 ms). The case passes against a build with no drain
timer whatsoever — a vacuous assertion of exactly the kind P2-2 was raised about.

With `detached: true` + `child.unref()` the divergence is real and large:
`exit` at 134 ms, `close` at 3166 ms. The test uses that, and says why in a
comment — detaching is what `Start-Process`, `&` and `nohup` do, which is the
behaviour the prompt block bans and this defence exists to survive.

### IF-7 — AC-15 / AC-16 cannot pass a `--port` to `node -e`

Both need a command whose **text** carries `--port N` so `extractPortHint` can
see it. `node -e "…" --port 4321` fails outright — `bad option: --port`, exit 9 —
so the service never starts and the probe never fires; the symptom is a readiness
timeout, which reads like a supervisor bug. Both tests write a small script file
into the temp dir and invoke `node <script> --port N`, which is also the shape a
real server invocation has.

### IF-8 — `Transcript.tsx`'s memo comparator needs no change, and that is a decision

§4's `Transcript.tsx` row says "extend the memo comparator". It was not extended,
because there is nothing to extend: the comparator's first term is
`a.entry === b.entry`, and `ServiceCard` threads no new per-frame prop — it
deliberately never animates (D-14) and therefore takes no `nowSec`, which is the
one prop that made the eleventh term necessary. An added term would compare two
values that are equal on every frame, forever.

Recorded here so the omission reads as a decision rather than as the closed-list
mistake this design is otherwise about. Note the asymmetry with `nowSecFor`: if a
future change gives the card a live elapsed counter, that helper and this
comparator both need a clause, and the failure would be the silent one (a frozen
counter, AC-26's "and the seconds advance" one card over).

### IF-9 - the reducer does NOT clear service tails on the way to `idle`, and that is the point

§4's `agent/reducer.ts` row asks for "clear tails on every path to `idle`
(already the rule - extend the existing clauses)". It was not done, because doing
it would delete the card's entire content.

The existing clauses release the LIVE TOOL TAIL, which is a side channel keyed by
tool-call id and cleared at `tool_execution_end` anyway; releasing it at `idle`
bounds a buffer whose owner has already gone. A service entry's `rows` are not
that. They are the card's body, capped at `PROC_LIMITS.cardTailRows` (8) on the
way in, and by D-11 a `ready`/`running` card has already been committed to
`<Static>` - so clearing them would blank a card the terminal has printed on
every path to idle, for a service that is still running, and the transcript's
own record of the URL would go with it.

The bound the clauses exist to enforce is enforced at the source instead: the
snapshot carries 8 rows, the ring behind it 200, and `stripServiceTail` drops
both on the way to disk (§6). Recorded here so the omission reads as a decision
rather than as the closed-list mistake this design is otherwise about.

### Smaller notes

- **AC-19 is asserted more weakly than it reads.** "The Node event loop is empty
  enough for the test process to exit unaided" cannot be checked from inside
  vitest, which holds its own handles. The test asserts what is checkable — that
  `dispose()` releases every timer the supervisor owns — and the `unref()` calls
  themselves are visible at each site.
- **`ProcSupervisor` is now constructed by every `makeController` caller**,
  including one-shot subcommands like `aragon models`. It allocates nothing but a
  `Map` and a `Set` until a service starts, and `addSignalHook` adds one closure;
  there is exactly one `new AgentController` in the package outside tests, so the
  hook list cannot grow in production. `resetProcessHooksForTest()` clears it for
  tests.
- **`/bg` reads `controller.stopService(id)` for `stop all` as well**, because
  the supervisor's `stop()` already takes `'all'`. One entry point rather than
  two that could disagree about what "all" means.
