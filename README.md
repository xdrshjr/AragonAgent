<p align="center">
  <img src="./logo/logo-circle.png" alt="AragonAgent logo" width="140" />
</p>

<h1 align="center">AragonAgent</h1>

<p align="center">
  <strong>Open-source terminal coding agent UI and Electron desktop app for the AragonAgent engine.</strong>
</p>

<p align="center">
  A Codex-style TUI in Ink/React, a Claude Code alternative you can package as a Windows desktop app,
  and the TypeScript front-end layer of a coding agent whose engine ships as a published npm package.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@aragon-agent/tui"><img src="https://img.shields.io/npm/v/@aragon-agent/tui?label=%40aragon-agent%2Ftui&logo=npm" alt="npm version of @aragon-agent/tui"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./llms.txt">llms.txt</a>
</p>

---

## What this is

This repository is the **open-source UI layer of AragonAgent**: an interactive terminal coding agent
(TUI) and an Electron desktop agent, both driving the same agent engine. If you are searching for an
open source coding agent, a terminal AI agent, a Codex-style TUI, or a Claude Code alternative that is
not locked to one vendor's terminal, this is the front-end half — MIT licensed, fully readable, and
buildable from source.

Two packages and one docs site:

| Path | What it is |
| --- | --- |
| [`packages/tui`](./packages/tui) | The terminal runtime: Ink/React components, terminal input protocols, the scrollback renderer and the view model they draw from. Published as `@aragon-agent/tui`. |
| [`packages/desktop`](./packages/desktop) | The Electron desktop app: main/host/preload/renderer processes, an NSIS installer, and a one-click PowerShell packaging script for Windows. Private, never published to npm. |
| [`docs`](./docs) | The developer documentation site (a zero-dependency static generator) covering the TUI, the CLI contract and the engine API. |

## What this is not

**This repository is not the whole agent.** The agent engine (`@aragon-agent/core`) and the CLI host
that owns the agent loop, tools, sessions and configuration (`@aragon-agent/cli`, which provides the
`aragon` command) are **closed source**. They are consumed here as published npm packages — the current
ones are `@aragon-agent/core@0.2.63` and `@aragon-agent/cli@0.6.51` — and their source is not in this
tree. What is open source is everything you look at and type into: the terminal UI, the desktop shell,
and the docs site. Nothing in this repository claims to reimplement the engine, and no attempt is made
to reverse it: the UI talks to the engine through the CLI's `host/` facade, which is a documented,
type-checked boundary.

So: **open-source UI, closed-source engine, one MIT-licensed front-end layer you can read, fork, build
and package.**

<p align="center">
  <img src="./logo/screenshot.png" width="880"
       alt="The AragonAgent terminal UI: the ARAGON banner over a full-screen Ink interface with the active model and working directory in the header, a message composer at the bottom, and a status bar showing idle state, thinking level, context usage, token counts and session cost." />
</p>

## Why AragonAgent

- **Two front ends, one session.** The TUI and the desktop app share `~/.aragon-agent` — the same model,
  key, theme and profile are there when either one starts, and a change made in one is picked up by the
  other (compare-and-swap on `config.json`, applied after the current run, never mid-answer).
- **Team subagents.** The agent can hand parts of a job to short-lived subagents that run in parallel and
  return one combined report. Depth-capped by construction, so fan-out cannot recurse without a bound.
- **Plan mode and TODO acceptance criteria.** A read-only planning mode where the agent investigates and
  asks before it touches anything, plus a live TODO list with per-item acceptance criteria and a verify
  phase that keeps the agent honest as it works.
- **Real terminal ergonomics.** Full-screen streaming chat, live tool-call cards, native scrollback with
  themes, queued follow-ups while the agent runs, interrupt and input queueing, and a status bar that
  tracks context usage, tokens and session cost.
- **Background jobs and services.** The agent can start a dev server or a long command, poll it through
  the `job_list` / `job_wait` tools, read its output, and stop it; the desktop app supervises those
  children and reaps them on exit.
- **Context that survives.** A context gauge, automatic compaction with a restorable archive, and
  sessions that resume, branch and survive a process restart — in the terminal and in the app.
- **One-click Windows packaging.** From `packages/desktop`, double-click `pack-desktop.cmd` and you get a
  verified release build: esbuild + Vite build, engine staged from npm tarballs, NSIS installer built by
  electron-builder, Electron fuses applied and compared against the finished executable. Unsigned,
  never published, no feed configured.
- **Bring your own model.** The engine ships adapters for **Anthropic, OpenAI and Google**, plus a custom
  `baseUrl` for OpenAI-compatible gateways, and an optional cheaper "fast" model tier for reflection and
  review. Keys live in `config.json`, exactly as in the terminal.

## Quick start

### a) Desktop app (Windows, from source)

Requires Node ≥ 20 and Windows PowerShell 5.1+. Run `npm install` once at the repository root, then use
the one-click script inside `packages/desktop`:

```bat
git clone https://github.com/xdrshjr/AragonAgent.git
cd AragonAgent
npm install
npm run build -w packages/desktop

cd packages\desktop
pack-desktop.cmd
```

**Install note:** `npm install` installs from the committed `package-lock.json` and needs **Node ≥ 20**. If it aborts with
`Cannot read properties of null (reading 'edgesOut')` on npm 10, rerun it as `npm install --legacy-peer-deps`, or use npm ≥ 11.

`pack-desktop.cmd` (or `powershell -NoProfile -ExecutionPolicy Bypass -File .\pack-desktop.ps1`) builds
the release installer for the host platform, runs `verify-bundle`, prints the artifacts and opens the
output folder. Useful switches: `-Dir` (fast, unpacked app only), `-Clean`, `-Doctor` (read-only
environment check), `-NoPause` (CI). The first build downloads Electron (~100 MB) and the engine
dependencies. Full parameter table, exit codes, log locations and troubleshooting:
[`packages/desktop/docs/packaging-desktop.md`](./packages/desktop/docs/packaging-desktop.md).

For development instead of packaging:

```bat
npm install
npm run build -w packages/desktop
npx electron . --smoke
```

### b) TUI from source

```bash
git clone https://github.com/xdrshjr/AragonAgent.git
cd AragonAgent
npm install
npm run build -w packages/tui
npm test -w packages/tui
```

`@aragon-agent/tui` is a component library, not a binary: it renders into a host that supplies the
engine. Most people want the published CLI (next block) to actually chat with the agent; build this
package when you are changing the terminal UI itself or mounting it in your own front end.

### c) The published CLI (the shipped agent)

```bash
npm i -g @aragon-agent/cli
export ANTHROPIC_API_KEY=sk-ant-...   # or paste a key live in the TUI settings
aragon
```

This installs the closed-source CLI host plus the engine; the TUI you build in this repository is the
same terminal layer that ships inside it. See the npm page for
[`@aragon-agent/cli`](https://www.npmjs.com/package/@aragon-agent/cli) for keybindings, slash commands
and the headless `aragon exec` contract.

## Repository layout

| Path | Package | Contents |
| --- | --- | --- |
| `packages/tui` | `@aragon-agent/tui` (published) | `ui/` Ink components, layout, scrollback, selection, frame diffing, themes; `input/` keyboard, mouse and paste protocols; `model/` the view model and the pure helpers it needs; `testing/` a terminal test harness. No barrel entry — subpath imports only. |
| `packages/desktop` | `@aragon-agent/desktop` (private) | `src/main` Electron main process, `src/host` one utility process per session, `src/preload` the only bridge, `src/renderer` the sandboxed React UI, `src/shared` types; plus `scripts/` build, stage, dist, verify-bundle and the `pack-desktop.ps1` one-click wrapper. |
| `docs` | — (not a workspace package) | The documentation site generator and its content: nine sections, zero dependencies, zero network at runtime. |
| `logo` | — | Brand assets used by this README. |
| `tsconfig.base.json` | — | The shared TypeScript compiler options both packages extend. |

The TUI and the app are the only workspaces. `npm install` at the root wires them together; there is no
build step that touches the network beyond the usual npm install and Electron's binary download.

## Documentation

The docs site is prebuilt and static — you can read it without a server or a network connection:

- **[Documentation site entry point](./docs/guide-doc/dist/index.html)** — open this file in a browser.
- [How the site is built, checked and deployed](./docs/guide-doc/README.md) — one command produces
  `dist/`, and a `check.mjs` gate reconciles the pages against the source.

Sections of the site:

| Section | Start here |
| --- | --- |
| Start — install, first run, five-minute tour, core concepts | [`dist/start/install/index.html`](./docs/guide-doc/dist/start/install/index.html) |
| Daily use — interface tour, keybindings, plan mode, TODO, team, skills | [`dist/guide/tui/index.html`](./docs/guide-doc/dist/guide/tui/index.html) |
| Team subagents | [`dist/guide/team/index.html`](./docs/guide-doc/dist/guide/team/index.html) |
| TODO and acceptance criteria | [`dist/guide/todo/index.html`](./docs/guide-doc/dist/guide/todo/index.html) |
| Configuration — files, precedence, every key | [`dist/config/reference/index.html`](./docs/guide-doc/dist/config/reference/index.html) |
| Machine contract (`aragon exec`) | [`dist/exec/overview/index.html`](./docs/guide-doc/dist/exec/overview/index.html) |
| Engine API | [`dist/api/install/index.html`](./docs/guide-doc/dist/api/install/index.html) |
| Built-in tools | [`dist/tools/index.html`](./docs/guide-doc/dist/tools/index.html) |
| Troubleshooting and FAQ | [`dist/troubleshoot/faq/index.html`](./docs/guide-doc/dist/troubleshoot/faq/index.html) |

Package-level documentation lives next to the code:
[`packages/tui/README.md`](./packages/tui/README.md),
[`packages/desktop/README.md`](./packages/desktop/README.md),
[`packages/desktop/docs/packaging-desktop.md`](./packages/desktop/docs/packaging-desktop.md).

## FAQ

**Is AragonAgent free?**
The code in this repository is MIT licensed and free to use, modify and redistribute. The engine and CLI
it runs on are also free to install from npm, but they are distributed as closed-source packages. You
still pay whatever your model provider charges for API usage; AragonAgent itself does not bill you.

**Does it work offline?**
No, not the agent. Every answer requires an HTTPS call to the model provider you configured, so the TUI
and the desktop app are useless without network access to that provider. What does work offline is the
documentation site in [`docs`](./docs) — it is static files with no fonts, CDN or analytics scripts.

**Which model providers are supported?**
Anthropic, OpenAI and Google, and any OpenAI-compatible endpoint through a custom `baseUrl` and model id.
Provider, model, key and base URL are per-profile settings, so you can keep several and switch between
them; an optional "fast" tier can point at a cheaper model for reflection and review.

**Is there a VS Code extension?**
Not supported yet. There is no extension, no IDE plugin and no editor integration in this repository.
The terminal UI does work inside the VS Code integrated terminal, and the desktop app is a standalone
window; that is the extent of it today.

**Can I run the desktop app on macOS or Linux?**
Windows is the supported packaging path: the one-click script produces an NSIS installer and refuses to
cross-build (`-Platform mac` / `-Platform linux` exit with code 2). macOS and Linux bundles can be built
by electron-builder from the same configuration, but they are unsigned and not exercised here — treat
them as unsupported yet. The TUI itself is plain Node ≥ 20 and is not tied to Windows.

**How is it different from Claude Code or Codex CLI?**
Both of those are terminal clients. AragonAgent is a terminal client *and* an Electron desktop app on the
same session store, sharing `~/.aragon-agent` with the terminal, with team subagent fan-out, a read-only
plan mode, a TODO list with acceptance criteria, and Windows packaging you can run yourself. The
honest other half: their clients are distributed open, and here only the UI layer is — the engine and CLI
are closed.

**Where does my code and my conversation go?**
To the model provider you configured, and nowhere else by design: the desktop app's only other outbound
request is an update check against a feed baked in at build time, and this repository ships with **no
feed configured**, so a build from this tree makes no update request at all. API keys are stored in
`config.json` next to your other settings — the same trust model as the terminal, not an OS keychain.

## Contributing

Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for prerequisites, the
workspace commands, and the one rule that matters most: **a change here must not reach into the closed
packages' source**, it must go through their published surface.

## License

MIT — see [LICENSE](./LICENSE). The engine and CLI packages distributed through npm are a separate,
closed-source product; this license covers this repository only.

---

<sub>English · [简体中文](./README.zh-CN.md) · [llms.txt](./llms.txt)</sub>
