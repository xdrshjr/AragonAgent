/**
 * The keyboard shortcut sheet (`?` outside text fields, Ctrl/Cmd+/): the desktop bindings and,
 * beside them, what each terminal key does here. Both lists come from data
 * (`lib/settings-shortcuts.ts`, `shared/parity-matrix.ts`), not from prose, so the sheet cannot
 * drift from the keys the shell actually wires. `Cmd` on macOS, `Ctrl` elsewhere.
 */

import { platform } from '../api.js';
import { useT } from '../i18n/index.js';
import { DESKTOP_SHORTCUTS, terminalKeyRows } from '../lib/settings-shortcuts.js';
import { KeyCombo } from '../settings/KeyCombo.js';
import { useUi } from '../store/ui-store.js';
import { Dialog } from '../ui/overlay.js';
import { Button, Kbd } from '../ui/primitives.js';
import './palette.css';

export function ShortcutSheet() {
  const t = useT();
  const open = useUi((state) => state.shortcutsOpen);
  const setOpen = useUi((state) => state.setShortcutsOpen);
  const isMac = platform() === 'darwin';
  return (
    <Dialog open={open} onOpenChange={setOpen} size="lg" title={t('workspace.keys.title')}
      actions={<Button onClick={() => setOpen(false)}>{t('common.close')}</Button>}>
      <div className="shortcuts-grid">
        <section aria-labelledby="sheet-desktop">
          <h3 id="sheet-desktop">{t('workspace.keys.desktop')}</h3>
          <ul className="shortcuts-list">
            {DESKTOP_SHORTCUTS.map((shortcut) => (
              <li key={shortcut.combo}><span>{t(shortcut.labelKey)}</span><KeyCombo combo={shortcut.combo} isMac={isMac} /></li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="sheet-terminal">
          <h3 id="sheet-terminal">{t('workspace.keys.terminal')}</h3>
          <ul className="shortcuts-list">
            {terminalKeyRows().map((row) => (
              <li key={row.id}>
                <span>{row.labelKey ? t(row.labelKey) : t('common.unknown')}</span>
                {row.notApplicable ? <span className="hint">{row.id}</span> : <Kbd>{row.id}</Kbd>}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
