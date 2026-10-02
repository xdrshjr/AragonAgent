# Team live activity - manual verification

> Companion to [`spec.md`](./spec.md) section 8.2. The automated suite covers the
> sanitizer, the formatter, the ranking, the deadlock fixpoint, the retry
> predicate and every abort exclusion in isolation. What it cannot cover is a
> real terminal at a real width, a real provider returning a real 429, and a
> real user resizing a window mid-dispatch. These nine checks are the ones that
> need a human.
>
> Run everything from the repository root with a working API key. Build first
> (`npm run build -w @aragon-agent/cli`) or run through `tsx`; either is fine,
> the checks are about behaviour rather than packaging.

---

## 1. Eight children, and the panel keeps showing the live ones

```
aragon
> /team max 8
> read each of these in parallel: packages/cli/src/tools/index.ts,
  packages/cli/src/config/load.ts, packages/cli/src/agent/reducer.ts,
  packages/cli/src/ui/App.tsx, packages/cli/src/team/bus.ts,
  packages/cli/src/team/runtime.ts, packages/cli/src/logging/install.ts and
  packages/cli/src/session/persist.ts - one subagent each
```

**Expect**

- **At no point are all five visible rows settled while a child is still
  running.** Watch the whole dispatch; the shipped build fails this from roughly
  the halfway mark onward, which is the defect F-2 exists to fix.
- Rows move at most twice each: `queued` -> running -> settled. A row that
  jitters between positions on the 200 ms tick is a ranking bug, not a rendering
  one.
- `+3 more` gains ` (N running)` only while more than five children run at once.

## 2. Narrow below 100 columns mid-dispatch

Start the same fan-out and drag the terminal narrower than 100 columns while
children are working.

**Expect**

- Activity lines switch from `read: packages/cli/src/tools/index.ts` to
  `read: index.ts`, and from `bash: npm run build -w @aragon-agent/cli` to
  `bash: npm`.
- No row wraps to a second line at any width you pass through.
- Widening again restores the full paths.

## 3. Exactly 80 columns, with a child mid-prose

Resize to **exactly 80 columns** while at least one child is between tool calls
(its row says `writing: ...`) and five rows are on screen.

**Expect**

- **The elapsed column is still on screen on every row.**
- No row wraps.

> Do this at 80, not at 100. At 100 and above the pre-fix layout already fits, so
> a check run there proves nothing. If the elapsed column disappears here,
> `ROW_RESERVED_COLS` in `ui/TeamPanel.tsx` is wrong and no amount of
> `flexShrink` will hide it.

## 4. Shorter than 20 rows

Shrink the window below 20 rows mid-dispatch.

**Expect**

- The panel collapses to its single header line (`team  3 running - 5 done -
  1m02s`) and the roster disappears. Growing the window back brings it back.

## 5. A wait for a teammate that has already finished

```
aragon
> two subagents. a1: read packages/cli/src/team/bus.ts and report in one
  sentence. a2: before doing anything else, call team_wait with from "a1" and a
  120 second timeout, then read packages/cli/src/team/report.ts.
```

Arrange for `a1` to finish first (its brief is much smaller).

**Expect**

- `a2`'s wait comes back **within a second or two**, not after 120 s.
- `a2`'s summary or the report mentions that nobody could answer; the report's
  `a2` section carries a `blocked waits: 1 (no teammate could answer)` line.
- Nothing is reported as an error.

## 6. A wait for a teammate that is still QUEUED

```
aragon
> /team max 5
> five subagents, and set maxConcurrent to 3 first if it is not already.
  a1: call team_wait with from "a5" and a 60 second timeout before doing
  anything else. a5: as your FIRST action call team_send to "a1" with subject
  "starting". The other three: read any file and report.
```

**Expect**

- **`a1`'s wait is NOT refused** while `a5` sits in `queued` - the roster will
  show `a4` and `a5` queued for the first part of the dispatch.
- The wait is satisfied once `a5` starts and sends, and `a1` reports the
  message.

> This is the check that catches the natural-but-wrong `canSend`. "The child's
> phase is running" excludes `queued`, which fires on the DEFAULT configuration
> rather than on an edge case.

## 7. A cold start against an unreachable provider

Point the CLI at a base URL that refuses connections for the first couple of
seconds of a dispatch, then let it recover - e.g. start the fan-out with
`aragon --base-url http://127.0.0.1:9/v1`, or block the provider host in a
firewall rule you drop two seconds in.

**Expect**

- One affected row returns to `starting (retry)` rather than going straight to
  `[failed]`.
- Exactly one retry per child - a second failure of the same kind ends the run.
- The final report notes `retried 1x` on that child's head line.
- The whole dispatch costs roughly two extra seconds rather than one fifth of
  the result.

## 8. `Esc` mid-dispatch, with the retry in play

Start a dispatch and press `Esc` about ten seconds in, ideally while a child is
in its backoff window (immediately after a transport failure).

**Expect**

- **No child restarts.** Every abort in this system reaches the provider as an
  aborted fetch and is classified `retryable: true`, so a retry here would be a
  fresh child spawned by the user pressing stop.
- The dispatch ends **promptly** - within about two seconds, not after the full
  backoff.
- The transcript card reads as aborted and the report's first line starts
  `Team dispatch ABORTED after ...`.

## 9. Nothing from the activity column reaches the log

In a second terminal:

```
aragon logs tail --level trace
```

Run a dispatch that includes a `bash` call with a distinctive argument (for
example `bash: git log --oneline -3`).

**Expect**

- `team_agent_update` records carry `label`, `phase` and `lastTool` and nothing
  else. **No command line, no path and no prose tail appears at any level**,
  `trace` included.
- The same rule that keeps a `team_send` body out of the log keeps these out:
  `lastTool` already answers the diagnostic question the record exists for.
