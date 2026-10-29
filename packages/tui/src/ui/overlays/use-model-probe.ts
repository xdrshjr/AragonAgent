/**
 * The probe task hook (model-profile-connection-test §6.2).
 *
 * IT LIVES IN `SettingsScreen`, ONCE, AND NOWHERE ELSE. The editor unmounts whenever
 * the page changes (`SettingsScreen` renders it only for `page === 'editor'`), so a
 * hook inside the editor would abort its own discovery the moment `Discover models`
 * switched to the list page - the feature cancelling itself.
 *
 * TWO SLOTS, ONE IN FLIGHT. A test verdict and a discovered list answer different
 * questions, so they are stored separately: opening the list must not erase a verdict
 * the user still wants to read when they press Esc back (AC-27). Starting either task
 * aborts whatever is running - one request at a time.
 *
 * `test()` AND `discover()` NEVER REJECT. The only callers are Ink input handlers,
 * which have nowhere to await a `catch`; the hook folds every exception into an
 * `unknown` failure so no frame can be left on `testing` forever.
 *
 * ASCII ONLY (`ui/` is inside `glyphs.test.ts::inScope`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiscoveryOutcome, ModelProbe, ProbeOutcome,
  ProbeTarget } from '../../model/agent/model-probe.js';
import type { ProbeDiscoveryPhase, ProbeTestPhase } from './model-probe-view.js';

const TEST_FAILED_DETAIL = 'The connection test could not run.';
const DISCOVERY_FAILED_DETAIL = 'The model list could not be fetched.';

export interface ModelProbeTasks {
  test: ProbeTestPhase;
  discovery: ProbeDiscoveryPhase;
  busy: boolean;
  startTest(target: ProbeTarget): void;
  startDiscovery(target: ProbeTarget): void;
  cancel(): void;
}

function unknownTest(targetId: string): ProbeOutcome {
  return { ok: false, targetId, latencyMs: 0, kind: 'unknown', detail: TEST_FAILED_DETAIL };
}

function unknownDiscovery(connectionId: string): DiscoveryOutcome {
  return { ok: false, connectionId, kind: 'unknown', detail: DISCOVERY_FAILED_DETAIL,
    models: [], truncated: false, total: 0 };
}

/** Run one probe, guaranteeing the promise settles and no rejection escapes. */
function settle<T>(work: () => Promise<T>, onValue: (value: T) => void,
  onFailure: () => void): void {
  let pending: Promise<T>;
  try {
    pending = work();
  } catch {
    onFailure();
    return;
  }
  void pending.then(onValue, onFailure);
}

export function useModelProbe(probe?: ModelProbe): ModelProbeTasks {
  const [test, setTest] = useState<ProbeTestPhase>({ phase: 'idle' });
  const [discovery, setDiscovery] = useState<ProbeDiscoveryPhase>({ phase: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef<'test' | 'discovery' | null>(null);
  const abortCurrent = useCallback((): void => {
    controller.current?.abort();
    controller.current = null;
    inFlight.current = null;
  }, []);
  useEffect(() => abortCurrent, [abortCurrent]);
  const begin = useCallback((kind: 'test' | 'discovery'): AbortController => {
    abortCurrent();
    const next = new AbortController();
    controller.current = next;
    inFlight.current = kind;
    return next;
  }, [abortCurrent]);
  /**
   * Land one run's result and drop the in-flight refs with it.
   *
   * Clearing them here is what keeps `cancel()` honest: it is the ONLY caller of
   * `abortCurrent`, and an Escape on a settled slot (a frame where `busy` is stale)
   * must not erase a verdict the user is still reading.
   */
  const finish = useCallback((run: AbortController, commit: () => void): void => {
    if (run.signal.aborted) return;
    controller.current = null;
    inFlight.current = null;
    commit();
  }, []);
  const startTest = useCallback((target: ProbeTarget): void => {
    if (!probe) return;
    const run = begin('test');
    const targetId = probe.targetFingerprint(target);
    setTest({ phase: 'testing', targetId });
    settle(() => probe.test({ ...target, signal: run.signal }), (outcome) => {
      finish(run, () => setTest({ phase: 'tested', outcome }));
    }, () => {
      finish(run, () => setTest({ phase: 'tested', outcome: unknownTest(targetId) }));
    });
  }, [probe, begin, finish]);
  const startDiscovery = useCallback((target: ProbeTarget): void => {
    if (!probe) return;
    const run = begin('discovery');
    const connectionId = probe.connectionFingerprint(target);
    setDiscovery({ phase: 'discovering', connectionId });
    settle(() => probe.discover({ ...target, signal: run.signal }), (outcome) => {
      finish(run, () => setDiscovery({ phase: 'discovered', outcome }));
    }, () => {
      finish(run, () => setDiscovery({ phase: 'discovered',
        outcome: unknownDiscovery(connectionId) }));
    });
  }, [probe, begin, finish]);
  const cancel = useCallback((): void => {
    const kind = inFlight.current;
    abortCurrent();
    if (kind === 'test') setTest({ phase: 'idle' });
    if (kind === 'discovery') setDiscovery({ phase: 'idle' });
  }, [abortCurrent]);
  const busy = test.phase === 'testing' || discovery.phase === 'discovering';
  return { test, discovery, busy, startTest, startDiscovery, cancel };
}
