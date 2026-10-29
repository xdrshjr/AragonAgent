/**
 * Kits: named bundles of a main profile, a fast profile and a sub-agent model choice. Kits live
 * in the profile library (shared with the terminal). Applying one affects the ACTIVE session
 * only, through the host; creating, copying and deleting edit the library.
 */

import { Copy, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n/index.js';
import { commandFailureText } from '../lib/panels-format.js';
import { addKit, copyKit, removeKit, type KitDraft } from '../lib/settings-profiles.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { useConfig } from '../store/config-store.js';
import { useUi } from '../store/ui-store.js';
import { Dialog } from '../ui/overlay.js';
import { Button, IconButton, Input, Select } from '../ui/primitives.js';
import type { LibraryEditor } from './use-library-editor.js';

const EMPTY_DRAFT: KitDraft = { name: '', mainProfileId: '', fastProfileId: '' };

function NewKitDialog(props: { entries: { id: string; name: string }[]; library: LibraryEditor; onClose(): void }) {
  const t = useT();
  const [draft, setDraft] = useState<KitDraft>({ ...EMPTY_DRAFT, mainProfileId: props.entries[0]?.id ?? '' });
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setProblem(null);
    const saved = await props.library.commit((current) => {
      const result = addKit(current, draft);
      if (!result.ok) { setProblem(t(`settings.kits.error.${result.reason}` as const)); return null; }
      return result.library;
    });
    if (saved) props.onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }} title={t('settings.kits.newTitle')}
      actions={<>
        <Button variant="ghost" onClick={props.onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={props.library.busy} onClick={() => void save()}>{t('common.save')}</Button>
      </>}>
      <div className="pe-grid">
        <div className="pe-field">
          <label className="label" htmlFor="kit-name">{t('settings.kits.name')}</label>
          <Input id="kit-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </div>
        <div className="pe-field">
          <label className="label" htmlFor="kit-main">{t('settings.models.mainModel')}</label>
          <Select id="kit-main" value={draft.mainProfileId} onChange={(event) => setDraft({ ...draft, mainProfileId: event.target.value })}>
            {props.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </Select>
        </div>
        <div className="pe-field">
          <label className="label" htmlFor="kit-fast">{t('settings.models.fastModel')}</label>
          <Select id="kit-fast" value={draft.fastProfileId} onChange={(event) => setDraft({ ...draft, fastProfileId: event.target.value })}>
            <option value="">{t('settings.kits.noFast')}</option>
            {props.entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </Select>
        </div>
      </div>
      {problem ? <p className="set-error" role="alert">{problem}</p> : null}
    </Dialog>
  );
}

export function KitList({ library }: { library: LibraryEditor }) {
  const t = useT();
  const profiles = useConfig((state) => state.result?.view?.modelProfiles ?? null);
  const activeId = useUi((state) => state.activeSessionId);
  const ready = useSession(activeId, (mirror) => mirror?.phase === 'ready');
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const kits = profiles?.kits ?? [];
  const nameOf = (id: string | null): string => profiles?.entries.find((entry) => entry.id === id)?.name ?? t('common.none');

  const run = async (cmd: { c: 'kit.apply'; kitId: string } | { c: 'kit.clear' }): Promise<void> => {
    if (!activeId) return;
    const result = await sessionStore.command(activeId, cmd);
    setNote(result.ok ? t('settings.kits.applied') : commandFailureText(t, result));
  };

  return (
    <section className="set-card" aria-labelledby="kits-title">
      <header className="set-card-head">
        <h3 id="kits-title">{t('settings.kits.title')}</h3>
        <Button size="sm" disabled={!profiles || profiles.entries.length === 0 || library.busy} onClick={() => setCreating(true)}>
          {t('settings.kits.new')}
        </Button>
      </header>
      <p className="set-desc">{t('settings.kits.desc')}</p>
      {note ? <p className="set-status" role="status">{note}</p> : null}
      {kits.length === 0 ? <p className="set-empty">{t('settings.kits.empty')}</p> : (
        <ul className="mp-list">
          {kits.map((kit) => (
            <li key={kit.id} className="mp-row">
              <div className="mp-main">
                <strong className="mp-name">{kit.name}</strong>
                <span className="mp-sub">{t('settings.kits.summary', { main: nameOf(kit.mainProfileId), fast: nameOf(kit.fastProfileId) })}</span>
              </div>
              <div className="mp-actions">
                <Button size="sm" variant="ghost" disabled={!ready} title={ready ? undefined : t('settings.kits.needSession')}
                  onClick={() => void run({ c: 'kit.apply', kitId: kit.id })}>{t('settings.kits.apply')}</Button>
                <IconButton size="sm" label={t('settings.models.copy')} disabled={library.busy}
                  onClick={() => void library.commit((current) => copyKit(current, kit.id))}><Copy size={14} /></IconButton>
                <IconButton size="sm" label={t('settings.models.delete')} disabled={library.busy}
                  onClick={() => void library.commit((current) => removeKit(current, kit.id))}><Trash2 size={14} /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {kits.length > 0 ? (
        <div className="set-card-foot">
          <Button size="sm" variant="ghost" disabled={!ready} onClick={() => void run({ c: 'kit.clear' })}>{t('settings.kits.clear')}</Button>
        </div>
      ) : null}
      {creating && profiles ? <NewKitDialog entries={profiles.entries} library={library} onClose={() => setCreating(false)} /> : null}
    </section>
  );
}
