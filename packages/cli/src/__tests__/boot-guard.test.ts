/**
 * The boot guard (cli-auto-update-hardening H1 / AC-32 … AC-35, AC-40, AC-41).
 *
 * FULLY INJECTED: the state reader, the writer, the version, the rollback, the
 * exit hook and stderr all come in through `BootGuardDeps`, so nothing here
 * touches `<home>`, spawns npm or registers a real `process.on('exit')`.
 *
 * THE WRITE COUNT IS THE POINT OF HALF THESE TESTS. The guard runs on EVERY
 * launch of `aragon`, including `aragon --version`, so "performs zero writes on
 * the fast path" is a performance contract and not a detail - and a stub writer
 * that records calls is the only way to assert it.
 */

import { describe, expect, it } from 'vitest';
import { markBootHealthy, runBootGuard } from '../boot/guard.js';
import { DEFAULT_UPDATE_STATE, type UpdateState } from '../update/state.js';

interface Harness {
  writes: Partial<UpdateState>[];
  rollbacks: Array<[string, string]>;
  stderr: string[];
  exitHooks: Array<(code: number) => void>;
  deps: Parameters<typeof runBootGuard>[0];
  state: UpdateState;
}

function harness(over: Partial<UpdateState> = {}, version = '0.6.0'): Harness {
  const state: UpdateState = { ...DEFAULT_UPDATE_STATE, ...over };
  const writes: Partial<UpdateState>[] = [];
  const rollbacks: Array<[string, string]> = [];
  const stderr: string[] = [];
  const exitHooks: Array<(code: number) => void> = [];
  return {
    writes,
    rollbacks,
    stderr,
    exitHooks,
    state,
    deps: {
      version,
      readState: () => ({ ...state }),
      writeState: (patch) => {
        writes.push(patch);
        Object.assign(state, patch);
        return state;
      },
      rollback: (bad, good) => rollbacks.push([bad, good]),
      onExit: (listener) => exitHooks.push(listener),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

describe('AC-32 / AC-33: the fast path writes NOTHING', () => {
  it('AC-32: a disarmed guard does not write and does not hook', () => {
    // The steady state - every launch on every machine except the first one
    // after an auto-update. One `readFileSync` and one string compare.
    const h = harness({ autoInstalledVersion: '' });
    runBootGuard(h.deps);
    expect(h.writes).toEqual([]);
    expect(h.exitHooks).toEqual([]);
    expect(h.rollbacks).toEqual([]);
  });

  it('AC-32: a version OTHER than the one we installed is left alone (D-29)', () => {
    // The guard only cleans up damage WE caused. A user's own
    // `npm i -g @aragon-agent/cli@broken` is their install and their decision.
    const h = harness({ autoInstalledVersion: '0.7.0', bootFailures: 5, lastGoodVersion: '0.5.9' });
    runBootGuard(h.deps);
    expect(h.writes).toEqual([]);
    expect(h.rollbacks).toEqual([]);
  });

  it('AC-33: an ARMED guard below the threshold hooks but still writes nothing', () => {
    // The counter moves in the exit hook, not at boot (P1-5 / D-30a). An
    // increment here would have no per-process identity, so concurrent launches
    // of a healthy release would walk it to the threshold between the first
    // one's increment and its `markBootHealthy`.
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 0 });
    runBootGuard(h.deps);
    expect(h.writes).toEqual([]);
    expect(h.rollbacks).toEqual([]);
    expect(h.exitHooks).toHaveLength(1);
  });
});

describe('AC-34 / AC-35: the rollback decision', () => {
  it('AC-34: rolls back ONCE at the threshold and still returns normally', () => {
    // D-31: refusing to start would lock the user out on our guess if the crash
    // was transient. The detached child completes either way.
    const h = harness({
      autoInstalledVersion: '0.6.0',
      bootFailures: 2,
      lastGoodVersion: '0.5.9',
    });
    expect(() => runBootGuard(h.deps)).not.toThrow();
    expect(h.rollbacks).toEqual([['0.6.0', '0.5.9']]);
  });

  it('AC-34: writes the stderr line SYNCHRONOUSLY, before the rollback (P2-9)', () => {
    // `performRollback` is async and its first statement yields, so a line
    // written in there would race `await import("./cli.js")`. Written here, the
    // ordering is a property of the code rather than of the module loader.
    const order: string[] = [];
    const h = harness({
      autoInstalledVersion: '0.6.0',
      bootFailures: 2,
      lastGoodVersion: '0.5.9',
    });
    runBootGuard({
      ...h.deps,
      writeStderr: (text) => order.push(`stderr:${text.trim()}`),
      rollback: () => order.push('rollback'),
    });
    expect(order).toEqual([
      'stderr:aragon 0.6.0 failed to start twice; rolling back to 0.5.9.',
      'rollback',
    ]);
  });

  it('AC-34: does NOT install an exit hook once it has rolled back', () => {
    // The rollback disarms the guard; this launch's own crash belongs to a cycle
    // that is over and must not be counted against the next one.
    const h = harness({
      autoInstalledVersion: '0.6.0',
      bootFailures: 2,
      lastGoodVersion: '0.5.9',
    });
    runBootGuard(h.deps);
    expect(h.exitHooks).toEqual([]);
  });

  it('AC-35: no `lastGoodVersion` means no rollback and no throw', () => {
    // There is nowhere to go. Reinstalling nothing, or guessing a version from
    // the registry, are both worse than leaving the machine as it is.
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 9, lastGoodVersion: '' });
    expect(() => runBootGuard(h.deps)).not.toThrow();
    expect(h.rollbacks).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  it('AC-35: a `lastGoodVersion` equal to the running version is not a rollback', () => {
    // Reinstalling what is already here cannot fix anything and would loop.
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 3, lastGoodVersion: '0.6.0' });
    runBootGuard(h.deps);
    expect(h.rollbacks).toEqual([]);
  });

  it('the threshold is tested BEFORE this launch contributes, so 2 rolls back on the third', () => {
    // D-30. One crash can be transient - a machine that ran out of memory once
    // gets a second chance at the release it just installed.
    for (const [failures, expected] of [
      [0, 0],
      [1, 0],
      [2, 1],
    ] as const) {
      const h = harness({
        autoInstalledVersion: '0.6.0',
        bootFailures: failures,
        lastGoodVersion: '0.5.9',
      });
      runBootGuard(h.deps);
      expect(h.rollbacks, `bootFailures=${failures}`).toHaveLength(expected);
    }
  });
});

describe('AC-41: the exit hook', () => {
  it('increments `bootFailures` on a NON-ZERO code', () => {
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 1 });
    runBootGuard(h.deps);
    (h.exitHooks[0] as (code: number) => void)(1);
    expect(h.writes).toEqual([{ bootFailures: 2 }]);
  });

  it('DISARMS on code 0 instead of counting', () => {
    // The backstop for `aragon -p`, `aragon config set`, `aragon --version` and
    // every other path that never mounts Ink.
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 1 });
    runBootGuard(h.deps);
    (h.exitHooks[0] as (code: number) => void)(0);
    expect(h.writes).toEqual([
      { autoInstalledVersion: '', bootFailures: 0, lastGoodVersion: '0.6.0' },
    ]);
  });

  it('a throwing writer inside the hook does not escape', () => {
    // An exit hook that throws prints an unactionable stack over whatever the
    // CLI last said. The bookkeeping is not worth that.
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 1 });
    runBootGuard({
      ...h.deps,
      writeState: () => {
        throw new Error('disk full');
      },
    });
    expect(() => (h.exitHooks[0] as (code: number) => void)(1)).not.toThrow();
  });
});

describe('AC-40: markBootHealthy', () => {
  it('clears the arming, zeroes the counter, and records the rollback target', () => {
    const h = harness({ autoInstalledVersion: '0.6.0', bootFailures: 1 });
    markBootHealthy('0.6.0', h.deps);
    expect(h.writes).toEqual([
      { autoInstalledVersion: '', bootFailures: 0, lastGoodVersion: '0.6.0' },
    ]);
  });

  it('LEAVES `rolledBackFrom` UNTOUCHED (P0-1e)', () => {
    // An earlier draft had this function clear the rollback notice. It could
    // never have done so - after a rollback `autoInstalledVersion` is `''`, so
    // it returns on its first line - and writing the field here would ALSO burn
    // the notice before the service ever read it. The service consumes it
    // (D-40), which is the only place that can decide it has been shown.
    const h = harness({ autoInstalledVersion: '0.6.0', rolledBackFrom: '0.7.0' });
    markBootHealthy('0.6.0', h.deps);
    expect(h.writes[0]).not.toHaveProperty('rolledBackFrom');
    expect(h.state.rolledBackFrom).toBe('0.7.0');
  });

  it('is a NO-OP on the second call, and on a version that is not armed', () => {
    const h = harness({ autoInstalledVersion: '0.6.0' });
    markBootHealthy('0.6.0', h.deps);
    markBootHealthy('0.6.0', h.deps);
    markBootHealthy('0.5.9', h.deps);
    expect(h.writes).toHaveLength(1);
  });

  it('ignores an empty version rather than writing one', () => {
    // `readOwnVersion()` returns `''` when the manifest is unreadable, and
    // `autoInstalledVersion: ''` is the DISARMED sentinel - so an unguarded call
    // would match it and write a `lastGoodVersion` of `''`.
    const h = harness({ autoInstalledVersion: '' });
    markBootHealthy('', h.deps);
    expect(h.writes).toEqual([]);
  });
});

describe('runBootGuard never throws', () => {
  it('survives a state reader that explodes', () => {
    // `launcher.ts` wraps the call anyway, but a guard that relies on its caller
    // for that is one refactor away from taking the CLI down with it.
    expect(() =>
      runBootGuard({
        version: '0.6.0',
        readState: () => {
          throw new Error('corrupt');
        },
      }),
    ).not.toThrow();
  });

  it('does nothing at all when the version is unreadable', () => {
    const h = harness({ autoInstalledVersion: '' }, '');
    runBootGuard(h.deps);
    expect(h.writes).toEqual([]);
    expect(h.exitHooks).toEqual([]);
  });
});
