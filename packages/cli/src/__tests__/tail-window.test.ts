/**
 * The tail window and the print boundary (tui-full-height-live-region AC-F8 / AC-F9,
 * invariants I-F8 / I-F9).
 *
 * These are properties rather than examples because `tail-window.ts` is pure: the whole
 * input space (window size, excluded entries, few entries, hundreds) is enumerable, and
 * the assertions state the invariant instead of a golden index.
 */

import { describe, expect, it } from 'vitest';
import type { Entry } from '../agent/reducer.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import {
  printBoundary,
  selectTailWindow,
  tailWindowStart,
  type TailWindow,
} from '../ui/scrollback/tail-window.js';

function user(id: string): Entry {
  return { id, kind: 'user', text: `message ${id}` };
}

function streaming(id: string): Entry {
  return {
    id, kind: 'assistant', text: 'half an answer', thinkingOpen: false, streaming: true,
  };
}

/** A non-terminal `service` card: printed never, so it never takes a window slot. */
function service(id: string, terminal = false): Entry {
  return { id, kind: 'service', serviceId: id, status: 'running', terminal } as unknown as Entry;
}

const messages = (count: number): Entry[] =>
  Array.from({ length: count }, (_, index) => user(`u${index}`));

describe('tailWindowStart', () => {
  it('is the index of the last K printable entries (AC-F8)', () => {
    expect(tailWindowStart(messages(20), SCROLLBACK_LIMITS.liveTailMaxEntries)).toBe(10);
    // Fewer entries than the window holds: the whole conversation is on screen.
    expect(tailWindowStart(messages(3), SCROLLBACK_LIMITS.liveTailMaxEntries)).toBe(0);
    expect(tailWindowStart([], 10)).toBe(0);
  });

  it('excluded entries do not occupy a slot (AC-F8)', () => {
    const entries: Entry[] = [
      ...messages(5),
      service('s1'), service('s2'), service('s3'),
      ...messages(15).map((entry) => ({ ...entry, id: `late-${entry.id}` })),
    ];
    const start = tailWindowStart(entries, 10);
    const window = entries.slice(start).filter((entry) => entry.kind !== 'service');
    expect(window).toHaveLength(10);
    // All three excluded cards sit before the window start: they consumed no slot.
    expect(start).toBe(entries.length - 10);
  });

  it('a terminal service record is printable and does take a slot', () => {
    const entries: Entry[] = [...messages(9), service('s1', true)];
    // 10 printable entries: the window starts at index 0.
    expect(tailWindowStart(entries, 10)).toBe(0);
    const eleven: Entry[] = [...messages(10), service('s1', true)];
    expect(tailWindowStart(eleven, 10)).toBe(1);
  });

  it('K = 0 means no window at all: everything printable may print (AC-F8)', () => {
    const entries = messages(20);
    expect(tailWindowStart(entries, 0)).toBe(entries.length);
    expect(tailWindowStart(entries, -3)).toBe(entries.length);
    expect(tailWindowStart(entries, Number.NaN)).toBe(entries.length);
  });

  it('is monotone in the entry list: appending never moves the start backwards (I-F9)', () => {
    let previous = 0;
    for (let count = 0; count <= 200; count += 1) {
      const start = tailWindowStart(messages(count), SCROLLBACK_LIMITS.liveTailMaxEntries);
      expect(start).toBeGreaterThanOrEqual(previous);
      previous = start;
    }
  });
});

describe('selectTailWindow', () => {
  it('returns the start and the printable entries inside the window', () => {
    const window: TailWindow = selectTailWindow(messages(14), 4);
    expect(window.start).toBe(10);
    expect(window.entries.map((entry) => entry.id)).toEqual(['u10', 'u11', 'u12', 'u13']);
  });

  it('drops the excluded entries that fall inside the window', () => {
    const entries: Entry[] = [...messages(5), service('s1'), user('tail')];
    const window = selectTailWindow(entries, 3);
    expect(window.start).toBe(3);
    expect(window.entries.map((entry) => entry.id)).toEqual(['u3', 'u4', 'tail']);
  });
});

describe('printBoundary', () => {
  it('never crosses the settled boundary: a streaming entry is never printed (AC-F9)', () => {
    const entries: Entry[] = [...messages(5), streaming('a1')];
    // The streaming assistant is entry 5 and a wall for `settledCount`, so the window
    // start (3) is the binding term - and the wall is never crossed either way.
    expect(printBoundary(entries, true, 3)).toBe(3);
    expect(printBoundary(entries, true, 1)).toBe(5);
    // A window wider than the list holds the whole conversation back, wall or not.
    expect(printBoundary(entries, true, 100)).toBe(0);
  });

  it('is min(settledCount, tailWindowStart)', () => {
    const windowed = messages(30);
    expect(printBoundary(windowed, false, 10)).toBe(20);
    // `settledCount` alone would allow all 30; the window is what holds them back.
    expect(printBoundary(windowed, false, 0)).toBe(30);
  });

  it('lets an entry print exactly when it leaves the window, in order (AC-F9)', () => {
    const printed: string[] = [];
    let entries = messages(SCROLLBACK_LIMITS.liveTailMaxEntries + 2);
    let boundary = printBoundary(entries, false, SCROLLBACK_LIMITS.liveTailMaxEntries);
    expect(boundary).toBe(2);
    printed.push(...entries.slice(0, boundary).map((entry) => entry.id));
    // Two more entries arrive: the boundary advances by exactly those two.
    entries = [...entries, user('u12'), user('u13')];
    boundary = printBoundary(entries, false, SCROLLBACK_LIMITS.liveTailMaxEntries);
    printed.push(...entries.slice(2, boundary).map((entry) => entry.id));
    expect(printed).toEqual(['u0', 'u1', 'u2', 'u3']);
  });
});
