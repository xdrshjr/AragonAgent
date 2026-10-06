/**
 * The running card's live tail (agent-activity-presentation-live §3.3.4).
 *
 * AC-22, AC-23, AC-24, AC-26, AC-29, AC-36 and the `Ctrl+O` clause of D-26 all
 * land here. The two that are silent when they break are AC-23 (a head-first
 * tail freezes on the first eight lines a build ever printed and then never
 * changes) and AC-24 (an escape byte reaching an Ink frame moves a cursor Ink
 * does not know it moved).
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { TranscriptList } from '../ui/Transcript.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { STALL_AFTER_MS } from '../tools/tool-output-store.js';
import { getTheme } from '../ui/theme.js';
import type { Entry } from '../agent/reducer.js';
import type { HeightStore } from '../ui/use-height-store.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);

// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

function tool(over: Partial<ToolEntry> = {}): ToolEntry {
  return {
    id: 'e1',
    kind: 'tool',
    toolCallId: 'c1',
    name: 'bash',
    label: 'Shell',
    argsRaw: '{"command":"npm test"}',
    args: { command: 'npm test' },
    status: 'running',
    ...over,
  } as ToolEntry;
}

const PASSTHROUGH: HeightStore = {
  version: 0,
  resolve: (_key, estimate) => estimate(),
  report: () => {},
  stats: () => ({ measured: 0, estimated: 0 }),
  clear: () => {},
};

/** Full-screen render, which is where `nowSec` is threaded per entry. */
function fullscreen(
  entries: Entry[],
  opts: { expandedToolIds?: Record<string, true>; nowSec?: number } = {},
): string {
  const { lastFrame, unmount } = render(
    <ViewportGeometryContext.Provider value={{ viewportRows: 60, offset: 0, contentRows: 0 }}>
      <TranscriptList
        entries={entries}
        expandedToolIds={opts.expandedToolIds ?? {}}
        thinkingVisible={false}
        reducedMotion
        density="compact"
        nowSec={opts.nowSec}
        theme={THEME}
        caps={CAPS}
        windowSize={20_000}
        cols={100}
        heights={PASSTHROUGH}
      />
    </ViewportGeometryContext.Provider>,
  );
  const frame = strip(lastFrame() ?? '');
  unmount();
  return frame;
}

const twentyRows = Array.from({ length: 20 }, (_, i) => `output line ${i}`);

describe('a running card draws its tail (AC-22)', () => {
  it('renders the rows the store handed it, under the header', () => {
    const frame = fullscreen([tool({ live: ['compiling...', 'linking...'], liveSeq: 2 })]);
    expect(frame).toContain('bash');
    expect(frame).toContain('running');
    expect(frame).toContain('compiling...');
    expect(frame).toContain('linking...');
  });

  it('draws nothing extra before the first chunk', () => {
    // The unchanged path: one row, exactly as today's build.
    const frame = fullscreen([tool()]);
    expect(frame).toContain('running');
    expect(frame).not.toContain('(running)');
  });

  /**
   * AC-23 — THE LAST ROWS, NOT THE FIRST (D-25).
   *
   * Fed 20 rows, the card must show 13..19 and not 0..7. Head-first is what the
   * SETTLED preview does, deliberately and forever (`ToolCard.tsx:146-154`), and
   * the two ends answer two different questions.
   */
  it('AC-23 — shows the LAST rows of a 20-row feed, never the first', () => {
    const frame = fullscreen([tool({ live: twentyRows, liveSeq: 20 })]);
    expect(frame).toContain('output line 19');
    expect(frame).toContain('output line 12');
    expect(frame).not.toContain('output line 0');
    expect(frame).not.toContain('output line 11');
  });

  /**
   * AC-24 — the rendered rows carry no escape, no CR, no C0/C1 byte.
   *
   * The entry is fed rows a sanitiser would never produce, so this asserts the
   * property of the RENDERED FRAME rather than re-asserting the sanitiser: a
   * future change that piped raw output past `sanitizeChunk` would fail here.
   */
  it('AC-24 — no control byte reaches a rendered live row', () => {
    const frame = fullscreen([tool({ live: ['clean row', 'also clean'], liveSeq: 2 })]);
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/.test(frame)).toBe(false);
    expect(frame).not.toContain('\r');
  });
});

describe('the footer row (§3.3.4)', () => {
  it('reads `(running)` while the child is talking', () => {
    const now = 1_700_000_000;
    const frame = fullscreen(
      [tool({ live: ['working'], liveSeq: 1, lastOutputAt: now * 1000 })],
      { nowSec: now },
    );
    expect(frame).toContain('(running)');
    expect(frame).not.toContain('no output for');
  });

  /** AC-26 — and NOT before the window, which is the half a `>` would break. */
  it('AC-26 — says `no output for Ns` only once the child has been quiet that long', () => {
    const lastOutputAt = 1_700_000_000_000;
    const justUnder = Math.floor((lastOutputAt + STALL_AFTER_MS - 1000) / 1000);
    const justOver = Math.floor((lastOutputAt + STALL_AFTER_MS) / 1000);
    const entry = tool({ live: ['stalled row'], liveSeq: 1, lastOutputAt });

    expect(fullscreen([entry], { nowSec: justUnder })).toContain('(running)');
    const stalled = fullscreen([entry], { nowSec: justOver });
    expect(stalled).toContain(`no output for ${STALL_AFTER_MS / 1000}s`);
  });

  it('AC-26 — the seconds advance with the clock', () => {
    const lastOutputAt = 1_700_000_000_000;
    const entry = tool({ live: ['stalled row'], liveSeq: 1, lastOutputAt });
    const at = (s: number) => fullscreen([entry], { nowSec: lastOutputAt / 1000 + s });
    expect(at(45)).toContain('no output for 45s');
    expect(at(46)).toContain('no output for 46s');
    expect(at(90)).toContain('no output for 90s');
  });

  it('is exactly one row, whatever the tail length — the estimate depends on it', () => {
    for (const n of [1, 5, 12]) {
      const live = Array.from({ length: n }, (_, i) => `r${i}`);
      const frame = fullscreen([tool({ live, liveSeq: n })]);
      const footers = frame.split('\n').filter((l) => l.includes('(running)'));
      expect(footers, `${n} rows`).toHaveLength(1);
    }
  });
});

describe('Ctrl+O is inert while live (D-26 / AC-29)', () => {
  it('renders the same frame expanded and collapsed', () => {
    const entry = tool({ live: twentyRows, liveSeq: 20 });
    const collapsed = fullscreen([entry]);
    const expanded = fullscreen([entry], { expandedToolIds: { e1: true } });
    expect(expanded).toBe(collapsed);
  });

  /**
   * AC-29 — at settle the tail is gone and the card is what today's build draws.
   *
   * The reducer clears `live` at `toolExecEnd`; this asserts the RENDER half:
   * even handed a stale tail, a settled card draws its preview and nothing else,
   * so the two ends can never be on screen at once.
   */
  it('AC-29 — a settled card shows its preview, never a leftover tail', () => {
    const frame = fullscreen([
      tool({
        status: 'done',
        durationMs: 120,
        preview: 'PASS  18 tests\nDone in 4.2s',
        live: ['a stale row that must not appear'],
        liveSeq: 9,
      }),
    ]);
    expect(frame).toContain('PASS  18 tests');
    expect(frame).not.toContain('a stale row');
    expect(frame).not.toContain('(running)');
  });
});
