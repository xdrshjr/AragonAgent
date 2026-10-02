# TUI composer flicker — manual test plan

> Companion to `spec.md` §7.3. Thirteen cases. **#1, #7, #10 and #12 on all four
> terminals are the merge gate** (§7.3 / P2-6); the rest are on Windows Terminal
> only for the merge and completed on the other three before the release that
> carries this.
>
> Run everything from a build, not from `tsx`:
> `npm run build && node dist/cli.js`. Record the `/perf` `writer` line before
> and after every case that has one.

**Terminals.** Windows Terminal, **legacy `conhost.exe`**, VS Code's integrated
terminal, and the AragonMesh embedded xterm.js pane. `conhost` has no DEC 2026,
so it is the proof that F1 carries the fix on its own — F2 is inert there by
construction.

---

## 0. Baseline (do this first)

```
node dist/cli.js
/perf
```

The last line is new:

```
writer     diff  -  frames 12 (diffed 9, full 3)  -  lines/frame 1.4  -  bytes/frame 61  -  fallbacks 0
```

`fallbacks` must be **0**, and must stay 0 for the whole session unless a case
below says otherwise. With `--no-diff-render` the same line reads
`writer     full  -  diff render off`, which is how "the flag is off" is told
apart from "the writer crashed".

---

## 1. Typing during a run (CANNOT BE SKIPPED — on `conhost` this is the whole fix)

**Do.** Start a long task (`Summarise every file under src/`), then type a full
sentence into the composer while it streams. Do not stop typing.

**Expect.**
- The composer is **rock steady**. No blink, no darkening, no partial row.
- The transcript keeps streaming above it.

**Then repeat twice more:**

| Run | Command | Expect |
|---|---|---|
| a | `node dist/cli.js --no-sync-output` | Still rock steady. **This is what proves F1 carries the fix without F2.** |
| b | `node dist/cli.js --no-diff-render` | The flicker **returns**. This is the control that proves the diagnosis. |

**Run 1a on legacy `conhost.exe` first, at §11 step 4, before anything further
is built.** It is the single observation that distinguishes "F1 fixes the bug"
from "F1 makes the bug 39× rarer". If the composer is not steady there, stop and
re-open the design rather than shipping F2 as cover (§13 condition 1).

---

## 2. Typing into an empty idle session

**Do.** With no run in flight, type one character, then delete it.

**Expect.** The composer border flips colour on the first character (empty →
draft) and back on the delete, with **no flash of the whole frame**. A border
colour change repaints the three border rows, not the screen.

---

## 3. Completion popups

**Do.** Type `/`, arrow through the palette, accept with `Tab`. Then `@` and a
few characters in a large repository, so the 120 ms glob debounce lands
mid-typing.

**Expect.** The popup appears, moves and disappears without the rows below it
tearing. The `@` results arriving asynchronously repaint only the popup rows.

---

## 4. Shift+Tab with a popup open

**Do.** Open the `/` palette, then press `Shift+Tab`.

**Expect.** The mode toggles and **the draft is untouched** — the completion is
not accepted. This is the AC-P3 regression the first statement of the input
handler exists to prevent, and F3 rewrote every branch around it.

---

## 5. Multi-line editing

**Do.** `Shift+Enter` for a second line, then arrow up/down inside the buffer,
`Home`, `End`, `Ctrl+W`, `Ctrl+U`, `Ctrl+K`.

**Expect.** Every key does exactly what it did before F3. The composer grows and
shrinks by whole rows; a row-count change is a full repaint and must leave no
residue above or below the box.

---

## 6. Prompt-history recall at both edges

**Do.** From an **empty** buffer press `↑` repeatedly to the oldest entry, then
`↓` back past the newest.

**Expect.** Recall walks in both directions and returns to an empty buffer at
the bottom. Then type half a draft and press `↑`: the draft must **not** be
clobbered.

---

## 7. Continuous drag-resize during a run (CANNOT BE SKIPPED — this is P0-2)

**Do.** Start a streaming task. Grab the window edge and drag **continuously for
about five seconds**, in both directions. Include a shrink below
`MIN_FULLSCREEN_ROWS` (12 rows) and back up.

**Expect.**
- No stale rows at **any** point of the drag — not just when you let go.
- Below 12 rows the "terminal too small" placeholder appears exactly as it does
  today; growing back restores a correct frame (AC-14).
- `/perf` afterwards: `framesFull` roughly tracks the number of resize events;
  `fallbacks` still **0**.

**A single-step resize does not exercise this.** `useTerminalSize` debounces
50 ms, and Ink re-renders synchronously from its own `'resize'` handler inside
that window — a matrix run that only clicks "maximise" reports a pass on the one
defect most likely to reach users (§13 condition 3).

---

## 8. Scrolling during a run

**Do.** `PgUp` / `PgDn`, `Shift+↑` / `Shift+↓`, and the mouse wheel, while a
task streams.

**Expect.** The viewport moves; the composer and status bar do not flicker. A
page scroll changes most rows and is a legitimate large diff — that is not a
regression.

---

## 9. Ctrl+L, Ctrl+T, Ctrl+O

**Do.** Press each.

**Expect.** `Ctrl+L` still forces a visible repaint (AC-9). `Ctrl+T` and
`Ctrl+O` behave exactly as before.

---

## 10. Every overlay, open → close (CANNOT BE SKIPPED)

**Do.** Open and close help, settings, confirm, question and plan overlays in
turn.

**Expect.** The rows an overlay covered are **clean** after it closes — no
fragment of the overlay's border, title or body left behind on any row. This is
where an absolute-addressing bug leaves visible debris.

---

## 11. Esc abort, then type immediately

**Do.** Start a run, press `Esc` to abort, and start typing in the same second.

**Expect.** The abort lands, the activity line disappears, and the first
characters appear with no flicker and no lost keystrokes.

---

## 12. Exit paths (CANNOT BE SKIPPED)

**Do.** In four separate sessions: `/exit`; `Ctrl+C` twice; `kill <pid>` from
another shell; close the terminal window.

**Expect.** In every case the alternate screen is restored, the cursor is
**visible**, the shell prompt is at column 1, and `--exit-transcript` replays
the session summary unchanged (AC-10).

---

## 13. `--no-fullscreen` full session

**Do.** `node dist/cli.js --no-fullscreen` and run a task with typing.

**Expect.** Appearance **unchanged from today** in every respect. The differ is
never constructed in inline mode, and `/perf` says `diff render off`.

---

## 14. The fallback notice (AC-15)

Not reachable by hand in a healthy session — it needs a foreign write to stdout.
If you ever see:

> Frame diffing lost sync with the terminal and fell back to a full repaint.
> If the display looks wrong, restart with `--no-diff-render`.

then it must appear **exactly once**, however many further fallbacks follow, and
`/perf` must show `fallbacks` greater than 0. Record what you were doing: a
reproducible fallback is a foreign write and is worth a bug of its own.

---

## Sign-off

| # | Windows Terminal | conhost | VS Code | Embedded |
|---|---|---|---|---|
| 1 (gate) | | | | |
| 2 | | — | — | — |
| 3 | | — | — | — |
| 4 | | — | — | — |
| 5 | | — | — | — |
| 6 | | — | — | — |
| 7 (gate) | | | | |
| 8 | | — | — | — |
| 9 | | — | — | — |
| 10 (gate) | | | | |
| 11 | | — | — | — |
| 12 (gate) | | | | |
| 13 | | — | — | — |

`—` = complete before the release, not before the merge.
