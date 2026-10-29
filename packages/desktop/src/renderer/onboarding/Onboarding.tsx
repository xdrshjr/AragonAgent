/**
 * First-run onboarding: provider -> key and model (with discovery and a staged connection
 * test) -> workspace. Every step can go back and the whole flow can be skipped.
 *
 * NOTHING IS WRITTEN UNTIL "Finish". Discovery and the connection test run on the draft held in
 * this component; the key reaches `config.json` exactly once, in the single patch that creates
 * the profile and binds it as the main model. Skipping writes nothing.
 */

import { isValidEndpointUrl } from '@aragon-agent/tui/model/config/model-profiles';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { applyProfile, bindRole, loadFullLibrary, type ProfileForm } from '../lib/settings-profiles.js';
import { ConfigConflictDialog } from '../settings/ConfigConflict.js';
import { useConnectionCheck } from '../settings/connection.js';
import { openSession } from '../store/actions.js';
import { useConfig } from '../store/config-store.js';
import { Button } from '../ui/primitives.js';
import { providerOf, type OnboardingDraft } from './draft.js';
import { KeyStep } from './KeyStep.js';
import { ProviderStep } from './ProviderStep.js';
import { WorkspaceStep } from './WorkspaceStep.js';
import './onboarding.css';

const STEPS = ['provider', 'key', 'workspace'] as const;

function profileForm(draft: OnboardingDraft): ProfileForm {
  return {
    name: '', provider: providerOf(draft.choice), model: draft.model, baseUrl: draft.baseUrl,
    apiKey: draft.apiKey, contextWindow: 'auto',
  };
}

export function Onboarding(props: { onFinished(): void; onSkip(): void }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>({ choice: 'anthropic', baseUrl: '', apiKey: '', model: '', workspace: null });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const check = useConnectionCheck();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, [step]);

  const update = (patch: Partial<OnboardingDraft>): void => {
    setDraft((held) => ({ ...held, ...patch }));
    if ('choice' in patch || 'baseUrl' in patch || 'apiKey' in patch || 'model' in patch) check.reset();
  };

  const finish = async (): Promise<void> => {
    setSaving(true);
    setFailure(null);
    try {
      const loaded = await loadFullLibrary(useConfig.getState().result?.view ?? null);
      if (!loaded.ok) { setFailure(t('settings.models.error.key_unavailable', { profile: loaded.profile })); return; }
      const applied = applyProfile(loaded.library, null, profileForm(draft));
      if (!applied.ok) { setFailure(t('settings.models.error.invalid')); return; }
      const outcome = await useConfig.getState().patch({ modelProfiles: bindRole(applied.library, 'main', applied.id) });
      if (!outcome.ok) {
        if (outcome.code !== 'conflict') setFailure(t('settings.error.save', { code: outcome.code }));
        return;
      }
      // The model is saved; a workspace that fails to open must not undo that.
      if (draft.workspace) await openSession({ cwd: draft.workspace });
      props.onFinished();
    } finally {
      setSaving(false);
    }
  };

  const last = step === STEPS.length - 1;
  const canNext = step === 0
    ? draft.choice !== 'custom' || (draft.baseUrl.trim() !== '' && isValidEndpointUrl(draft.baseUrl))
    : step === 1 ? draft.apiKey.trim() !== '' && draft.model.trim() !== '' : true;
  const advance = (): void => { if (!canNext) return; if (last) void finish(); else setStep(step + 1); };

  return (
    <main className="onb" aria-labelledby="onb-title">
      <div className="onb-card">
        <header className="onb-head">
          <ol className="onb-steps" aria-label={t('workspace.onboarding.steps')}>
            {STEPS.map((id, index) => (
              <li key={id} aria-current={index === step ? 'step' : undefined} data-done={index < step}>
                <span className="onb-step-n">{index + 1}</span> {t(`workspace.onboarding.step.${id}` as const)}
              </li>
            ))}
          </ol>
          <Button variant="ghost" size="sm" onClick={props.onSkip}>{t('workspace.onboarding.skip')}</Button>
        </header>
        <h1 id="onb-title" ref={heading} tabIndex={-1}>{t(`workspace.onboarding.title.${STEPS[step]!}` as const)}</h1>
        <form onSubmit={(event) => { event.preventDefault(); advance(); }}>
          {step === 0 ? <ProviderStep draft={draft} onChange={update} /> : null}
          {step === 1 ? <KeyStep draft={draft} check={check} onChange={update} /> : null}
          {step === 2 ? <WorkspaceStep draft={draft} onChange={update} /> : null}
          {failure ? <p className="set-error" role="alert">{failure}</p> : null}
          <footer className="onb-foot">
            <Button variant="ghost" disabled={step === 0 || saving} onClick={() => setStep(step - 1)}>{t('common.back')}</Button>
            <Button variant="primary" type="submit" disabled={!canNext || saving}>
              {last ? (saving ? t('common.loading') : t('workspace.onboarding.finish')) : t('common.next')}
            </Button>
          </footer>
        </form>
        <p className="onb-note">{t('workspace.onboarding.writeNote')}</p>
      </div>
      <ConfigConflictDialog />
    </main>
  );
}
