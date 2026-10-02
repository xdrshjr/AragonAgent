# Manual test — agent activity presentation

Twelve rows, from §7.3 of `spec.md`. **Rows 1, 2b, 4, 5, 7b and 8 are not
skippable** (DoD #5). Row 7b must be run **in full-screen at a short terminal**
and row 2b **in inline** — those are the two modes the round's P0s live in, and
neither is the mode a developer happens to be sitting in.

Run on Windows PowerShell **and** on one POSIX terminal.

Build first: `npm run build` at the workspace root, then `node packages/cli/dist/cli.js`
(or `npm link` and use `aragon`).

---

## 1. A fresh install shows no reasoning, and says a turn thought  *(not skippable)*

`aragon config set showThinking false`, `aragon config set thinkingLevel high`,
then ask something that provokes long reasoning ("plan a refactor of the diff
renderer, think it through").

**Pass:**
- No reasoning text at any point in the turn.
- One activity row above the composer for the whole run, whose word changes.
- One muted `✱ thought for Ns · ctrl+t to show` row when the answer lands.

**Watch the FIRST FRAME of the run specifically (P1-7):** the word must not
change between the first and second frame. A one-frame flicker at the start of
every turn is the failure `runStartedAt`'s render-scope assignment prevents, and
it is invisible unless you look for it.

**Fail:** reasoning text on screen; a blank gap while it thinks; no `thought`
row after a turn that clearly thought.

## 2. Full-screen — `Ctrl+T` reveals, both mid-run and after

Press `Ctrl+T` during the run, and again after it settles.

**Pass:** the body appears both times; the collapsed marker disappears; a toast
reads `Thinking shown.` Pressing again hides it and toasts `Thinking hidden.`

## 2b. Inline — the marker must NOT offer a key it cannot honour  *(not skippable)*

`aragon --no-fullscreen`. Ask the same question. Let the turn settle, then press
`Ctrl+T` twice.

**Pass:**
- The settled entry's marker reads `✱ thought for Ns` with **no** `ctrl+t` hint.
- The toast reads `Thinking shown for new output.`
- The **next** turn's thinking is visible.

**Fail:** a settled marker offering `ctrl+t to show` that does nothing when
pressed. That is the P0-2 regression — Ink's `<Static>` cannot re-print an entry
it has already printed, so in inline mode the key provably cannot reach it.

## 3. The settings row round-trips

`/settings` → **Show thinking** → `on` → save. Start a new turn.

**Pass:** thinking is visible from the first frame (no flash of the collapsed
marker first). Reopen `/settings`.

**Pass:** the row still reads `on`.

**Then:** press `Ctrl+T` to hide it again, and reopen `/settings`.

**Pass:** the row reads `off` — it reports what the transcript is actually doing,
not what was on disk at launch.

## 4. Two far-apart regions render as two hunks  *(not skippable)*

Ask for an edit that changes two regions several hundred lines apart in one
file (`edit_file` with `replace_all`, or two separate edits in one turn).

**Pass:**
- Two hunks, separated by one `@@ -a,b +c,d @@` row.
- The line numbers in the gutter match the file — check two of them against the
  real file.
- `+N -M` matches `git diff --stat` for that file.

**Fail:** one hunk spanning everything between the two changes. That is a
regression to `blockReplace`, which is what the renderer did before this round.

## 5. A new file renders as a diff, not a byte count  *(not skippable)*

Ask for a new ~200-line file.

**Pass:**
- An add-coloured diff with a `+N -0` summary — **not** `Wrote 8214 bytes to …`.
- A `+13 lines (Ctrl+O)` style footer.
- `Ctrl+O` expands it; `Ctrl+O` again collapses it.

Note that `Ctrl+O` targets the **most recent** tool card, which is pre-existing
behaviour (`README.md`) and unchanged here.

## 6. A huge overwrite still writes, promptly

Create a file above 2 MB, then ask the agent to `write_file` over it.

**Pass:** the write succeeds without a perceptible delay, and the card's summary
row says `old side not read: too-large`. Repeat with a binary file (a `.png`):
the reason reads `binary`.

**Fail:** a slow write, a failed write, or a tool error. A presentation feature
must never be able to break the operation it presents.

## 7. Resize to 40 columns mid-run

While a run is in flight, narrow the terminal to 40 columns.

**Pass:** the activity row stays exactly one row and is not truncated into
gibberish; the composer and the status bar are intact.

## 7b. The frame height does not move  *(not skippable — full-screen, ~24 rows)*

Size the terminal to about 24 rows. **Note the transcript's bottom line**, then
submit a message.

**Pass:**
- The transcript does **not** shift by a row when the run starts.
- It does **not** shift back when the run ends.
- The status bar stays on the last line throughout.

Repeat with a toast firing mid-run (press `Ctrl+T` twice while it runs).

**Pass:** the toast replaces the activity row for its TTL and the frame height
never changes.

**Fail:** any one-row jump. That is P0-1 — the extra bottom-chrome row this
design deliberately does not add, which would be taken out of the transcript
while `viewportRows()` kept reporting the old number to five consumers.

## 8. A legacy console shows no mojibake  *(not skippable)*

Run in a terminal that reports no Unicode support (`cmd.exe` on Windows, or a
`TERM` that trips the capability probe). Do a turn that thinks and edits a file.

**Pass:** no mojibake anywhere — activity row, collapsed thinking marker, diff
gutter, diff signs, footers.

## 9. A saved session reloads with its diffs

`/save` a session containing three edits, quit, restart, `/resume`.

**Pass:** all three diffs render; the thinking markers are still collapsed.

**Also:** open a session file written by a build from before this round.

**Pass:** its tool cards render through the old text preview, and nothing is
blank.

## 10. Esc during a long think

Interrupt with `Esc` while it is thinking.

**Pass:** the activity row disappears immediately; the entry settles with
`[aborted]`.

## 11. The three config channels each work on their own

Run each of these in a shell where the other two are absent, and check
`/settings` (or the first frame of a turn that thinks):

```
aragon config set showThinking true          # then launch with no flag and no env
ARAGON_SHOW_THINKING=1 aragon                # with showThinking false on disk
aragon --show-thinking                       # with both of the above off
```

**Pass:** each shows reasoning on its own. `--no-show-thinking` overrides both of
the others.

**Fail:** any one of them doing nothing. `showThinking` has to exist in
`PersistedConfig`, in `CliConfig` **and** in `load.ts`'s `pick(...)`; missing any
one of the three fails silently — the key round-trips through `config set` and
`config list` and simply never reaches the first frame.

## 12. The model's diff did not get bigger

With `--log-level debug` (or by reading the `edit_file` result in the
transcript), make a **single-region** edit and read the tool result text.

**Pass:** the text is `Applied edit to <path>:`, then `--- path` / `+++ path`,
then **one** `@@` header, then the same two-context-row diff the tool produced
before this round. Not three context rows — the UI uses 3, the model still gets
2, and that difference is on purpose.

**Pass:** `write_file`'s result text is exactly `Wrote <n> bytes to <path>`,
byte for byte.
