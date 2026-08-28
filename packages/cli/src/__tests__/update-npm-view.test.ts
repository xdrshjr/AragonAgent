/**
 * `fetchLatestViaNpm` - the proxy-aware fallback probe
 * (cli-auto-update-hardening H3 / AC-47 / AC-48).
 *
 * NO TEST SPAWNS NPM. `execFileImpl` is injected, so the argv, the options and
 * every failure shape are asserted against a stub. The two properties that
 * matter are the ARGV - `--registry` in particular, whose absence would make the
 * fallback answer about a different registry than the check it replaces - and
 * the never-throws contract, since the only caller is a background timer.
 */

import { describe, expect, it } from 'vitest';
import { buildNpmViewArgs, fetchLatestViaNpm, type ExecFileImpl } from '../update/npm-view.js';
import { UPDATE_LIMITS } from '../update/limits.js';

const NPM_CLI = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
const REGISTRY = 'https://mirror.corp.example.com';

interface Call {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

function stub(
  behaviour: (cb: (e: Error | null, out: string, err: string) => void) => void,
): { impl: ExecFileImpl; calls: Call[] } {
  const calls: Call[] = [];
  const impl: ExecFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options: options as unknown as Record<string, unknown> });
    behaviour(callback);
    return undefined;
  };
  return { impl, calls };
}

function ok(body: unknown) {
  return stub((cb) => cb(null, JSON.stringify(body), ''));
}

describe('AC-47: the argv', () => {
  it('is exactly the six arguments, with the RESOLVED registry', () => {
    // `--registry` IS NOT OPTIONAL (P1-4 / D-41). Without it `npm view` obeys
    // whatever `.npmrc` says, so on a mirror-configured machine - the same
    // population this fallback exists for - it would answer about a different
    // package registry than the HTTP check it is standing in for, and
    // `decideUpdate` could not tell.
    expect(buildNpmViewArgs(NPM_CLI, '@aragon-agent/cli', 'latest', REGISTRY)).toEqual([
      NPM_CLI,
      'view',
      '@aragon-agent/cli@latest',
      '--json',
      '--loglevel=error',
      `--registry=${REGISTRY}`,
    ]);
  });

  it('is what the probe actually passes, with shell:false and a timeout', () => {
    const { impl, calls } = ok({ name: '@aragon-agent/cli', version: '0.6.0' });
    return fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
      execFileImpl: impl,
      npmCliPath: NPM_CLI,
      env: {},
    }).then(() => {
      expect(calls).toHaveLength(1);
      const call = calls[0] as Call;
      expect(call.args).toEqual(
        buildNpmViewArgs(NPM_CLI, '@aragon-agent/cli', 'latest', REGISTRY),
      );
      // C-7: an argv array, never a shell. The package name comes from a
      // manifest on disk and the registry from config.
      expect(call.options.shell).toBe(false);
      expect(call.options.windowsHide).toBe(true);
      // SAFE HERE AND FORBIDDEN FOR THE INSTALLER (C-20): a killed `npm view`
      // has written nothing.
      expect(call.options.timeout).toBe(UPDATE_LIMITS.npmViewTimeoutMs);
      expect(call.options.maxBuffer).toBe(UPDATE_LIMITS.manifestMaxBytes);
    });
  });

  it('runs npm through `process.execPath`, never the `npm` shim (U-2)', () => {
    const { impl, calls } = ok({ name: '@aragon-agent/cli', version: '0.6.0' });
    return fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
      execFileImpl: impl,
      npmCliPath: NPM_CLI,
      env: {},
    }).then(() => {
      expect((calls[0] as Call).file).toBe(process.execPath);
    });
  });
});

describe('parsing', () => {
  it('returns the same shape `fetchLatestManifest` does', async () => {
    // So `decideUpdate` cannot tell the two sources apart - which is the whole
    // reason the fallback is safe to run unconditionally.
    const { impl } = ok({
      name: '@aragon-agent/cli',
      version: '0.6.0',
      engines: { node: '>=20' },
      deprecated: 'do not use',
      dist: { tarball: 'ignored' },
    });
    const manifest = await fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
      execFileImpl: impl,
      npmCliPath: NPM_CLI,
      env: {},
    });
    expect(manifest).toEqual({
      name: '@aragon-agent/cli',
      version: '0.6.0',
      engines: { node: '>=20' },
      deprecated: 'do not use',
    });
  });

  it('takes the LAST element when npm answers with an array', async () => {
    // We only ever send a dist-tag, which yields one object. npm is not ours,
    // so a shape we did not ask for degrades rather than failing the probe.
    const { impl } = ok([
      { name: '@aragon-agent/cli', version: '0.5.9' },
      { name: '@aragon-agent/cli', version: '0.6.0' },
    ]);
    const manifest = await fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
      execFileImpl: impl,
      npmCliPath: NPM_CLI,
      env: {},
    });
    expect(manifest?.version).toBe('0.6.0');
  });

  it('coerces a boolean `deprecated`, as the HTTP path does', async () => {
    const { impl } = ok({ name: '@aragon-agent/cli', version: '0.6.0', deprecated: true });
    const manifest = await fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
      execFileImpl: impl,
      npmCliPath: NPM_CLI,
      env: {},
    });
    expect(manifest?.deprecated).toBe('true');
  });
});

describe('AC-48: every failure is `null`, and nothing rejects', () => {
  const cases: Array<[string, ReturnType<typeof stub>['impl']]> = [
    ['a non-zero exit', stub((cb) => cb(new Error('Command failed'), '', 'npm error'))[
      'impl'
    ]],
    ['a timeout', stub((cb) => cb(Object.assign(new Error('killed'), { killed: true }), '', ''))[
      'impl'
    ]],
    ['unparseable stdout', stub((cb) => cb(null, 'not json at all', ''))['impl']],
    ['an object with no version', stub((cb) => cb(null, '{"name":"x"}', ''))['impl']],
    ['an empty array', stub((cb) => cb(null, '[]', ''))['impl']],
    ['a null document', stub((cb) => cb(null, 'null', ''))['impl']],
  ];

  for (const [label, impl] of cases) {
    it(`returns null on ${label}`, async () => {
      await expect(
        fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
          execFileImpl: impl,
          npmCliPath: NPM_CLI,
          env: {},
        }),
      ).resolves.toBeNull();
    });
  }

  it('returns null WITHOUT calling execFile when resolveNpmCli() is null', async () => {
    // A machine with no reachable `npm-cli.js` degrades to notify-only, which is
    // the honest outcome. There is deliberately no bare-`npm`-on-PATH fallback:
    // on Windows that is `npm.cmd`, which U-2 forbids.
    const { impl, calls } = ok({ name: '@aragon-agent/cli', version: '0.6.0' });
    await expect(
      fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
        execFileImpl: impl,
        npmCliPath: null,
        env: {},
      }),
    ).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('survives an execFile that throws SYNCHRONOUSLY', async () => {
    // A bad argv or a missing binary raises before the callback exists, and an
    // exception here is an unhandled rejection on a background timer.
    const impl: ExecFileImpl = () => {
      throw new Error('spawn failed');
    };
    await expect(
      fetchLatestViaNpm(REGISTRY, '@aragon-agent/cli', 'latest', {
        execFileImpl: impl,
        npmCliPath: NPM_CLI,
        env: {},
      }),
    ).resolves.toBeNull();
  });
});
