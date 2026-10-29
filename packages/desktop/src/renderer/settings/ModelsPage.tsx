/**
 * Settings > Models: the profile library, the main/fast bindings, generation defaults and kits.
 *
 * A profile's API key is write-only here: the list shows presence, source and the last four
 * characters; the editor can reveal the stored key for 30 seconds on request. Every change is
 * one `modelProfiles` patch (see `use-library-editor`), so a half-applied library cannot exist.
 */

import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useT, type Translate } from '../i18n/index.js';
import {
  applyProfile, bindRole, checkProfileForm, copyProfile, deleteProfile, emptyProfileForm,
  formFromProfile, maskedLibrary, type FormErrors, type ProfileForm,
} from '../lib/settings-profiles.js';
import { SECTIONS } from '../lib/settings-sections.js';
import { useConfig } from '../store/config-store.js';
import type { MaskedKey, MaskedProfile } from '../../shared/config-view.js';
import { Dialog } from '../ui/overlay.js';
import { Badge, Button, IconButton, Select } from '../ui/primitives.js';
import { KitList } from './KitList.js';
import { ProfileEditor } from './ProfileEditor.js';
import { SectionForm } from './SectionForm.js';
import { useLibraryEditor, type LibraryFailure } from './use-library-editor.js';

export function KeyBadge({ keyInfo }: { keyInfo: MaskedKey | undefined }) {
  const t = useT();
  if (!keyInfo?.present) return <Badge tone="danger">{t('settings.key.badge.none')}</Badge>;
  if (keyInfo.source === 'env') return <Badge tone="info">{t('settings.key.badge.env')}</Badge>;
  return <Badge>{t('settings.key.badge.file', { tail: keyInfo.tail })}</Badge>;
}

export function failureText(t: Translate, failure: LibraryFailure): string {
  if (failure.kind === 'key_unavailable') return t('settings.models.error.key_unavailable', { profile: failure.profile });
  if (failure.kind === 'invalid') return t('settings.models.error.invalid');
  return t('settings.error.save', { code: failure.code });
}

interface EditorState {
  editing: MaskedProfile | null;
  initial: ProfileForm;
}

function ProfileRow(props: {
  profile: MaskedProfile; isMain: boolean; isFast: boolean; busy: boolean;
  onEdit(): void; onCopy(): void; onDelete(): void; onUseAsMain(): void;
}) {
  const t = useT();
  const { profile } = props;
  return (
    <li className="mp-row">
      <div className="mp-main">
        <strong className="mp-name">{profile.name}</strong>
        <span className="mp-sub selectable">{profile.provider} · {profile.model}{profile.baseUrl ? ` · ${profile.baseUrl}` : ''}</span>
      </div>
      <div className="mp-badges">
        {props.isMain ? <Badge tone="brand">{t('settings.models.role.main')}</Badge> : null}
        {props.isFast ? <Badge tone="info">{t('settings.models.role.fast')}</Badge> : null}
        <KeyBadge keyInfo={profile.key} />
      </div>
      <div className="mp-actions">
        {!props.isMain ? <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onUseAsMain}>{t('settings.models.useAsMain')}</Button> : null}
        <IconButton size="sm" label={t('settings.models.edit')} disabled={props.busy} onClick={props.onEdit}><Pencil size={14} /></IconButton>
        <IconButton size="sm" label={t('settings.models.copy')} disabled={props.busy} onClick={props.onCopy}><Copy size={14} /></IconButton>
        <IconButton size="sm" label={t('settings.models.delete')} disabled={props.busy} onClick={props.onDelete}><Trash2 size={14} /></IconButton>
      </div>
    </li>
  );
}

function BindingSelect(props: {
  id: string; label: string; value: string; entries: MaskedProfile[]; busy: boolean; onChange(id: string): void;
}) {
  const t = useT();
  return (
    <div className="mp-bind">
      <label htmlFor={props.id}>{props.label}</label>
      <Select id={props.id} value={props.value} disabled={props.busy} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">{t('settings.models.unbound')}</option>
        {props.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </Select>
    </div>
  );
}

export function ModelsPage() {
  const t = useT();
  const view = useConfig((state) => state.result?.view ?? null);
  const library = useLibraryEditor();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [removing, setRemoving] = useState<MaskedProfile | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const profiles = view?.modelProfiles ?? null;
  const entries = profiles?.entries ?? [];
  const closeEditor = (): void => { setEditor(null); setErrors({}); library.clearFailure(); };

  const submit = async (form: ProfileForm): Promise<void> => {
    const found = checkProfileForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const id = editor?.editing?.id ?? null;
    const saved = await library.commit((current) => {
      const result = applyProfile(current, id, form);
      if (!result.ok) { setErrors(result.errors); return null; }
      // The first profile becomes the main model: a library with none bound is not usable.
      return current.mainId === null ? bindRole(result.library, 'main', result.id) : result.library;
    });
    if (saved) closeEditor();
  };

  const confirmRemove = async (): Promise<void> => {
    const target = removing;
    if (!target) return;
    const check = deleteProfile(maskedLibrary(view), target.id);
    setRemoving(null);
    if (!check.ok) {
      setBlocked(check.reason === 'bound' ? t('settings.models.blockedBound', { name: target.name })
        : t('settings.models.blockedKits', { name: target.name, kits: check.kits.join(', ') }));
      return;
    }
    await library.commit((current) => {
      const result = deleteProfile(current, target.id);
      return result.ok ? result.library : null;
    });
  };

  return (
    <div className="set-page">
      <section className="set-card" aria-labelledby="mp-title">
        <header className="set-card-head">
          <h3 id="mp-title">{t('settings.models.profiles')}</h3>
          <Button size="sm" variant="primary" disabled={library.busy || view === null}
            onClick={() => setEditor({ editing: null, initial: emptyProfileForm() })}>
            <Plus size={14} aria-hidden="true" /> {t('settings.models.add')}
          </Button>
        </header>
        <p className="set-desc">{t('settings.models.desc')}</p>
        {library.failure ? <p className="set-error" role="alert">{failureText(t, library.failure)}</p> : null}
        {blocked ? <p className="set-error" role="alert">{blocked}</p> : null}
        {entries.length === 0 && view ? (
          <div className="set-empty">
            <p>{t('settings.models.empty')}</p>
            <p className="mp-legacy selectable">{t('settings.models.current', { model: `${view.provider}:${view.model}` })} <KeyBadge keyInfo={view.apiKeys[view.provider]} /></p>
          </div>
        ) : (
          <ul className="mp-list">
            {entries.map((profile) => (
              <ProfileRow key={profile.id} profile={profile} busy={library.busy}
                isMain={profiles?.mainId === profile.id} isFast={profiles?.fastId === profile.id}
                onEdit={() => setEditor({ editing: profile, initial: formFromProfile(profile) })}
                onCopy={() => void library.commit((current) => copyProfile(current, profile.id))}
                onDelete={() => { setBlocked(null); setRemoving(profile); }}
                onUseAsMain={() => void library.commit((current) => bindRole(current, 'main', profile.id))} />
            ))}
          </ul>
        )}
        {entries.length > 0 ? (
          <div className="mp-bindings">
            <BindingSelect id="mp-main" label={t('settings.models.mainModel')} value={profiles?.mainId ?? ''} entries={entries} busy={library.busy}
              onChange={(id) => void library.commit((current) => bindRole(current, 'main', id || null))} />
            <BindingSelect id="mp-fast" label={t('settings.models.fastModel')} value={profiles?.fastId ?? ''} entries={entries} busy={library.busy}
              onChange={(id) => void library.commit((current) => bindRole(current, 'fast', id || null))} />
          </div>
        ) : null}
      </section>

      <SectionForm section={SECTIONS.modelDefaults} />
      <KitList library={library} />

      {editor ? (
        <ProfileEditor key={editor.editing?.id ?? 'new'} editing={editor.editing ? { id: editor.editing.id, key: editor.editing.key } : null}
          initial={editor.initial} errors={errors} saving={library.busy}
          failure={library.failure ? failureText(t, library.failure) : null}
          onSubmit={(form) => void submit(form)} onClose={closeEditor} />
      ) : null}

      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={t('settings.models.deleteTitle')} description={t('settings.models.deleteBody', { name: removing?.name ?? '' })}
        actions={<>
          <Button variant="ghost" autoFocus onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => void confirmRemove()}>{t('common.delete')}</Button>
        </>}>
        <p className="selectable">{removing?.provider} · {removing?.model}</p>
      </Dialog>
    </div>
  );
}
