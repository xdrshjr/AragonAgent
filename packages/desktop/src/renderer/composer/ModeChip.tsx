/** The MODE chip: BUILD / PLAN / GOVERN / PLAN+GOVERN. Click or Shift+Tab steps the host's cycle. */

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { POSTURES_FULL, type Posture } from '@aragon-agent/tui/model/governance/posture';
import { useT, type Translate } from '../i18n/index.js';
import { postureLabel } from '../lib/engine-labels.js';
import { pushToast } from '../chat/hooks.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { Popover } from '../ui/overlay.js';

/** Step to the next posture in the host's cycle; failures are shown, never swallowed. */
export async function cyclePosture(sessionId: string, t: Translate): Promise<void> {
  const result = await sessionStore.command(sessionId, { c: 'posture.cycle' });
  if (!result.ok) pushToast(sessionId, 'warn', describeFailure(t, result));
}

export function ModeChip({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const posture = useSession(sessionId, (mirror) => mirror?.view?.posture) ?? 'build';
  const pending = useSession(sessionId, (mirror) => mirror?.view?.pendingPosture);
  const cycle = useSession(sessionId, (mirror) => mirror?.meta?.postureCycle);
  const unavailable = useSession(sessionId, (mirror) => mirror?.meta?.governanceUnavailable);

  const choose = async (next: Posture): Promise<void> => {
    setOpen(false);
    const result = await sessionStore.command(sessionId, { c: 'posture.set', posture: next });
    if (!result.ok) pushToast(sessionId, 'warn', describeFailure(t, result));
  };

  return (
    <span className="chip-group">
      <button type="button" className="status-chip" data-kind="mode" data-posture={posture}
        title={t('chat.mode.hint')} onClick={() => void cyclePosture(sessionId, t)}>
        <span className="chip-label">{t('chat.mode.label')}</span>
        <strong>{postureLabel(t, posture)}</strong>
        {pending ? <span className="chip-pending">{`→ ${postureLabel(t, pending)}`}</span> : null}
      </button>
      <Popover open={open} onOpenChange={setOpen}
        trigger={(
          <button type="button" className="status-chip chip-caret" aria-label={t('chat.mode.choose')}>
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}>
        <ul className="menu" role="menu" aria-label={t('chat.mode.choose')}>
          {POSTURES_FULL.map((candidate) => {
            const allowed = cycle ? cycle.includes(candidate) : candidate === 'build' || candidate === 'plan';
            return (
              <li key={candidate} role="none">
                <button type="button" role="menuitemradio" aria-checked={candidate === posture}
                  aria-disabled={!allowed} className="menu-item" onClick={() => { if (allowed) void choose(candidate); }}>
                  <span>{postureLabel(t, candidate)}</span>
                  {!allowed ? <span className="hint">{unavailable ?? t('chat.mode.unavailable')}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </Popover>
    </span>
  );
}
