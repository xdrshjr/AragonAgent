/**
 * Add / edit one model profile. Discovery and the connection test run on the DRAFT, so a user
 * can verify a key and base URL before anything is written. The stored key is never shown
 * unless the user asks, and then only for `REVEAL_MS`.
 */

import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { ADAPTER_PROVIDERS } from '@aragon-agent/tui/model/config/schema';
import { useT } from '../i18n/index.js';
import type { FormErrors, ProfileForm } from '../lib/settings-profiles.js';
import type { MaskedKey } from '../../shared/config-view.js';
import { Dialog } from '../ui/overlay.js';
import { Button, IconButton, Input, Select, Spinner } from '../ui/primitives.js';
import { ConnectionResult, useConnectionCheck, useRevealedKey } from './connection.js';

export interface ProfileEditorProps {
  /** Present when editing: the profile id and the masked key status. */
  editing: { id: string; key: MaskedKey } | null;
  initial: ProfileForm;
  errors: FormErrors;
  saving: boolean;
  /** A save-level failure that belongs to no single field. */
  failure: string | null;
  onSubmit(form: ProfileForm): void;
  onClose(): void;
}

function Field(props: { id: string; label: string; error?: string | undefined; hint?: string; children: React.ReactNode }) {
  return (
    <div className="pe-field">
      <label htmlFor={props.id} className="label">{props.label}</label>
      {props.children}
      {props.hint ? <div className="hint">{props.hint}</div> : null}
      {props.error ? <div className="error-text" role="alert">{props.error}</div> : null}
    </div>
  );
}

function KeyField(props: {
  form: ProfileForm; editing: ProfileEditorProps['editing']; error: string | undefined;
  onChange(value: string): void;
}) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const stored = useRevealedKey();
  const { form, editing } = props;
  const showingStored = stored.key !== null && form.apiKey === '';
  const placeholder = editing?.key.present ? t('settings.key.stored', { tail: editing.key.tail }) : t('settings.key.none');
  const toggle = (): void => {
    if (form.apiKey !== '') setVisible((value) => !value);
    else if (showingStored) stored.hide();
    else if (editing) void stored.reveal(form.provider, editing.id);
  };
  const canToggle = form.apiKey !== '' || Boolean(editing?.key.present);
  return (
    <Field id="pe-key" label={t('settings.profile.apiKey')} error={props.error}
      hint={editing ? t('settings.profile.keyKeep') : t('settings.profile.keyHint')}>
      <div className="pe-key">
        <Input id="pe-key" type={visible || showingStored ? 'text' : 'password'} autoComplete="off" spellCheck={false}
          value={showingStored ? stored.key ?? '' : form.apiKey} readOnly={showingStored} placeholder={placeholder}
          onChange={(event) => props.onChange(event.target.value)} />
        <IconButton label={visible || showingStored ? t('settings.key.hide') : t('settings.key.show')}
          onClick={toggle} disabled={!canToggle}>
          {visible || showingStored ? <EyeOff size={14} /> : <Eye size={14} />}
        </IconButton>
      </div>
      {stored.error ? <div className="error-text" role="alert">{t('settings.key.revealFailed')}</div> : null}
      {showingStored ? <div className="hint" role="status">{t('settings.key.autoHide')}</div> : null}
    </Field>
  );
}

export function ProfileEditor(props: ProfileEditorProps) {
  const t = useT();
  const [form, setForm] = useState<ProfileForm>(props.initial);
  const check = useConnectionCheck();
  const set = (patch: Partial<ProfileForm>): void => { setForm((current) => ({ ...current, ...patch })); check.reset(); };
  const draft = { ...form, ...(props.editing ? { profileId: props.editing.id } : {}) };
  const errorText = (code: 'required' | 'invalid' | undefined): string | undefined =>
    (code ? t(code === 'required' ? 'settings.profile.required' : 'settings.profile.invalid') : undefined);
  const models = check.discovery.state === 'done' ? check.discovery.models : [];

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }} size="lg"
      title={props.editing ? t('settings.profile.editTitle') : t('settings.profile.addTitle')}
      actions={<>
        <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={props.saving} onClick={() => props.onSubmit(form)}>
          {props.saving ? <Spinner label={t('common.loading')} /> : null} {t('common.save')}
        </Button>
      </>}>
      <div className="pe-grid">
        <Field id="pe-name" label={t('settings.profile.name')} hint={t('settings.profile.nameHint')}>
          <Input id="pe-name" value={form.name} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field id="pe-provider" label={t('settings.profile.provider')} error={errorText(props.errors.provider)}>
          <Select id="pe-provider" value={form.provider} onChange={(event) => set({ provider: event.target.value })}>
            {ADAPTER_PROVIDERS.map((provider) => <option key={provider} value={provider}>{t(`settings.provider.${provider}` as const)}</option>)}
          </Select>
        </Field>
        <Field id="pe-url" label={t('settings.profile.baseUrl')} error={errorText(props.errors.baseUrl)} hint={t('settings.profile.baseUrlHint')}>
          <Input id="pe-url" value={form.baseUrl} placeholder="https://" inputMode="url" spellCheck={false}
            onChange={(event) => set({ baseUrl: event.target.value })} />
        </Field>
        <KeyField form={form} editing={props.editing} error={errorText(props.errors.apiKey)} onChange={(apiKey) => set({ apiKey })} />
        <Field id="pe-model" label={t('settings.profile.model')} error={errorText(props.errors.model)}>
          <Input id="pe-model" list="pe-models" value={form.model} spellCheck={false} onChange={(event) => set({ model: event.target.value })} />
          <datalist id="pe-models">{models.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</datalist>
        </Field>
        <Field id="pe-window" label={t('settings.field.contextWindow')} error={errorText(props.errors.contextWindow)} hint={t('settings.hint.autoAllowed')}>
          <Input id="pe-window" value={form.contextWindow} inputMode="numeric" onChange={(event) => set({ contextWindow: event.target.value })} />
        </Field>
      </div>

      <div className="pe-actions">
        <Button size="sm" onClick={() => void check.discover(draft)} disabled={check.discovery.state === 'busy'}>
          {check.discovery.state === 'busy' ? t('settings.conn.discovering') : t('settings.conn.discover')}
        </Button>
        <Button size="sm" onClick={() => void check.runTest(draft)} disabled={check.test.state === 'busy' || form.model.trim() === ''}>
          {t('settings.conn.test')}
        </Button>
        {check.discovery.state === 'done' ? <span className="set-status" role="status">{t('settings.conn.found', { n: models.length })}</span> : null}
        {check.discovery.state === 'error' ? <span className="set-error" role="alert">{check.discovery.message}</span> : null}
      </div>
      <ConnectionResult test={check.test} />
      {props.failure ? <p className="set-error" role="alert">{props.failure}</p> : null}
    </Dialog>
  );
}
