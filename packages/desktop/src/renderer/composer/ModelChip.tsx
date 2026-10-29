/**
 * The MODEL chip and its popover: current model, saved profiles, kits, thinking level.
 *
 * Changing any of them while a run is live is refused by the host (an answer must not switch
 * model half-way), so the controls are disabled WITH the reason shown rather than silently dead.
 * The current model is read from the shared configuration (which the host just wrote), with the
 * session's own meta as the fallback.
 */

import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pushToast } from '../chat/hooks.js';
import { useT, type Translate } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import type { ConfigViewDto, MaskedProfile } from '../../shared/config-view.js';
import type { HostCommand } from '../../shared/port-protocol.js';
import { useConfig } from '../store/config-store.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { Popover } from '../ui/overlay.js';
import { onComposerIntent } from './composer-bus.js';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export function currentModelLabel(view: ConfigViewDto | null, meta: { provider: string; model: string } | undefined): string {
  const profiles = view?.modelProfiles;
  const main = profiles?.mainId ? profiles.entries.find((entry) => entry.id === profiles.mainId) : undefined;
  if (main) return main.model;
  return view?.model ?? meta?.model ?? '';
}

async function run(sessionId: string, command: HostCommand, t: Translate): Promise<void> {
  const result = await sessionStore.command(sessionId, command);
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
}

function ProfileRow(props: {
  profile: MaskedProfile; current: boolean; disabled: boolean; onPick(): void;
}) {
  const { profile } = props;
  return (
    <li role="none">
      <button type="button" role="menuitemradio" aria-checked={props.current} aria-disabled={props.disabled}
        className="menu-item" onClick={() => { if (!props.disabled) props.onPick(); }}>
        <span>{profile.name}</span>
        <span className="hint">{profile.provider}:{profile.model}</span>
      </button>
    </li>
  );
}

export function ModelChip({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const view = useConfig((state) => state.result?.view ?? null);
  const meta = useSession(sessionId, (mirror) => mirror?.meta);
  const running = useSession(sessionId, (mirror) => mirror?.view?.status === 'running');
  const pending = useSession(sessionId, (mirror) => mirror?.configPending) === true;
  useEffect(() => onComposerIntent('open-model', () => setOpen(true)), []);

  const label = currentModelLabel(view, meta ?? undefined) || t('chat.model.none');
  const profiles = view?.modelProfiles?.entries ?? [];
  const kits = view?.modelProfiles?.kits ?? [];
  const pick = (profile: MaskedProfile): void => {
    setOpen(false);
    void run(sessionId, {
      c: 'model.patch',
      patch: { provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, contextWindow: profile.contextWindow },
    }, t);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}
      trigger={(
        <button type="button" className="status-chip" data-kind="model" title={t('chat.model.hint')}>
          <span className="chip-label">{t('chat.model.label')}</span>
          <strong className="chip-model">{label}</strong>
          {pending ? <span className="chip-dot" role="img" aria-label={t('chat.model.pending')} title={t('chat.model.pending')} /> : null}
          <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}>
      <div className="model-pop">
        <div className="pop-title">{t('chat.model.current', { model: `${view?.provider ?? meta?.provider ?? ''}:${label}` })}</div>
        {running ? <p className="pop-note" role="note">{t('chat.model.busy')}</p> : null}
        {pending ? <p className="pop-note" role="note">{t('chat.model.pending')}</p> : null}
        <div className="pop-section">{t('chat.model.profiles')}</div>
        {profiles.length === 0 ? <p className="hint">{t('chat.model.noProfiles')}</p> : (
          <ul className="menu" role="menu">
            {profiles.map((profile) => (
              <ProfileRow key={profile.id} profile={profile} disabled={running} onPick={() => pick(profile)}
                current={profile.provider === view?.provider && profile.model === view?.model} />
            ))}
          </ul>
        )}
        {kits.length > 0 ? (
          <>
            <div className="pop-section">{t('chat.model.kits')}</div>
            <ul className="menu" role="menu">
              {kits.map((kit) => (
                <li key={kit.id} role="none">
                  <button type="button" role="menuitem" aria-disabled={running} className="menu-item"
                    onClick={() => { if (!running) { setOpen(false); void run(sessionId, { c: 'kit.apply', kitId: kit.id }, t); } }}>
                    {kit.name}
                  </button>
                </li>
              ))}
              <li role="none">
                <button type="button" role="menuitem" aria-disabled={running} className="menu-item"
                  onClick={() => { if (!running) { setOpen(false); void run(sessionId, { c: 'kit.clear' }, t); } }}>
                  {t('chat.model.clearKit')}
                </button>
              </li>
            </ul>
          </>
        ) : null}
        <div className="pop-section">{t('chat.model.thinking')}</div>
        <div className="seg" role="radiogroup" aria-label={t('chat.model.thinking')}>
          {THINKING_LEVELS.map((level) => (
            <button key={level} type="button" role="radio" aria-checked={view?.thinkingLevel === level}
              aria-disabled={running} className="seg-item"
              onClick={() => { if (!running) void run(sessionId, { c: 'thinking.set', level }, t); }}>
              {t(`chat.thinking.level.${level}` as const)}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
