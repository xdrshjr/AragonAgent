/**
 * Settings > Prompts: the library manager (create, edit, delete, favourite, import, export)
 * plus the `prompts.*` behaviour switches. The library file is shared with the terminal; every
 * change goes through the main process and the list is re-read afterwards.
 */

import { Pencil, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { exportPrompts, parsePromptImport } from '../prompts/prompt-io.js';
import { usePrompts, type PromptsOutcome } from '../prompts/prompts-store.js';
import { SECTIONS } from '../lib/settings-sections.js';
import type { PromptDraftDto, PromptDto } from '../../shared/ipc-contract.js';
import { Dialog } from '../ui/overlay.js';
import { Button, IconButton } from '../ui/primitives.js';
import { PromptEditor } from './PromptEditor.js';
import { SectionForm } from './SectionForm.js';

type Editing = { prompt: PromptDto | null } | null;

function downloadJson(text: string): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'aragon-prompts.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** `File.text()` is missing from some embedders (and jsdom); a FileReader works everywhere. */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

function PromptRow(props: { prompt: PromptDto; onEdit(): void; onDelete(): void; onFavorite(): void }) {
  const t = useT();
  const { prompt } = props;
  return (
    <li className="mp-row">
      <div className="mp-main">
        <strong className="mp-name">{prompt.title}</strong>
        <span className="mp-sub">{prompt.description || prompt.content.split('\n')[0]}</span>
        {prompt.tags && prompt.tags.length > 0 ? <span className="mp-tags">{prompt.tags.map((tag) => <span key={tag} className="badge">{tag}</span>)}</span> : null}
      </div>
      <div className="mp-actions">
        <IconButton size="sm" label={prompt.favorite ? t('settings.prompts.unfavorite') : t('settings.prompts.favorite')}
          active={prompt.favorite === true} onClick={props.onFavorite}><Star size={14} /></IconButton>
        <IconButton size="sm" label={t('settings.models.edit')} onClick={props.onEdit}><Pencil size={14} /></IconButton>
        <IconButton size="sm" label={t('settings.models.delete')} onClick={props.onDelete}><Trash2 size={14} /></IconButton>
      </div>
    </li>
  );
}

export function PromptsPage() {
  const t = useT();
  const prompts = usePrompts((state) => state.prompts);
  const loaded = usePrompts((state) => state.loaded);
  const listError = usePrompts((state) => state.error);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<PromptDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { void usePrompts.getState().refresh(); }, []);

  const report = (outcome: PromptsOutcome): boolean => {
    setFailure(outcome.ok ? null : `${outcome.message}`);
    return outcome.ok;
  };

  const save = async (draft: PromptDraftDto): Promise<void> => {
    setSaving(true);
    const store = usePrompts.getState();
    const outcome = editing?.prompt ? await store.update(editing.prompt.id, draft) : await store.create(draft);
    setSaving(false);
    if (report(outcome)) setEditing(null);
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setNote(t('settings.prompts.import.unreadable'));
      return;
    }
    const parsed = parsePromptImport(text);
    if (!parsed.ok) { setNote(t(`settings.prompts.import.${parsed.reason}` as const)); return; }
    let imported = 0;
    for (const draft of parsed.drafts) {
      const outcome = await usePrompts.getState().create(draft);
      if (outcome.ok) imported += 1;
      else parsed.skipped += 1;
    }
    setNote(t('settings.prompts.import.done', { imported, skipped: parsed.skipped }));
  };

  const exportAll = (): void => {
    const text = exportPrompts(prompts);
    setNote(downloadJson(text) ? t('settings.prompts.export.done') : t('settings.prompts.export.failed'));
  };
  const copyAll = (): void => {
    void navigator.clipboard?.writeText(exportPrompts(prompts)).then(() => setNote(t('common.copied')), () => setNote(t('settings.prompts.export.failed')));
  };

  return (
    <div className="set-page">
      <section className="set-card" aria-labelledby="pl-title">
        <header className="set-card-head">
          <h3 id="pl-title">{t('settings.prompts.library')}</h3>
          <Button size="sm" variant="primary" onClick={() => { setFailure(null); setEditing({ prompt: null }); }}>{t('settings.prompts.new')}</Button>
        </header>
        <p className="set-desc">{t('settings.prompts.desc')}</p>
        {listError ? <p className="set-error" role="alert">{t('settings.prompts.loadFailed', { message: listError })}</p> : null}
        {failure && !editing ? <p className="set-error" role="alert">{failure}</p> : null}
        {loaded && prompts.length === 0 && !listError ? <p className="set-empty">{t('settings.prompts.empty')}</p> : (
          <ul className="mp-list">
            {prompts.map((prompt) => (
              <PromptRow key={prompt.id} prompt={prompt}
                onEdit={() => { setFailure(null); setEditing({ prompt }); }} onDelete={() => setRemoving(prompt)}
                onFavorite={() => void usePrompts.getState().favorite(prompt.id, prompt.favorite !== true).then(report)} />
            ))}
          </ul>
        )}
        <div className="set-card-foot">
          <span className="set-status" role="status">{note}</span>
          <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1}
            aria-label={t('settings.prompts.importJson')} onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
          <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>{t('settings.prompts.importJson')}</Button>
          <Button size="sm" variant="ghost" disabled={prompts.length === 0} onClick={copyAll}>{t('settings.prompts.copyJson')}</Button>
          <Button size="sm" variant="ghost" disabled={prompts.length === 0} onClick={exportAll}>{t('settings.prompts.export')}</Button>
        </div>
      </section>
      <SectionForm section={SECTIONS.prompts} />

      {editing ? (
        <PromptEditor prompt={editing.prompt} saving={saving} failure={failure} onSave={(draft) => void save(draft)}
          onClose={() => setEditing(null)} />
      ) : null}
      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={t('settings.prompts.deleteTitle')} description={t('settings.prompts.deleteBody', { title: removing?.title ?? '' })}
        actions={<>
          <Button variant="ghost" autoFocus onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => {
            const target = removing;
            setRemoving(null);
            if (target) void usePrompts.getState().remove(target.id).then(report);
          }}>{t('common.delete')}</Button>
        </>}>
        <p className="selectable">{removing?.title}</p>
      </Dialog>
    </div>
  );
}
