/** Onboarding step 1: which provider. A custom endpoint is an OpenAI-compatible server with its own base URL. */

import { isValidEndpointUrl } from '@aragon-agent/tui/model/config/model-profiles';
import { useT } from '../i18n/index.js';
import { Input } from '../ui/primitives.js';
import type { OnboardingDraft, ProviderChoice } from './draft.js';

const CHOICES: readonly ProviderChoice[] = ['anthropic', 'openai', 'google', 'custom'];

export function ProviderStep(props: { draft: OnboardingDraft; onChange(patch: Partial<OnboardingDraft>): void }) {
  const t = useT();
  const { draft } = props;
  const badUrl = draft.choice === 'custom' && draft.baseUrl.trim() !== '' && !isValidEndpointUrl(draft.baseUrl);
  return (
    <div>
      <fieldset className="onb-choices">
        <legend className="sr-only">{t('workspace.onboarding.title.provider')}</legend>
        {CHOICES.map((choice) => (
          <label key={choice} className="onb-choice" data-selected={draft.choice === choice}>
            <input type="radio" name="provider" value={choice} checked={draft.choice === choice}
              onChange={() => props.onChange({ choice })} />
            <span className="onb-choice-name">{t(`workspace.onboarding.provider.${choice}` as const)}</span>
            <span className="onb-choice-desc">{t(`workspace.onboarding.providerDesc.${choice}` as const)}</span>
          </label>
        ))}
      </fieldset>
      {draft.choice === 'custom' ? (
        <div className="pe-field">
          <label className="label" htmlFor="onb-url">{t('settings.profile.baseUrl')}</label>
          <Input id="onb-url" value={draft.baseUrl} placeholder="https://" inputMode="url" spellCheck={false} autoFocus
            aria-invalid={badUrl ? true : undefined} onChange={(event) => props.onChange({ baseUrl: event.target.value })} />
          <div className="hint">{t('workspace.onboarding.customHint')}</div>
          {badUrl ? <div className="error-text" role="alert">{t('settings.profile.invalid')}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
