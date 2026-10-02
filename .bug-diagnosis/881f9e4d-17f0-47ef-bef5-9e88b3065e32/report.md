# Bug Diagnosis Session

**Session UUID:** 881f9e4d-17f0-47ef-bef5-9e88b3065e32
**Date:** 2026-07-28 09:12 -04:00
**Mode:** Fully automatic
**Status:** Fixed

## Problem Description

After a successful npm release, `npm i -g @aragon-agent/cli@latest` failed with
`ETARGET: No matching version found for @aragon-agent/cli@0.5.3`.

## Evidence Collected

- The npm debug log shows both metadata reads came from the local npm cache.
- The abbreviated package document resolved `latest` to `0.5.3`, while the full
  package document used immediately afterwards did not contain `0.5.3`.
- The scoped registry is `https://registry.npmjs.org/`, so the install did not use
  the configured `https://registry.npmmirror.com` default.
- The official registry currently returns CLI `0.5.3`, Core `0.2.3`, both
  tarball URLs, and the CLI dependency on Core `^0.2.3`.
- The release left the expected version changes in both workspace manifests and
  `package-lock.json`; these pre-existing changes will be preserved.

## Root Cause Analysis

**Primary Hypothesis:**
Immediately after publication, npm's abbreviated and full packument cache entries
were inconsistent. The former advertised `latest=0.5.3`; the latter was stale and
made npm-pick-manifest reject that same version. The post-publish installation
smoke at `scripts/verify-published.mjs:338` installs an exact version, so it does
not exercise the consumer's `@latest` resolution path and cannot catch this state.

**Why this causes the problem:**
Installing `@latest` is a two-step resolution. npm first reads the dist-tag and
then selects that version from full package metadata. Conflicting cached documents
produce the observed `ETARGET`, even though the version and tarball exist.

**Alternative Possibilities:**
1. Registry propagation was still incomplete at the time of installation. This
   can produce the same transient split state, but the package is now complete.
2. A third-party mirror was stale. This is ruled out for the failed command by
   the scoped npm registry configuration and the registry URLs in the debug log.

## Fix Plan

Change the post-publish install smoke to install `@aragon-agent/cli@latest`, while
retaining the existing assertions that the installed CLI and Core versions match
the just-published release. Add regression coverage for the generated install
arguments.

## Verification Plan

- Observe the new tooling regression test fail before implementation.
- Run the tooling test suite after the change.
- Run the complete post-publish verifier for Core `0.2.3` and CLI `0.5.3`.
- Perform a real `@latest` installation in an isolated temporary prefix and run
  its CLI entry point with `--version`.

## Notes

No new npm release is required to repair the already-published package. The code
change prevents future release verification from missing the same consumer path.

## Fix Applied

**Files modified:**

- `scripts/verify-published.mjs` - the clean-directory install smoke now resolves
  `@aragon-agent/cli@latest` and still checks the installed CLI/Core versions.
- `scripts/tests/release-preflight.test.mjs` - added regression coverage for the
  exact `@latest` install arguments and official registry pin.

**Changes:**
The verifier now exercises the same dist-tag-to-version path used by the documented
global install command. A stale or inconsistent `latest` path will therefore fail
post-publish verification instead of being hidden by an exact-version install.

## Verification

- Regression test observed failing before implementation, then passed (10/10).
- Complete release-tooling suite passed (19/19).
- Workspace tests passed: CLI 1022; Core 219; 5 CLI tests skipped.
- Live V4 verification installed CLI `0.5.3` through `@latest` with Core `0.2.3`
  into a clean directory and ran the installed CLI version check successfully.
- The original global install path passed `--dry-run`, both normally and with
  `--prefer-online`, resolving CLI `0.5.3` and Core `0.2.3`.
- The original global install command then completed successfully. `aragon
  --version` printed `0.5.3`, and the global dependency tree contains Core
  `0.2.3`.
- The complete live verifier still reports an unrelated V2 failure because the
  GitHub default branch serves a Core manifest named `@argon-agent/core`. V1,
  V3, and the relevant V4 installation check passed.

## Final Notes

The initial npm cache split has converged, so the published package is currently
installable. npm documents `--prefer-online` as forcing freshness checks for cached
metadata; it is the targeted recovery option if this transient state recurs.
