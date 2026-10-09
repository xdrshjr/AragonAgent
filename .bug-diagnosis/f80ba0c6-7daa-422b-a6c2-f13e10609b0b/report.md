# Bug Diagnosis Session

**Session UUID:** f80ba0c6-7daa-422b-a6c2-f13e10609b0b
**Date:** 2026-10-08 06:32
**Mode:** Fully automatic
**Status:** Fixed (feature: user-configurable model-windows.json)

## Problem Description

User report (Chinese): the context gauge below the input box in the TUI always
shows a question mark ("Context ?" / "C?"), never a percentage.

## Evidence Collected

- `~/.aragon-agent/config.json`: provider `anthropic`, model `kimi-k3`,
  baseUrl `https://api.kimi.com/coding`, `contextWindow: null` (no override).
  Model profiles use `glm-5.3` / `glm-5.3-flash` on bigmodel's Anthropic-compatible
  endpoint — also absent from every known-model table.
- Rendering: `packages/cli/src/ui/layout/status-layout.ts:60-63` returns `'?'`
  when `validContext()` is false; `validContext()` (line 56) requires
  `context.windowKnown` plus finite, non-negative numbers.
- Data source: `packages/cli/src/compaction/meter.ts:479-493`
  (`ContextMeter.resolveWindow`) — an explicit `contextWindow` override makes the
  window known; otherwise `isWindowKnown()` decides.
- `packages/cli/src/agent/controller.ts:733`:
  `isWindowKnown: () => this.getModelInfo().contextWindowSource !== 'fallback'`.
- `packages/cli/src/agent/controller.ts:2010-2018` resolves the window through
  `ModelRegistry.getContextWindow(providerId, modelId, baseUrl)`.
- `packages/core/src/llm/model-registry.ts:74-92` — resolution order:
  1. API discovery cache, but only entries with `contextWindowSource === 'api'`.
  2. Builtin per-provider lists (3 Claude ids on `anthropic`).
  3. `CATALOG` in `packages/core/src/llm/context-window.ts:38-50`
     (10 ids: gpt-5 family, gpt-4.1, gemini-2.5-pro/flash, claude-sonnet-4-6).
  4. Otherwise `{ contextWindow: 128_000, contextWindowSource: 'fallback' }`.
- `packages/core/src/llm/providers/anthropic.ts:326-372` maps discovery through
  `reportedContextWindow` (`context-window.ts:8-16`), which only accepts
  `context_length` / `context_window` / `max_input_tokens` / `inputTokenLimit`
  fields. The Anthropic-compatible `/v1/models` response carries none of them
  (and Kimi's `/coding` endpoint may not implement the listing at all), so the
  discovery path can never mark `kimi-k3` as `api`-sourced.

## Root Cause Analysis

**Primary Hypothesis (confirmed):**

`kimi-k3` is not in any known-model table (builtin lists, the 10-entry CATALOG,
and API discovery that yields no context-length data), so
`ModelRegistry.getContextWindow('anthropic', 'kimi-k3', baseUrl)` returns the
explicitly-untrusted 128k `fallback` (`model-registry.ts:91`).
`controller.ts:733` then reports `isWindowKnown() === false`, which propagates
through `ContextMeter.resolveWindow()` into `ContextUsageSnapshot.windowKnown`,
and `status-layout.ts:61` renders `'?'`. The user's `contextWindow: null`
removes the one override that would have forced the window known.

**Why this causes the problem:**

The gauge deliberately refuses to show a percentage against a guessed
denominator: `~` means "window known, occupancy estimated"; `?` means
"window unknown". With no catalog entry, no API-provided length, and no user
override, the denominator is unknown on every turn — the `?` is permanent,
not a startup transient.

**Alternative Possibilities:**

1. Startup-only `?` before the first measurement (`emptyContextUsage()` also
   has `windowKnown: false`) — ruled out: user reports "always", and the
   config's model id guarantees the fallback branch on every measurement.
2. NaN/invalid numbers failing `validContext()` — ruled out: purely defensive;
   no producer can emit NaN here.

## Fix Applied

Implemented the user-configurable per-model window file requested by the user
(`~/.aragon-agent/model-windows.json`), plus the researched values:

**Files modified:**
- `packages/cli/src/config/app-paths.ts` - `getModelWindowsPath()` + LAYOUT entry
- `packages/cli/src/config/model-windows.ts` - NEW: format, parser, mtime-cached lookup
- `packages/cli/src/agent/controller.ts` - `ControllerDeps.modelWindows`, field,
  constructor default, and the `getModelInfoFor` override (source `'user'`,
  outranking api/catalog/fallback; config.json `contextWindow` still wins)
- `packages/core/src/llm/types.ts` + `packages/core/src/llm/context-window.ts` -
  `contextWindowSource` union widened with `'user'` (Core never produces it)
- `packages/cli/src/compaction/types.ts` - `Pressure.windowSource` widened likewise
- `packages/cli/src/compaction/context-command.ts` - `/context` names the new
  source; UNKNOWN hint now mentions the file
- `packages/core/API.md` - documents the fourth source literal

**Values written to `~/.aragon-agent/model-windows.json`** (verified online,
2026-10-08): `kimi-k3` = 1048576 (Moonshot platform pricing table `1M tokens`;
kimi.com/coding "K3 ... 1M context"; OpenRouter context_length=1048576),
`glm-5.3` = 1048576 and `glm-5.3-flash` = 1048576 (docs.z.ai official pages:
"a 1M-token context window"; flash "consistent with GLM-5.3"; OpenRouter
1048576).

## Verification

- New tests: `model-windows.test.ts` (10), `model-windows-controller.test.ts` (5,
  full precedence ladder), `context-command.test.ts` extended (+1, hint updated) - all green.
- Regression: full CLI suite 254 files / 3697 tests passed; full core suite
  32 files / 549 tests passed (incl. `public-api` and `no-host-coupling`);
  `tsc --noEmit` clean for both packages (source + test configs).
- End-to-end smoke against the REAL `~/.aragon-agent/model-windows.json`
  through the built dist: `window=1048576, windowKnown=true, windowSource='user'`,
  occupancy estimated at 3180 tokens -> the status bar shows a percentage
  instead of `?`.

## Review round (post-fix, subagent audit)

Three parallel review subagents audited the change. Findings and dispositions:

- P1 FIXED - UTF-8 BOM and UTF-16LE/BE saves (Windows Notepad defaults) parsed to
  an empty table, silently killing the feature. `refresh()` now reads raw bytes
  and BOM-sniffs; `parseModelWindowsResult` also strips a stray UTF-8 BOM.
  Verified against dist with all three encodings (all resolve to 1048576).
- P2 FIXED - a transient stat failure (EACCES/AV lock) cleared the table
  mid-session. Now only ENOENT (a deliberate deletion) clears; other stat
  errors keep the last good table.
- P3 FIXED - a valid-but-empty file (`{}`) logged a spurious parse warning.
  `parseModelWindowsResult` now separates `malformed` from valid-but-empty;
  the warn fires only on the former.
- P3 FIXED - `/context`: override parenthetical now names model-windows.json;
  `windowSource === undefined` + known window now prints "source unverified"
  instead of claiming "the model table" (pre-existing honesty gap, exposed by
  the new branch).
- P2 FIXED - docs: root README + packages/cli README (tree, resolution order,
  and a new `model-windows.json` subsection) now document the file.
- Not fixed (out of scope): `keyboardEnhancement` WIP from a parallel session
  modified schema.ts/cli.tsx/env.ts/load.ts/input/* at 10:57Z and currently
  breaks `tsconfig.test.json` in 16 files this feature never touched; root
  `.patch-*.cjs` junk from other sessions; pre-existing non-ASCII (em-dash,
  section sign) in comment prose across the repo (house style; the glyph
  scanner exempts comments and passes).

Verification after fixes: 7 suites / 63 tests green (incl. new encoding matrix
UTF-8+BOM / UTF-16LE / UTF-16BE, deletion, malformed flag); source `tsc -p
tsconfig.json --noEmit` clean; dist rebuilt; controller smoke still reports
window=1048576, windowKnown=true, windowSource='user'.

## Notes

- Same symptom will appear for ANY model id outside the builtin lists + CATALOG
  on Anthropic/OpenAI-compatible endpoints; this is inherent to the design
  (refuse to guess a denominator), not a regression.
- The `glm-5.3` / `glm-5.3-flash` profiles in the same config file are also
  outside the catalog and would show `?` when active.
