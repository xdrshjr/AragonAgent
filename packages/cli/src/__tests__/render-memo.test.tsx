/**
 * Memo boundaries (tui-render-performance L2 / AC-2 / I-L2-1 / K-3).
 *
 * `mapEntry` already preserves object identity for untouched entries, which is
 * precisely the input a `React.memo` comparator needs — so the material for this
 * has existed since the reducer was written and was simply unused.
 *
 * K-3 is the failure this file exists to catch: if a future change makes `theme`
 * or `caps` a fresh object per render, every boundary silently becomes a no-op
 * AND NOTHING FAILS. The static guard at the bottom is the only thing that turns
 * that into a red test.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink-testing-library';

/**
 * A counting stand-in for `UserEntry`. `EntryView`'s memo is what decides
 * whether this is ever re-invoked, so the counter measures exactly AC-2.
 */
const counts = vi.hoisted(() => ({ byText: new Map<string, number>() }));
vi.mock('../ui/entries/UserEntry.js', () => ({
  UserEntry: ({ text }: { text: string }) => {
    counts.byText.set(text, (counts.byText.get(text) ?? 0) + 1);
    return null;
  },
}));

const { TranscriptList, EntryView } = await import('../ui/Transcript.js');
const { ViewportGeometryContext } = await import('../ui/layout/viewport-geometry.js');
const { useHeightStore } = await import('../ui/use-height-store.js');
const { getTheme } = await import('../ui/theme.js');
import type { Entry } from '../agent/reducer.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);
const NO_EXPANDED: Record<string, true> = {};
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function Harness({ entries }: { entries: Entry[] }): React.ReactElement {
  const heights = useHeightStore();
  return (
    <ViewportGeometryContext.Provider value={{ viewportRows: 40, offset: 0, contentRows: 0 }}>
      <TranscriptList
        entries={entries}
        expandedToolIds={NO_EXPANDED}
        thinkingVisible
        reducedMotion
        density="compact"
        theme={THEME}
        caps={CAPS}
        windowSize={1000}
        cols={80}
        heights={heights}
      />
    </ViewportGeometryContext.Provider>
  );
}

describe('AC-2: a textDelta re-renders exactly one EntryView', () => {
  it('leaves untouched entries alone across a streaming update', () => {
    counts.byText.clear();

    // Identity-preserved, exactly as `mapEntry` leaves them.
    const users: Entry[] = [
      { id: 'e1', kind: 'user', text: 'first question' },
      { id: 'e2', kind: 'user', text: 'second question' },
    ];
    const streaming = (text: string): Entry => ({
      id: 'e3',
      kind: 'assistant',
      text,
      thinkingOpen: false,
      streaming: true,
    });

    const { rerender, unmount } = render(<Harness entries={[...users, streaming('He')]} />);
    const afterFirst = new Map(counts.byText);
    expect(afterFirst.get('first question')).toBeGreaterThan(0);

    // The SAME user objects, a NEW assistant object -- one `textDelta`.
    rerender(<Harness entries={[...users, streaming('Hello')]} />);
    unmount();

    expect(counts.byText.get('first question')).toBe(afterFirst.get('first question'));
    expect(counts.byText.get('second question')).toBe(afterFirst.get('second question'));
  });
});

describe('the EntryView comparator', () => {
  const compare = (EntryView as unknown as {
    compare: (a: Record<string, unknown>, b: Record<string, unknown>) => boolean;
  }).compare;

  const base = {
    entry: { id: 'e1', kind: 'user', text: 'x' } as Entry,
    prev: undefined,
    expanded: false,
    thinkingVisible: true,
    reducedMotion: false,
    density: 'compact' as const,

    theme: THEME,
    caps: CAPS,
  };

  it('skips a re-render when every prop is identical', () => {
    expect(compare({ ...base }, { ...base })).toBe(true);
  });

  it('re-renders when the entry object changes', () => {
    expect(compare(base, { ...base, entry: { ...base.entry } })).toBe(false);
  });

  it('re-renders when the PREDECESSOR changes', () => {
    // `prev` feeds `separationRows`, so an entry whose predecessor changed kind
    // must re-render even though the entry itself did not.
    const prev: Entry = { id: 'e0', kind: 'user', text: 'p' };
    expect(compare({ ...base, prev }, { ...base, prev: { ...prev } })).toBe(false);
  });

  it('re-renders on every switch that changes the rendered output', () => {
    expect(compare(base, { ...base, expanded: true })).toBe(false);
    expect(compare(base, { ...base, thinkingVisible: false })).toBe(false);
    expect(compare(base, { ...base, reducedMotion: true })).toBe(false);
    expect(compare(base, { ...base, density: 'comfortable' })).toBe(false);
    expect(compare(base, { ...base, theme: getTheme('warm', CAPS) })).toBe(false);
    expect(compare(base, { ...base, caps: { colorLevel: 0, unicode: false } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-L2-1 / K-3 — theme and caps must stay referentially stable
// ---------------------------------------------------------------------------

describe('I-L2-1: App memoizes theme and caps', () => {
  const app = readFileSync(resolve(SRC, 'ui/App.tsx'), 'utf8');

  it('computes `caps` through useMemo', () => {
    // A fresh object per render here silently turns EVERY memo boundary in the
    // transcript into a no-op, with no error and no visible symptom beyond the
    // performance regression the whole feature exists to fix.
    expect(app).toMatch(/const caps = useMemo<TermCapabilities>\(/);
  });

  it('computes `theme` through useMemo', () => {
    expect(app).toMatch(/const theme = useMemo\(\(\) => getTheme\(/);
  });

  it('passes both straight down rather than reshaping them per render', () => {
    // `theme={{ ...theme }}` anywhere in the transcript path would defeat the
    // comparator just as thoroughly as dropping the useMemo.
    expect(app).not.toMatch(/theme=\{\{/);
    expect(app).not.toMatch(/caps=\{\{/);
  });
});

describe('the entry components are memo boundaries', () => {
  it('wraps every card that renders per frame', async () => {
    const isMemo = (c: unknown): boolean =>
      typeof c === 'object' && c !== null && 'compare' in (c as object);
    const { AssistantEntry } = await import('../ui/entries/AssistantEntry.js');
    const { ToolCard } = await import('../ui/entries/ToolCard.js');
    const { TeamCard } = await import('../ui/entries/TeamCard.js');
    const { TodoCard } = await import('../ui/entries/TodoCard.js');
    for (const [name, component] of Object.entries({ AssistantEntry, ToolCard, TeamCard, TodoCard })) {
      expect(isMemo(component), name).toBe(true);
    }
  });
});
