# Bug Diagnosis Session

**Session UUID:** 0f8258b1-c47e-4e93-bd31-c60c04b8ade3
**Date:** 2026-08-02 00:31 -04:00
**Mode:** Fully automatic
**Status:** Fixed

## Problem Description

Running `publish-latest.ps1` fails before `npm publish`. The tail of the output
shows all 21 Core test files and all 338 Core tests passing, but the release
script reports `npm command failed (1): npm test` and restores version files.

## Evidence Collected

- A direct `npm test` and a release-style `node npm-cli.js test` both initially
  exited 0.
- A complete `publish-latest.ps1 -DryRun` exited 0 and restored the version
  files, confirming the publish workflow itself can complete.
- On stress run 4 of the exact release-style test command, CLI test
  `src/__tests__/mouse-routing.test.tsx:273` failed: expected overlay scroll
  calls `[-3]`, received `[]`.
- After fixing that local subscription race, another default-concurrency full
  run exposed three more load-sensitive CLI failures: two synchronous
  `render-budget.test.tsx` cases exceeded Vitest's 5 second default, and one
  `app.test.tsx` case had not rendered its message after a fixed 80 ms wait.
- The release machine exposes 18 logical processors. Running the same CLI suite
  with `--maxWorkers=4` passed all 145 files / 2077 tests.
- npm continued to run the Core workspace after that CLI failure. Core then
  passed all 21 files / 338 tests, but npm correctly returned the earlier CLI
  failure as aggregate exit code 1. This reproduces the user's misleading tail.
- The watchdog message is emitted by a Core test that intentionally verifies a
  genuinely wedged run is aborted; that test passes and is not the failure.

## Root Cause Analysis

**Primary Hypothesis:**
The CLI suite lets Vitest use the release machine's full worker capacity even
though many Ink tests are CPU-heavy and depend on short event-loop waits. The
result is suite-wide timing instability. One concrete instance is
`packages/cli/src/__tests__/mouse-routing.test.tsx`, which waits a fixed 10 ms
after rendering before emitting a wheel event. React/Ink installs the
`MouseSource` subscription in `useEffect`; under full-suite worker load, the
effect sometimes has not run after 10 ms, so the synthetic event is dropped.

**Why this causes the problem:**
The controlled-overlay route calls `onOverlayScroll` synchronously whenever a
subscriber receives the event. Receiving `[]` therefore shows that the event
was emitted before subscription, not that the overlay calculation was delayed.
The test already exposes `subscriberCount()`, but uses elapsed time instead of
waiting for that observable readiness condition. Subsequent failures in other
files under the same default concurrency confirm the resource-contention layer.

**Alternative Possibilities:**
1. A product defect in overlay routing is unlikely because the same isolated
   test and repeated full runs pass whenever subscription is ready.
2. The 16 ms content-scroll coalescer can also be delayed under load, but the
   reproduced failing case uses the synchronous overlay branch and never enters
   that coalescer.

## Fix Plan

Cap CLI Vitest at four workers so release checks do not saturate all 18 logical
processors. Replace fixed pre-event sleeps in the isolated router tests with a
bounded wait for `subscriberCount() === 1`. Keep post-event waits only where the
production 16 ms coalescer is intentionally under test.

## Verification Plan

1. Use the observed stress failure as the RED regression evidence.
2. Run the isolated mouse-routing test repeatedly after the change.
3. Run the full root test command repeatedly in the release preload environment.
4. Run the complete release-tooling tests and a final `publish-latest.ps1 -DryRun`.

## Fix Applied

**Files modified:**

- `packages/cli/src/__tests__/mouse-routing.test.tsx:183` - added a bounded
  `waitUntilSubscribed()` readiness helper and replaced all fixed pre-event
  10 ms sleeps in the isolated router tests.
- `packages/cli/vitest.config.ts:4` - capped the CLI suite at the smaller of four
  workers or the host's available processor count minus one (with a one-worker
  floor), preventing both high-core contention and low-core oversubscription.

**Changes:**
The mouse tests now synchronize on the observable condition they require: one
active subscriber. The suite also uses bounded concurrency for stable release
checks. Production behavior and post-event coalescing waits are unchanged.

## Verification

- RED reproduced before the fix on stress run 4: one CLI mouse-routing test
  failed while the later Core suite passed, and aggregate `npm test` exited 1.
- Isolated `mouse-routing.test.tsx`: 20 consecutive runs passed (24/24 tests
  each).
- Release-style root test after bounding concurrency: 3 consecutive runs
  passed; each run completed CLI 145/145 files (2072 passed, 5 skipped) and Core
  21/21 files (338 passed).
- Final release-preload `npm test` after the portable worker-cap refinement:
  exited 0 with the same full test counts.
- `npm run typecheck`: exited 0 for both workspaces.
- `npm run test:tooling`: 19/19 tests passed.
- `scripts/tests/publish-latest.tests.ps1`: 14/14 release scenarios passed.
- A pre-fix `publish-latest.ps1 -DryRun` completed the complete test/build/pack
  path and restored all version files. The post-fix DryRun was correctly blocked
  by the script's clean-worktree guard because the fix is intentionally still
  uncommitted; package manifests and lockfile remain at Core 0.2.11 / CLI 0.5.11.
- Independent code review found no Critical or Important issues after changing
  the worker cap to respect low-core hosts.

## Notes

Diagnosis used the existing `.claude-index/index.md` project index. No package
was published during diagnosis. Commit the fix before running the real release,
because `publish-latest.ps1` intentionally rejects a dirty source tree.
