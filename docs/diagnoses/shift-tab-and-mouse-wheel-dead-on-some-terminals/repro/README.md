# Repro harness

Deterministic replacement for "press Shift+Tab and spin the wheel by hand". Nothing
here is part of the shipped CLI — it exists so the claim in `../analysis.md` §3.2 can
be re-run by anyone in about a minute.

All of it must run in a **real console window**. The probe needs `stdin.isTTY`, so
launching it from an agent shell (stdin redirected) measures nothing.

| File | What it does |
|---|---|
| `probe-stdin.mjs` | Puts stdin in raw mode the way Ink does, writes `\x1b[?1000h\x1b[?1006h` the way `ui/screen.ts` does, dumps every received chunk as hex to a `.jsonl` |
| `inject-console-input.ps1` | Starts the probe as a child sharing this console, then `WriteConsoleInput`s `a` / `Tab` / `Shift+Tab` / `↑` / `Shift+↑` / wheel. Samples `GetConsoleMode(stdin)` before, during raw mode, and after |
| `inject-wheel-only.ps1` | Wheel alone, with `ENABLE_MOUSE_INPUT` forced back on halfway through as a control |
| `post-wheel-message.ps1` | `PostMessage(WM_MOUSEWHEEL)` to `GetConsoleWindow()`. **Inconclusive under ConPTY** (the pseudo-console window is 0×0 and window messages are not its input path) — kept as a record of a path that was tried, see `../analysis.md` §7 |

## Run

```powershell
$dir = 'M:\takoAI\JRAgentMesh\aragon-agent-core\docs\diagnoses\shift-tab-and-mouse-wheel-dead-on-some-terminals\repro'

# current Node
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
  '-File',"$dir\inject-console-input.ps1",'-NodeExe','node','-Tag','node22' -Wait

# an older Node, e.g. from https://nodejs.org/dist/v20.19.0/node-v20.19.0-win-x64.zip
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
  '-File',"$dir\inject-console-input.ps1",'-NodeExe','<...>\node.exe','-Tag','node20' -Wait

Get-Content "$dir\probe-out-node22.jsonl"
Get-Content "$dir\probe-out-node20.jsonl"
```

## What to look for

`Shift+Tab` should come back as `1b5b5a` (`\x1b[Z`). If it comes back as `09` — the same
bytes as a plain `Tab` — this Node build is putting the console into `UV_TTY_MODE_RAW`
rather than `UV_TTY_MODE_RAW_VT`, and both the mode toggle and the mouse wheel are
unavailable no matter what the terminal emulator is. The `inject-log-*.txt` line
`ENABLE_VIRTUAL_TERMINAL_INPUT during raw mode:` says the same thing directly.

The checked-in `probe-out-node20.jsonl` / `probe-out-node22.jsonl` / `inject-log-*.txt` /
`wheel-log.txt` are the outputs from 2026-08-08 on Windows 11 26200, quoted in
`../analysis.md` appendix A.

The `node20/` runtime and the third-party sources (`libuv src/win/tty.c`,
`microsoft/terminal src/host/inputBuffer.cpp`, …) that were downloaded to check the
citations are deliberately **not** kept here; appendix B lists them with tags and line
numbers so they can be re-fetched.
