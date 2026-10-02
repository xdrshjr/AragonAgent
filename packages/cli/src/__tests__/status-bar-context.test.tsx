/**
 * The status bar's right cluster: the width ladder and the two approximation
 * markers (context-usage-gauge-accuracy §7.1, T15-T17).
 *
 * `~` AND `?` ARE ABOUT DIFFERENT NUMBERS AND ARE TESTED INDEPENDENTLY. One
 * glyph used to carry three meanings - the window is a guess, the occupancy is a
 * guess, the occupancy contains an appended-message estimate - so a user who
 * distrusted the bar could not tell which half to distrust. All four
 * combinations are asserted below, because a single combined assertion is
 * satisfied by an implementation that still conflates them.
 *
 * THE FIXTURE USES A SHORT MODEL NAME ON PURPOSE. The left cluster is
 * `flexShrink={0}`, so at 72 columns a full `anthropic:claude-sonnet-4-5` leaves
 * the right cluster over-subscribed and yoga drops characters off the end - the
 * PRE-EXISTING degradation the `StatusBar` header describes, not something this
 * feature introduced (the old `1.2M^ 48k v` readout occupied the same columns at
 * the same breakpoint). These rows are about WHICH READOUTS APPEAR at each rung,
 * so the fixture keeps the left cluster out of the way rather than pinning a
 * threshold to one model's name length.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { render as inkRender } from 'ink';
import stripAnsi from 'strip-ansi';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { ContextUsageSnapshot } from '../compaction/types.js';

const ASCII: TermCapabilities = { unicode: false, colorLevel: 0 };
const theme = getTheme('cool', ASCII);

function context(over: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    occupied: 86_000,
    window: 200_000,
    pct: 43,
    source: 'usage',
    deltaTokens: 0,
    windowKnown: true,
    windowOverridden: false,
    ...over,
  };
}

/**
 * Render the bar at a given width.
 *
 * `ink-testing-library` HARDCODES `columns` AT 100, so the ladder is driven
 * through Ink's own `render` with a stdout we control - the pattern
 * `team-panel.test.tsx` already uses for exactly this reason.
 */
function bar(cols: number, over: Partial<ContextUsageSnapshot> = {}): string {
  const stdout = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (s: string) => void;
  };
  let last = '';
  stdout.columns = cols;
  stdout.rows = 40;
  stdout.write = (s: string) => {
    last = s;
  };
  const instance = inkRender(
    <StatusBar
      model="m"
      provider="p"
      usageTotal={{
        inputTokens: 1_200_000,
        outputTokens: 48_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 3.21,
      }}
      context={context(over)}
      status="idle"
      elapsedMs={0}
      thinkingLevel="off"
      tokPerSec={0}
      theme={theme}
      caps={ASCII}
    />,
    { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
  );
  const out = stripAnsi(last);
  instance.unmount();
  return out;
}

describe('T15 - the width ladder', () => {
  it('cols 60: percentage and cost only', () => {
    const frame = bar(60);
    expect(frame).toContain('43%');
    expect(frame).not.toContain('86.0k/200.0k');
    expect(frame).not.toContain('total');
  });

  it('cols 72: the absolute pair appears', () => {
    const frame = bar(72);
    expect(frame).toContain('86.0k/200.0k');
    // The session total does NOT come back yet: the pair took its columns, which
    // is the ordering decision (D-6). "How full am I, out of how much" is the
    // question the gauge is asked; "what has this session spent" is a different
    // one, and it is the one users misread as an occupancy.
    expect(frame).not.toContain('total');
  });

  it('cols 96: the session total returns, prefixed', () => {
    const frame = bar(96);
    expect(frame).toContain('86.0k/200.0k');
    // AN ASCII WORD, NOT A SIGMA: `ui/**` is inside the glyph scanner's scope,
    // so a new symbol would need a `glyphs.ts` entry with an ASCII fallback.
    expect(frame).toContain('total 1.2M');
  });
});

describe('T16 - the two markers are independent', () => {
  it('`~` marks the NUMERATOR, `?` marks the DENOMINATOR', () => {
    // measured + known window: neither marker.
    const clean = bar(96);
    expect(clean).toContain(' 43%');
    expect(clean).not.toContain('~43%');
    expect(clean).not.toContain('200.0k?');

    // estimated occupancy, known window: `~` only.
    const estimated = bar(96, { source: 'estimate' });
    expect(estimated).toContain('~43%');
    expect(estimated).not.toContain('200.0k?');

    // measured occupancy, invented window: `?` only... and `~` too, because an
    // unknown denominator has always widened the percentage marker and this
    // feature does not narrow it (AC-9 keeps the existing shape).
    const unknownWindow = bar(96, { windowKnown: false });
    expect(unknownWindow).toContain('200.0k?');
    expect(unknownWindow).toContain('~43%');

    // both.
    const both = bar(96, { source: 'estimate', windowKnown: false });
    expect(both).toContain('~43%');
    expect(both).toContain('200.0k?');
  });

  it('an appended-message delta alone makes the percentage approximate', () => {
    // `deltaTokens > 0` is the measured branch's own admission that part of the
    // figure is a guess about messages no request has carried yet.
    const frame = bar(96, { source: 'usage', deltaTokens: 4_000 });
    expect(frame).toContain('~43%');
  });
});

describe('T17 - an override removes BOTH markers (I-6)', () => {
  it('a user-supplied window is known, so nothing is hedged', () => {
    const frame = bar(96, { windowKnown: true, windowOverridden: true, window: 1_000_000 });
    expect(frame).toContain('86.0k/1.0M');
    expect(frame).not.toContain('1.0M?');
    expect(frame).not.toContain('~43%');
  });
});
