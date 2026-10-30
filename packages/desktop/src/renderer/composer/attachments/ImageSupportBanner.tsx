/**
 * "This model may not read pictures" - said BEFORE sending, not after a 400 (spec 3.6, D-5).
 *
 *   no       warning card, default = send file paths; four ways out; "remember" writes an override
 *   unknown  one muted line, default = send pictures; a link to switch to paths, "don't ask again"
 *   yes      nothing
 *
 * A `no` card never disappears while there are pictures and no decision: after a choice it
 * shrinks to one reversible line, so the user can always see (and change) what will happen.
 * The text reacts to the model: a new snapshot with another `meta.imageInput` re-renders it.
 */

import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { Button, IconButton } from '../../ui/primitives.js';
import { emitComposerIntent } from '../composer-bus.js';
import { dismissHint, setModeChoice } from './attachment-draft-store.js';
import { useImageMode } from './use-image-mode.js';

export function ImageSupportBanner(props: {
  sessionId: string;
  /** Pictures in the tray that would be affected (not counting failed ones). */
  imageCount: number;
  onRemoveImages(): void;
}) {
  const t = useT();
  const { sessionId } = props;
  const { mode, choice, hintDismissed, input } = useImageMode(sessionId);
  const [remember, setRemember] = useState(false);
  if (props.imageCount === 0 || input.support === 'yes') return null;
  const model = input.model || t('chat.attach.thisModel');

  const choose = (next: 'inline' | 'path'): void => {
    setModeChoice(sessionId, next);
    if (remember) void input.setOverride(next === 'inline' ? 'on' : 'off');
  };

  if (choice !== null) {
    return (
      <div className="att-banner att-banner-line" role="status">
        <span>{mode === 'inline' ? t('chat.attach.sendingImages') : t('chat.attach.sendingPaths')}</span>
        <Button size="sm" variant="ghost" onClick={() => setModeChoice(sessionId, null)}>{t('chat.attach.change')}</Button>
      </div>
    );
  }

  if (input.support === 'unknown') {
    if (hintDismissed) return null;
    return (
      <div className="att-banner att-banner-line" role="status" aria-live="polite">
        <span>{t('chat.attach.unknown', { model })}</span>
        <Button size="sm" variant="ghost" onClick={() => setModeChoice(sessionId, 'path')}>{t('chat.attach.unknownPath')}</Button>
        <Button size="sm" variant="ghost" onClick={() => void input.setOverride('on')}>{t('chat.attach.unknownDont')}</Button>
        <IconButton size="sm" label={t('chat.attach.dismiss')} onClick={() => dismissHint(sessionId)}>
          <X size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="att-banner att-banner-warn" role="alert">
      <div className="att-banner-title">
        <AlertTriangle size={14} strokeWidth={1.5} aria-hidden="true" /> {t('chat.attach.no.title', { model })}
      </div>
      <p className="att-banner-body">{t('chat.attach.no.body')}</p>
      <div className="att-banner-actions">
        <Button size="sm" onClick={() => choose('inline')}>{t('chat.attach.no.sendImages')}</Button>
        <Button size="sm" variant="primary" aria-pressed={mode === 'path'} onClick={() => choose('path')}>
          {t('chat.attach.no.sendPaths')}
        </Button>
        <Button size="sm" onClick={props.onRemoveImages}>{t('chat.attach.no.remove')}</Button>
        <Button size="sm" onClick={() => emitComposerIntent('open-model')}>{t('chat.attach.no.switch')}</Button>
      </div>
      <label className="att-remember">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        {t('chat.attach.no.remember')}
      </label>
    </div>
  );
}
