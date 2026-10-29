/** Small formatting helpers shared by the sidebar and the panels. Pure. */

import type { MessageKey } from '../i18n/index.js';

export type TimeFormatter = (key: MessageKey, params?: Record<string, string | number>) => string;

/** "now", "5m", "3h", "2d": the sidebar's relative time, from a translate function. */
export function relativeTime(at: number, now: number, t: TimeFormatter): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t('shell.time.now');
  if (minutes < 60) return t('shell.time.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('shell.time.hours', { n: hours });
  return t('shell.time.days', { n: Math.floor(hours / 24) });
}

/** Format a token count compactly: 950, 12.3k, 1.2M. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** A dollar amount; sub-cent values keep enough digits to be non-zero. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Elapsed milliseconds as "4.2 s" / "1m 12s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
