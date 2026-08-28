/**
 * W1 — thinking is hidden by default, and says so (agent-activity-presentation
 * §3.1 / AC-1..AC-5, AC-19, AC-21).
 *
 * TWO CONDITIONS OF APPROVAL LIVE HERE, and both fail silently if skipped:
 *
 *  - **D-16 / P0-2** — the INLINE collapsed marker must not offer `ctrl+t`.
 *    Inline prints settled entries into Ink's `<Static>`, which cannot un-print
 *    or re-print, so with thinking hidden by default the body is never printed
 *    there at all and the key provably cannot do what the row says. Asserted in
 *    BOTH modes, because a one-sided assertion is what lets the next reader
 *    "simplify" `revealable` back to a constant with the test still green.
 *  - **P1-6** — `estimateEntryRows` must charge a collapsed marker ONE row.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Transcript, TranscriptList } from '../ui/Transcript.js';
import { estimateEntryRows } from '../ui/layout/virtual-window.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { initialViewState, viewReducer, type Entry } from '../agent/reducer.js';
import { getTheme } from '../ui/theme.js';
import type { HeightStore } from '../ui/use-height-store.js';
import type { RenderMode } from '../ui/layout/frame.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);

const THOUGHT = Array.from({ length: 40 }, (_, i) => `reasoning step ${i}`).join('\n');

function assistant(over: Partial<Extract<Entry, { kind: 'assistant' }>> = {}): Entry {
  return {
    id: 'e1',
    kind: 'assistant',
    text: 'the answer',
    thinking: THOUGHT,
    thinkingOpen: false,
    streaming: false,
    ...over,
  } as Entry;
}

function frameOf(entries: Entry[], thinkingVisible: boolean, mode: RenderMode): string {
  const { lastFrame, unmount } = render(
    <Transcript
      entries={entries}
      expandedToolIds={{}}
      thinkingVisible={thinkingVisible}
      reducedMotion
      density="compact"
      mode={mode}
      theme={THEME}
      caps={CAPS}
    />,
  );
  const frame = stripAnsi(lastFrame() ?? '');
  unmount();
  return frame;
}

describe('initialViewState seeding (D-2 / AC-4 / AC-21)', () => {
  it('defaults to HIDDEN when the seed is omitted — it fails closed', () => {
    // A future call site that forgets the seed must land on the product default,
    // not silently restore the reasoning firehose for one code path.
    expect(initialViewState().thinkingVisible).toBe(false);
    expect(initialViewState({}).thinkingVisible).toBe(false);
  });

  it('honours an explicit seed in both directions', () => {
    expect(initialViewState({ thinkingVisible: true }).thinkingVisible).toBe(true);
    expect(initialViewState({ thinkingVisible: false }).thinkingVisible).toBe(false);
  });

  it('shows the body on the FIRST frame when seeded true (no flash-then-hide)', () => {
    const seeded = initialViewState({ thinkingVisible: true });
    const frame = frameOf([assistant()], seeded.thinkingVisible, 'fullscreen');
    expect(frame).toContain('reasoning step');
    expect(frame).not.toContain('thought for');
  });
});

describe('the collapsed marker (AC-1 / AC-2)', () => {
  it('draws no reasoning text and exactly one `thought` row', () => {
    const frame = frameOf([assistant({ thinkingMs: 12_000 })], false, 'fullscreen');
    expect(frame).not.toContain('reasoning step');
    expect(frame.split('\n').filter((r) => r.includes('thought'))).toHaveLength(1);
    expect(frame).toContain('thought for 12.0s');
  });

  it('omits the duration when it is unknown rather than claiming `0s`', () => {
    // A session restored from a file written by an older build has no
    // `thinkingMs`, and `thought for 0s` is a lie where `thought` is merely terse.
    const frame = frameOf([assistant()], false, 'fullscreen');
    expect(frame).toContain('thought');
    expect(frame).not.toContain('for 0');
  });

  it('is suppressed while the entry is still streaming (R-9)', () => {
    // Exactly one live surface at a time: the activity line owns the run.
    const frame = frameOf([assistant({ streaming: true, text: '' })], false, 'fullscreen');
    expect(frame).not.toContain('thought');
  });

  it('offers ctrl+t in FULL-SCREEN and never in INLINE (D-16 / P0-2 / R-12)', () => {
    const entry = assistant({ thinkingMs: 4_000 });
    const full = frameOf([entry], false, 'fullscreen');
    const inline = frameOf([entry], false, 'inline');

    expect(full).toContain('ctrl+t to show');
    // BOTH DIRECTIONS. `<Static>` cannot re-print a settled entry, so an inline
    // marker offering the key would be an instruction that provably does nothing.
    expect(inline).toContain('thought for 4.0s');
    expect(inline).not.toContain('ctrl+t');
  });
});

describe('Ctrl+T still reveals in full-screen (AC-3)', () => {
  it('swaps the marker for the body and back', () => {
    let state = viewReducer(initialViewState(), {
      type: 'restoreEntries',
      entries: [assistant({ thinkingMs: 4_000 })],
    });
    expect(state.thinkingVisible).toBe(false);
    expect(frameOf(state.entries, state.thinkingVisible, 'fullscreen')).toContain('thought for');

    state = viewReducer(state, { type: 'toggleThinking' });
    const revealed = frameOf(state.entries, state.thinkingVisible, 'fullscreen');
    expect(revealed).toContain('reasoning step');
    expect(revealed).not.toContain('thought for');

    state = viewReducer(state, { type: 'toggleThinking' });
    expect(frameOf(state.entries, state.thinkingVisible, 'fullscreen')).toContain('thought for');
  });
});

describe('estimateEntryRows and the hidden marker (AC-19 / P1-6)', () => {
  it('charges ONE row for a collapsed marker and the wrapped length when shown', () => {
    const entry = assistant({ thinkingMs: 4_000, text: '' });
    const hidden = estimateEntryRows(entry, 100, 'compact', false, false);
    const shown = estimateEntryRows(entry, 100, 'compact', false, true);

    // 1 marker + 1 body placeholder.
    expect(hidden).toBe(2);
    // The thinking block is 40 lines plus its own header row.
    expect(shown).toBeGreaterThan(40);
  });

  it('charges ZERO for a streaming entry whose marker is suppressed', () => {
    const entry = assistant({ streaming: true, text: '' });
    expect(estimateEntryRows(entry, 100, 'compact', false, false)).toBe(1);
  });

  it('defaults to the CONSERVATIVE value when the flag is not passed', () => {
    // The default is a fail-safe for a forgotten caller: over-estimating is the
    // safe direction. `Transcript.tsx` passes the real flag.
    const entry = assistant({ thinkingMs: 4_000, text: '' });
    expect(estimateEntryRows(entry, 100, 'compact', false)).toBe(
      estimateEntryRows(entry, 100, 'compact', false, true),
    );
  });

  it('never under-estimates the rendered height, in either state', () => {
    const entry = assistant({ thinkingMs: 4_000 });
    for (const visible of [false, true]) {
      const drawn = frameOf([entry], visible, 'fullscreen').split('\n').length;
      expect(estimateEntryRows(entry, 100, 'compact', false, visible)).toBeGreaterThanOrEqual(
        drawn,
      );
    }
  });
});

/**
 * AC-19's second clause — *"and `Transcript.tsx` passes `thinkingVisible`"* — and
 * condition 5 of the approval.
 *
 * THE CASE ABOVE ("defaults to the CONSERVATIVE value") PINS THE FAIL-SAFE, NOT
 * THE CALLER, and its own comment asserts in prose the thing nothing checked:
 * *"`Transcript.tsx` passes the real flag."* Deleting that argument is a
 * one-token edit that changes no type and no short-transcript frame — it was
 * mutation-checked against the whole suite and every one of the 1624 cases
 * stayed green. So the estimate itself has to be observed, or the fifth
 * parameter's `true` default silently becomes the behaviour for the only
 * production caller there is, and every assistant entry that thought is charged
 * `1 + wrappedRows(thinking)` against a real height of one row. That entry is
 * then exactly the one `selectWindow` never mounts and therefore never
 * re-measures, so the over-estimate does not self-correct (P1-6a).
 *
 * A RECORDING `HeightStore` IS HOW, rather than a module mock: `resolve(key,
 * estimate)` is the seam the component computes its fallback through, so this
 * reads the number `Transcript.tsx` actually produced without stubbing a module
 * or depending on yoga measuring a box the test never sized.
 */
describe('TranscriptList passes thinkingVisible to estimateEntryRows (AC-19 / condition 5)', () => {
  function estimatesFor(thinkingVisible: boolean): number[] {
    const seen: number[] = [];
    const heights: HeightStore = {
      version: 0,
      resolve: (_key, estimate) => {
        const rows = estimate();
        seen.push(rows);
        return rows;
      },
      report: () => {},
      stats: () => ({ measured: 0, estimated: seen.length }),
      clear: () => {},
    };
    const { unmount } = render(
      <ViewportGeometryContext.Provider
        value={{ viewportRows: 40, offset: 0, contentRows: 0 }}
      >
        <TranscriptList
          entries={[assistant({ thinkingMs: 4_000, text: '' })]}
          expandedToolIds={{}}
          thinkingVisible={thinkingVisible}
          reducedMotion
          density="compact"
          mode="fullscreen"
          theme={THEME}
          caps={CAPS}
          windowSize={20_000}
          cols={100}
          heights={heights}
        />
      </ViewportGeometryContext.Provider>,
    );
    unmount();
    return seen;
  }

  it('estimates a hidden thinking block at the marker, not at its wrapped length', () => {
    const hidden = estimatesFor(false);
    const shown = estimatesFor(true);

    expect(hidden.length).toBeGreaterThan(0);
    expect(shown.length).toBeGreaterThan(0);
    // THE ASSERTION THAT FAILS WHEN THE ARGUMENT IS DROPPED. Same entry, same
    // `cols`, same density as the direct cases above: 1 marker row + 1 body
    // placeholder when hidden, and the 40-line block plus its header when shown.
    expect(Math.max(...hidden)).toBe(2);
    expect(Math.max(...shown)).toBeGreaterThan(40);
  });
});
