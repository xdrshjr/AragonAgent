/**
 * What the user sees when two writers meet.
 *
 *  - `ConfigConflictDialog`: a save was REFUSED because the file changed after the form was
 *    read (`useConfig().conflict`). Three choices, never a silent retry: apply my edits on top
 *    of the latest file, discard mine, or look at the differences first.
 *  - `StaleDraftBanner`: the file changed while edits are still unsaved. The edits are kept;
 *    the user reloads, keeps them (rebased onto the new file), or compares.
 *
 * Both are mounted by `SettingsShell`. `ConfigConflictDialog` is exported on its own so the
 * app shell can mount it globally: a conflict raised by a chip outside Settings has no other
 * place to surface.
 */

import { useEffect, useState } from 'react';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { flattenPatch, readPath, resolveSection } from '../lib/settings-draft.js';
import { staleSections, useDrafts } from '../lib/settings-drafts.js';
import { SECTIONS, type SectionId } from '../lib/settings-sections.js';
import { useConfig } from '../store/config-store.js';
import type { ConfigViewDto } from '../../shared/config-view.js';
import { Dialog } from '../ui/overlay.js';
import { Button } from '../ui/primitives.js';

interface DiffRow {
  path: string;
  mine: unknown;
  disk: unknown;
}

function show(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  const t = useT();
  return (
    <table className="set-diff selectable">
      <thead>
        <tr><th scope="col">{t('settings.diff.setting')}</th><th scope="col">{t('settings.diff.mine')}</th><th scope="col">{t('settings.diff.disk')}</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path}><th scope="row">{row.path}</th><td>{show(row.mine)}</td><td>{show(row.disk)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function ConfigConflictDialog() {
  const t = useT();
  const conflict = useConfig((state) => state.conflict);
  const [showDiff, setShowDiff] = useState(false);
  const [disk, setDisk] = useState<ConfigViewDto | null>(null);

  useEffect(() => {
    setShowDiff(false);
    if (!conflict) return undefined;
    let cancelled = false;
    // A fresh read for the comparison only: the store itself is refreshed by the user's choice.
    void ipc('config:get').then((response) => {
      if (!cancelled && response.ok) setDisk(response.value.view);
    });
    return () => { cancelled = true; };
  }, [conflict]);

  const choose = async (choice: 'reload' | 'overwrite'): Promise<void> => {
    await useConfig.getState().resolveConflict(choice);
    if (useConfig.getState().conflict === null) useDrafts.getState().discardAll();
  };

  const rows: DiffRow[] = conflict
    ? flattenPatch(conflict.patch).map((row) => ({ path: row.path, mine: row.value, disk: readPath(disk, row.path) }))
    : [];

  return (
    <Dialog open={conflict !== null} onOpenChange={() => undefined} dismissible={false} size="lg"
      title={t('settings.conflict.title')} description={t('settings.conflict.body')}
      actions={<>
        <Button variant="ghost" onClick={() => setShowDiff((value) => !value)} aria-expanded={showDiff}>{t('settings.conflict.view')}</Button>
        <Button onClick={() => void choose('reload')}>{t('settings.conflict.discard')}</Button>
        <Button variant="primary" onClick={() => void choose('overwrite')}>{t('settings.conflict.apply')}</Button>
      </>}>
      {showDiff ? <DiffTable rows={rows} /> : null}
    </Dialog>
  );
}

export function StaleDraftBanner() {
  const t = useT();
  const revision = useConfig((state) => state.result?.revision);
  const view = useConfig((state) => state.result?.view ?? null);
  const drafts = useDrafts((state) => state.drafts);
  const [showDiff, setShowDiff] = useState(false);
  const stale = staleSections(drafts, revision);
  if (stale.length === 0) return null;

  const rows: DiffRow[] = stale.flatMap((id) => {
    const section = SECTIONS[id as SectionId];
    const patch = section ? resolveSection(section, view, drafts[id]!.edits).patch : null;
    return patch ? flattenPatch(patch).map((row) => ({ path: row.path, mine: row.value, disk: readPath(view, row.path) })) : [];
  });
  const reload = (): void => { for (const id of stale) useDrafts.getState().discard(id); };
  const keep = (): void => { for (const id of stale) useDrafts.getState().rebase(id, revision ?? ''); };

  return (
    <div className="set-stale" role="alert">
      <div className="set-stale-row">
        <strong>{t('settings.stale.title')}</strong>
        <span>{t('settings.stale.body')}</span>
        <span className="set-spacer" />
        <Button size="sm" onClick={reload}>{t('settings.stale.reload')}</Button>
        <Button size="sm" variant="primary" onClick={keep}>{t('settings.stale.keep')}</Button>
        <Button size="sm" variant="ghost" aria-expanded={showDiff} onClick={() => setShowDiff((value) => !value)}>{t('settings.conflict.view')}</Button>
      </div>
      {showDiff ? <DiffTable rows={rows} /> : null}
    </div>
  );
}
