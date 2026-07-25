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
argon

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

argon                       # interactive TUI
argon "summarize README.md" # interactive, auto-submitting the prompt
echo "list files" | argon -p   # one-shot, prints to stdout then exits
```

## Usage

```
argon [prompt]                 Start the interactive TUI (or one-shot with -p / piped stdin)
argon -p, --print [prompt]     Headless: stream the answer to stdout, then exit
argon config                   Open the settings screen
argon config set <key> <value> Non-interactive config write (e.g. model, provider)
argon config path              Print the config file path
argon models [--provider p]    List builtin + discovered models
argon --version | -v           Print the version
argon --help  | -h             Print help
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
| `--theme <name>` | `auto\|dark\|light` |
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
| `/theme <auto\|dark\|light>` | Switch the color theme live (persisted) |
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
| `Ctrl+L` | Clear the screen |
| `Ctrl+T` | Toggle thinking blocks |
| `Ctrl+O` | Expand / collapse the most recent tool card |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Cursor to line start / end |
| `Alt/Ctrl+←` / `→` | Word-wise cursor jump |
| `Ctrl+W`, `Alt+Backspace` | Delete the previous word |
| `Ctrl+U` / `Ctrl+K` | Kill to line start / end |
| `Up` / `Down` | Move between draft lines; recall prompt history at the edges |
| `?` | Open help (empty input) |

History scrollback lives in your terminal's **native scrollback** (settled
turns are printed once via Ink `<Static>`); scroll the terminal to review them.

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
  `ARGON_BASE_URL`, `ARGON_THINKING`, `ARGON_MAX_TOKENS`, `ARGON_THEME`.
- **User config file** (`argon config path`): JSON, written `0600` on POSIX.
  Holds provider/model/keys and MRU lists. Keys are masked in the UI and never
  logged.

### Theming & color

`--theme` / `config.theme` / `/theme` pick a palette: `dark`, `light`, or `auto`
(which resolves to `dark` — terminals can't reliably report their background).
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
- With `ANTHROPIC_API_KEY` set: `argon` streams a reply, a tool card renders,
  `Esc` aborts mid-run, `/model` switches models, `/settings` saves a key,
  `Ctrl+C` twice exits.
- `echo "list files" | node dist/cli.js -p` prints an answer and exits `0`.
- A missing/invalid key produces a visible, actionable message (never a blank
  screen), both in the TUI and headless.

## License

MIT
