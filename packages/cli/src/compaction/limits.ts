/** Structural limits for v2 compaction. All character counts are UTF-16 units. */
export const COMPACTION_LIMITS = {
  digestMaxChars: 120_000,
  summarizerReserveTokens: 8_000,
  summaryMaxChars: 32_000,
  summaryOutputTokens: 4_096,
  memoryJsonChars: 32_000,
  memoryEnvelopeChars: 1_024,
  protectedMemoryChars: 48_000,
  memoryItems: 200,
  protectedUserMessages: 200,
  memoryAdditions: 64,
  coverageClips: 200,
  jsonDepth: 32,
  instructionsChars: 4_000,
  itemTextChars: 1_200,
  sourceExcerptChars: 512,
  itemSources: 8,
  toolResultEdgeChars: 1_500,
  operationTimeoutMs: 120_000,
  callTimeoutMs: 45_000,
  minTurnsBetween: 2,
  maxPerRun: 5,
  minReclaimRatio: 0.15,
  stuckLimit: 2,
  // Legacy capacity helpers remain callable, but v2 never mutates retained tails.
  tailToolResultChars: 2_000,
  blockAllowanceTokens: 2_000,
  archiveMaxFiles: 20,
  archiveMaxAgeMs: 604_800_000,
  archiveMaxBytes: 8_000_000,
  cardTextRows: 6,
  statusCompactCols: 100,
} as const;

export const COMPACTION_BLOCK_VERSION = 'v2-2026-10';
export const ANCHOR_TAG_OPEN = '<original_task>';
export const ANCHOR_TAG_CLOSE = '</original_task>';
export const BLOCK_TAG_OPEN = '<compacted_context';
export const BLOCK_TAG_CLOSE = '</compacted_context>';

/** Retained legacy helper for explicit callers; v2 compression never clips the tail. */
export function tailClipMarker(removed: number): string {
  return `\n[... ${removed} characters removed by context compaction ...]`;
}
