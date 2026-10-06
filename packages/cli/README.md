# @aragon-agent/cli

A Claude-Code / Codex-style **interactive terminal UI** for the
[`@aragon-agent/core`](../core) engine. Type a task, watch the agent think and
stream its answer, see each tool call render as a live card, and interrupt /
steer / configure the session — all without leaving the terminal.

> ⚠️ **Full permission, no sandbox.** This first version runs at **maximum
> permission**: `bash` executes directly, file writes hit the real filesystem,
> and there is **no per-action approval gate by default**. Only run it in
> workspaces you trust. An opt-in confirmation mode is available via `--confirm`.

## Requirements

Node **≥ 18**, any platform.

**On Windows with Node < 22.17.0 (or 24.0/24.1), aragon turns the missing
console flag on itself at startup**, which restores `Shift+Tab` on most
machines. Where that is blocked — a locked-down PowerShell, an old console
host — **`Ctrl+P` toggles the mode instead**; it is bound on every platform and
does not depend on the console mode, the Node version, or anything else.
Everything else — the agent loop, every tool, skills, teams, `aragon -p` — works
exactly the same on Node 18 and 20, which is why `engines` stays at `>=18`
rather than locking those users out.

The reason is not the terminal emulator and not a setting: on Windows both
`Shift+Tab` (`CSI Z`) and mouse reporting exist only while the console input
handle has `ENABLE_VIRTUAL_TERMINAL_INPUT` set, and Node only sets it from
v22.17.0 / v24.2.0 onward. On older versions libuv translates console input
itself, and that translation has no entry for `Shift+Tab` (it arrives as a
plain `Tab`) and discards mouse records outright. Node 20 is the current
Windows default LTS, so this is a common configuration rather than an exotic
one — it is why the same build behaves differently on two machines. Below that
version aragon sets `ENABLE_VIRTUAL_TERMINAL_INPUT` itself, from a short
PowerShell helper, right after it puts the console into raw mode — the flag is a
property of the console, not of Node, so any process attached to it can turn it
on. When that works, `Shift+Tab` arrives as `CSI Z` again and mouse reporting
goes back on with it — the wheel should follow by the same route, though only
the key has been measured. When it does not work, aragon says so at startup and
turns mouse reporting off rather than asking for reports that can never arrive;
`Ctrl+P` and `/plan` switch mode, and `Shift+↑` / `Shift+↓` scroll.

## Install

```bash
# Global
npm i -g @aragon-agent/cli
aragon

# Zero-install
npx @aragon-agent/cli
```

> **Release note (R3):** `npx @aragon-agent/cli` resolves `@aragon-agent/core`
> from the npm registry, so `@aragon-agent/core@^0.1.0` must be published first
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

## Use it from another project

`aragon exec` is the machine-facing face of the same binary: a versioned JSON
event stream on stdout, sessions that survive across process boundaries, tool
permissions enforced at the tool boundary, and budgets with their own exit code.
Install the package, spawn it, read the JSON — that is the whole integration
story. Nothing about the interactive TUI changes, and `aragon -p` keeps working
exactly as it always has.

```bash
npm i -g @aragon-agent/cli    # or add it as a devDependency and use npx

aragon exec --output-format json "summarize src/index.ts" | jq -r .result
```

### Discover what you installed

```bash
aragon info --json     # version, schema version, tools, formats, features
aragon doctor          # "is this machine configured to run me?" — exit 0 = yes
```

`info.features` is a flat list of strings, on purpose: a wrapper that tests
`features.includes('sessions')` keeps working across versions that add
capabilities.

### Output formats

| Format | Stdout carries | Use it when |
| --- | --- | --- |
| `text` (default) | Exactly what `aragon -p` prints | A human reads the output, or you already parse `-p` |
| `json` | One `result` object, pretty-printed | You want the answer and the totals, nothing else |
| `stream-json` | One JSON object per line (NDJSON) | You want tool calls, todos and progress as they happen |

```bash
# text — byte-identical to `aragon -p "hi"`
aragon exec "hi"

# json — one object, ideal for `jq`
aragon exec --output-format json "hi"

# stream-json — NDJSON, one object per line
aragon exec --output-format stream-json "read package.json and name the deps"
```

A `stream-json` run looks like this (elided for width):

```jsonc
{"type":"system","subtype":"init","schemaVersion":1,"sessionId":"6f2…","cli":"0.6.0","cwd":"/w","model":{"provider":"anthropic","id":"claude-…","baseUrl":null},"permissionMode":"auto","tools":["read_file","write_file",…],"resumed":false}
{"type":"user","sessionId":"6f2…","turn":1,"text":"read package.json…","source":"caller"}
{"type":"tool_call","sessionId":"6f2…","turn":1,"id":"t1","name":"read_file","input":{"path":"package.json"}}
{"type":"tool_result","sessionId":"6f2…","turn":1,"id":"t1","name":"read_file","isError":false,"durationMs":4,"output":"{\n  \"name\": …"}
{"type":"assistant","sessionId":"6f2…","turn":1,"text":"The dependencies are …"}
{"type":"result","schemaVersion":1,"sessionId":"6f2…","isError":false,"stopReason":"end_turn","exitCode":0,"result":"The dependencies are …","turns":1,"durationMs":4120,"usage":{"inputTokens":1204,"outputTokens":88,"totalTokens":1292},"cost":{"amount":0.0049,"currency":"USD","known":true},"model":{"provider":"anthropic","id":"claude-…"},"todos":null,"error":null}
```

Event types: `system` · `user` · `text_delta` · `thinking` · `assistant` ·
`tool_call` · `tool_result` · `todo` · `team` · `fast_review` · `retry` ·
`error` · `result`. `text_delta` and `thinking` are opt-in
(`--partial-messages`, `--include-thinking`) — a per-token line is thousands of
lines per turn and is only wanted by a caller rendering a live UI.

**Forward compatibility, stated as a contract.** `schemaVersion` appears on
`system` and on `result`. **Ignore event types you do not know, and ignore
fields you do not know**: adding either never bumps the version, and renaming or
removing one does. A consumer that holds up its end of that keeps working across
upgrades; one that does not will break on a release that adds an event.

One practical note: a `tool_result.output` line can approach 100 KB, so read
stdout with a line reader that has no small buffer cap.

### Tool permissions

`--confirm` needs a human. For a program embedding an agent there are two
orthogonal controls instead, and both are enforced by the wiring — a denied tool
is **not registered at all**, so the model never sees it and never plans around
it.

| Flag | Meaning |
| --- | --- |
| `--permission-mode auto` | Every tool (the default) |
| `--permission-mode plan` | Every tool registered; the five that write refuse at call time. Exactly `aragon -p --plan` |
| `--permission-mode strict` | Nothing, until `--allow-tool` says otherwise |
| `--allow-tool <names>` | **Adds** to the baseline. Repeatable; comma lists accepted |
| `--deny-tool <names>` | **Removes**. Wins over `--allow-tool` |

Each of these reads as one sentence:

```bash
# a research agent that cannot touch anything
aragon exec --permission-mode strict --allow-tool read_file,grep,glob,list_dir \
  --output-format json "which files define the retry policy?"

# do anything except shell out
aragon exec --deny-tool bash --output-format json "fix the failing test"

# read-only research and a written plan, no edits
aragon exec --permission-mode plan --output-format json "how would you add OAuth?"
```

The policy reaches **subagents**: a `task` dispatch cannot hand a child a tool
the parent was denied. An unknown tool name is a usage error (exit 2) rather
than a silent no-op.

### Sessions across invocations

A wrapper that respawns per turn — a CI step, an HTTP handler, a queue worker —
needs the conversation to outlive the process.

```bash
aragon exec --session-id ci-42 --output-format json "start the migration plan"
aragon exec --session-id ci-42 --output-format json "now do step 1"
```

| Flag | If the session exists | If it does not |
| --- | --- | --- |
| `--session-id <id>` | Resume it | **Create** it (the wrapper-friendly upsert) |
| `--resume <id\|path>` | Resume it | Exit 2, `session_not_found` |
| `-c, --continue` | Resume the newest session for this directory | Exit 2, `no_session_for_cwd` |
| `--no-save-session` | — | Run statelessly; write nothing |

Sessions live in `~/.aragon-agent/sessions/`. An id must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}` — it becomes a filename, and the caller
supplying it is frequently the least trusted input in the pipeline.

```bash
aragon sessions list [--json] [-n 20] [--all]
aragon sessions show <id> [--json]
aragon sessions rm <id> --yes
aragon sessions prune [--older-than 7] [--dry-run] [--all] --yes
aragon sessions path
```

Two same-id runs cannot interleave: the second exits 2 with `session_busy`
rather than blocking, because a wrapper that wants a queue can build one and a
CLI that blocks on a lock it cannot show you is a hang.

### Budgets

```bash
aragon exec --max-turns 20 --max-duration 600000 --output-format json "…"
```

`--max-turns <n>` bounds assistant turns; `--max-duration <ms>` bounds the whole
run's wall clock. Both abort through the same path `Esc` uses, so subagents are
torn down and the engine settles normally. **Neither is an error** — `isError`
stays `false` — but both exit **3**, so a shell script can tell "ran out of
budget" from "finished" and from "broke" without parsing JSON.

Two neighbours they do not replace: `--idle-timeout` bounds a *silent stretch*
inside the run and still applies (a `--max-duration` longer than the idle
watchdog will usually be pre-empted by it, which surfaces as
`stopReason: "error"`); `--tool-timeout` bounds a *single tool call*.

A run that finishes on its own in exactly `--max-turns` turns exits `0` with
`stopReason: "end_turn"`. The budget fires only when a further turn would start.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Agent / runtime error (the run started and failed) |
| `2` | Configuration or usage error (the run never started; stdout is empty) |
| `3` | Stopped by a caller-set budget (`--max-turns`, `--max-duration`) |
| `130` / `143` / `129` | Interrupted by `SIGINT` / `SIGTERM` / `SIGHUP` (`128 + signo`) |

### Spawning it from Node

```js
import { spawn } from 'node:child_process';
import readline from 'node:readline';

function runAragon(prompt, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'aragon',
      ['exec', '--output-format', 'stream-json', ...args, prompt],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );

    let result = null;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return; // Never fatal: forward compatibility runs both ways.
      }
      if (event.type === 'result') result = event;
      // Ignore every type you do not know. That is the contract.
    });

    // RESOLVE ON EXIT AS WELL AS ON `result`. Process exit is terminal whether
    // or not a `result` arrived — see Limits below — and a consumer that waits
    // only for `result` hangs when the run is killed.
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, result }));
  });
}
```

### In CI

```bash
aragon exec \
  --permission-mode plan \
  --max-turns 20 \
  --max-duration 900000 \
  --output-format json \
  --session-id "ci-${GITHUB_RUN_ID}" \
  "Review the diff on this branch and list the risks." \
  | jq -r .result
```

`aragon doctor --json` exits 1 with a named failing check when the machine is
not configured, which makes a good first step in the job.

Feeding several turns to one process:

```bash
printf '%s\n' \
  '{"type":"user","text":"list the files you would change"}' \
  '{"type":"user","text":"now change the first one"}' \
  '{"type":"end"}' \
| aragon exec --input-format stream-json --output-format stream-json
```

### Limits

Four things this does **not** do, stated plainly because the audience for this
section is the one that would be misled by their omission.

1. **There is no filesystem sandbox.** Tool paths are not confined to the
   working directory: an absolute path resolves to itself. Tool permission —
   not a directory allowlist — is the boundary that is real, and a run with
   `bash` enabled can reach anything the invoking user can. There is deliberately
   no `--add-dir`, because it would be a promise the wiring does not keep.
2. **Process exit is terminal, `result` or no `result`.** On POSIX, `SIGINT`,
   `SIGTERM` and `SIGHUP` all produce a final `result` before the process ends.
   **On Windows only Ctrl-C does** — Node does not deliver the other two to
   listeners, so `taskkill` ends the process outright. Resolve on process exit as
   well as on `result`, or a killed run hangs your parent process.
3. **A session created by `aragon exec` and resumed with `aragon --resume`
   carries the model's full memory and shows no scrollback** for the turns that
   ran headlessly. The reverse direction is fully faithful: a TUI `/save` resumed
   by `aragon exec --resume <id>` keeps everything.
4. **`aragon sessions prune` shares a directory with the TUI's `/save`**, so it
   only ever touches sessions `exec` created — files that carry an exec `meta`
   block — unless you pass `--all`. `sessions show` and `sessions rm` accept any
   id, because you named it.

## Usage

```
aragon [prompt]                 Start the interactive TUI (or one-shot with -p / piped stdin)
aragon -p, --print [prompt]     Headless: stream the answer to stdout, then exit
aragon exec [prompt]            Machine-facing run: JSON events, sessions, permissions, budgets
aragon sessions <sub> [id]      Manage exec sessions: list | show | rm | prune | path
aragon info [--json]            Print what this installation supports
aragon doctor [--json] [--probe] Check this machine is configured to run aragon
aragon config                   Open the settings screen
aragon config set <key> <value> Non-interactive config write (e.g. model, provider)
aragon config path              Print the config file path
aragon models [--provider p]    List builtin + discovered models
aragon --version | -v           Print the version
aragon --help  | -h             Print help
```

`aragon exec` is documented in full under
[Use it from another project](#use-it-from-another-project). Every global flag
below works there too, in either position — `aragon --model m exec "…"` and
`aragon exec --model m "…"` parse identically.

### Global flags

| Flag | Meaning |
| --- | --- |
| `--provider <id>` | `anthropic` \| `openai` \| `google` |
| `--model <id>` | Model id |
| `--base-url <url>` | Override the provider base URL (OpenAI-compatible endpoints) |
| `--api-key <key>` | One-shot key override (not persisted) |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh` |
| `--max-tokens <n\|auto>` | Output token cap: a number, or `auto` for the model's own ceiling (default `64000`) |
| `--cwd <dir>` | Working directory for tools |
| `--confirm` | Confirm each mutating tool call |
| `--tool-timeout <ms>` | Per-tool executor ceiling (default 180000) |
| `--idle-timeout <ms>` | Watchdog idle timeout (auto-raised to ≥ tool-timeout + 30s) |
| `--theme <name>` | `auto\|warm\|cool\|light` (`dark` is a compatibility alias for `cool`) |
| `--compact` / `--no-compact` | Transcript density: no blank rows between turns, or the default |
| `--hints` / `--no-hints` | Show or hide the composer hint row |
| `--show-thinking` / `--no-show-thinking` | Draw the model's reasoning blocks in the transcript. Off by default — see [What you see while it runs](#what-you-see-while-it-runs) |
| `--live-tool-output` / `--no-live-tool-output` | Show a bounded tail of a running command's output on its card. **On** by default — see [What you see while it runs](#what-you-see-while-it-runs) |
| `--no-exit-transcript` | Do not replay the session summary after exiting |
| `--plan` / `--no-plan` | Start the session in PLAN mode (read-only research + review) or force BUILD |
| `--team` / `--no-team` | Enable or disable team subagents. `--no-team` does not register the `task` tool at all |
| `--team-max <n>` | Max subagents per dispatch for this run, clamped to `[1, 10]` |
| `--todo` / `--no-todo` | Enable or disable todo planning. `--no-todo` does not register the `todo_write` tool at all |
| `--todo-panel` / `--no-todo-panel` | Show or hide the right-hand todo rail. The tool stays registered either way |
| `--todo-follow <mode>` | What happens when a run ends with steps left: `notify` (default), `auto`, `off` |
| `--retry` / `--no-retry` | Retry a failed provider call with backoff (the default), or fail on the first error |
| `--retry-max <n>` | Retries after the first attempt for this run, clamped to `[0, 20]`. `0` turns retry off |
| `--fast` / `--no-fast` | Enable or disable the fast model tier. Off by default; see **Fast model tier** |
| `--fast-model <id>` | The fast model id. Implies nothing about `--fast` on its own |
| `--fast-provider <id>` | Provider for the fast model. Absent inherits the main provider |
| `--fast-review <n\|off>` | Turns between automatic fast reviews, or `off` |
| `--compaction` / `--no-compaction` | Compact the conversation when the context window fills, or never. **On** by default — see **Context compaction** |
| `--compaction-threshold <n>` | Occupancy that triggers compaction for this run: `0.9` or `90%`, clamped to `[0.5, 0.95]` |
| `--no-skills` | Disable the skill system entirely (no catalog, no skill tools) |
| `--skill <name>` | Force-load a skill's full body for this run (repeatable) |
| `--skills-yes` | Approve skill installs for this run (CI / headless) |
| `--transcript-retain <n>` | Entries kept in memory, clamped to `[200, 20000]`. Older ones are dropped and counted |
| `--render-governor` / `--no-render-governor` | Adapt the frame interval under load, or pin it at 33 ms |
| `--max-render-interval <ms>` | Governor ceiling, clamped to `[33, 1000]`. `33` flattens the ladder |
| `--no-color` | Disable ANSI color |
| `--quiet` | (print mode) suppress tool/usage lines on stderr |

Exit codes: `0` success · `1` agent/runtime error · `2` config/usage error ·
`3` stopped by a caller-set budget (`aragon exec` only) · `128 + signo` when a
signal ends the run (`130` SIGINT, `143` SIGTERM, `129` SIGHUP).

## Slash commands (interactive)

| Command | Action |
| --- | --- |
| `/help` | Keybindings + command help |
| `/model` | Open the model picker |
| `/settings` | Open the settings screen |
| `/thinking <level>` | Set the thinking level |
| `/max-tokens [<n>\|auto\|default]` | Output token cap; with no argument, reports the setting **and** the effective cap for the live model |
| `/tools` | List active tools |
| `/clear` | Clear the visible transcript and the todo panel |
| `/reset` | New conversation |
| `/cwd [dir]` | Show / change the tool working directory |
| `/save [file]` | Save the session to JSON |
| `/resume [file]` | Load a saved session |
| `/plan [on\|off\|status]` | Toggle plan mode - the keyboard-free equivalent of `Shift+Tab` |
| `/team [on\|off\|max <n>]` | Team subagents: status and the live roster, the on/off switch, the fan-out width |
| `/todo [on\|off\|panel on\|off\|follow <mode>\|clear\|continue]` | Todo planning: status, the on/off switch, the rail, follow-through, and picking an unfinished plan back up |
| `/retry [show\|on\|off\|max <n>]` | API retry: the effective ladder, the on/off switch, the retry count. Takes effect **in the running session**, children included |
| `/fast [on\|off\|model <id>\|provider <id>\|same\|review <n\|off>\|delegate on\|off]` | Fast model tier: status and this session's totals, the on/off switch, which model, the review cadence |
| `/compact [status\|on\|off\|threshold <n>\|keep <n>\|history\|show <n>\|<instructions>]` | Context compaction: occupancy and this session's totals, the on/off switch, when it fires, how much it keeps. With free text, compacts now and tells the summarizer what to pay attention to |
| `/context` | What the context gauge is showing: occupancy split into measured and estimated, the window and **where it came from**, how stale the measurement is, compaction's actual state, and what the session-spend readout includes |
| `/bg [list\|logs <id> [n]\|stop <id\|all>\|status]` | Background services: what is running, its log tail, and how to stop it. `list` is the default |
| `/update [status\|now\|skip\|off]` | Auto-update: what is running, what is available, where it came from, when it looks again. `now` forces a check past the throttle; `skip` declines the offered version until a newer one appears |
| `/theme <auto\|warm\|cool\|light>` | Switch the color theme live (persisted) |
| `/expand [n]` | Expand / collapse the n-th-from-last (default last) tool card |
| `/copy` | Copy the last answer to the clipboard |
| `/perf` | What the renderer is doing: frame interval, mounted entries, dropped entries, cache occupancy. `/perf reset` clears the caches and the governor |
| `/logs` | Show where this session is being logged, and at what level |
| `/reload` | Re-read `config.json` after editing it in another window (refused mid-run) |
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
| `Shift+Tab` | Toggle **plan mode** (`BUILD` <-> `PLAN`). Equivalent: `/plan`. On Windows this needs a console flag Node < 22.17 does not set; aragon sets it at startup — see [Requirements](#requirements) |
| `Ctrl+P` | The same toggle, over a channel no Windows console can swallow. Use it if `Shift+Tab` does nothing |
| `Esc` | Close an overlay or popup; otherwise ask for interruption confirmation. While idle, cancel pending auto-continuation |
| `Esc` ×2 | Interrupt the run when pressed within 1.5 seconds. Other keys or closing a menu cancel the first press |
| `Esc` again after interruption | **Force-stop** a run that is still stopping, kill foreground shell commands and return to `idle`; background services remain running |
| `Ctrl+C` | Stop the background **services** the agent started, when there are any. It does not arm exit |
| `Ctrl+C` ×2 | Exit (first press warns), once no services are running |
| `Ctrl+L` | Redraw the frame |
| `Ctrl+T` | Show / hide thinking (**off by default**) for the entire session |
| `Ctrl+O` | Expand / collapse the most recent tool, team, compaction or **service** card — including a diff or a service's log tail |
| `PgUp` / `PgDn` | Scroll the transcript a page (full-screen mode) |
| `Shift+↑` / `Shift+↓` | Scroll the transcript a line (full-screen mode) |
| Mouse wheel | Scroll the transcript (or the open overlay). On Windows needs Node ≥ 22.17 — see [Requirements](#requirements) |
| `Shift`+wheel | Scroll the transcript a page |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | Cursor to line start / end |
| `Alt/Ctrl+←` / `→` | Word-wise cursor jump |
| `Ctrl+W`, `Alt+Backspace` | Delete the previous word |
| `Ctrl+U` / `Ctrl+K` | Kill to line start / end |
| `Up` / `Down` | Move between draft lines; recall prompt history at the edges |
| Paste | Inserted as-is up to 6 lines / 400 chars; larger collapses to `[Pasted text #1 +15 lines]`, which deletes as one unit and expands in full when you send. `--no-paste` restores the pre-0.6.3 behaviour |
| `?` | Open help (empty input) |

In **full-screen mode** the transcript is scrolled by the app itself: `PgUp` /
`PgDn` and `Shift+↑` / `Shift+↓`. While pinned to the bottom the viewport follows
new output automatically; once you scroll away the status bar shows `↑N`, a slim
scrollbar occupies the terminal's last column (including 40-column windows). Drag its thumb
to move through history, or click the track to move one page. Messages, the team panel
and the input area scroll together; typing or editing returns to the input without
losing the draft. The fixed status row shows `PgDn down` while reading history.
`PgDn` moves one page down; editing or submitting returns directly to the end.

**The mouse wheel is a viewport gesture and nothing else.** Wherever the pointer
happens to be — including right on top of the composer — a notch scrolls the
transcript three rows (a page with `Shift`), or scrolls the overlay when one is
open. It never touches your draft, and it never recalls prompt history: that is
`↑` / `↓`, and only `↑` / `↓`.

Two things follow from the app owning the mouse, and they are worth knowing
before you meet them:

- **Dragging text selects and copies it when mouse selection is enabled.**
  Dragging the last-column scrollbar scrolls instead. `--no-mouse-select` disables
  text selection while preserving scrollbar dragging. `Shift`+drag uses the
  terminal's native selection on hosts that support that convention.
- **`tmux` with `mouse on` keeps the wheel for itself**, so the app never sees
  it. `set -g mouse off` hands it back.
- **A Windows console on Node below 22.17.0 cannot report the wheel at all**,
  so aragon does not ask it to. See [Requirements](#requirements); `PgUp` /
  `PgDn` and `Shift+↑` / `Shift+↓` scroll from the keyboard meanwhile.

Turn the whole thing off with `--no-mouse`, `ARAGON_MOUSE=0`, or
`aragon config set mouse false`. With mouse support off the wheel simply does
nothing in full-screen mode — it does not fall back to editing your draft, which
is what it used to do. Inline mode is unaffected either way.

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
`esc ×2 interrupt` in full.

## What you see while it runs

Four rules, and each of them exists because the opposite was worse.

**Reasoning is not shown.** A model at `thinkingLevel: high` emits more
chain-of-thought than answer, and it used to scroll the answer and the tool calls
off the top of the screen. It is written for the model, not for you. So it is off
by default, and a settled turn that thought leaves one muted row in its place:

```
  ✱ thought for 12s · ctrl+t to show
```

That row is the whole point — hiding information without saying that it exists
is how a "clean" UI becomes a dishonest one. `Ctrl+T` shows the bodies for the
session, `showThinking: true` (or `--show-thinking`, or `ARAGON_SHOW_THINKING=1`)
shows them permanently, and `/settings` has a **Show thinking** row next to
**Thinking**.

**There is something to look at while it thinks.** One row directly above the
input box, for as long as a run is in flight, with the keys that act on the run
beside it (it takes the place of the idle hint row below the box, so starting a
run never moves the layout):

```
  ⠋ Percolating… · ⏎ steer · esc×2 interrupt · ctrl+c×2 exit            PLAN
```

The row scrolls with the input box. On a narrow terminal whole clauses are dropped
from the end (`exit` first) and only the phrase is shortened with an ellipsis, so
`steer` and `interrupt` are never cut mid-word. When you scroll history until the
input box is out of view, the animation moves to the fixed row at the bottom, so
there is always exactly one spinner on screen. Terminals shorter than 20 rows, and
`--no-hints`, keep the animation on that fixed row instead.

The word rotates every four seconds. It carries no clock and no token count on
purpose: the status bar one row below already has both, under the same
condition, driven by the same ticker. Under `reducedMotion` the spinner is a
static glyph and the word is chosen once and holds — rotating text is motion too.
An idle frame is exactly what it was before this existed, down to the row count.

While a **tool** is in flight the row stops guessing and names it instead:

```
  ⠙ Running bash
```

`running` covers the whole turn, including the minutes the model is idle and a
child process is doing the work. "Pondering" is right for the gap before the
first token and simply untrue during a build.

**A long command is not a blank card.** `bash` is the only tool here that can run
for minutes — `npm test`, a `git clone`, a training job — and while it ran, its
card used to be one line of text that never changed. Now it shows the last eight
lines of what the command is printing, plus one honest footer row:

```
  bash npm test   ⠹ running
  │  ✓ src/__tests__/patch.test.ts (49 tests)
  │  ✓ src/__tests__/diff-view.test.tsx (9 tests)
  │  (running)
```

and, when the child goes quiet, `no output for 45s` instead of a spinner that
means nothing. A `\r`-driven progress bar — npm, pip, curl, docker — is *one*
line rewritten a thousand times, and it renders as one row counting up in place,
not a thousand rows of nearly the same string.

**What the tail deliberately does not do.** It is a display, not a transcript.
ANSI colour, cursor motion and every other control byte are **stripped**, not
interpreted (keeping colour would mean validating it, and an unterminated escape
leaks into the rest of the frame; interpreting cursor motion would mean owning a
screen buffer). It keeps eight rows, so `Ctrl+O` does nothing while a command is
running — expansion is a promise about stored content, and there is no stored
rest of a 400 MB stream to show. It is not saved: `/save` during a run writes no
tail, because a resumed one would describe a process that died with the session.
And it never reaches the model — at settle the card is replaced by the
authoritative result, exactly as before. Set `liveToolOutput: false` (or
`--no-live-tool-output`, or `ARAGON_LIVE_TOOL_OUTPUT=0`, or the **Live output**
row in `/settings`) and the card is a single `running` row again, with no store
allocated and no recorder attached.

**A file modification looks like a file modification.** `write_file` and
`edit_file` now produce a real diff — hunks, line numbers, `+N -M`:

```
  +6 -5
  1163   top level of the file where the section never takes effect. It
  1164 - `applyFastConfigSet` (`:259`). A key missing from the list is
  1164 + `applyFastConfigSet` (`:252`). A key missing from the list is
  1165   `Unknown config key`; a key in the list but missing from the switch
  +13 lines (Ctrl+O)
```

Creating a 300-line file is the single most consequential thing an agent does,
and it used to be reported as a byte count. Diffs collapse at 12 rows behind the
existing `Ctrl+O`; there is no new keybinding.

**This costs the model nothing — it saves.** The structured patch reaches the
screen on a CLI-local channel, not through the tool result, and the text the
model reads gained a 4 000-character ceiling it did not have before. For a
single-region edit that text is what it always was plus one `@@` header; for a
multi-region edit it is strictly smaller, because a change at line 40 and one at
line 900 are now two small hunks instead of 860 removed rows followed by 860
near-identical added ones.

## Full-screen mode

`aragon` takes over the terminal's **alternate screen buffer** — the mechanism
`vim`, `htop`, and `lazygit` use. Two consequences worth knowing:

- Your previous shell output is **covered, not erased**, and returns untouched
  when you exit. Nothing in your scrollback is destroyed.
- The frame is fixed at `rows - 1` tall. The header, activity row and status bar
  stay visible. The input belongs to the scrolling document; short sessions fill
  the space above it, and browsing history moves it out of view.

On exit the session is replayed into the normal buffer as plain text so the
conversation survives leaving the screen (`--no-exit-transcript` opts out;
`/save` still exports the full JSON).

Interactive sessions always use the full-screen TUI, including under `TERM=dumb`
or CI. Windows smaller than 40 columns or 12 rows show a size notice and recover
when enlarged, preserving the session and draft.

The layout switches `--fullscreen`, `--no-fullscreen`, `ARAGON_FULLSCREEN` and
`fullscreen` configuration have been removed. Old command-line flags are errors;
old config fields and environment variables are ignored.

Interactive screens require both stdin and stdout to be TTYs. `aragon config`
without a TTY exits with code 2; use `aragon config list` or `aragon config set`.
`-p`, `exec`, piped input and prompt-based redirected output retain their
headless behavior and never enter the alternate screen.

The alternate screen uses an application scrollbar rather than the terminal's
native scrollback. Windows Terminal and conhost have different mouse/VT capabilities;
the PowerShell version alone does not determine dragging support. If the host cannot
deliver SGR mouse reports, the scrollbar remains visible and keyboard scrolling works.
The differential renderer never erases the last column: a row that already fills the
terminal width is repainted without a trailing erase-to-end-of-line, which on Windows
console hosts would otherwise wipe the scrollbar cell on every redrawn row. `/perf`
prints a `scrollbar:` line (column, mouse state, whether a full frame was confirmed,
thumb position, glyph tier) to tell "cannot see it" from "cannot drag it".
`--no-mouse` provides that keyboard-only path; `--no-diff-render` disables output
differencing without disabling the scrollbar. A mid-session resize below 40 columns
or 12 rows displays a size hint and preserves the draft for restoration.

## Render performance

A long session used to get slower and slower, and past a point it stopped
responding at all. The cause was structural rather than incidental: Ink has no
output caching, so every frame re-walked the whole mounted tree, re-measured
every text node and re-serialised the frame. The cost was therefore proportional
to **every character the session had ever produced**, not to the characters
actually on screen — and `transcriptWindow` bounded the entry *count*, which is
not the same thing when one entry can be fifty thousand lines.

Four things changed, and you should not have to think about any of them:

- **Off-screen entries are not mounted.** The viewport renders the band you can
  see plus a couple of entries either side, and replaces the rest with two
  spacers of the right height. Scrolling and the `↑N` readout are unchanged.
- **The expensive pure work is cached.** Syntax highlighting and markdown
  parsing now run once per distinct block instead of once per frame. Themes are
  still applied at render time, so `/theme` takes effect immediately.
- **The transcript is bounded.** A single answer cannot exceed 256 KiB in the
  view, and `transcriptRetain` caps how many entries are kept. Both bounds
  report what they removed rather than dropping it silently.
- **The frame interval adapts.** If a frame is genuinely expensive, updates
  coalesce into a wider window — 33 ms up to a 320 ms ceiling — so the terminal
  stays responsive to typing and to `Ctrl+C`. A muted **`eco`** chip appears in
  the status bar whenever this is in effect: the stream getting chunkier is
  something you should be able to see a reason for.

`/perf` reports exactly what the renderer is doing:

```
render     rung 2  -  interval 80ms  -  last commit 61ms  -  eco
transcript 4213 entries  -  1000 retained  -  3213 dropped  -  38 mounted
heights    412 cached  -  6 estimated  -  cols 132
caches     md 178 (1.9MB)  -  hl 96 (1.4MB)  -  lines 340
mode       fullscreen  -  viewport 44 rows  -  offset 0
```

`/perf reset` clears the render caches and returns the governor to its fastest
rung. `--no-render-governor` (or `renderGovernor: false`, or
`ARAGON_RENDER_GOVERNOR=0`) turns the adaptation off entirely; the output is
identical, just heavier under load.

## Plan mode

`aragon` has two postures, and `Shift+Tab` switches between them. `/plan` does
the same thing for terminals that swallow the key (see below).

| Mode | What it means |
| --- | --- |
| `BUILD` | The default, and unchanged from earlier versions: you ask, the agent does it. |
| `PLAN` | Research and design only. The agent reads, asks you the decisions it cannot settle by reading, and submits a plan for approval before anything is written. |

`BUILD` is right for "rename this symbol". `PLAN` is right for "add multi-tenant
support" — anything where you want to see and steer the *approach* before a
single byte changes.

### What plan mode actually stops

In `PLAN`, five tools are refused at the tool boundary: `write_file`,
`edit_file`, `bash`, `skill_install` and `skill_create`. That is a property of
the wiring, not a promise in a prompt — the refusal happens before the tool runs,
so the badge is telling you something that is structurally true.

**`bash` is refused in full, `git status` included.** This is the most likely
question this feature generates, so: there is no reliable way to classify a shell
string as read-only, and a gate that is right 95 % of the time is worse than one
that is always right, because you stop trusting the badge. Use `read_file`,
`list_dir`, `glob` and `grep`, which stay available; the refusal message names
them so the agent has somewhere to go. There is no allowlist and there will not
be one built out of substring matching.

Everything else still works: reading, searching, loading skills, and asking you
questions.

### The two plan-mode tools

- **`ask_user`** renders a keyboard-driven wizard: 1–5 questions, 2–4 options
  each, exactly one marked `RECOMMENDED`, plus an `Other…` free-text option.
  `↑`/`↓` choose, `Enter` confirms and advances, `←` goes back, `Esc` cancels.
  Pressing `Enter` through the whole wizard accepts every recommendation, which
  is a deliberate "use your judgement" path rather than an accident. A last
  screen lets you review before submitting.
- **`submit_plan`** renders the plan as a scrollable card: `a` approves, `r`
  opens a one-line feedback field (`Enter` sends it, `←` goes back to the card),
  `Esc` dismisses. **Approving flips the session to `BUILD` immediately and the
  same run continues straight into implementation** — you do not have to re-ask.

Cancelling either one is not an error. The agent is told to proceed on stated
assumptions rather than to retry.

**Dismissing a plan is not how you stop.** `Esc` on a plan card asks for a
*better* plan — the agent is told to refine it and submit again — so a model that
keeps submitting keeps getting cards. To stop the run itself, close the card with `Esc`, then **press `Esc`
twice within 1.5 seconds** to interrupt. Closing the card never counts as the first press. `Ctrl+C` twice
still exits the session outright.

### Where the mode is shown

The status bar always names a non-default mode (`PLAN`, or `PLAN → BUILD` while
a switch is pending), including on short terminals and with `--no-hints`. The composer additionally shows a `PLAN` chip on its hint row and
tints its border, where there is room for it.

### Switching mid-run

Tightening applies at once; loosening waits. Pressing `Shift+Tab` toward `PLAN`
during a run takes effect immediately — you pressed it *because* the agent is
about to do something. Pressing it toward `BUILD` during a run is **deferred to
the end of the run**, so a session you launched under a read-only guarantee
cannot start writing files because of one stray keypress. The status bar shows
`PLAN → BUILD` while that is pending. Approving a plan is the one exception, and
it is an informed act rather than a stray keypress.

### If `Shift+Tab` does nothing

**Press `Ctrl+P`.** It is the same toggle and it does not depend on any of the
machinery below.

To find out why, run this in the same terminal, press `Shift+Tab` once, then
`Ctrl+C`:

```powershell
node -e "process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',b=>{console.log(b.toString('hex'));if(b[0]===3)process.exit(0)})"
```

| It prints | What it means |
| --- | --- |
| `09` | The console is swallowing the modifier — the key is arriving as an ordinary `Tab`. Check `node -v`: below 22.17.0 (or on 24.0/24.1) this is expected, and aragon's own attempt to fix it was blocked. See [Requirements](#requirements) |
| `1b5b5a` | The key reaches the process fine, so something inside aragon is eating it — most often an overlay is open, or the run is still going and the switch is pending (the status bar shows `BUILD → PLAN`) |
| nothing | Your terminal, multiplexer or remote-desktop stack never sent it; some never send `CSI Z` at all |

On the first row the wheel is dead for the same reason, and with the `/` palette
or an `@` popup open the stray `Tab` completes that entry over your draft.

`/plan`, `/plan on`, `/plan off` and `/plan status` are first-class equivalents
in every case, and `--plan` / `ARAGON_PLAN=1` / `planModeDefault` cover the
startup case. `aragon doctor` reports this machine's answer as `vt-input`.

### Headless

`aragon -p --plan "add SSO"` is a useful combination: the read-only gate still
applies, so it means *"tell me how you would do this, and do not touch my
repository"*. No question or plan tool is registered there — there is nobody to
ask — and the agent writes the finished plan as its final message in markdown.

## TODO planning

For work with three or more distinct steps the agent keeps a **visible plan**:
it writes a checklist with the `todo_write` tool, marks exactly one item as in
progress, and ticks it off before starting the next. In full-screen mode that
list is rendered as a right-hand rail, targeting 15% of the terminal width
(14–36 columns, including its separator and padding).

```
  transcript ...                            | TODO             2/7
                                            | ####------
                                            |
                                            | v  1 Read the reducer
                                            | v  2 Design the store
                                            | >  3 Wiring the rail...
                                            | o  4 Add the panel-rows test
                                            | o  5 Update the README
                                            |      +2 more
```

Ask for something small and nothing appears. The agent is told, in its system
prompt, **not** to use the tool for anything it can finish in one or two steps,
for a question, or for a search with no work attached — and a one-item list
against an empty plan is refused outright. A session that never plans has
byte-identical layout to a build without this feature.

**The list shows the current task's plan.** Starting a new task or explicitly
clearing the list removes this live view while preserving conversation history:

- `/clear` and `/todo clear` take the plan off the screen. Neither touches the
  conversation, so the model still knows what it was doing and its next update
  brings the panel straight back.
- `/reset` clears the conversation, so the plan goes with it.
- `/save` writes the list and `/resume` restores it. Resuming a session that has
  no list clears the current one, rather than leaving a plan on screen whose
  conversation has just been replaced.
- A normal new task clears the previous plan, including unfinished steps, only
  when it starts successfully. The completed run keeps its final plan visible.
  `/todo continue` and automatic continuation preserve the plan and its timestamp;
  ordinary text such as "continue" starts a new task. Steering keeps the current
  plan. Until a valid new `todo_write`, the rail and count stay hidden.
  Startup failure or cancellation keeps the old plan. History cards remain available.
- During a live run, interrupt before `/reset` or `/resume`. A conversation switch
  while startup is waiting cancels that pending request and returns the view to idle.

### When a run ends with steps left

By default you get a notice and `/todo continue` — nothing auto-continues on
your behalf. `/todo continue` no longer says "continue the remaining items"; it
sends the model the numbered list of steps that are still open, so a plan that
scrolled out of the context window some turns ago is still followed exactly.

`/todo follow auto` (or `--todo-follow auto`, or `todo.followThrough` in
`config.json`) turns that into an actual loop: the CLI announces
`Continuing with 4 remaining steps in 3s - Esc to stop.`, waits, and then sends
the continuation itself. Two structural limits bound it, and neither is a
setting:

- A continuation that completes no step buys exactly **one** more attempt.
  After that you get a sentence and the keyboard back.
- A single plan is continued at most **25** times however productive it looks.
  A re-plan forgives the first counter but never the second, so a model that
  reshapes its list every turn cannot lift the ceiling.

`Esc` during the grace window cancels; so does typing anything. A run that ended
with an **error** never auto-continues in any mode — you get a warning instead.
A run **you** interrupted with two `Esc` presses now says nothing at all, where it used to
report what you had just interrupted.

`/todo follow off` is the third mode: no notice, no continuation, silence.

Under `-p` there is no grace window (there is nobody there to use it), so the
two counters are the whole of the protection. `[todo] continuing (3 steps left)`
goes to stderr before each continuation and `[todo] 3 steps unfinished` when it
stops; both are suppressed by `--quiet`, and an unfinished plan never changes
the exit code.

### Inline mode

Inline mode has no fixed frame and therefore no rail, but it does get a one-row
plan strip under the transcript:

```
todo 3/7  >  Adding the rail to AppShell                        +2 done
```

It never wraps and never grows past one row, so the composer does not move. The
`+N done` suffix drops below 80 columns and the counter compacts to `[3/7]`
below 100, matching the status bar. `--no-todo-panel` hides the strip as well as
the rail.

`/todo` reports status and switches things off: `/todo off` unregisters nothing
(the tool list is fixed when the session starts) but stops the tool working and
drops the guidance from the system prompt, while `/todo panel off` keeps the
planning discipline and hides the column — which is what you want with a screen
reader, and what `--no-todo-panel` does for a whole session. Under `-p` the plan
is written to stderr as `[todo] 3/7 <step>` lines, suppressed by `--quiet`.

右栏从 76 列开始显示，正文至少保留 62 列；100 列终端使用 15 列右栏。
已有任务时，团队面板按实际行数占用空间，补全菜单的边框和提示也计入预算。
例如 100×20、团队占 8 行时，TODO 仍以 4 行紧凑视图显示。

剩余 3–5 行时保留标题、完成计数、当前任务与合并提示 `-A +B`：
`-9 +10` 表示上方隐藏 9 项、下方隐藏 10 项。6 行起使用常规视图；
所有任务各占一行，全文仍可在正文任务卡片中查看。进度条需要至少 20 列、8 行。
输入增长导致空间不足时团队先折叠为摘要；菜单不足 3 行时隐藏，其候选不会拦截输入。

低于 76 列、共享区域不足 3 行、打开 overlay、显式关闭面板、没有任务或
inline 模式时不显示右栏。低于 12 行使用原有小终端提示；扩大窗口后自动恢复。
inline 仍使用上文的单行任务条。`/todo status` 中的 `Panel: on` 仅表示配置开启，
实际可见性还取决于数据和窗口空间；可以通过该命令区分未生成计划与暂时隐藏。

## Built-in tools

`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash` — all
at full permission. Paths resolve against the session working directory. The
per-tool timeout and 100 KB output truncation are enforced by the core executor;
`bash`'s `timeout` param only shrinks within that ceiling.

When skills are enabled, four more are added — the two read tools `skill` and
`skill_find`, then the two mutating ones `skill_install` and `skill_create` (see
below). `--no-skills` removes them again. Updating a skill is deliberately not
among them; that is a `aragon skills update` decision for you, not the model.

With team mode on — which is the default — one more is added: `task`, the
delegation tool (see below). `--no-team` removes it again.

With todo planning on — also the default — one more is added: `todo_write`, the
planning tool (see above). `--no-todo` removes it again.

With background services on — also the default — two more are added:
`bash_output` and `bash_kill` (see below), and `bash` itself gains a `background`
parameter. `bash.background: false` removes all three again.

## Background services

The agent can write a web app; it also has to be able to **run** one. A command
that never exits on its own — `npm run dev`, `uvicorn main:app`, `vite`,
`docker compose up`, `tsc --watch` — is not a hung tool, it is a server, and
running it in the foreground stalls the turn until the tool timeout kills it
three minutes later.

So those commands are **supervised** instead. `bash` gains one optional
parameter:

```jsonc
{ "command": "npm run dev", "background": true }
```

`true` supervises it, `false` never does, and **omitting it lets the runtime
decide** from the command itself — a closed allowlist over the leading token and
the script name (`npm|pnpm|yarn|bun run dev|start|serve|watch|preview`,
`next dev`, `vite`, `nuxt dev`, `ng serve`, `nodemon`, `tsc --watch`, `uvicorn`,
`gunicorn`, `flask run`, `manage.py runserver`, `rails server`, `php -S`,
`cargo watch`, `docker compose up` without `-d`, `tail -f`, `watch `). It never
fires on a chained command, because a chain's tail is what you actually wanted
the result of, and `npm run build` and `npm test` are deliberately not on it.

A supervised launch returns as soon as there is something true to say — the
**first** of ready, exited, or four seconds — so a server that crashes on boot is
reported in 400 ms with the stack in the result rather than after a three-minute
stall:

```
$ npm run dev
[background] service s1 started (pid 24188)
[ready] http://localhost:3000  (detected from output after 1.4s)
[log tail]
  > next dev
    - Local:  http://localhost:3000
Read more with bash_output({ service: "s1" }); stop it with bash_kill({ service: "s1" }).
```

Readiness is a URL the server printed, or one TCP connect to a port the command
named — and if that port was **already answering before the launch**, the probe
is switched off and the card says so, rather than calling somebody else's server
yours. A process that stays up without listening on anything (`tsc --watch`) is
reported as `running`, which is the honest third answer.

Each service gets a transcript card and a `svc N` chip in the status bar. Two
tools read and stop them:

- `bash_output({ service, since? })` — the log tail and the current status.
  `since` is the cursor the previous call returned, so a watcher can be read
  incrementally. The tail is a bounded in-memory ring of 200 rows; there are no
  log files on disk.
- `bash_kill({ service })` — stop one, or `"all"`.

**Services do not survive the CLI.** Quitting, `Ctrl+C`, `SIGTERM` and a crash
all reap the tree on a best-effort basis; there is no daemon, no PID file and no
reattach across launches. A `SIGKILL` of aragon itself is unrecoverable by
construction, and if a stop cannot confirm the process is gone it says
`may have left a detached child` rather than claiming success.

From your side there are two keys and one command: `Ctrl+C` stops every live
service (and does *not* arm exit), `/bg` lists them, and `/bg logs s1` prints a
tail without going through the model.

### Turning it off

```jsonc
// ~/.aragon/config.json
{ "bash": { "background": false } }
```

`ARAGON_BASH_BACKGROUND=0` does the same for one run;
`ARAGON_BASH_AUTO_BACKGROUND=0` keeps the tools but stops the classifier firing
on a command that did not ask. With `background: false` the build behaves exactly
as it did before this feature existed — no `background` parameter, no extra
tools, no prompt block, no chip.

Two things are **not** governed by that switch, because they are fixes rather
than features. `bash` now always settles: it returns when the process exits
rather than when its output stream closes, so a command that detaches a
grandchild can no longer leave the turn pending forever, and it is handed a
closed stdin so a command that prompts fails instead of blocking on a read
nobody will answer. Two `Esc` presses request interruption; another press force-stops a stuck run,
whatever the flag says.

## Team subagents

The agent can hand parts of a job to short-lived **subagents** that run in
parallel, then read one combined report of what they each found. It decides for
itself whether to delegate; a session that never calls `task` is the session
that existed before this feature.

```
> read the auth middleware, map the route table, and check the migration

 ◆ team  2 running · 1 done · 84s                             ✉ 1
 ⠋ a1  read the auth middleware      tool: grep         22.1s
 ⠙ a2  map the route table           thinking           31.6s
 ✔ a3  check the migration           done  4 turns      18.2s
```

**What a subagent is.** A full agent with its own message history, the same
tools and the same working directory — but no memory of your conversation, so
its brief has to be self-contained. It cannot delegate further (depth is capped
at one by construction) and it cannot ask you anything.

**Delegate wide, not deep.** Two to four subagents is the usual size. The
default cap is 5 per dispatch and 3 in flight at once; the hard maximum is 10
and no config file can raise it. `maxConcurrent` is separate from `maxSubagents`
on purpose: five simultaneous streams against one API key is a reliable way to
collect rate-limit errors, and each one would land in the report as a failed
subagent.

**The report.** One text result: a header with the ok/failed counts, aggregate
tokens and cost, then one section per subagent with its status, timing, the
files it wrote and its own final summary. A failed subagent never fails the
dispatch — partial results are the normal outcome of a fan-out. When two
subagents wrote the same file the header says so, phrased as a warning rather
than a fact: the file list is derived from `write_file` / `edit_file`, so a
write made through `bash` is invisible to it.

**Talking to each other.** Subagents get two extra tools, `team_send` and
`team_wait`. Messages are delivered by attaching them to the recipient's next
tool result, so nobody has to poll and nobody's work is interrupted. The limits
are the point rather than an afterthought: **6 messages per subagent, one every
15 seconds, 24 per dispatch**, a broadcast costing two. Every refusal is a plain
result naming the limit, never an error — an error reads as a malfunction and
invites a retry, which is the behaviour the limits exist to prevent.

**What you see.** While a dispatch runs, the roster above sits between the
transcript and the composer and the status bar carries `agents 3/5` (`[3]` under
100 columns). Both disappear when it finishes and the transcript keeps a card
with the per-agent results; `Ctrl+O` expands it to their summaries. Under `-p`
the same transitions go to stderr as `[team] a1 ok 22.1s 7 tools` lines, and the
children's tokens are folded into the `[usage]` footer.

**Interaction with the other subsystems.**

- **Plan mode reaches one level down.** In PLAN, every subagent is built with
  the same read-only gate, so `write_file` / `edit_file` / `bash` are refused
  inside them too. Parallel research is plan mode's best use, so `task` itself
  is allowed. A single subagent can be pinned read-only with `readOnly: true`
  even in a BUILD session — the field can only ever tighten.
- **A skill's `allowed-tools` ceiling reaches one level down too**, so
  delegating is not a way around it. Subagents get `skill_find` but not `skill`:
  loading a skill mutates a turn-scoped registry the lead owns, and three
  subagents doing it at once would narrow what the lead may do next in a way
  nothing would report. Always-on skills still reach them.
- **`--confirm`** queues subagent confirmations one at a time, labelled with the
  subagent that is asking (`[a2] Write: src/routes.ts`).
- **Logs.** `dispatch_start` and `dispatch_end` are recorded at `info` with the
  ok / failed / aborted counts and aggregate usage; phase transitions at
  `debug`. A `team_send` subject is recorded, never its body; a subagent's brief
  and summary only at `trace`.

**Two `Esc` presses within 1.5 seconds** abort the whole dispatch — every subagent within a couple of seconds
— and the report comes back marked `ABORTED` with whatever was finished.

## Fast model tier

A second, cheaper model can be made a first-class citizen of a session. It is
**off by default** — with `fast.enabled: false` the system prompt, the `task`
tool schema, the transcript and the request payloads are exactly what they were
before this feature existed — and it buys you two things once you turn it on.

**Delegation (the agent decides).** `task` gains one optional field per
subagent, `model: "fast"`. A child marked that way runs on the fast model and is
otherwise identical: same tools, same working directory, same `--confirm` gate,
same plan-mode gate, same skills ceiling. Delegating to a cheaper model is a
*model* choice, never a permission boundary. This is where "not complicated, but
very expensive in context" is actually paid for: a child that reads nine files
and reports four sentences moves ~200 KB of file bodies out of the lead's window
and onto a model that costs a fraction as much per token.

**Periodic review (the harness decides).** Every *N* completed turns, a small
digest of what the lead has been doing goes to the fast model with one question
— is this still on track? — and if the answer is not "on track" it is injected
back into the running loop as a `<fast_review>` block. The lead sees a short
second opinion mid-run, when it can still act on it, for a few hundred tokens
instead of a second full-size turn.

```
> refactor the config loader and keep the tests green

  fast review #2 · claude-haiku-4-5 · turn 12 · 1.4s
  You have edited config/schema.ts three times without running the tests.
  The clamp for reviewEveryTurns is missing its upper bound.
```

**The digest is bounded, and that is the whole economic argument.** The reviewer
keeps its own ring of recent turns — the tools you called, whether they failed,
the tail of what the model said — and never reads the message history. Sending
that history to the "cheap" model would make a review cost more than the turn it
is reviewing.

**Cost is attributed per tier.** A fast-tier subagent's tokens are priced at the
fast model's table, not the lead's, and the dispatch report states the two
separately. If the fast model is not in the built-in price table the number is
shown as `unknown` rather than as `$0.00` — a feature that looks free while it
is spending money is worse than one that admits it does not know.

**The review has a session budget, and delegation deliberately does not.** A
session is not one run — it is one run per message you send — so a cadence alone
bounds nothing over a working afternoon. `fast.reviewMaxPerSession` (default
**40**) is the total number of reviews a session may *start*; reaching it prints
one `info` notice naming the remedy, and `/fast status` reads `12/40` from the
first review rather than a bare count you can only size afterwards. Raise it live
with `/fast budget 80`. The budget is denominated in **reviews, not currency**,
because the fast tier is precisely where a model the price table has never seen
lives — a dollar ceiling would silently never fire for the configuration that
most needs one. Delegation is never budgeted: it is spend the lead chose in
service of a message you sent, it is already bounded by `team.*`, and it exists
to *reduce* total cost.

### Turning it on

```bash
aragon config set fast.model claude-haiku-4-5
aragon config set fast.enabled true
```

or, in a session: `/fast model claude-haiku-4-5` then `/fast on`. Either way the
tier is on for the next launch; `/fast on` in a session that started without it
saves the setting and says so, because the `task` schema is fixed at startup and
cannot grow a field mid-session.

| key | default | meaning |
|---|---|---|
| `fast.enabled` | `false` | Resolve the tier at all. |
| `fast.provider` | `''` | Empty inherits the main provider. |
| `fast.model` | `''` | The fast model id. Empty means *not configured* — it never falls back to the main model, so "same as main" stays distinguishable from a typo. |
| `fast.baseUrl` | `''` | Empty inherits the session's base URL **only** when the provider matches. |
| `fast.thinkingLevel` | `'off'` | Applied to fast children and to reviews. |
| `fast.delegate` | `true` | Allow `model:"fast"` on `task`. |
| `fast.review` | `true` | Run the periodic review. |
| `fast.reviewEveryTurns` | `5` | Turns between reviews (1–50). |
| `fast.reviewContextTurns` | `3` | Turns included in one digest (1–10). |
| `fast.reviewMaxChars` | `280` | Ceiling on an injected critique (80–600). |
| `fast.reviewMaxPerSession` | `40` | Reviews started per session, across all runs (1–500). There is no "unlimited" sentinel. |

**Flags:** `--fast` / `--no-fast`, `--fast-model <id>`, `--fast-provider <id>`,
`--fast-review <n|off>`. **Environment:** `ARAGON_FAST`,
`ARAGON_FAST_PROVIDER`, `ARAGON_FAST_MODEL`, `ARAGON_FAST_BASE_URL` — the four
that a container or a wrapper owning argv cannot otherwise reach. There is
deliberately no env var for the review cadence: tuning it is what the config
file is for.

**`/fast`** is the discoverable surface and `/fast status` is the guaranteed
reporting one:

```
/fast                      status, the resolved model, the cadence, session totals
/fast on | off             live switch
/fast model <id>           accepts provider:model
/fast provider <id>
/fast same                 run the fast tier on the main model
/fast review <n> | off
/fast budget [n]           the session review budget; bare form reads it
/fast delegate on | off
```

`/fast budget` with no argument is a **read**, so it is answerable while a `task`
dispatch is running; `/fast budget <n>` is a write and is refused mid-dispatch
like every other `/fast` setting.

**What you see.** A `fast` chip in the status bar's right cluster while the tier
is live (`fast*` while a review is in flight, dropped below 100 columns), a
one-line card per review in the transcript, and `n fast` plus a trailing `~` on
fast children in the team roster. `/fast status` reports the session totals the
status bar cannot: reviews run, children delegated, tokens and cost. Under `-p`
nothing extra is written to stdout or stderr — the review spend is folded into
the `[usage]` footer and the reviews are in the log.

**When the tier stops resolving.** `fast.provider: ''` inherits from the main
provider, so switching model or clearing a key can leave the tier unusable
mid-session. When that happens `model:"fast"` is downgraded to the main model,
the downgrade is **counted and stated in the dispatch report**, and one notice
names the reason. A silent downgrade would leave the agent believing its cost
model while paying full price.

**When the review fails.** Three consecutive *misconfiguration* failures (a
wrong model id, a dead gateway, a key with no access) disable the reviewer for
the session with exactly one warning. A busy provider — rate-limited or
overloaded — is treated as transient and never counts, because that condition
fixes itself and a session-long silent shutdown over it would not. A review that
you *cancelled* — Esc, a run that ended first, quitting — is neither: it leaves a
`cancelled` card and no strike.

**The review fails fast, and your own work does not.** The reviewer calls through
its own provider registry with **one** retry — not the ten `retry.maxRetries`
defaults to for the lead — and it does not observe `retry.*` or `/retry` at all.
That policy is a statement about how hard to fight for *your* answer; inheriting
it for a background advisory is how an unrequested call ends up competing with
you for a rate-limited provider's quota. The review's own wall-clock bound is
20 s.

## The context gauge

The right end of the status bar answers one question: **how full is the context,
out of how much.**

```
[####----] 43%  86.0k/200.0k   total 1.2M^ 48.0k v   $3.21   12 tok/s  1m02s
            ^        ^         ^
            |        |         +-- session spend, prompt side / output side
            |        +-- occupied / window
            +-- the two together, as a percentage
```

The readouts drop as the terminal narrows, in that order of priority:

| Columns | Right cluster |
|---|---|
| >= 96 | `[####----] 43%  86.0k/200.0k  total 1.2M^ 48.0k v  $3.21` |
| 72-95 | `[####----] 43%  86.0k/200.0k  $3.21` |
| 60-71 | `[####----] 43%  $3.21` |
| < 60 | `43%  $3.21` |

**Two different markers, because there are two different things to doubt.**

- `~` sits on the **percentage** and means the *numerator* is partly a guess:
  either no completed turn has reported usage yet (right after `/resume`, or
  right after a compaction), or tool results have been appended since the last
  measurement and their size is estimated.
- `?` sits on the **window** and means the *denominator* is a guess: the model is
  not in the built-in table, so a flat 128 000 was substituted. See
  `contextWindow` below.

**The percentage keeps moving during a turn.** Every tool result nudges it,
whether or not compaction is enabled — it is not a compaction feature, and a
session started with `--no-compaction` gets the same live reading. After
`/resume` the gauge shows the restored session's real occupancy immediately,
without sending anything.

### `/context`

The gauge is a bar and a rounded percentage; `/context` is the full answer, at
any width, in any mode:

```
Context
  Occupancy      43%   86.2k of 200.0k   [measured 85.1k + 1.1k estimated]
  Window         200000   from the model table
  Since measured 1.1k estimated tokens appended since the last provider-reported usage
  Compaction     on - triggers at 90% (amber at 75%), 2 this session, 118.0k reclaimed
  Session spend  1.2M in (incl. 940.0k cache read, 12.0k cache write) / 48.2k out, $3.21
                 includes subagent, fast-tier and compaction spend,
                 not just this conversation
```

Two lines are worth reading closely. **`Window`** always names where the number
came from — the model table, your own `contextWindow`, or the invented
placeholder — because those are indistinguishable everywhere else. And
**`Compaction`** reports what is actually true of this session, including
`off - not registered for this session (started with --no-compaction)`; it never
promises a threshold that nothing will act on.

### `contextWindow`

When the model is not in the built-in table — a custom `baseUrl`, a self-hosted
id, something released last week — the denominator is a **fabricated** 128 000
and the percentage is meaningless. Correct it:

```bash
aragon config set contextWindow 1000000   # persisted; prints "Set contextWindow = 1000000"
aragon config set contextWindow auto      # back to the model table / placeholder
ARAGON_CONTEXT_WINDOW=1000000 aragon      # one session
```

Values are clamped to `[8000, 5000000]`; `auto` (the default) is stored as
`null`. Setting it removes the `?` marker, because you have asserted the number —
and `/context` still shows that it came from you, which is what makes a wrong
value findable.

## Context compaction

A long agentic run fills the model's context window. Before this existed, the
only ending available to it at that point was an HTTP 400 and a banner telling
you to start over — which threw away everything the run had done.

Now the CLI **compacts** instead. When the conversation occupies **90 %** of the
window, the run pauses at a turn boundary, hands the older part of the history to
a summarizer, and swaps it for a structured record. Your original task stays
**verbatim**, the most recent turns stay **verbatim**, and the run continues in
the same loop with the same tools, the same todo list and the same working
directory. Nothing about the session restarts.

**It is on by default**, unlike every other optional subsystem here, and that is
deliberate: the fast tier and team mode *add* behaviour you did not ask for,
while this one *removes* a failure you did not ask for. `--no-compaction` or
`compaction.enabled: false` restores the old behaviour exactly — no manager is
constructed, nothing is subscribed, and a full window ends the run as it did
before.

### What actually happens

1. **Proactively**, when measured occupancy crosses the threshold. This is the
   case that fires almost every time.
2. **Reactively**, when the provider returns `context_overflow` anyway — because
   the model's context window is not in the static table, or you are pointed at a
   proxy in front of a smaller model. One compaction, one re-send, run continues.
   The engine allows exactly one of these per turn.
3. **Manually**, with `/compact`. While the agent is idle it runs immediately;
   while it is running it queues and fires at the next turn boundary.

The trigger has **two** terms, and the second one is not belt-and-braces: 90 % of
a 200 k window leaves 20 k, which is plenty, but 90 % of a 32 k window leaves
3.2 k — less than a single `max_tokens` of 8192, so the request is already
impossible. Compaction therefore also fires whenever the remaining headroom drops
below one full response.

### Which model summarizes, and what it costs

**By default, your own model.** `compaction.useFastTier` is `true`, but it
describes a *preference*: the fast tier only resolves when you have configured
it, and it is off by default. So out of the box the first compaction is a
~30 k-token call **on the session's own model** — real money on a frontier model,
spent by a feature that is on by default.

Three things make that the right trade rather than a hidden cost. It happens at
most 5 times per run. The alternative is losing the entire run. And the spend is
visible: it goes into the session total, it is priced with the *summarizer's* own
table, and `/compact status` reports `pricing unknown` rather than `$0.00` when
the model is not in that table.

To make it cheap, configure the fast tier (`/fast on`, `/fast model <cheap-id>`).
The transcript card then names the cheap model.

### When it cannot summarize

Summarization is a network call and it will sometimes fail. The ladder is: one
retry — on your **main** model if the first attempt used the fast tier, because
"a fast model that cannot summarize" is the likeliest single failure — and then,
by default, a **truncation**: the same cut, the same verbatim task, and a block
that says plainly that the dropped messages were not summarized. That is
announced on the card, in the transcript, on the JSON event stream and inside the
block the model itself reads.

Truncation loses information, and it is still the default, because an unattended
`aragon exec` that wedges on an unrecoverable 400 loses the whole run.
`compaction.onFailure: "stop"` makes the other trade: the history is left alone,
an error names your exits, and the next request will probably fail — which is
what you asked for by setting it.

### It will not loop on your money

Four independent guards: never two compactions on consecutive turns, never more
than 5 per run, a splice that does not project a real reclaim does not count as
progress, and two consecutive no-progress compactions **switch the proactive
trigger off for the session** with a notice naming the cause and the fix.

The guards are trigger-aware. A *pressure* compaction that reclaims little has
spent money to buy two turns and should stop. An *overflow* compaction that
reclaims little is the difference between a live run and a dead one, because the
provider has already refused the request — so the reactive path stays armed even
after a self-disable, and an overflow attempt may halve `keepRecentTurns` for
itself, which is the one lever that can make a too-large tail fit.

### What you see

Three surfaces, each answering something the others cannot:

- **While it runs** — the activity row reads `Compacting context…`. It outranks
  the tool name and the rotating phrase, because compaction happens between
  turns and the phrase would otherwise claim the model is thinking. The
  transcript card counts the seconds and tells you `esc to cancel`, which has
  always been true and was never said.
- **As state** — a `compacting` chip in the status bar, and the context gauge's
  colours aligned to your own thresholds. The gauge **falls immediately** after a
  compaction rather than waiting for the next turn, with a `~` while the value is
  derived rather than measured. The colours follow your configured thresholds
  whenever compaction is **enabled**, even if no summarizer model currently
  resolves; after `/compact off` they fall back to the generic 60 / 85, because
  colouring by a rescue that is not coming is worse than not colouring at all.
- **As a record** — a transcript card with the before/after message and token
  counts, the summarizer, the duration, and the summary itself. `Ctrl+O` expands
  it.

**What a red gauge means:** the trigger is `>= threshold` while the red band is
`> threshold`, so any occupancy that would paint red has already triggered
compaction and the bar repaints downward in the same frame. Red is therefore only
ever visible when compaction did **not** or **could not** run — it is off, it
self-disabled, or the ladder ran out.

`/compact status` is the guaranteed surface: the chip drops on a narrow terminal
and the card scrolls away, but the command answers at any width, in any mode,
after the fact. For the gauge specifically, [`/context`](#the-context-gauge) is
the equivalent — and it works in a session that never registered compaction at
all.

### When the RECENT turns are what does not fit

Every rung above operates on the **head** of the conversation. When the retained
tail is the problem — a few turns each carrying several 100 KB tool results —
each of those rungs reports success or "nothing to drop" while the history stays
un-sendable.

The last rung clips oversized `tool_result` bodies **inside the retained turns**,
oldest first, stopping the moment the request fits. Nothing is removed: no
message, no tool-call id, no role — so a history that was structurally valid
before is still valid after. Every clip is announced **in the text the model
reads**, at the exact place the data went:

```
[... 214003 characters removed by context compaction ...]
```

A model that sees that knows the output is partial and can re-run the tool. It is
also stated on the transcript card, in `/compact status`, on the JSON event
stream and in the archive. When clipping is the **only** thing that happened, the
card says so and names no model, because none was called.

### Sub-agents get the same protection

A `task` child is bounded by `team.maxTurnsPerSubagent` (24) and
`team.dispatchTimeoutMs` (15 minutes) — the same profile as a lead run that fills
a window. When a child overflowed, its history was discarded and the whole
dispatch reached you as one partial sentence.

Children now compact their own history, under tighter bounds: **two** retained
turns instead of four, at most **two** compactions per child instead of five, the
fast tier preferred whenever it resolves, and `onFailure` forced to `truncate`
because nobody is watching a background worker. There is no transcript card for a
child — the lead's transcript describes the lead's context. Turn it off with
`compaction.subagents: false`.

### A compaction is no longer irreversible

Before a splice is adopted, the dropped messages are written verbatim to
`~/.aragon/compaction/` — metadata, the summary, and the messages themselves.

`/compact history` lists **this run's** archives, newest first, with the path of
each. `/compact show <n>` prints one archive's metadata and its stored summary;
it never prints message bodies, because a single archive can be megabytes and the
transcript is not a pager. The directory is shared by every `aragon` on the
machine, so files carry a per-process run id: another terminal's compactions are
counted in one trailing line rather than listed as yours.

Retention is two-tier and bounded: the newest 20 files **of this run**, plus a
seven-day sweep across all runs. Writing is best-effort — a failure is logged and
never affects the compaction. `compaction.archive: false` turns it off and writes
nothing.

This is **not undo**: restoring an over-full history restores the condition that
triggered the compaction, and the next request fails. It is fidelity on disk, so
"the summary was wrong and the agent proceeded on a false record" is something
you can check rather than something you have to accept.

### Configuration

```jsonc
{
  "compaction": {
    "enabled": true,          // false restores the pre-feature behaviour exactly
    "threshold": 0.9,         // [0.5, 0.95]
    "warnThreshold": 0.75,    // [0.4, threshold - 0.05]; where the gauge turns amber
    "keepRecentTurns": 4,     // [1, 20] complete turns kept verbatim
    "useFastTier": true,      // summarize with the fast tier WHEN it resolves
    "onFailure": "truncate",  // or "stop"
    "subagents": true,        // give `task` children their own compaction
    "archive": true           // write the dropped messages to ~/.aragon/compaction
  }
}
```

Environment: `ARAGON_COMPACTION=0|1`, `ARAGON_COMPACTION_THRESHOLD`,
`ARAGON_COMPACTION_KEEP_TURNS`, `ARAGON_COMPACTION_SUBAGENTS`,
`ARAGON_COMPACTION_ARCHIVE`.

### The part that cannot be fixed

A summarizer that is 90 % faithful will, eventually, drop something the run
needed. No amount of prompt engineering closes that. What this design does is
bound it: your task is verbatim, the recent turns are verbatim, the block tells
the model the record is partial, and three surfaces make it visible so you can
step in. That is the same trade Claude Code and Codex make, and it is preferable
by a wide margin to the alternative, which is losing the entire run.

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
| `project` | `<cwd>/.aragon/skills/` | yes |
| `project` | `<cwd>/.claude/skills/` | no — read-only Claude Code interop |
| `env` | `ARAGON_SKILLS_PATH` (`:`/`;`-separated) | no |

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
  `GOOGLE_API_KEY` / `GEMINI_API_KEY`, plus `ARAGON_PROVIDER`, `ARAGON_MODEL`,
  `ARAGON_BASE_URL`, `ARAGON_THINKING`, `ARAGON_SHOW_THINKING` (`1` shows
  reasoning blocks), `ARAGON_LIVE_TOOL_OUTPUT` (`0` keeps a running tool card to
  one line),
  `ARAGON_MAX_TOKENS` (a number, or `auto` / `0` for the per-model ceiling),
  `ARAGON_CONTEXT_WINDOW` (a number, or `auto`; the denominator the context
  gauge measures against),
  `ARAGON_THEME`,
  `ARAGON_PLAN` (`1` starts in plan mode),
  `ARAGON_TEAM` (`0` disables team subagents), `ARAGON_TEAM_MAX` (fan-out width),
  `ARAGON_TODO` (`0` disables todo planning entirely),
  `ARAGON_TODO_FOLLOW` (`notify` / `auto` / `off`),
  `ARAGON_RETRY` (`0` disables API retry), `ARAGON_RETRY_MAX` (retry count; `0`
  also disables),
  `ARAGON_UPDATE` (`0` / `off` disables auto-update, `notify` reports without
  installing), `ARAGON_UPDATE_REGISTRY` (registry base URL for the update check),
  `ARAGON_SKILLS` (`0` disables), `ARAGON_SKILLS_PATH`,
  `ARAGON_SKILLS_DISABLED` (comma-separated names), `ARAGON_LOG_LEVEL`,
  `ARAGON_LOG_FILE` (`0` disables), `ARAGON_LOG_DIR`,
  `ARAGON_TRANSCRIPT_RETAIN`, `ARAGON_RENDER_GOVERNOR` (`0` disables),
  `ARAGON_MAX_RENDER_INTERVAL_MS`.
  `ARAGON_HOME` is the exception that **cannot** come from `.env`: it is read
  before any `.env` is loaded. See [Files & logs](#files--logs).
- **User config file** (`aragon config path`): JSON, written `0600` on POSIX.
  Holds provider / model / keys and your preferences, and nothing else — the
  prompts you type and the counters behind one-time notices live in their own
  files (see [Files & logs](#files--logs)). Keys are masked in the UI and never
  logged. It lives in your home directory — see [Files & logs](#files--logs) —
  and editing it by hand is supported: `aragon config edit` opens it, and an
  invalid edit is reported rather than silently resetting every setting.

| Config key | Default | Meaning |
| --- | --- | --- |
| `maxTokens` | `64000` | Output token cap, clamped to `[256, 200000]`. `null` means **auto** — use each model's own ceiling, never above 64000. Absent means the default. See [Output token limits](#output-token-limits). |
| `contextWindow` | `null` | The window the context gauge measures against, clamped to `[8000, 5000000]`. `null` means **auto** — the built-in model table, or a fabricated 128000 for a model it has never seen. Set it when the gauge shows `?` on the denominator. See [The context gauge](#the-context-gauge). |
| `showThinking` | `false` | Draw the reasoning the model returns. `thinkingLevel` is the effort the provider is asked to **spend**; this is whether the terminal **shows** it. Off by default: a settled turn that thought leaves one muted `thought for 12s` row in its place, so nothing is hidden silently. |
| `liveToolOutput` | `true` | Draw up to eight sanitised rows of a **running** tool's output on its card, plus a `no output for Ns` row when the child goes quiet. On by default, unlike `showThinking`: this ADDS the information a long `bash` call otherwise hides, and its cost is bounded by construction — eight rows per call, sixteen calls, whatever the command emits. Turn it off and the card is a single `running` row again, with no store allocated and no recorder attached. |
| `exitTranscript` | `true` | Replay a plain-text session summary after exiting (full-screen only). |
| `transcriptWindow` | `1000` | How far back you can scroll, clamped to `[50, 20000]`. Entries beyond it collapse into one line. It is no longer a rendering budget: the viewport is virtualised, so off-screen entries are not laid out at all. |
| `transcriptRetain` | `1000` | Entries kept in memory, clamped to `[200, 20000]` and raised to `transcriptWindow` if the two conflict — with a startup notice saying so, because retaining less than you can scroll to would otherwise make part of the horizon quietly unreachable. Older entries are dropped, counted, and reported by `/perf` and by the exit replay. |
| `renderGovernor` | `true` | Widen the streaming frame interval when a frame is genuinely expensive. See [Render performance](#render-performance). |
| `maxRenderIntervalMs` | `320` | Ceiling of the governor ladder, clamped to `[33, 1000]`. `33` flattens it to the pre-0.6 cadence without disabling the mechanism. |
| `planModeDefault` | `false` | Start every session in plan mode. `--no-plan` still overrides it for a single run. |
| `planModeMaxAskRounds` | `4` | `ask_user` rounds allowed per user message, clamped to `[1, 10]`. The counter resets on your next message; steering does **not** reset it. |
| `planModeHumanTimeoutMs` | `1800000` | Ceiling on a single question / plan wait, clamped to `[60000, 7200000]`. Thirty minutes is far outside "went to get coffee", but a ceiling has to exist so an unattended terminal cannot wedge a CI job forever. |
| `paste` | `true` | Recognise pasted text before Ink's key parser sees it: line breaks become buffer newlines instead of fifteen separate messages, control bytes are stripped instead of overwriting the row they land on, and a paste above 6 lines or 400 characters collapses to a one-line placeholder that expands when you send. `false` treats pasted bytes as keystrokes, which is what 0.6.2 did. |
| `historyEnabled` | `true` | Record submitted prompts to `prompt-history.jsonl` for `↑` recall. Setting it to `false` stops new writes; it does not delete what is already stored (that is `aragon history clear --yes`) and does not stop reading. See [Prompt history](#prompt-history). |
| `team.enabled` | `true` | Master switch for team subagents. `false` means the `task` tool is never registered — `/team on` in such a session saves the setting for next launch and says so, rather than advertising a tool that is not there. |
| `team.maxSubagents` | `5` | Subagents per dispatch, clamped to `[1, 10]`. The 10 is the hard ceiling and is enforced twice — on the config value and again on what the model asks for — so hand-editing this file cannot raise it. |
| `team.maxConcurrent` | `3` | Subagents in flight at once, clamped to `[1, 10]` and capped at `maxSubagents`. A separate knob because provider rate limits are a different constraint from context economics. |
| `team.subagentTimeoutMs` | `300000` | One subagent's wall clock before it is aborted, clamped to `[30000, 1800000]`. A wedged subagent dies on its own ceiling without taking the dispatch with it. |
| `team.dispatchTimeoutMs` | `900000` | The whole dispatch's wall clock, clamped to `[60000, 3600000]`. |
| `team.maxTurnsPerSubagent` | `24` | Runaway-loop cap, clamped to `[4, 100]`. A subagent stopped here is reported as `stopped: turn cap reached`, with whatever it had produced. |
| `todo.enabled` | `true` | Master switch for todo planning. `false` means the `todo_write` tool is never registered — `/todo on` in such a session saves the setting for next launch and says so, rather than advertising a tool that is not there. |
| `todo.panel` | `true` | Render the right-hand rail. Independent of `todo.enabled` on purpose: a screen-reader user wants the planning discipline without the column, and the system prompt varies one sentence accordingly. |
| `todo.followThrough` | `"notify"` | What happens when a run ends with steps left. `notify` says so and stops; `auto` continues the plan after a 3-second grace window, bounded by two structural limits (one fruitless attempt, 25 continuations per plan) that are deliberately **not** settings; `off` is silent. An unrecognized value falls back to `notify`. |
| `retry.enabled` | `true` | Retry a failed provider call at all. Unlike `team.enabled` / `todo.enabled` this decides nothing at construction — the policy lives on the provider registry, so `/retry on` / `/retry off` takes effect **in the running session**, subagents included. |
| `retry.maxRetries` | `10` | Retries **after** the first attempt, clamped to `[0, 20]`. `0` is the kill switch and is a real value here, not a typo for the default. The 20 is a hard ceiling enforced twice — on the config value and again inside the engine — so hand-editing this file cannot raise it. |
| `retry.initialDelayMs` | `1000` | The first wait, clamped to `[100, 30000]`. |
| `retry.maxDelayMs` | `30000` | Ceiling on one wait, clamped to `[1000, 120000]` and raised to `initialDelayMs` if the two conflict. Kept below the engine's 60 s idle window on purpose, so the mechanism does not depend on the watchdog pause being correct — it merely benefits from it. |
| `retry.multiplier` | `2` | Growth factor, clamped to `[1, 5]`. The one **float** key in this section: `2.5` is a legitimate factor and is stored as typed. |
| `retry.jitter` | `true` | Equal jitter (`d/2 + rand·d/2`), which de-correlates concurrent subagents hitting the same 429 while keeping the announced countdown within a factor of two of the truth. Full jitter can fire 40 ms after announcing 30 s, which reads as a bug. |
| `retry.respectRetryAfter` | `true` | Honour `Retry-After` (and the provider rate-limit reset headers) as a **floor**, never a replacement — a `Retry-After: 1` on the ninth retry does not undo eight retries of backoff. A stated wait above 60 s is surfaced immediately instead of waited out. |
| `retry.maxElapsedMs` | `240000` | Wall-clock budget from the first failure, clamped to `[10000, 1800000]`. Deliberately **below** `team.subagentTimeoutMs`: an equal budget means a subagent is killed at the same instant its ladder ends, and the user is then told "subagent timed out" for what was a provider outage. |
| `retry.onPartialStream` | `true` | Allow a restart after content has already streamed to the transcript. The view is rewound and the discarded tool cards removed; engine history is provably clean at that point, because it is only written on a completed turn. `false` refuses the whole path. |
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
| `log.level` | `info` | `silent` · `error` · `warn` · `info` · `debug` · `trace`. See [Files & logs](#files--logs) for what each level records. |
| `log.toFile` | `true` | Write records to a file at all. `false` here is respected; `--log-file` overrides it for one run. |
| `log.dir` | `""` | Log directory. Empty means `<home>/logs`. Only **absolute** paths are accepted — a relative one would mean a different directory for every working directory you launch from. |
| `log.maxFileBytes` | `5242880` | Rotate once a file would exceed this, clamped to `[65536, 268435456]`. |
| `log.maxFiles` | `10` | Files kept in the log directory, clamped to `[1, 200]`. The oldest beyond this are deleted — on rotation **and** on the first write of each day. |
| `log.redactSecrets` | `true` | Run every record through redaction. Setting it to `false` is the one way to get credentials onto disk, so it prints a warning and has no settings-screen entry. |
| `log.previewChars` | `512` | How much user content `debug` keeps per field, clamped to `[0, 8192]`. `trace` is never truncated. |

Byte, not character: `ToolExecutor` truncates at 100 000 **bytes**, so a
character-based budget would be roughly triple its nominal size for CJK text
and would get cut mid-tag.

### Output token limits

Every model and every provider defaults to **64000** output tokens. You never
have to configure this, and if you never touch it the number stays 64000.

The number you set is an **ambition, not a promise**: it is clamped down to
whatever the target model actually accepts. `gpt-4o` caps at 16384 and
`gemini-1.5-pro` at 8192, and sending 64000 to either is an HTTP 400 that ends
the turn — so `aragon` sends what the model will take, silently. When the model
is one it has never seen (a proxy, an endpoint behind `--base-url`, a model that
shipped last week), it sends 64000, and if the provider objects it reads the real
ceiling out of the provider's own error, repairs the request, sends it again, and
remembers the answer for the rest of the session. You see one warning line and
the run continues.

Four ways to change it, highest priority first:

```bash
aragon --max-tokens 32000            # this run only
aragon --max-tokens auto             # this run only, per-model ceiling
ARAGON_MAX_TOKENS=32000 aragon       # env layer, between the flag and the file
aragon config set maxTokens 32000    # persisted; prints "Set maxTokens = 32000"
aragon config set maxTokens auto     # persisted as null
aragon config set maxTokens default  # back to 64000
aragon config set contextWindow 1000000  # the gauge's denominator
aragon config set contextWindow auto     # back to the model table
aragon config get maxTokens          # "64000" | "auto"
```

Inside the TUI, `/max-tokens` reports the current setting **and** the effective
cap for the live model, and `/max-tokens <n|auto|default>` changes it. The
settings screen (`/settings`) has the same field with an `Effective:` line under
it, so a value the model will not honour is visible before you save it.

And by hand, in `~/.aragon-agent/config.json` (`aragon config path` prints the
exact location; `aragon config edit` opens it, and `/reload` picks up an edit
made in another window):

```jsonc
{
  "version": 1,
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",

  // Output token cap.
  //   64000  (or any 256..200000 integer) — an explicit cap, clamped down to
  //          the target model's real ceiling when that ceiling is lower.
  //   null   — auto: use each model's own ceiling, never above 64000.
  //   absent — the product default, 64000.
  "maxTokens": 64000
}
```

Out-of-range numbers are clamped on the way in **and** on the way out, so a
hand-edited `900000` becomes `200000` on disk rather than reverting to the
default on every launch.

Extended thinking is reconciled with the cap automatically: `--thinking xhigh`
asks for a 65536-token budget, Anthropic requires `max_tokens` to be strictly
greater than it, and the two are resolved together rather than left to collide.

These are additive: a config file written by an earlier version loads
unchanged, with no migration and no version bump.

## Auto-update

`aragon` checks npm for a newer release in the background, installs it silently
into the same global installation you already have, and tells you on one line
above the composer:

```
  * 0.6.0 installed - restart aragon to apply
```

**The running session is never touched.** The new version lands on disk and
takes effect the next time you start `aragon`. A restart in the middle of a turn
would destroy a live run, a subagent dispatch and an open plan review, so the
line waits and you decide when. Nothing else about the check is visible: it
happens at most once every four hours, at most once per machine per interval,
and every failure is silent. Only after three consecutive failures does the line
say anything, and then it says something you can act on.

**It only ever installs for one kind of installation**: a global `npm i -g`,
where nothing else claims to own the version. If `aragon` came from pnpm, yarn,
bun or volta it will not run a command on your behalf — it prints the right one
for your manager and stops. If it came from `npx`, from a project's
`node_modules`, or from a clone of this repo it says **nothing at all**: an
`npx` run resolved `latest` seconds ago, a project's manifest deliberately pins
the version, and a checkout is not out of date. A global directory it cannot
write to (the usual Linux case) is detected before anything is spawned.

### The four keys

| Key | Default | Meaning |
| --- | --- | --- |
| `update.mode` | `auto` | `auto` installs · `notify` only reports · `off` disables the subsystem entirely |
| `update.checkIntervalMs` | `14400000` (4 h) | Minimum time between registry checks, across every `aragon` on this machine |
| `update.registry` | `''` | Registry base URL. Empty derives it: `ARAGON_UPDATE_REGISTRY`, then `npm_config_registry`, then npmjs |
| `update.distTag` | `latest` | The dist-tag to track |

```bash
aragon config set update.mode notify     # tell me, do not install
aragon config set update.mode off        # never check at all
ARAGON_UPDATE=0 aragon                   # off for this run
aragon --no-update                       # the same, as a flag
aragon update --check                    # ask right now, install nothing
aragon update                            # ask right now, install if eligible
aragon update --to 0.5.8                 # go back to a specific version
aragon update --rollback                 # undo the last auto-update
```

`aragon update` is also the answer for headless users: the background updater is
only ever constructed for an interactive session, so `aragon -p "…"`,
`aragon config set`, CI (any truthy `CI`) and any non-TTY execute **zero** lines
of update code.

### If an update breaks the CLI

The failure an auto-updater has to answer for is the one where the version it
installed will not start — an undeclared dependency, a Node API that moved, a
syntax error past the transpile target. None of those reach any line inside
`main()`, so no amount of care there helps.

So the `aragon` command is a small launcher that runs **before** the CLI itself.
It reads one file, and on almost every launch that is all it does. But if the
version it is about to start is one **this updater installed**, and that version
has already exited non-zero twice, it reinstalls the version you were running
before the update and marks the bad one so nothing puts it back:

```
aragon 0.6.0 failed to start twice; rolling back to 0.5.9.
```

It boots anyway — if the crash was transient, refusing to start would lock you
out on a guess. The next session tells you once what happened, and then stops
mentioning it. A **newer** release clears the mark and installs normally: you
were never opted out of updates, only out of the loop.

Three things this deliberately does not do. It never touches a version **you**
installed yourself — `npm i -g @aragon-agent/cli@something` is your decision, and
an updater that silently reverts it is a worse actor than one that does nothing.
It does not roll back a release that starts and is merely *wrong*; that is not
detectable from inside, and a heuristic that guessed would eventually revert a
working version on a bad day. Use `aragon update --rollback` for that — it is the
same mechanism, run deliberately. And **`update.mode: off` disables this too**:
the guard is armed only by an auto-install, so a machine that never auto-installs
never arms it. That is the honest reading of the kill switch — it turns off the
whole subsystem, recovery included.

### Behind a proxy

Node's own `fetch` ignores `HTTP_PROXY`, so on a proxied machine the direct check
simply fails. When it does, `aragon` asks **the npm you already have** instead,
which honours `proxy`, `https-proxy` and your `.npmrc`. It runs only after the
direct request has already failed, so on an ordinary machine it never runs at
all. `/update status` shows `probe: npm` when this is what answered.

No credentials are read or forwarded by either path — we run the command you
could have typed and read one version string out of its JSON.

### The trade this makes

Auto-update widens the window in which a compromised release could reach you
without a human deciding to fetch it. That is a real cost, and it is worth
stating plainly rather than burying:

- npm verifies each package against the registry's `dist.integrity` SRI hash, so
  what is installed is what was published. That protects the transport, not the
  publisher.
- Only the `latest` dist-tag is tracked, prereleases are never installed onto a
  stable version, and a release its own author has `npm deprecate`d is skipped.
- `update.mode: off` and `ARAGON_UPDATE=0` are kill switches, and they are
  documented rather than incidental.
- Organisations that want a review gate point `update.registry` at a mirror they
  control.

No credentials are ever sent with the check. The updater does not read
`_authToken` out of your `.npmrc` — an updater that attached a token to a
user-configurable URL would be a credential-exfiltration primitive the moment
that URL was mis-set. Private-registry users should point `update.registry` at a
mirror they can read anonymously, or turn the feature off.

## Files & logs

Everything AragonAgent keeps for you lives under one directory in your home:

```
~/.aragon-agent/                    (Windows: C:\Users\<you>\.aragon-agent\)
├── config.json                     settings + API keys (0600 on POSIX)
├── config.json.bak                 written by `aragon config edit` before it opens
├── prompt-history.jsonl            prompts you submitted, for ↑ recall (0600 on POSIX)
├── state.json                      UI bookkeeping: submit count, one-shot notices
├── update-state.json               auto-update: last check, pending restart, skipped version,
│                                   and the boot guard's rollback bookkeeping
├── logs/
│   ├── aragon-2026-07-27.log       today, JSON Lines
│   └── aragon-2026-07-27.1.log     rotated at log.maxFileBytes
├── sessions/                       /save and /resume
├── skills/                         aragon skills install
└── skill-usage.json
```

`config.json` holds **settings only**. What you typed and how often you have
typed it live in the two files next to it, so that editing your config means
scrolling past your own settings and nothing else, and so that submitting a
prompt no longer rewrites the file that holds your API keys.

`ARAGON_HOME` moves the whole tree. **It cannot come from a `.env` file** — the
path is resolved when the process starts, long before a `.env` is read — so set
it as a real environment variable. `aragon config home` always prints the
directory actually in use.

Upgrading from 0.5.0 or earlier moves your config, sessions and skills here
automatically, once, and prints a line on stderr when it does. The old
`%APPDATA%\aragon-agent-nodejs` / `%LOCALAPPDATA%\aragon-agent-nodejs`
directories are **left in place** so that reinstalling an older build stays
lossless; `aragon config home` names them, and you can delete them once you are
satisfied.

### Prompt history

Every prompt you submit is appended to `~/.aragon-agent/prompt-history.jsonl`,
one JSON object per line, so that `↑` recalls it — in this session and in every
later one. It is written `0600` on POSIX, it never leaves the machine, and it is
**stored verbatim**: a redacted history would recall the wrong text, which is
worse than not recalling at all.

The last 100 distinct prompts are what `↑` walks. The file is rewritten down to
that many entries once it passes 400 lines, and a single submission longer than
16 KiB is not recorded at all rather than recorded truncated.

```bash
aragon history path           # where it is, plus a reminder of what is in it
aragon history list -n 50     # the 50 most recent, newest first
aragon history list --json    # raw entries with timestamps
aragon history clear --yes    # delete the file
```

Set `historyEnabled` to `false` (`aragon config set historyEnabled false`) to
stop recording. Switching it off does **not** delete what is already stored —
`aragon history clear --yes` does that — and reading keeps working either way,
so you can look before you erase.

Upgrading from 0.5.x moves an existing `promptHistory` out of `config.json` into
this file once, automatically and silently.

### What gets logged

Logs are local files. Nothing is uploaded, ever — there is no network path out
of this subsystem at all.

| Level | Records | Contains your content? |
| --- | --- | --- |
| `error` | crashes, failed requests, config write/parse failures | no |
| `warn` | degraded migrations, clamped values, dropped records | no |
| `info` *(default)* | start/exit, config writes, turn boundaries with token counts, tool names and durations | **no** |
| `debug` | the above, plus prompts, replies and tool arguments truncated to `log.previewChars` | yes, truncated |
| `trace` | full message bodies and full tool output | yes, in full |

The default is `info` specifically so that attaching a log to a bug report is
safe. **`debug` and `trace` write what you typed and what the model replied** —
check before sharing one.

API keys are removed at every level, by two independent passes: any field whose
name looks like a credential is blanked whatever it holds, and every string is
scanned for known key formats *and* for the literal keys this process is
holding. The second half is what covers a custom endpoint whose key looks like
nothing in particular. Setting `log.redactSecrets false` disables both, and says
so on stdout when you do.

### Commands

```bash
aragon logs path              # where records are going right now, and at what level
aragon logs list              # files, sizes, timestamps
aragon logs tail -n 50        # render the last 50 records
aragon logs tail --follow     # keep printing new ones
aragon logs tail --json       # raw JSON Lines, for jq
aragon logs tail --level warn # only warn and above
aragon logs clear --yes       # delete every log file
aragon logs open              # open the directory in your file manager

aragon history path           # where prompt history is kept
aragon history list -n 50     # the 50 most recent prompts, newest first
aragon history clear --yes    # delete the prompt history

aragon config home            # the user-state root (and whether ARAGON_HOME set it)
aragon config get log.level   # one value; secrets always masked
aragon config list --json     # everything; secrets always masked here too
aragon config edit            # open config.json in $VISUAL / $EDITOR
```

Per-run overrides, none of which are persisted:

```bash
aragon --log-level debug "…"   # or --verbose, which means the same thing
aragon --no-log-file "…"       # nothing reaches a file this run
aragon --log-dir D:\logs "…"
```

`ARAGON_LOG_LEVEL`, `ARAGON_LOG_FILE=0` and `ARAGON_LOG_DIR` do the same from the
environment, and unlike `ARAGON_HOME` these three *can* come from a `.env`.

### Insecure TLS opt-in

When `NODE_TLS_REJECT_UNAUTHORIZED` is the exact string `0`, the installed or
locally built `aragon` process honors that setting and suppresses only Node's
standard insecure-TLS warning. Every unrelated process warning remains visible,
and any other value leaves warning behavior unchanged. The check happens when a
warning is emitted, so a `0` loaded from the project `.env` is covered too; the
CLI never creates, normalizes, or persists this variable.

> **Security warning:** `0` genuinely disables certificate verification. It does
> not make an insecure connection safe and can expose credentials or request
> contents to interception. Use it only in a controlled environment where you
> accept that risk.

The automatic filter starts with the `aragon` process. An earlier `npm install`
or `npx` bootstrap belongs to npm and is outside the installed package's process
boundary, so that parent may still print Node's warning. The official repository
release flow covers its npm children through `publish-latest.ps1`; callers that
own another npm/npx parent must preload the filter in that parent themselves if
quiet output is required.

### Theming & color

`--theme` / `config.theme` / `/theme` pick a palette: `warm`, `cool`, `light`, or
`auto` (which resolves to `warm` — terminals can't reliably report their
background). `dark` remains accepted everywhere as an alias for `cool`.
Colors degrade automatically to your terminal's depth (truecolor → 256 → 16 →
monochrome) and glyphs fall back to ASCII on terminals without Unicode. Color is
disabled — and the UI renders plain monochrome with ASCII glyphs — when any of
`NO_COLOR`, `--no-color`, `TERM=dumb`, or `config.color=false` is set; `FORCE_COLOR`
is respected. `reducedMotion` (also `ARAGON_REDUCED_MOTION`, and implied by
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
  `Esc` twice interrupts mid-run, `/model` switches models, `/settings` saves a key,
  `Ctrl+C` twice exits.
- `echo "list files" | node dist/cli.js -p` prints an answer and exits `0`.
- A missing/invalid key produces a visible, actionable message (never a blank
  screen), both in the TUI and headless.
- `Shift+Tab` at 40, 80 and 120 columns - the chip, the hint and the status bar
  are all legible and nothing wraps onto a second row.
- The question wizard at 24 rows with 5 questions x 4 options - no clipping, and
  the `n/N` counter matches what is on screen.
- Approve a plan and watch the SAME run start writing files, with no second
  prompt.
- `--no-color` on a legacy `cmd.exe` - the chip renders `[PLAN]`, radios render
  `*`/`o`, checkboxes render `[x]`/`[ ]`, no mojibake anywhere.
- A plan with a 600-character summary and a 400-character step detail - the text
  wraps and scrolls, the footer count matches the real number of rows, and
  nothing is truncated to a single line.
- `--no-hints` on a 20-row terminal in plan mode - the status bar still says
  `PLAN` with no chip on screen.
- Dismiss a plan card with `Esc`, let the agent resubmit, then close the card and press `Esc` twice within 1.5 seconds:
  the run aborts and the session returns to an idle prompt. Do this one BY HAND
  as well as in a test - the point of the check is whether the exit is findable,
  which no assertion can tell you.

## License

MIT


### 输入光标与任务切换验收

输入获得应用内焦点时，光标每 500 ms 明暗切换；编辑、移动和恢复焦点后立即亮起。
`reducedMotion` 开启时保持常亮，弹层打开时暂停。fullscreen 和 inline 使用相同规则。
单色终端用等列宽的下划线标记，原文相同时改用 `^`，零宽附加码点保留以兼容 Ink。
标记不进入草稿、历史或提交文本；屏幕选择复制会包含当时可见的标记。
UTF-16 编辑和 ZWJ/组合字形仍有既有限制，本次修复保证视觉光标定位及相位布局稳定。

在 Windows Terminal/PowerShell 与 POSIX TTY 分别验证两种模式，窗口覆盖
120×30、100×20、80×24、60×16：观察空输入、英文、中文、emoji、多行和组合附加符至少三个周期。
检查流式输出不阻止闪烁；单 ESC 不停止任务，两击中断，卡住时第三击强停；菜单关闭不计入两击。
任务结束后保留最终计划，下一条普通消息启动时旧计划消失，新有效计划出现才恢复；显式续跑保留计划。
强停后立即提交，在等待中双 ESC 取消，旧引擎退出后不得自行执行已取消的消息。
