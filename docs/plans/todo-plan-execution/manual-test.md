# TODO planning — manual verification matrix

Companion to `spec.md` §8.3. **Status: NOT RUN.** Every row below is written out
but none has been executed — the matrix needs a human at three real terminals
(Windows Terminal, legacy `cmd.exe`, one POSIX terminal), and several rows are
invisible to the unit suite by construction. Record the result in the `Result`
column when you run it; do not mark a row done from a unit test.

The unit suite covers everything that can be covered without a terminal: 1152
tests across 82 files in `packages/cli`, including the 9 `todo-*` files.

## Setup

```bash
cd packages/cli
npm run build
node dist/cli.js            # or `npm link` and use `aragon`
```

A prompt that reliably produces a plan: *"Add a --verbose flag: wire it through
the flag parser, the config layer and the CLI entry point, then update the README
and the CHANGELOG."*

## The matrix

| # | Case | What to look for | Result |
|---|---|---|---|
| 1 | A 7-step task on an **80-column** terminal | Rail is 18 columns; transcript keeps 62; no row is wider than its box | |
| 2 | The same task on a **200-column** terminal | Rail is 36 columns, not 40 — the clamp binds above 180 | |
| 3 | Resize **200 → 70 → 200 mid-run** | Rail disappears under 80 columns and comes back; the transcript never re-wraps into the rail's columns; nothing crashes | |
| 4 | A **simple** request ("what does budget.ts do?") | No rail, no card, no `todo_write` call at all (R-c) | |
| 5 | `--no-todo` | `/tools` does not list `todo_write`; no rail ever; `/todo status` says "off for this session" | |
| 6 | `/todo panel off` then `on`, **without relaunching** (P1-2) | The rail goes on the NEXT FRAME, not the next launch; the counter moves to the status bar while it is off | |
| 7 | An **overlay** (`/help`) opened and closed while a list is active | Rail hidden for the overlay's duration, transcript takes the full width, rail returns on close | |
| 8 | `/save` + `/resume` mid-plan | The rail comes back with the same list; the resumed card reads `interrupted (session resumed)` | |
| 9 | `/resume` of a session saved **before this feature** (P0-2) | The current rail CLEARS rather than surviving into a conversation that no longer contains it | |
| 10 | `-p "<the 7-step prompt>"`, with and without `--quiet` | `[todo] 7 steps planned` / `[todo] 3/7 <step>` on stderr; `--quiet` silences them; stdout is unchanged | |
| 11 | Legacy **`cmd.exe`** | `[x]` / `[ ]` / `>` markers, `#`/`-` gauge, `|` separator; no mojibake anywhere in the rail | |
| 12 | A run aborted with **`Esc` at step 3** | The notice names how many items are left and points at `/todo continue`; nothing auto-continues | |
| 13 | `/clear` with a plan on screen, then `/reset` | BOTH drop the rail: `/clear` because an explicit user instruction is I-2's exception (the model still believes in the plan, and its next write brings the rail back), `/reset` because the belief itself is gone. After `/clear`, `/todo status` must also report no list | |
| 14 | `/todo clear` mid-run | Refused, with one sentence; allowed between turns | |

## The four cases the v2 review added (§14 condition 3)

These are not optional, and three of them are invisible to the entire unit suite.

| # | Case | What to look for | Result |
|---|---|---|---|
| R1 | A **`task` dispatch with five children while a 20-item list is on screen** (P1-3) | `+N more` must still be the LAST VISIBLE RAIL ROW. Its absence is indistinguishable from "the list is short", which is why this cannot be checked by eye without the roster up | |
| R2 | **`/todo panel off`, then quit and relaunch** (P0-1) | `todo_write` must STILL BE REGISTERED — observable only through `/tools`. If it is gone, the write-path config merge is missing and a display preference has silently unregistered a tool | |
| R3 | A **wheel notch over the rail** (P2-5) | The transcript scrolls; the rail does not move; nothing is routed into prompt history. This is the intended behaviour — do not "fix" it | |
| R4 | A **Chinese-language session** (P2-3) | CJK item text truncates cleanly at the rail edge on an 80-column terminal: no wrapped fragment, no row wider than its box | |

## Notes for whoever runs this

- Rows 6, 9, R2 and R3 each pin a failure that is SILENT: the feature keeps
  working in every visible way and one guarantee quietly stops holding.
- R2 needs a real relaunch, not a `/reload`.
- On `cmd.exe`, expect Ink's own truncation ellipsis (`…`) on any item too long
  for the column. That is a pre-existing property of every `wrap="truncate"` in
  this codebase, not a regression in the rail — see `spec.md` §15 IF-2.
