# Changelog

`@aragon-agent/desktop` is private and unversioned for release purposes; this file records what each
milestone of the desktop app contains.

## Unreleased
- **The packaged app starts again.** The main process resolves attachment ids through the ledger module that
  the session host also uses, and `electron-builder.yml` shipped `dist/main/**` and `dist/shared/**` only: in a packaged
  build the import died before the first window (a modal "Error" and no host, invisible in development). `dist/host/attachment-ledger.js`
  is now packaged, and `verify-bundle` check 8c fails the build when the main process imports anything the asar does not carry.

- **Attachments and tool calls, finished**:
  - The real-window E2E suite now runs on a machine that has another copy of the app open (Electron `userData` is isolated per run
    with `--e2e-user-data`, a test switch that does not exist in a release build); a launch that dies explains its likely cause.
    Running it for the first time found that the suite's own PNG fixture was corrupt.
  - Removing an attachment can be undone; a chip can be previewed; "Paste image from clipboard" and a clipboard fallback for pictures
    the page's paste event cannot see; BMP / AVIF / ICO / SVG are accepted (converted to PNG); HEIC / TIFF say they go by path only.
  - When a provider refuses a picture: one button that records "this model cannot see images", waits for the host, and resends as paths
    (a model the catalog says reads images only gets a one-off resend). Settings > General > Image input lists and restores these decisions.
  - Runs of three or more finished reads / searches / folder listings fold into one line; an MCP tool shows its server. Both off in
    Developer mode; folding has its own switch.
  - `ARAGON_DESKTOP_ATTACHMENTS=0` turns the attachment feature off for a window or a machine.
  - Core-adjacent: the name-based image-support guess is one exported table (`IMAGE_VENDOR_PRIORS`) that can only say yes or unknown.
  - Benchmark `B-5` (checkpoint with eight pictures) added.
- Attachments and images in the composer (paste, drop, pick; `@image1` references), model image-support check before sending,
  thumbnails and a lightbox in the transcript, queued and retried messages keep their attachments; tool calls read in plain
  language ("Hunting for retry policy") unless Developer mode is on (Settings > General, or the hidden `Ctrl/Cmd+Shift+D`).

- Electron shell on the shared engine: one `utilityProcess` per session, host-owned view state mirrored to the window over a `MessagePort`,
  config/sessions/prompts shared with the terminal through `~/.aragon-agent` (compare-and-swap writes, unknown keys preserved, live
  change detection, sessions held by a terminal cannot be opened for writing).
- Fail-closed approvals (tool confirmation, skill install, ask-user, plan review) with a 400 ms accidental-press guard.
- Supabase-style design tokens with contrast verified by test; English and Simplified Chinese.
- Packaging: engine staged in its published shape (`--omit=optional`), placed in `resources/engine` by an `afterPack` hook;
  `electron . --smoke` proves an installed build can load the engine and start a session host.
- **v1.1 (verification, completion, distribution)**:
  - Real-window E2E (Playwright `_electron` + a scripted OpenAI-compatible model) for first message, tool calls, approval guard, Esc ladder,
    host crash recovery, external config edits, notifications, queue withdrawal, workspace images, update notification, write failures,
    a damaged state file, accessibility (axe), keyboard-only use and title-bar geometry; the same tests run against a packaged E2E build.
  - Fixed by that suite: preferences in `desktop-state.json` were never read; IPC could race the engine load; turn-end notifications had no
    caller; a restarted host left the window on "not connected"; no notice after a damaged preferences file.
  - Withdraw a queued message (the engine queue decides), installed-skill listing without a session, slash-menu metadata from the real command set,
    drag-and-drop paths, workspace image preview (`aragon-asset://`), optimistic "sending" bubble with Retry/Edit, localized engine wording,
    "Build project index", forced fan-out card, process id on job rows.
  - Update notification (not an installer): build-time feed and host allow-list, skip a version, no placeholder host baked in.
  - Build flavors (`dev | e2e | release`; release has no test hooks) and Electron fuses verified against the built executable.
  - CI wrapper, benchmark scripts. Not yet: a registered benchmark machine with baseline numbers, pixel-baseline visual tests,
    macOS/Linux builds (written, never run), in-place updates (no feed, no signing).
- **v1.2 (claims made true, recovery, desktop-grade finish)**:
  - The window opens where it was left (position, size, maximized, zoom) instead of always at the default; move / resize writes are
    debounced and no longer erase the zoom. Zoom is a View-menu action that is saved, and the Windows caption-button strip follows it.
  - A renderer that crashes, fails to load or hangs is reloaded (twice a minute, then the user is asked); the open sessions are
    re-attached, unsent drafts survive (kept in `sessionStorage`, never written to disk), the session hosts are untouched.
  - Waking from sleep no longer parks every idle session at once, and does not hide a host that really died.
  - `/reset`, `/save`, `/branch` and `/queue` do what the parity matrix says (they used to open the sidebar); a mechanical test now
    fails when a "mapped" command is not fulfilled. New session ⋯ menu: new conversation, save checkpoint, export as Markdown, branch,
    copy id, show folder, close. Export removes configured API keys (including the legacy `apiKeys` map the engine registry misses).
  - Find in conversation (Ctrl/Cmd+F) over the entries the view holds, with CSS Custom Highlight; taskbar progress / attention flash.
  - Fixed on the way: the layout writer in the renderer overwrote window geometry and dropped zoom; the production CSP blocked Radix
    Dialog's scroll-lock style on every dialog (now allowed by hash, not by `unsafe-inline`); a failed navigation was "recovered" by
    reloading the error page.
  - Tooling: `test:e2e:repeat`, `bench:verdict`, `make-update-manifest` (read back through the app's own parser), and the case ledger
    (`verify:cases`) runs in CI with a declared rename (`--renamed <old> <new>`).
- **v1.3 (shell polish)**:
  - A long session title no longer widens the sidebar and covers the conversation: the sidebar now fills a clipped slot instead of sizing to its
    content, titles are collapsed to one line, cut with an ellipsis (full text on hover) and fade out before the row's hover actions.
  - The title bar's first slot is the product mark (it was a sidebar toggle). The sidebar is still toggled by Ctrl/Cmd+B, the command palette,
    the rail's Sessions button (now a real toggle) and a new Collapse button in the sidebar header.
  - The Windows / Linux caption-button strip and the window background follow the APPLICATION theme instead of the OS theme (a dark app on a
    light OS used to get a white strip). New IPC `window:set-chrome` (a three-value enum); the main process remembers the last theme in
    `desktop-state.json` (`chromeTheme`) so the first frame is already right; colours live in one table mirrored from `tokens.css` and
    checked by a test. The strip leaves the title bar's divider line alone, and the right-hand gutter is read from the strip's real width.
  - Inspector tabs never wrap (the strip scrolls and keeps the active tab visible); the inspector can be dragged wider (320-640, double-click
    resets, default 400). A stored width of exactly 340 - the old default - is raised to 400 once, **on load only**; someone who really chose
    340 gets 60px more and can drag it back.
  - Narrow windows degrade in steps rather than overflow: below the width needed for sidebar + main + inspector the sidebar hides itself
    (the preference is untouched; it returns when there is room); at very high zoom the minimum widths relax. Never a sideways scrollbar.
  - Settings content is one column centred in the pane right of the navigation; title, page and footer share its left edge. Models and
    Prompts use a wider column.
