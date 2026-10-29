/**
 * Onboarding step 2: API key, model (discovered or typed) and a staged connection test.
 * The key lives only in the onboarding draft until Finish.
 */

import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { blockEnterWhileComposing } from '../lib/settings-ime.js';
import { ConnectionResult, type ConnectionCheck, type ConnectionDraft } from '../settings/connection.js';
import { Button, IconButton, Input } from '../ui/primitives.js';
import { providerOf, type OnboardingDraft } from './draft.js';

export function KeyStep(props: { draft: OnboardingDraft; check: ConnectionCheck; onChange(patch: Partial<OnboardingDraft>): void }) {
  const t = useT();
  const { draft, check } = props;
  const [visible, setVisible] = useState(false);
  const connection: ConnectionDraft = {
    provider: providerOf(draft.choice), model: draft.model, baseUrl: draft.baseUrl, apiKey: draft.apiKey,
  };
  const models = check.discovery.state === 'done' ? check.discovery.models : [];
  const hasKey = draft.apiKey.trim() !== '';

  return (
    <div className="pe-grid onb-grid">
      <div className="pe-field pe-wide">
        <label className="label" htmlFor="onb-key">{t('settings.profile.apiKey')}</label>
        <div className="pe-key">
          <Input id="onb-key" type={visible ? 'text' : 'password'} value={draft.apiKey} autoComplete="off" spellCheck={false} autoFocus
            onChange={(event) => props.onChange({ apiKey: event.target.value })} onKeyDown={blockEnterWhileComposing} />
          <IconButton label={visible ? t('settings.key.hide') : t('settings.key.show')} onClick={() => setVisible((value) => !value)}>
            {visible ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconButton>
        </div>
        <div className="hint">{t('workspace.onboarding.keyHint')}</div>
      </div>
      <div className="pe-field pe-wide">
        <label className="label" htmlFor="onb-model">{t('settings.profile.model')}</label>
        <Input id="onb-model" list="onb-models" value={draft.model} spellCheck={false} autoComplete="off"
          onChange={(event) => props.onChange({ model: event.target.value })} onKeyDown={blockEnterWhileComposing} />
        <datalist id="onb-models">{models.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</datalist>
        {check.discovery.state === 'done' ? <div className="hint" role="status">{t('settings.conn.found', { n: models.length })}</div> : null}
        {check.discovery.state === 'error' ? <div className="error-text" role="alert">{check.discovery.message}</div> : null}
      </div>
      <div className="pe-actions pe-wide">
        <Button disabled={!hasKey || check.discovery.state === 'busy'} onClick={() => void check.discover(connection)}>
          {check.discovery.state === 'busy' ? t('settings.conn.discovering') : t('settings.conn.discover')}
        </Button>
        <Button disabled={!hasKey || draft.model.trim() === '' || check.test.state === 'busy'} onClick={() => void check.runTest(connection)}>
          {t('settings.conn.test')}
        </Button>
      </div>
      <div className="pe-wide"><ConnectionResult test={check.test} /></div>
    </div>
  );
}
