/**
 * Token + cost accounting derived from `TokenUsage` and `ModelInfo.cost`
 * (which is expressed in USD per 1M tokens). See spec §6.2 status bar.
 */

import type { ModelCost, TokenUsage } from '@aragon-agent/core';

/** Compute the USD cost of a single `TokenUsage` given a model's cost table. */
export function computeCost(usage: TokenUsage, cost?: ModelCost): number {
  if (!cost) return 0;
  const perM = (tokens: number, rate: number | undefined) =>
    rate ? (tokens / 1_000_000) * rate : 0;
  return (
    perM(usage.inputTokens, cost.input) +
    perM(usage.outputTokens, cost.output) +
    perM(usage.cacheReadTokens ?? 0, cost.cacheRead) +
    perM(usage.cacheWriteTokens ?? 0, cost.cacheWrite)
  );
}

/** Format a USD amount for the status bar (`$0.0000`, or `$1.23` when large). */
export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format a token count compactly (`1.2k`, `3.4M`). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a millisecond duration compactly (`820ms`, `3.4s`, `1m02s`). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${String(rem).padStart(2, '0')}s`;
}
