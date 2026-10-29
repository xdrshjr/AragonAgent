/**
 * Inspector > Changes: every file the session edited, with a diff for the selected one.
 *
 * The list is derived from the transcript (`aggregateChanges`) and deferred, so a streaming
 * answer re-renders the transcript without recomputing this on every token. A diff comes from
 * the tool entry itself when it still carries one; otherwise it is requested with
 * `file-patch.get` (the host hands that patch out once, so a refusal is shown, not hidden).
 */

import { ExternalLink } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import type { FilePatch } from '@aragon-agent/tui/model/tools/patch';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { aggregateChanges, type ChangedFile } from '../lib/panels-changes.js';
import { useSession } from '../store/session-store.js';
import { IconButton } from '../ui/primitives.js';
import { PanelEmpty, PanelError, usePanelCommand } from './PanelBits.js';
import { PatchView } from './PatchView.js';

function isFilePatch(value: unknown): value is FilePatch {
  return typeof value === 'object' && value !== null && Array.isArray((value as FilePatch).hunks);
}

export function ChangesPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const entries = useSession(sessionId, (mirror) => mirror?.view?.entries);
  const deferred = useDeferredValue(entries);
  const files = useMemo(() => (deferred ? aggregateChanges(deferred) : []), [deferred]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Record<string, FilePatch>>({});
  const command = usePanelCommand(sessionId);
  const [openNote, setOpenNote] = useState<string | null>(null);

  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const patch = selected ? selected.patch ?? fetched[selected.toolCallId] : undefined;

  const select = async (file: ChangedFile): Promise<void> => {
    setSelectedPath(file.path);
    command.clearError();
    if (file.patch || fetched[file.toolCallId]) return;
    const result = await command.run({ c: 'file-patch.get', toolCallId: file.toolCallId });
    if (result.ok && isFilePatch(result.value)) setFetched((held) => ({ ...held, [file.toolCallId]: result.value as FilePatch }));
  };

  const open = async (file: ChangedFile): Promise<void> => {
    const response = await ipc('native:open-path', { sessionId, relPath: file.path });
    setOpenNote(response.ok && response.value.opened ? null : t('workspace.changes.openFailed'));
  };

  if (files.length === 0) {
    return <PanelEmpty title={t('workspace.changes.emptyTitle')} body={t('workspace.changes.emptyBody')} />;
  }
  return (
    <div className="panel">
      <ul className="change-list" aria-label={t('workspace.changes.list')}>
        {files.map((file) => (
          <li key={file.path} className="change-row" data-selected={file.path === selectedPath}>
            <button type="button" className="change-main" aria-pressed={file.path === selectedPath} onClick={() => void select(file)}>
              <span className="change-status" data-status={file.status} aria-label={t(file.status === 'A' ? 'workspace.changes.added' : 'workspace.changes.modified')}>
                {file.status}
              </span>
              <span className="change-path selectable" title={file.path}>{file.path}</span>
              <span className="change-stat">{file.patch || file.added + file.removed > 0 ? `+${file.added} −${file.removed}` : ''}</span>
            </button>
            <IconButton size="sm" label={t('workspace.changes.open', { path: file.path })} onClick={() => void open(file)}>
              <ExternalLink size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
      <PanelError message={command.error ?? openNote} />
      {selected ? (
        patch ? <PatchView patch={patch} /> : command.busy ? <p className="panel-note" role="status">{t('common.loading')}</p>
          : <p className="panel-note">{t('workspace.changes.noDiff')}</p>
      ) : <p className="panel-note">{t('workspace.changes.pick')}</p>}
    </div>
  );
}
