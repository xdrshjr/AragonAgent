/**
 * THE REGRESSION GATE FOR R1 (tui-render-performance AC-1).
 *
 * Ink's `renderNodeToOutput` has no early-out for clipped subtrees, so before
 * virtualisation the per-frame cost was proportional to the total number of
 * characters MOUNTED rather than to the number visible. `transcriptWindow`
 * bounded the entry COUNT, which is not the same thing: one entry can be fifty
 * thousand lines.
 *
 * This file therefore gates the number of TEXT NODES and the volume of TEXT
 * that reach the frame. `ink-testing-library` exposes no handle on the Ink DOM,
 * so the count is taken from the rendered output — which is the same quantity
 * `renderNodeToOutput` walks, and is what actually matters. K-9: this is a
 * BEHAVIOURAL gate, so it fails on any regression regardless of cause, including
 * an Ink upgrade that changes the pipeline.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TranscriptList } from '../ui/Transcript.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { useHeightStore } from '../ui/use-height-store.js';
import { getTheme } from '../ui/theme.js';
import type { Entry } from '../agent/reducer.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);
const VIEWPORT_ROWS = 40;

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Heavy entries: each one is a paragraph, so a mounted one is unmissable. */
function heavy(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    kind: 'notice' as const,
    level: 'info' as const,
    text: `entry ${i} ${'payload '.repeat(24)}`,
  }));
}

function Harness({ entries }: { entries: Entry[] }): React.ReactElement {
  const heights = useHeightStore();
  return (
    <ViewportGeometryContext.Provider
      value={{ viewportRows: VIEWPORT_ROWS, offset: 0, contentRows: 0 }}
    >
      <TranscriptList
        entries={entries}
        expandedToolIds={{}}
        thinkingVisible
        reducedMotion
        density="compact"
        mode="fullscreen"
        theme={THEME}
        caps={CAPS}
        windowSize={20_000}
        cols={80}
        heights={heights}
      />
    </ViewportGeometryContext.Provider>
  );
}

interface Budget {
  /** Non-blank rows: spacer rows are blank, so this counts real text nodes. */
  textRows: number;
  /** Characters of real content that reached the frame. */
  chars: number;
}

function budgetOf(entries: Entry[]): Budget {
  const { lastFrame, unmount } = render(<Harness entries={entries} />);
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  const rows = frame.split('\n').filter((line) => line.trim().length > 0);
  return { textRows: rows.length, chars: rows.join('').length };
}

describe('AC-1: the render budget is independent of transcript length', () => {
  it('renders the same text volume for 100 and 5 000 entries (within 10%)', () => {
    const small = budgetOf(heavy(100));
    const large = budgetOf(heavy(5000));

    // Before virtualisation `large` was ~50x `small`, and every one of those
    // characters was scanned TWICE per frame (`renderNodeToOutput` +
    // `Output.get`), thirty times a second.
    expect(large.textRows).toBeLessThanOrEqual(Math.ceil(small.textRows * 1.1));
    expect(large.chars).toBeLessThanOrEqual(Math.ceil(small.chars * 1.1));
  });

  it('keeps the mounted rows close to the viewport height', () => {
    const { textRows } = budgetOf(heavy(5000));
    // Viewport + overscan + the wrap of the overscan entries; an order of
    // magnitude below 5 000 is the property under test.
    expect(textRows).toBeLessThan(VIEWPORT_ROWS * 4);
  });

  it('is unaffected by one enormous entry in the history', () => {
    // The exact shape R1 describes: `transcriptWindow` bounds the entry COUNT
    // and bounds nothing about this. Two thousand lines rather than fifty
    // thousand only because the harness has no clipping box, so the leading
    // SPACER is serialised in full here and in the app it is not — that cost is
    // the test's, not the renderer's.
    const entries = heavy(200);
    entries[0] = {
      id: 'e0',
      kind: 'notice',
      level: 'info',
      text: Array.from({ length: 2000 }, (_, i) => `log line ${i}`).join('\n'),
    };
    const withMonster = budgetOf(entries);
    const withoutMonster = budgetOf(heavy(200));
    expect(withMonster.chars).toBeLessThanOrEqual(Math.ceil(withoutMonster.chars * 1.1));
  });
});
