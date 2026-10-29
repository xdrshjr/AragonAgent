# AragonAgent Desktop v0.0.1

The first public desktop build of AragonAgent: an open-source terminal coding agent UI (Ink/React TUI) and an Electron desktop app that run on the same agent engine. This release ships one Windows installer that contains the desktop front end plus the published engine, so the app runs from a normal install with no separate npm setup. The repository you are reading holds the UI layer — the terminal runtime, the desktop shell and the documentation site — and the engine it drives is consumed from npm.

## Install

Download the single release asset:

| Asset | Size | Platform |
| --- | --- | --- |
| `AragonAgent.Setup.0.0.1.exe` | ~122.7 MB | Windows x64 (NSIS installer) |

1. Download the installer from the release page: https://github.com/xdrshjr/AragonAgent/releases
2. Run `AragonAgent.Setup.0.0.1.exe`.
3. The build is **not code-signed**, so Windows SmartScreen shows **"Windows protected your PC"** on first launch. Click **More info**, then **Run anyway**. This prompt is expected for an unsigned build and is not a sign that the download is broken.
4. The installer is per-user: it does **not** ask for administrator rights, and you can choose the install directory.
5. The engine is bundled inside the app (under `resources/engine`, installed with production-only dependencies), so you do **not** need Node.js, npm, or a global `aragon` install. Installing the app is the whole setup.

The SHA-256 checksum of the asset is listed on the release page: https://github.com/xdrshjr/AragonAgent/releases. This file does not embed a hash, because the artifact is built and published separately from the notes. Command to check your copy is in [Verify the download](#verify-the-download).

## What is in this build

| Component | Version / value |
| --- | --- |
| AragonAgent Desktop | 0.0.1 |
| Electron shell | 45.1.0 |
| React renderer | 18.3.1 |
| Engine — `@aragon-agent/core` | 0.2.63 |
| CLI host — `@aragon-agent/cli` | 0.6.51 |
| Terminal UI — `@aragon-agent/tui` | 0.0.4 |
| Platform | Windows x64 |
| Installer | NSIS, per-user, unsigned |
| appId / productName | `com.aragonagent.desktop` / AragonAgent |

## Highlights

- **One session, two front ends.** The desktop app and the terminal share `~/.aragon-agent` (`config.json` and `desktop-state.json`), so sessions, model choice, API keys and theme are the same in both. A change made in one front end is applied by the other after the current run finishes.
- **Live tool calls.** Chat shows each tool call as a card while the agent works, instead of a wall of text.
- **Approval prompts.** The agent asks before it runs an action that needs your consent, and you approve or deny it in the app.
- **Plan mode.** A read-only mode where the agent investigates and proposes a plan before changing anything.
- **TODO list with acceptance criteria.** Work items are kept in a live list, each with its own acceptance criteria and a verify step.
- **Parallel subagent teams.** The agent can split a job across short-lived subagents that run in parallel and report back as one result.
- **Background job supervision.** Long commands and dev servers run as supervised jobs you can inspect and stop; they are cleaned up when the app exits.
- **Sessions, prompts, settings.** A session list with resume, a reusable prompt library, settings pages for models, providers and keys, find-in-conversation, and light/dark themes.

## What is open source, and what is not

The MIT license in this repository covers the UI layer: `packages/tui` (the terminal runtime, published to npm as `@aragon-agent/tui`), `packages/desktop` (the Electron app and its packaging scripts) and `docs/guide-doc` (the documentation site). The agent engine `@aragon-agent/core` and the CLI host `@aragon-agent/cli` (which provides the `aragon` command) are **closed source** and are consumed here as published npm packages — their source is not in this repository. This installer ships that engine and CLI, so the binary contains closed-source code even though the app around it is open source.

## Known limitations

- **The installer is unsigned.** There is no code-signing certificate, so Windows SmartScreen warns on first launch and you must choose **More info → Run anyway**.
- **Windows x64 only.** No macOS or Linux build was produced for this release. The packaging script refuses to cross-build, and while mac/linux targets exist in the electron-builder configuration, they are neither exercised nor signed — treat them as unsupported.
- **No auto-update.** There is no update feed, so a new version means downloading the installer again and installing it over the current one.
- **The Updates page is empty by design.** An update feed URL is deliberately not baked into the build, so the Updates page in settings reports that no feed is configured.

## Requirements

- Windows 10 or Windows 11, x64.
- An API key for a model provider of your own: Anthropic, OpenAI, Google, or any OpenAI-compatible endpoint with a custom `baseUrl`. The app is a client — it does not include credits, a subscription, or a hosted proxy.
- No administrator rights are needed for the per-user install.
- The agent needs network access: every answer is a request to your configured provider.

## Verify the download

Compare the checksum of the file you downloaded with the value listed on the release page. In `cmd.exe`:

```bat
certutil -hashfile "AragonAgent.Setup.0.0.1.exe" SHA256
```

In PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 "AragonAgent.Setup.0.0.1.exe"
```

Both print a 64-character hex digest. It must match the SHA-256 shown in the release notes on the release page. If it does not match, delete the file and download it again from https://github.com/xdrshjr/AragonAgent/releases.

Developers can skip the installer and build from source instead: `npm install`, then `npm run build -w packages/desktop`, then `pack-desktop.cmd` inside `packages/desktop`. The steps, switches and troubleshooting are in the packaging guide linked below.

## Links

- Repository: https://github.com/xdrshjr/AragonAgent
- Release page (asset + checksum): https://github.com/xdrshjr/AragonAgent/releases
- Documentation site entry: https://github.com/xdrshjr/AragonAgent/blob/main/docs/guide-doc/README.md
- Packaging guide (build from source): https://github.com/xdrshjr/AragonAgent/blob/main/packages/desktop/docs/packaging-desktop.md
- npm — CLI host: https://www.npmjs.com/package/@aragon-agent/cli
- npm — engine: https://www.npmjs.com/package/@aragon-agent/core
- License (MIT, UI layer): https://github.com/xdrshjr/AragonAgent/blob/main/LICENSE
