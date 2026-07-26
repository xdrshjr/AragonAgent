# Changelog

All notable changes to `@argon-agent/cli` are documented here.

## Unreleased

### Breaking

- The globally installed executable is now `aragon`. The previous `argon` and
  `argon-agent` aliases are no longer installed; the npm package name remains
  `@argon-agent/cli`.

### Changed

- Added a repository-level PowerShell release workflow that automatically
  updates CLI and Core versions, synchronizes their dependency and lockfile,
  verifies both tarballs, and publishes them in dependency order.

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
