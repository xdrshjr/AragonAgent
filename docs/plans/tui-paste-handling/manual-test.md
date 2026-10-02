# Manual test matrix — paste handling in the composer

> Feature: `tui-paste-handling` · package `@aragon-agent/cli`
> Design: `spec.md` §9.3 · Acceptance: `spec.md` §9.4
> Status: **NOT YET EXECUTED.** Every result cell below reads `pending`. This
> file is a script, not a report, until somebody fills it in — including the
> failures.

## Why this file is not optional

The three behaviours this matrix covers have **no CI coverage at all** and cannot
get any:

- **Which tier fires** depends on whether a terminal honours `DECSET 2004`, which
  no test harness can simulate — `ink-testing-library` hands the app a
  `PassThrough`, and a `PassThrough` implements whatever we write into it.
- **Whether `?2004l` was really returned** is observable only in the shell the
  process exited back into.
- **An IME commit** (a Chinese input method putting a whole phrase on screen at
  once) is a real chunk shape from a real keyboard driver, and it is the shape
  Tier 2's secondary rule is closest to misreading.

Two rows at the bottom are variations that no unit test can reach at all, and
they are the two the design's review named as release conditions (C-3, C-2).

## The standard action

Unless a row says otherwise:

1. Start `aragon` in the terminal named by the row.
2. Type `explain this: ` into the composer (do not press Enter).
3. Paste **218 lines of a log** that contains: at least one TAB-indented line, at
   least one CJK line, at least one ANSI colour sequence (`\x1b[31m…\x1b[0m`), and
   CRLF line endings.
4. Press Enter.
5. Exit with `Ctrl+C` twice, then paste anything at your shell prompt.

## What every row asserts

| # | Assertion | Maps to |
| --- | --- | --- |
| A | Exactly **one** message is sent. Never two, never fifteen. | AC-1 |
| B | No stray `[200~` or `[201~` anywhere in the draft or the message. | I-1 / I-16 |
| C | No row of the composer is overwritten or left with stray colour. | AC-4 / G2 |
| D | The draft reads `explain this: [Pasted text #1 +218 lines]`. | AC-2 |
| E | The composer stays within `draftMaxRows` for that terminal height (3 / 6 / 10). | AC-5 |
| F | The agent's echo / the transcript entry shows the log, capped at 40 rows plus `... +N more lines`. | G7 / R-10 |
| G | After exiting, pasting at the shell prompt behaves normally. | AC-7 / I-2 |

## Matrix

| # | Terminal | Tier expected | A | B | C | D | E | F | G | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Windows Terminal + PowerShell 7, Node 22 | 1 | pending | pending | pending | pending | pending | pending | pending | |
| 2 | Windows Terminal + PowerShell 5.1, Node 20 | 1 or 2 | pending | pending | pending | pending | pending | pending | pending | Record which tier actually fired. |
| 3 | legacy `conhost` `cmd.exe`, Node 20 | 2 | pending | pending | pending | pending | pending | pending | pending | The Tier 2 population, and the reason Tier 2 exists (R-11). |
| 4 | macOS Terminal.app | 1 | pending | pending | pending | pending | pending | pending | pending | |
| 5 | iTerm2 | 1 | pending | pending | pending | pending | pending | pending | pending | |
| 6 | VS Code integrated terminal | 1 | pending | pending | pending | pending | pending | pending | pending | |
| 7 | Linux `gnome-terminal` / `xterm` | 1 | pending | pending | pending | pending | pending | pending | pending | |
| 8 | `tmux` inside any of the above | 1 | pending | pending | pending | pending | pending | pending | pending | `set -g mouse off` first, or tmux keeps the wheel. |
| 9 | ssh from Windows into Linux | 1 | pending | pending | pending | pending | pending | pending | pending | |
| 10 | `--no-fullscreen` (inline) anywhere | 2 | pending | pending | pending | pending | n/a | pending | pending | Inline never writes `?2004h` (D-6 / N5), so G is trivially true. |
| 11 | `--no-paste` anywhere | none | pending | pending | pending | n/a | n/a | pending | pending | 0.6.3 behaviour, on purpose. A / C are EXPECTED TO FAIL here — record what actually happens, it is the baseline. |
| 12 | `--no-mouse` anywhere (paste still on) | 2 | pending | pending | pending | pending | pending | pending | pending | **AC-11, and the reason it is here:** click-drag selection with the terminal's own mouse MUST still work, and `/mouse` must report off. |
| 13 | A shell that leaves DEC 2004 on, inline mode | markers consumed anyway | pending | pending | pending | pending | n/a | pending | pending | I-16. Arrange with `printf '\e[?2004h'` before launching. |

## The two variation rows (NOT optional)

### V1 — paste, then press Enter within ~50 ms (C-3 / P1-1 / I-14)

Ink drains its whole stdin buffer in one `read()`, so a paste and the Enter that
follows it inside the burst window arrive as **one** `input` string, and the
paste framing is concatenated with a raw `\r`. No unit test can produce the
timing; `paste-frames.test.ts` covers the string once it exists, not the race
that makes it.

| Assertion | Result |
| --- | --- |
| The draft holds no overwritten row. | pending |
| The message is sent **at most once**. | pending |
| Nothing of the paste is lost. | pending |

### V2 — paste an API key into Settings, save, make one request (C-2 / P0-2)

`useInput` is a broadcast, so the settings screen sees the composer's framing. An
API key is ~100 characters with no line break, which trips Tier 2's burst rule.
**This is the one failure that is completely invisible on screen**: the field is
rendered through `maskDot`, `trim()` does not remove NUL, and the value is
persisted — the user is told the settings were saved and every subsequent request
returns 401 with nothing anywhere connecting the two.

1. `/settings`, focus **API key**, paste a real ~100-character key.
2. Save.
3. Send one message that reaches the provider.

| Assertion | Result |
| --- | --- |
| The request authenticates. | pending |
| `aragon config get` / the stored file shows the key with no framing bytes. | pending |
| The same, for a pasted free-text answer in a `QuestionOverlay` prompt. | pending |
| The same, for pasted revision feedback in the plan-review overlay. | pending |

> The fourth row is not in the design's §9.3. The plan-review overlay was listed
> there as "key-driven only; inert", which stopped being true when its revision
> feedback field was added — see `spec.md` §「实施过程发现的方案缺陷」IF-1.

## Recording a result

Replace `pending` with `pass`, `fail` or `n/a`. For any `fail`, add a row to the
list below with the terminal, what happened, and whether it blocks release.

### Failures observed

_(none recorded yet — the matrix has not been run)_
