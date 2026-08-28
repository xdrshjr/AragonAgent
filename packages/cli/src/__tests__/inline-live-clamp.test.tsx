/**
 * I-L5-1 / AC-5 — the inline live region must stay strictly below `stdout.rows`.
 *
 * Above that, Ink takes the branch at `ink.js:118-123` and writes
 * `clearTerminal + fullStaticOutput + output` on EVERY subsequent frame,
 * bypassing both the `output !== lastOutput` dedupe and `throttledLog`.
 * `fullStaticOutput` accumulates every `<Static>` frame of the whole session and
 * is never trimmed, so the terminal then receives the entire session history
 * thirty times a second. That is a genuine hard freeze, and it is reachable
 * today by any inline user whose model writes a long answer.
 *
 * `ink-testing-library`'s stdout stub reports no `rows`, so `useTerminalSize`
 * resolves the documented `FALLBACK_ROWS` (24) — exactly the 24-row terminal the
 * design's manual test #10 describes.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Transcript } from '../ui/Transcript.js';
import { getTheme } from '../ui/theme.js';
import { FALLBACK_ROWS } from '../ui/layout/frame.js';
import type { Entry } from '../agent/reducer.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const bigText = (n: number): string =>
  Array.from({ length: n }, (_, i) => `answer line ${i}`).join('\n');

function inline(entries: Entry[]): { frame: string; rows: number } {
  const { lastFrame, unmount } = render(
    <Transcript
      entries={entries}
      expandedToolIds={{}}
      thinkingVisible
      reducedMotion
      density="compact"
      mode="inline"
      theme={THEME}
      caps={CAPS}
    />,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return { frame, rows: frame.split('\n').length };
}

describe('I-L5-1: a 5 000-line live entry cannot reach stdout.rows', () => {
  const entries: Entry[] = [
    { id: 'e0', kind: 'notice', level: 'info', text: 'settled' },
    {
      id: 'e1',
      kind: 'assistant',
      text: bigText(5000),
      thinkingOpen: false,
      streaming: true,
    },
  ];

  it('renders a live region strictly shorter than the terminal', () => {
    const { rows } = inline(entries);
    expect(rows).toBeLessThan(FALLBACK_ROWS);
  });

  it('shows the newest output, not the oldest', () => {
    // The tail is where the cursor is; clamping to the head would hide exactly
    // the rows the user is waiting for.
    const { frame } = inline(entries);
    expect(frame).toContain('answer line 4999');
    expect(frame).not.toContain('answer line 0\n');
  });

  it('states the count rather than dropping rows silently (K-8)', () => {
    const { frame } = inline(entries);
    expect(frame).toMatch(/\d+ earlier lines/);
  });

  it('leaves a short live entry byte-identical', () => {
    const short: Entry[] = [
      { id: 'e0', kind: 'notice', level: 'info', text: 'settled' },
      { id: 'e1', kind: 'assistant', text: 'a\nb\nc', thinkingOpen: false, streaming: true },
    ];
    const { frame } = inline(short);
    expect(frame).toContain('a');
    expect(frame).not.toMatch(/earlier lines/);
  });

  it('bounds the region even when several entries are live at once', () => {
    // `computeSettledCount` stops at the first unsettled entry, so an expanded
    // card or a live todo list can hold several entries in the live region.
    // A per-entry clamp of `rows - 4` would then still overrun.
    const many: Entry[] = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      kind: 'assistant' as const,
      text: bigText(500),
      thinkingOpen: false,
      streaming: true,
    }));
    const { rows } = inline(many);
    expect(rows).toBeLessThan(FALLBACK_ROWS);
  });

  it('prints the entry in full once it settles -- nothing is lost, only deferred', () => {
    const settled: Entry[] = [
      {
        id: 'e0',
        kind: 'assistant',
        text: bigText(5000),
        thinkingOpen: false,
        streaming: false,
      },
      { id: 'e1', kind: 'notice', level: 'info', text: 'after' },
    ];
    const { lastFrame, frames, unmount } = render(
      <Transcript
        entries={settled}
        expandedToolIds={{}}
        thinkingVisible
        reducedMotion
        density="compact"
        mode="inline"
        theme={THEME}
        caps={CAPS}
      />,
    );
    void lastFrame();
    const all = stripAnsi(frames.join('\n'));
    unmount();
    // It reached `<Static>`, which prints once into the terminal's own
    // scrollback -- head and tail both.
    expect(all).toContain('answer line 0');
    expect(all).toContain('answer line 4999');
  });
});
