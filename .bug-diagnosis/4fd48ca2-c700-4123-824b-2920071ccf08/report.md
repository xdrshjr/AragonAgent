# Bug Diagnosis Session

**Session UUID:** 4fd48ca2-c700-4123-824b-2920071ccf08
**Date:** 2026-10-08
**Mode:** Fully automatic
**Status:** Fixed

## Problem Description

Release (`publish-latest.ps1` -> `npm test -w packages/cli`) failed: 1 of 263
test files failed.

- Failing test: `src/__tests__/exec-diagnostics.test.ts > AC-22: aragon doctor >
  reports a named failing check when no API key is resolvable`
- Assertion: `expected true to be false` — `report.ok` was `true`, meaning the
  `api-key` doctor check PASSED on a machine state where no key should be
  resolvable.

## Evidence Collected

- The test's premise: "The vitest home root is a fresh per-pid directory under
  `os.tmpdir()`, so there is no key." This isolates only the CONFIG FILE layer
  (`app-paths.ts` VITEST branch redirects `getHomeRoot()`).
- `loadConfig()` has FOUR layers: defaults > file > env/.env > flags
  (`config/load.ts:784-796`). The env layer reads
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY`
  (`config/env.ts:61-65, 436-439`).
- `config.test.ts` "getApiKey precedence" block assigns provider key env vars
  DIRECTLY at lines 256/262/268:
  - `process.env.ANTHROPIC_API_KEY = 'env-key'`
  - `process.env.OPENAI_API_KEY = 'env-openai'`
  These are plain assignments, not `vi.stubEnv`, so the file-wide
  `afterEach(() => vi.unstubAllEnvs())` (config.test.ts:34) does NOT undo them.
  The values leak for the remainder of the worker process.
- Vitest assigns several test files sequentially to each worker process
  (maxWorkers <= 4). Environment is process-global across files in one worker.
- `config.test.ts` (c...) sorts before `exec-diagnostics.test.ts` (e...), so
  when both land on the same worker the doctor test runs with
  `ANTHROPIC_API_KEY=env-key` -> `checkProviderKey` resolves a key ->
  `api-key` passes -> `report.ok === true` -> assertion fails.
- Local machine check: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` absent,
  `GEMINI_API_KEY` set (irrelevant: default provider is `anthropic`); no
  `.env` in repo root or `packages/cli`.
- No other test file assigns provider key env vars directly.

## Root Cause Analysis

**Primary Hypothesis:**
`config.test.ts` leaks `process.env.ANTHROPIC_API_KEY` (and
`process.env.OPENAI_API_KEY`) into the shared vitest worker process. When
`exec-diagnostics.test.ts` is scheduled into the same worker afterwards, the
env layer of `loadConfig` resolves a key, the doctor `api-key` check passes,
and the test asserting "no key resolvable" fails. Order-dependent flake
(scheduling collision), which is why it surfaced at release time.

**Why this causes the problem:**
The test's "no key" premise holds only for the config-file layer; the env
layer is process-global shared state across test files in one vitest worker.

**Alternative Possibilities:**
1. A `.env` in the vitest cwd (ruled out: none exists).
2. Machine-level provider env vars (ruled out for anthropic: absent; the set
   `GEMINI_API_KEY` does not apply to the default provider).
3. Another test file leaking keys (ruled out by grep: only config.test.ts).
4. Leftover `config.json` in an inherited `ARAGON_HOME` temp dir (ruled out:
   config.test.ts `afterAll` removes its TMP; other writers either use
   `DEFAULT_CONFIG` (empty apiKeys) or delete their dir).

## Fix Plan

1. Replace the direct env assignments in `config.test.ts` with `vi.stubEnv`
   (already restored by the file's `afterEach(vi.unstubAllEnvs())`).
2. Harden `exec-diagnostics.test.ts` to enforce its own premise: stub the four
   provider key env vars to undefined for the "no key resolvable" test (and
   restore), so the test is hermetic regardless of scheduling.

## Verification Plan

- Deterministic repro: `npx vitest run src/__tests__/config.test.ts
  src/__tests__/exec-diagnostics.test.ts --no-file-parallelism` in
  `packages/cli` (single worker, config first). Expect failure before fix,
  pass after.
- Full `npm test -w packages/cli` afterwards.

## Fix Applied

**Files modified:**
- `packages/cli/src/__tests__/config.test.ts` (getApiKey precedence block) — the
  three direct `process.env.<PROVIDER>_API_KEY = ...` assignments became
  `vi.stubEnv(...)`, so the file-wide `afterEach(vi.unstubAllEnvs())` restores
  them and nothing leaks into later test files of the same worker. A comment
  records why a direct assignment is forbidden here.
- `packages/cli/src/__tests__/exec-diagnostics.test.ts` (AC-22 describe) — the
  suite now ENFORCES its "no key resolvable" premise: beforeEach stubs
  ANTHROPIC/OPENAI/GOOGLE/GEMINI key env vars to undefined (vitest deletes
  them), afterEach un-stubs. Hermetic against both leaked test state and a
  developer shell that exports a real provider key.

**Changes:**
Test-only; no production code touched.

## Verification

- Deterministic repro `npx vitest run src/__tests__/config.test.ts
  src/__tests__/exec-diagnostics.test.ts --no-file-parallelism` in
  `packages/cli`: 1 failed before the fix, 2 files / 96 tests passed after.
- Full release-gate `npm test -w packages/cli`: 263 files passed,
  3878 passed | 6 skipped (3884) — previously 3877 passed | 1 failed.
- `npm run typecheck -w packages/cli` (both tsconfigs): clean.

## Notes

- The repro combination IS the regression test for this bug (two files, one
  worker); no new test file is needed beyond making exec-diagnostics
  self-isolating.
- Other test files also assign `process.env.ARAGON_*` directly (a systemic
  pattern). None of those leak a provider key or `ARAGON_PROVIDER`, so they
  cannot break this suite; converting them all is out of scope for this fix.
- The release can now be re-run (`publish-latest.ps1`); the version files were
  restored by its rollback path, so no manual cleanup is needed.
