/**
 * Viewport virtualisation (tui-render-performance L3 / AC-1).
 *
 * The harness mounts `TranscriptList` under an explicit
 * `ViewportGeometryContext`, which is exactly what `ScrollViewport` supplies in
 * the app. That keeps these cases about the WINDOW SELECTION rather than about
 * yoga's measurement of a box the test never sized.
 */

import { describe, expect, it } from 'vitest';
import React, { useRef } from 'react';
import { render } from 'ink-testing-library';
import { TranscriptList } from '../ui/Transcript.js';
import { ViewportGeometryContext } from '../ui/layout/viewport-geometry.js';
import { useHeightStore } from '../ui/use-height-store.js';
import { getTheme } from '../ui/theme.js';
import { VIRTUAL_LIMITS } from '../ui/layout/virtual-window.js';
import type { Entry } from '../agent/reducer.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);

/** Distinctive one-line entries, so "is it mounted" is a substring test. */
function notices(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    kind: 'notice' as const,
    level: 'info' as const,
    text: `MARK${i}END`,
  }));
}

interface HarnessProps {
  trailingContentRows?: number;
  entries: Entry[];
  viewportRows?: number;
  offset?: number;
  sink: { current: number };
  renders?: { current: number };
}

function Harness({
  entries,
  viewportRows = 40,
  trailingContentRows = 0,
  offset = 0,
  sink,
  renders,
}: HarnessProps): React.ReactElement {
  const heights = useHeightStore();
  const seen = useRef(0);
  seen.current += 1;
  if (renders) renders.current = seen.current;
  return (
    <ViewportGeometryContext.Provider value={{ viewportRows, offset, contentRows: 0, trailingContentRows }}>
      <TranscriptList
        entries={entries}
        expandedToolIds={{}}
        thinkingVisible
        reducedMotion
        density="compact"
        theme={THEME}
        caps={CAPS}
        windowSize={20_000}
        cols={80}
        heights={heights}
        mountedSink={sink}
      />
    </ViewportGeometryContext.Provider>
  );
}

function mount(entries: Entry[], opts: { viewportRows?: number; offset?: number; trailingContentRows?: number } = {}): {
  frame: string;
  mounted: number;
  renders: number;
} {
  const sink = { current: 0 };
  const renders = { current: 0 };
  const { lastFrame, unmount } = render(
    <Harness entries={entries} sink={sink} renders={renders} {...opts} />,
  );
  const frame = lastFrame() ?? '';
  unmount();
  return { frame, mounted: sink.current, renders: renders.current };
}

describe('AC-1: the mounted entry count does not grow with the transcript', () => {
  it('mounts a viewport-sized band out of 5 000 entries', () => {
    const viewportRows = 40;
    const small = mount(notices(100), { viewportRows });
    const large = mount(notices(5000), { viewportRows });

    const ceiling = viewportRows + 2 * VIRTUAL_LIMITS.overscan + 2;
    expect(large.mounted).toBeLessThanOrEqual(ceiling);
    // Within 10% of each other: the whole point is that the number is a function
    // of the VIEWPORT, not of the session length.
    expect(Math.abs(large.mounted - small.mounted)).toBeLessThanOrEqual(
      Math.ceil(small.mounted * 0.1),
    );
  });

  it('V-1: an off-window entry is not in the output at all', () => {
    // The spacers are childless, so nothing above or below the band can appear.
    // If a spacer ever grew a child, this is the assertion that catches it.
    const { frame } = mount(notices(5000), { viewportRows: 20, offset: 2000 });
    expect(frame).not.toContain('MARK0END');
    expect(frame).not.toContain('MARK4999END');
  });

  it('V-3: the last entry is mounted whenever the viewport is pinned', () => {
    const { frame } = mount(notices(5000), { viewportRows: 20, offset: 0 });
    expect(frame).toContain('MARK4999END');
  });

  it('renders every entry of a transcript shorter than the viewport', () => {
    const { frame, mounted } = mount(notices(5), { viewportRows: 40 });
    expect(mounted).toBe(5);
    for (let i = 0; i < 5; i += 1) expect(frame).toContain(`MARK${i}END`);
  });

  it('keeps the "N earlier entries collapsed" line for the scroll horizon', () => {
    const sink = { current: 0 };
    const { lastFrame, unmount } = render(
      <ViewportGeometryContext.Provider value={{ viewportRows: 20, offset: 0, contentRows: 0 }}>
        <TranscriptList
          entries={notices(50)}
          expandedToolIds={{}}
          thinkingVisible
          reducedMotion
          density="compact"
          theme={THEME}
          caps={CAPS}
          windowSize={10}
          cols={80}
          heights={{
            version: 0,
            resolve: (_k, estimate) => estimate(),
            report: () => {},
            stats: () => ({ measured: 0, estimated: 0 }),
            clear: () => {},
          }}
          mountedSink={sink}
        />
      </ViewportGeometryContext.Provider>,
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('40 earlier entries collapsed');
  });
});

describe('K-2: the height store converges', () => {
  it('settles a static transcript in a bounded number of renders', () => {
    // A measure -> setState -> re-measure store that never converges is a HUNG
    // TERMINAL, not an error, which is why the bound is asserted rather than
    // assumed. One render for the estimates, one for the measurements, and a
    // little slack for React's own scheduling.
    const { renders } = mount(notices(200), { viewportRows: 30 });
    expect(renders).toBeLessThanOrEqual(5);
  });
});

it('projects a long footer without mounting the entire transcript', () => {
  const view = mount(notices(10000), { viewportRows: 20, trailingContentRows: 50 });
  expect(view.mounted).toBeLessThanOrEqual(3);
  expect(view.frame).toContain('MARK9999END');
  expect(view.frame).not.toContain('MARK9950END');
});
