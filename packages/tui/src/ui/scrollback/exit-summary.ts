/**
 * Exit summary for native-scroll mode (tui-native-terminal-scroll §4.8 / D9).
 *
 * The conversation is already in the terminal's scrollback, so exit does NOT replay
 * it (that would print every message twice). It prints at most four short lines and
 * leaves the cursor on a fresh line.
 *
 * PURE and ASCII-safe: glyphs come from `pickGlyphs`, and the figures come from the
 * same `formatSessionStats` the full-screen replay uses.
 */

import type { Entry, UsageTotal } from '../../model/agent/reducer.js';
import { formatDuration } from '../../model/agent/usage.js';
import type { Glyphs } from '../glyphs.js';
import { formatSessionStats } from '../transcript-text.js';
import { SCROLLBACK_LIMITS } from './limits.js';

export interface ExitSummaryInput {
  entries: readonly Entry[];
  usageTotal: UsageTotal;
  provider: string;
  model: string;
  elapsedMs: number;
  /** The session id, when this process has one worth resuming. */
  sessionId?: string;
  glyphs: Pick<Glyphs, 'midDot' | 'arrowUp' | 'arrowDown'>;
}

export function buildExitSummary(input: ExitSummaryInput): string[] {
  const { glyphs: g } = input;
  const stats = formatSessionStats(input.entries, input.usageTotal, g);
  const rows = [
    ['Session ended', `${input.provider}:${input.model}`, formatDuration(Math.max(0, input.elapsedMs))]
      .join(` ${g.midDot} `),
    [stats.turns, stats.tokens, stats.cost].join(` ${g.midDot} `),
  ];
  if (input.sessionId) rows.push(`Resume: aragon --resume ${input.sessionId}`);
  return rows.slice(0, SCROLLBACK_LIMITS.exitSummaryMaxRows);
}
