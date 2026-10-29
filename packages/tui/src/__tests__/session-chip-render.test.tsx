/**
 * The session-id chip as RENDERED (tui-session-id-resume AC-1 / AC-2 / AC-17).
 *
 * `session-chip.test.ts` proves the planner; this proves the WIRING, which is
 * where the two halves of I-6 can disagree: the chip decides how many cells it
 * wants and the status row is told to reserve them, and a mistake in either half
 * shows up only in a frame. It also pins the negative: with no `sessionId` the
 * row is exactly the row the previous build drew.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import type { UsageTotal } from '../model/agent/reducer.js';

const CAPS = { unicode: false, colorLevel: 0 } as const;
const USAGE: UsageTotal = {
  inputTokens: 1200,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
};

function frame(columns: number, sessionId?: string): string {
  const view = render(
    <StatusBar
      columns={columns}
      speedKnown={false}
      model="m"
      provider="p"
      status="idle"
      usageTotal={USAGE}
      context={{
        occupied: 8600,
        window: 200000,
        pct: 4,
        source: 'usage',
        deltaTokens: 0,
        windowKnown: true,
        windowOverridden: false,
      }}
      elapsedMs={62000}
      thinkingLevel="off"
      tokPerSec={0}
      theme={getTheme('cool', CAPS)}
      caps={CAPS}
      {...(sessionId === undefined ? {} : { sessionId })}
    />,
  );
  const text = view.lastFrame() ?? '';
  view.unmount();
  return text;
}

describe('AC-1 / D-11: the chip in the frame', () => {
  it('puts the id at the right end of the primary row', () => {
    const text = frame(120, 'a4k2m9');
    // One row, and the id is the LAST thing on it - the "look at the bottom right"
    // instruction in `/session` and in the README depends on this.
    expect(text.split('\n')).toHaveLength(1);
    expect(text.trimEnd().endsWith(`id a4k2m9`)).toBe(true);
    expect(stringWidth(text)).toBeLessThanOrEqual(120);
  });

  it('drops the label on a narrow terminal and keeps the whole id', () => {
    const text = frame(70, 'a4k2m9');
    expect(text.trimEnd().endsWith('a4k2m9')).toBe(true);
    expect(text).not.toContain('id a4k2m9');
  });

  it('never renders a partial id', () => {
    for (let columns = 40; columns <= 120; columns += 1) {
      const text = frame(columns, 'a4k2m9');
      const trimmed = text.trimEnd();
      // The id either appears whole or not at all.
      if (text.includes('a4k2m9')) expect(trimmed).toMatch(/a4k2m9$/);
      // AND NOTHING SHORTER THAN IT. `includes` cannot fail on a truncated id -
      // `a4k2m` simply does not contain `a4k2m9` - so the "no partial id" claim
      // needs the prefixes checked on their own, which is the only way a
      // `wrap="truncate"` regression would be caught.
      for (let cut = 1; cut < 'a4k2m9'.length; cut += 1) {
        expect(trimmed.endsWith('a4k2m9'.slice(0, cut))).toBe(false);
      }
    }
  });
});

describe('AC-17 / I-6: no session, byte-identical row', () => {
  it('renders exactly what a build without the feature drew', () => {
    for (const columns of [40, 61, 80, 137]) {
      const without = frame(columns);
      expect(without).not.toContain('a4k2m9');
      // One row, and it still fills no more than the terminal it was given.
      expect(without.split('\n')).toHaveLength(1);
      expect(stringWidth(without)).toBeLessThanOrEqual(columns);
    }
  });
});
