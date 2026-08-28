/**
 * The live working line (agent-activity-presentation §3.2.2 / AC-6, AC-9, AC-10).
 *
 * THE DIGIT ASSERTION IS THE POINT OF THIS FILE. R-13 is that someone adds an
 * elapsed cluster to the row because it "looks empty" — and the status bar
 * already renders `formatDuration(elapsedMs)` under exactly the `running`
 * condition that mounts this row, plus the token cluster at `cols >= 72`. It is
 * written as a PROPERTY rather than a string match because a clock, a token
 * count and a percentage must all fail it, whatever they are spelled like.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { ActivityLine } from '../ui/ActivityLine.js';
import { renderRowsAtWidth } from './render-at-width.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const ASCII: TermCapabilities = { colorLevel: 0, unicode: false };
const STARTED = 1_700_000_000_000;

function frameOf(
  caps: TermCapabilities,
  reducedMotion: boolean,
  elapsedMs = 1_200,
  runningTool?: string,
): string {
  const { lastFrame, unmount } = render(
    <ActivityLine
      startedAt={STARTED}
      elapsedMs={elapsedMs}
      reducedMotion={reducedMotion}
      runningTool={runningTool}
      theme={getTheme('cool', caps)}
      caps={caps}
    />,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return frame;
}

describe('ActivityLine', () => {
  it('is exactly one row, and carries a phrase', () => {
    const frame = frameOf(RICH, false);
    expect(frame.split('\n')).toHaveLength(1);
    expect(frame.trim().length).toBeGreaterThan(3);
  });

  it('CARRIES NO DIGITS AND NO `esc` (D-5 / P1-1 / R-13)', () => {
    // A clock, a token count, a percentage and the abort hint all fail this.
    // The status bar owns the first three; both composers own the last.
    for (const caps of [RICH, ASCII]) {
      for (const reduced of [false, true]) {
        const frame = frameOf(caps, reduced, 65_432);
        expect(frame, `${caps.unicode}/${reduced}`).not.toMatch(/\d/);
        expect(frame.toLowerCase()).not.toContain('esc');
      }
    }
  });

  it('renders a static marker and a held phrase under reduced motion (AC-9)', () => {
    const still = frameOf(RICH, true, 0);
    expect(still).not.toMatch(/[⠀-⣿]/); // no braille dots
    // The word does not move for the whole run.
    expect(frameOf(RICH, true, 30_000)).toBe(still);
  });

  it('degrades to pure ASCII on a legacy console (AC-20 / manual row 8)', () => {
    const frame = frameOf(ASCII, false);
    expect(frame).not.toMatch(/[^\x20-\x7e]/);
    expect(frame).toContain('...');
  });

  it('is one row at 200 columns and at 40 (AC-10)', () => {
    // There is no width ladder to get wrong: nothing on the row depends on
    // `cols`, so `cols` is not even a prop.
    //
    // RENDERED THROUGH A STUB WHOSE WIDTH IS A PARAMETER. `ink-testing-library`'s
    // stdout hard-codes `columns = 100`, so the obvious `render(tree, {
    // columns })` is silently ignored and the assertion would be vacuous while
    // looking exactly like a real one.
    for (const columns of [200, 40]) {
      const rows = renderRowsAtWidth(
        <ActivityLine
          startedAt={STARTED}
          elapsedMs={900}
          reducedMotion
          theme={getTheme('cool', RICH)}
          caps={RICH}
        />,
        columns,
      );
      expect(rows, `cols=${columns}`).toHaveLength(1);
      expect(rows[0]!.length, `cols=${columns}`).toBeLessThanOrEqual(columns);
    }
  });

  /**
   * The tool branch (agent-activity-presentation-live L4 / D-31). The branch
   * itself is exercised in `activity-tool-label.test.tsx`; what belongs HERE is
   * that adding it left this file's four rules intact.
   *
   * THE OMITTED-PROP PATH MUST BE BYTE-IDENTICAL, and that is the whole of the
   * regression: `runningTool` is optional, so a session with no tool in flight —
   * which is every frame of every turn that only talks — must render exactly the
   * row it rendered before this round.
   */
  describe('the tool branch leaves the phrase branch untouched', () => {
    it('renders identically with the prop absent and with it `undefined`', () => {
      expect(frameOf(RICH, false, 1_200, undefined)).toBe(frameOf(RICH, false, 1_200));
    });

    it('is still one row, still ASCII-degradable, with a tool named', () => {
      const frame = frameOf(ASCII, false, 1_200, 'bash');
      expect(frame.split('\n')).toHaveLength(1);
      expect(frame).not.toMatch(/[^\x20-\x7e]/);
    });

    it('still carries no digit and no `esc` while a tool is named', () => {
      for (const caps of [RICH, ASCII]) {
        for (const reduced of [false, true]) {
          const frame = frameOf(caps, reduced, 65_432, 'read_file');
          expect(frame, `${caps.unicode}/${reduced}`).not.toMatch(/\d/);
          expect(frame.toLowerCase()).not.toContain('esc');
        }
      }
    });

    it('drops the ellipsis with the phrase — `Running bash` is a statement', () => {
      // The phrase branch reads `Percolating...` because it is an open-ended
      // wait. Naming the tool answers the question, so the trailing dots would
      // be decoration rather than meaning.
      expect(frameOf(RICH, false, 1_200, 'bash')).not.toContain('...');
    });
  });
});
