import { describe, expect, it } from 'vitest';
import type { Entry, UsageTotal } from '../model/agent/reducer.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { buildExitSummary } from '../ui/scrollback/exit-summary.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import { renderTranscriptText } from '../ui/transcript-text.js';

const USAGE: UsageTotal = {
  inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0123,
};
const ENTRIES: Entry[] = [
  { id: 'e1', kind: 'user', text: 'hi' },
  { id: 'e2', kind: 'user', text: 'again' },
];
const ASCII = pickGlyphs({ colorLevel: 0, unicode: false });

describe('buildExitSummary', () => {
  const base = {
    entries: ENTRIES, usageTotal: USAGE, provider: 'anthropic', model: 'm', elapsedMs: 65_000,
    glyphs: ASCII,
  };

  it('is at most four rows and pure ASCII on an ASCII terminal', () => {
    const rows = buildExitSummary({ ...base, sessionId: 'abc123' });
    expect(rows.length).toBeLessThanOrEqual(SCROLLBACK_LIMITS.exitSummaryMaxRows);
    for (const row of rows) expect(row).toMatch(/^[\x20-\x7e]*$/);
  });

  it('names the model, the elapsed time and how to resume', () => {
    const rows = buildExitSummary({ ...base, sessionId: 'abc123' });
    expect(rows[0]).toContain('Session ended');
    expect(rows[0]).toContain('anthropic:m');
    expect(rows[0]).toContain('1m');
    expect(rows.at(-1)).toBe('Resume: aragon --resume abc123');
  });

  it('omits the resume row when there is no session id', () => {
    const rows = buildExitSummary(base);
    expect(rows.some((row) => row.startsWith('Resume:'))).toBe(false);
  });

  it('uses the same figures as the full-screen replay footer (one implementation)', () => {
    const rows = buildExitSummary(base);
    const footer = renderTranscriptText(ENTRIES, {
      glyphs: ASCII, usageTotal: USAGE, provider: 'anthropic', model: 'm', elapsedMs: 65_000,
    }).split('\n')[0]!;
    // "2 turns - 1.2k^ 340v - $0.0123": every figure of row two appears in the footer.
    for (const part of rows[1]!.split(` ${ASCII.midDot} `)) expect(footer).toContain(part);
  });
});
