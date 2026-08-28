# Changelog

All notable changes to `@aragon-agent/cli` are documented here. Entries at
`0.4.x` and earlier refer to the package by its former name, `@argon-agent/cli`
— those releases really were published under that name, so they are left as they
were written.

## Unreleased

### Added

- **The composer understands pasting.** Until now it did not have the concept at
  all: every byte the terminal delivered on stdin was a keystroke, and a
  clipboard block is thousands of bytes arriving in an unpredictable number of
  chunks. Three separate failures fell out of that one omission, and on Windows
  you hit all three at once.

  A carriage return that landed alone in a chunk **sent the half-finished
  message** — a fifteen-line paste could arrive as a dozen separate messages,
  interleaved with the agent's replies. A carriage return in the middle of a
  chunk was inserted into the draft as a literal `\r`, which the terminal obeyed
  by **overwriting the row it was drawn on**. And a paste that survived both grew
  the composer to the height of the pasted text, pushing the transcript out of a
  frame whose row accounting still believed the composer was three rows tall.

  Pasting now works the way it reads:

  - **A paste never submits.** Line breaks become buffer newlines, exactly one
    per source line break, `CRLF` and lone `CR` alike.
  - **A short paste appears verbatim.** At or below 6 lines and 400 characters it
    is inserted as-is, indentation intact, and renders exactly like typed text.
  - **A large paste collapses to a placeholder** — `[Pasted text #1 +218 lines]`
    — which occupies one line, carries its own size in its label, deletes as a
    single unit (one `Backspace`, and `Ctrl+W` / `Ctrl+U` / `Ctrl+K` cannot leave
    half of one behind), and expands back to the full text the moment you send.
    The model receives every byte; the composer never has to draw them.
  - **No pasted byte is executed as a terminal control.** `\r`, `\x1b`, NUL, DEL
    and the C1 range are stripped from the payload — never from your keystrokes,
    so `Ctrl+A` and Escape are untouched.
  - **The composer has a ceiling.** A draft of any length occupies at most 3 / 6 /
    10 rows depending on terminal height, scrolls internally to keep the caret
    visible, shows how many rows are hidden above and below, and reports its true
    height to the layout budget. Four hundred presses of `Shift+Enter` were
    already able to destroy the frame; they no longer are.
  - **A submitted message cannot make the transcript unresponsive.** A user entry
    renders at most 40 rows plus a `... +N more lines` tail. The full text is kept
    and the exit transcript is uncapped.

  On terminals that support it, detection is **exact**: aragon asks for bracketed
  paste (`DECSET 2004`) in full-screen mode and reads the markers the terminal
  wraps your paste in. Where that is unavailable — inline mode, an old Windows
  console — a heuristic on chunk shape catches the same cases, and it needs no
  cooperation from the terminal at all. Both feed one code path.

  Turn it off with `--no-paste`, `ARAGON_PASTE=0`, or
  `aragon config set paste false`; the input path is then byte-for-byte what
  0.6.2 did.

### Fixed

- **A pasted API key is stored correctly again.** Ink broadcasts each stdin chunk
  to every mounted input handler, so the settings screen, the question overlay
  and the plan-review feedback field all see what the composer sees. Without
  this, a ~100-character key pasted into Settings would have been stored wrapped
  in invisible framing bytes, masked on screen by the password dots, and would
  have failed to authenticate on every request afterwards with nothing anywhere
  explaining why.

- **`--no-mouse` still writes no mouse sequence.** Paste support installs a
  stdin filter, and `paste` defaults to on, so the filter now exists in sessions
  that disabled the mouse. Whether the mouse is on is a separate question from
  whether the stream is wrapped, and the four places that used to conflate them
  now ask the right one: `aragon --no-mouse` writes no `?1000h`, no `?1006h` and
  no `?1002h`, leaves your terminal's own click-drag selection alone, and reports
  `/mouse` as off — while pasting still works.

### Changed

- **Auto-compaction no longer reports compactions that did not happen.** A long
  unattended run used to print a red `context not compacted #2: nothing_to_drop`
  card into the transcript. The card was accurate; nobody had asked for it.
  Auto-compaction evaluates itself at every turn boundary, and a checkpoint that
  looks at the history and finds nothing worth dropping has changed nothing,
  called nothing and spent nothing — a smoke alarm announcing "no fire" twice an
  hour, in error colours, with a machine reason attached.

  A compaction now announces itself **if and only if it commits to doing work**.
  That is a position in the control flow, not a list of reason strings: everything
  decided before the first spend is silent, and everything decided after it —
  including every failure, the truncation fallback, an Esc, and a host fault — is
  as loud as it ever was. A declined `pressure` checkpoint is now
  indistinguishable from a turn on which the threshold was never crossed.

  **`/compact` and overflow recovery are unchanged.** A compaction you asked for
  is owed an answer, and a reactive compaction running after the provider has
  already refused your request is the one moment the diagnosis matters most. Both
  still report on every outcome.

  **Quiet, not unrecorded.** Every attempt is still written to the diagnostic log
  (its `compaction` line gains an `announced` field, so `announced: false` is one
  grep), still charged to the anti-loop guards, and still counted by
  `/compact status` — which now reads
  `This session: 1 compaction (2 checkpoints declined), 94.2k tokens reclaimed`
  when checkpoints declined, and is byte-identical to before when none did. If
  declines keep happening, the self-disable notice still says so out loud, once,
  naming the cause and the remedies. Card numbers are also contiguous again: `#N`
  counts compactions that ran, not checkpoints that fired.

  **Behaviour change for wrapper scripts.** A declined `pressure` compaction no
  longer emits a `{ type: 'compaction', subtype: 'start' | 'end' }` pair on the
  `--output-format json` stream, and no longer prints `[compaction] skipped:` on
  `-p` stderr. The pairs stay balanced, so only consumers counting *attempts* are
  affected; the diagnostic log reports those more accurately.

### Added

- **Context compaction, hardened — the trigger now counts the whole history, the
  recent turns can no longer wedge a run, sub-agents get the same protection, and
  a compaction is no longer irreversible.**

  **The trigger was systematically late.** It fired on the provider's reported
  usage for the PREVIOUS request, read at a checkpoint that runs AFTER the current
  turn's tool results were appended — and tool results are the largest single
  increment in this loop (100 KB per call, several per turn, ~25 k tokens each).
  A session reading 88 % could be sending 110 %. Occupancy is now the measured
  base PLUS an estimate of everything appended since that measurement, and the
  status gauge reads the same number the trigger does, on every turn — including
  the turns where a guard declines to compact, which is exactly when the number
  matters most.

  **The recent turns can no longer wedge a run.** Every previous rung of the
  ladder operated on the head of the conversation. When the RETAINED tail was what
  did not fit, each rung reported success or "nothing to drop" while the history
  stayed un-sendable and the run died. Oversized `tool_result` bodies inside the
  retained turns are now clipped, oldest first, only when the alternative is a
  request the provider cannot accept. Nothing is removed — no message, no
  tool-call id, no role — so a valid history stays valid. Every clip is announced
  in the text the model reads, at the exact place the data went, and on the card,
  in `/compact status`, on the JSON stream and in the archive.

  **Sub-agents compact their own history** (`compaction.subagents`, default
  `true`). A `task` child is bounded by 24 turns and fifteen minutes, and when one
  overflowed its entire history was discarded and the dispatch reached the lead as
  one partial sentence. Children run under tighter bounds than the lead: two
  retained turns, at most two compactions, the fast tier preferred, and failure
  forced to truncate because nobody is watching a background worker. No transcript
  card — the lead's transcript describes the lead's context. Set
  `compaction.subagents: false` to restore the previous behaviour exactly.

  **A compaction is no longer irreversible** (`compaction.archive`, default
  `true`). The dropped messages are written verbatim to `~/.aragon/compaction/`
  before the splice is adopted. `/compact history` lists this run's archives,
  `/compact show <n>` prints one's metadata and summary — never message bodies.
  The directory is shared by every `aragon` on the machine, so files carry a
  per-process run id and retention is two-tier: 20 files per run by count, plus a
  seven-day sweep across all runs, so one session can never prune a live
  neighbour's work. Writing is best-effort: a failure is logged and never affects
  the compaction. This is deliberately **not** undo — restoring an over-full
  history restores the condition that triggered the compaction.

  **The long moment is legible.** The live card counts elapsed seconds and says
  `esc to cancel`, which `AgentController.abort()` has always made true and no
  surface has ever stated. A compaction that could only clip says so and names no
  model, because none was called.

  Two new config keys (`compaction.subagents`, `compaction.archive`), two new
  environment variables (`ARAGON_COMPACTION_SUBAGENTS`,
  `ARAGON_COMPACTION_ARCHIVE`), two new `/compact` verbs (`history`, `show <n>`),
  and two new settings-screen rows. No flags were added.

- **Context compaction — a long run no longer dies when the window fills, and it
  is ON by default.** A session's conversation only grows: nothing anywhere
  removed a message, so a 40-turn tool-heavy run had exactly one ending available
  to it once the context window filled — an HTTP 400 and a banner reading
  *"Context length exceeded — start a new conversation with /reset."* The
  product's answer to running out of context was "throw away everything you were
  doing."

  Now, at **90 %** occupancy, the run pauses at a turn boundary, hands the older
  part of the history to a summarizer, and swaps it for a structured record. Your
  original task stays **verbatim**, the most recent turns stay **verbatim**, and
  the run continues in the same loop with the same tools, the same todo list and
  the same working directory.

  **This changes behaviour for existing users, in the direction of not dying.**
  `--no-compaction`, or `compaction.enabled: false`, restores the old behaviour
  exactly: no manager is constructed, nothing is subscribed, no registry is
  allocated, and a full window ends the run as it did before. Both flag forms are
  declared, so a stored `false` survives a run that passes no flags.

  Three ways it fires. **Proactively** on measured occupancy — the case that
  happens almost every time. **Reactively** when the provider returns
  `context_overflow` anyway, because the model is not in the static window table
  or you are pointed at a proxy in front of a smaller one: one compaction, one
  re-send, run continues. And **manually**, via `/compact`, which runs
  immediately when idle and queues to the next turn boundary when running.

  The trigger has two terms. 90 % of a 200 k window leaves 20 k, which is plenty;
  90 % of a 32 k window leaves 3.2 k, which is less than a single `max_tokens` of
  8192 — the request is already impossible. So compaction also fires whenever the
  remaining headroom drops below one full response.

  **The default summarizer is your own model, and that costs real money.**
  `compaction.useFastTier` is `true`, but it is a *preference*: the fast tier is
  off unless you configured it, so out of the box the first compaction is a
  ~30 k-token call on the session's own model. It happens at most 5 times per
  run, the alternative is losing the run entirely, and the spend is visible — in
  the session total, priced with the summarizer's own table, and reported as
  `pricing unknown` rather than `$0.00` when that table has never seen the model.
  Configure the fast tier to make it cheap.

  Summarization fails sometimes. The ladder is one retry (on your **main** model
  if the first attempt used the fast tier), then a **truncation** that says so on
  the card, on the JSON event stream, and inside the block the model itself
  reads. `compaction.onFailure: "stop"` makes the other trade.

  Four guards stop it looping on your money: never two on consecutive turns,
  never more than 5 per run, a progress requirement, and a self-disable after two
  no-progress attempts with a notice naming the cause and the fix. The guards are
  **trigger-aware** — the reactive path stays armed even after a self-disable,
  because a compaction answering a request the provider has already refused is
  the difference between a live run and a dead one.

  Three UI surfaces: `Compacting context…` on the activity row while it runs, a
  `compacting` chip plus threshold-aligned gauge colours as state, and a
  transcript card with the before/after counts, the summarizer, the duration and
  an expandable summary as the record. The gauge falls **immediately** rather
  than waiting for the next turn. `/compact status` is the guaranteed surface at
  any width.

  New: `compaction` config section (6 keys), `--compaction` / `--no-compaction` /
  `--compaction-threshold`, `ARAGON_COMPACTION*` (3 vars), `/compact` (6 forms),
  three settings-screen rows, a `compaction` event on the `aragon exec` JSON
  stream (`EXEC_SCHEMA_VERSION` **unchanged** — adding an event type never bumps
  it), and two stderr lines under `-p`.

### Changed

- **The context gauge now counts cache tokens**, through the same
  `occupiedTokens` the compaction trigger reads. Anthropic reports `input_tokens`
  *excluding* cached tokens and puts them in two separate fields, so the old
  `inputTokens + outputTokens` silently under-reported occupancy for anyone
  behind a caching gateway. That was already a defect in the number on the status
  bar; it becomes a much worse one the moment a trigger fires on a different
  number from the one you are watching.

- **`context_overflow` now names `/compact` alongside `/reset`.** That remedy
  list was complete until this release, because throwing the conversation away
  really was the only exit.

### Known limitation

- **A summarizer that is 90 % faithful will, eventually, drop something the run
  needed,** and no amount of prompt engineering closes that. The design bounds it
  — verbatim task, verbatim recent turns, a block that tells the model the record
  is partial, and three surfaces that make it visible so a human can step in —
  but it does not eliminate it. That is inherent to compaction as a technique, it
  is the same trade Claude Code and Codex make, and it is preferable by a wide
  margin to the previous behaviour, which was to lose the entire run.

## 0.6.0

### Added

- **`aragon exec` — a second, machine-facing face on the same binary.** The
  package already installed from npm and already ran from a terminal, so "it has
  a CLI" was true. It was nonetheless not *callable* by another program:
  everything it exposed was shaped for a person, and a build script, a CI job, a
  web backend or a second agent had to spawn it, capture free text, and guess.
  There was no way to read the answer without also reading the narration, no way
  to carry a conversation across two invocations, no way to say "you may read but
  not write" when there is no human to answer `--confirm`, and no way to bound
  what a run may spend.

  `aragon exec` adds a **contract** rather than a feature: a versioned JSON event
  schema on stdout, a session identifier the caller may mint itself, a tool
  permission policy enforced at the tool boundary, caller-set budgets with their
  own exit code, and a discovery command so a wrapper can ask what it just
  installed before depending on it. Everything underneath is reused unchanged —
  the same controller, the same tools, the same config resolution, the same
  skills, teams, todo and fast-tier subsystems.

  - `--output-format text | json | stream-json`. `stream-json` is NDJSON: one
    object per line, `system/init` first, exactly one `result` last, on every
    exit path including error, budget and signal. `text` is byte-identical to
    `aragon -p`, because it **delegates** to the same renderer rather than
    reimplementing it.
  - `--session-id` / `--resume` / `--continue`, backed by `~/.aragon-agent/
    sessions/` and an exclusive lock, so two runs cannot interleave and lose a
    turn. A second run on a held id exits 2 with `session_busy` rather than
    blocking.
  - `--permission-mode auto|plan|strict` plus `--allow-tool` / `--deny-tool`.
    A denied tool is **not registered at all**, so the model never sees it and
    never plans around it — and the policy reaches subagents, so one `task` call
    cannot bypass it.
  - `--max-turns` / `--max-duration`, both aborting through the same path `Esc`
    uses, both reporting `isError: false` and exit **3**: a budget firing is not
    a malfunction, but it is not a complete answer either, and a shell script has
    to be able to tell without parsing JSON.
  - `--append-system-prompt` / `--append-system-prompt-file`. Appending only;
    there is deliberately no full `--system-prompt` replacement, because the
    builtin prompt carries tool discipline, todo planning, the skills catalog and
    the plan-mode block, and replacing it silently disables half the product.
  - `--input-format stream-json`, so one process can serve several turns from a
    pipe. A malformed line is skipped with a non-fatal `error` event; an unknown
    message type is ignored.
  - **`aragon sessions`** (`list` / `show` / `rm` / `prune` / `path`),
    **`aragon info [--json]`** and **`aragon doctor [--json] [--probe]`**.

  Documented in full under
  [Use it from another project](./README.md#use-it-from-another-project),
  including an honest Limits section: there is no filesystem sandbox, process
  exit is terminal on Windows whether or not a `result` arrived, an exec session
  resumed in the TUI shows no scrollback, and `sessions prune` shares a directory
  with the TUI's `/save`.

### Changed

- **Exit code `3` is new, and the signal row is now stated as `128 + signo`.**
  `3` means "stopped by a budget you set" and is reachable only from
  `aragon exec`. The signal codes are unchanged in behaviour — this CLI has
  always exited `128 + signo`, so `SIGTERM` has always been `143` — but the
  README previously simplified all of them to `130`, which is fine for prose
  about a CLI a human interrupts and not good enough for a wire contract.
- `interrupt` handling now settles the run before exiting when `aragon exec`
  owns it, so a wrapper reading NDJSON gets a final `result` on Ctrl-C instead of
  having to time out to learn the run ended. `aragon`, `aragon -p` and every
  other subcommand keep the previous bare-exit behaviour byte for byte.

### Unchanged, and asserted rather than claimed

- `aragon`, `aragon -p`, every existing flag, every slash command and every byte
  of their output. `aragon exec --output-format text` and `runHeadless` are
  compared for byte equality on **both** stdout and stderr by a regression test,
  and `createBuiltinTools` with no permission policy is proven by object identity
  to return the tools it returned before.

## Unreleased

### Added

- **Drag the mouse to select text, and release to copy it.** Full-screen mode
  takes the alternate screen, turns on mouse reporting so the wheel can scroll a
  transcript the terminal no longer knows how to scroll, and draws every row
  itself. Each of those is right on its own; together they took your terminal's
  own drag-to-select away and put nothing in its place. The only thing shipped
  in its place was a one-line notice naming a bypass key that is Shift on some
  emulators, Fn on others and a preference elsewhere — a workaround, told once,
  in a line that scrolls away.

  Press the left button and drag: the cells you drag across are highlighted as
  you go, and releasing copies exactly them. The copy goes out over **OSC 52**
  first, so it reaches the clipboard of the machine you are *sitting at* rather
  than the one you are ssh'd into, with the platform clipboard binary attempted
  alongside it for terminals that ignore the sequence. Neither mechanism is
  detectable, so the toast names what was sent rather than claiming a success it
  cannot verify. `/copy` now goes through the same path and gained ssh support on
  the way.

  The highlight is painted in the frame pipeline rather than in React, so a drag
  costs one to three re-addressed rows instead of a re-render of the whole tree,
  and the text that is copied is read from the same mirrored rows the highlight
  was painted over — what you see is what you get by construction, not by a
  staleness check that can be wrong.

  Two switches, both reversible without a restart: `/mouse off` hands the mouse
  back to your terminal for the session (and says plainly that the wheel goes
  inert while it is off), `/mouse on` takes it back, and
  `aragon config set mouseSelect false` keeps wheel scrolling while leaving
  drag-select off — which also stops the CLI asking the terminal for motion
  reports at all, so that session puts exactly the bytes on the wire that it did
  before this release. `--no-mouse` remains the switch that captures nothing.

### Changed

- **Scrolling up now actually stops the transcript.** The viewport followed the
  newest output by holding a *fixed distance from the bottom*, so scrolling up
  during a run did not pause anything: twelve new rows of output moved the
  window twelve rows down, and whatever you had scrolled up to read slid off the
  top while you were reading it. The faster the agent talked, the faster your
  reading position ran away.

  While you are scrolled up, the transcript is now anchored to the **content**:
  new output accumulates below the window instead of dragging the window along
  with it, and the rows on screen hold still. After five seconds with no
  scrolling the viewport returns to the newest line by itself — but only if
  something actually arrived while you were paused, so reading a *finished*
  transcript is never interrupted by a jump to a bottom that has not moved.
  Every gesture restarts the countdown, a selection drag suspends it, and
  `aragon config set scrollResumeMs 0` turns the return off entirely
  (`ARAGON_SCROLL_RESUME_MS` sets it too).

  The number the hint shows means something sharper as a result: it is now
  literally "rows of newer output below your reading position", which is what
  `PgDn` traverses and what the status bar's `↑N` has always shown.

- **The "N new lines · PgDn" hint moved inside the input box.** It used to be
  rendered as the viewport's own last row, which spent a line of your transcript
  on chrome at exactly the moment the transcript was longest — and, because the
  hint's presence shrank the viewport, it fed back into the very number it was
  displaying. It is now a right-aligned chip on the composer's input row, inside
  the border, where it costs no rows at all. The chip sits in a fixed-width cell
  so the number gaining a digit cannot re-wrap a draft, it never truncates (the
  draft wraps first), and unlike the teaching row below the box it neither fades
  with experience nor disappears on a short terminal: how far behind you are is
  state, not a tutorial.

### Fixed

- **The working spinner no longer disappears when an ack takes its row.** Steer a
  run, approve a plan, or press `Ctrl+T` while the agent is working, and the row
  above the composer traded its spinner for the acknowledgement — and for that
  ack's full two and a half seconds, nothing anywhere on screen moved. The status
  bar still read `running` and the tool card still read `running`, so no
  information had left the frame; only the evidence that the process was alive
  had, during exactly the long tool calls where "is it stuck?" is the question you
  are already asking. Consecutive acks extended the window, and steering is
  something the composer invites on every run.

  That row was made the sole owner of animation in this same release, and
  everything else on screen holds still for as long as the row is believed to be
  showing one. Believed, not checked: an ack won the row outright, so the belief
  and the frame disagreed, and the disagreement was invisible to every test
  because no component was wrong on its own.

  The ack still owns the row and keeps every word of its text. The spinner now
  rides beside it as a bare glyph — no phrase, no clock — so there is exactly one
  animation at every instant of a run, with an ack up or without one: never none,
  and never the several this release set out to remove. Terminals without Unicode
  and anyone running with `reducedMotion` come out byte for byte unchanged; they
  had no animation to lose, and nothing is prefixed to their acks.

- **`/clear` now takes the todo panel with it.** Finish a plan, type `/clear`,
  and the transcript emptied while the `7/7 done` rail stayed exactly where it
  was — on a screen you had just asked to be cleared. It stayed until your next
  real message, which is precisely the pause you take after clearing to decide
  what to ask next, so essentially everyone met it.

  This was deliberate once. The list is a projection of what the model believes,
  and `/clear` wipes the transcript rather than the conversation, so the model
  still believed in the plan and a panel contradicting the model was judged worse
  than no panel. That reasoning holds for everything the CLI does on its own; it
  does not hold against you typing the command. An explicit instruction was
  always this rule's exception — `/todo clear` has used the same door from the
  start — and `/clear` now goes through it.

  The list itself is cleared, not just the pixels, so `/save`, `/todo status`,
  `/todo continue` and auto follow-through all agree with the screen: no plan is
  written into a saved session, nothing offers to continue one, and nothing spends
  a follow-through on it. `/reset` is unchanged and still the only command that
  clears the conversation. Nothing is stranded either way — the model's next
  `todo_write` is a full replacement, so the panel comes back the moment there is
  a plan to show.

### Added

- **An update that will not start is undone automatically.** The updater shipped
  in this same release could install a version that fails to *import* — an
  undeclared dependency, a Node API that moved, a syntax error past the transpile
  target — and the only recovery was to know the package name and type
  `npm i -g @aragon-agent/cli@<some older version>` from memory. None of those
  failures reach any line inside `main()`, so no amount of care there helps.

  The `aragon` command is now a small launcher that runs **before** the CLI. It
  reads one ~300-byte file, and on every launch except the first one after an
  auto-update that is all it does — no write at all. But if the version it is
  about to start is one **this updater installed**, and that version has already
  exited non-zero twice, it reinstalls the version that was running before the
  update and marks the bad one so nothing puts it back:

  ```
  aragon 0.6.0 failed to start twice; rolling back to 0.5.9.
  ```

  It boots anyway. If the crash was transient, refusing to start would lock you
  out of a working CLI on our guess; the reinstall is detached and finishes
  either way. The next session says once what happened and then stops. A **newer**
  release clears the mark and installs normally — you were never opted out of
  updates, only out of the loop.

  It never touches a version **you** installed yourself, and it does not try to
  detect a release that starts and is merely wrong. `aragon update --rollback` is
  the same mechanism run deliberately, for the case a human spots in one second
  and a heuristic would get wrong on a bad day. Exit `4` means there was nothing
  recorded to roll back to.

  **`update.mode: off` disables this too.** The guard is armed only by an
  auto-install, so a machine that never auto-installs never arms it — the kill
  switch turns off the whole subsystem, recovery included.

- **A blocked install now says what is actually blocking it.** Every install
  failure used to print the same line: `update failed · npm i -g
  @aragon-agent/cli`. On Windows the commonest cause is that the shim which
  launched us is held open by the shell running it, so that advice hits the same
  handle and fails identically — the one visible failure was also a wrong
  instruction. Failures are now classified, and three of them name the real
  remedy and appear immediately rather than after three strikes, because each is
  something you can fix and none of them fixes itself:

  ```
    ! update blocked · close other aragon windows, then: npm i -g @aragon-agent/cli
    ! update failed · no disk space
    ! update needs write access · npm i -g @aragon-agent/cli
  ```

  Network failures are deliberately **not** in that set: you cannot fix the
  registry and the next check may well succeed, so they stay silent and back off.

- **Updates work behind a corporate proxy.** Node's `fetch` ignores `HTTP_PROXY`,
  so on a proxied machine the check failed silently forever. When the direct
  request fails, `aragon` now asks the npm you already have instead, which
  honours `proxy`, `https-proxy` and your `.npmrc`. It runs *only* after a
  request that has already failed, so on an ordinary machine it never runs.
  `/update status` shows `probe: npm` when this is what answered. No credentials
  are read or forwarded — we run the command you could have typed.

- `/update status` gained `rollback`, `lastgood` and `probe` lines, so what the
  guard did and what `--rollback` would reinstall are answerable without reading
  the log.

### Changed

- **`aragon update` exit codes: a blocked install is now `2`, not `1`.** This is
  the one change here a script can notice. `1` means "try again later" and `2`
  means "this machine will never auto-update, run the command we printed" — and
  for `EPERM` / `EBUSY` / `ENOSPC` the second is the accurate one: waiting does
  not unblock a held file handle or an empty disk. A caller shaped like
  `aragon update || sleep 300 && retry` changes behaviour. `0`, and `1` for an
  ordinary failed check or install, are unchanged.

- `bin.aragon` now points at `dist/launcher.js` rather than `dist/cli.js`.
  `dist/cli.js` is unchanged, keeps its shebang and stays executable, so
  `npm start` and any script invoking it directly keep working — only the mapping
  moved.

- **`aragon` keeps itself up to date.** Until now the installed copy was frozen
  forever: nothing in the CLI ever looked at the registry, so someone who
  installed 0.4.x eighteen releases ago was still running it and the only signal
  that anything had moved was a README they were never going to re-read.

  There is now a background updater. At most once every four hours, and at most
  once per machine per interval, it asks npm what the `latest` dist-tag resolves
  to; if that version is genuinely newer, stable, not deprecated and runnable on
  this Node, it installs it silently into the same global installation you
  already have and says so on **one line above the composer**:

  ```
    * 0.6.0 installed - restart aragon to apply
  ```

  **The running process is never mutated in any way it can observe.** The new
  version lands on disk and takes effect on the *next* launch. A restart in the
  middle of a turn would destroy a live run, a subagent dispatch and an open plan
  review, so the line waits and the human decides when.

  The notice does not get its own row — it shares the row the toast stack and the
  working line already share, behind both of them. A toast is a response to
  something you did and wins outright; the working line is transient and would be
  lost if deferred; the update line is persistent and loses nothing by waiting.
  The practical effect is that **someone who is actually working never sees the
  updater until they stop.**

  It only ever runs `npm i -g` for one kind of installation: a global one where
  no project manifest claims to own the version. pnpm, yarn, bun and volta are
  each detected and get the correct command for *that* manager printed instead
  of a command run on their behalf; `npx`, a project's `node_modules` and a
  clone of this repo produce no line at all, because none of them is out of date
  in any sense the user can act on. A global directory that cannot be written is
  detected before anything is spawned, and npm exiting `0` into a *different*
  prefix — which happens on any machine with `prefix=` in `.npmrc` or two Node
  installations — is caught by re-reading the version from the directory we
  classified, rather than being believed.

  Every failure is silent: it logs, backs off exponentially, and says nothing
  until the third consecutive one, at which point it says something actionable.
  Four config keys (`update.mode`, `update.checkIntervalMs`, `update.registry`,
  `update.distTag`), the flags `--update` / `--no-update`, the environment
  variables `ARAGON_UPDATE` and `ARAGON_UPDATE_REGISTRY`, the slash command
  `/update [status|now|skip|off]`, and a foreground `aragon update
  [--check] [--to <version>] [--json]` for headless users. `update.mode: off`
  and `ARAGON_UPDATE=0` are kill switches, and with either set the CLI executes
  zero lines of update code.

  Auto-update widens the window in which a compromised release reaches users
  without a human decision. The README says so plainly, along with what is and
  is not mitigated. No credentials are ever attached to the check.

- **A running command shows what it is doing.** `bash` is the only tool here that
  can run for minutes — `npm test`, a `git clone`, a training job — and while it
  ran, its card was one line of text that never changed. Nothing in that frame
  distinguished a test suite at 40% from a child process blocked forever on a
  password prompt this CLI will never show. Its card now carries the last eight
  lines of what the command is printing, plus one footer row that reads
  `(running)` or, once the child has been quiet for ten seconds,
  `no output for 45s` — with the seconds advancing.

  A `\r`-driven progress bar (npm, pip, curl, docker) is *one* line rewritten a
  thousand times, and it renders as **one row counting up in place** rather than
  a thousand rows of nearly the same string — including the ordinary case where
  the bar emits no newline at all for its entire run.

  Everything the tail shows is **stripped, not interpreted**: ANSI colour, cursor
  motion, `\r`, `\b`, tabs and every other control byte are removed at the
  boundary before a row is stored, so nothing can move a cursor inside a frame
  the renderer believes it owns. It is bounded twice by construction — eight rows
  per call, sixteen concurrent calls — so a command that writes 400 MB to stdout
  costs a fixed number of retained rows.

  It is a **display and nothing else**. The text the model receives is
  byte-for-byte what it was; `Ctrl+O` does nothing while a command runs, because
  expansion is a promise about stored content and there is no stored rest of a
  400 MB stream; `/save` during a run writes no tail, since a resumed one would
  describe a process that died with the session; and at settle the card is
  replaced by the authoritative result exactly as before.

  New config key `liveToolOutput`, defaulting to **`true`** — unlike
  `showThinking` below, this adds information rather than hiding it.
  `aragon config set liveToolOutput false` (or `--no-live-tool-output`, or
  `ARAGON_LIVE_TOOL_OUTPUT=0`, or the **Live output** row in `/settings`) turns it
  off, and with it off no store is allocated and no recorder is attached: `bash`
  is byte-identical to the build before this entry.

- **The working line stops guessing while a tool runs.** It reads
  `⠙ Running bash` instead of rotating thinking-words. `running` covers the whole
  turn, including the minutes the model is idle and a child process is doing the
  work, so "Pondering" during a build was not calm — it was wrong. One row, no
  digits, no clock: everything the row already promised still holds.

### Changed

- **Reasoning blocks are now hidden by default.** `showThinking` is a new
  top-level config key and it defaults to `false`. If you have been reading
  thinking every day, this is the entry that concerns you: `Ctrl+T` still shows
  it for the session exactly as before, `aragon config set showThinking true`
  (or `--show-thinking`, or `ARAGON_SHOW_THINKING=1`) restores the old behaviour
  permanently, and `/settings` has a **Show thinking** row directly under
  **Thinking**.

  Nothing is hidden silently. A settled turn that thought leaves one muted row
  where the block used to be — `✱ thought for 12s · ctrl+t to show` — so the fact
  that reasoning happened, how long it took, and how to see it are all still on
  screen. In **inline** mode that row omits the key hint and the toast reads
  `Thinking shown for new output.`, because a settled entry there has already
  been printed into your terminal's scrollback and cannot be repainted; the
  toggle applies to the live entry and to everything drawn after it.

  `thinkingLevel` is untouched and means what it always did — the effort the
  provider is asked to spend. `showThinking` is only whether the terminal draws
  what came back. They are one word apart in the config file, which is why the
  flag is `--show-thinking` rather than the shorter name.

### Added

- **A live working line while a run is in flight.** One row above the composer,
  carrying a spinner and a word that rotates every four seconds:
  `⠋ Percolating…`. Take reasoning off the screen and the gap between submitting
  and the first token is otherwise completely blank, which reads as dead rather
  than as busy — the two changes are one change.

  It carries no clock and no token count, deliberately: the status bar one row
  below already renders both, under the same running condition and driven by the
  same 200 ms ticker this row reuses. Under `reducedMotion` the spinner is a
  static glyph and the word is chosen once and holds, because rotating text is
  motion too. An idle frame is unchanged, and so is the viewport's row budget —
  the line shares the row the toast strip already owned rather than adding one.

- **`write_file` and `edit_file` render a real diff.** Hunks with old/new line
  numbers, a `+N -M` summary, add/remove/context colouring, and `(truncated)` or
  a `binary` / `too-large` / `unreadable` note when the old side could not be
  read. Diffs collapse at 12 rows behind the existing `Ctrl+O` — no new
  keybinding. A resumed session written by an older build, or a card whose patch
  the bounded store already evicted, falls back to the previous text preview;
  nothing renders blank.

  `write_file` previously reported creating a 300-line file as
  `Wrote 8214 bytes to path`, and `edit_file`'s diff trimmed the common prefix
  and suffix and rendered *everything* in between as one removed block followed
  by one added block — for a `replace_all` touching line 40 and line 900, that
  was 860 removed rows followed by 860 nearly identical added ones.

  **The model's input got smaller, not larger.** The structured patch reaches the
  screen on a CLI-local channel rather than through the tool result, and the text
  the model reads gained a 4 000-character ceiling it did not have before (its
  only previous bound was the executor's 100 KB backstop). A single-region edit
  is byte-for-byte what it was plus one `@@` header; a multi-region edit is
  strictly smaller. `write_file`'s result text is unchanged.

### Changed

- **A stream that stops mid-answer is now a loud failure instead of a silent
  truncated one.** All three provider adapters used to end their SSE loop by
  yielding "done" with whatever had arrived, so a connection closed cleanly
  half-way through an answer — a proxy idle cut, a load-balancer timeout, an
  HTTP/2 GOAWAY — was indistinguishable from a completed reply. You got a
  truncated answer and were told nothing.

  Each adapter now reports the truncation, which is what lets it be retried and
  recovered. An **abort** is explicitly excluded and still completes normally, and
  a model that legitimately says nothing and stops is still a success.

  This is deliberately **not** behind `--no-retry`: an adapter that reports a
  truncated stream honestly should do so whether or not retry is enabled. A switch
  that also disabled telling you the truth would be a mute button, not a kill
  switch.

- **The mouse wheel now only ever scrolls.** A notch scrolls the transcript
  three rows (a page with `Shift`), or the open overlay when there is one, no
  matter where the pointer is sitting. Prompt history is recalled by `↑` / `↓`
  alone, exactly as in Claude Code and Codex.

  **This supersedes the 0.5.0 entry below**, which said the wheel "scrolls what
  is under the pointer" and stepped prompt history one entry per notch when the
  pointer was over the input box. That turned out to be wrong in use rather than
  in principle: the pointer is not an instrument you aim in a TUI — it rests
  wherever you last left it, which in a chat-shaped app is next to the thing you
  type into. So the ordinary "scroll back and see what just happened" gesture
  landed on the composer and replaced the draft with an old prompt, with no
  error, no undo and nothing visibly connecting the gesture to the outcome. The
  band that decided this was invisible too: its boundary was a measured row that
  moved as the toast row, the hint row and the completion popup came and went, so
  the same gesture could do two different things a second apart.

  Nothing else about the wheel changes — same three rows per notch, same
  `Shift`+wheel page, same `--no-mouse` / `ARAGON_MOUSE=0` / `mouse: false`
  escape hatches, same `Shift`+drag for selecting text.

- **A long session stays as fast as a short one.** The TUI used to get slower as
  a session grew and, past a threshold, stopped making progress at all. That was
  structural rather than incidental: Ink has no output caching, so every frame
  re-walked the entire mounted tree, re-measured every text node and
  re-serialised the frame. The per-frame cost was therefore proportional to every
  character the session had ever produced — and `transcriptWindow` bounded the
  entry *count*, which bounds nothing when one entry can be fifty thousand lines.

  Entries outside the visible band are no longer mounted. The viewport renders
  what you can see plus a couple either side and replaces the rest with two
  spacers of the right height, so the frame costs what the screen costs.
  Scrolling, the `↑N` readout and the wheel routing are untouched. Because the
  horizon is no longer a rendering budget, `transcriptWindow` rises from 300 to
  1000 and its ceiling from 2000 to 20000; an existing setting is still valid
  and still clamps.

  Syntax highlighting and markdown parsing are memoised on their input, so a
  200-line code block is tokenised once rather than thirty times a second for as
  long as it stays on screen. Only the *parsed* form is cached and never a themed
  one, so `/theme` still takes effect on the next frame.

  Under genuine load the streaming interval widens — 33 ms up to a 320 ms
  ceiling — so keystrokes and `Ctrl+C` do not queue behind renders. This is
  visible rather than silent: a muted **`eco`** chip appears in the status bar
  while it is in effect, because a user who cannot see why the stream got
  chunkier will conclude the model got slower. `--no-render-governor`,
  `renderGovernor: false` or `ARAGON_RENDER_GOVERNOR=0` turns it off;
  `--max-render-interval 33` flattens the ladder without disabling the mechanism.

- **A live thinking block no longer grows without limit.** While an answer is
  streaming, visible thinking is clamped to its newest 24 rows behind a
  `... N earlier lines` marker, and the whole block renders again the moment the
  answer settles. Thinking is scratch reasoning you read from its newest end, and
  an unbounded one was the easiest way for a single live entry to fill the
  viewport on its own.

### Fixed

- **Inline mode could hard-freeze the terminal, and now cannot.** Once a live
  entry grew taller than the terminal, Ink took a branch that writes
  `clearTerminal` plus the *entire accumulated session history* on every
  subsequent frame — bypassing both of its own dedupe gates, and growing without
  bound for the rest of the session. Any inline user (`--no-fullscreen`,
  `TERM=dumb`, CI, a terminal under 12 rows or 40 columns) whose model wrote a
  long answer could reach it. The live region is now clamped below that
  threshold, with a `... N earlier lines` marker naming what is deferred. Nothing
  is lost: the entry prints in full into the terminal's own scrollback the moment
  it settles.

- **The view state no longer grows without a ceiling.** A single assistant answer
  is capped at 256 KiB in the view (thinking at 64 KiB, streamed tool arguments
  at 16 KiB) by eliding the MIDDLE, so both the opening and the live cursor
  survive; a marker states how many characters went. `transcriptRetain`
  (default 1000) caps the entries kept in memory, and what it removed is counted
  and reported both by `/perf` and at the top of the exit replay. A model that
  emits five megabytes no longer makes every later frame a five-megabyte scan.

### Added

- **A fast model tier: a second, cheaper model you can delegate to and be
  reviewed by.** Off by default — with `fast.enabled: false` the system prompt,
  the `task` schema, the transcript and the request payloads are byte-identical
  to a build without it — and it does two things once you turn it on.

  **Delegation.** `task` gains one optional field per subagent, `model: "fast"`.
  A child marked that way runs on the fast model and is otherwise identical:
  same tools, same working directory, same `--confirm` gate, same plan-mode
  gate, same skills ceiling. Delegating to a cheaper model is a *model* choice,
  never a permission boundary. It is where "not complicated, but very expensive
  in context" gets paid for — a child that reads nine files and reports four
  sentences moves the file bodies out of the lead's window and onto a model that
  costs a fraction as much per token.

  **Periodic review.** Every few turns a small digest of what the lead has been
  doing goes to the fast model with one question — is this still on track? — and
  a critique that is not "on track" is injected into the running loop as a
  `<fast_review>` block, so the lead sees a second opinion while it can still
  act on it:

  ```
    fast review #2 · claude-haiku-4-5 · turn 12 · 1.4s
    You have edited config/schema.ts three times without running the tests.
  ```

  The digest is built from a bounded ring of recent turns and **never** from the
  message history: sending a session's accumulated file bodies to the "cheap"
  model would make a review cost more than the turn it reviews, which is the
  inversion the whole feature exists to prevent.

  Spend is attributed **per tier** — a fast child's tokens are priced at the
  fast model's table, not the lead's, and the dispatch report states the two
  separately. A model the built-in price table has never seen is reported as
  `unknown` rather than as `$0.00`, because a feature that looks free while it
  is spending money is worse than one that admits it does not know.

  Turn it on with `/fast model <id>` then `/fast on`, with
  `aragon config set fast.enabled true`, with `--fast --fast-model <id>`, or with
  `ARAGON_FAST=1 ARAGON_FAST_MODEL=<id>`. `/fast status` is the guaranteed
  readout: the resolved model, the budget, and this session's reviews, delegated
  children, tokens and cost. Eleven `fast.*` config keys, four flags, four
  environment variables and five settings-screen rows; see the README.

  **The review has a session budget.** A session is not one run — it is one run
  per message you send — so a cadence bounds the pace and nothing bounds the
  total. `fast.reviewMaxPerSession` (default **40**, raisable live with
  `/fast budget <n>`) is the number of reviews a session may *start*; reaching it
  prints one `info` notice that names the remedy and says delegation is
  unaffected, and `/fast status` reads `12/40` from the first review rather than a
  bare count you can only size after the fact. It is denominated in **reviews,
  not currency**, because the fast tier is exactly where a model the price table
  has never seen lives — a dollar ceiling would silently never fire for the
  configuration that most needs one. Delegation is never budgeted: it is spend the
  lead chose in service of a message you sent, it is already bounded by `team.*`,
  and it exists to *reduce* total cost.

  **The review also fails fast, so it cannot compete with you.** It calls through
  its own provider registry with **one** retry rather than the ten
  `retry.maxRetries` defaults to for the lead, and it observes neither `retry.*`
  nor `/retry` — that policy says how hard to fight for *your* answer, and
  inheriting it for an unrequested background call is how an advisory ends up
  spending a rate-limited provider's quota on itself. Its own wall-clock bound
  is 20 s.

  Two failure modes are handled out loud rather than silently. If the tier stops
  resolving mid-session — you switch the main provider and `fast.provider` was
  inheriting it — `model:"fast"` is downgraded to the main model, **counted, and
  stated in the report**, because an agent that silently gets an expensive child
  has no way to learn its cost model is wrong. And three consecutive
  *misconfiguration* failures disable the reviewer for the session with exactly
  one warning, while a merely busy provider (rate-limited or overloaded) is
  treated as transient and never counts — that condition fixes itself, and a
  session-long silent shutdown over it would not. A review you *cancelled* is
  neither: Esc, a run that ends first, or quitting leaves a `cancelled` card and
  no strike against the tier.

  Reviews log under their own `fast` scope rather than under `agent`, so
  `fast_review_*` records filter cleanly away from the lead's.

- **API calls are retried with backoff, and the waiting is legible.** A transient
  provider failure — HTTP 429, 529, 5xx, 408, or a dropped connection — used to end
  the turn. One red notice, an idle prompt, and forty tool calls of work thrown
  away. It is now retried up to **10 times** with an increasing interval
  (1 s → 2 → 4 → 8 → 16 → 30 s, equal-jittered, 30 s per wait at most) under a
  4-minute budget measured from the first failure.

  What you see while it waits is **one line, rewritten in place** — never ten
  notices — carrying what failed, which attempt this is, and a countdown to the
  next one:

  ```
    ↻  Provider overloaded · retry 3/10 in 7s          Esc to cancel
    ↻  recovered after 3 retries · 12.4s
  ```

  plus a `retry 3/10 7s` chip on the status bar (`[r3]` on a narrow terminal). The
  card settles into the transcript as history — `recovered`, `gave up`, or
  `interrupted` — and shows up in the exit replay, because a turn that spent three
  minutes retrying is exactly the kind of cost an exported transcript should
  account for.

  **Esc ends the wait within a frame**, not at the end of the countdown, and it
  never produces a fabricated error: an aborted request is silent. That is the one
  detail everything else here depends on, because the provider layer marks an
  `AbortError` as retryable — so the signal is checked *before* the error, and a
  user pressing Esc can never be mistaken for a timeout worth retrying.

  Never retried: `auth_error` (401/403), `invalid_request`, `context_overflow`.
  Ten retries of a bad API key is three minutes of looking broken.

  `Retry-After` is honoured as a **floor**, never a replacement — a `Retry-After: 1`
  on the ninth retry does not undo eight retries of backoff — and a stated wait
  longer than a minute is surfaced immediately with the provider's own number
  rather than silently wedging the terminal.

  A connection that dies **mid-answer** is also covered, and this is the case that
  needed more than a retry loop: the partial text is discarded, the affected tool
  cards are removed, and the answer restarts from the top. Nothing is duplicated,
  because the engine only writes history on a completed turn.

- **`/retry [show|on|off|max <n>]`, `--retry` / `--no-retry`, `--retry-max <n>`,
  `ARAGON_RETRY`, `ARAGON_RETRY_MAX`, and a `retry` config section** with nine
  keys (`aragon config set retry.*`). `/retry off` takes effect **in the running
  session** — subagents included, since they share the lead's provider registry —
  not only at the next launch. `retry.maxRetries: 0` is the kill switch and is a
  real value at every one of those entry points. `/settings` gains one read-only
  `API retries` row.

- **A subagent's retry is visible on the team card.** A child in backoff reports
  `retry 3/10` on its own row. Children inherit the retry policy for free, but
  their events never reach the lead's view, so without this a subagent spending
  three minutes waiting looked exactly like a hung dispatch.

- **Retry lines in `-p` mode go to stderr, never stdout.** `[retry 3/10]
  overloaded — waiting 7s` and `[retry] recovered after 3 retries` are on stderr,
  so `aragon -p … | jq` stays valid; a discarded partial answer is announced there
  too, because a piped consumer otherwise cannot tell a replay from a model that
  repeated itself. They are not suppressed by `--quiet`: a three-minute pause with
  no explanation is not a compact run, it is a hang.

- **`/perf`.** Reports what the renderer is actually doing: the frame interval
  and the last commit cost, how many entries exist / are retained / were dropped
  / are mounted, height-cache and render-cache occupancy, and the viewport
  geometry. `/perf reset` clears the caches and returns the governor to its
  fastest rung. Silent degradation is the one thing a claim of robustness cannot
  afford, and this is the place that names it.

- **Three configuration keys**, each with a flag and an environment override:
  `transcriptRetain` (`--transcript-retain`, `ARAGON_TRANSCRIPT_RETAIN`),
  `renderGovernor` (`--render-governor` / `--no-render-governor`,
  `ARAGON_RENDER_GOVERNOR`) and `maxRenderIntervalMs`
  (`--max-render-interval`, `ARAGON_MAX_RENDER_INTERVAL_MS`). No migration and no
  config version bump: a file written before they existed loads unchanged.
  `transcriptRetain` is raised to `transcriptWindow` when the two conflict —
  retaining less than you can scroll to would make part of the horizon
  unreachable — and a startup notice names both numbers, because overriding a
  value you typed and saying nothing is the one thing none of this may do.

- **Following the plan through, on a budget you can do arithmetic on.** A run
  that ended with steps outstanding used to print one sentence and stop. It now
  asks three questions the CLI already knew the answers to — did you abort it,
  did it error, did the list move — and does one of three things.

  With the default `notify` the sentence is unchanged, except that a run **you**
  cancelled with `Esc` now says nothing at all: being told what you just
  interrupted is the CLI answering a question nobody asked.

  With `/todo follow auto` it continues the plan itself, after announcing
  `Continuing with 4 remaining steps in 3s - Esc to stop.` Auto-continuation was
  refused last release as "an unbounded cost loop wearing a helpful hat", and
  that judgement stands — what changed is that the loop is now bounded first.
  A continuation that completes no step buys exactly one more attempt; a single
  plan is continued at most 25 times however productive it looks; and a re-plan
  forgives the first counter but never the second, so a model that reshapes its
  list every turn cannot lift the ceiling. A run that ended with an error never
  auto-continues in any mode. `Esc` cancels, and so does typing anything.

  Whatever sends the continuation — the timer or `/todo continue` — now sends
  the numbered list of open steps rather than the words "continue with the
  remaining todo items", so a plan whose `todo_write` has scrolled out of the
  context window is still followed exactly. Neither path records that text in
  your prompt history any more; it is not something you typed.

  Under `-p` there is no grace window, because there is nobody there to use it,
  which is precisely why the two counters rather than the human are the
  protection there. `[todo] continuing (3 steps left)` and
  `[todo] 3 steps unfinished` go to stderr, suppressed by `--quiet`, and an
  unfinished plan still never changes the exit code.

  New surfaces: `/todo follow <notify|auto|off>`; `--todo-follow <mode>`;
  `ARAGON_TODO_FOLLOW`; and `todo.followThrough` in `config.json`. The default
  is `notify`, so a session that does not ask for any of this behaves as it did.

- **A plan strip for inline mode.** Inline mode has no fixed frame and so no
  rail, which left every pipe, every `CI=1`, every `TERM=dumb` terminal and
  every window under twelve rows able to see `todo 3/7` but not *which* step was
  running. There is now a one-row strip under the transcript —
  `todo 3/7  >  Adding the rail to AppShell        +2 done` — windowed on the
  same step the rail would have anchored on. It truncates rather than wrapping
  and is exactly one row at every width, so the composer does not move.
  `--no-todo-panel` hides it along with the rail.

### Changed

- `npm run typecheck` now covers the test tree in both packages. `tsconfig.json`
  excludes `__tests__` so the build never emits fixtures, and vitest transpiles
  without typechecking — between the two, a widened required field could break
  ten test files while `npm run build` and `npm test` were both green. Twelve
  such errors had accumulated; all twelve were fixture drift and all twelve are
  repaired, with no suppressions and no production type relaxed to accommodate a
  fixture.

- **TODO planning, and a rail to watch it in.** For work with three or more
  distinct steps the agent now keeps a visible plan: it writes a checklist with
  a new `todo_write` tool, marks exactly one item in progress, and ticks it off
  before starting the next. In full-screen mode the list is rendered as a
  right-hand rail about a fifth of the terminal wide, windowed around the step
  being worked on rather than sliced from the top. Ask for something small and
  nothing appears — the prompt tells the model not to plan work it can finish in
  one or two steps, and a one-item list against an empty plan is refused
  outright, so a session that never plans has byte-identical layout to a build
  without this feature.

  The list is a projection of what the model believes, and that single rule
  decides everything else: `/clear` keeps it (the conversation is still there),
  `/reset` drops it, `/save` writes it and `/resume` restores it — and resuming
  a session that carries no list CLEARS the current one rather than leaving a
  plan on screen whose conversation has just been replaced. A finished plan
  survives to the start of your next message so you get to see `7/7 done`; an
  unfinished one survives "continue" and "now do the rest", then expires after
  three unrelated turns rather than holding a fifth of the screen for the rest
  of the session. A run that ends with items left over produces a notice and
  `/todo continue`; nothing auto-continues on your behalf.

  "One step at a time" is enforced by structure rather than asked for in a
  prompt: any payload with two in-progress items is repaired down to one, and a
  list with none promotes the first unfinished item. Whatever the model sends,
  the panel has exactly one current row.

  New surfaces: the `todo_write` tool; `/todo [status|on|off|panel on|off|clear|
  continue]`; `--todo` / `--no-todo` and `--todo-panel` / `--no-todo-panel`;
  `ARAGON_TODO=0`; and `todo.enabled` / `todo.panel` in `config.json` (a third
  key, `todo.followThrough`, arrived with the follow-through entry above).
  `panel` is
  separate from `enabled` on purpose — a screen-reader user wants the planning
  discipline without the column, and the system prompt varies one sentence to
  match. Under `-p` the plan goes to stderr as `[todo] 3/7 <step>` lines,
  suppressed by `--quiet`. Below 80 columns, behind an overlay, in inline mode
  or on a short terminal the rail is not mounted and the counter appears in the
  status bar instead; the transcript keeps at least 62 columns at every width.

- **Output token limits that cannot themselves fail a run.** Every model and
  every provider now defaults to 64000 output tokens, and that number is
  configurable from the TUI, from a flag, from `ARAGON_MAX_TOKENS`, and by hand
  in `~/.aragon-agent/config.json`. Leave it alone and it stays 64000.

  What is new is that the number is an *ambition*. `gpt-4o` caps at 16384 and
  `gemini-1.5-pro` at 8192; sending 64000 to either is an HTTP 400 that ends the
  turn with a raw provider string in the transcript. The cap is now clamped down
  to whatever the target model actually accepts, from a per-model table plus
  whatever the provider's own model list reports. For a model nothing knows — a
  proxy, a `--base-url` endpoint, something that shipped last week — the request
  goes out at 64000, and if the provider objects, `aragon` reads the real ceiling
  out of the error text, repairs the request, sends it exactly once more, and
  remembers the answer for the rest of the session. One warning line; the run
  continues.

  Two combinations that were a guaranteed 400 on every request are fixed with
  it: `--thinking xhigh` asks for a 65536-token budget while Anthropic requires
  `max_tokens` to be strictly greater than it, and OpenAI's reasoning family
  (`o1`, `o3`, `gpt-5`) rejects the `max_tokens` parameter name outright in
  favour of `max_completion_tokens`.

  New surfaces: `/max-tokens [<n>|auto|default]`, which with no argument reports
  the setting *and* the effective cap for the live model; an `Effective:` line
  under the settings screen's `Max tokens` field, so a value the model will not
  honour is visible before you save it; `--max-tokens auto`; and
  `aragon config set maxTokens <n|auto|default>`, which echoes the value that was
  actually stored rather than the one you typed.

- **Team subagents.** The agent can now hand independent parts of a job to up to
  five short-lived subagents that run in parallel, then read one combined report
  of what each of them found. It decides for itself whether to delegate, so a
  session that never calls the new `task` tool is byte-for-byte the session that
  existed before. On by default; `--no-team` or `team.enabled: false` turns it
  off, and `aragon config set team.maxSubagents <n>` sets the width (1-10; the
  10 is a hard ceiling no config file can raise).

  A subagent is a full agent with the same tools and working directory but no
  memory of your conversation, so its brief has to be self-contained. It cannot
  delegate further and it cannot ask you anything. Plan mode and a skill's
  `allowed-tools` ceiling both reach one level down, so delegating is never a
  way around either; `--confirm` queues subagent confirmations one at a time and
  labels each with the subagent that is asking.

  Subagents can message each other with `team_send` / `team_wait`, delivered by
  attaching the message to the recipient's next tool result rather than
  interrupting it. The limits are deliberate — 6 messages each, one every 15
  seconds, 24 per dispatch — and every refusal is a plain result naming the
  limit rather than an error, because an error invites the retry the limits
  exist to prevent.

  While a dispatch runs, a roster sits between the transcript and the composer
  and the status bar carries `agents 3/5`; both disappear when it finishes and
  the transcript keeps a card you can expand with `Ctrl+O`. `Esc` aborts every
  subagent and returns the partial report. Under `-p` the transitions go to
  stderr and the subagents' tokens are folded into the `[usage]` footer, so the
  cost readout cannot under-report what the team spent.

  Full documentation, including the limits table and how team mode interacts
  with plan mode, skills and `--confirm`, is in the README.

- **The subagent roster now shows what each subagent is doing, and shows the
  ones that are working.** Where every row used to say `thinking` for minutes at
  a time, it now says `bash: npm test -w cli`, `read: src/api/routes.ts`,
  `waiting for a2`, or the tail of the sentence the subagent is currently
  writing. On a narrow terminal the same row falls back to a file name and a
  program name rather than wrapping, and the elapsed clock keeps its place at
  every width.

  The five visible rows are now the five that matter: whatever is running comes
  first, then whatever is queued, then the most recent results. Above five
  subagents the old panel showed the five that had finished first and hid
  everything still working behind `+3 more`, which is the opposite of what the
  roster is for. `+3 more` now says how many of the hidden ones are still going.

- **A subagent no longer waits two minutes for a message nobody can send.**
  `team_wait` now checks whether anyone could actually answer before it blocks:
  if the teammate it named has already finished, does not exist, or is itself
  waiting in a way that cannot be released in time, it returns straight away and
  says which. Nothing is refused that could still have been answered — including
  by a third teammate further down the chain — and the subagent is told what to
  do instead rather than handed an error.

- **A subagent whose very first request dies on a rate limit is retried once.**
  Only a genuine cold start qualifies: no turn completed and no tool ran, so
  there is nothing to undo. It restarts after two seconds, the roster says
  `starting (retry)`, and the report notes `retried 1x`. Pressing `Esc`, a
  timeout, or any subagent that had already begun work is never retried.

### Changed

- **`"maxTokens": null` in `config.json` now means AUTO** — use each model's own
  ceiling, never above 64000. It previously resolved to 64000 by accident (the
  layered resolver skipped `null`), and there was no way to express AUTO through
  any supported write path. If you have a `null` there today, the only difference
  is a downward clamp on models whose real ceiling is below 64000 — the direction
  that prevents failures rather than causing them. Absent still means 64000, and
  an explicit number still means that number.

- **`config.json` holds settings again.** The prompts you type are no longer
  stored in it. They move to `~/.aragon-agent/prompt-history.jsonl` — one JSON
  object per line, `0600` on POSIX — and the submit counter and the "notice
  already shown" flag move to `~/.aragon-agent/state.json`. `↑` and `↓` behave
  exactly as before.

  Two things get better. Opening `config.json` to change your model no longer
  means scrolling past a transcript of your own typing, and copying it to
  another machine no longer carries your prompts along. And submitting a message
  no longer rewrites the file that holds your API keys: `config.json` is written
  when you change a setting, and at no other time.

  **Your history and counters are migrated automatically, once, at the next
  launch.** Nothing is printed, because nothing changes for you. The dead
  `recentModels` key — which nothing has ever written — is dropped.

  If you go back to 0.5.x after upgrading, that version does not know about the
  new file and `↑` will look empty. Nothing has been lost: the entries are still
  in `prompt-history.jsonl`, and upgrading again brings them back.

### Added

- **`aragon history`** — `path`, `list` (`-n`, `--json`) and `clear --yes` for
  the prompt history, alongside the existing `aragon logs` commands. Entries are
  stored verbatim, so `clear` is how you erase them; `aragon config set
  historyEnabled false` stops new ones being recorded without deleting or hiding
  what is already there.

- **The mouse wheel scrolls what is under the pointer.** In full-screen mode the
  wheel now scrolls the transcript three rows per notch (a page with `Shift`),
  scrolls an open overlay when the pointer is over one, and steps prompt history
  one entry per notch when the pointer is over the input box — the same code
  path `↑` / `↓` use, so it inherits the rule that an in-progress draft is never
  overwritten. A slim rail on the viewport's right edge shows where you are in
  the conversation.

  **This fixes a destructive bug.** Previously the wheel recalled prompt history
  no matter where the pointer was, because the alternate screen makes terminals
  translate each notch into arrow keys. Wheeling while composing a message
  silently replaced the draft with an old prompt, and nothing scrolled.

  **Selecting text with the mouse now requires `Shift`+drag** in most terminals.
  That is the standard convention for "an application is tracking the mouse" and
  it applies to everyone, including people who never scroll with the wheel — so
  the first session says so once, in the transcript, and never again. Turn the
  whole feature off with `--no-mouse`, `ARAGON_MOUSE=0`, or
  `aragon config set mouse false`; the wheel then does nothing rather than
  reverting to the old behaviour. Inline mode (`--no-fullscreen`) is untouched:
  your terminal's own scrollback already does the right thing there.

  Under `tmux` with `mouse on`, tmux keeps the wheel for itself and the app
  never sees it. `set -g mouse off` hands it back.

### Changed

- **Your files moved to `~/.aragon-agent/`.** Config, sessions, installed skills
  and the usage counters now live in one directory in your home — on Windows
  `C:\Users\<you>\.aragon-agent\`, and the same path on macOS and Linux. They
  used to be split across `%APPDATA%\aragon-agent-nodejs\Config` and
  `%LOCALAPPDATA%\aragon-agent-nodejs\Data` (or the XDG equivalents), which are
  correct locations and terrible answers to "where do I change the model?".

  **The move happens once, automatically, on first launch, and prints a line on
  stderr when it does.** Nothing is deleted: `config.json` is COPIED rather than
  moved, and the old directories are left where they are, so reinstalling 0.5.0
  remains lossless. `aragon config home` prints the new location and names the
  old ones. Once you are satisfied, you can delete them yourself.

  `ARAGON_HOME` relocates the whole tree. It has to be a real environment
  variable — the path is resolved before any `.env` is read, so putting it in a
  `.env` will not work. `aragon config home` always prints what is actually in
  use.

### Added

- **Logging.** Records go to `~/.aragon-agent/logs/aragon-<date>.log` as JSON
  Lines: startup and exit, config writes, turn boundaries with token counts,
  tool names with durations, skill loads, and every uncaught error. Files rotate
  by day and by size (`log.maxFileBytes`, default 5 MiB) and the oldest beyond
  `log.maxFiles` (default 10) are deleted.

  **`info`, the default, records no conversation content**, so attaching a log
  to a bug report is safe. `--log-level debug` (or `--verbose`) adds prompts,
  replies and tool arguments truncated to `log.previewChars`; `trace` adds them
  in full. Those two write what you typed — check before sharing one.

  API keys are removed at every level by two independent passes: fields whose
  name looks like a credential are blanked whatever they hold, and every string
  is scanned both for known key formats and for the literal keys this process is
  holding — which is what covers a custom endpoint whose key looks like nothing
  in particular. `log.redactSecrets false` turns both off and warns you on
  stdout when you set it.

  Nothing is ever uploaded. There is no network path out of this subsystem.

  New commands: `aragon logs path | list | tail [-n N] [--follow] [--level lv]
  [--json] | clear --yes | open`, and `/logs` inside the TUI. New flags:
  `--log-level`, `--verbose`, `--log-file` / `--no-log-file`, `--log-dir`. New
  environment variables: `ARAGON_LOG_LEVEL`, `ARAGON_LOG_FILE`, `ARAGON_LOG_DIR`
  — these three, unlike `ARAGON_HOME`, can come from a `.env`.

- **`aragon config get <key>` / `list [--json]` / `edit` / `home`.** `get` and
  `list` mask every secret, `--json` included. `edit` opens `config.json` in
  `$VISUAL` / `$EDITOR` (`notepad` on Windows), takes a `config.json.bak` first,
  and re-parses on exit — an invalid edit is reported immediately, and the
  backup is named in the message.

- **`/reload`** re-reads `config.json` into the running session, for when you
  have edited it in another window. Refused while a run is in progress: swapping
  the model mid-turn would let the second half of an answer come from different
  settings than the first, with nothing afterwards able to explain the result.

- **Log level in the settings screen**, alongside provider / model / thinking.
  The rest of the log settings — and `redactSecrets` above all — stay
  command-line-only, so the one switch that can put credentials on disk cannot
  be flipped with an arrow key.

### Fixed

- **A malformed `config.json` no longer resets everything in silence.** A stray
  comma used to send the model, theme, timeouts, skills and (as far as you could
  tell) your API key back to defaults, with nothing anywhere explaining it. The
  fallback is unchanged — a bad config still never stops the CLI from starting —
  but it now says so, and records why.

- **Ctrl+C now flushes pending log records in every mode.** The signal handlers
  only existed in the full-screen branch, so `-p`, the inline renderer and every
  subcommand took Node's default termination, which does not run exit handlers.

### Added

- **Plan mode.** `Shift+Tab` toggles between `BUILD` (everything as before) and
  `PLAN`, a read-only research-and-design posture. `/plan [on|off|status]` is a
  first-class equivalent for terminals that swallow `CSI Z`, and `--plan` /
  `--no-plan` / `ARAGON_PLAN=1` / `planModeDefault` cover the startup case.

  In `PLAN`, `write_file`, `edit_file`, `bash`, `skill_install` and
  `skill_create` are refused **at the tool boundary**, so read-only is a
  property of the wiring rather than a promise in a prompt. `bash` is refused in
  full, `git status` included: a shell string cannot be classified reliably, and
  a gate that is right most of the time is worse than one that is always right,
  because you stop trusting the badge. The refusal names `read_file` / `glob` /
  `grep` as the alternatives.

  Two tools exist only while a human is attached. `ask_user` renders a
  keyboard-driven wizard - 1-5 questions, 2-4 options each, exactly one marked
  `RECOMMENDED`, plus an `Other...` free-text option - where pressing `Enter`
  through the wizard accepts every recommendation. `submit_plan` renders the
  plan as a scrollable card: `a` approves, `r` sends written feedback (`<-`
  returns to the card), `Esc` dismisses. **Approving flips the session to
  `BUILD` immediately and the same run continues into implementation.**

  Dismissing a plan asks for a better one rather than stopping - the agent is
  told to refine and resubmit - so the way out of a run is `Esc` twice: the
  first closes the card, the second aborts the run.

  Toggling mid-run is asymmetric on purpose: `build -> plan` applies at once,
  `plan -> build` is deferred to the end of the run (the status bar shows
  `PLAN -> BUILD` meanwhile) so a run launched under a read-only guarantee
  cannot start writing files because of one stray keypress.

  `aragon -p --plan "..."` registers no question or plan tool - there is nobody
  to ask - but the read-only gate still applies, so it means "tell me how you
  would do this, and do not touch my repository".

- Three flat config keys: `planModeDefault` (default `false`),
  `planModeMaxAskRounds` (default `4`, clamped `[1, 10]`) and
  `planModeHumanTimeoutMs` (default `1800000`, clamped `[60000, 7200000]`). All
  three are settable with `aragon config set`. Additive, as always: a config
  file written by an earlier version loads unchanged.

### Fixed

- A `--confirm` prompt no longer races the idle watchdog. Taking longer than
  `idleTimeoutMs` over `Proceed? (y/N)` used to abort the run with no
  explanation; every human wait now suspends the watchdog and restarts it in a
  `finally`.

- Honor an explicit `NODE_TLS_REJECT_UNAUTHORIZED=0` setting in the CLI and the
  official npm release workflow while hiding only Node's standard insecure-TLS
  warning. Other process warnings remain visible.

## 0.5.0

### Breaking

- **The package is renamed `@argon-agent/cli` → `@aragon-agent/cli`.** The brand
  was always meant to be *Aragon*, matching AragonMesh; the missing `a` was a
  typo that reached the registry. Install with:

  ```
  npm uninstall -g @argon-agent/cli
  npm install -g @aragon-agent/cli
  ```

  `@argon-agent/cli` is deprecated and receives no further releases. **The
  executable is still `aragon`** — the command you type does not change.

- **Environment variables are `ARAGON_*`, not `ARGON_*`.** There is no
  compatibility fallback: `ARGON_MODEL`, `ARGON_PROVIDER`, `ARGON_BASE_URL`,
  `ARGON_THINKING`, `ARGON_MAX_TOKENS`, `ARGON_THEME`, `ARGON_FULLSCREEN`,
  `ARGON_SKILLS`, `ARGON_SKILLS_DISABLED`, `ARGON_SKILLS_PATH` and
  `ARGON_REDUCED_MOTION` are all ignored from this release on. Rename them in
  your shell profile and CI. Provider keys (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`) are untouched.

- **The project-level skills directory is `.aragon/skills`, not
  `.argon/skills`.** This one lives in your repository, so rename it yourself:

  ```
  git mv .argon .aragon
  ```

  A config file that already persisted the old default keeps working — an
  explicitly saved `skills.projectDirs` still wins over the default — but the
  shipped default is now `['.aragon/skills', '.claude/skills']`. Update it with
  `aragon config set` if you want the new default.

### Added

- **Automatic migration of your user-level state.** On first run, 0.5.0 moves
  the `env-paths` config and data directories from `argon-agent` to
  `aragon-agent` — your API key, sessions and installed skills come with it, and
  each installed skill's `.argon-skill.json` manifest is renamed to
  `.aragon-skill.json` so `skills update` and `skills uninstall` still recognise
  it. The migration prints one line to **stderr**, runs once, and is skipped
  entirely if the new directory already exists. If it fails for any reason the
  CLI still starts; the old directory is never deleted when a cross-volume copy
  was needed.

- The opening wordmark now reads `ARAGON` and is 52 columns wide (was 44).
  Terminals between 52 and 55 columns show the single-line banner rather than a
  clipped wordmark.

- **Skills.** A skill is a directory holding a `SKILL.md` (YAML frontmatter +
  Markdown body) plus optional `reference/`, `scripts/` and `assets/`. Skills
  reach the model through three levels of progressive disclosure: a name +
  one-line "when to use" catalog in the system prompt (≤ 6 000 bytes total),
  the full body only when the model calls the `skill` tool, and bundled files
  only when it reads them with `read_file` / `bash`. A skill therefore costs a
  line of context rather than its whole body. How many fit in Level 1 depends on
  description length and language — roughly 30 with terse English descriptions,
  roughly 10 with Chinese ones at the character cap; past that the catalog
  truncates and `skill_find` covers the remainder.
- Four model-facing tools: `skill` (load), `skill_find` (search installed
  skills), `skill_install` (install from a local directory, git repo, or https
  `SKILL.md` / `.zip`) and `skill_create` (author a new one from a procedure the
  agent just worked out).
- **`aragon skills update <name> | --all`**, with `--dry-run`, `--force` and
  `--check`. Re-fetches from the source recorded in the install manifest,
  preserving `installedAt` and recording `updatedAt` / `previousVersion`. Refuses
  before downloading anything when the installed copy has local edits, and
  re-validates the source against the *current* `skills.allowedHosts` rather than
  the one in force at install time. Not exposed to the model.
- **Catalog ranking.** Level 1 entries are ordered by scope, then by how recently
  and often each skill was used, so truncation drops what you do not use rather
  than what sorts last alphabetically. With no usage data the order is unchanged.
- **`skill_find`**, advertised in the prompt only when the catalog actually
  truncated. Searches installed skills by name, description and keyword; never
  reaches the network, never returns `activation: manual` skills, and tells the
  model to ask for a source rather than invent one when nothing matches.
- **Cross-process install lock.** Install / create / remove / update take a
  per-directory advisory lock, closing a race in which two concurrent installs
  could interleave their atomic-replace steps and delete a skill with no error.
  Self-expires after 60 s; waits at most 5 s; only ever released by its owner.
- **Load-time integrity.** Discovery re-checks `SKILL.md` against the sha256
  recorded at install, at no extra I/O. `skills.integrity` selects
  `off` / `warn` (default) / `strict`.
- **Local usage counters** at `<data>/skill-usage.json` — skill name, count and
  timestamp only, never transmitted, disabled with `skills.usageTracking=false`.
  Automatically injected `activation: always` skills are not counted.
- Config keys `skills.integrity` and `skills.usageTracking`; `aragon skills list
  --sort=recent` and `/skills list --sort=recent`.
- Every usable skill also becomes a slash command: `/<skill-name> [args]`, with
  `$ARGUMENTS` / `$1..$9` substitution. On a name clash the built-in command
  always wins and the skill is reachable as `/skill:<name>`.
- `/skills` management: `list`, `info`, `install`, `remove`, `enable`,
  `disable`, `reload`, `create`, `trust`, `untrust`.
- `aragon skills …` non-interactive equivalents plus `path` and `doctor`.
  Exit codes follow `config set`: `0` ok, `1` run-time failure, `2` usage.
- Four discovery scopes in ascending precedence: bundled (`<pkg>/skills`), user
  (`<data>/skills`), project (`<cwd>/.aragon/skills` and, read-only,
  `<cwd>/.claude/skills` for Claude Code interop), and `ARAGON_SKILLS_PATH`.
- New flags `--no-skills`, `--skill <name>` (repeatable) and `--skills-yes`;
  env `ARAGON_SKILLS`, `ARAGON_SKILLS_PATH`, `ARAGON_SKILLS_DISABLED`; config keys
  `skills.enabled`, `skills.requireApproval`, `skills.catalogMaxBytes`,
  `skills.bodyMaxBytes`.
- One bundled skill, `skill-creator`, documenting how to write a good one.
- New runtime dependency: `fflate` (~30 KB, MIT, zero transitive deps) for zip
  extraction. `@aragon-agent/core` gains no dependency.
- **Release tooling for the scope change.** `npm run verify:brand` scans every
  file that `npm pack` would put in the tarball — README and `dist/` included —
  and blocks the release on any surviving `argon` reference, with only the four
  documented exceptions (the two CHANGELOGs and the legacy-state migration
  module, which hold the old names by definition). `packages/cli` also gains a
  `prepublishOnly: npm run build`, so a publish that bypasses
  `publish-latest.ps1` can no longer ship a `dist/` that is out of step with the
  sources. `deprecate-legacy.ps1` retires `@argon-agent/*` on the registry, and
  refuses to do so until the replacements are actually published.

### Changed

- The globally installed executable is now `aragon`. The previous `argon` and
  `argon-agent` aliases are no longer installed.
- `config/store.ts` now deep-merges the `skills` section on both read and write,
  the same treatment `apiKeys` already received. Without it a partial patch such
  as the one `/skills disable` sends would replace the whole section and
  silently discard `trustedProjectDirs`, `allowedHosts` and `requireApproval`.
- `slashSuggestions` accepts `-` and `:`, so kebab-case and `skill:`-namespaced
  commands autocomplete. Previously `/my-sk` produced no popup at all.
- `AgentController` now has a single `agent.setSystemPrompt()` call site, so a
  `/cwd` change can no longer drop the skill catalog out of the prompt.
- With skills off or none installed, the system prompt and the 7-tool array are
  byte-identical to the previous release.
- Added a repository-level PowerShell release workflow that automatically
  updates CLI and Core versions, synchronizes their dependency and lockfile,
  verifies both tarballs, and publishes them in dependency order.

### Security

- Installing a skill requires an explicit human approval that **probes for a
  human first and refuses when there is none**. Under `-p` there is no TUI and
  therefore no approver, so `skill_install` is refused with an actionable
  message rather than writing a third-party directory unattended. Use
  `--skills-yes` (or `skills.requireApproval=false`) to opt out deliberately.
- Project skill directories require a one-time trust confirmation before they
  are loaded — cloning an unfamiliar repository does not grant it the ability
  to inject instructions into your session.
- Git is invoked only via `execFile` with an argv array and `shell: false`, and
  owner / repo / ref / subdirectory fragments are whitelisted and refused if
  they begin with `-`. A leading dash matters even with a pure argv array:
  `--upload-pack=<program>` makes git execute that program.
- Zip extraction is streamed and gated on **actually written** bytes, per-entry
  size, compression ratio and entry count, all of which can abort mid-archive.
  The size a zip *declares* is written by whoever built it and is never trusted.
  Path traversal, absolute entries, symlinks and Windows device names are
  refused, and a rejected archive is removed rather than left half-extracted.
- Network fetches are `https:` only, restricted to `skills.allowedHosts`,
  re-checked on every redirect (max 3), size-capped, and refuse IP literals and
  loopback.
- Nothing a skill ships is executed at install time, and the executable bit is
  not preserved. Scripts run only when the model invokes `bash` explicitly.
  There is no sandbox: approval blocks *silent* installation, it does not make
  a skill you approved safe.

## 0.3.0

A full-screen TUI release. `@argon-agent/core` is untouched, no new runtime
dependency is added, and the headless/print contract, exit codes, and
slash-command semantics are unchanged. The 0.2.0 inline renderer remains
available in full via `--no-fullscreen`.

### Added

- **Full-screen mode (default).** `aragon` now takes over the terminal's
  alternate screen buffer — the same mechanism `vim` / `htop` / `lazygit` use.
  Your shell history is covered, not erased, and comes back untouched on exit.
  The frame is a fixed `rows - 1` tall, so **the composer and the status bar sit
  at the physical bottom of the screen from the very first frame**: empty
  session, long session, mid-scroll, or overlay open.
- **Brand region.** A six-row gradient ASCII wordmark on a roomy empty session,
  degrading to a banner, then a single-line bar, then a bare wordmark as space
  runs out. Row 1 always begins with the brand glyph.
- **Self-drawn scrolling.** `PgUp` / `PgDn` by the page, `Shift+↑` / `Shift+↓` by
  the line. The viewport auto-follows new output while pinned to the bottom;
  scrolling away shows `↑N` in the status bar plus a "N new lines" hint, and
  submitting a message always re-pins.
- **Exit replay.** After leaving the alternate screen the session is replayed
  into the normal buffer as plain, colorless text, so the conversation does not
  evaporate with the screen. Turn it off with `--no-exit-transcript`.
- **New flags** `--fullscreen` / `--no-fullscreen` / `--no-exit-transcript`, the
  env var `ARGON_FULLSCREEN=0|1`, and the config keys `fullscreen`,
  `exitTranscript`, and `transcriptWindow`.
- **Automatic downgrade.** A non-TTY stdout, `TERM=dumb`, CI, and terminals under
  12 rows / 40 columns fall back to the inline renderer. Only the non-TTY gate is
  un-overridable — `--fullscreen` beats the rest.

### Changed

- The status bar lost its round border and is now exactly one row; it had been
  spending an eighth of a 24-row terminal framing a single line of text.
- The toast strip holds a fixed row in full-screen mode, so the transcript no
  longer jumps as toasts appear and expire.
- The composer is a rounded frame whose border color reports state (idle, has a
  draft, running, blurred by an overlay), with the completion popup above it.
- `Ctrl+L` repaints the frame instead of writing a clear sequence. Ink dedupes
  identical output at two separate gates, so under a fixed frame the old
  approach erased the screen and then declined to redraw it.
- `Shift+↑` / `Shift+↓` no longer recall prompt history — they scroll.
- Full-screen mode routes `console.*` into the transcript as notices rather than
  letting Ink write them straight to stdout, which corrupts the frame's line
  accounting.

### Known trade-offs

- The terminal's native scrollback and mouse wheel do not scroll the transcript
  in full-screen mode; use `PgUp` / `PgDn`, or run with `--no-fullscreen`.
- Mouse tracking is deliberately left off: enabling it costs text selection and
  copy in most terminals.
- Should a crash ever strand your terminal on the alternate screen, `reset`
  restores it. Four independent restore paths exist to prevent that: normal
  exit, `process.exit`, `SIGINT` / `SIGTERM` / `SIGHUP`, and Ink's own signal
  handling.

## 0.2.0

A design-elevation & HCI-hardening release. No breaking changes: `@argon-agent/core`
is untouched, no new runtime dependency is added, and the headless/print contract,
exit codes, config keys, and slash-command semantics from 0.1.0 are unchanged.

### Added

- **Real theming engine.** Distinct `dark` / `light` palettes with an `auto`
  resolution (`auto → dark`), color degradation across terminal depth
  (truecolor → 256 → 16 → monochrome), and an ASCII glyph fallback for terminals
  without Unicode. Honors `NO_COLOR`, `FORCE_COLOR`, `--no-color`, and
  `TERM=dumb`. Switch live with `/theme <auto|dark|light>` (persisted).
- **Elegant chrome.** A gradient wordmark header that collapses to a slim sticky
  bar after the first turn, a first-run **Welcome / empty-state** card, and a
  status bar with a colored **context gauge** (threshold colors), a **tokens/sec**
  read-out while running, and a contextual hint.
- **Legible tool output.** Colored unified diffs (green adds / red removes) and
  per-tool rich previews (`edit_file`/`write_file`/`read_file`/`bash`/`list_dir`/
  `glob`). Long previews collapse to 8 lines and expand with `Ctrl+O` or
  `/expand [n]`.
- **Autocomplete.** A slash-command palette and `@file` path completion popup
  (`Tab`/`→` to complete, `Up`/`Down` to move, `Esc` to close).
- **Full line editing.** Home/End, word jump/delete, kill-to-start/end, and
  multi-line vertical cursor navigation, with prompt-history recall at the edges.
  Unknown control/escape sequences are dropped instead of inserted.
- **Reliability under load.** Ink `<Static>` finalization for settled entries and
  a streaming delta coalescer, so long/fast sessions stay flicker-free.
- **Calm feedback.** Ephemeral, auto-dismissing **toasts** for transient acks;
  the transcript keeps only durable content (messages, tool cards, run errors).
- `reducedMotion` config (also `ARGON_REDUCED_MOTION`; implied by `--no-color`)
  replaces spinners with a static glyph.

### Changed

- History scrollback now uses the **native terminal scrollback** that `<Static>`
  prints into (this supersedes the never-implemented `PgUp`/`PgDn` promise).

## 0.1.0

Initial release — a Claude-Code / Codex-style interactive terminal UI (TUI) on
top of `@argon-agent/core`.

### Added

- **Interactive TUI** (React + Ink): gradient header, streaming transcript with
  markdown + syntax highlighting, collapsible thinking blocks, live tool-call
  cards, a status bar (model / context % / tokens / cost / elapsed), and modal
  overlays (settings, model picker, help, confirm).
- **Built-in toolset** wired into the core agent at full permission:
  `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`.
- **Layered configuration** (defaults → user file → env/`.env` → flags) with
  live in-TUI editing of provider / model / base URL / API keys / thinking level
  / max tokens. Secrets are masked and the config file is written `0600` on POSIX.
- **One-shot / print mode** (`argon -p`) for scripting and piping, plus
  `argon config` / `argon config set` / `argon config path` / `argon models`.
- **Session control**: abort (Esc), steer-while-running, follow-up queue,
  double-Ctrl-C exit, `/save` / `/resume` JSON sessions.
- **Timeout invariant** (`idleTimeout ≥ toolTimeout`) so a long single tool run
  is never killed by the idle watchdog.
- **Never-silent failures**: pre-flight API-key validation, error-StreamEvent
  rendering, and a guard that surfaces a swallowed agent error instead of a
  blank no-op (headless exits `1`/`2` accordingly).
