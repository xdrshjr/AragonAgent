/**
 * `performRollback` (cli-auto-update-hardening H1 / AC-36 … AC-39).
 *
 * FULLY INJECTED, and one assertion here cannot be written any other way:
 * AC-36's spawn stub READS THE STATE FILE at the moment of the spawn and finds
 * the latch already there. A test that only checks the final state passes on the
 * broken ordering, which is the whole failure this ordering exists to prevent.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = mkdtempSync(join(tmpdir(), 'aragon-rollback-'));
process.env.ARAGON_HOME = HOME;

const { performRollback } = await import('../boot/rollback.js');
const { getUpdateStatePath } = await import('../config/app-paths.js');
const { readUpdateState, updateUpdateState } = await import('../update/state.js');
const { decideUpdate } = await import('../update/semver.js');
const { UpdateService } = await import('../update/service.js');
const { DEFAULT_UPDATE_CONFIG } = await import('../config/schema.js');

const GOOD_TARGET = {
  root: join(HOME, 'lib', 'node_modules', '@aragon-agent', 'cli'),
  packageName: '@aragon-agent/cli',
  autoInstallable: true,
  writable: true,
};

function lock() {
  const adopted: number[] = [];
  let released = 0;
  return {
    handle: {
      adoptChild: (pid: number) => adopted.push(pid),
      release: () => {
        released += 1;
      },
    },
    adopted,
    get released() {
      return released;
    },
  };
}

beforeEach(() => {
  rmSync(getUpdateStatePath(), { force: true });
});

describe('AC-36: the latch is written BEFORE the spawn', () => {
  it('the installer already sees `skippedVersion` when it runs', async () => {
    // THE ORDER IS THE INVARIANT (C-17 / D-28). If the process dies between the
    // latch and the spawn, the machine is left running a broken version that
    // will not be reinstalled - recoverable. In the other order, a death between
    // the spawn and the latch leaves a good version installed with NO LATCH, and
    // the next check reinstalls the bad one.
    const seenAtSpawn: ReturnType<typeof readUpdateState>[] = [];
    const l = lock();
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => l.handle,
      install: async () => {
        // Read from DISK, not from a closure: this is the assertion.
        seenAtSpawn.push(readUpdateState());
        return { ok: true };
      },
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(seenAtSpawn).toHaveLength(1);
    const state = seenAtSpawn[0] as ReturnType<typeof readUpdateState>;
    expect(state.skippedVersion).toBe('0.6.0');
    expect(state.rolledBackFrom).toBe('0.6.0');
    expect(state.autoInstalledVersion).toBe('');
    expect(state.bootFailures).toBe(0);
    expect(state.pendingRestartVersion).toBe('');
  });

  it('installs the GOOD version into the classified root, reusing runNpmInstall', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const l = lock();
    await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => l.handle,
      install: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        // Phase two of U-4: the lock names the CHILD once the child exists.
        input.onSpawn?.(4242);
        return { ok: true };
      },
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      packageName: '@aragon-agent/cli',
      version: '0.5.9',
      root: GOOD_TARGET.root,
    });
    expect(l.adopted).toEqual([4242]);
    expect(l.released).toBe(1);
  });
});

describe('AC-37: the latch survives a version that knows nothing about the new fields', () => {
  it('an OLDER CLI still decides `none` for the bad version', async () => {
    // C-17 made concrete. `readUpdateState` rebuilds from a fixed field list, so
    // a pre-H1 `aragon` erases `autoInstalledVersion`, `lastGoodVersion`,
    // `bootFailures` and `rolledBackFrom` on its next write. `skippedVersion` is
    // schema-1 and every shipped version honours it - so it is the ONLY channel
    // that reaches the version we just rolled back to.
    await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => lock().handle,
      install: async () => ({ ok: true }),
      log: () => {},
    });

    // Simulate the old CLI: it reads, then writes back only the fields it knows.
    const seen = readUpdateState();
    rmSync(getUpdateStatePath(), { force: true });
    updateUpdateState({
      lastCheckAt: seen.lastCheckAt,
      lastKnownVersion: seen.lastKnownVersion,
      pendingRestartVersion: seen.pendingRestartVersion,
      skippedVersion: seen.skippedVersion,
      consecutiveFailures: seen.consecutiveFailures,
      lastFailureAt: seen.lastFailureAt,
    });

    const decision = decideUpdate({
      local: '0.5.9',
      manifest: { version: '0.6.0' },
      nodeVersion: '20.11.1',
      skippedVersion: readUpdateState().skippedVersion,
    });
    expect(decision.action).toBe('none');
    expect(decision.reason).toBe('skipped');
  });

  it('and a real service running the older version does not reinstall it', async () => {
    // The same claim one level up: not "the decision function says none" but
    // "the state machine reaches `idle` and spawns nothing".
    await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => lock().handle,
      install: async () => ({ ok: true }),
      log: () => {},
    });
    const spawns: unknown[] = [];
    const service = new UpdateService({
      config: { ...DEFAULT_UPDATE_CONFIG, mode: 'auto' },
      currentVersion: '0.5.9',
      now: () => 1_900_000_000_000,
      nodeVersion: '20.11.1',
      packageRoot: GOOD_TARGET.root,
      packageName: '@aragon-agent/cli',
      source: 'npm-global',
      env: {},
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
      },
      setTimeoutImpl: () => ({ unref: () => {} }),
      clearTimeoutImpl: () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ name: '@aragon-agent/cli', version: '0.6.0' }), {
          status: 200,
        })) as never,
      install: {
        npmCliPath: join(HOME, 'fake-npm-cli.js'),
        spawnImpl: (...args: unknown[]) => {
          spawns.push(args);
          throw new Error('a rollback must never reinstall the version it escaped');
        },
      },
    });
    const snapshot = await service.checkNow({ force: true });
    service.dispose();
    expect(spawns).toEqual([]);
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.reason).toBe('skipped');
  });
});

describe('AC-38 / AC-39: the refusals', () => {
  it('AC-38: a contended lock returns WITHOUT spawning', async () => {
    // Someone else is installing or already rolling back, and two concurrent
    // `npm i -g` on one prefix is the one thing the lock exists to stop.
    const installs: unknown[] = [];
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => null,
      install: async (input) => {
        installs.push(input);
        return { ok: true };
      },
      log: () => {},
    });
    expect(installs).toEqual([]);
    expect(result).toEqual({ ok: false, failure: 'locked' });
    // The latch still happened, and that is correct: it is written first
    // precisely so a rollback that cannot run still stops the reinstall loop.
    expect(readUpdateState().skippedVersion).toBe('0.6.0');
  });

  it('AC-39: a source that no longer classifies as npm-global refuses', async () => {
    // The machine may have changed since the install; we do not run `npm i -g`
    // on a tree we would not have installed into.
    const installs: unknown[] = [];
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => ({ ...GOOD_TARGET, autoInstallable: false }),
      acquireLock: () => lock().handle,
      install: async (input) => {
        installs.push(input);
        return { ok: true };
      },
      log: () => {},
    });
    expect(installs).toEqual([]);
    expect(result).toEqual({ ok: false, failure: 'source-ineligible' });
  });

  it('AC-39: an unwritable root refuses too', async () => {
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => ({ ...GOOD_TARGET, writable: false }),
      acquireLock: () => lock().handle,
      install: async () => ({ ok: true }),
      log: () => {},
    });
    expect(result).toEqual({ ok: false, failure: 'not-writable' });
  });

  it('a root we cannot identify refuses rather than guessing a package name', async () => {
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => ({ ...GOOD_TARGET, root: null, packageName: '' }),
      acquireLock: () => lock().handle,
      install: async () => ({ ok: true }),
      log: () => {},
    });
    expect(result).toEqual({ ok: false, failure: 'no-package-root' });
  });
});

describe('logging and the never-throws contract', () => {
  it('records `update_rolled_back` with the count taken BEFORE the latch zeroed it', () => {
    // `bootFailures` is reset by step 1, so a record built afterwards would
    // always say `0` - and the count is the only number that explains WHY the
    // machine was downgraded.
    updateUpdateState({ bootFailures: 2 });
    const records: Array<{ msg: string; data: Record<string, unknown> }> = [];
    return performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => lock().handle,
      install: async () => ({ ok: true }),
      log: (_level, msg, data) => records.push({ msg, data }),
    }).then(() => {
      expect(records).toEqual([
        { msg: 'update_rolled_back', data: { from: '0.6.0', to: '0.5.9', failures: 2 } },
      ]);
    });
  });

  it('records `update_rollback_failed` when npm exits non-zero, and releases the lock', async () => {
    const l = lock();
    const records: string[] = [];
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => l.handle,
      install: async () => ({ ok: false, failure: 'exit', exitCode: 1 }),
      log: (_level, msg) => records.push(msg),
    });
    expect(result).toEqual({ ok: false, failure: 'install-failed' });
    expect(records).toEqual(['update_rollback_failed']);
    expect(l.released).toBe(1);
  });

  it('never rejects, and releases the lock, when the installer THROWS', async () => {
    // The guard invokes this without `await` and cannot handle a rejection; an
    // unhandled one would print a stack over whatever the CLI is doing.
    const l = lock();
    const result = await performRollback('0.6.0', '0.5.9', {
      resolveTarget: async () => GOOD_TARGET,
      acquireLock: () => l.handle,
      install: async () => {
        throw new Error('module not found');
      },
      log: () => {},
    });
    expect(result).toEqual({ ok: false, failure: 'error' });
    expect(l.released).toBe(1);
  });

  it('never rejects when the whole resolution step throws', async () => {
    await expect(
      performRollback('0.6.0', '0.5.9', {
        resolveTarget: async () => {
          throw new Error('install-source is part of the broken build');
        },
        log: () => {},
      }),
    ).resolves.toEqual({ ok: false, failure: 'error' });
  });
});
