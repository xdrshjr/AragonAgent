/**
 * The activity row names the running tool (agent-activity-presentation-live L4
 * / D-31 / AC-32).
 *
 * `state.status === 'running'` covers the WHOLE turn, including the minutes the
 * model is idle while a child process does the work. The thinking vocabulary is
 * right for the gap before the first token and WRONG during a build: a UI that
 * says "Pondering" while `npm test` runs is not calm, it is inaccurate, and the
 * requirement's fourth clause asks for a status line rather than a screensaver.
 *
 * ROUND 1'S RULES SURVIVE UNCHANGED, and this file re-asserts them for the new
 * branch: one row, no digits, no `esc`, no width ladder, ASCII only (D-5 / D-17).
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

/** Every builtin the lead can run, which is what AC-32's property ranges over. */
const BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'bash',
] as const;

function frameOf(
  caps: TermCapabilities,
  reducedMotion: boolean,
  runningTool?: string,
  elapsedMs = 1_200,
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

describe('ActivityLine names the running tool', () => {
  it('reads `Running bash` while bash is in flight', () => {
    expect(frameOf(RICH, false, 'bash')).toContain('Running bash');
  });

  it('reverts to a rotating phrase when no tool is running', () => {
    const withTool = frameOf(RICH, false, 'bash');
    const without = frameOf(RICH, false, undefined);
    expect(without).not.toContain('Running');
    expect(without).not.toBe(withTool);
    // The phrase is pure in `(startedAt, now)`, so it resumes where the clock
    // says rather than from wherever the tool interrupted it.
    expect(without.trim().length).toBeGreaterThan(3);
  });

  it('shows the tool INSTEAD of the phrase, never both', () => {
    const phrase = frameOf(RICH, false, undefined, 1_200).replace(/[^A-Za-z]/g, '');
    const labelled = frameOf(RICH, false, 'bash', 1_200);
    // Whatever word the phrase clock picked, it is not on the row any more.
    expect(labelled).toContain('Running bash');
    expect(labelled.replace(/[^A-Za-z]/g, '')).not.toContain(phrase.replace('Running', ''));
  });

  /**
   * AC-32 — NO DIGIT IN THE RENDERED ROW, in either branch.
   *
   * Stated over today's builtin tool set rather than as a universal property
   * (P2-5): the label interpolates a model-supplied name, so a hallucinated tool
   * called `grep2` would put a digit on the row. Harmless — the row is
   * `wrap="truncate"` — but the assertion should say what it checks.
   */
  it('AC-32 — carries no digit and no `esc`, for every builtin, at both capabilities', () => {
    for (const caps of [RICH, ASCII]) {
      for (const reduced of [false, true]) {
        for (const name of [...BUILTIN_TOOLS, undefined]) {
          const frame = frameOf(caps, reduced, name, 65_432);
          expect(frame, `${name}/${caps.unicode}/${reduced}`).not.toMatch(/\d/);
          expect(frame.toLowerCase()).not.toContain('esc');
        }
      }
    }
  });

  it('stays exactly one row at every width (no ladder — D-5)', () => {
    for (const cols of [40, 72, 120, 200]) {
      const rows = renderRowsAtWidth(
        <ActivityLine
          startedAt={STARTED}
          elapsedMs={1_200}
          reducedMotion
          runningTool="write_file"
          theme={getTheme('cool', RICH)}
          caps={RICH}
        />,
        cols,
      );
      expect(rows, `cols=${cols}`).toHaveLength(1);
    }
  });

  it('uses only ASCII for the label itself', () => {
    // The spinner glyph is `glyphs.ts`'s business; the LABEL must not smuggle a
    // non-ASCII character past `glyphs.test.ts` (DoD #4).
    const frame = frameOf(ASCII, true, 'bash');
    const label = frame.slice(frame.indexOf('Running'));
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(label)).toBe(false);
  });
});
