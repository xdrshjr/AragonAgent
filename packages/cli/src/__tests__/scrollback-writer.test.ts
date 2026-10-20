import { describe, expect, it, vi } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import {
  canvasBytes, canvasSeedBytes, fillBytes, skipRows,
} from '../ui/scrollback/writer-shapes.js';

const ESC = '\x1b[';
const SGR0 = `${ESC}0m`;
const R = (t: string): string => SGR0 + t + SGR0 + '\r\n';
const TALL = `${ESC}2J${ESC}3J${ESC}H`;

function make(over: Partial<Parameters<typeof createScrollbackWriter>[0]> = {}) {
  const drain = createScrollbackDrain();
  let rows: number | undefined = 24;
  let cols: number | undefined = 80;
  let t = 1_000_000;
  const writer = createScrollbackWriter({
    rows: () => rows, cols: () => cols, sync: false, fullEveryFrame: false, drain,
    now: () => t, ...over,
  });
  /** An Ink-shaped write: `eraseLines(previous + 1)` then the frame and a newline. */
  let inkCount = 0;
  const ink = (lines: string[]): string => {
    const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
    inkCount = lines.length + 1;
    return chunk;
  };
  return {
    drain, writer, ink,
    setRows: (v: number | undefined) => { rows = v; },
    setCols: (v: number | undefined) => { cols = v; },
    advance: (ms: number) => { t += ms; },
  };
}

describe('ScrollbackWriter byte shapes', () => {
  it('seed_starts_with_carriage_return and prints statics before the region', () => {
    const { writer, drain, ink } = make();
    drain.enqueue(['hello'], { id: 'a', kind: 'user' });
    const out = writer.transform(ink(['L1', 'L2']));
    expect(out).toBe('\r' + SGR0 + R('hello') + R('L1') + R('L2'));
  });

  it('reseed_starts_with_crlf after a foreign write', () => {
    const { writer, ink } = make();
    writer.transform(ink(['L1']));
    expect(writer.transform('not a frame')).toBeNull();
    const out = writer.transform(ink(['L1']));
    expect(out?.startsWith('\r\n\r' + SGR0)).toBe(true);
  });

  it('full_erases_exactly_previous_region: CUU(H0), no more', () => {
    const { writer, drain, ink } = make();
    writer.transform(ink(['L1', 'L2', 'L3']));
    drain.enqueue(['S1'], { id: 'a', kind: 'user' });
    const out = writer.transform(ink(['L1', 'L2', 'L3']));
    expect(out).toBe(`${ESC}3A` + '\r' + SGR0 + `${ESC}J` + R('S1') + R('L1') + R('L2') + R('L3'));
  });

  it('diff_parks_below_region and rewrites only changed rows, paint then clear tail', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a', 'b', 'c', 'd']));
    const out = writer.transform(ink(['a', 'B', 'c', 'D']));
    expect(out).toBe(
      `${ESC}3A` + '\r' + SGR0 + 'B' + SGR0 + `${ESC}K` +
      `${ESC}2B` + '\r' + SGR0 + 'D' + SGR0 + `${ESC}K` + `${ESC}1B` + '\r',
    );
    expect(out).not.toContain(`${ESC}2K`);
  });

  it('wraps every batch in DEC 2026 when sync is on', () => {
    const { writer, ink } = make({ sync: true });
    const out = writer.transform(ink(['a']))!;
    expect(out.startsWith(`${ESC}?2026h`)).toBe(true);
    expect(out.endsWith(`${ESC}?2026l`)).toBe(true);
  });

  it('writes nothing for an identical frame', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a', 'b']));
    expect(writer.transform(ink(['a', 'b']))).toBe('');
  });

  it('fullEveryFrame rewrites the whole region even when nothing changed', () => {
    const { writer, ink } = make({ fullEveryFrame: true });
    writer.transform(ink(['a', 'b']));
    expect(writer.transform(ink(['a', 'b']))).toBe(
      `${ESC}2A` + '\r' + SGR0 + `${ESC}J` + R('a') + R('b'),
    );
  });

  it('a height change is a FULL batch', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a', 'b']));
    const out = writer.transform(ink(['a', 'b', 'c']))!;
    expect(out.startsWith(`${ESC}2A`)).toBe(true);
    expect(out).toContain(`${ESC}J`);
  });
});

describe('ScrollbackWriter guards', () => {
  it('swallows_tall_frame_without_erasing_scrollback', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a']));
    expect(writer.transform(TALL + 'frame')).toBe('');
    expect(writer.scrollbackStats().guardHits).toBe(1);
  });

  it('three_consecutive_guard_hits_trip_callback (outside the resize grace)', () => {
    const onGuardTrip = vi.fn();
    const { writer, ink } = make({ onGuardTrip });
    writer.transform(ink(['a']));
    writer.transform(TALL + 'x');
    writer.transform(TALL + 'x');
    expect(onGuardTrip).not.toHaveBeenCalled();
    writer.transform(TALL + 'x');
    expect(onGuardTrip).toHaveBeenCalledTimes(1);
    expect(writer.scrollbackStats().guardHitsOutsideResize).toBe(3);
  });

  it('resize_drag_does_not_trip_guard', () => {
    const onGuardTrip = vi.fn();
    const { writer, ink, advance } = make({ onGuardTrip });
    writer.transform(ink(['a']));
    for (let i = 0; i < 10; i += 1) {
      writer.onResize!();
      advance(20); // a drag fires resize events faster than the 250 ms grace
      writer.transform(TALL + 'x');
    }
    expect(onGuardTrip).not.toHaveBeenCalled();
    expect(writer.scrollbackStats().guardHits).toBe(10);
    expect(writer.scrollbackStats().guardHitsOutsideResize).toBe(0);
  });

  it('a normal frame clears the consecutive-guard count', () => {
    const onGuardTrip = vi.fn();
    const { writer, ink } = make({ onGuardTrip });
    writer.transform(ink(['a']));
    writer.transform(TALL + 'x');
    writer.transform(TALL + 'x');
    writer.transform(ink(['b']));
    writer.transform(TALL + 'x');
    expect(onGuardTrip).not.toHaveBeenCalled();
  });

  it('osc52_does_not_invalidate: the next frame is a diff, not a seed', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a', 'b']));
    writer.cursorNeutralWrite!();
    const out = writer.transform(ink(['a', 'c']))!;
    expect(out).toContain(`${ESC}K`);
    expect(writer.scrollbackStats().framesSeed).toBe(1);
  });

  it('counts an unparseable write and raises onFirstFallback once', () => {
    const onFirstFallback = vi.fn();
    const { writer, ink } = make({ onFirstFallback });
    writer.transform(ink(['a']));
    expect(writer.transform('garbage')).toBeNull();
    expect(writer.transform('garbage')).toBeNull();
    expect(onFirstFallback).toHaveBeenCalledTimes(1);
    expect(writer.scrollbackStats().fallbacks).toBe(2);
  });

  it('placeholder_region_keeps_h0_in_sync: a pass-through frame still updates H0', () => {
    const { writer, drain, ink, setRows } = make();
    writer.transform(ink(['a', 'b', 'c', 'd']));
    setRows(1); // too small to address
    expect(writer.transform(ink(['x']))).toBeNull();
    expect(writer.regionRows()).toBe(1);
    setRows(24);
    drain.enqueue(['S'], { id: 's', kind: 'user' });
    const out = writer.transform(ink(['x']))!;
    // CUU(1): the placeholder region, not the stale 4-row one (that would erase history).
    expect(out.startsWith(`${ESC}1A`)).toBe(true);
  });

  it('clips_overwide_row_and_counts_it (I-S13)', () => {
    const { writer, ink, setCols } = make();
    setCols(10);
    const out = writer.transform(ink(['x'.repeat(30)]))!;
    expect(out).toBe('\r' + SGR0 + R('x'.repeat(9) + SGR0));
    expect(writer.scrollbackStats().clippedRows).toBe(1);
  });

  it('clips wide CJK glyphs by display columns, never splitting a glyph', () => {
    const { writer, ink, setCols } = make();
    setCols(6); // 5 usable columns
    const wide = '中';
    const out = writer.transform(ink([wide.repeat(5)]))!; // 10 columns of CJK
    expect(out).toContain(wide + wide + SGR0);
    expect(out).not.toContain(wide + wide + wide);
  });

  it('splits_oversized_static_batch across consecutive repaints', () => {
    const requests = vi.fn();
    const { writer, drain, ink } = make({ requestRepaint: requests });
    writer.transform(ink(['L']));
    const per = SCROLLBACK_LIMITS.maxRowsPerBatch;
    drain.enqueue(Array.from({ length: per }, (_, i) => `a${i}`), { id: 'a', kind: 'assistant' });
    drain.enqueue(['b0', 'b1'], { id: 'b', kind: 'assistant' });
    const first = writer.repaint();
    expect(first).toContain('a0');
    expect(first).not.toContain('b0');
    expect(drain.pending()).toBe(2);
    expect(requests).toHaveBeenCalled();
    const second = writer.repaint();
    expect(second).toContain('b0');
    expect(drain.pending()).toBe(0);
  });

  it('repaint flushes static rows when Ink produced no new frame', () => {
    const { writer, drain, ink } = make();
    writer.transform(ink(['L1', 'L2']));
    expect(writer.repaint()).toBe('');
    drain.enqueue(['S'], { id: 's', kind: 'user' });
    expect(writer.repaint()).toBe(`${ESC}2A` + '\r' + SGR0 + `${ESC}J` + R('S') + R('L1') + R('L2'));
    expect(writer.scrollbackStats().repaints).toBe(1);
  });

  it('repaint is inert before the first frame (statics wait for the seed)', () => {
    const { writer, drain, ink } = make();
    drain.enqueue(['S'], { id: 's', kind: 'user' });
    expect(writer.repaint()).toBe('');
    expect(writer.transform(ink(['L']))).toContain('S');
  });
});

describe('ScrollbackWriter resize', () => {
  it('a_width_change_resets_and_reseeds instead of estimating a reflow', () => {
    const { writer, ink, setCols } = make();
    writer.transform(ink(['x'.repeat(70), 'y']));
    setCols(40);
    writer.onResize!();
    // D5: the rows on screen were re-flowed by the terminal, so the cached erase
    // distance describes nothing. Drop the geometry; the next batch starts a new canvas
    // one line lower (a re-seed always pays for its own CRLF).
    expect(writer.anchorStats().state).toBe('unknown');
    expect(writer.scrollbackStats().anchorResets).toBe(1);
    const out = writer.transform(ink(['x'.repeat(30), 'y']))!;
    expect(out.startsWith('\r\n\r' + SGR0)).toBe(true);
  });

  it('a_shrink_resets_instead_of_erasing on a stale height', () => {
    const { writer, ink, setRows } = make();
    writer.transform(ink(['a', 'b']));
    setRows(1);
    writer.onResize!();
    expect(writer.anchorStats().state).toBe('unknown');
    expect(writer.scrollbackStats().anchorResets).toBe(1);
  });

  it('growth keeps the canvas and widens it by the exact delta', () => {
    const { writer, ink, setRows } = make();
    writer.setAnchorSpaceBelow(30, 'probe');
    writer.transform(ink(['L1', 'L2']));
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 23, top: 0 });
    setRows(30);
    writer.onResize!();
    // 23 + 6 and `top` stays 0: `top + capacity` is still `rows - 1`.
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 23, top: 0 });
    const out = writer.transform(ink(['L1', 'L2']))!;
    expect(out.startsWith(`${ESC}23A`)).toBe(true);
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 29, top: 0 });
  });
});

describe('ScrollbackWriter finalize', () => {
  it('finalize_is_idempotent', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a', 'b']));
    const first = writer.finalize(['bye']);
    expect(first).toBe(`${ESC}2A` + '\r' + SGR0 + `${ESC}J` + R('bye') + `${ESC}?25h`);
    expect(writer.finalize(['bye'])).toBe('');
  });

  it('flushes pending static rows before the summary', () => {
    const { writer, drain, ink } = make();
    writer.transform(ink(['a']));
    drain.enqueue(['last answer'], { id: 'x', kind: 'assistant' });
    expect(writer.finalize(['sum'])).toBe(
      `${ESC}1A` + '\r' + SGR0 + `${ESC}J` + R('last answer') + R('sum') + `${ESC}?25h`,
    );
  });

  it('swallows_ink_frames_after_finalize (I-S14)', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a', 'b']));
    writer.finalize(['bye']);
    expect(writer.transform(ink(['a', 'b']))).toBe('');
    expect(writer.transform('anything')).toBe('');
    expect(writer.repaint()).toBe('');
  });

  it('starts on a fresh line, erasing nothing, when geometry is in doubt', () => {
    const { writer, ink } = make();
    writer.transform(ink(['a']));
    writer.transform('foreign');
    expect(writer.finalize(['bye'])).toBe('\r\n' + R('bye') + `${ESC}?25h`);
  });
});

/**
 * The canvas byte shapes (tui-canvas-bottom-anchor §6.1 / §8.2).
 *
 * Asserted byte for byte, because the ORDER inside a batch is the whole fix: erase,
 * SKIP the gap, write the content, write the region. A refactor that writes the gap
 * after the content restores the reported defect without changing a single number, and
 * that is exactly what a screen assertion made at the end of a batch cannot see.
 */
describe('ScrollbackWriter canvas (byte shapes)', () => {
  it('SKIPS the gap before the content, and never writes a blank row', () => {
    const { writer, drain, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    drain.enqueue(['hello'], { id: 'a', kind: 'user' });
    // rows 10 (C = 9), 1 static row, frame 2: the canvas is 6 rows tall with 3 blank
    // rows above the content, and those three are CUD rather than `R('')`.
    const out = writer.transform(ink(['L1', 'L2']));
    expect(out).toBe('\r' + SGR0 + `${ESC}3B` + R('hello') + R('L1') + R('L2'));
    expect(writer.anchorStats()).toEqual({
      state: 'pinned', source: 'probe', canvasRows: 6, heldRows: 1, gapRows: 3, top: 3,
    });
    expect(out).not.toContain('\r\n\r\n');
  });

  it('erases the whole CANVAS on a full batch, gap included', () => {
    const { writer, drain, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.transform(ink(['L1', 'L2']));
    drain.enqueue(['S1'], { id: 'a', kind: 'user' });
    // The previous canvas was SIX rows: erasing the region alone would leave its blank
    // rows on screen for ever, and would forget the content row it reprints here.
    expect(writer.transform(ink(['L1', 'L2']))).toBe(
      `${ESC}6A` + '\r' + SGR0 + `${ESC}J` + `${ESC}3B` + R('S1') + R('L1') + R('L2'),
    );
  });

  it('writes no gap byte at all on a diff batch (R9)', () => {
    const { writer, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.transform(ink(['L1', 'L2']));
    const out = writer.transform(ink(['L1', 'Lx']))!;
    expect(out).toBe(`${ESC}1A` + '\r' + SGR0 + 'Lx' + SGR0 + `${ESC}K` + `${ESC}1B` + '\r');
    expect(out).not.toContain('\r\n');
  });

  it('keeps regionRows reporting the FRAME height, not the canvas (P1-4)', () => {
    const { writer, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.transform(ink(['L1', 'L2']));
    expect(writer.regionRows()).toBe(2);
    expect(writer.anchorStats().canvasRows).toBe(6);
    expect(writer.scrollbackStats().anchorCanvasRows).toBe(6);
    expect(writer.scrollbackStats().anchorGapRows).toBe(4);
    expect(writer.scrollbackStats().anchorHeldRows).toBe(0);
    expect(writer.scrollbackStats().anchorSource).toBe('probe');
  });

  it('counts re-probes at settlement, not resize events (P1-5)', () => {
    const { writer, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.transform(ink(['L1', 'L2']));
    expect(writer.scrollbackStats().anchorReprobes).toBe(0);
    writer.onResize!();
    writer.setAnchorSpaceBelow(4, 'probe');
    writer.setAnchorSpaceBelow(2, 'probe');
    expect(writer.scrollbackStats().anchorReprobes).toBe(2);
    expect(writer.scrollbackStats().resizes).toBe(1);
  });

  it('erases the canvas on exit and reprints what it removed (I-B11)', () => {
    const { writer, drain, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    drain.enqueue(['hello'], { id: 'a', kind: 'user' });
    writer.transform(ink(['L1', 'L2']));
    drain.enqueue(['last'], { id: 'x', kind: 'assistant' });
    // The content row ('hello' lives in `held`) and the pending static are re-printed
    // before the summary, so exiting does not delete the last screenful.
    expect(writer.finalize(['bye'])).toBe(
      `${ESC}6A` + '\r' + SGR0 + `${ESC}J` + R('hello') + R('last') + R('bye') + `${ESC}?25h`,
    );
  });

  it('asks the host for a re-probe on resize and on invalidate, never itself (P0-3)', () => {
    const requestAnchorProbe = vi.fn();
    const { writer, ink, setRows } = make({ requestAnchorProbe });
    setRows(10);
    // Nothing measured yet: do not interrogate a terminal that never answered.
    writer.onResize!();
    expect(requestAnchorProbe).not.toHaveBeenCalled();
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.onResize!();
    expect(requestAnchorProbe).toHaveBeenCalledTimes(1);
    writer.transform(ink(['L1', 'L2']));
    writer.transform('foreign');
    expect(requestAnchorProbe).toHaveBeenCalledTimes(2);
    // The writer never writes a probe byte itself: it only asks.
    expect(writer.transform(ink(['L1', 'L2']))).not.toContain(`${ESC}6n`);
  });

  it('never asks the host for a probe once finalized (I-A9)', () => {
    const requestAnchorProbe = vi.fn();
    const { writer, ink, setRows } = make({ requestAnchorProbe });
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.transform(ink(['L1', 'L2']));
    expect(requestAnchorProbe).not.toHaveBeenCalled();
    writer.finalize([]);
    writer.invalidate();
    writer.onResize!();
    expect(requestAnchorProbe).not.toHaveBeenCalled();
  });

  it('ignores a measurement that arrives after finalize', () => {
    const { writer, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(6, 'probe');
    writer.transform(ink(['L1', 'L2']));
    writer.finalize([]);
    const before = writer.anchorStats();
    writer.setAnchorSpaceBelow(0, 'probe');
    expect(writer.anchorStats()).toEqual(before);
  });

  it('clamps a nonsense measurement to the screen instead of trusting it', () => {
    const { writer, ink, setRows } = make();
    setRows(10);
    writer.setAnchorSpaceBelow(9_999, 'probe');
    writer.transform(ink(['L1', 'L2']));
    // Clamped to rows - 1 = 9, so the canvas is the whole screen and the gap is 7.
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 9, gapRows: 7, top: 0 });
    writer.setAnchorSpaceBelow(-4, 'probe');
    writer.transform(ink(['L1', 'L2']));
    // A negative measurement asks for no gap at all, and must not open one either.
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 9, gapRows: 7, top: 0 });
  });

  it('unknown_anchor_matches_the_current_bytes (I-A8 / I-B7)', () => {
    const { writer, drain, ink } = make();
    // No measurement at all: byte-identical to the pre-canvas writer.
    drain.enqueue(['hello'], { id: 'a', kind: 'user' });
    expect(writer.transform(ink(['L1', 'L2']))).toBe('\r' + SGR0 + R('hello') + R('L1') + R('L2'));
    expect(writer.anchorStats()).toEqual({
      state: 'unknown', source: 'none', canvasRows: 0, heldRows: 0, gapRows: 0, top: 0,
    });
  });

  it('skipRows moves down without writing a cell, and clamps nonsense', () => {
    expect(skipRows(0)).toBe('');
    expect(skipRows(3)).toBe(`${ESC}3B`);
    expect(skipRows(-2)).toBe('');
    expect(skipRows(Number.NaN)).toBe('');
  });

  it('canvasSeedBytes pays for its own CRLF and skips down to a capped top', () => {
    expect(canvasSeedBytes({
      downToTop: 0, gap: 2, held: ['a'], lines: ['b'], sync: false, reseed: false,
    })).toBe('\r' + SGR0 + `${ESC}2B` + R('a') + R('b'));
    // 98 rows down to the canvas top, then the gap, then the content: one canvas top,
    // no rows written in between.
    expect(canvasSeedBytes({
      downToTop: 98, gap: 1, held: ['a'], lines: ['b'], sync: false, reseed: true,
    })).toBe('\r\n\r' + SGR0 + `${ESC}98B${ESC}1B` + R('a') + R('b'));
  });

  it('canvasBytes erases, then skips, then writes content, then the region', () => {
    expect(canvasBytes({
      eraseUp: 4, gap: 2, held: ['a', 'b'], lines: ['r'], sync: true,
    })).toBe(
      `${ESC}?2026h` + `${ESC}4A` + '\r' + SGR0 + `${ESC}J` + `${ESC}2B` +
        R('a') + R('b') + R('r') + `${ESC}?2026l`,
    );
  });

  it('fillBytes writes the requested number of line feeds and nothing else', () => {
    expect(fillBytes(0)).toBe('');
    expect(fillBytes(-3)).toBe('');
    expect(fillBytes(3)).toBe('\r\n\r\n\r\n');
  });
});

