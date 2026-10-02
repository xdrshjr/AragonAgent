# Mouse-wheel region routing — manual test matrix

> Companion to `spec.md` §8.4. Everything here needs a real terminal and a real
> mouse, which is precisely why it is not in `packages/cli/src/__tests__/`.

Build once, then run each row against the same build:

```bash
npm run build -w packages/cli
node packages/cli/dist/cli.js
```

---

## 0. Phase 0 — the premise probe (RUN THIS FIRST)

`spec.md` §11 makes this a **hard gate**, not a step: R-1 asks whether
Node/libuv surfaces SGR mouse reports from a Windows console at all, and it is
the one claim in the design that no amount of reading source settles. Everything
else in this document assumes the answer is yes.

**It cannot be run by an automated agent** — it requires physically spinning a
wheel inside an interactive TTY. Run it by hand before trusting any row below.

Save as `probe-mouse.mjs` **outside the repo** (it is deliberately not committed):

```js
import process from 'node:process';

const out = process.stdout;
const restore = () => {
  out.write('\x1b[?1006l\x1b[?1000l');
  try { process.stdin.setRawMode(false); } catch {}
};
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(0); });

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
out.write('\x1b[?1000h\x1b[?1006h');
out.write('Spin the wheel. Ctrl+C to stop.\n');

process.stdin.on('data', (chunk) => {
  if (chunk === '\u0003') { restore(); process.exit(0); }
  out.write(JSON.stringify(chunk) + '\n');
});
```

```bash
node probe-mouse.mjs
```

| Observation | Consequence |
| --- | --- |
| `"\x1b[<64;40;12M"` appears on every notch, in **all three** Windows terminals | proceed; ship no platform gate |
| appears in Windows Terminal / VS Code but **not** legacy `conhost` | proceed, and adopt §13-Q1's `win32` gate using the env-var signature the probe actually observed — write the observation into the code comment |
| appears **nowhere** on Windows | **stop and escalate.** The shipped result would be "the wheel does nothing" on the primary support platform |

Terminals to probe, in this order: Windows Terminal (PowerShell 7), legacy
`conhost` (`cmd.exe`), VS Code integrated terminal.

Record the outcome here when you run it:

| Terminal | Reports arrive? | Date | Notes |
| --- | --- | --- | --- |
| Windows Terminal (PowerShell 7) | _unrecorded_ | | |
| Legacy `conhost` (`cmd.exe`) | _unrecorded_ | | |
| VS Code integrated terminal | _unrecorded_ | | |

---

## 1. Per-terminal matrix

Repeat all seven checks in each terminal below.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Type a few words into the composer, then wheel **up** over the middle of the transcript | The transcript scrolls 3 rows per notch. **The draft is byte-identical** — this is the reported bug (I-3 / AC-1) |
| 2 | ~~Wheel **up** over the input box with an **empty** composer~~ **AMENDED — see `docs/plans/wheel-scrolls-transcript-only/manual-test.md` M-2** | ~~One prompt-history entry per notch, exactly as `↑` does (G2 / AC-2)~~ → **The transcript scrolls; no history is recalled.** The composer band was removed: the pointer is not an aimed instrument in a TUI, so this row's "expected" was the bug report |
| 3 | ~~Wheel over the input box with a **non-empty** draft~~ **AMENDED — see M-1 of the new matrix** | ~~Nothing happens, silently — the same as pressing `↑` today (D-7)~~ → **The transcript scrolls and the draft is byte-identical.** Kept here as the record of *why* a band once looked reasonable: protecting the draft by doing nothing is a weaker contract than never touching it at all |
| 4 | `Shift`+wheel over the transcript | One page per notch (AC-9's sibling; also verifies the terminal does not eat `Shift`+wheel — if it does, `PgUp`/`PgDn` still work, which is the condition §13-Q2 attaches) |
| 5 | Press `?`, then wheel over the help overlay | The overlay scrolls; the transcript behind it does **not** move when you close it (P1-3 / R-12) |
| 6 | Drag to select text **without** `Shift`, then **with** `Shift` | Without: the terminal likely refuses (this is R-3, and the §6.1 notice is what warns about it). With `Shift`: normal selection |
| 7 | Exit (`/exit`, `Ctrl+C` ×2, `kill <pid>`, and once by closing the window), then **click** in the host shell | Nothing is printed. Not `[<0;12;5M`, not anything (I-2 / AC-4) |

| Terminal | Why it is on the list | Result |
| --- | --- | --- |
| Windows Terminal (PowerShell 7) | primary dev environment; ConPTY path | |
| Legacy `conhost` (`cmd.exe`) | worst case for both mouse input and Unicode glyphs | |
| VS Code integrated terminal | xterm.js; different alternate-scroll defaults | |
| iTerm2 / Apple Terminal | SGR reference implementations | |
| GNOME Terminal (VTE) | Linux reference | |
| `tmux` with `mouse off` | should behave like the bare terminal | |
| `tmux` with `mouse on` | R-2: tmux eats the wheel; expect it to be inert. `set -g mouse off` hands it back | |
| Over SSH, Windows → Linux | escape-sequence round trip | |

---

## 2. Opt-out and fallback rungs (§4.4)

| # | Command | Expected |
| --- | --- | --- |
| 8 | `aragon --no-mouse` | The wheel is **inert** — never destructive. No `?1000h` is written; `Ctrl+C` ×2 out, then check that alternate scroll in the host terminal is however you left it, not force-enabled (AC-5 / AC-11 / P1-6) |
| 9 | `ARAGON_MOUSE=0 aragon` | Same as row 8 |
| 10 | `ARAGON_MOUSE=disable aragon` | Same as row 8 — the **positive** env list is used, so anything that is not `1/true/on/yes` is false (P1-9) |
| 11 | `aragon config set mouse false` then `aragon config get mouse` | Prints `false`. Print the file too (`aragon config path`) and confirm the key is really on disk — a missing switch case still prints the success line (AC-12 / P1-2) |
| 12 | `aragon --no-fullscreen` | Byte-for-byte today's behaviour: the terminal's own scrollback moves under the wheel, and nothing new is written to stdout (AC-6 / I-5) |
| 13 | `aragon -p "hi"`, and `echo hi \| aragon` | Headless. No screen sequences at all |

---

## 3. First-run notice (§6.1 / AC-13)

| # | Action | Expected |
| --- | --- | --- |
| 14 | Remove `mouseNoticeSeen` from `config.json`, start `aragon` | One notice in the transcript: *"Mouse wheel scrolls the transcript. Hold Shift to select text…"* |
| 15 | Exit and start again | **No notice.** Once, never again |
| 16 | Remove the key again and start with `--no-mouse` | **No notice** — advice about a mode that is not in effect is worse than silence |

---

## 4. Scroll indicator (§4.8 / AC-9)

| # | Action | Expected |
| --- | --- | --- |
| 17 | Fill the transcript past one screen, at ≥ 50 columns | A one-column rail on the right edge; the thumb sits at the **bottom** while pinned |
| 18 | Wheel up to the top | The thumb reaches the top and never leaves the rail |
| 19 | Drag the window narrower than 50 columns | The rail disappears and the content reclaims the column |
| 20 | Scroll up and down repeatedly | The viewport width **never changes** — the column is reserved whether or not there is overflow (D-9 / R-9) |

---

## 5. Degenerate geometry

| # | Action | Expected |
| --- | --- | --- |
| 21 | While wheeling, drag the window below 12 rows and back up | The "terminal too small" placeholder appears; on the way back the wheel works again and **no** history entry was recalled by the resize itself (I-9 / P1-4) |
| 22 | Open the `/` command palette, then wheel over the input box | The wheel moves the popup selection, exactly as `↑`/`↓` do |
| 23 | With the completion popup open (up to 9 extra rows), wheel just above it | Still routes to the transcript — the boundary is **measured**, not computed from `budget.ts` (D-5) |
