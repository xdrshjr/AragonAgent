/**
 * `UpdateService` — transitions, throttle, backoff, the lock, and the two
 * failure paths v1 could not observe (cli-auto-update §3.5-§3.9 / §8.1).
 *
 * FULLY OFFLINE AND FULLY DETERMINISTIC: an injected `fetchImpl`, an injected
 * `spawnImpl`, an injected clock and an injected `setTimeout` that CAPTURES
 * rather than fires. Nothing here opens a socket, spawns npm, or waits on real
 * time — which is what lets AC-27 assert that a contended lock returns without
 * sleeping, a claim a test against real time could only approximate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = mkdtempSync(join(tmpdir(), 'aragon-update-service-'));
process.env.ARAGON_HOME = HOME;

const { UpdateService } = await import('../update/service.js');
const { UPDATE_LIMITS } = await import('../update/limits.js');
const { tryAcquireInstallLock } = await import('../update/install-lock.js');
const { DEFAULT_UPDATE_CONFIG } = await import('../config/schema.js');
const { getUpdateStatePath, getUpdateLockPath } = await import('../config/app-paths.js');
const { readUpdateState, updateUpdateState } = await import('../update/state.js');
const { shouldRenderUpdateLine } = await import('../update/types.js');

type SpawnCall = { file: string; args: string[]; options: Record<string, unknown> };

/** A package root that really exists, so `probeWritable` answers honestly. */
const PKG_ROOT = join(HOME, 'lib', 'node_modules', '@aragon-agent', 'cli');
mkdirSync(PKG_ROOT, { recursive: true });

const LOG_PATH = join(HOME, 'test-install.log');

let clock = 1_700_000_000_000;
const now = () => clock;

interface Harness {
  service: InstanceType<typeof UpdateService>;
  timers: { fn: () => void; ms: number }[];
  cleared: number;
  spawns: SpawnCall[];
  /** Every `npm view` the H3 fallback attempted. Empty on a healthy machine. */
  views: { args: string[]; options: Record<string, unknown> }[];
  killed: number;
  records: { level: string; msg: string; data?: Record<string, unknown> }[];
  fire(): void;
}

interface HarnessOptions {
  remote?: string | null;
  engines?: string;
  deprecated?: string;
  mode?: 'auto' | 'notify' | 'off';
  source?: 'npm-global' | 'npm-local' | 'pnpm' | 'npx' | 'dev-monorepo' | 'unknown';
  exitCode?: number;
  spawnThrows?: boolean;
  /** What `<root>/package.json` reports AFTER the install — U-6's input. */
  observedAfterInstall?: string;
  stderr?: string;
  local?: string;
  /**
   * What the H3 fallback probe answers, when it is reachable at all.
   *
   * `undefined` means "this machine has no `npm-cli.js`", which is the DEFAULT
   * and is deliberate: `npmCliPath` must never be left to `resolveNpmCli()` in a
   * test, or a developer machine with npm installed would really spawn it.
   */
  npmViewVersion?: string;
}

function harness(opts: HarnessOptions = {}): Harness {
  const timers: { fn: () => void; ms: number }[] = [];
  const spawns: SpawnCall[] = [];
  const views: Harness['views'] = [];
  const records: Harness['records'] = [];
  let cleared = 0;
  let killed = 0;
  const target = opts.remote === undefined ? '0.6.0' : opts.remote;

  const service = new UpdateService({
    config: { ...DEFAULT_UPDATE_CONFIG, mode: opts.mode ?? 'auto' },
    currentVersion: opts.local ?? '0.5.9',
    now,
    nodeVersion: '20.11.1',
    packageRoot: PKG_ROOT,
    packageName: '@aragon-agent/cli',
    source: opts.source ?? 'npm-global',
    random: () => 0.5, // zero jitter, so `nextCheckAt` is exactly the interval
    env: {},
    logger: {
      error: (msg, data) => records.push({ level: 'error', msg, data }),
      warn: (msg, data) => records.push({ level: 'warn', msg, data }),
      info: (msg, data) => records.push({ level: 'info', msg, data }),
      debug: (msg, data) => records.push({ level: 'debug', msg, data }),
      trace: (msg, data) => records.push({ level: 'trace', msg, data }),
    },
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, ms });
      return { unref: () => {} };
    },
    clearTimeoutImpl: () => {
      cleared += 1;
    },
    fetchImpl: (async () =>
      target === null
        ? new Response('boom', { status: 500 })
        : new Response(
            JSON.stringify({
              name: '@aragon-agent/cli',
              version: target,
              ...(opts.engines ? { engines: { node: opts.engines } } : {}),
              ...(opts.deprecated ? { deprecated: opts.deprecated } : {}),
            }),
            { status: 200 },
          )) as never,
    // H3's fallback probe. `npmCliPath: null` unless a test asks for an answer,
    // so the DEFAULT is "this machine cannot run npm view" and no test can
    // accidentally spawn the developer's real npm.
    npmView: {
      npmCliPath: opts.npmViewVersion === undefined ? null : join(HOME, 'fake-npm-cli.js'),
      execFileImpl: (_file, args, options, callback) => {
        views.push({ args, options: options as unknown as Record<string, unknown> });
        callback(
          null,
          JSON.stringify({ name: '@aragon-agent/cli', version: opts.npmViewVersion }),
          '',
        );
        return undefined;
      },
    },
    install: {
      npmCliPath: join(HOME, 'fake-npm-cli.js'),
      logPath: LOG_PATH,
      // U-6's re-read, injected: the default reads `<root>/package.json`, and
      // the whole point of the invariant is what happens when that DISAGREES
      // with npm's exit code.
      readVersionAt: () => opts.observedAfterInstall ?? target,
      spawnImpl: (file, args, options) => {
        spawns.push({ file, args, options: options as unknown as Record<string, unknown> });
        if (opts.spawnThrows) throw new Error('EACCES');
        const handlers = new Map<string, (arg: never) => void>();
        queueMicrotask(() => {
          if (opts.stderr) writeFileSync(LOG_PATH, opts.stderr);
          handlers.get('exit')?.((opts.exitCode ?? 0) as never);
        });
        return {
          pid: 4242,
          on(event: string, fn: (arg: never) => void) {
            handlers.set(event, fn);
            return this;
          },
          unref: () => {},
          // NOT part of the interface the installer uses; present only so the
          // AC-23 assertion below can prove nothing ever calls it (U-3).
          kill: () => {
            killed += 1;
          },
        } as never;
      },
    },
  });

  return {
    service,
    timers,
    get cleared() {
      return cleared;
    },
    spawns,
    views,
    get killed() {
      return killed;
    },
    records,
    fire() {
      const next = timers.pop();
      next?.fn();
    },
  };
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  rmSync(getUpdateStatePath(), { force: true });
  rmSync(getUpdateLockPath(), { force: true });
  rmSync(LOG_PATH, { force: true });
  writeFileSync(join(PKG_ROOT, 'package.json'), JSON.stringify({ name: 'x', version: '0.5.9' }));
});

afterEach(() => {
  rmSync(getUpdateStatePath(), { force: true });
  rmSync(getUpdateLockPath(), { force: true });
  rmSync(LOG_PATH, { force: true });
});

describe('the happy path (§3.9)', () => {
  it('checks, installs, verifies, and lands on `ready`', async () => {
    const h = harness();
    const snapshot = await h.service.checkNow({ force: true });

    expect(snapshot.phase).toBe('ready');
    expect(snapshot.latestVersion).toBe('0.6.0');
    // The new version is on disk and takes effect on the NEXT launch; the
    // running process is never mutated in a way it can observe (D-3).
    expect(readUpdateState().pendingRestartVersion).toBe('0.6.0');
    expect(h.spawns).toHaveLength(1);
  });

  it('clears `pendingRestartVersion` on the launch that is finally running it', () => {
    updateUpdateState({ pendingRestartVersion: '0.6.0' });
    const h = harness({ local: '0.6.0' });
    h.service.start();
    expect(readUpdateState().pendingRestartVersion).toBe('');
    expect(h.records.some((r) => r.msg === 'update_applied')).toBe(true);
  });

  it('leaves a pending version alone when it is NOT the one running', () => {
    // Installed 0.6.0, then the user launched an older binary from elsewhere:
    // clearing here would lose the fact that a restart is still owed.
    updateUpdateState({ pendingRestartVersion: '0.6.0' });
    harness({ local: '0.5.9' }).service.start();
    expect(readUpdateState().pendingRestartVersion).toBe('0.6.0');
  });
});

describe('the gates that stop an install (§3.4 / §3.2)', () => {
  it('says nothing at all when the registry is not ahead of us', async () => {
    const h = harness({ remote: '0.5.9' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.reason).toBe('up-to-date');
    expect(h.spawns).toHaveLength(0);
  });

  it('mode `notify` REPORTS a newer version and never spawns (AC-8)', async () => {
    const h = harness({ mode: 'notify' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('available');
    expect(snapshot.advice).toBe('npm i -g @aragon-agent/cli');
    expect(h.spawns).toHaveLength(0);
  });

  it('an ineligible manager gets ITS command and no npm (AC-8)', async () => {
    const h = harness({ source: 'pnpm' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('available');
    expect(snapshot.reason).toBe('source-ineligible');
    expect(snapshot.advice).toBe('pnpm add -g @aragon-agent/cli');
    expect(h.spawns).toHaveLength(0);
  });

  it('a dev checkout and an npx run render NOTHING (AC-6 / AC-7)', async () => {
    for (const source of ['dev-monorepo', 'npx'] as const) {
      const h = harness({ source });
      const snapshot = await h.service.checkNow({ force: true });
      // `idle` is what `shouldRenderUpdateLine` answers `false` for: a
      // developer's clone is not out of date, it is checked out.
      expect(snapshot.phase, source).toBe('idle');
      expect(h.spawns, source).toHaveLength(0);
    }
  });

  it('a project-local install renders nothing either (§3.2 / manual row 10)', async () => {
    // The third silent source, and the one that is easy to miss because it is
    // not in AC-6/AC-7's pair. `adviceFor('npm-local')` is `undefined` BY
    // DESIGN - a project manifest pins our version, so there is no command we
    // could honestly print - which means reporting it puts `0.6.0 available` on
    // the row with nothing after it, every session, in every project that
    // depends on this package. An unactionable persistent notice is exactly the
    // fatigue D-7 and R-8 exist to prevent.
    const h = harness({ source: 'npm-local' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('idle');
    expect(shouldRenderUpdateLine(snapshot)).toBe(false);
    expect(h.spawns).toHaveLength(0);
  });

  it('a manifest this Node cannot run NOTIFIES with both numbers (AC-12)', async () => {
    const h = harness({ engines: '>=22' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('available');
    expect(snapshot.reason).toBe('node-too-old');
    // Both, or neither: "needs a newer Node" without saying which is a notice
    // the user cannot act on.
    expect(snapshot.requiredNode).toBe('>=22');
    expect(snapshot.runningNode).toBe('20.11.1');
    expect(h.spawns).toHaveLength(0);
  });

  it('AC-9: a non-writable npm-global root downgrades to notify, before any spawn', async () => {
    // The ordinary Linux case: the global root belongs to root and the user has
    // no sudo (R-2). Probing BEFORE the spawn is what turns a confusing EACCES
    // buried in npm's output into a one-line notice - and we never suggest
    // `sudo`, only the command.
    const service = new UpdateService({
      config: { ...DEFAULT_UPDATE_CONFIG },
      currentVersion: '0.5.9',
      now,
      nodeVersion: '20.11.1',
      // A path whose PARENT does not exist, so `accessSync(dirname(root), W_OK)`
      // fails exactly as it does on a root-owned directory.
      packageRoot: join(HOME, 'no-such-parent', 'cli'),
      packageName: '@aragon-agent/cli',
      source: 'npm-global',
      random: () => 0.5,
      env: {},
      setTimeoutImpl: () => ({ unref: () => {} }),
      clearTimeoutImpl: () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ name: '@aragon-agent/cli', version: '0.6.0' }), {
          status: 200,
        })) as never,
      install: {
        spawnImpl: () => {
          throw new Error('must never spawn on an unwritable root');
        },
      },
    });
    const snapshot = await service.checkNow({ force: true });
    expect(snapshot.phase).toBe('available');
    expect(snapshot.reason).toBe('not-writable');
    expect(snapshot.advice).toBe('npm i -g @aragon-agent/cli');
    service.dispose();
  });

  it('a deprecated release is never auto-installed (AC-11)', async () => {
    const h = harness({ deprecated: 'use 0.7' });
    expect((await h.service.checkNow({ force: true })).phase).toBe('idle');
    expect(h.spawns).toHaveLength(0);
  });
});

describe('the throttle and the backoff (§3.7 / AC-15 / AC-16)', () => {
  it('a scheduled check inside the interval asks the registry NOTHING', async () => {
    updateUpdateState({ lastCheckAt: clock - 1000 });
    const h = harness();
    // Ten terminals opened at once produce ONE registry request, not ten.
    const snapshot = await h.service.checkNow();
    expect(snapshot.phase).toBe('idle');
    expect(h.spawns).toHaveLength(0);
  });

  it('`force` bypasses it — that is what /update now is for', async () => {
    updateUpdateState({ lastCheckAt: clock - 1000 });
    const h = harness();
    expect((await h.service.checkNow({ force: true })).phase).toBe('ready');
  });

  it('grows the backoff geometrically and caps it', async () => {
    const h = harness({ remote: null });
    for (let i = 1; i <= 3; i += 1) {
      clock += UPDATE_LIMITS.backoffMaxMs; // always past the previous backoff
      await h.service.checkNow({ force: true });
      expect(readUpdateState().consecutiveFailures, `failure ${i}`).toBe(i);
    }
    const armed = h.timers[h.timers.length - 1];
    expect(armed?.ms).toBe(
      Math.min(UPDATE_LIMITS.backoffMaxMs, UPDATE_LIMITS.backoffBaseMs * 2 ** 2),
    );
  });

  it('ONE success resets the counter', async () => {
    updateUpdateState({ consecutiveFailures: 2, lastFailureAt: 0 });
    const h = harness();
    await h.service.checkNow({ force: true });
    expect(readUpdateState().consecutiveFailures).toBe(0);
  });

  it('stays SILENT below the notice threshold, then speaks (D-7 / R-8)', async () => {
    const h = harness({ remote: null });
    for (let i = 1; i <= UPDATE_LIMITS.failuresBeforeNotice; i += 1) {
      clock += UPDATE_LIMITS.backoffMaxMs;
      const snapshot = await h.service.checkNow({ force: true });
      expect(snapshot.phase).toBe('failed');
      expect(shouldRenderUpdateLine(snapshot), `after ${i} failures`).toBe(
        i >= UPDATE_LIMITS.failuresBeforeNotice,
      );
    }
  });

  it('and what it says is ACTIONABLE - the failed row carries the command', async () => {
    // §1.2 promises the one visible failure is "muted and actionable", and §6.2
    // spells the row `<warn> update failed <dot> npm i -g @aragon-agent/cli`.
    // `UpdateLine` renders that clause only when the snapshot carries `advice`,
    // and it falls back to a bare "update failed" when it does not - so a
    // service that never supplies one leaves the single exception to silence
    // naming no way out, with the renderer's own test still green because its
    // fixture supplies the field the service never sets.
    const h = harness({ remote: null });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.advice).toBe('npm i -g @aragon-agent/cli');
  });

  it('an install failure carries it too, and a silent source still carries none', async () => {
    const failed = await harness({ exitCode: 1 }).service.checkNow({ force: true });
    expect(failed.reason).toBe('install-failed');
    expect(failed.advice).toBe('npm i -g @aragon-agent/cli');
    // `adviceFor` has nothing honest to offer a checkout, and inventing one
    // would send a developer to overwrite their own clone with a release.
    const dev = await harness({ source: 'dev-monorepo', remote: null }).service.checkNow({
      force: true,
    });
    expect(dev.advice).toBeUndefined();
  });
});

describe('the lock (§3.7 / U-4 / U-5b)', () => {
  it('AC-14: a held lock means this process installs NOTHING', async () => {
    const held = tryAcquireInstallLock({ now });
    expect(held).not.toBeNull();
    try {
      const h = harness();
      const snapshot = await h.service.checkNow({ force: true });
      // NOT AN ERROR: another process is already doing the work.
      expect(snapshot.phase).toBe('idle');
      expect(snapshot.reason).toBe('locked');
      expect(h.spawns).toHaveLength(0);
    } finally {
      held?.release();
    }
  });

  it('AC-27: acquiring a HELD lock returns null WITHOUT SLEEPING', () => {
    // A test that merely asserted the return value would pass against
    // `skills/lock.ts`'s five-second synchronous busy-wait, which from a
    // background timer is a frozen Ink render loop. The clock assertion is the
    // point: `now` never advances, and real wall-clock time barely does.
    const held = tryAcquireInstallLock({ now });
    try {
      const before = clock;
      const wallBefore = Date.now();
      const second = tryAcquireInstallLock({ now, isProcessAlive: () => true });
      expect(second).toBeNull();
      expect(clock).toBe(before);
      expect(Date.now() - wallBefore).toBeLessThan(500);
    } finally {
      held?.release();
    }
  });

  it('AC-28: the two-phase write names the CHILD, keeping uuid and startedAt', () => {
    // U-4's ordering constraint made concrete. The lock must be held BEFORE the
    // spawn (or the race it exists to close is wide open), but `child.pid` does
    // not exist UNTIL AFTER it - so the `wx` write carries the parent's pid and
    // `adoptChild` rewrites it. `uuid` is what `release()` matches on and
    // `startedAt` is what the TTL measures, so replacing either here would
    // silently break one of the two recovery paths.
    const handle = tryAcquireInstallLock({ now });
    const atCreate = JSON.parse(readFileSync(getUpdateLockPath(), 'utf-8')) as {
      pid: number;
      uuid: string;
      startedAt: number;
      host: string;
    };
    expect(atCreate.pid).toBe(process.pid);

    handle?.adoptChild(4242);
    const afterSpawn = JSON.parse(readFileSync(getUpdateLockPath(), 'utf-8')) as typeof atCreate;
    expect(afterSpawn.pid).toBe(4242);
    expect(afterSpawn.uuid).toBe(atCreate.uuid);
    expect(afterSpawn.startedAt).toBe(atCreate.startedAt);
    expect(afterSpawn.host).toBe(atCreate.host);

    // And the uuid still matches, so our own release still works.
    handle?.release();
    expect(() => readFileSync(getUpdateLockPath(), 'utf-8')).toThrow();
  });

  it('the service takes and RELEASES the lock around one install', async () => {
    const h = harness();
    await h.service.checkNow({ force: true });
    expect(h.spawns).toHaveLength(1);
    // Released on the child's exit, so the next process is not stuck behind a
    // ten-minute TTL for an install that already finished.
    expect(() => readFileSync(getUpdateLockPath(), 'utf-8')).toThrow();
  });

  it('a lock naming a DEAD process is reclaimed', () => {
    const held = tryAcquireInstallLock({ now });
    held?.adoptChild(999_999);
    const second = tryAcquireInstallLock({ now, isProcessAlive: () => false });
    // The exact case a crash between the `wx` write and the spawn leaves behind,
    // and the reason U-4's two-phase write is safe rather than merely narrow.
    expect(second).not.toBeNull();
    second?.release();
  });

  it('release() only removes OUR lock (the classic file-lock bug)', () => {
    const first = tryAcquireInstallLock({ now });
    // Simulate being preempted: someone judged us stale and took the file.
    rmSync(getUpdateLockPath(), { force: true });
    const second = tryAcquireInstallLock({ now });
    first?.release(); // must NOT delete the successor's lock
    expect(() => readFileSync(getUpdateLockPath(), 'utf-8')).not.toThrow();
    second?.release();
  });
});

describe('the install child (§3.5 / U-2 / U-5 / U-6)', () => {
  it('AC-30: spawns node with npm-cli.js, detached, no shell, to a FILE', async () => {
    const h = harness();
    await h.service.checkNow({ force: true });
    const call = h.spawns[0];
    expect(call?.file).toBe(process.execPath);
    expect(call?.args[0]).toBe(join(HOME, 'fake-npm-cli.js'));
    expect(call?.args).toContain('--global');
    expect(call?.args).toContain('@aragon-agent/cli@0.6.0');
    expect(call?.options.detached).toBe(true);
    // C-7: never a shell, on an argv built from a manifest and a registry answer.
    expect(call?.options.shell).toBe(false);
    // U-5: a real fd, not `'ignore'` (no diagnostic) and not a pipe (EPIPE once
    // the parent exits, which breaks D-10).
    const stdio = call?.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[1]).toBe(stdio[2]);
    // P1-5: `installTimeoutMs` bounds the UI phase and the lock, NEVER the child.
    // With `spawn` there is no `timeout` option at all, which makes that
    // structural rather than a field someone must remember to leave at 0.
    expect(call?.options.timeout).toBeUndefined();
    expect(call?.options.killSignal).toBeUndefined();
  });

  it('logs a bounded, non-empty stderr tail on a non-zero exit', async () => {
    const noise = 'npm ERR! '.repeat(200);
    const h = harness({ exitCode: 1, stderr: noise });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.reason).toBe('install-failed');
    const record = h.records.find((r) => r.msg === 'update_install_failed');
    const tail = record?.data?.stderrTail as string;
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(UPDATE_LIMITS.stderrTailChars);
  });

  it('treats a spawn failure as an ordinary, silent, counted failure', async () => {
    const h = harness({ spawnThrows: true });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('failed');
    expect(readUpdateState().consecutiveFailures).toBe(1);
  });

  it('AC-26: npm exits 0 into ANOTHER prefix -> ineffective, latched, no retry', async () => {
    // R-12, the worst failure shape available to a feature that promised to be
    // invisible: without the latch this reinstalls once per interval, forever,
    // and nothing anywhere says so.
    const h = harness({ observedAfterInstall: '0.5.9' });
    const snapshot = await h.service.checkNow({ force: true });

    expect(snapshot.phase).toBe('available');
    expect(snapshot.reason).toBe('install-ineffective');
    // The pending marker is NOT set, so the next launch does not think it is
    // owed a restart it will never get.
    expect(readUpdateState().pendingRestartVersion).toBe('');
    expect(readUpdateState().skippedVersion).toBe('0.6.0');

    // The whole point: a SECOND check on the same version decides `none`.
    const again = harness({ observedAfterInstall: '0.5.9' });
    const second = await again.service.checkNow({ force: true });
    expect(second.reason).toBe('skipped');
    expect(again.spawns).toHaveLength(0);
  });

  it('a NEWER release still gets through the latch', async () => {
    updateUpdateState({ skippedVersion: '0.6.0' });
    const h = harness({ remote: '0.6.1' });
    expect((await h.service.checkNow({ force: true })).phase).toBe('ready');
  });
});

describe('lifecycle', () => {
  it('start() is idempotent and arms exactly one timer', () => {
    const h = harness();
    h.service.start();
    h.service.start();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.ms).toBe(UPDATE_LIMITS.startupDelayMs);
  });

  it('AC-23: dispose() clears the timer and NEVER signals the child (U-3)', async () => {
    const h = harness();
    h.service.start();
    h.service.dispose();
    expect(h.cleared).toBeGreaterThan(0);
    // Killing a running `npm install -g` is the one action here that can leave
    // the user's global installation broken - and `dispose()` is called by the
    // most ordinary event there is, Ctrl+C.
    expect(h.killed).toBe(0);
  });

  it('dispose() is idempotent and makes later checks inert', async () => {
    const h = harness();
    h.service.dispose();
    h.service.dispose();
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('idle');
    expect(h.spawns).toHaveLength(0);
  });

  it('is SINGLE-FLIGHT: two overlapping checks make one registry request', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.service.checkNow({ force: true }),
      h.service.checkNow({ force: true }),
    ]);
    expect(a).toBe(b);
    expect(h.spawns).toHaveLength(1);
  });

  it('AC-21: skip() persists the version and empties the row', async () => {
    const h = harness({ mode: 'notify' });
    await h.service.checkNow({ force: true });
    h.service.skip('0.6.0');
    expect(readUpdateState().skippedVersion).toBe('0.6.0');
    const { shouldRenderUpdateLine } = await import('../update/types.js');
    expect(shouldRenderUpdateLine(h.service.snapshot())).toBe(false);
  });

  it('notifies subscribers with a NEW snapshot object on every transition', async () => {
    const h = harness();
    const seen: string[] = [];
    const unsubscribe = h.service.subscribe((s) => seen.push(s.phase));
    await h.service.checkNow({ force: true });
    expect(seen).toContain('checking');
    expect(seen).toContain('installing');
    expect(seen).toContain('ready');
    unsubscribe();
    const before = seen.length;
    h.service.skip('0.6.0');
    expect(seen).toHaveLength(before);
  });

  it('a throwing subscriber cannot break the state machine', async () => {
    const h = harness();
    h.service.subscribe(() => {
      throw new Error('renderer bug');
    });
    await expect(h.service.checkNow({ force: true })).resolves.toMatchObject({ phase: 'ready' });
  });
});

describe('the logged record set (§3.10)', () => {
  it('writes the check and install records under one scope', async () => {
    const h = harness();
    await h.service.checkNow({ force: true });
    const messages = h.records.map((r) => r.msg);
    expect(messages).toContain('update_check_start');
    expect(messages).toContain('update_check_result');
    expect(messages).toContain('update_install_start');
    expect(messages).toContain('update_install_done');
  });

  it('records `update_install_ineffective` with both versions (U-6)', async () => {
    const h = harness({ observedAfterInstall: '0.5.9' });
    await h.service.checkNow({ force: true });
    const record = h.records.find((r) => r.msg === 'update_install_ineffective');
    expect(record?.data?.target).toBe('0.6.0');
    expect(record?.data?.observed).toBe('0.5.9');
  });
});

// ---------------------------------------------------------------------------
// The hardening round (cli-auto-update-hardening)
// ---------------------------------------------------------------------------

describe('AC-42 / AC-42b: the guard is armed by an AUTO install only', () => {
  it('AC-42: a successful automatic install writes all THREE guard fields', async () => {
    const h = await harness().service.checkNow({ force: true }).then(() => readUpdateState());
    expect(h.autoInstalledVersion).toBe('0.6.0');
    // The version DOING the installing, which is the strongest available
    // evidence of "this one works": it is executing.
    expect(h.lastGoodVersion).toBe('0.5.9');
    expect(h.bootFailures).toBe(0);
  });

  it('AC-42: `installNow()` (the `--to` path) writes NONE of them (D-32)', async () => {
    // A user who explicitly asked for version X has made a decision, and an
    // updater that silently reverses it is not ours to be.
    const h = harness();
    await h.service.installNow('0.6.0');
    const state = readUpdateState();
    expect(h.spawns).toHaveLength(1);
    expect(state.pendingRestartVersion).toBe('0.6.0');
    expect(state.autoInstalledVersion).toBe('');
    expect(state.lastGoodVersion).toBe('');
    expect(state.bootFailures).toBe(0);
  });

  it('AC-42: `installNow` does not disturb a counter left by an earlier cycle', () => {
    updateUpdateState({ bootFailures: 1, autoInstalledVersion: '0.4.0' });
    return harness()
      .service.installNow('0.6.0')
      .then(() => {
        const state = readUpdateState();
        expect(state.bootFailures).toBe(1);
        expect(state.autoInstalledVersion).toBe('0.4.0');
      });
  });

  it('AC-42b: a counter STRANDED by a manual downgrade cannot roll back the next release', async () => {
    // P0-2, asserted directly and reachable without anything exotic. 0.6.0
    // auto-installs and arms, crashes twice (`bootFailures: 2`), and the user
    // gives up and runs `npm i -g @aragon-agent/cli@0.5.9` by hand rather than
    // launching a third time. The guard now takes its fast path FOREVER -
    // `autoInstalledVersion` is 0.6.0, the running version is 0.5.9 - so nothing
    // ever clears the counter.
    updateUpdateState({ bootFailures: 2, autoInstalledVersion: '0.6.0', lastGoodVersion: '0.5.9' });

    // Weeks later, 0.7.0 - a perfectly good release - auto-installs and arms.
    const h = harness({ remote: '0.7.0' });
    expect((await h.service.checkNow({ force: true })).phase).toBe('ready');
    expect(readUpdateState().autoInstalledVersion).toBe('0.7.0');

    // Its VERY FIRST launch. Without the `bootFailures: 0` in the arming write
    // this already satisfies `bootFailures >= crashesBeforeRollback`, so the
    // guard rolls a working version back and latches it into `skippedVersion` -
    // never offering it again. Silent, destructive, and the exact inverse of
    // what H1 is for.
    const { runBootGuard } = await import('../boot/guard.js');
    const rollbacks: Array<[string, string]> = [];
    runBootGuard({ version: '0.7.0', rollback: (bad, good) => rollbacks.push([bad, good]) });

    expect(readUpdateState().bootFailures).toBe(0);
    expect(rollbacks).toEqual([]);
    expect(readUpdateState().skippedVersion).toBe('');
  });
});

describe('AC-54: the rollback notice is consumed ONCE, by start()', () => {
  it('lands on the snapshot and is cleared from the file in the same call', () => {
    updateUpdateState({ rolledBackFrom: '0.6.0' });
    const h = harness();
    h.service.start();
    const snapshot = h.service.snapshot();
    expect(snapshot.rolledBackFrom).toBe('0.6.0');
    // DERIVED, not stored: we ARE the target of the rollback that wrote it, so
    // the "both or neither" rule holds by construction rather than by discipline.
    expect(snapshot.rolledBackTo).toBe('0.5.9');
    expect(readUpdateState().rolledBackFrom).toBe('');
    expect(h.records.some((r) => r.msg === 'update_rollback_notice')).toBe(true);
  });

  it('a SECOND service afterwards reports no rollback (D-38, one session)', () => {
    updateUpdateState({ rolledBackFrom: '0.6.0' });
    harness().service.start();
    const second = harness();
    second.service.start();
    expect(second.service.snapshot().rolledBackFrom).toBeUndefined();
    // Asserted on the MECHANISM rather than on the row: a permanent notice is
    // the fatigue D-7 exists to prevent, and showing it zero times would leave
    // the user with a silently downgraded CLI they do not know about.
    expect(shouldRenderUpdateLine(second.service.snapshot())).toBe(false);
  });

  it('a launch that constructs NO service does not burn the notice', () => {
    // `update.mode: 'off'`, a non-TTY and CI all skip construction entirely
    // (cli.tsx's four-conjunct gate), so the notice survives to the first
    // session that could actually have shown it (D-40).
    updateUpdateState({ rolledBackFrom: '0.6.0' });
    expect(readUpdateState().rolledBackFrom).toBe('0.6.0');
    const later = harness();
    later.service.start();
    expect(later.service.snapshot().rolledBackFrom).toBe('0.6.0');
  });

  it('picks up `lastGoodVersion` for `/update status`, without consuming it', () => {
    // The only place a user can learn what `aragon update --rollback` would do
    // BEFORE running it (§6.3).
    updateUpdateState({ lastGoodVersion: '0.5.8' });
    const h = harness();
    h.service.start();
    expect(h.service.snapshot().lastGoodVersion).toBe('0.5.8');
    expect(readUpdateState().lastGoodVersion).toBe('0.5.8');
  });
});

describe('H2: the classified install failures (§5.3)', () => {
  it('EPERM becomes `blocked-by-os` and breaks the three-strike silence', async () => {
    const h = harness({ exitCode: 1, stderr: 'npm error code EPERM\nnpm error syscall rename' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.reason).toBe('blocked-by-os');
    // ONE consecutive failure, and the row already speaks: the failure is
    // actionable and will not fix itself (D-33).
    expect(snapshot.consecutiveFailures).toBe(1);
    expect(shouldRenderUpdateLine(snapshot)).toBe(true);
    // And it still carries the command, because a warning that names no way out
    // is the defect iteration 1 shipped and fixed.
    expect(snapshot.advice).toBe('npm i -g @aragon-agent/cli');
  });

  it('records `update_install_blocked` rather than the generic failure', async () => {
    const h = harness({ exitCode: 1, stderr: 'npm error code EBUSY' });
    await h.service.checkNow({ force: true });
    const messages = h.records.map((r) => r.msg);
    expect(messages).toContain('update_install_blocked');
    expect(messages).not.toContain('update_install_failed');
  });

  it('ENOSPC and EACCES route to their own reasons', async () => {
    for (const [stderr, reason] of [
      ['npm error code ENOSPC: no space left on device', 'no-space'],
      ['npm error code EACCES: permission denied', 'not-writable'],
    ] as const) {
      rmSync(getUpdateStatePath(), { force: true });
      const h = harness({ exitCode: 1, stderr });
      const snapshot = await h.service.checkNow({ force: true });
      expect(snapshot.reason, stderr).toBe(reason);
      expect(shouldRenderUpdateLine(snapshot), stderr).toBe(true);
    }
  });

  it('an unrecognised tail keeps the pre-H2 behaviour: silent until the third', async () => {
    // The half of H2 that is easy to lose. `install-failed` and `network` are
    // the two reasons that actually RECUR, and letting either through would be
    // the beginning of the notification fatigue the whole feature avoids (R-20).
    const h = harness({ exitCode: 1, stderr: 'npm error something entirely new' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.reason).toBe('install-failed');
    expect(shouldRenderUpdateLine(snapshot)).toBe(false);
  });
});

describe('AC-49: the H3 fallback runs ONLY on a failed fetch', () => {
  it('a successful HTTP check never spawns `npm view` (R-19)', async () => {
    const h = harness({ npmViewVersion: '0.6.0' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(h.views).toEqual([]);
    expect(snapshot.probe).toBe('http');
  });

  it('a failed fetch falls back, and the check COMPLETES (R-5)', async () => {
    // Without H3 this machine logs a network failure forever: Node's `fetch`
    // (undici) ignores `HTTP_PROXY`, and v1 accepted that as "the check fails,
    // silently, forever".
    // `observedAfterInstall` because the harness derives U-6's re-read from
    // `remote`, and here `remote` is the probe that FAILED - the version the
    // machine ends up on came from the fallback.
    const h = harness({ remote: null, npmViewVersion: '0.6.0', observedAfterInstall: '0.6.0' });
    const snapshot = await h.service.checkNow({ force: true });
    expect(h.views).toHaveLength(1);
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.probe).toBe('npm');
    expect(readUpdateState().consecutiveFailures).toBe(0);
    expect(h.records.some((r) => r.msg === 'update_check_via_npm' && r.data?.ok === true)).toBe(
      true,
    );
  });

  it('P1-4: the fallback carries the SAME resolved registry the fetch used', async () => {
    // Otherwise the fallback answers about npm's default registry while the
    // check it replaces used `update.registry` - and the machines where those
    // differ are the same mirror-and-proxy population H3 exists for.
    const { resolveRegistryUrl } = await import('../update/registry.js');
    const expected = resolveRegistryUrl(DEFAULT_UPDATE_CONFIG.registry, {});
    const h = harness({ remote: null, npmViewVersion: '0.6.0' });
    await h.service.checkNow({ force: true });
    expect(h.views[0]?.args).toContain(`--registry=${expected}`);
  });

  it('records ONE network failure only when BOTH probes fail', async () => {
    const h = harness({ remote: null });
    const snapshot = await h.service.checkNow({ force: true });
    expect(snapshot.phase).toBe('failed');
    expect(snapshot.reason).toBe('network');
    // One check, one failure. `lastCheckAt` is written once after both attempts:
    // it means "somebody asked", and the throttle it feeds must not fire twice
    // for one check.
    expect(readUpdateState().consecutiveFailures).toBe(1);
    expect(readUpdateState().lastCheckAt).toBe(clock);
    expect(h.records.some((r) => r.msg === 'update_check_via_npm' && r.data?.ok === false)).toBe(
      true,
    );
  });

  it('`via` is on the RESULT record, never on the start record (P2-3)', async () => {
    // On `update_check_start` the value is not yet known, so it would be the
    // constant `'http'` - which is worse than absent.
    const h = harness({ remote: null, npmViewVersion: '0.6.0' });
    await h.service.checkNow({ force: true });
    expect(h.records.find((r) => r.msg === 'update_check_result')?.data?.via).toBe('npm');
    expect(h.records.find((r) => r.msg === 'update_check_start')?.data).not.toHaveProperty('via');
  });
});

describe('AC-31 / C-13: `update` is a member of the closed LogScope union', () => {
  it('compiles as a LogScope', async () => {
    const { getLogger } = await import('../logging/logger.js');
    // A TYPE-LEVEL assertion, so the guard cannot rot into a string comparison:
    // `logger.info('update', ...)` does not compile until the union carries the
    // word. `fast` shipped a whole release logging under the wrong scope by
    // missing exactly this line (its IF-2).
    const child = getLogger().child('update');
    expect(typeof child.info).toBe('function');
    expect(() => getLogger().info('update', 'update_check_start', {})).not.toThrow();
  });
});
