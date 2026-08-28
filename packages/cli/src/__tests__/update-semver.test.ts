/**
 * `update/semver.ts` — ordering, prereleases, engine ranges and the decision
 * (cli-auto-update §3.4 / §8.1).
 *
 * THE FAIL-OPEN DIRECTION IS THE ONE WORTH PINNING (D-15 / AC-13). An
 * `engines.node` syntax we did not anticipate must let the update through, not
 * freeze every user's updates forever with no message and no way to find out.
 * The reverse — a range we DID understand and that excludes this Node — must
 * produce a `notify`, so the user is told to upgrade Node rather than left
 * wondering. A test that only asserted one of those would pass against an
 * implementation that got the other backwards.
 */

import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  decideUpdate,
  isPrerelease,
  parseSemver,
  satisfiesNodeRange,
  STRICT_VERSION_RE,
} from '../update/semver.js';

const manifest = (version: string, extra: Record<string, unknown> = {}) =>
  ({ version, ...extra }) as Parameters<typeof decideUpdate>[0]['manifest'];

describe('parseSemver', () => {
  it('parses the three-part core with an optional prerelease and build', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseSemver('1.2.3-rc.1+build.9')?.prerelease).toEqual(['rc', '1']);
    expect(parseSemver('v18.19.0')?.major).toBe(18);
  });

  it('returns null for anything that is not a version', () => {
    for (const bad of ['', '1.2', 'latest', '1.2.3.4', null, undefined, 42]) {
      expect(parseSemver(bad as unknown as string), String(bad)).toBeNull();
    }
  });
});

describe('compareSemver', () => {
  it('orders by numeric core', () => {
    expect(compareSemver('0.6.0', '0.5.9')).toBe(1);
    expect(compareSemver('0.5.9', '0.6.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1);
  });

  it('sorts a prerelease BELOW its own release (semver §11)', () => {
    // Getting this backwards would let a `latest` tag pointing at a release
    // candidate read as newer than the release it precedes.
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('sorts an UNPARSEABLE version below a parseable one', () => {
    // A garbage registry answer must never read as newer than what is installed.
    expect(compareSemver('not-a-version', '0.5.9')).toBe(-1);
    expect(compareSemver('0.5.9', 'not-a-version')).toBe(1);
  });
});

describe('isPrerelease', () => {
  it('is true only when a prerelease tag is present', () => {
    expect(isPrerelease('1.0.0')).toBe(false);
    expect(isPrerelease('1.0.0+build')).toBe(false);
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
  });
});

describe('satisfiesNodeRange', () => {
  it('handles the forms engines.node actually uses', () => {
    expect(satisfiesNodeRange('>=18', '18.19.0')).toBe(true);
    expect(satisfiesNodeRange('>=18', '20.11.1')).toBe(true);
    expect(satisfiesNodeRange('>=20.10.0', '20.9.0')).toBe(false);
    expect(satisfiesNodeRange('>=20.10.0', '20.10.0')).toBe(true);
    expect(satisfiesNodeRange('>18', '18.0.0')).toBe(false);
    expect(satisfiesNodeRange('^20', '20.11.1')).toBe(true);
    expect(satisfiesNodeRange('^20', '21.0.0')).toBe(false);
    expect(satisfiesNodeRange('18.x', '18.19.0')).toBe(true);
    expect(satisfiesNodeRange('18.x', '20.0.0')).toBe(false);
    expect(satisfiesNodeRange('>=18 <21', '20.0.0')).toBe(true);
    expect(satisfiesNodeRange('>=18 <21', '21.1.0')).toBe(false);
    expect(satisfiesNodeRange('^18 || ^20', '20.1.0')).toBe(true);
    expect(satisfiesNodeRange('^18 || ^20', '19.1.0')).toBe(false);
  });

  it('FAILS OPEN on anything it cannot parse (D-15 / AC-13)', () => {
    // The worse of the two errors by a wide margin: a syntax we did not
    // anticipate must not silently freeze every user's updates forever.
    for (const garbage of ['not a range', '>=>=18', 'node16', '~~1', '>=1.2.3.4']) {
      expect(satisfiesNodeRange(garbage, '18.19.0'), garbage).toBe(true);
    }
    expect(satisfiesNodeRange(undefined, '18.19.0')).toBe(true);
    expect(satisfiesNodeRange('', '18.19.0')).toBe(true);
    expect(satisfiesNodeRange('*', '18.19.0')).toBe(true);
  });

  it('treats a PARTIALLY understood range as unknown, not as strict', () => {
    // A union whose first clause parses and whose second does not is exactly the
    // input that would make a fail-open guard silently strict.
    expect(satisfiesNodeRange('>=99 || garbage-here', '18.19.0')).toBe(true);
  });
});

describe('decideUpdate', () => {
  const base = { local: '0.5.9', nodeVersion: '20.11.1', skippedVersion: '' };

  it('installs a strictly newer, stable, non-deprecated, runnable version', () => {
    expect(decideUpdate({ ...base, manifest: manifest('0.6.0') })).toEqual({
      action: 'install',
      reason: 'newer-available',
    });
  });

  it('says nothing when the registry is not ahead of us', () => {
    expect(decideUpdate({ ...base, manifest: manifest('0.5.9') }).action).toBe('none');
    expect(decideUpdate({ ...base, manifest: manifest('0.5.8') }).reason).toBe('up-to-date');
  });

  it('never moves a stable install onto a prerelease (AC-10)', () => {
    // Even if someone points the `latest` dist-tag at one.
    expect(decideUpdate({ ...base, manifest: manifest('0.6.0-rc.1') })).toEqual({
      action: 'none',
      reason: 'prerelease',
    });
  });

  it('DOES move a prerelease install onto a newer prerelease', () => {
    // A local prerelease is already opted in; refusing here would strand the
    // testers who most need the next build.
    const decision = decideUpdate({
      ...base,
      local: '0.6.0-rc.1',
      manifest: manifest('0.6.0-rc.2'),
    });
    expect(decision.action).toBe('install');
  });

  it('never auto-installs a version its own author deprecated (AC-11)', () => {
    expect(
      decideUpdate({ ...base, manifest: manifest('0.6.0', { deprecated: 'use 0.7' }) }),
    ).toEqual({ action: 'none', reason: 'deprecated' });
  });

  it('NOTIFIES rather than installs when this Node is too old (AC-12)', () => {
    // `notify`, not `none`: the user can act on this one, so silence would be
    // the wrong kind of quiet.
    expect(
      decideUpdate({
        ...base,
        nodeVersion: '18.19.0',
        manifest: manifest('0.6.0', { engines: { node: '>=20' } }),
      }),
    ).toEqual({ action: 'notify', reason: 'node-too-old' });
  });

  it('installs when engines.node is unparseable (AC-13)', () => {
    const decision = decideUpdate({
      ...base,
      manifest: manifest('0.6.0', { engines: { node: 'whatever npm allows' } }),
    });
    expect(decision.action).toBe('install');
  });

  it('honours a skipped version, and only that exact one', () => {
    expect(
      decideUpdate({ ...base, skippedVersion: '0.6.0', manifest: manifest('0.6.0') }),
    ).toEqual({ action: 'none', reason: 'skipped' });
    // A NEWER release clears the latch in the normal way, so `/update skip` and
    // U-6's `install-ineffective` latch both opt the user out of a loop rather
    // than out of updates.
    expect(
      decideUpdate({ ...base, skippedVersion: '0.6.0', manifest: manifest('0.6.1') }).action,
    ).toBe('install');
  });

  it('checks `skipped` BEFORE the quality gates', () => {
    // A user who typed `/update skip` should not then be told about a
    // prerelease they already declined.
    expect(
      decideUpdate({ ...base, skippedVersion: '0.6.0-rc.1', manifest: manifest('0.6.0-rc.1') })
        .reason,
    ).toBe('skipped');
  });
});

describe('STRICT_VERSION_RE (AC-24)', () => {
  it('accepts real versions and rejects everything that could reach argv', () => {
    for (const good of ['1.0.0', '0.5.9', '1.0.0-rc.1', '1.0.0+build.2']) {
      expect(STRICT_VERSION_RE.test(good), good).toBe(true);
    }
    // A manifest with `version: "1.0.0; rm -rf /"` must never reach `spawn`.
    // With `shell: false` this is not an injection surface to begin with; the
    // rejection is what makes that claim checkable rather than reasoned.
    for (const bad of [
      '1.0.0; rm -rf /',
      '1.0.0 && echo hi',
      '--force',
      'v1.0.0',
      '1.0.0\n2.0.0',
      '',
      '../../etc/passwd',
    ]) {
      expect(STRICT_VERSION_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
