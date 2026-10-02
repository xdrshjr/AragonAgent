# Wheel scrolls the transcript only — manual test matrix

> Feature slug: `wheel-scrolls-transcript-only`
> Companion to `spec.md` §8.3. Supersedes rows 2 and 3 of
> `docs/plans/mouse-wheel-region-routing/manual-test.md`; every other row of that
> matrix still applies unchanged.

The automated suite (`packages/cli/src/__tests__/mouse-routing.test.tsx`) drives a
synthetic `MouseSource`, so it proves the ROUTING TABLE and nothing about the
terminal. What only a real terminal can tell you is whether an SGR report arrives
at all, and whether the row it carries is the row you think it is. That is what
this matrix is for.

## Setup

```bash
npm run build -w packages/cli
node packages/cli/dist/cli.js
```

Then drive a session long enough to overflow the viewport — ask for something
that streams fifty-plus lines (`explain what this repo does, in detail`) — so
there is scrollback to move. Without overflow the wheel is *correctly* inert and
every row below is vacuous.

`npm run build` once is enough; nothing here needs a rebuild between rows.

## Matrix

| # | Do | Expect |
| --- | --- | --- |
| M-1 | Type `hello` (do **not** submit), park the pointer over the input box, spin the wheel up 5 notches | Draft still reads `hello`, cursor unmoved; transcript scrolled up ~15 rows |
| M-2 | With an empty input, spin up over the input box | No history recalled; transcript scrolls |
| M-3 | Press `↑` | The last prompt appears in the composer (history still works) |
| M-4 | Type `/`, wait for the palette, spin the wheel over the popup | Selection does **not** move; transcript scrolls behind |
| M-5 | Spin down until pinned to the bottom | `↑N` indicator clears, auto-follow resumes |
| M-6 | Open `/help`, spin over the input row | The help overlay scrolls (D-3) |
| M-7 | Trigger a `confirm` / `ask_user` overlay, spin anywhere | Nothing scrolls, nothing is typed |
| M-8 | `Shift`+wheel over the input box | Transcript pages |
| M-9 | Shrink the terminal below 12 rows mid-wheel, grow it back | Placeholder, then a clean frame; no history recalled on the way back (the old I-9 hazard cannot exist any more) |
| M-10 | `aragon --no-mouse`, spin anywhere | Nothing happens; no escape bytes typed into the draft |

**M-1, M-4 and M-9 cannot be skipped.**

- **M-1 is the reported bug.** It is the whole reason this change exists, and it
  is the one row that fails loudly on a regression rather than quietly.
- **M-4 is the popup path.** The deleted `applyHistoryIntent` used to mirror the
  keyboard's popup branch, so a notch over an open `/` palette moved the
  selection. Now the palette is not wheel-scrollable at all — it is not an
  `Overlay`, so the router never sees it — and `↑` / `↓` keep owning selection
  movement. That split (wheel moves the viewport, keys move the selection) is the
  contract; this row is where you observe it.
- **M-9 is the remount hazard.** `App` returns the terminal-too-small placeholder
  before `AppShell`, so shrinking below `MIN_FULLSCREEN_ROWS` really does unmount
  and remount the composer. The nonce-replay guard that made that safe
  (`lastHistoryNonce`) is deleted along with the channel it guarded, so this row
  is checking that removing a guard did not reopen the hole it covered — it
  cannot, because there is no longer an intent to replay, but "cannot by
  construction" is worth confirming once with your hands.

## Per-terminal coverage

Run the matrix in at least Windows Terminal and one xterm-family terminal (VS
Code's integrated terminal or iTerm2). The full seven-terminal grid in
`mouse-wheel-region-routing/manual-test.md` §1 does not need re-running: this
change removes a branch from the router and touches neither the SGR parser, the
stdin filter, nor the mode-enable sequences, so per-terminal *reporting* behaviour
is unchanged by construction.

Two rows there are worth repeating anywhere you have not run them since 0.5.0,
because they are the ones users notice and they are unaffected by this change:
row 6 (`Shift`+drag to select) and row 7 (no stray `[<0;12;5M` in the host shell
after exit).

## Result log

| # | Windows Terminal | VS Code / iTerm2 | Notes |
| --- | --- | --- | --- |
| M-1 | | | |
| M-2 | | | |
| M-3 | | | |
| M-4 | | | |
| M-5 | | | |
| M-6 | | | |
| M-7 | | | |
| M-8 | | | |
| M-9 | | | |
| M-10 | | | |
