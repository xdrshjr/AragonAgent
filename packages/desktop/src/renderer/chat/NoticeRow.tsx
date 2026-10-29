/** `notice` entries, with Copy and - for errors the engine words in a known way - action buttons. */

import { AlertTriangle, Check, Copy, Info, XCircle } from 'lucide-react';
import { memo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { classifyErrorNotice, type ErrorAction } from '../lib/chat-errors.js';
import { Button } from '../ui/primitives.js';
import { useCopy } from './hooks.js';

type NoticeEntry = Extract<Entry, { kind: 'notice' }>;

const ICONS = { info: Info, warn: AlertTriangle, error: XCircle } as const;

export const NoticeRow = memo(function NoticeRow(props: {
  entry: NoticeEntry;
  /** Offer retry / compact-and-retry (only meaningful for the newest failure, and when safe). */
  canRetry: boolean;
  onAction(action: ErrorAction): void;
}) {
  const t = useT();
  const { entry } = props;
  const { copied, copy } = useCopy();
  const Icon = ICONS[entry.level];
  const classified = entry.level === 'error' ? classifyErrorNotice(entry.text) : null;
  const actions = (classified?.actions ?? []).filter((action) => action === 'open-models' || props.canRetry);
  return (
    <div className="notice" data-level={entry.level} role={entry.level === 'error' ? 'alert' : undefined}>
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" className="notice-icon" />
      <div className="notice-main">
        <span className="sr-only">{t(`chat.notice.${entry.level}` as const)}: </span>
        <span className="notice-text selectable">{entry.text}</span>
        {entry.level === 'error' ? (
          <div className="notice-actions">
            {actions.map((action, index) => (
              <Button key={action} size="sm" variant={index === 0 ? 'primary' : 'default'} onClick={() => props.onAction(action)}>
                {t(`chat.error.action.${action}` as const)}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => copy(entry.text)}>
              {copied ? <Check size={14} strokeWidth={1.5} /> : <Copy size={14} strokeWidth={1.5} />}
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
