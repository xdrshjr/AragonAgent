# Contributing to AragonAgent

This repository is the **UI layer** of AragonAgent: `packages/tui` (the terminal runtime) and
`packages/desktop` (the Electron app), plus the `docs/` site. Thanks for taking the time to read this
before opening a pull request.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **Node ≥ 20** | Both workspaces declare `engines.node >= 20`; npm 10.x is what the project is tested with. |
| **Windows 10/11 + Windows PowerShell 5.1+** | Required *only* for desktop packaging (the one-click script and NSIS installer). The TUI and the desktop source build fine on any platform Node runs on. |
| **A model API key** (Anthropic, OpenAI or Google) | The UI cannot do anything observable without a provider. Unit tests and component tests do not need one — they never call a real model. |
| **~8 GB free disk** | Desktop packaging keeps `dist/`, `build-staging/` and `release/` on disk at the same time. The first build also downloads Electron (~100 MB). |

## The one rule that matters: the closed-package boundary

The agent engine (`@aragon-agent/core`) and the CLI host (`@aragon-agent/cli`, the `aragon` command) are
**closed source** and consumed here as published npm packages. Therefore:

- **Do not vendor, copy or reconstruct source from the closed packages.** No pasted files, no
  re-implementations of engine internals, no reading a minified/`dist/` file and translating it back.
- **Talk to them only through their published surface** — the declared exports, the `@aragon-agent/cli`
  `host/` facade, and the types those packages ship. If a change needs a new capability from the engine,
  open an issue describing the capability; it cannot be added from this repository.
- **Do not add imports that cross the boundary illegally.** The desktop main process must not import the
  engine statically (it loads it through its engine loader, because an installed build keeps the engine
  outside `app.asar`), and the renderer has a strict import whitelist. `packages/desktop/README.md`
  documents the layering; keep it that way.

## Workspace commands

Run everything from the repository root unless noted.

```bash
npm install                 # once, at the root — links both workspaces

npm run build               # build:tui, then build:desktop
npm run build:tui           # tsc -p packages/tui
npm run build:desktop       # tsc + esbuild preload + vite renderer

npm run typecheck:tui
npm run typecheck:desktop
npm test -w packages/tui    # or: npm run test:tui
npm test -w packages/desktop    # or: npm run test:desktop
```

`npm install` resolves from the committed `package-lock.json` and needs **Node ≥ 20**. On npm 10 a plain install can abort
with `Cannot read properties of null (reading 'edgesOut')` while resolving `vitest`'s peers — rerun it as
`npm install --legacy-peer-deps`, or use npm ≥ 11. Do not delete the lockfile to work around it.

Desktop development and packaging (from `packages/desktop`):

```bash
npm run dev -w packages/desktop     # main+preload build, Vite dev server, Electron
npx electron . --smoke             # boots the engine through the loader, prints one JSON line
npm run pack:win                   # one-click release build, no arguments
```

`pack-desktop.cmd` / `pack-desktop.ps1` accept `-Dir`, `-Clean`, `-Doctor`, `-NoPause`, `-Flavor` and
`-Platform`; see [`packages/desktop/docs/packaging-desktop.md`](./packages/desktop/docs/packaging-desktop.md)
for the full parameter table and exit codes.

## Tests

- **TUI:** `npm test -w packages/tui`. Tests use the virtual-terminal helpers in `packages/tui/testing/`;
  they render to a fake terminal and never open a real one. That helper directory carries **no stability
  promise** — it is test support, not a public API.
- **Desktop:** `npm test -w packages/desktop` runs the unit and component suites (node + jsdom) and never
  launches Electron. The end-to-end suite is separate on purpose (`vitest.e2e.config.ts`, because `vitest
  run` would otherwise execute every project in a config and make `npm test` start Electron):
  `npm run test:e2e -w packages/desktop`. It drives the real app against a scripted local model; a script
  that is not fully consumed fails the test. Failures leave a screenshot and logs in `test-results/<case>/`.
- **Docs:** the site has its own gate and tests; see [`docs/guide-doc/README.md`](./docs/guide-doc/README.md)
  (`build.mjs`, `check.mjs`, `node --test docs/guide-doc/tests/*.test.mjs`).

Add a test with the fix, not after it. A change that alters rendering, input handling or the host contract
without a test that fails before it and passes after it will be asked to add one.

## Pull request expectations

- **Small and scoped.** One concern per PR. Refactors that move files around are separate from behaviour
  changes, because review cannot separate them afterwards.
- **Reproduce first.** For a bug, say in the PR (or the linked issue) how the wrong behaviour shows up on
  the current `main`, and what you changed.
- **Green before review:** `npm run build`, `npm run typecheck:tui`, `npm run typecheck:desktop` and the
  affected test suites. If you touched the desktop shell, say whether you ran `pack-desktop.cmd -Dir` and
  `npx electron . --smoke`.
- **TypeScript style used here:** `interface` over `type` for public shapes, one file one responsibility,
  explicit error propagation (no swallowed exceptions or `null`-as-success), and comments that explain
  *why*, not *what*.
- **No new dependency without a reason.** State what it does, why the existing dependencies cannot, and
  its license. The TUI in particular keeps `react` and `ink` as peers to avoid two copies of either in one
  process — do not change that casually.
- **No secrets, no personal data, no private URLs** in code, tests, fixtures, logs or screenshots. The
  desktop app stores API keys in `config.json` on purpose; tests must never assert against a real key.
- **Never commit build output.** `dist/`, `build-staging/`, `release/`, `pack-logs/`, `test-results/` and
  `bench-results/` stay local.
- **Unsigned builds are expected.** Signing certificates are not part of this repository; do not add them.

By contributing you agree that your contribution is licensed under the MIT license of this repository
(see [LICENSE](./LICENSE)).
