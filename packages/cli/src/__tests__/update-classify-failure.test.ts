/**
 * `classifyInstallFailure` and the reporting rule it feeds
 * (cli-auto-update-hardening H2 / AC-43 / AC-44 / AC-45).
 *
 * PURE AND OFFLINE: a string in, a reason out. The half worth testing carefully
 * is not the regexes, it is the TABLE ORDER and the membership of
 * `IMMEDIATE_NOTICE_REASONS` - the two places where a plausible-looking edit
 * changes user-visible behaviour silently.
 */

import { describe, expect, it } from 'vitest';
import { classifyInstallFailure } from '../update/classify-failure.js';
import { IMMEDIATE_NOTICE_REASONS, shouldRenderUpdateLine } from '../update/types.js';
import { UPDATE_LIMITS } from '../update/limits.js';
import type { UpdateReason, UpdateSnapshot } from '../update/types.js';

function failedAt(failures: number, reason: UpdateReason): UpdateSnapshot {
  return {
    phase: 'failed',
    currentVersion: '0.5.9',
    latestVersion: '0.6.0',
    source: 'npm-global',
    reason,
    nextCheckAt: null,
    consecutiveFailures: failures,
  };
}

describe('classifyInstallFailure', () => {
  it('AC-43: EPERM wins over EACCES when npm prints both', () => {
    // THE ORDER IS THE ASSERTION. npm's Windows output frequently carries both -
    // the EPERM on the shim rename plus an EACCES from a retry - and the
    // actionable one is the first. Sorting the table alphabetically, or moving
    // the EACCES row up, changes the row the user sees from "close other aragon
    // windows" to "needs write access" with nothing failing.
    const tail = [
      'npm error code EPERM',
      "npm error syscall rename",
      'npm error EACCES: permission denied, open ...',
    ].join('\n');
    expect(classifyInstallFailure(tail)).toBe('blocked-by-os');
  });

  it('recognises each of the four families on its own', () => {
    expect(classifyInstallFailure('npm error code EBUSY resource busy or locked')).toBe(
      'blocked-by-os',
    );
    expect(classifyInstallFailure('npm error code ETXTBSY')).toBe('blocked-by-os');
    expect(classifyInstallFailure('Error: EACCES: permission denied')).toBe('not-writable');
    expect(classifyInstallFailure('npm error code ENOSPC')).toBe('no-space');
    expect(classifyInstallFailure('no space left on device')).toBe('no-space');
    expect(classifyInstallFailure('npm error code ENOTFOUND registry.npmjs.org')).toBe('network');
    expect(classifyInstallFailure('tunneling socket could not be established')).toBe('network');
  });

  it('`network` is LAST, so a specific cause is not swallowed by advisory text', () => {
    // npm's own advice regularly mentions the network and the proxy while
    // reporting something else entirely. An earlier `network` row would answer
    // "network" for a disk that is full, which is silent AND unactionable.
    const tail =
      'npm error code ENOSPC\nnpm error check your network connection and proxy settings';
    expect(classifyInstallFailure(tail)).toBe('no-space');
  });

  it('AC-44: an absent or unrecognised tail is `install-failed`', () => {
    // The pre-H2 behaviour, deliberately: a machine whose npm says something we
    // have never seen degrades to what it did before rather than to a confident
    // wrong answer.
    expect(classifyInstallFailure(undefined)).toBe('install-failed');
    expect(classifyInstallFailure('')).toBe('install-failed');
    expect(classifyInstallFailure('npm error something entirely new')).toBe('install-failed');
  });
});

describe('AC-45: the reporting rule', () => {
  it('the three immediate reasons show at ONE consecutive failure', () => {
    for (const reason of ['blocked-by-os', 'no-space', 'not-writable'] as const) {
      expect(shouldRenderUpdateLine(failedAt(1, reason)), reason).toBe(true);
    }
  });

  it('`network` and `install-failed` stay silent until the third', () => {
    // THE OTHER DIRECTION, and it is the one that matters (R-20). A set that
    // grows until everything is immediate is the notification fatigue the rest
    // of this feature is built to avoid, and the membership rule - actionable
    // AND not self-healing - is what keeps it from growing.
    for (const reason of ['network', 'install-failed'] as const) {
      expect(shouldRenderUpdateLine(failedAt(1, reason)), reason).toBe(false);
      expect(shouldRenderUpdateLine(failedAt(2, reason)), reason).toBe(false);
      expect(
        shouldRenderUpdateLine(failedAt(UPDATE_LIMITS.failuresBeforeNotice, reason)),
        reason,
      ).toBe(true);
    }
  });

  it('the set is exactly the three the rule admits', () => {
    // Pinned as a whole rather than by membership tests alone: adding a fourth
    // is a policy decision that has to be made deliberately, and this is where
    // the reviewer sees it.
    expect([...IMMEDIATE_NOTICE_REASONS].sort()).toEqual([
      'blocked-by-os',
      'no-space',
      'not-writable',
    ]);
    expect(IMMEDIATE_NOTICE_REASONS.has('network')).toBe(false);
  });
});
