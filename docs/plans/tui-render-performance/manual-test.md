# TUI render performance — manual test plan

> Companion to `spec.md` §7.3. Ten cases; **#2, #3, #4 and #10 cannot be
> skipped** — they are the four the automated suite cannot reach, because they
> need a real terminal, a real provider and a real keyboard.
>
> Run everything from a build, not from `tsx`: `npm run build && node dist/cli.js`.
> Record the `/perf` block before and after each case that has one.

---

## 0. Baseline (do this first)

```
node dist/cli.js
/perf
```

Record the block. Every later case is read against it. On an empty session the
expected shape is `0 entries`, `0 dropped`, a small `mounted`, `rung 0`.

---

## 1. A 300-turn session scrolls smoothly

**Setup.** Resume a long saved session, or run a scripted one:
`/resume ~/long-session.json`.

**Do.** `PgUp` to the very top, then `PgDn` back to the bottom. Then the same
with the mouse wheel.

**Expect.**
- The transcript moves one page per press with no visible stall.
- The `↑N` readout in the status bar counts down to 0 and the "N new lines" hint
  disappears exactly when it reaches the bottom.
- **No content jump** as old entries scroll into view. A one-frame correction on
  an entry that has never been measured is acceptable (K-1); a *jump of the
  content you are looking at* is not, and would mean `offset` has stopped
  counting from the bottom (V-4).
- `/perf` shows `mounted` in the tens, not the hundreds, whatever the entry
  count says.

---

## 2. `cat` a 50 000-line file (CANNOT BE SKIPPED)

**Do.** Ask the model to run `cat` on a very large file, or run
`bash -c "seq 1 50000"` through the tool.

**Expect.**
- No freeze at any point, during or after.
- The tool card collapses to 8 lines with a `+N lines (Ctrl+O)` footer.
- `Ctrl+O` expands it **without stalling**, and `Ctrl+O` again collapses it.
- Typing in the composer echoes immediately throughout.
- `/perf` afterwards: `mounted` unchanged from case 1, and `last commit` well
  under 50 ms.

**This is the case R1 describes.** Before the change, the clipped card cost two
full string scans per frame for the rest of the session.

---

## 3. A 3 000-line code answer while streaming (CANNOT BE SKIPPED)

**Do.** Ask for something that produces a very long fenced code answer
("write a 3000-line python file that prints the numbers 1 to 3000"). While it
streams, type into the composer.

**Expect.**
- Characters appear in the composer as you type them. This is the requirement:
  keystrokes must not queue behind renders.
- The **`eco`** chip appears in the status bar at some point, and disappears
  within a second or so of the stream ending. If the chip never appears and the
  UI is smooth, that is a pass; if the UI is chunky and the chip is absent, the
  governor is not wired (I-L4-2).
- `Ctrl+C` is honoured on the first press (arming the "press again" toast)
  within one frame.
- `/perf` during the stream shows a rung above 0 and an interval above 33 ms.

---

## 4. The same answer in `--no-fullscreen` (CANNOT BE SKIPPED)

**Do.** `node dist/cli.js --no-fullscreen`, then repeat case 3.

**Expect.**
- **No full-screen clear and no flicker.** A repeating whole-screen wipe is the
  `ink.js:121` failure this feature exists to close (I-L5-1); if you see it,
  stop and report it.
- While the answer streams you see its **tail**, headed by
  `... N earlier lines - shown in full when this entry finishes`.
- When the answer finishes, the entry is printed **in full** into the terminal's
  normal scrollback — scroll your terminal up and confirm the first line of the
  answer is there.

---

## 5. Resize mid-stream

**Do.** Start a long answer, then drag the terminal wider and narrower.

**Expect.** One reflow per size, correct geometry afterwards, no crash, no
duplicated rows. Heights are keyed on `cols` (V-5), so the frame after a resize
renders from estimates and re-measures; a single frame of slightly wrong spacing
is expected, a persistent one is not.

---

## 6. `/theme` on a long transcript

**Do.** With a long transcript on screen, `/theme warm`, then `/theme cool`,
then `/theme light`.

**Expect.** Colours change on the next frame, everywhere, including inside
fenced code blocks' surrounding chrome. If old colours persist anywhere, the
caches are theme-poisoned (K-5) — only the parsed AST and the chalk-level
highlighted string may be cached, never a themed element.

---

## 7. `Ctrl+C` during the worst frame

**Do.** During case 2's or case 3's heaviest moment, press `Ctrl+C`.

**Expect.** The "Press Ctrl+C again to exit." toast appears within one frame; a
second press exits and the exit replay prints.

---

## 8. `--no-render-governor`

**Do.** `node dist/cli.js --no-render-governor`, repeat case 3.

**Expect.** Identical output, no `eco` chip ever, `/perf` reports
`rung 0 - interval 33ms - governor off`. It is allowed to feel heavier; it must
not feel *broken*.

Also check the ceiling path: `--max-render-interval 33` behaves the same way but
still reports the governor as on.

---

## 9. `/save` and `/resume` past `transcriptRetain`

**Do.** Run with `--transcript-retain 200` and produce more than 200 entries
(case 2 twice over will do it). Then `/perf`, then `/save /tmp/s.json`, then
`/reset`, then `/resume /tmp/s.json`, then exit.

**Expect.**
- `/perf` reports a non-zero `dropped` count.
- The exit replay's **second line** reads
  `... N earlier entries dropped by transcriptRetain - raise it or /save sooner`.
- Nothing is missing *without being counted*. This is the K-6 trade: the drop is
  real, and the only unacceptable version of it is a silent one.

---

## 10. `TERM=dumb` and a 10-row terminal (CANNOT BE SKIPPED)

**Do.** Resize the terminal to about 10 rows, then
`TERM=dumb node dist/cli.js` and ask for a long answer.

**Expect.** The inline path, no cliff, no repeated screen wipe, and the live
region visibly shorter than the window. The clamp floor is 1 row per live entry,
so on a very short terminal you may see only a line or two of live output — that
is the intended degradation, and the full text still lands in scrollback when
the entry settles.

---

## Reporting

For each case record: the `/perf` block, whether the `eco` chip appeared, and
anything that stalled for longer than about a second. A case that passes but
*felt* wrong is worth writing down — the whole point of the `eco` chip and
`/perf` is that this feature must never degrade in a way the user cannot see.
