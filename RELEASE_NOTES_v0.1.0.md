# AragonAgent Desktop v0.1.0

The second public desktop build of AragonAgent: an open-source terminal coding agent UI (Ink/React TUI) and an Electron desktop app that run on the same agent engine. This release ships one Windows installer that contains the desktop front end plus the published engine, so the app runs from a normal install with no separate npm setup. The repository you are reading holds the UI layer — the terminal runtime, the desktop shell and the documentation site — and the engine it drives is consumed from npm.

Everything in v0.0.1 still works; the additions are attachments and the way tool calls read.

## Install

Download the single release asset:

| Asset | Size | Platform |
| --- | --- | --- |
| `AragonAgent.Setup.0.1.0.exe` | ~122.7 MB | Windows x64 (NSIS installer) |

1. Download the installer from the release page: https://github.com/xdrshjr/AragonAgent/releases
2. Run `AragonAgent.Setup.0.1.0.exe`.
3. The build is **not code-signed**, so Windows SmartScreen shows **"Windows protected your PC"** on first launch. Click **More info**, then **Run anyway**. This prompt is expected for an unsigned build and is not a sign that the download is broken.
4. The installer is per-user: it does **not** ask for administrator rights, and you can choose the install directory.
5. The engine is bundled inside the app (under `resources/engine`, installed with production-only dependencies), so you do **not** need Node.js, npm, or a global `aragon` install. Installing the app is the whole setup.

Upgrading from v0.0.1 does not need an uninstall: run the new installer over the old one and your `~/.aragon-agent` settings and sessions are kept. Close the app first — Windows refuses to replace a running executable.

The SHA-256 checksum of the asset is listed on the release page: https://github.com/xdrshjr/AragonAgent/releases. This file does not embed a hash, because the artifact is built and published separately from the notes. Command to check your copy is in [Verify the download](#verify-the-download).

## What is in this build

| Component | Version / value |
| --- | --- |
| AragonAgent Desktop | 0.1.0 |
| Electron shell | 45.1.0 |
| React renderer | 18.3.1 |
| Engine — `@aragon-agent/core` | 0.2.63 |
| CLI host — `@aragon-agent/cli` | 0.6.51 |
| Terminal UI — `@aragon-agent/tui` | 0.0.4 |
| Platform | Windows x64 |
| Installer | NSIS, per-user, unsigned |
| appId / productName | `com.aragonagent.desktop` / AragonAgent |

## New in 0.1.0

- **Pictures and files in the box.** Paste (`Ctrl/Cmd+V`), drop, the `+` menu, or `Ctrl/Cmd+U`. Images are shrunk to what the model accepts and shown as thumbnails; `@image1` in the text refers to one. A removed attachment can be undone for eight seconds, and a chip previews the picture exactly as it will be sent.
- **Formats.** PNG, JPEG, GIF and WebP go as they are. BMP, AVIF, ICO and SVG are converted to PNG in the window first (a converted SVG never runs its scripts or loads anything it references). HEIC and TIFF cannot be decoded, so they are sent as file paths and the chip says so.
- **Clipboard fallback.** Some screenshot tools put only a bare bitmap on the clipboard, which the page's own paste event cannot see. The main process reads it with Electron's clipboard module — image only, on demand, never polled — and the `+` menu can do the same by hand.
- **Models that cannot see images.** The banner above the composer says so before you send. If a provider refuses a picture anyway, the error offers "This model cannot see images — resend as file paths": it records the decision, waits for the host to confirm, then resends. Decisions are listed, and can be taken back, in **Settings > General > Image input**.
- **Tool calls in plain language.** A call reads "Hunting for the retry policy" instead of `grep retry …`. Runs of three or more finished reads, searches or folder listings fold into one line that opens in place; edits, commands and failures are never folded, and an MCP tool shows which server it came from. Everything can be switched back to raw cards with Developer mode (Settings > General, or the hidden `Ctrl/Cmd+Shift+D`), and folding has its own switch.
- **Queued and retried messages keep their attachments**, including after a reload of the window.
- **A packaged app that starts.** The main process resolves attachment ids through the module the session host also uses; that module is now part of the installer, and `verify-bundle` fails the build if the packaged main imports anything the archive does not carry — the check that would have caught it before this release existed.

## What is open source, and what is not

The MIT license in this repository covers the UI layer: `packages/tui` (the terminal runtime, published to npm as `@aragon-agent/tui`), `packages/desktop` (the Electron app and its packaging scripts) and `docs/guide-doc` (the documentation site). The agent engine `@aragon-agent/core` and the CLI host `@aragon-agent/cli` (which provides the `aragon` command) are **closed source** and are consumed here as published npm packages — their source is not in this repository. This installer ships that engine and CLI, so the binary contains closed-source code even though the app around it is open source.

## Known limitations

- **The installer is unsigned.** There is no code-signing certificate, so Windows SmartScreen warns on first launch and you must choose **More info → Run anyway**.
- **Windows x64 only.** No macOS or Linux build was produced for this release. The packaging script refuses to cross-build, and while mac/linux targets exist in the electron-builder configuration, they are neither exercised nor signed — treat them as unsupported.
- **No auto-update.** There is no update feed, so a new version means downloading the installer again and installing it over the current one.
- **The Updates page is empty by design.** An update feed URL is deliberately not baked into the build, so the Updates page in settings reports that no feed is configured.
- **Pictures live inside the session file.** A long screenshot-heavy conversation grows by the size of its pictures; that is measured by a benchmark and is the documented trade-off, not an accident.
- **A refused picture leaves the failed turn in place.** The recovery adds a new message after it; there is no command that replaces a failed turn, and the notice says so.

## Requirements

- Windows 10 or Windows 11, x64.
- An API key for a model provider of your own: Anthropic, OpenAI, Google, or any OpenAI-compatible endpoint with a custom `baseUrl`. The app is a client — it does not include credits, a subscription, or a hosted proxy.

## Verify the download

```powershell
Get-FileHash "AragonAgent.Setup.0.1.0.exe" -Algorithm SHA256
```

Compare the result with the checksum in the release body. A mismatch means the download was altered or truncated; download it again.
