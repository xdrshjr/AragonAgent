/**
 * Settings > Team > "Force a fan-out": the desktop's `/team`.
 *
 * Arms the open session so its NEXT message must be split across N sub-agents instead of leaving
 * the choice to the model. The number is capped by the existing `team.maxSubagents` setting - this
 * card adds no configuration key of its own, only the act.
 *
 * Honest limit: the engine does not publish "is this session armed", so the card shows what was
 * armed from here in this window, not a live readback; arming again simply replaces it, and
 * "Disarm" is always safe (it is a no-op on an unarmed session).
 */

import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { useConfig } from '../store/config-store.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { Button, Input } from '../ui/primitives.js';

const DEFAULT_COUNT = 2;

export function ForcedFanout() {
  const t = useT();
  const sessionId = useUi((state) => state.activeSessionId);
  const maxSubagents = useConfig((state) => state.result?.view?.team?.maxSubagents) ?? 4;
  const teamEnabled = useConfig((state) => state.result?.view?.team?.enabled) !== false;
  const [count, setCount] = useState(String(DEFAULT_COUNT));
  const [armed, setArmed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = Number(count);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= maxSubagents;
  const available = sessionId !== null && teamEnabled;

  const arm = async (): Promise<void> => {
    if (!sessionId || !valid) return;
    setBusy(true);
    setError(null);
    const result = await sessionStore.command(sessionId, { c: 'team.arm-forced', count: parsed });
    setBusy(false);
    if (!result.ok) { setError(describeFailure(t, result)); return; }
    setArmed((result.value as { armed?: number } | undefined)?.armed ?? parsed);
  };
  const disarm = async (): Promise<void> => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    const result = await sessionStore.command(sessionId, { c: 'team.disarm' });
    setBusy(false);
    if (!result.ok) { setError(describeFailure(t, result)); return; }
    setArmed(null);
  };

  return (
    <section className="set-card" aria-labelledby="forced-fanout">
      <header className="set-card-head"><h3 id="forced-fanout">{t('settings.team.forced.title')}</h3></header>
      <p className="set-desc">{t('settings.team.forced.body', { max: maxSubagents })}</p>
      {!sessionId ? <p className="set-empty">{t('settings.team.forced.noSession')}</p> : null}
      {sessionId && !teamEnabled ? <p className="set-empty">{t('settings.team.forced.disabled')}</p> : null}
      <div className="pe-actions">
        <label htmlFor="forced-count" className="sr-only">{t('settings.team.forced.count')}</label>
        <Input id="forced-count" type="number" inputMode="numeric" min={1} max={maxSubagents} value={count}
          aria-invalid={!valid} disabled={!available || busy} onChange={(event) => setCount(event.target.value)} />
        <Button size="sm" variant="primary" disabled={!available || !valid || busy} onClick={() => void arm()}>
          {t('settings.team.forced.arm')}
        </Button>
        <Button size="sm" disabled={!sessionId || busy} onClick={() => void disarm()}>{t('settings.team.forced.disarm')}</Button>
      </div>
      {!valid ? <p className="set-error" role="alert">{t('settings.team.forced.range', { max: maxSubagents })}</p> : null}
      {armed !== null ? <p className="set-status" role="status">{t('settings.team.forced.armed', { n: armed })}</p> : null}
      {error ? <p className="set-error" role="alert">{error}</p> : null}
    </section>
  );
}
