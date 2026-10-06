/**
 * The frame differ (tui-input-flicker-fix §3.2 / §4.3).
 *
 * The module is pure by contract, so every case here is plain string literals
 * and no TTY, no Ink and no event emitter. `frame-differ-ink-shape.test.ts` is
 * what ties these synthetic chunks back to what Ink actually writes.
 */

import { describe, expect, it, vi } from 'vitest';
import { createFrameDiffer, eraseLinesPrefix, type FrameDiffer } from '../ui/frame-differ.js';
import React from 'react';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { PromptCaret } from '../ui/PromptCaret.js';

const CSI = '\x1b[';
const SGR_RESET = `${CSI}0m`;
const ERASE_LINE = `${CSI}2K`;
const ERASE_TO_EOL = `${CSI}K`;
const SYNC_BEGIN = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

const ROWS = 24;
/** `frameHeight(24)` — what `AppShell` pins the root box to. */
const HEIGHT = ROWS - 1;

describe('caret frame differential (C-09)', () => {
  it('writes only the blinking input row and parks at H+1', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const inputRow = HEIGHT - 2;
    const view = render(React.createElement(Box, { flexDirection: 'column' },
      ...Array.from({ length: HEIGHT }, (_, index) => React.createElement(Text, { key: index },
        index === inputRow
          ? React.createElement(PromptCaret, { text: 'a', active: true, reducedMotion: false, colorLevel: 0, resetKey: {} })
          : `stable ${index}`)),
    ));
    try {
      const bright = view.lastFrame()!.split('\n');
      expect(bright).toHaveLength(HEIGHT);
      const h = harness();
      h.seed(bright);
      await vi.advanceTimersByTimeAsync(500);
      const dark = view.lastFrame()!.split('\n');
      const output = h.differ.transform(chunk(dark, HEIGHT))!;
      expect(output).toContain(`${CSI}${inputRow + 1};1H`);
      expect(output).toContain(`${CSI}${HEIGHT + 1};1H`);
      expect(output.match(/\x1b\[\d+;1H/g)).toHaveLength(2);
      expect(output).not.toContain('stable');
      expect(output).not.toContain(`${CSI}?25h`);
      expect(output).not.toContain(`${CSI}J`);
    } finally { view.unmount(); vi.useRealTimers(); }
  });
});

function frameBody(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

/** The chunk log-update writes for `lines`, given a previous frame of `prevLines` rows. */
function chunk(lines: string[], prevLines: number): string {
  return eraseLinesPrefix(prevLines === 0 ? 0 : prevLines + 1) + frameBody(lines);
}

function rowsOf(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `row ${i}`);
}

interface Harness {
  differ: FrameDiffer;
  /** Drive the session to a warm cache holding `lines`, returning the differ. */
  seed(lines: string[]): void;
}

function harness(options: { sync?: boolean; rows?: () => number | undefined } = {}): Harness {
  const differ = createFrameDiffer({
    sync: options.sync ?? false,
    rows: options.rows ?? (() => ROWS),
  });
  return {
    differ,
    seed(lines) {
      // Write 1 of the session carries no erase prefix and is passed through
      // WITHOUT seeding (P1-1); write 2 is the full repaint that warms the cache.
      differ.transform(frameBody(lines));
      differ.transform(chunk(lines, lines.length));
    },
  };
}

describe('frame differ — session start (P1-1)', () => {
  it('passes the first write through and does NOT seed the cache', () => {
    const { differ } = harness();
    const lines = rowsOf(HEIGHT);
    // No erase prefix: `previousLineCount` is 0, so `eraseLines(0)` is empty.
    expect(differ.transform(frameBody(lines))).toBeNull();
    // Not counted as a fallback: this is the expected seed write, not a desync.
    expect(differ.stats().fallbacks).toBe(0);
    expect(differ.stats().framesTotal).toBe(0);
  });

  it('makes the SECOND write a full repaint, because the cache is still empty', () => {
    const { differ } = harness();
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    const out = differ.transform(chunk(lines, lines.length));
    expect(out).not.toBeNull();
    expect(out).toContain(`${CSI}1;1H`);
    expect(out).toContain(`${CSI}J`); // erase-down, not H+1 line erases
    expect(differ.stats().framesFull).toBe(1);
    expect(differ.stats().framesDiffed).toBe(0);
  });
});

describe('frame differ — one changed line', () => {
  it('emits exactly one addressed line for a one-row change', () => {
    const h = harness();
    const before = rowsOf(HEIGHT);
    h.seed(before);

    const before2 = h.differ.stats();
    const after = [...before];
    after[HEIGHT - 1] = 'row 22 typed';
    const out = h.differ.transform(chunk(after, HEIGHT));

    expect(out).not.toBeNull();
    const addressed = (out as string).match(/\x1b\[\d+;1H/g) ?? [];
    // One for the changed row, one for the I-5 park.
    expect(addressed).toEqual([`${CSI}${HEIGHT};1H`, `${CSI}${HEIGHT + 1};1H`]);
    expect(h.differ.stats().framesDiffed).toBe(1);
    // The park is NOT counted as a written line — `linesWritten` is what
    // `/perf`'s `lines/frame` divides, and it has to mean "rows repainted".
    expect(h.differ.stats().linesWritten - before2.linesWritten).toBe(1);
  });

  it('paints then tail-clears, and NEVER emits CSI 2K (AC-2 / P0-1)', () => {
    // THE NEGATIVE HALF IS THE LOAD-BEARING HALF. A refactor that reinstates the
    // erase would still satisfy "exactly one addressed line" while putting R1's
    // blank-then-paint window back on the one row the user is watching.
    const h = harness();
    const before = rowsOf(HEIGHT);
    h.seed(before);
    const after = [...before];
    after[3] = 'changed';

    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    expect(out).toContain(`${CSI}4;1H${SGR_RESET}changed${SGR_RESET}${ERASE_TO_EOL}`);
    expect(out).not.toContain(ERASE_LINE);
  });

  it('does not address any composer row when only the spinner ticked (AC-3)', () => {
    const h = harness();
    const before = rowsOf(HEIGHT);
    h.seed(before);
    const after = [...before];
    after[5] = 'row 5 *'; // the activity line, far above the composer

    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    // Rows HEIGHT-2 .. HEIGHT are the bottom chrome; none may be addressed.
    for (const row of [HEIGHT - 2, HEIGHT - 1, HEIGHT]) {
      expect(out).not.toContain(`${CSI}${row};1H`);
    }
  });

  it('parks the cursor on row H+1 at the end of every batch (I-5)', () => {
    const h = harness();
    const before = rowsOf(HEIGHT);
    h.seed(before);
    const after = [...before];
    after[0] = 'x';
    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    expect(out.endsWith(`${CSI}${HEIGHT + 1};1H`)).toBe(true);
  });
});

describe('frame differ — full repaint triggers', () => {
  it('forces the full-repaint form on a line-count change', () => {
    const h = harness();
    h.seed(rowsOf(HEIGHT));
    // The erase prefix still describes the PREVIOUS frame, so it is unchanged;
    // only the new body is shorter.
    const out = h.differ.transform(chunk(rowsOf(HEIGHT - 2), HEIGHT)) as string;
    expect(out).toContain(`${CSI}1;1H`);
    expect(out).toContain(`${CSI}J`);
    expect(h.differ.stats().framesFull).toBe(2); // the seed one, plus this
  });

  it('uses explicit CRLF rather than relying on the tty ONLCR mode', () => {
    const h = harness();
    const { differ } = h;
    differ.transform(frameBody(['a', 'b']));
    const out = differ.transform(chunk(['a', 'b'], 2)) as string;
    expect(out).toContain('a\r\nb\r\n');
  });

  it('repaints in full after invalidate()', () => {
    const h = harness();
    const lines = rowsOf(HEIGHT);
    h.seed(lines);
    h.differ.invalidate();
    const after = [...lines];
    after[1] = 'y';
    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    expect(out).toContain(`${CSI}J`);
    // An invalidation is NOT a fallback (AC-11 / K-14): a resize legitimately
    // invalidates and must not make AC-11 and AC-7 contradict each other.
    expect(h.differ.stats().fallbacks).toBe(0);
  });
});

describe('frame differ — pass-through and invalidation (I-6)', () => {
  it('returns null and invalidates for an unrecognised chunk', () => {
    const h = harness();
    const lines = rowsOf(HEIGHT);
    h.seed(lines);

    expect(h.differ.transform('a foreign write')).toBeNull();
    expect(h.differ.stats().fallbacks).toBe(1);

    // The cache is gone, so the next frame is a full repaint that re-establishes
    // the origin rather than a diff against fiction.
    const after = [...lines];
    after[2] = 'z';
    expect(h.differ.transform(chunk(after, HEIGHT)) as string).toContain(`${CSI}J`);
  });

  it('passes through a prefixed chunk whose body does not end in a newline', () => {
    // `log.clear()` writes the erase prefix and nothing else.
    const h = harness();
    h.seed(rowsOf(HEIGHT));
    expect(h.differ.transform(eraseLinesPrefix(HEIGHT + 1))).toBeNull();
    expect(h.differ.stats().fallbacks).toBe(1);
  });

  it('raises onFirstFallback exactly once per session (AC-15 / §5.6)', () => {
    const onFirstFallback = vi.fn();
    const differ = createFrameDiffer({ sync: false, rows: () => ROWS, onFirstFallback });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));

    differ.transform('foreign one');
    differ.transform('foreign two');
    differ.transform('foreign three');

    expect(differ.stats().fallbacks).toBe(3);
    expect(onFirstFallback).toHaveBeenCalledTimes(1);
  });
});

describe('frame differ — degenerate geometry (I-9 / P1-3 / AC-14)', () => {
  it('stands down entirely at rows = 1', () => {
    // `frameHeight` clamps to 0 there, `frame.ts:30-38` records the range as
    // REACHABLE, and step 11 would address row 2 on a one-row terminal.
    const h = harness({ rows: () => 1 });
    expect(h.differ.transform(frameBody(['']))).toBeNull();
    expect(h.differ.transform(chunk([''], 1))).toBeNull();
    // Not a fallback: nothing wrote behind Ink's back, the viewport is just too
    // small to address, and firing the §5.6 notice for a window drag would be a
    // false alarm on the one message whose whole value is precision.
    expect(h.differ.stats().fallbacks).toBe(0);
  });

  it('stands down when the frame would not fit: lines.length + 1 > rows', () => {
    const h = harness();
    h.seed(rowsOf(HEIGHT));
    // A frame as tall as the terminal leaves no row to park the cursor on.
    expect(h.differ.transform(chunk(rowsOf(ROWS), HEIGHT))).toBeNull();
    expect(h.differ.stats().fallbacks).toBe(0);
  });

  it('stands down when stdout.rows is missing', () => {
    const h = harness({ rows: () => undefined });
    expect(h.differ.transform(frameBody(rowsOf(HEIGHT)))).toBeNull();
  });
});

describe('frame differ — DEC 2026 envelope (F2)', () => {
  it('wraps each batch when sync is on', () => {
    const h = harness({ sync: true });
    const lines = rowsOf(HEIGHT);
    h.seed(lines);
    const after = [...lines];
    after[0] = 'w';
    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    expect(out.startsWith(SYNC_BEGIN)).toBe(true);
    expect(out.endsWith(SYNC_END)).toBe(true);
  });

  it('emits no envelope when sync is off, and still diffs', () => {
    const h = harness({ sync: false });
    const lines = rowsOf(HEIGHT);
    h.seed(lines);
    const after = [...lines];
    after[0] = 'w';
    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    expect(out).not.toContain(SYNC_BEGIN);
    expect(out).not.toContain(SYNC_END);
    expect(out).toContain(`${CSI}1;1H`);
  });

  it('hands the envelope to ONE write — it is a single string (P2-5 / K-13)', () => {
    // A refactor that emitted the markers separately would take on a
    // freeze-the-terminal failure mode this design does not have.
    const h = harness({ sync: true });
    const lines = rowsOf(HEIGHT);
    h.seed(lines);
    const after = [...lines];
    after[0] = 'w';
    const out = h.differ.transform(chunk(after, HEIGHT)) as string;
    expect(out.split(SYNC_BEGIN)).toHaveLength(2);
    expect(out.split(SYNC_END)).toHaveLength(2);
  });
});

describe('frame differ — defensive guard, not a live path (P2-4)', () => {
  it("returns '' for an identical frame, which log-update never actually sends", () => {
    // `log-update.js:13-15` returns early when the output is unchanged, so a
    // chunk reaching the differ always differs by at least one line. This asserts
    // THE GUARD; it does not document a reachable behaviour.
    const h = harness();
    const lines = rowsOf(HEIGHT);
    h.seed(lines);
    expect(h.differ.transform(chunk(lines, HEIGHT))).toBe('');
  });
});

describe('frame differ — counters (§5.4)', () => {
  it('keeps framesTotal equal to framesDiffed + framesFull', () => {
    const h = harness();
    const lines = rowsOf(HEIGHT);
    h.seed(lines);
    for (let i = 0; i < 5; i += 1) {
      const next = [...lines];
      next[0] = `tick ${i}`;
      h.differ.transform(chunk(next, HEIGHT));
    }
    h.differ.transform('foreign');
    const s = h.differ.stats();
    expect(s.framesTotal).toBe(s.framesDiffed + s.framesFull);
    expect(s.fallbacks).toBe(1);
    expect(s.bytesWritten).toBeGreaterThan(0);
  });

  it('hands back a copy, so a caller cannot mutate the live counters', () => {
    const h = harness();
    const snapshot = h.differ.stats();
    snapshot.fallbacks = 99;
    expect(h.differ.stats().fallbacks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// decorate / repaint (tui-selection-and-scroll-follow §4.4.3)
// ---------------------------------------------------------------------------

/** A `decorate` that marks one row, so "was it painted" is a substring test. */
function markRow(row: number, mark = '<<SEL>>') {
  return (lines: string[]): string[] => {
    const out = lines.slice();
    if (row < out.length) out[row] = mark + out[row]!;
    return out;
  };
}

describe('frame differ — decorate (I-2)', () => {
  it('T-8: runs before the diff, so the cache equals the SCREEN', () => {
    // Diffing RAW against a painted screen would leave the highlight burned into
    // rows the next frame never repaints, because those rows' raw text did not
    // change. Two caches — painted and raw — is what buys I-2.
    let decorate = markRow(2);
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      decorate: (lines) => decorate(lines),
    });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    const full = differ.transform(chunk(lines, HEIGHT));
    expect(full).toContain('<<SEL>>row 2');

    // A frame whose raw rows are identical still repaints the row whose PAINT
    // changed, and nothing else.
    decorate = markRow(2, '<<OTHER>>');
    const next = [...lines];
    next[5] = 'row five changed';
    const out = differ.transform(chunk(next, HEIGHT));
    expect(out).toContain('<<OTHER>>row 2');
    expect(out).toContain('row five changed');
    expect(out).not.toContain('row 7');
  });

  it('runs AFTER the geometry stand-down, so a stood-down frame never reaches it', () => {
    // I-9. A frame the differ refuses to address must not be handed to the
    // selection layer at all.
    let calls = 0;
    const differ = createFrameDiffer({
      sync: false,
      rows: () => undefined,
      decorate: (lines) => {
        calls += 1;
        return lines;
      },
    });
    differ.transform(frameBody(rowsOf(4)));
    differ.transform(chunk(rowsOf(4), 4));
    expect(calls).toBe(0);
  });

  it('discards a decorator that changes the line count', () => {
    // A different number of rows would shift every absolute address below it for
    // the rest of the session.
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      decorate: (lines) => [...lines, 'extra'],
    });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    const out = differ.transform(chunk(lines, HEIGHT));
    expect(out).not.toContain('extra');
  });
});

describe('frame differ — repaint()', () => {
  it('T-8: emits ONLY the rows whose paint changed', () => {
    let decorate = (lines: string[]): string[] => lines;
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      decorate: (lines) => decorate(lines),
    });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));

    decorate = markRow(3);
    const out = differ.repaint();
    expect(out).toContain('<<SEL>>row 3');
    expect(out).not.toContain('row 4');
    // Drag cost is O(CHANGED ROWS), which is the whole reason the highlight is
    // painted in the frame pipeline rather than in React (D-6): one addressed
    // row, plus the I-5 park on H+1.
    expect(out.match(/\x1b\[\d+;1H/g)).toHaveLength(2);
  });

  it('returns `` when the paint did not move', () => {
    const differ = createFrameDiffer({ sync: false, rows: () => ROWS, decorate: (l) => l });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));
    expect(differ.repaint()).toBe('');
  });

  it('T-9: returns `` after invalidate() — no absolute write against an unknown screen', () => {
    const differ = createFrameDiffer({ sync: false, rows: () => ROWS, decorate: markRow(1) });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));
    differ.invalidate();
    expect(differ.repaint()).toBe('');
  });

  it('P2-6: carries the sync envelope and parks on H+1, like every other batch', () => {
    let decorate = (lines: string[]): string[] => lines;
    const differ = createFrameDiffer({
      sync: true,
      rows: () => ROWS,
      decorate: (lines) => decorate(lines),
    });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));
    decorate = markRow(0);
    const out = differ.repaint();
    expect(out.startsWith(SYNC_BEGIN)).toBe(true);
    expect(out.endsWith(SYNC_END)).toBe(true);
    expect(out).toContain(`${CSI}${HEIGHT + 1};1H`);
  });

  it('T-32: never touches framesTotal / framesDiffed / fallbacks', () => {
    // `/perf`'s "frames" means FRAMES INK PRODUCED. Folding self-initiated
    // repaints in would make the reported frame rate a function of how much the
    // user dragged the mouse.
    let decorate = (lines: string[]): string[] => lines;
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      decorate: (lines) => decorate(lines),
    });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));
    const before = differ.stats();

    decorate = markRow(2);
    expect(differ.repaint()).not.toBe('');
    const after = differ.stats();
    expect(after.framesTotal).toBe(before.framesTotal);
    expect(after.framesDiffed).toBe(before.framesDiffed);
    expect(after.framesFull).toBe(before.framesFull);
    expect(after.fallbacks).toBe(before.fallbacks);
    expect(after.repaints).toBe(before.repaints + 1);
  });
});

describe('frame differ — onInvalidate (P1-7)', () => {
  it('T-31: fires on a foreign write, on an explicit invalidate, and on a stand-down', () => {
    // ═══ THE HOLE IN I-4's "BY CONSTRUCTION" ARGUMENT ═══
    //
    // On every pass-through the RAW Ink frame reaches the screen verbatim, so the
    // highlight is wiped off the terminal while the controller still believes it
    // is painted and its mirror still holds the rows of the last DECORATED frame.
    // A release would then copy text that is not on screen. One callback closes
    // it.
    let rows: number | undefined = ROWS;
    let invalidations = 0;
    const differ = createFrameDiffer({
      sync: false,
      rows: () => rows,
      decorate: (l) => l,
      onInvalidate: () => {
        invalidations += 1;
      },
    });
    const lines = rowsOf(HEIGHT);
    differ.transform(frameBody(lines));
    differ.transform(chunk(lines, HEIGHT));
    const seed = invalidations;

    differ.transform('a foreign write');
    expect(invalidations).toBeGreaterThan(seed);

    const afterForeign = invalidations;
    differ.invalidate();
    expect(invalidations).toBe(afterForeign + 1);

    rows = 2; // degenerate geometry
    differ.transform(chunk(lines, HEIGHT));
    expect(invalidations).toBe(afterForeign + 2);
  });

  it('does not recurse when the listener invalidates again', () => {
    // The listener clears the selection, which asks for a repaint, which can
    // reach `invalidate()` again.
    let depth = 0;
    let maxDepth = 0;
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      onInvalidate: () => {
        depth += 1;
        maxDepth = Math.max(maxDepth, depth);
        differ.invalidate();
        depth -= 1;
      },
    });
    differ.invalidate();
    expect(maxDepth).toBe(1);
  });
});


describe('shared Ink frame prefix recognition', () => {
  it('preserves differ seed and erase semantics after parser extraction', async () => {
    const { parseInkFrame } = await import('../ui/frame-parser.js');
    const body = 'header\ntrack|\nstatus\n';
    expect(parseInkFrame(body)).toEqual(['header', 'track|', 'status']);
    expect(parseInkFrame(eraseLinesPrefix(4) + body)).toEqual(parseInkFrame(body));
    const differ = createFrameDiffer({ rows: () => 24, sync: false });
    expect(differ.transform(body)).toBeNull();
    expect(differ.transform(eraseLinesPrefix(4) + body)).not.toBeNull();
  });
});

describe('frame differ - CSI K only for rows narrower than the terminal (T3-T5)', () => {
  const COLS = 20;
  const full = 'a'.repeat(COLS);
  const eolCount = (out: string): number => out.split(ERASE_TO_EOL).length - 1;

  function warm(cols: (() => number | undefined) | undefined) {
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      ...(cols ? { cols } : {}),
      decorate: (lines) => lines.map((line) => line),
    });
    const base = rowsOf(HEIGHT);
    differ.transform(frameBody(base));
    differ.transform(chunk(base, HEIGHT));
    return { differ, base };
  }

  it('keeps EL on every changed row when cols is not provided', () => {
    const { differ, base } = warm(undefined);
    const next = [...base];
    next[1] = full;
    next[2] = 'short';
    expect(eolCount(differ.transform(chunk(next, HEIGHT))!)).toBe(2);
  });

  it('keeps EL on every changed row when cols is not finite', () => {
    const { differ, base } = warm(() => Number.NaN);
    const next = [...base];
    next[1] = full;
    expect(eolCount(differ.transform(chunk(next, HEIGHT))!)).toBe(1);
  });

  it('skips EL at width cols and cols+1 but keeps it at cols-1', () => {
    const { differ, base } = warm(() => COLS);
    const next = [...base];
    next[1] = full; // exactly cols
    next[2] = `${full}b`; // overflow row
    next[3] = full.slice(1); // cols - 1
    const out = differ.transform(chunk(next, HEIGHT))!;
    expect(eolCount(out)).toBe(1);
    expect(out).toContain(`${full.slice(1)}${SGR_RESET}${ERASE_TO_EOL}`);
    expect(out).not.toContain(`${full}${SGR_RESET}${ERASE_TO_EOL}`);
  });

  it('measures display width so a CJK row that exactly fills the line skips EL', () => {
    const { differ, base } = warm(() => COLS);
    const next = [...base];
    next[1] = '\u4e2d'.repeat(COLS / 2); // 10 chars, 20 columns
    next[2] = '\u4e2d'.repeat(COLS / 2 - 1); // 9 chars, 18 columns
    expect(eolCount(differ.transform(chunk(next, HEIGHT))!)).toBe(1);
  });

  it('ignores SGR escapes when measuring width', () => {
    const { differ, base } = warm(() => COLS);
    const next = [...base];
    next[1] = `${CSI}2m${'a'.repeat(COLS - 1)}${CSI}0m${CSI}1m|${CSI}0m`;
    expect(eolCount(differ.transform(chunk(next, HEIGHT))!)).toBe(0);
  });

  it('applies the same rule to repaint() (selection highlight never erases the edge)', () => {
    let mark = false;
    const differ = createFrameDiffer({
      sync: false,
      rows: () => ROWS,
      cols: () => COLS,
      decorate: (lines) => (mark ? lines.map((l, i) => (i === 1 || i === 2 ? `${CSI}7m${l}${CSI}27m` : l)) : lines),
    });
    const base = rowsOf(HEIGHT);
    base[1] = full;
    base[2] = 'short';
    differ.transform(frameBody(base));
    differ.transform(chunk(base, HEIGHT));
    mark = true;
    const out = differ.repaint();
    expect(out).toContain(full);
    // Row 2 ('short') keeps its EL, the full-width row 1 does not.
    expect(eolCount(out)).toBe(1);
    expect(out).toContain(`short${CSI}27m${SGR_RESET}${ERASE_TO_EOL}`);
  });
});
