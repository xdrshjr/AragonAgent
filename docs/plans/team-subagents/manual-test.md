# Team subagents — manual verification

> Companion to [`spec.md`](./spec.md) §8.3. The automated suite covers the
> scheduler, the bus, the report, the config layers and the components in
> isolation; what it cannot cover is a real terminal, a real provider and a real
> user pressing keys. These six checks are the ones that need a human.

Run everything from the repository root with a working API key. Build first
(`npm run build -w @aragon-agent/cli`) or run through `tsx`; either is fine, the
checks are about behaviour rather than packaging.

---

## 1. A real three-way fan-out

```
aragon
> read the tool wrappers in packages/cli/src/tools/index.ts, map the config
  resolution in packages/cli/src/config/load.ts, and list the test files under
  packages/cli/src/__tests__ - do those three in parallel
```

**Expect**

- A roster appears between the transcript and the composer while the dispatch
  runs, one row per subagent, each with a spinner, a phase (`thinking` /
  `tool: grep`) and a rising elapsed time.
- The status bar's left cluster shows `agents n/m` (or `[n]` under 100 columns —
  check both by resizing).
- Both disappear the instant the dispatch ends, leaving one `team` card in the
  transcript.
- The lead's next message describes what the team found rather than restating
  the report verbatim.
- **The dispatch outlives 210 seconds without `[Agent] idle watchdog fired`
  appearing on stderr.** This is I-3, the single most likely way to ship the
  feature broken; if the fan-out is fast, ask for something slower (a build, a
  wide search) rather than skipping the check.

`Ctrl+O` on the settled card expands the per-agent summaries; `Ctrl+O` again
collapses them.

## 2. Mid-dispatch `Esc`

Start the same fan-out and press `Esc` about ten seconds in.

**Expect**

- Every subagent stops within about two seconds; the roster disappears.
- The lead receives a report whose **first line** starts
  `Team dispatch ABORTED after ...; partial results below.`
- The lead does not present the partial work as a finished answer.
- `aragon` returns to the shell promptly on `Ctrl+C` afterwards — an orphaned
  child holding the event loop open is R-15.

## 3. `--no-team` A/B of the tool list

```
aragon --no-team
> /tools
> /team
```

**Expect**

- `/tools` lists no `task`.
- `/team` reports `Team mode: off for this session (started with --no-team)`.
- `/team on` answers
  `Team mode is off for this session (started with --no-team). Saved for next launch.`
  and `/tools` **still** lists no `task` — the tool array is immutable for the
  life of a session (D-17), and the honest sentence is the whole point.
- Relaunching plain `aragon` shows `task` again, because the flip was persisted.

Then the other direction: in a normal session, `/team off` keeps `task` in
`/tools` but makes it refuse with `Team mode is off for this session.` — the
guard, not an unregistration.

## 4. `cmd.exe` render check

Open a legacy console (`cmd.exe`, not Windows Terminal) and repeat check 1.

**Expect**

- The roster's markers are `*` and `@` rather than `◆` and `✉`, spinners are
  replaced by a static marker, and **no mojibake anywhere**.
- The settled card and the status cluster degrade the same way.

The automated scanner (`glyphs.test.ts`, scope extended to `src/team/**`) proves
no literal escaped into a component; this proves the fallback table is the one
actually being picked.

## 5. 80x24 terminal

Resize to exactly 80 columns by 24 rows and repeat check 1.

**Expect**

- The status readout is the compact `[3]`, and the context gauge and cost
  readout opposite it keep their columns (D-20).
- With the window shortened below 20 rows the roster collapses to its single
  header line rather than eating the transcript.
- Long descriptions truncate; the phase and elapsed columns never lose
  characters.
- **Scroll the mouse wheel over the transcript while a dispatch is running.**
  The transcript scrolls — prompt history does not. The panel lives inside
  `AppShell`'s measured bottom box precisely so this stays true (I-10 / R-11).

## 6. Headless

```
aragon -p "read the tool wrappers and map the config resolution in parallel"
aragon -p --quiet "same prompt"
```

**Expect**

- Without `--quiet`, stderr carries `[team] dispatch 2 subagents`, one
  `[team] a1 start "..."` per child, one `[team] a1 ok 22.1s 7 tools` per child,
  and a closing `[team] done 2/2 ok`. stdout carries only the answer.
- With `--quiet`, none of those lines appear.
- In both runs the `[usage]` footer **includes the subagents' tokens**. Compare
  against the same prompt with `--no-team`: the team run should report visibly
  more input tokens. A footer that under-reports what the team spent is R-5, the
  most misleading way this feature can fail.

---

## Logging spot-check (AC-17)

After any dispatch:

```
aragon logs tail --level debug
```

**Expect** `team_dispatch_start` and `team_dispatch_end` at `info` with
`ok` / `failed` / `aborted` counts and aggregate usage, phase transitions at
`debug`, and **no `team_send` body at any level**. Subagent briefs appear only
at `trace`, and only through the same redaction every other record passes.
