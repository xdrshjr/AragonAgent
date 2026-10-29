# @aragon-agent/desktop

The Electron desktop front end for the `aragon` engine. It is a **third front end on the same
engine**, not a new one: it reuses `@aragon-agent/core` (engine), `@aragon-agent/tui` (the pure view
model) and `@aragon-agent/cli` (controller, config, sessions), and shares `~/.aragon-agent` with the
terminal. Private: it ships as an installer, never to npm.

The design notes, review record and acceptance criteria of the original iteration are not part
of this repository; the packaging guide that does ship here is `docs/packaging-desktop.md`.

## What "shares the terminal's configuration" means

- A model, key, theme or profile you set in the terminal is there when the app opens (no onboarding).
- A change made in the app is written to the same `config.json` with a compare-and-swap, keeping every
  key it does not know (including terminal-only ones like `scrollMode`), so the terminal reads it on
  its next start or `/reload`.
- If a terminal changes `config.json` while the app is running, the app notices within about a second
  (a directory watcher, with a 5 s poll as backup) and applies it - **after the current run**, never
  in the middle of an answer.
- App-only preferences (language, window layout, `enterToSend`, live-session cap) live in
  `desktop-state.json` next to `config.json`. The terminal never reads that file.
- A session open in a terminal cannot be opened here for writing: branch it or leave it.

## Layout

```
src/main/      Electron main process (thin: windows, IPC, supervision, config watcher, packaging glue)
src/host/      One utilityProcess per session: the controller, the authoritative ViewState, approvals
src/preload/   The only bridge: window.aragon (bundled to one CommonJS file)
src/renderer/  React UI (sandboxed, no Node)
src/shared/    Types and pure functions used by all of the above
```

`npm run verify:layering` (repo root) enforces who may import whom: the main process never imports the
engine statically (it loads it through `main/engine-loader.ts`, because the installed app keeps the
engine outside `app.asar`), the renderer has an import whitelist, and the host facade
(`cli/src/host`) must stay free of Ink and React.

## Develop

```bash
npm install --include=dev          # NODE_ENV=production shells otherwise prune devDependencies
npm run dev:desktop                # builds main+preload, serves the renderer with Vite, starts Electron
npm run typecheck:desktop          # three tsconfigs: main/host/shared, renderer, tests
npm run test:desktop               # vitest (node + jsdom projects); E2E is separate, see Test
```

Two environment traps:

- **`ELECTRON_RUN_AS_NODE`** is exported by some terminals (VS Code, Claude Code). With it set, Electron
  behaves as plain Node and the app dies on `import 'electron'`. The dev script and the host launcher
  strip it; if you start Electron by hand, `env -u ELECTRON_RUN_AS_NODE`.
- The Electron binary is downloaded at install time. Behind a restricted network set
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`. CLI-only contributors can skip the
  download with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.

## Verify an engine boot (works in development and against an installed build)

```bash
npx electron . --smoke      # loads the engine through engine-loader, forks a real host, waits for ready
```

It prints one JSON line and exits 0 only if a session host reached `ready`.

## Test

```bash
npm run test:desktop        # unit + component tests (node + jsdom); never launches Electron
npm run test:e2e -w packages/desktop       # real Electron window + scripted local model, from source
ARAGON_E2E_APP=<AragonAgent.exe> npm run test:e2e -w packages/desktop   # same tests, packaged E2E build
npm run dist:e2e -w packages/desktop       # builds that E2E-flavor package into release-e2e/
npm run bench -w packages/desktop -- --suite=startup,stream,big,soak --soak-minutes=10
npm run bench:verdict -w packages/desktop -- bench-results/<report>.json [--strict]   # green / amber / red table
npm run test:e2e:repeat -w packages/desktop -- --runs=3   # the whole E2E suite N times; any case that is not green every time fails
```

The E2E tests start the actual app against `test/e2e/mock-llm`, an OpenAI-compatible endpoint driven by
a script (one scripted turn per model request; a script that is not fully consumed fails the test).
They live in a **separate vitest configuration** (`vitest.e2e.config.ts`), because `vitest run` runs every
project in a config: an `e2e` project in the default config would make `npm test` launch Electron.
`test/e2e-isolation.test.ts` pins that. Failures leave a screenshot, the renderer log, what the model was
sent and the main-process log tail in `test-results/<case>/`.

The launcher removes `ELECTRON_RUN_AS_NODE` (see "Two environment traps"), so the suite also runs from a
shell that exports it.

### Build flavors

| Flavor | What it is | Test switches (`--e2e`, `--e2e-fault`, `--e2e-feed`, `--e2e-restore-window`) |
|---|---|---|
| `dev` | running from source | read |
| `e2e` | a packaged build the harness may drive | read |
| `release` | what users install | **do not exist** (nothing parses them, no hook is installed) |

The flavor is baked into the **compiled** `dist/main/build-flavor.js` (never the source) by
`scripts/build.mjs`; unbaked, a packaged app is `release`. An E2E-flavor package and the release package
differ in exactly two things: the baked flavor and the `EnableNodeCliInspectArguments` fuse (Playwright
drives Electron over the inspector). The release package cannot be driven by Playwright; it is covered by
`verify-bundle` and `--smoke` instead. These are two different gates and are not interchangeable.

`--e2e` pins a 1280x800 window and neither reads nor writes saved window state, which is what almost every
scenario wants. The geometry scenarios (`test/e2e/lifecycle.e2e.ts`) add `--e2e-restore-window` to run the real
restore / persist path. After a **renderer crash** Playwright's `Page` object stays "crashed" even though
Electron has reloaded the window, so those scenarios read and drive the page through the main process
(`webContents.executeJavaScript` / `sendInputEvent`) instead.

## Package

```bash
npm run build:desktop       # tsc + esbuild preload + vite
npm run stage -w packages/desktop        # engine in its published shape -> build-staging/engine
npm run dist -w packages/desktop         # release flavor: build + stage + electron-builder (unsigned, never publishes)
node packages/desktop/scripts/verify-bundle.mjs --app packages/desktop/release/win-unpacked --flavor release
```

`stage` installs the three engine packages from the npm registry at the versions this `package.json`
declares, with `--omit=dev --omit=optional`:
the optional native `isolated-vm` must not be compiled into an Electron app (wrong ABI), and an
undeclared dependency should fail here rather than on a user's machine.

### One-click packaging (Windows)

From `packages/desktop`, run `pack-desktop.cmd` (double-click, or `pack-desktop.cmd -Dir`) or
`powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1`. With no arguments it builds the
release installer for the host platform, runs `verify-bundle`, prints the artifacts and opens the output
folder; it wraps the same `node scripts/dist.mjs` + `scripts/verify-bundle.mjs` pair as the commands above.
Switches: `-Dir` (fast, unpacked app only), `-Clean`, `-Doctor` (read-only environment check), `-Help`.
Logs go to `pack-logs\pack-<yyyyMMdd-HHmmss>.log`; the full guide is `docs/packaging-desktop.md`.
`npm run pack:win` (from `packages/desktop`) is the same run with no arguments.

### Hardening (Electron fuses)

`scripts/lib/fuses.mjs` is the single table of fuse values: `dist.mjs` hands it to electron-builder, and
`verify-bundle` compares it with the fuse wire **read from the finished executable** (so a configuration
that was silently ignored fails verification).

| Fuse | Release |
|---|---|
| `RunAsNode` | off |
| `EnableNodeOptionsEnvironmentVariable` | off |
| `EnableNodeCliInspectArguments` | off (on only in the E2E flavor) |
| `EnableCookieEncryption` | on |
| `OnlyLoadAppFromAsar` | **on** |
| `EnableEmbeddedAsarIntegrityValidation` | on (Windows and macOS only) |

`OnlyLoadAppFromAsar: true` was verified with `--smoke` and the packaged E2E suite: the engine, which sits
as plain files in `resources/engine` and is started by path, still loads. If a future Electron breaks that,
set it to `false` in `fuses.mjs`, **and remove the word "hardened" from this section**: with the fuse off a
`resources/app/` directory beats the asar and its integrity check. Asar integrity protects `app.asar` only,
not `resources/engine`.

### Signing and updates

Signing certificates are not part of this repository, so builds are unsigned (Windows SmartScreen and
macOS Gatekeeper will say so; that is expected).

Updating is a **notification**, not an installer (`main/update-service.ts`): it reads a small JSON manifest
and tells the user a newer version exists, with a button that opens the download page in the browser. It
never downloads or runs anything and never claims a checksum was verified (`sha256` in the manifest is
display-only). The feed and the hosts a URL may point at are fixed **when the app is built**
(`extraMetadata.updates` in `electron-builder.yml`: `feedUrl`, `allowedHosts`); neither the manifest nor
`desktop-state.json` can add to that list. **No feed is configured in this repository**: the product owner
has to supply the address (until then the Updates page says so, and no placeholder host is baked in).
Checking sends one HTTPS request to the feed host, with no identifiers; switching it off in Settings >
Updates means the app makes no update request at all. In-place installation (`electron-updater`) is
deliberately not implemented; `UpdateService.install()` is its extension point.

## Release runbook

1. **Version.** Bump `version` in `packages/desktop/package.json` (semver; a pre-release suffix sorts before the release).
2. **Build and verify.** `npm run dist -w packages/desktop`, then `node scripts/verify-bundle.mjs --app <win-unpacked> --flavor release
   --platform win32` (flavor baked as `release`, every fuse as expected) and `<AragonAgent.exe> --smoke` (an installed build loads the
   engine and starts a session host). `node scripts/ci-desktop.mjs e2e-win` runs all of that plus the E2E suite twice (source, packaged
   E2E flavor).
3. **Manifest.** `node scripts/make-update-manifest.mjs --version <v> --base-url https://<host>/<path>/ --artifacts release/
   [--notes-url ...] [--out latest.json]`. It hashes the installers, writes `latest.json` and reads it back through the app's own
   parser (needs a build first). The base URL is a parameter of that run and is stored nowhere in the repository.
4. **Where to upload.** _Undecided._ The update source (and the host list in `extraMetadata.updates`) is a product decision that has not
   been made; until it is, builds ship with no feed and the Updates page says so.
5. **Rollback.** Point the manifest back at the previous version's `latest.json`. The app only ever *notifies*: nothing is installed
   from the feed, so rolling back means pointing users at the older installer.

## Performance baseline

Budgets (spec AC-47..AC-50): window shown P95 <= 400 ms, first usable input P95 <= 1.5 s, frame time P95 <=
16.7 ms with no task over 100 ms while streaming 200 tokens/s, 5,000-entry transcript first paint < 1 s,
memory growth < 2 MB/min. They are judged **only on the registered benchmark machine**, at release review;
a shared CI runner is too noisy, so CI runs `bench` for the report and never fails on it.

| Machine | Electron | B-1 shown / input (P95) | B-2 frame P95 / longest task | B-3 first paint | B-4 slope (5 min, 100 turns) |
|---|---|---|---|---|---|
| Intel Core Ultra 5 125H, 18 cores, 32 GB, Windows 11 (10.0.26200), Node 22.18 - **provisional** | 45.1.0 | 1832 ms **red** / 1369 ms green | 6.2 ms green / 0 ms green | 909 ms green | 15.0 MB/min whole run, 20.6 MB/min second half - **red** |

This row is the machine that ran the v1.2 iteration, registered as **provisional**: it is not the product
owner's reference machine, and the budgets cannot be called met on it. Two figures are red and are recorded
as they are (budgets are not adjusted):

- **B-1 window shown (1832 ms vs 400 ms)** includes process spawn and the harness attaching, so it over-reads
  the in-app `ready-to-show` figure; the in-app figure is not measured separately yet. Treat it as "not
  demonstrated", not as "400 ms is missed".
- **B-4 memory (about 15-21 MB/min over 5 minutes, 584 -> 699 MB total working set)** is steady, not warm-up:
  the second half grows as fast as the whole run. It may be lazy garbage collection or a real retention in
  the renderer or the hosts; a 5-minute soak cannot tell which. Open item: run `--soak-minutes=30` and look
  at the per-process figures. (The first v1.2 run of this suite reported 1,538 MB/min because the mock answered
  instantly and "5 minutes" were really 25 seconds; the soak is now paced across the window.)

`npm run bench:verdict -w packages/desktop -- bench-results/<report>.json` prints this table from a report,
recomputing every verdict from the raw numbers.

**A reference machine still has to be registered by the product owner (and the two red figures resolved) before the budgets can be called met.**
`npm run bench` writes `bench-results/<time>-<platform>.json` with raw samples and a green/amber/red
verdict per figure (amber: up to 20% over; red: more). B-1's "window shown" includes process start and
the harness attaching, so it reads high against the in-app figure.

## Known limits

- No embedded terminal; API keys stay in `config.json` (the same trust as the terminal).
- The app cannot leave background services running after it quits: hosts are its children, so the quit
  dialog offers "stop and quit" or "cancel" and nothing else. This is a property of the process model,
  not a to-do.
- A crash restores the last **checkpoint**, which is written a moment after a turn ends; a host that dies
  inside that moment loses that turn (the window re-attaches on its own once the host is back).
- macOS and Linux packages are built and smoke-tested in CI only (unsigned); there is no E2E on Linux.
- Syntax highlighting in code blocks is a small built-in tokenizer, not Shiki.
- Unsent drafts survive a reload or a renderer crash but **not** quitting the app: they are kept in `sessionStorage` on purpose (a draft
  may hold a pasted secret, and nothing the user has not chosen to send is written to disk).
- Find in conversation searches the entries the view holds. The view keeps the newest 1,000 entries of a long session (older ones are
  trimmed and announced), so a phrase further back is not found; the find bar says how many earlier entries are not loaded.
- Export removes the API keys that are configured and the common key shapes; that is best effort. Review the file before sharing it.
- Sleeping and waking is handled (idle sessions are not all parked at once; a dead host is still reported), and the taskbar progress /
  attention flash are unit-tested against a fake window, but their appearance in the OS is not automated: see "Manual checks".
- **Not run on CI:** the workflow (`.github/workflows/aragon-agent-desktop.yml`, in the repository root above this package) has never been
  executed, and macOS / Linux packages have never been built. Nothing in this repository can prove either until it is pushed.
- Pixel-baseline visual tests are not implemented yet (see the spec's ledger); accessibility is covered by the axe scans in
  `test/e2e/quality.e2e.ts` for the states listed there.

## Manual checks

Things a script cannot observe; do them on each release candidate, on each OS you ship:

- Windows: put the app in the background while a long run is in progress - the taskbar button shows indeterminate progress; make a
  session wait for an approval - the button flashes until you focus the window.
- macOS: a session waiting for approval puts a number on the dock icon and the dock bounces once when it first appears in the background.
- Close the lid (sleep) for longer than the "park idle sessions" setting, wake the machine: sessions are not all parked at once and
  the session list is current.
- Drag a file from the file manager onto the composer: the path is inserted (Playwright cannot synthesize a native drag with a path).
- With the zoom at 125% and 150% (View menu), the window-control buttons and the page header are the same height and nothing overlaps.

## Building from source

This package is `packages/desktop` in the AragonAgent repository and is built from the repository
root (npm workspaces). The engine is **not** part of that repository: `@aragon-agent/core`,
`@aragon-agent/tui` and `@aragon-agent/cli` are published npm dependencies, taken at the ranges this
`package.json` declares.

```bash
npm install --include=dev                 # repository root; NODE_ENV=production would prune devDependencies
npm run build -w packages/desktop         # tsc (main/host/shared) + esbuild preload + vite renderer
npm run typecheck -w packages/desktop     # the three tsconfigs: main/host/shared, renderer, tests
npm test -w packages/desktop              # vitest, node + jsdom projects; E2E is separate (npm run test:e2e -w packages/desktop)
npm run start -w packages/desktop         # electron . against the built tree (alternatively npm run dev -w packages/desktop)
```

`-w packages/desktop` works on any npm 7+ checkout; the repository-root scripts
`build:desktop`, `typecheck:desktop`, `test:desktop` and `pack:desktop` are thin wrappers around
the same commands. Two names used further up this file have no root wrapper here: `dev:desktop`
(use `npm run dev -w packages/desktop`) and `verify:layering` (it checked a layering rule of the
closed engine packages and is not part of this repository).

What the first build costs, and what it does not do:

- **The terminal UI is compiled first.** The desktop's TypeScript imports `@aragon-agent/tui/model/*`,
  which resolves through the TUI's export map to its compiled `dist` (`*.d.ts`), not to its sources.
  A fresh clone has no `packages/tui/dist`, so `prebuild` / `pretypecheck` / `pretest` run
  `scripts/ensure-tui-dist.mjs`, which builds that sibling once. It is a no-op on later runs, and a
  no-op when `@aragon-agent/tui` comes from the npm registry instead of a workspace.
- **The first install downloads the Electron binary (~100 MB)** and the first `dist` downloads
  electron-builder's NSIS toolchain, both into caches outside the repository. Expect a few minutes on
  a cold cache; nothing is downloaded when the app runs.
- **Packaging is Windows-only today.** `scripts/ci-desktop.mjs package` refuses to cross-build
  (`cannot build win on linux`), the one-click entry points are `.cmd`/`.ps1`, and the installer is
  NSIS. A full packaged run (`build` + `stage` + NSIS) takes minutes rather than seconds.
- **Nothing is signed and nothing updates itself.** The installer is unsigned, so Windows SmartScreen
  shows "Windows protected your PC" on first run (More info -> Run anyway), and no update feed is
  configured in this repository (`--publish never`), so a build you make yourself never self-updates.

## Packaging

`npm run dist -w packages/desktop` builds the unsigned release flavor end to end: `build`, then
`stage` (installs `@aragon-agent/{core,tui,cli}` from the npm registry at the declared versions with
`--omit=dev --omit=optional` into `build-staging/engine`), then electron-builder (an NSIS installer
on Windows; `dist:e2e` builds the inspector-enabled E2E flavor instead). Nothing is signed and
nothing is published. On Windows the one-click entry points are `pack-desktop.cmd` /
`pack-desktop.ps1` (or `npm run pack:win` from this directory); the full guide, including the
failure catalogue and the `-Doctor` report, is [`docs/packaging-desktop.md`](docs/packaging-desktop.md).
