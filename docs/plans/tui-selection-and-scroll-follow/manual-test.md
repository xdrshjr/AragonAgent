# Manual test matrix — `tui-selection-and-scroll-follow`

> Companion to `spec.md` §8.3. The automated suite (`npm test -w packages/cli`)
> covers the pure reducers, the parser table, the differ hooks and the composer
> chip. **Everything below needs a real terminal**, because every one of these
> failures is invisible to a test that cannot size a box, cannot press a mouse
> button, and cannot tell you what your emulator did with `\x1b[?1002h`.

## How to run it

```bash
npm run build -w packages/cli
node packages/cli/dist/cli.js
```

Run every row in each of these, and record the result per terminal:

| # | Terminal | Why it is in the list |
| --- | --- | --- |
| T1 | Windows Terminal (pwsh) | ConPTY splits writes mid-sequence; the primary target |
| T2 | VS Code integrated terminal | Its own mouse handling, and where most development happens |
| T3 | iTerm2 | OSC 52 honoured by default; the reference for row 1 |
| T4 | GNOME Terminal (VTE) | `?1007` alternate scroll is on by default here |
| T5 | `cmd.exe` | The ASCII / no-Unicode fallback tier |
| T6 | one `ssh` session (any of the above → a remote host) | The only place OSC 52 is the *point* rather than a nicety |

A row that cannot be run on a given terminal (no mouse in a bare `cmd.exe`
window, say) is recorded as **n/a with the reason**, never as a pass.

## The rows

Rows marked **(not optional)** are the ones whose failure mode is *silent* — the
CLI keeps running and tells you nothing. They are the reason this file exists.

| # | Steps | Expected | Guards |
| --- | --- | --- | --- |
| 1 | Start a run that produces tool output. Drag the left button across three lines of it. Release. Paste into an editor. | The highlight tracks the pointer while you drag; the pasted text matches the highlighted cells exactly. | G1 / G2 |
| 2 | Same, over a syntax-highlighted code block. | The pasted text contains no escape codes; the highlight has no holes where the block's own colours reset. | T-6 |
| 3 | Same, over a line of CJK text (paste `选中复制测试 mixed ASCII` into a prompt first). | No half-character corruption at either end of the selection, and the copied text is what was highlighted. | I-12 / P1-5 |
| 4 | Start a long run. Begin a drag over rows the agent is *not* currently writing, and hold it while output streams in. **(not optional)** | The rows under the pointer do not move for the whole drag. The chip in the input box counts up while they stay still. | S2 `hold` — the whole reason S3 is safe |
| 5 | Scroll up mid-run with the wheel. Do not touch anything for 10 s. | The viewport returns to the newest line by itself; the chip disappears. | G5 |
| 6 | Scroll up on a **finished** transcript. Wait 60 s. **(not optional)** | Nothing moves. Ever. | G6 — the failure here is "the fix became a new complaint" |
| 7 | Scroll up mid-run, then keep scrolling one notch every 2 s for ~30 s. | It never snaps back while you are still moving. | T-21 |
| 8 | `/mouse off`. Try your terminal's own drag-select. Then spin the wheel. Then `/mouse on`. **(not optional)** | Native selection works while it is off; the wheel is **inert** — it must not recall prompt history into the draft. After `/mouse on` the wheel scrolls the transcript again and native selection stops. | I-10 / P1-1 |
| 9 | Start with `--no-mouse`. Use PgUp / PgDn and Shift+Up / Shift+Down. | The chip, the anchoring and the idle resume all still work from the keyboard. | G4–G7 are not mouse features |
| 10 | `cmd.exe`, scrolled up. | The chip renders as `v12` (ASCII), no mojibake, no crash. | I-5 |
| 11 | Begin a drag, and resize the window without releasing. | The highlight clears; releasing copies nothing. | N6 |
| 12 | Press Ctrl+C twice during a drag. Then click around in the shell you land back in. | Exits cleanly; no stray `[<0;12;5M` appears in the shell on any subsequent click. | I-1 |
| 13 | Press and hold the left button over the transcript, click into **another window**, and release the button there. Come back and wait. **(not optional)** | Within `HOLD_MAX_MS` (30 s) the transcript resumes following on its own. | I-11 / P1-3 — without this the viewport is frozen for the rest of the session, silently |
| 14 | Scroll up mid-run, then press `Ctrl+T` (or `Ctrl+O` on a tool card **above** the viewport). **(not optional)** | The rows under the cursor do not move. | P0-1 / V-4 — a height change above the reading position must not be read as new output |
| 15 | Scroll up and stay there through a long run, until the scroll horizon starts dropping entries off the front. **(not optional)** | No jump. The chip's number keeps matching the number of rows `PgDn` actually traverses. | P0-1 — a front-drop must not read as tail motion |
| 16 | Select some text mid-run, then leave everything alone for the 5 s auto-resume. | The highlight is **gone**, not stranded over whatever scrolled into its place. | I-9 / P1-4 |
| 17 | On a fresh session (`aragon`), run `/copy`, then `/perf`. **(not optional)** | No "frame fallback" warning is printed at any point, and `/perf` reports `fallbacks 0`. | I-13 / P1-6 |
| 18 | Over ssh (T6): drag-select three lines, release, then paste into an application on your **local** machine. | The local clipboard holds the selection. | §4.4.5 — the reason OSC 52 is first |
| 19 | Start with `aragon config set mouseSelect false`. Drag across the transcript. Then check the startup notice. | Dragging does nothing (the terminal's own selection may take over, depending on emulator); the one-shot notice says drag-select is off rather than advertising it. | AC-8 / the two notice texts |
| 20 | With a state file written by 0.6.2 (an existing install), upgrade and start once. | The corrected mouse notice appears once; the composer hint's fade level is unchanged, i.e. `submitCount` survived. | AC-16 / P1-8 |

## Recording results

| Row | T1 | T2 | T3 | T4 | T5 | T6 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |  |
| 9 |  |  |  |  |  |  |  |
| 10 |  |  |  |  |  |  |  |
| 11 |  |  |  |  |  |  |  |
| 12 |  |  |  |  |  |  |  |
| 13 |  |  |  |  |  |  |  |
| 14 |  |  |  |  |  |  |  |
| 15 |  |  |  |  |  |  |  |
| 16 |  |  |  |  |  |  |  |
| 17 |  |  |  |  |  |  |  |
| 18 |  |  |  |  |  |  |  |
| 19 |  |  |  |  |  |  |  |
| 20 |  |  |  |  |  |  |  |

## Known, accepted deviations

These are **not** failures; they are recorded in `spec.md` and should not be
filed as bugs when a run meets them.

* Dragging past the top or bottom edge does **not** auto-scroll and keep
  extending the selection (N1). Scroll first, then select.
* Double-click word select and triple-click line select are not implemented
  (N2 / Q-3).
* There is no right-click or middle-click paste (N3).
* Selection inside an overlay (help, settings, plan review) does nothing (N4).
* A resize clears the selection rather than re-deriving it (N6).
* Under `--no-diff-render` a drag re-renders through React rather than
  re-addressing rows, so it is slower — visibly so on a large terminal. This is
  rung 2 of the fail-safe ladder, and it is correct rather than fast.
* Under tmux without `set -g set-clipboard on`, OSC 52 is swallowed silently.
  The platform clipboard binary is attempted in the same call, and the toast
  names the mechanism rather than claiming success (R-7).
* An entry that grows *between* your reading position and the tail — a tool card
  still streaming while a later entry already exists — still moves the screen by
  its delta (P2-5). That is unchanged from before this feature; what changed is
  that it is now the only remaining case, and it is stable rather than
  intermittent.
