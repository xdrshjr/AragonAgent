# Manual test — live tool output (agent-activity-presentation-live)

The §7.3 rows of `spec.md`, as a checklist. **Rows 1, 2, 3 and 4 are not
skippable**: they are the four modes the risks live in, and row 3 must be run
with the command written below rather than a substitute, for the reason P1-8
gives.

Build first (`npm run build` at the workspace root), then run `aragon` from this
repository so `npm test` in row 1 has something real to do.

| # | Row | Platform | Result |
|---|---|---|---|
| 1 | `npm test`, full-screen 120×40 | both | |
| 2 | The same at 80×24 inline | both | |
| 3 | An unconditional `\r` writer | both | |
| 4 | A command emitting SGR colour | both | |
| 5 | A 60-second silent command | both | |
| 6 | A 400 MB emitter | per-platform form | |
| 7 | `Ctrl+O` during and after | one | |
| 8 | `liveToolOutput: false` | one | |
| 9 | `Esc` during a run | both | |
| 10 | Rows 1–5 and 9 on the other platform | both | |

---

## 1. `npm test`, full-screen, 120×40 **(not skippable)**

Ask the agent to run `npm test` in this repository.

**Pass:** the card's tail moves as vitest reports files, the badge stays
`running` throughout, and the transcript below the card **does not jump** while
the tail rewrites. The activity row above the composer reads `Running bash`, not
a rotating word.

**Fail:** the transcript scrolls or shifts on every tail update. That is the
height cache serving a stale measurement — `liveSeq` missing from
`entryRevision`'s tool branch (D-22), which is exactly the failure that reports
nothing.

## 2. The same at 80×24, inline **(not skippable)**

Relaunch with `--no-fullscreen` in an 80×24 terminal and repeat row 1.

**Pass:** the live region stays inside its clamp — the composer and the status
row remain visible and pinned — and the settled scrollback above is **not
re-printed** as the tail updates.

**Fail:** the whole session re-prints on every frame. That is `ink.js:121`
(I-L5-1): the live region reached `stdout.rows`.

## 3. A `\r` writer that emits no newline **(not skippable)**

Ask the agent to run **exactly** this:

```
python -c "import sys,time;[(sys.stdout.write('\rdownloading [' + '#'*(i//5) + ' '*(20-i//5) + '] ' + str(i) + '%'), sys.stdout.flush(), time.sleep(0.05)) for i in range(101)]"
```

**Use this command and not `npm install` / `pip install` / `docker pull`.**
`bash` spawns with piped stdio (`bash-tool.ts:77-82`), so the child's stdout is
not a TTY — and all three of those *suppress* their progress bars in exactly that
situation. The row would pass green while emitting no `\r` at all, which is a
false pass on the one path this round exists for (P1-8). The `\r` above is
Python's, not the shell's, so the byte reaches stdout identically under `cmd.exe`
and under `/bin/sh`. It is one line on purpose: a multi-line `-c` string does not
survive `cmd.exe`. There is deliberately **no trailing newline** — the command
exits with its bar still an incomplete line, which is the state the store's carry
has to be able to draw.

**Pass:** the card shows **one** row that counts up in place, no `\r` artefacts,
no row-per-tick growth, and the transcript below it does not move. At exit the
card settles to the full result.

**Fail (a):** the card shows only `bash …  ⠹ running` with no tail for the whole
run. That is P0-1's display half — the `\r` collapse never reached the incomplete
tail, so nothing was ever emitted.
**Fail (b):** the row is garbled, or the frame's other rows move. That is a raw
`\r` reaching an Ink frame — AC-24 and AC-25 failing together.

## 4. A command emitting SGR colour **(not skippable)**

POSIX: `ls --color=always -R /usr | head -200`.
Windows: `npm test -- --reporter verbose` in this repo, or any command whose
output you know is coloured.

**Pass:** no stray colour bleeding into rows below the card, no cursor jump, no
frame corruption. The tail is plain text.

**Fail:** a colour persists past the tail into the status bar or the composer.
That is an unterminated SGR escaping the sanitiser (D-27).

## 5. A silent 60-second command

```
python -c "import time; time.sleep(60); print('done')"
```

**Pass:** the footer row reads `(running)` for about ten seconds, then switches to
`no output for 10s` and **counts up** — 11s, 12s, … — once a second. When the
command exits, the result replaces the tail.

**Fail:** the number appears once and freezes. That is `nowSec` not crossing
`EntryView`'s memo comparator (P1-3), which is the failure AC-41 exists to make
loud.

## 6. A 400 MB emitter

POSIX: `yes | head -c 400000000`
Windows: `python -c "import sys;[sys.stdout.write('x'*8192) for _ in range(50000)]"`

The POSIX form is POSIX-only as written: `shell:true` selects `cmd.exe` on
Windows, which has neither `yes` nor `head` (P2-11).

**Pass:** RSS stays flat and the UI stays interactive. The render governor
stepping up a rung is **correct**, not a failure — report which rung it reached.

Record for the PR body: peak RSS and frame interval, against the same command on
the pre-round build (DoD #9). If the governor's top rung is reached, say so.

## 7. `Ctrl+O` during and after

Press `Ctrl+O` while the card from row 1 is running, then again after it settles.

**Pass:** during — nothing happens, the tail is the same eight rows (D-26).
After — the preview expands as it always has.

## 8. The kill switch

```
aragon config set liveToolOutput false
```

Restart and repeat row 1.

**Pass:** the card is a single `running` row again, exactly as before this round.
The activity row still reads `Running bash` — that is L4, which is independent of
the key.

## 9. `Esc` during a run

Start row 1 and press `Esc` while the tail is moving.

**Pass:** the tail disappears with the run, the card does **not** keep a frozen
`no output for Ns` row, and the transcript keeps scrolling normally afterwards.

**Fail:** the card keeps its tail and a stall counter stuck at its last value.
That is AC-40 / D-35 — `abortMark` not releasing the tail — and its cost is not
one card: a stranded live card pins `Transcript`'s monotonic settled boundary and
re-renders the tail every frame for the rest of the session.

## 10. The other platform

Repeat rows 1–5 and 9 on Windows PowerShell and on one POSIX terminal, taking
row 6 in its per-platform form.
