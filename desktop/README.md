# AragonAgent Desktop

An Electron + Next.js desktop host for the AragonAgent engine - multi-session
chat, model profiles (Anthropic / OpenAI / any OpenAI-compatible endpoint), and
a packaged installer that works without a system Node install.

```
desktop/
  electron/    main process (window, app:// protocol, IPC, agent bridge)
  shared/      the exec event contract, IPC protocol, and the pure fold reducer
  app/         Next.js app router (static export)
  components/  renderer UI
  lib/         renderer store + typed bridge client
  scripts/     dev / runtime staging / packaging pipelines
  tests/       unit tests for the pure logic
```

## Architecture in one paragraph

Each conversation session owns one long-lived `aragon exec` child process,
spawned with `ELECTRON_RUN_AS_NODE=1` from Electron's own binary and driven
over the CLI's stable stream-json contract: user/interrupt/end frames in on
stdin, a typed event stream out on stdout (`system/init`, `text_delta`,
`tool_call`, `result`, ...). The main process journals every event to
`sessions/<id>/events.jsonl`, forwards events to the renderer over IPC, and the
renderer folds them into transcript entries with the same pure reducer it uses
to replay journals after a restart. Model configuration never touches the CLI's
own config: profiles inject `ARAGON_PROVIDER / ARAGON_MODEL / ARAGON_BASE_URL /
ARAGON_THINKING` plus the matching `*_API_KEY` into the child environment, and
API keys are stored encrypted (Electron safeStorage). Changing a session's
model or working directory respawns the child (`--resume`) on the next message.

## Prerequisites

- Node >= 18 (built and tested on 20.10), npm workspaces enabled by the root install
- The root workspace installed: `npm install` at the repository root
  (on machines without Visual Studio C++ Build Tools, use
  `npm install --ignore-scripts` then `node node_modules/electron/install.js`)

## Development

```bash
npm run dev          # from desktop/ - builds core+cli if needed, then next dev + tsc watch + electron
```

The dev shell loads http://localhost:3000 and the agent runtime resolves to the
monorepo's `packages/cli/dist/launcher.js` (built automatically on first run).

## Tests

```bash
node node_modules/vitest/vitest.mjs run   # from desktop/
```

Covers profile validation, environment injection, the event fold reducer, and
helper formatting.

## Building the installer

```bash
npm run package      # from desktop/
```

Pipeline: `next build` (static export to `out/`) -> `tsc` (main process to
`dist-electron/`) -> `scripts/stage-agent-runtime.mjs` (npm-packs core + cli
and installs a production-only runtime into `agent-runtime/`) ->
`electron-builder` producing:

- `release/AragonAgent-Setup-<version>.exe` - NSIS one-click installer (win x64)
- `release/AragonAgent-Portable-<version>.exe` - single-file portable build

macOS (dmg) and Linux (AppImage) targets are configured in
`electron-builder.yml` but not built on Windows; run
`npx electron-builder --mac` / `--linux` on the respective platform.

## Notes and honest limits

- **Unsigned binaries.** Windows SmartScreen will warn on first launch
  ("More info" -> "Run anyway"); code signing requires a certificate.
- **First-run keys.** The app boots with one Anthropic profile and no key; the
  header shows a setup banner until a key is stored or exported in the env.
- **Queueing.** Enter while a turn runs queues a follow-up (the exec child
  buffers turns); Stop sends an interrupt frame, which settles and persists the
  session on every platform.
- The desktop keeps its own transcript journals under the OS userData dir; the
  CLI-side session files (`~/.aragon-agent/sessions`, shared with the `aragon`
  CLI) hold the model-facing history and are resumed with `--resume`.
