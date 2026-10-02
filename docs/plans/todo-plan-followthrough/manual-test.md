# TODO plan follow-through — manual verification

Companion to `spec.md` §8.4. Eight cases, each with the exact commands, what to
watch, and what a failure looks like.

> **Execution status: NOT YET RUN.**
> Every case below needs a live provider key, a real TTY and a model willing to
> plan, none of which the implementation node has. The automated suite covers
> the decision table, the budget machine, the arming/cancelling wiring, the
> headless loop and the strip's geometry (1246 CLI + 278 core tests green,
> `npm run typecheck` clean in both packages) — but **none of it exercises a
> real terminal or a real model**, which is exactly what these eight cases are
> for. Record results in the "Result" column and change this banner when done.

## Setup

```bash
cd packages/cli
npm run build
node dist/cli.js --version        # confirm you are running the build under test
```

Use a scratch config so a test run cannot leave `followThrough: auto` behind on
your real machine:

```bash
# POSIX
ARAGON_HOME=/tmp/aragon-followthrough node dist/cli.js
```

```powershell
# PowerShell
$env:ARAGON_HOME = "$env:TEMP\aragon-followthrough"; node dist/cli.js
```

Terminals to cover: **Windows Terminal**, **cmd.exe**, and one POSIX terminal.
Cases 1, 2, 4 and 7 are the ones whose behaviour can differ by terminal (timing
and key handling); 3, 5, 6 and 8 need only one.

---

## 1. A 5-step plan under `auto`, hands off the keyboard

```
/todo follow auto
Write a small CLI that reads a CSV, filters rows by a column value, sorts by
another, writes JSON, and has a --help. Plan it first.
```

Watch: the rail fills, the model works a step, the run ends, a notice reads
`Continuing with N remaining steps in 3s - Esc to stop.`, and about three
seconds later a new run starts on its own. Repeat to `5/5 done`.

**Pass:** the plan completes without a keystroke and the budget never binds —
you never see `auto-continue has run 25 times` or `completed none of them`.
**Fail:** a continuation fires while the previous run is still going; the notice
promises 3s and fires at a visibly different delay; the rail and the
continuation text disagree about which steps are left.

| Terminal | Result |
| --- | --- |
| Windows Terminal | |
| cmd.exe | |
| POSIX | |

---

## 2. `Esc` during the first grace window

Same as case 1, but press `Esc` once while the countdown notice is on screen.

**Pass:** a toast reads `Auto-continue cancelled.`, no new run starts, the rail
keeps the unfinished plan, and `/todo continue` still works afterwards.
**Fail:** the run starts anyway (the timer was not cleared); `Esc` also aborts
something else; the toast appears but a run starts three seconds later.

Then repeat with an overlay open (`?` for help) — the **first** `Esc` must close
the overlay and the **second** must cancel the continuation. That precedence is
deliberate (spec P2-9): reaching past the overlay would make "close this dialog"
silently mean "abandon the plan".

| Terminal | Result |
| --- | --- |
| Windows Terminal | |
| cmd.exe | |
| POSIX | |

---

## 3. Abort mid-run: no unfinished notice

Under the default (`/todo follow notify`), start a long planned task and press
`Esc` while it is running.

**Pass:** `Run aborted.` and **nothing else**. No "N todo items are unfinished".
**Fail:** the unfinished notice appears — that is the round-1 behaviour this
round removes (D-5 / AC-7), and it is the case most likely to regress if the
`endReasonRef` mutation next to `abortMark` is ever dropped.

| Result |
| --- |
| |

---

## 4. A model that stalls: exactly one nudge, then hand back

```
/todo follow auto
```

Get a plan on screen, then send something that makes the model answer without
touching `todo_write` — e.g. `Before you continue: what does the second step
actually depend on? Just answer, do not change the plan.`

**Pass:** the first fruitless continuation is followed by exactly one more
attempt, and then a warn notice `... the last 2 attempts completed none of them.
/todo continue to retry, or take over.` The rail is still there.
**Fail:** it keeps going; or the rail vanishes silently instead (that would mean
`staleTurns` fired first, and the streak rule is supposed to beat it — spec
§3.5).

| Terminal | Result |
| --- | --- |
| Windows Terminal | |
| cmd.exe | |
| POSIX | |

---

## 5. Inline mode: the strip

```bash
node dist/cli.js --no-fullscreen
```

Get a plan on screen. Then resize the terminal to 40 columns and to 79.

**Pass:** one row under the transcript reading
`todo 3/7  >  <step>` — it truncates with the terminal and **never wraps**, the
composer never moves, `+N done` disappears below 80 columns, and the counter
becomes `[3/7]` below 100. `--no-todo-panel` removes the strip entirely.
**Fail:** the row wraps (the composer jumps as text streams); the strip appears
in full-screen mode as well as the rail.

| Terminal | Result |
| --- | --- |
| Windows Terminal | |
| cmd.exe | |
| POSIX | |

---

## 6. Headless

```bash
node dist/cli.js -p --todo-follow auto "Plan and then do: create a scratch dir,
write three text files in it, then list them. Use a todo list."
echo "exit=$?"
```

**Pass:** `[todo] continuing (N steps left)` lines on stderr between runs, the
plan finishes, `exit=0`. Re-run with `--quiet` and confirm **no** `[todo]` line
appears while the continuations still happen.
**Fail:** exit code changes because a plan was unfinished (it must not — AC-27);
`--quiet` leaks a `[todo]` line.

| Result |
| --- |
| |

---

## 7. The P0-1 scenario, by hand — the ceiling holds

```
/todo follow auto
Plan this, and revise the plan as you learn: <something open-ended enough that
the model keeps re-scoping, e.g. "explore this repo and write a summary of every
subsystem">
```

Count the continuations. **Pass:** the session ends in a hand-back notice naming
`25`, and no amount of re-planning lifts it.
**Fail:** it runs past 25 — which means `advanceBudget` is clearing `used` on a
re-anchor again. This is the failure whose symptom is a bill rather than a test
failure, which is why it is on the manual list as well as in
`todo-follow-through.test.ts` AC-35.

| Terminal | Result |
| --- | --- |
| Windows Terminal | |
| cmd.exe | |
| POSIX | |

---

## 8. The P1-1 scenario, by hand — no relaunch needed

Launch with the default `notify`. Get a plan going, then **mid-session**:

```
/todo follow auto
```

Now end a run with steps outstanding.

**Pass:** the continuation arms on that very run.
**Fail:** you get the `notify` sentence instead — which means the mode is being
read from a `cfg` object captured when the subscription effect mounted, and
`/todo follow auto` is inert until relaunch. This package has shipped that exact
defect class twice (spec P1-1), which is why it has both an automated
regression (AC-36) and a manual case.

| Result |
| --- |
| |

---

## Cleanup

```bash
rm -rf /tmp/aragon-followthrough        # or %TEMP%\aragon-followthrough
```
