# Changelog

All notable changes to `@argon-agent/cli` are documented here.

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
