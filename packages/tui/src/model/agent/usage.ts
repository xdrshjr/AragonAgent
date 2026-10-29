/**
 * Token + cost accounting derived from `TokenUsage` and `ModelInfo.cost`
 * (which is expressed in USD per 1M tokens). See spec §6.2 status bar.
 */

import type { ModelCost, TokenUsage } from '@aragon-agent/core';
import type { UsageTotal } from './reducer.js';

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

/**
 * Fold one `TokenUsage` into a running session total
 * (context-usage-gauge-accuracy §3.6 / W5).
 *
 * THE ONE ADDITION SITE, and collapsing four hand-written copies into it is the
 * point rather than a tidy-up. The reducer had the same three lines in four
 * branches - `turnEnd`, `teamUsage`, `fastUsage`, `compactionUsage` - and all
 * four silently omitted the cache terms, so the status bar's `^` read LOWER than
 * the `$` beside it on any session behind a caching gateway. A fifth source
 * added later would have made the identical omission; now it cannot.
 *
 * `costDelta` IS PRECOMPUTED BY THE CALLER, exactly as the four branches already
 * required: the summarizer and the fast tier may be different models with
 * different price tables, and a reducer that priced its own would have to know
 * about three of them.
 */
export function addUsage(total: UsageTotal, usage: TokenUsage, costDelta: number): UsageTotal {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    costUsd: total.costUsd + costDelta,
  };
}

/**
 * The number the status bar's `^` shows: the PROMPT side of the session total.
 *
 * DELIBERATELY THE SAME TERMS AS `occupiedTokens` MINUS `outputTokens`
 * (`compaction/pressure.ts`). Anthropic reports `input_tokens` EXCLUDING cached
 * tokens and puts them in two separate fields, so `inputTokens` alone
 * under-reports for anyone behind a caching gateway - while `computeCost` above
 * has always priced all three. That is the "three units on one row" defect
 * (P1-3): the percentage counted cache, the dollars counted cache, and the arrow
 * did not.
 *
 * `$` IS STILL NOT THE SAME TOTAL, and the distinction is worth keeping straight
 * (RV-14): `computeCost` also prices OUTPUT tokens. What this function asserts is
 * narrower and exact - both cache terms are counted, on both sides.
 */
export function promptTokensOf(total: UsageTotal): number {
  return total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens;
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
