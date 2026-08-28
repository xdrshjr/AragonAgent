/**
 * Height accounting for the live tool tail (agent-activity-presentation-live
 * §3.3.3) — AC-27 and AC-28.
 *
 * BOTH ARE SILENT WHEN THEY BREAK, which is why both are in §7.2's must-pin
 * list. A revision that does not move leaves the card frozen at a stale height
 * AND a stale rendered subtree with nothing reporting it (I-L3-1); an estimate
 * that under-counts puts the newest output off the bottom of a viewport the user
 * believes is pinned.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { entryRevision, estimateEntryRows } from '../ui/layout/virtual-window.js';
import { TranscriptList } from '../ui/Transcript.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { LIVE_TAIL_ROWS } from '../tools/tool-output-store.js';
import { getTheme } from '../ui/theme.js';
import type { Entry } from '../agent/reducer.js';
import type { HeightStore } from '../ui/use-height-store.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

function tool(over: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: 'e1',
    kind: 'tool',
    toolCallId: 'c1',
    name: 'bash',
    label: 'Shell',
    argsRaw: '{"command":"npm test"}',
    status: 'running',
    ...over,
  } as ToolEntry;
}

describe('entryRevision — the tool branch carries `liveSeq` (AC-28 / D-22)', () => {
  /**
   * THE MUTATION THIS PINS: delete `.${entry.liveSeq ?? -1}` from
   * `virtual-window.ts`'s tool branch and this case fails. Nothing else in the
   * suite does, which is exactly why the term needs its own test — a ring
   * eviction that replaces the oldest row with a new one of the same width
   * leaves every OTHER term identical.
   */
  it('changes on a tail update whose joined length is IDENTICAL', () => {
    const before = tool({ live: ['aaaa', 'bbbb', 'cccc'], liveSeq: 1 });
    const after = tool({ live: ['bbbb', 'cccc', 'dddd'], liveSeq: 2 });
    const joined = (e: ToolEntry) => (e.live ?? []).join('\n').length;
    // The precondition: without it the test would pass for the wrong reason.
    expect(joined(before)).toBe(joined(after));
    expect(entryRevision(before)).not.toBe(entryRevision(after));
  });

  it('changes on the FIRST tail, and again on every one after it', () => {
    const seen = new Set<string>();
    let entry = tool();
    seen.add(entryRevision(entry));
    for (let i = 1; i <= 5; i += 1) {
      entry = tool({ live: [`row ${i}`], liveSeq: i });
      seen.add(entryRevision(entry));
    }
    expect(seen.size).toBe(6);
  });

  it('changes when the tail is RELEASED without the status moving (AC-40 / D-35)', () => {
    // `runEnd` and `abortMark` clear the tail but deliberately leave the status
    // alone, so `liveSeq` is the only term that can move — and if it does not,
    // the height cache keeps serving a multi-row measurement for a one-row card.
    const live = tool({ live: ['x', 'y'], liveSeq: 3 });
    const released = tool({ live: undefined, lastOutputAt: undefined, liveSeq: 4 });
    expect(entryRevision(live)).not.toBe(entryRevision(released));
  });
});

describe('estimateEntryRows — the live branch (AC-27)', () => {
  const rowsFor = (n: number) =>
    estimateEntryRows(
      tool({ live: Array.from({ length: n }, (_, i) => `line ${i}`), liveSeq: n }),
      100,
      'compact',
      false,
    );

  it('charges header + min(rows, 8) + one footer', () => {
    for (const n of [1, 2, 3, 7, 8, 12, 40]) {
      expect(rowsFor(n), `${n} rows`).toBe(1 + Math.min(n, LIVE_TAIL_ROWS) + 1);
    }
  });

  it('still charges exactly one row for a running tool with NO tail', () => {
    // The unchanged path: this is what every non-`bash` tool draws for its whole
    // (millisecond) life, and what `bash` draws before its first chunk.
    expect(estimateEntryRows(tool(), 100, 'compact', false)).toBe(1);
    expect(estimateEntryRows(tool({ live: [] }), 100, 'compact', false)).toBe(1);
  });

  /**
   * P1-4 — THE GUARD THAT MUST SURVIVE THE SPLIT.
   *
   * The single line this replaced covered TWO cases: not settled, and settled
   * with nothing to draw. A `!settled` block alone drops the second into
   * `wrappedRows(entry.preview, usable)` with `undefined` — a crash, on the
   * aborted-tool path.
   */
  it('charges one row for a SETTLED entry with no preview, and does not throw', () => {
    for (const status of ['done', 'error'] as const) {
      const entry = tool({ status, preview: undefined });
      expect(() => estimateEntryRows(entry, 100, 'compact', false)).not.toThrow();
      expect(estimateEntryRows(entry, 100, 'compact', false)).toBe(1);
    }
  });

  it('ignores `expanded`, because `Ctrl+O` is inert on a live card (D-26)', () => {
    const entry = tool({ live: ['a', 'b', 'c'], liveSeq: 1 });
    expect(estimateEntryRows(entry, 100, 'compact', true)).toBe(
      estimateEntryRows(entry, 100, 'compact', false),
    );
  });

  it('charges the settled card exactly what it charged before the round', () => {
    // AC-29's arithmetic half: at settle the tail is gone and the card is the
    // one today's build draws.
    const settled = tool({ status: 'done', preview: 'one\ntwo\nthree', durationMs: 5 });
    expect(estimateEntryRows(settled, 100, 'compact', false)).toBe(1 + 3 + 1);
  });
});

/**
 * AC-27's second half — the estimate must equal what the card ACTUALLY draws.
 *
 * A RECORDING `HeightStore` is how, rather than a module mock: `resolve(key,
 * estimate)` is the seam `TranscriptList` computes its fallback through, so this
 * reads the number the component produced and compares it with the rows the
 * frame contains.
 */
describe('the estimate matches the rendered row count over 14 shapes', () => {
  function measure(entry: Entry): { estimated: number; rendered: number } {
    let estimated = 0;
    const heights: HeightStore = {
      version: 0,
      resolve: (_key, estimate) => {
        const rows = estimate();
        estimated = rows;
        return rows;
      },
      report: () => {},
      stats: () => ({ measured: 0, estimated: 1 }),
      clear: () => {},
    };
    const { lastFrame, unmount } = render(
      React.createElement(
        ViewportGeometryContext.Provider,
        { value: { viewportRows: 60, offset: 0, contentRows: 0 } },
        React.createElement(TranscriptList, {
          entries: [entry],
          expandedToolIds: {},
          thinkingVisible: false,
          reducedMotion: true,
          density: 'compact',
          mode: 'fullscreen',
          theme: THEME,
          caps: CAPS,
          windowSize: 20_000,
          cols: 100,
          heights,
        }),
      ),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // Trailing blank lines are the spacer boxes, not the card.
    const rendered = frame.replace(/\n+$/, '').split('\n').length;
    return { estimated, rendered };
  }

  /**
   * `exact` is the LIVE branch's own claim (§3.3.4): one footer row ALWAYS,
   * matching §3.3.3's arithmetic exactly, so the estimate is a number rather
   * than a ceiling.
   *
   * The settled branch stays what it has always been — an UPPER bound, because
   * it charges its `+N lines (Ctrl+O)` footer unconditionally. That is the
   * direction `virtual-window.ts` says the layout absorbs, and this round does
   * not change it; the shapes are here so a future edit that made it UNDER-count
   * fails in this file rather than as scroll drift.
   */
  const shapes: Array<[string, Entry, boolean]> = [
    ['no tail', tool(), true],
    ['empty tail', tool({ live: [], liveSeq: 1 }), true],
    ['1 row', tool({ live: ['a'], liveSeq: 1 }), true],
    ['2 rows', tool({ live: ['a', 'b'], liveSeq: 2 }), true],
    ['3 rows', tool({ live: ['a', 'b', 'c'], liveSeq: 3 }), true],
    ['7 rows', tool({ live: Array.from({ length: 7 }, (_, i) => `r${i}`), liveSeq: 7 }), true],
    ['8 rows', tool({ live: Array.from({ length: 8 }, (_, i) => `r${i}`), liveSeq: 8 }), true],
    [
      '20 rows (clamped)',
      tool({ live: Array.from({ length: 20 }, (_, i) => `r${i}`), liveSeq: 20 }),
      true,
    ],
    ['stalled', tool({ live: ['a', 'b'], liveSeq: 2, lastOutputAt: 1_000 }), true],
    // BLANK LINES ARE ORDINARY BUILD OUTPUT, and an `<Text>` with an empty child
    // must still occupy a row or the estimate over-counts the moment `npm test`
    // prints a separator.
    ['blank rows', tool({ live: ['a', '', 'b', ''], liveSeq: 4 }), true],
    ['all blank', tool({ live: ['', '', ''], liveSeq: 3 }), true],
    ['pending with a tail', tool({ status: 'pending', live: ['a'], liveSeq: 1 }), true],
    ['settled, no preview', tool({ status: 'done' }), true],
    ['settled with a preview', tool({ status: 'done', preview: 'one\ntwo', durationMs: 3 }), false],
  ];

  it.each(shapes)('%s', (_name, entry, exact) => {
    const { estimated, rendered } = measure(entry);
    // The invariant that matters for every shape: never UNDER-count.
    expect(estimated).toBeGreaterThanOrEqual(rendered);
    if (exact) expect(estimated).toBe(rendered);
  });
});
