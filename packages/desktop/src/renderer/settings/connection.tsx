/**
 * Everything the model-connection forms share (Settings > Models and onboarding): model
 * discovery and the staged connection test, both on an UNSAVED draft, plus the 30-second
 * "show key" reveal.
 *
 * Each request carries a sequence number; an answer that arrives after the user changed the
 * draft or started another request is dropped, so a slow 401 can never be shown beside a key
 * that has since been corrected.
 */

import { Check, Circle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import type { ConnectionTestResultDto, ModelOptionDto } from '../../shared/ipc-contract.js';

/** A revealed key is hidden again after this long. */
export const REVEAL_MS = 30_000;

export interface ConnectionDraft {
  provider: string;
  model: string;
  baseUrl: string;
  /** What the user typed; empty means "use the stored key". */
  apiKey: string;
  profileId?: string;
}

export type DiscoveryState =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; models: ModelOptionDto[] }
  | { state: 'error'; message: string };

export type TestState =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'done'; result: ConnectionTestResultDto }
  | { state: 'error'; message: string };

function connection(draft: ConnectionDraft): { provider: string; baseUrl: string | null; apiKey?: string; profileId?: string } {
  const key = draft.apiKey.trim();
  return {
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim() || null,
    ...(key ? { apiKey: key } : {}),
    ...(draft.profileId ? { profileId: draft.profileId } : {}),
  };
}

export interface ConnectionCheck {
  discovery: DiscoveryState;
  test: TestState;
  discover(draft: ConnectionDraft): Promise<void>;
  runTest(draft: ConnectionDraft): Promise<void>;
  reset(): void;
}

export function useConnectionCheck(): ConnectionCheck {
  const [discovery, setDiscovery] = useState<DiscoveryState>({ state: 'idle' });
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const counters = useRef({ discover: 0, test: 0 });
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const discover = useCallback(async (draft: ConnectionDraft) => {
    const mine = ++counters.current.discover;
    setDiscovery({ state: 'busy' });
    const response = await ipc('config:discover-models', connection(draft));
    if (!mounted.current || mine !== counters.current.discover) return;
    setDiscovery(response.ok ? { state: 'done', models: response.value.models } : { state: 'error', message: response.message });
  }, []);

  const runTest = useCallback(async (draft: ConnectionDraft) => {
    const mine = ++counters.current.test;
    setTest({ state: 'busy' });
    const response = await ipc('config:test-connection', { ...connection(draft), model: draft.model.trim() });
    if (!mounted.current || mine !== counters.current.test) return;
    setTest(response.ok ? { state: 'done', result: response.value } : { state: 'error', message: response.message });
  }, []);

  const reset = useCallback(() => {
    counters.current.discover += 1;
    counters.current.test += 1;
    setDiscovery({ state: 'idle' });
    setTest({ state: 'idle' });
  }, []);

  return { discovery, test, discover, runTest, reset };
}

/** The reveal button's state: the clear key exists in memory only while it is shown. */
export function useRevealedKey(): {
  key: string | null; error: boolean; reveal(provider: string, profileId?: string): Promise<void>; hide(): void;
} {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setKey(null);
  }, []);
  useEffect(() => clear, [clear]);

  const reveal = useCallback(async (provider: string, profileId?: string) => {
    const response = await ipc('config:reveal-key', { provider, ...(profileId ? { profileId } : {}) });
    if (!response.ok || !response.value.key) {
      setError(true);
      return;
    }
    setError(false);
    setKey(response.value.key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(clear, REVEAL_MS);
  }, [clear]);

  return { key, error, reveal, hide: clear };
}

const STAGES = ['config', 'network', 'auth', 'model', 'stream'] as const;
type Stage = (typeof STAGES)[number];

function stageState(stage: Stage, result: ConnectionTestResultDto): 'passed' | 'failed' | 'pending' {
  if (result.ok) return 'passed';
  const failedAt = STAGES.indexOf(result.stage as Stage);
  const here = STAGES.indexOf(stage);
  if (failedAt < 0) return 'pending';
  return here < failedAt ? 'passed' : here === failedAt ? 'failed' : 'pending';
}

const STAGE_ICON = { passed: Check, failed: X, pending: Circle } as const;

/** The stage-by-stage result with an actionable reason (spec 3.9.6: 401 = key, 404 = URL, timeout = network). */
export function ConnectionResult({ test }: { test: TestState }) {
  const t = useT();
  if (test.state === 'idle') return null;
  if (test.state === 'busy') return <p className="conn-busy" role="status">{t('settings.conn.testing')}</p>;
  if (test.state === 'error') return <p className="set-error" role="alert">{t('settings.conn.unavailable', { message: test.message })}</p>;
  const { result } = test;
  const hintStage: Stage = (STAGES as readonly string[]).includes(result.stage) ? (result.stage as Stage) : 'config';
  return (
    <div className="conn-result" role="status" data-ok={result.ok}>
      <ol className="conn-stages">
        {STAGES.map((stage) => {
          const state = stageState(stage, result);
          const Icon = STAGE_ICON[state];
          return (
            <li key={stage} data-state={state}>
              <Icon size={14} aria-hidden="true" />
              <span>{t(`settings.conn.stage.${stage}` as const)}</span>
              <span className="conn-stage-state">{t(`settings.conn.state.${state}` as const)}</span>
            </li>
          );
        })}
      </ol>
      {result.ok ? (
        <p>{t('settings.conn.ok', { ms: result.latencyMs ?? 0 })}</p>
      ) : (
        <>
          <p className="conn-hint"><strong>{t('settings.conn.fix')}</strong> {t(`settings.conn.hint.${hintStage}` as const)}</p>
          {result.detail ? <p className="conn-detail selectable"><span>{t('common.error.details')}: </span>{result.detail}</p> : null}
        </>
      )}
    </div>
  );
}
