/** A collapsed large paste: "Pasted 1,842 lines", expandable to a preview, removable. */

import { ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n/index.js';
import type { PasteChipData } from '../lib/chat-drafts.js';
import { IconButton } from '../ui/primitives.js';

const PREVIEW_CHARS = 6000;

export function PasteChip(props: { chip: PasteChipData; onRemove(): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { chip } = props;
  return (
    <div className="paste-chip" data-open={open ? 'true' : undefined}>
      <div className="paste-chip-bar">
        <button type="button" className="paste-chip-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={14} strokeWidth={1.5} className="chev" aria-hidden="true" />
          <span>{t('chat.paste.label', { n: chip.lines.toLocaleString() })}</span>
        </button>
        <IconButton size="sm" label={t('chat.paste.remove')} onClick={props.onRemove}>
          <X size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
      {open ? (
        <pre className="paste-chip-preview selectable" tabIndex={0}>
          {chip.text.length > PREVIEW_CHARS ? `${chip.text.slice(0, PREVIEW_CHARS)}…` : chip.text}
        </pre>
      ) : null}
    </div>
  );
}
