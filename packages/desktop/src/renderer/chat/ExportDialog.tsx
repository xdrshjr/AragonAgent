/**
 * "Export as Markdown": two switches and a confirm. The Markdown is built here (the transcript lives
 * in this process); the main process asks where to save it and removes configured secrets. A cancelled
 * save dialog is silent - the user chose not to - but a failed write keeps this dialog open so the
 * choices survive a retry.
 */

import { useState } from 'react';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { basename } from '../lib/chat-format.js';
import { DEFAULT_EXPORT_OPTIONS, transcriptToMarkdown, type ExportOptions } from '../lib/chat-export.js';
import { sessionStore } from '../store/session-store.js';
import { useSessionsList } from '../store/sessions-list-store.js';
import { useUi } from '../store/ui-store.js';
import { Dialog } from '../ui/overlay.js';
import { Button, Switch } from '../ui/primitives.js';
import { pushToast } from './hooks.js';

/** Mirrors the main process limit; checked here first so nothing huge crosses the IPC boundary. */
export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;

export function ExportDialog({ sessionId }: { sessionId: string }) {
  const t = useT();
  const open = useUi((state) => state.exportSessionId === sessionId);
  const setExportSession = useUi((state) => state.setExportSession);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => { setExportSession(null); setError(null); };

  const run = async (): Promise<void> => {
    const mirror = sessionStore.get(sessionId);
    const entries = mirror?.view?.entries ?? [];
    const cwd = mirror?.meta?.cwd;
    const info = await ipc('app:info');
    const title = useSessionsList.getState().rows.find((row) => row.id === sessionId)?.title ?? null;
    const markdown = transcriptToMarkdown(entries, {
      title, appVersion: info.ok ? info.value.versions.desktop : '', exportedAt: new Date().toISOString(),
      sessionId, cwdName: cwd ? basename(cwd) : '',
    }, options);
    if (new Blob([markdown]).size > MAX_EXPORT_BYTES) { setError(t('chat.export.tooLarge')); return; }
    setBusy(true);
    const response = await ipc('session:export', {
      sessionId, suggestedName: title ?? 'conversation', markdown, ...(cwd ? { cwd } : {}),
    });
    setBusy(false);
    if (response.ok) {
      close();
      pushToast(sessionId, 'info', t('chat.export.done', { path: response.value.path }));
      return;
    }
    if (response.code === 'cancelled') return; // the user chose not to save: not an error
    setError(response.code === 'invalid_argument' ? t('chat.export.tooLarge') : t('chat.export.failed'));
  };

  return (
    <Dialog open={open} onOpenChange={(state) => { if (!state) close(); }}
      title={t('chat.export.title')} description={t('chat.export.desc')}
      actions={<>
        <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void run()}>{t('chat.export.confirm')}</Button>
      </>}>
      <div className="export-options">
        <label className="export-row">
          <span>{t('chat.export.toolOutput')}</span>
          <Switch label={t('chat.export.toolOutput')} checked={options.includeToolOutput}
            onCheckedChange={(checked) => setOptions((held) => ({ ...held, includeToolOutput: checked }))} />
        </label>
        <label className="export-row">
          <span>{t('chat.export.thinking')}</span>
          <Switch label={t('chat.export.thinking')} checked={options.includeThinking}
            onCheckedChange={(checked) => setOptions((held) => ({ ...held, includeThinking: checked }))} />
        </label>
        <p className="export-note">{t('chat.export.note')}</p>
        {error ? <p className="export-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}
