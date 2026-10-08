# aragon-desktop - Electron + Next.js desktop host

Date: 2026-10-08
Status: implemented; unit tests green; installer produced on Windows x64.

## 1. Problem and approach

Give AragonAgent a desktop application comparable to the Claude Code / Codex
desktop experiences: multi-session chat, model configuration for Anthropic /
OpenAI / custom OpenAI-compatible endpoints, Anthropic-grade visual design, and
an installer a non-developer can double-click.

The desktop is a *wrapper*, not a second engine. It reuses the CLI's
`aragon exec` machine contract (stream-json in both directions) so every
capability the TUI has - tools, durable sessions, compaction, retry, budgets,
interrupts - works in the desktop with zero changes to `packages/*`:

```
renderer (Next.js static export, app:// protocol)
   |  contextBridge IPC (typed window.aragon)
electron main
   |  SessionRegistry: one ExecChild per session (ELECTRON_RUN_AS_NODE)
   |  journals every event to sessions/<id>/events.jsonl
aragon exec --output-format stream-json --input-format stream-json
   --include-thinking --partial-messages (--session-id | --resume)
```

### Why spawn instead of embedding Core

Embedding `@aragon-agent/core` in the Electron main process would re-implement
everything the CLI already owns: host tools, config, skills, compaction
wiring, sessions. The exec surface is the project's own documented wrapper
contract ("ignore event types you do not know"), it is versioned
(`EXEC_SCHEMA_VERSION`), and a subprocess per session gives free isolation:
crash containment, clean kill semantics, and per-session environments.

### Key decisions

| Decision | Rationale |
| --- | --- |
| `ELECTRON_RUN_AS_NODE` child | packaged app needs no system Node; Electron 33 ships Node 20.18 (ESM-capable) |
| Raw-event journal + one fold reducer | replay-after-restart and live streaming share one code path; renderer never trusts folded state it cannot recompute |
| Env-var model injection (`ARAGON_*`) | documented CLI override surface; never writes the user's `~/.aragon-agent/config.json`; per-session profiles possible |
| `custom` mode = provider `openai` + required base URL | any OpenAI-compatible gateway is one adapter; keeps the provider set adapter-backed |
| safeStorage key vault | DPAPI/Keychain-encrypted at rest; keys never cross IPC (only `hasKey`) |
| Lazy respawn on env-hash change | switching model/cwd mid-session resumes the same CLI session on the next message |
| `app://` custom protocol for the export | absolute `/_next/...` asset URLs resolve without a local HTTP server |
| npm-pack staged runtime | deterministic, offline-capable, independent of electron-builder workspace quirks |

## 2. Interaction specification (states and recovery)

Requirement IDs referenced below are stable for future reviews.

### R-1 Session lifecycle

| Action | Result state | Failure / recovery |
| --- | --- | --- |
| New chat (sidebar) | fresh view, composer focused, session row appears titled "New chat" | if no profile exists, settings opens instead (R-4) |
| First message | row retitles from the message; phase starting -> idle -> running | spawn failure surfaces as a fatal notice row; Send retries |
| Switch session (click row) | backlog folds from the journal; live child keeps running for the old session | - |
| Delete session | inline confirm click (no dialog); journal + CLI session file removed | - |
| Quit app | children settle via `end` frame (8s grace), sessions persist | hard kill falls back to the CLI's own session persistence |

### R-2 Turn interaction

| Action | Result state | Notes |
| --- | --- | --- |
| Enter | optimistic "YOU - QUEUED" row; echo reconciles on the `user` event | the exec child buffers queued turns by contract |
| Enter while running | queues a follow-up (hint text changes) | - |
| Stop | interrupt frame; result(stopReason=interrupted) renders as a footer | settle+persist guaranteed by init `capabilities` |
| tool call | running card -> done card (duration, expandable input/output) | orphan results synthesize a completed card |
| thinking | collapsed "Thought process (N words)" | `--include-thinking` |
| compaction / retry / error | notice rows (info / warn / error tones) | applied=false compaction ends are skipped |
| turn end | result footer: in/out tokens, duration, cost | usage accumulates per session |

Phase semantics (verified by `scripts/smoke-interactive.mjs`): `result` is a
RUN-level event - it fires once, after the end frame or exit. The per-turn
completion signal in an interactive session is `turn_state`
(`started` -> running, `completed`/`failed`/`cancelled` -> idle). Usage and
cost therefore appear when a run closes, not after each message.

### R-3 Model switching

Profile chip (header) switches the ACTIVE session's profile and the default
for new chats; the next message respawns the child under `--resume` with the
new env. The composer never blocks on the respawn.

### R-4 Settings

- Mode cards: Anthropic / OpenAI / Custom (OpenAI-compatible). Custom requires
  a base URL; all modes accept an optional gateway override.
- API key: password field, "stored - type to replace", encrypted at rest,
  never rendered back.
- Test connection: one-turn exec probe with the profile env (`--no-save-session
  --max-turns 1`); success shows model + latency, failure the provider message.
- Save: whole-draft transaction; per-profile issues are reported inline and
  nothing is written on failure.

### R-5 Transcript reading

Streaming caret while `streaming`; auto-follow stops when the user scrolls up
("Jump to latest" pill); markdown with GFM, highlighted code with copy buttons;
scrollbars styled to the palette.

## 3. Visual system

Warm paper canvas (#F0EEE6 oat / #FAF9F5 bone), ink scale from #191919,
single coral accent (#D97757 / hover #C4633F / soft #F6E3DA), hairline borders
(#E0DDD2), Source Serif 4 display over Inter, 16/12/8 radius ladder, soft
two-tier shadows, 160ms cubic-bezier motion. Tool status uses ok/danger tints
on the glyph only, keeping the card surface quiet.

## 4. Files and thresholds

All new files are inside `desktop/` (a new root workspace). Pure logic lives in
`shared/` (fold reducer, event mirror, protocol) and `electron/settings/`
(profiles, env-inject) with unit coverage in `desktop/tests/` (36 tests).
Every file stays under the 1,000-line cap; functions are small and named for
their behaviour. The package is private and never published.

## 5. Open items

- macOS / Linux builds are configured but untested (no signing identities).
- Session titles are first-message derived; manual rename ships in the IPC but
  not yet in the UI.
- Team subagent events render as notices; a dedicated roster panel can follow.
- No dark theme yet - the light palette is the design's center of gravity.
