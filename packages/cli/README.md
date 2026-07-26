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
| `--no-skills` | Disable the skill system entirely (no catalog, no skill tools) |
| `--skill <name>` | Force-load a skill's full body for this run (repeatable) |
| `--skills-yes` | Approve skill installs for this run (CI / headless) |
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
| `/skills [sub]` | List and manage skills (see below) |
| `/<skill-name> [args]` | Run an installed skill directly |
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

When skills are enabled, four more are added — the two read tools `skill` and
`skill_find`, then the two mutating ones `skill_install` and `skill_create` (see
below). `--no-skills` removes them again. Updating a skill is deliberately not
among them; that is a `aragon skills update` decision for you, not the model.

## Skills

A skill is a reusable expert procedure stored on disk: a directory containing a
`SKILL.md` (YAML frontmatter + Markdown body) and, optionally, `reference/`,
`scripts/` and `assets/`. The format matches Claude Code's, so an existing
community skill directory works as-is.

### Progressive disclosure

This is the part that makes skills cheap enough to install a lot of:

| Level | What the model gets | When |
| --- | --- | --- |
| 1 | Name, scope, and a one-line "what + when" | Always, in the system prompt. Whole catalog capped at 6 000 bytes. |
| 2 | The full `SKILL.md` body + a list of bundled files | Only when the model calls `skill(name=…)` |
| 3 | The bundled files themselves | Only when it reads them with `read_file` / `bash` |

A skill costs a line in the prompt rather than its whole body, so installing
many of them stays cheap. The model decides on its own whether a task matches a
skill — you do not have to name one.

At Level 2 the file list is split into what to read and what to run, and carries
the skill's absolute root so the model can build real paths. The accompanying
guidance is **platform-specific**: on Windows the `bash` tool runs `cmd.exe`, so
the model is told to run `.py` with `python <abs path>` and that a `.sh` file
will not work — rather than the previous, flatly untrue "run scripts with bash".
`aragon skills doctor` warns when a skill bundles only scripts for the other
shell.

**How many fit in Level 1 depends on your descriptions, and on the language they
are written in.** The 6 000-byte ceiling is measured in UTF-8 bytes: a terse
English description costs roughly 180 bytes a line (~30 skills), while a Chinese
one at the 220-character cap can cost 660 (~10 skills). Past that point the
catalog truncates.

Truncation is not a dead end. Entries are ranked before it happens, and what
falls off is still reachable:

- **Ranking**: scope first (`env` > `project` > `user` > `bundled`), then how
  recently and how often you have actually used each skill. A skill you ran an
  hour ago outranks one you have never used, so what survives truncation is what
  you actually work with — not whatever sorts first alphabetically.
- **`skill_find`**: when the catalog *does* truncate, it says so and names this
  tool, which searches everything installed by name, description and keyword.
  It only ever searches **what is already on this machine** — it never reaches
  the network and never suggests something to install.

Both are off the critical path: with no usage data recorded the order is exactly
the plain scope-then-name order, and `skill_find` is only advertised in the
prompt when something was actually omitted.

### Using them

```bash
aragon skills list [--sort=recent]          # what is installed
aragon skills info <name>                   # version, path, provenance, files
aragon skills install <source> [--yes]      # dir | git repo | https .md / .zip
aragon skills install github:owner/repo#v1.2.0
aragon skills update <name> [--yes] [--force] [--dry-run]
aragon skills update --all [--yes]          # every skill that has an upstream
aragon skills update --check [<name>|--all] # is there a newer version?
aragon skills remove <name> [--yes]
aragon skills create <name> --description "what + when" [--yes]
aragon skills path                          # user skills directory
aragon skills doctor                        # validate + detect tampering
aragon skills usage [--json]                # local use counters
aragon skills usage --reset --yes           # delete them
aragon skills trust <dir>                   # allow a project skills directory
```

#### Updating

`update` re-fetches a skill from the source recorded in its install manifest,
keeping `installedAt` and recording `updatedAt` + `previousVersion`.

- **Local edits are protected.** If you have changed an installed skill, `update`
  refuses and names the files, *before downloading anything*. `--force`
  overwrites them — and **`--force` discards your edits**; copy them out first.
  The replaced directory is parked under the staging trash, so a mistake is
  recoverable by hand.
- **The host allowlist is re-checked** against your *current*
  `skills.allowedHosts`, not the one in force when you installed. Narrowing that
  list therefore also constrains updates.
- **`--all` never stops on one failure.** Skills that cannot be updated
  (hand-authored, bundled, or locally modified) are reported as `skipped`, which
  is not an error; only a genuine I/O or validation failure exits non-zero.
- **`--check` reports `unknown` freely.** It compares the commit recorded at
  install time against `git ls-remote`, so it can only answer for git sources
  installed by a version that records one. Anything else is honestly reported as
  unknown rather than guessed.
- **The model cannot call `update`.** Installing is something you pointed it at;
  swapping working instructions for different ones is a maintenance decision and
  stays with you.

Interactively the same lives under `/skills …` (`/skills update <name> [--force]`,
`/skills update --all`, `/skills list --sort=recent`, `/skills policy [mode]`,
`/skills unload`, `/skills usage [--reset]`). Every usable skill also becomes a
slash command:

```
/pdf-forms invoice.pdf --flatten
```

Both delivery paths share `skills.bodyMaxBytes`, so an oversized `SKILL.md` is
truncated with a visible marker rather than submitted whole. Loading the same
skill twice in one conversation returns a short digest (description, file list,
guidance) instead of a second copy of the body; the model can ask for the full
text back with `skill(name="…", force=true)`.

Bodies may use `$ARGUMENTS` and `$1..$9`; `$$` is a literal `$`. If a skill
declares no placeholder, the arguments are appended under an `## Arguments`
heading instead. Where a skill's name collides with a built-in command, the
**built-in wins** and the skill is reachable as `/skill:<name>`.

### Where skills come from

Four scopes, later ones overriding earlier ones by name:

| Scope | Location | Writable |
| --- | --- | --- |
| `bundled` | `<package>/skills/` | no |
| `user` | `aragon skills path` | yes — the default install target |
| `project` | `<cwd>/.argon/skills/` | yes |
| `project` | `<cwd>/.claude/skills/` | no — read-only Claude Code interop |
| `env` | `ARGON_SKILLS_PATH` (`:`/`;`-separated) | no |

A shadowed skill is not lost: `/skills` shows it as `~shadowed by <scope>`.

### Frontmatter

```yaml
---
name: pdf-forms          # required, kebab-case, ≤ 64 chars
description: Fill, flatten and validate AcroForm PDFs. Use when the task
  mentions PDF forms, field filling, or flattening a fillable PDF.
version: 1.2.0
license: MIT
author: Jane Doe
homepage: https://github.com/jane/pdf-forms
keywords: [pdf, forms]
allowed-tools: [read_file, bash]   # enforced as a per-turn tool ceiling (union)
activation: auto                   # auto | always | manual
---
```

`description` is the only text a model sees before deciding to load the skill,
so it has to say both what the skill does and when to use it. Unknown keys are
preserved, so a newer Claude Code field will not break parsing.

`activation: always` injects the body into every session's system prompt (12 000
bytes total across all such skills); `manual` keeps it out of the catalog so it
runs only when explicitly invoked.

### Security model — and its limits

Be clear about what this does and does not buy you:

- **Installing requires a human.** The approval gate checks whether a person is
  actually reachable *before* asking, and refuses when nobody is. Under `-p`
  there is no TUI and therefore no approver, so `skill_install` fails with an
  actionable message instead of writing to disk unattended. Opt out
  deliberately with `--skills-yes` or `skills.requireApproval=false`.
- **Project directories need trusting once.** Cloning an unfamiliar repository
  does not grant it the right to inject instructions into your session.
- **Nothing is executed at install time.** No postinstall, no dependency
  install; the executable bit is not preserved. Scripts run only when the model
  invokes `bash`.
- **Archives are gated on real bytes** — total size, per-entry size, compression
  ratio and entry count, all abortable mid-extraction. Path traversal,
  absolute paths, symlinks and Windows device names are refused.
- **Git is never run through a shell**, and ref / owner / repo fragments are
  whitelisted and refused if they start with `-`.
- **Third-party text cannot break out of its prompt block**: angle brackets in
  descriptions, bodies and file names are neutralized before rendering.

- **A changed `SKILL.md` is noticed at load time.** Every install records a
  sha256; discovery re-checks the one file that reaches the model's context and
  flags it as `!modified` if it no longer matches what you approved. See
  `skills.integrity` below.
- **Concurrent installs cannot corrupt a skill.** Writes take a per-directory
  advisory lock, so two `aragon` processes installing at once queue instead of
  interleaving their atomic-replace steps. *Limit:* the lock relies on exclusive
  file creation, which is not reliably atomic on every NFS implementation. It
  self-expires after 60 seconds and waits at most 5, so the worst case there is
  no mutual exclusion — never a hang.

What it does **not** do: there is **no sandbox**. Approval blocks *silent*
installation; it does not make a skill you approved safe. A skill you accept can
contain adversarial instructions, and its scripts run with your full user
permissions — the same trust model as pasting text into the prompt and the same
as the `bash` tool. `/skills info` records provenance and a sha256 per file so
you can audit what arrived and notice if it changed. The integrity check answers
"is this still the file I approved?", **not** "is this file from someone I
trust" — there is no signing and no key distribution.

`allowed-tools` **is** enforced now (see below), but read the next section before
treating it as a permission boundary: it is blast-radius control, not a security
boundary, and a skill can widen its own ceiling by loading another skill.

### The tool ceiling (`allowed-tools`)

A skill that declares `allowed-tools` constrains which tools the model may use
**for the rest of the current turn**:

```yaml
allowed-tools: [read_file, write_file]
```

- **Scope is one turn.** The ceiling appears when a skill is loaded — by the
  model calling `skill(...)`, or by you running `/<skill-name>` — and it is gone
  as soon as you send the next message. A skill you used this morning does not
  restrict unrelated work this afternoon.
- **Read-only tools are always allowed**, declared or not: `read_file`,
  `list_dir`, `glob`, `grep`, plus `skill` and `skill_find`. What the declaration
  actually controls is the five tools that change something — `write_file`,
  `edit_file`, `bash`, `skill_install`, `skill_create`.
- **Claude Code names work.** `[Read, Bash, MultiEdit]` maps onto this host's
  `read_file` / `bash` / `edit_file`. Tools that exist there but not here
  (`WebFetch`, `Task`, `TodoWrite`, …) are ignored rather than treated as errors.
- **A name we cannot resolve waives the whole declaration**, and says so. One
  typo means that skill imposes no ceiling at all — never a narrower one you did
  not write. `aragon skills doctor` reports these up front.
- **`activation: always` skills never impose a ceiling.** They are ambient
  reference material, not a procedure you chose to run.

Three modes, via `skills.toolPolicy` (default `enforce`),
`aragon --skill-tool-policy <mode>` for one run, or `/skills policy <mode>` for
the current session (which takes effect immediately, even mid-turn):

| Mode | Behaviour |
| --- | --- |
| `enforce` | The call is refused; the model is told what it may use instead. |
| `warn` | The call runs, and you get one notice per tool per turn. |
| `off` | No ceiling, and nothing about `allowed-tools` reaches the model. |

`/skills unload` drops the ceiling for the current turn. It does **not** remove
skill text already in the conversation — nothing can.

**What this is and is not.** It is **blast-radius control, not a security
boundary**. The declaration is written by the skill's own author, so a malicious
skill can simply declare `[bash]`. Its value is that a declaration is now
binding: you can read one in `/skills info` and decide whether to install, and an
honest author's `[read_file]` means a "while you're there, run `rm -rf`" line
smuggled into that skill's text — or into a file it tells the model to read —
cannot execute.

**And a known limit:** the ceiling is a **union** across every skill loaded this
turn, and `skill` is always available. So a skill can widen its own ceiling by
instructing the model to load a second, more permissive skill. This is not
blocked — blocking it would either strand the model inside a skill it cannot
escape, or break every multi-skill workflow — but every widening is printed to
the transcript:

```
Tool ceiling widened by skill "skill-creator": +write_file, +skill_create
```

So it stops the smuggled instruction; it does not stop a skill that deliberately
teaches the model to reach for another one.

### Usage counters

To rank the catalog, the CLI keeps a small file next to your skills directory:

```jsonc
// <aragon skills path>/../skill-usage.json
{ "schema": 1, "skills": { "deploy-preview": { "useCount": 12, "lastUsedAt": 1785050000000 } } }
```

**It contains the skill name, a count, and a timestamp. Nothing else** — no
arguments, no conversation content, no working directory, no machine identifier.
It is never transmitted anywhere, by anything. Delete it whenever you like; the
only effect is that the catalog falls back to plain scope-then-name order. Set
`skills.usageTracking=false` to switch it off entirely, after which the file is
neither read nor written.

Automatically injected `activation: always` skills are deliberately **not**
counted — they load on every turn, so counting them would say nothing about what
you actually use.

## Configuration

Config is layered (highest priority last): **defaults → user config file →
env / `.env` → CLI flags**.

- **Env / `.env`**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_API_KEY` / `GEMINI_API_KEY`, plus `ARGON_PROVIDER`, `ARGON_MODEL`,
  `ARGON_BASE_URL`, `ARGON_THINKING`, `ARGON_MAX_TOKENS`, `ARGON_THEME`,
  `ARGON_FULLSCREEN`, `ARGON_SKILLS` (`0` disables), `ARGON_SKILLS_PATH`,
  `ARGON_SKILLS_DISABLED` (comma-separated names).
- **User config file** (`aragon config path`): JSON, written `0600` on POSIX.
  Holds provider/model/keys and MRU lists. Keys are masked in the UI and never
  logged.

| Config key | Default | Meaning |
| --- | --- | --- |
| `fullscreen` | `true` | Use the full-screen TUI (still subject to the automatic downgrades). Setting it to `false` opts out permanently; leaving it `true` is *not* a force — only `--fullscreen` / `ARGON_FULLSCREEN=1` override the heuristics. |
| `exitTranscript` | `true` | Replay a plain-text session summary after exiting (full-screen only). |
| `transcriptWindow` | `300` | How many trailing entries the full-screen viewport renders, clamped to `[50, 2000]`. The full history stays in memory and in `/save`. |
| `skills.enabled` | `true` | Master switch for the skill system. |
| `skills.requireApproval` | `true` | Require a human to approve `skill_install` / `skill_create`. |
| `skills.catalogMaxBytes` | `6000` | Level 1 catalog ceiling, in UTF-8 **bytes**, clamped to `[500, 40000]`. |
| `skills.bodyMaxBytes` | `30000` | Level 2 body ceiling, in UTF-8 **bytes**, clamped to `[1000, 50000]`. |
| `skills.allowedHosts` | GitHub / GitLab hosts | Hosts an install **or update** may fetch from. Re-checked on every update, not just at install time. |
| `skills.disabled` | `[]` | Skill names switched off. |
| `skills.trustedProjectDirs` | `[]` | Project skill directories you have trusted. |
| `skills.integrity` | `warn` | What to do when `SKILL.md` no longer matches the copy you approved. `off` skips the check; `warn` flags it in `/skills list` and once per session; `strict` removes it from the catalog and makes `skill()` refuse it. Defaults to `warn` because editing an installed skill is a legitimate thing to do — `strict` suits CI and managed environments. |
| `skills.usageTracking` | `true` | Keep local per-skill use counters to rank the catalog. Name, count and timestamp only; never transmitted. Inspect with `aragon skills usage`, erase with `--reset --yes`. |
| `skills.toolPolicy` | `enforce` | How hard a skill's `allowed-tools` bites, for the turn it is loaded in. `off` disables it and says nothing about it to the model; `warn` runs the tool and reports it; `enforce` refuses. Unlike `skills.integrity`, a false positive here means a skill AUTHOR under-declared their own skill — which `aragon skills doctor` reports before it can bite. |

Byte, not character: `ToolExecutor` truncates at 100 000 **bytes**, so a
character-based budget would be roughly triple its nominal size for CJK text
and would get cut mid-tag.

These are additive: a config file written by an earlier version loads
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
