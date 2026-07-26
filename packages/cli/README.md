# @argon-agent/cli

A Claude-Code / Codex-style **interactive terminal UI** for the
[`@argon-agent/core`](../core) engine. Type a task, watch the agent think and
stream its answer, see each tool call render as a live card, and interrupt /
steer / configure the session — all without leaving the terminal.

> ⚠️ **Full permission, no sandbox.** This first version runs at **maximum
> permission**: `bash` executes directly, file writes hit the real filesystem,
> and there is **no per-action approval gate by default**. Only run it in
> workspaces you trust. An opt-in confirmation mode is available via `--confirm`.

## Install

```bash
# Global
npm i -g @argon-agent/cli
aragon

# Zero-install
npx @argon-agent/cli
```

> **Release note (R3):** `npx @argon-agent/cli` resolves `@argon-agent/core`
> from the npm registry, so `@argon-agent/core@^0.1.0` must be published first
> (or bundled into the CLI `dist`). During local development inside this
> monorepo, npm workspaces link the local `packages/core` automatically.

## Quick start

```bash
# Set a key (any one of these)
export ANTHROPIC_API_KEY=sk-ant-...
# ...or paste it live in the TUI via /settings, or pass --api-key

aragon                       # interactive TUI
aragon "summarize README.md" # interactive, auto-submitting the prompt
echo "list files" | aragon -p   # one-shot, prints to stdout then exits
```

## Usage

```
aragon [prompt]                 Start the interactive TUI (or one-shot with -p / piped stdin)
aragon -p, --print [prompt]     Headless: stream the answer to stdout, then exit
aragon config                   Open the settings screen
aragon config set <key> <value> Non-interactive config write (e.g. model, provider)
aragon config path              Print the config file path
aragon models [--provider p]    List builtin + discovered models
aragon --version | -v           Print the version
aragon --help  | -h             Print help
```

### Global flags

| Flag | Meaning |
| --- | --- |
| `--provider <id>` | `anthropic` \| `openai` \| `google` |
| `--model <id>` | Model id |
| `--base-url <url>` | Override the provider base URL (OpenAI-compatible endpoints) |
| `--api-key <key>` | One-shot key override (not persisted) |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `--max-tokens <n>` | Output token cap |
| `--cwd <dir>` | Working directory for tools |
| `--confirm` | Confirm each mutating tool call |
| `--tool-timeout <ms>` | Per-tool executor ceiling (default 180000) |
| `--idle-timeout <ms>` | Watchdog idle timeout (auto-raised to ≥ tool-timeout + 30s) |
| `--theme <name>` | `auto\|warm\|cool\|light` (`dark` is a compatibility alias for `cool`) |
| `--compact` / `--no-compact` | Transcript density: no blank rows between turns, or the default |
| `--hints` / `--no-hints` | Show or hide the composer hint row |
| `--fullscreen` | Force the full-screen TUI, overriding the automatic downgrades |
| `--no-fullscreen` | Force the inline renderer (the 0.2.0 behavior) |
| `--no-exit-transcript` | Do not replay the session summary after exiting |
| `--no-color` | Disable ANSI color |
| `--quiet` | (print mode) suppress tool/usage lines on stderr |

Exit codes: `0` success · `1` agent/runtime error · `2` config/usage error ·
`130` interrupted.

## Slash commands (interactive)

| Command | Action |
| --- | --- |
| `/help` | Keybindings + command help |
| `/model` | Open the model picker |
| `/settings` | Open the settings screen |
| `/thinking <level>` | Set the thinking level |
| `/tools` | List active tools |
| `/clear` | Clear the visible transcript |
| `/reset` | New conversation |
| `/cwd [dir]` | Show / change the tool working directory |
| `/save [file]` | Save the session to JSON |
| `/resume [file]` | Load a saved session |
| `/theme <auto\|warm\|cool\|light>` | Switch the color theme live (persisted) |
| `/expand [n]` | Expand / collapse the n-th-from-last (default last) tool card |
| `/copy` | Copy the last answer to the clipboard |
| `/exit` (`/quit`) | Exit |

A leading `/` meant literally can be escaped as `//`. Typing `/` opens a
command palette and `@` opens a file-path completion popup — `Tab` / `→`
completes, `Up` / `Down` moves the selection, `Esc` closes it.

## Keybindings

| Key | Action |
| --- | --- |
| `Enter` | Submit (idle) / queue a steering message (running) |
| `Alt+Enter` / `Shift+Enter` | Insert a newline |
| `Esc` | Abort the run / close an overlay / close a popup |
| `Ctrl+C` ×2 | Exit (first press warns) |
| `Ctrl+L` | Redraw the frame (clear the screen in inline mode) |
| `Ctrl+T` | Toggle thinking blocks |
| `Ctrl+O` | Expand / collapse the most recent tool card |
| `PgUp` / `PgDn` | Scroll the transcript a page (full-screen mode) |
| `Shift+↑` / `Shift+↓` | Scroll the transcript a line (full-screen mode) |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Cursor to line start / end |
| `Alt/Ctrl+←` / `→` | Word-wise cursor jump |
| `Ctrl+W`, `Alt+Backspace` | Delete the previous word |
| `Ctrl+U` / `Ctrl+K` | Kill to line start / end |
| `Up` / `Down` | Move between draft lines; recall prompt history at the edges |
| `?` | Open help (empty input) |

In **full-screen mode** the transcript is scrolled by the app itself: `PgUp` /
`PgDn` and `Shift+↑` / `Shift+↓`. While pinned to the bottom the viewport follows
new output automatically; once you scroll away the status bar shows `↑N` and a
hint counts the lines below you. Submitting a message always re-pins to the
newest output. In **inline mode** (`--no-fullscreen`) history lives in your
terminal's native scrollback, printed once via Ink `<Static>`.

## Themes

Three palettes plus `auto`:

| Name | Look |
| --- | --- |
| `warm` | Terracotta + amber over warm neutrals. The default (`auto` resolves here). |
| `cool` | The blue/violet palette that shipped as `dark` through 0.3.x. |
| `light` | For light terminal backgrounds. |

`auto` never guesses `light`: terminals cannot report their background reliably,
and guessing wrong makes the app unreadable rather than merely wrong-looking.

**Migrating from 0.3.x** — `dark` was renamed `cool` when `warm` became the
default, and the old name still works everywhere: `--theme dark`,
`aragon config set theme dark`, `/theme dark`, and a config file containing
`"theme": "dark"` all resolve to `cool`, so a screen you explicitly chose does
not change under you. The value is rewritten as `cool` the next time the config
is saved. Only users who never picked a theme see the new default.

Density and hints are settable the same three ways: `--compact` / `--no-hints`
for one run, `aragon config set density compact` / `aragon config set hints false`
to persist. The composer hint row also shortens to `? help` on its own after a
few sessions — except while a run is in progress, when it always spells out
`esc abort` in full.

## Full-screen mode

`aragon` takes over the terminal's **alternate screen buffer** — the mechanism
`vim`, `htop`, and `lazygit` use. Two consequences worth knowing:

- Your previous shell output is **covered, not erased**, and returns untouched
  when you exit. Nothing in your scrollback is destroyed.
- The frame is fixed at `rows - 1` tall, which is what keeps the composer and the
  status bar at the bottom of the screen even on an empty session.

On exit the session is replayed into the normal buffer as plain text so the
conversation survives leaving the screen (`--no-exit-transcript` opts out;
`/save` still exports the full JSON).

It downgrades to the inline renderer automatically when stdout is not a TTY,
`TERM=dumb`, a CI environment variable is set, or the terminal is under 12 rows
or 40 columns. `--fullscreen` overrides all of those except the non-TTY check —
writing screen-control sequences into a pipe or a redirected file is never safe.
`--no-fullscreen`, `ARGON_FULLSCREEN=0`, or `aragon config set fullscreen false`
opt out permanently.

The terminal's native scrollback and mouse wheel do not scroll the transcript in
this mode, and mouse tracking is deliberately left off because enabling it costs
text selection and copy in most terminals. If a crash ever strands your terminal
on the alternate screen, `reset` restores it.

## Built-in tools

`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash` — all
at full permission. Paths resolve against the session working directory. The
per-tool timeout and 100 KB output truncation are enforced by the core executor;
`bash`'s `timeout` param only shrinks within that ceiling.

## Configuration

Config is layered (highest priority last): **defaults → user config file →
env / `.env` → CLI flags**.

- **Env / `.env`**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY` / `GEMINI_API_KEY`, plus `ARGON_PROVIDER`, `ARGON_MODEL`,
  `ARGON_BASE_URL`, `ARGON_THINKING`, `ARGON_MAX_TOKENS`, `ARGON_THEME`,
  `ARGON_FULLSCREEN`.
- **User config file** (`aragon config path`): JSON, written `0600` on POSIX.
  Holds provider/model/keys and MRU lists. Keys are masked in the UI and never
  logged.

| Config key | Default | Meaning |
| --- | --- | --- |
| `fullscreen` | `true` | Use the full-screen TUI (still subject to the automatic downgrades). Setting it to `false` opts out permanently; leaving it `true` is *not* a force — only `--fullscreen` / `ARGON_FULLSCREEN=1` override the heuristics. |
| `exitTranscript` | `true` | Replay a plain-text session summary after exiting (full-screen only). |
| `transcriptWindow` | `300` | How many trailing entries the full-screen viewport renders, clamped to `[50, 2000]`. The full history stays in memory and in `/save`. |

All three are additive: a config file written by an earlier version loads
unchanged, with no migration and no version bump.

### Theming & color

`--theme` / `config.theme` / `/theme` pick a palette: `warm`, `cool`, `light`, or
`auto` (which resolves to `warm` — terminals can't reliably report their
background). `dark` remains accepted everywhere as an alias for `cool`.
Colors degrade automatically to your terminal's depth (truecolor → 256 → 16 →
monochrome) and glyphs fall back to ASCII on terminals without Unicode. Color is
disabled — and the UI renders plain monochrome with ASCII glyphs — when any of
`NO_COLOR`, `--no-color`, `TERM=dumb`, or `config.color=false` is set; `FORCE_COLOR`
is respected. `reducedMotion` (also `ARGON_REDUCED_MOTION`, and implied by
`--no-color`) replaces spinners with a static glyph.

### Timeout invariant

The core idle watchdog (60 s by default) is **shorter** than the tool timeout
(120 s), so a long single tool run (a build, `npm install`) would be killed
mid-run. The CLI fixes this by always constructing the agent with
`idleTimeout ≥ toolTimeout` (defaults 210 s ≥ 180 s), re-derived after config
merge. Raise both `--tool-timeout` / `--idle-timeout` for genuinely long jobs.

## Development

```bash
npm run build -w packages/cli   # tsc + shebang → dist/cli.js
npm test    -w packages/cli     # vitest
node packages/cli/dist/cli.js --version
```

### Manual smoke checklist

- `npm run build -w packages/cli` produces an executable `dist/cli.js` with a
  shebang; `node packages/cli/dist/cli.js --version` prints the version.
- `npm pack -w packages/cli --dry-run --json` lists `dist/cli.js` under `files`.
- With `ANTHROPIC_API_KEY` set: `aragon` streams a reply, a tool card renders,
  `Esc` aborts mid-run, `/model` switches models, `/settings` saves a key,
  `Ctrl+C` twice exits.
- `echo "list files" | node dist/cli.js -p` prints an answer and exits `0`.
- A missing/invalid key produces a visible, actionable message (never a blank
  screen), both in the TUI and headless.

## License

MIT
