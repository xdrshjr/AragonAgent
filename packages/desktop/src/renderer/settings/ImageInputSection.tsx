/**
 * Settings > General > Image input: the per-model decisions "this model reads pictures" /
 * "this model does not", each with a way to take it back.
 *
 * These are rows in `desktop-state.json` (`imageInputOverrides`, keyed `provider/model`), the same
 * table the composer's banner and the "this model cannot see images" recovery write. Taking a row
 * back also tells every open session that uses that model, so the next message is built from the
 * built-in answer again without having to reopen the session.
 */

import { useT } from '../i18n/index.js';
import { overrideKey, useImageOverrideTable, writeImageOverride } from '../composer/attachments/image-input.js';
import { sessionStore, useSessionList } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';

/** `provider/model` -> a readable pair. The provider never contains a slash; the model may. */
export function splitOverrideKey(key: string): { provider: string; model: string } {
  const at = key.indexOf('/');
  return at < 0 ? { provider: '', model: key } : { provider: key.slice(0, at), model: key.slice(at + 1) };
}

export function ImageInputSection() {
  const t = useT();
  const table = useImageOverrideTable();
  const sessions = useSessionList();
  const rows = Object.entries(table).sort(([a], [b]) => a.localeCompare(b));

  const restore = async (key: string): Promise<void> => {
    await writeImageOverride(key, null);
    // Open sessions on that model: the host was told the old decision and must hear it is gone.
    for (const mirror of sessions) {
      if (mirror.meta && overrideKey(mirror.meta.provider, mirror.meta.model) === key) {
        void sessionStore.command(mirror.id, { c: 'image.override', key, value: null });
      }
    }
  };

  return (
    <section className="set-card" aria-labelledby="img-title">
      <header className="set-card-head"><h3 id="img-title">{t('settings.section.imageInput')}</h3></header>
      <p className="set-desc">{t('settings.imageInput.note')}</p>
      {rows.length === 0 ? (
        <p className="set-hint" role="status">{t('settings.imageInput.empty')}</p>
      ) : (
        <ul className="set-rows" aria-label={t('settings.section.imageInput')}>
          {rows.map(([key, value]) => {
            const { provider, model } = splitOverrideKey(key);
            return (
              <li key={key} className="set-row">
                <div className="set-row-label">
                  <div>{model}</div>
                  <div className="set-hint">
                    {provider ? `${provider} · ` : ''}{t(value === 'off' ? 'settings.imageInput.off' : 'settings.imageInput.on')}
                  </div>
                </div>
                <div className="set-row-control">
                  <Button size="sm" aria-label={t('settings.imageInput.restore', { model })} onClick={() => void restore(key)}>
                    {t('settings.imageInput.restoreShort')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
