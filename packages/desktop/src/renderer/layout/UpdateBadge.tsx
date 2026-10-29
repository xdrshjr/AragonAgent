/** A quiet "version X is available" chip in the title bar. It only exists while an update is on offer. */

import { ArrowUpCircle } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { selectOffer, useUpdates } from '../store/update-store.js';
import { useUi } from '../store/ui-store.js';

export function UpdateBadge() {
  const t = useT();
  const version = useUpdates(selectOffer);
  const openSettings = useUi((state) => state.openSettings);
  if (version === null) return null;
  return (
    <button type="button" className="update-badge" title={t('shell.update.badge', { version })}
      onClick={() => openSettings('updates')}>
      <ArrowUpCircle size={13} strokeWidth={1.5} aria-hidden="true" /> <span>{t('shell.update.badge', { version })}</span>
    </button>
  );
}
