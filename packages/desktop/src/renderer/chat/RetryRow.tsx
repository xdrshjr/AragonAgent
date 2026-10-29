/** `retry` entries: a live countdown while waiting, a quiet history line once settled. */

import { RefreshCw } from 'lucide-react';
import { memo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { secondsLeft } from '@aragon-agent/tui/model/agent/retry-view';
import { useT } from '../i18n/index.js';
import { useNow } from './hooks.js';

type RetryEntry = Extract<Entry, { kind: 'retry' }>;

const REASONS = ['rate_limit', 'overloaded', 'server_error', 'network_error', 'timeout'] as const;
type Reason = (typeof REASONS)[number] | 'other';

function reasonOf(errorType: string): Reason {
  return (REASONS as readonly string[]).includes(errorType) ? (errorType as Reason) : 'other';
}

export const RetryRow = memo(function RetryRow({ entry }: { entry: RetryEntry }) {
  const t = useT();
  const live = entry.phase === 'waiting' || entry.phase === 'retrying';
  // The timer exists only while a retry is actually pending (a settled row owns none).
  const now = useNow(live && entry.phase === 'waiting');
  const reason = t(`chat.retry.reason.${reasonOf(entry.errorType)}` as const);
  const params = { reason, attempt: entry.attempt, max: entry.maxRetries, n: entry.totalRetries ?? entry.attempt };
  let text: string;
  switch (entry.phase) {
    case 'waiting': text = t('chat.retry.waiting', { ...params, s: secondsLeft(entry.resumeAt, now) }); break;
    case 'retrying': text = t('chat.retry.retrying', params); break;
    case 'recovered': text = t('chat.retry.recovered', params); break;
    case 'exhausted': text = t('chat.retry.exhausted', params); break;
    default: text = t('chat.retry.interrupted', params);
  }
  return (
    <div className="retry" data-live={live ? 'true' : undefined} data-phase={entry.phase}>
      <RefreshCw size={14} strokeWidth={1.5} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
});
