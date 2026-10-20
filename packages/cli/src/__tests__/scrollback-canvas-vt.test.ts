import { describe, expect, it } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { createMiniVt, type MiniVt } from './helpers/mini-vt.js';

/**
 * Screen-truth tests for the CANVAS geometry (tui-canvas-bottom-anchor §11.1).
 *
 * The defect these pin down is a POSITION, not a number: `screen[R - 2 - H]` must be
 * the newest printed row, so the reply touches the composer instead of floating in
 * the middle of a screenful of blank lines. Asserted on a VT model rather than on
 * bytes, because a byte assertion would only restate the implementation.
 *
 * `modelRows` may exceed `rows`: that is how a window drag is simulated without
 * asking the model to re-wrap anything.
 */
function session(rows = 20, cols = 40, shell: string[] = ['$ aragon'], modelRows = rows) {
  const vt: MiniVt = createMiniVt(modelRows, cols);
  for (const line of shell) vt.write(line + '\r\n');
  const drain = createScrollbackDrain();
  let height: number | undefined = rows;
  let width: number | undefined = cols;
  let inkCount = 0;
  const writer = createScrollbackWriter({
    rows: () => height,
    cols: () => width,
    sync: false,
    fullEveryFrame: false,
    drain,
  });
  const frame = (lines: string[], statics: string[] = []): void => {
    if (statics.length > 0) drain.enqueue(statics, { id: String(Math.random()), kind: 'user' });
    const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
    inkCount = lines.length + 1;
    const out = writer.transform(chunk);
    vt.write(out === null ? chunk : out);
  };
  const repaint = (): void => {
    const out = writer.repaint();
    if (out.length > 0) vt.write(out);
  };
  return {
    vt, drain, writer, frame, repaint,
    setRows: (value: number | undefined) => { height = value; },
    setCols: (value: number | undefined) => { width = value; },
    resize: () => writer.onResize?.(),
    anchor: (spaceBelow: number, source: 'probe' | 'fill' = 'probe') =>
      writer.setAnchorSpaceBelow(spaceBelow, source),
  };
}

/** The composer occupies `R - 2`, the parked row is `R - 1`, the region sits above. */
function expectHugsComposer(vt: MiniVt, rows: number, frameRows: number, newest: string): void {
  const screen = vt.screen();
  expect(screen[rows - 2 - frameRows]).toBe(newest);
  expect(vt.cursor().row).toBe(rows - 1);
}

const blanks = (vt: MiniVt): number => vt.scrollback.filter((line) => line === '').length;

const messages = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `m${i}`);

describe('the canvas keeps the reply glued to the composer', () => {
  it('newest_content_hugs_the_region_after_a_reply (the reported defect)', () => {
    // The screenshot's sequence: seed, one printed row, a region that collapses from
    // eight rows back to two, then a four-row answer. On HEAD the answer stays where
    // the collapsed region left it, with six blank rows between it and the composer.
    const { vt, frame, anchor } = session(20, 40);
    anchor(18);
    frame(['> p', 'status']);
    frame(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', '> p', 'status'], ['m0']);
    frame(['> p', 'status']);
    expectHugsComposer(vt, 20, 2, 'm0');
    frame(['> p', 'status'], ['a1', 'a2', 'a3', 'a4']);
    expectHugsComposer(vt, 20, 2, 'a4');
    expect(vt.screen()[17]).toBe('> p');
    expect(vt.screen()[18]).toBe('status');
    expect(vt.screen()[19]).toBe('');
    expect(blanks(vt)).toBe(0);
  });

  it('a_region_collapse_alone_never_opens_a_band_above_the_composer', () => {
    const { vt, frame, anchor } = session(20, 40);
    anchor(18);
    frame(['> p', 'status'], ['m0']);
    expectHugsComposer(vt, 20, 2, 'm0');
    const scrolled = vt.scrollback.length;
    frame(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', '> p', 'status']);
    expectHugsComposer(vt, 20, 8, 'm0');
    frame(['> p', 'status']);
    // Back where it started: the six rows the region gave back became gap ABOVE the
    // content, so the content moved DOWN with the gate and nothing scrolled.
    expectHugsComposer(vt, 20, 2, 'm0');
    expect(vt.scrollback.length).toBe(scrolled);
    expect(vt.screen()[16]).toBe('m0');
    expect(vt.screen()[15]).toBe('');
  });

  it('a_draft_that_grows_and_shrinks_leaves_no_trace', () => {
    const { vt, frame, anchor } = session(20, 40);
    anchor(18);
    frame(['> p', 'status']);
    const before = vt.screen();
    const scrolled = vt.scrollback.length;
    frame(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', '> p', 'status']);
    frame(['> p', 'status']);
    expect(vt.scrollback.length).toBe(scrolled);
    expect(vt.screen()).toEqual(before);
  });

  it('after_a_short_reply_the_last_row_sits_above_the_composer (simplest repro)', () => {
    // No collapse batch, no React commit order: a seed and one answer. `gap` goes from
    // 6 to 2 as the answer prints, and the answer's last row is on `R - 2 - H`.
    const { vt, frame, anchor, writer } = session(20, 40);
    anchor(18);
    frame(['> p', 'status'], messages(10));
    expect(writer.anchorStats()).toMatchObject({ state: 'pinned', top: 1, canvasRows: 18 });
    expect(writer.anchorStats().gapRows).toBe(6);
    expect(vt.screen()[1]).toBe('');
    frame(['> p', 'status'], ['a1', 'a2', 'a3', 'a4']);
    expect(writer.anchorStats().gapRows).toBe(2);
    expect(vt.screen().slice(1, 3)).toEqual(['', '']);
    expectHugsComposer(vt, 20, 2, 'a4');
    expect(vt.screen()[19]).toBe('');
  });
});

describe('the scrollback only ever receives printed rows', () => {
  it('blank_rows_never_reach_the_scrollback (I-B3)', () => {
    const { vt, frame, anchor } = session(12, 40);
    anchor(10);
    frame(['> p', 's']);
    for (let i = 0; i < 30; i += 1) {
      frame(['> p', 's'], [`message ${i}`]);
      expect(blanks(vt)).toBe(0);
    }
    expect(vt.scrollback.length).toBeGreaterThan(0);
  });

  it('history_is_exactly_what_was_printed_once (I-B5 / AC-B4)', () => {
    const { vt, frame, anchor } = session(12, 40);
    anchor(10);
    frame(['> p', 's']);
    const printed: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      printed.push(`message ${i}`, '');
      frame(['> p', 's'], [`message ${i}`, '']);
    }
    // Blank rows inside an entry are the author's layout and must survive (I-B9).
    expect(vt.history()).toEqual(['$ aragon', ...printed, '> p', 's']);
  });

  it('an_overflow_batch_keeps_the_order', () => {
    const { vt, frame, anchor } = session(20, 40);
    anchor(18);
    frame(['> p', 'status'], ['first']);
    const big = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    frame(['> p', 'status'], big);
    // 40 statics + 1 held + 2 frame = 43 rows against a 19-row screen: the first 24
    // leave through the top, in order, and the host's own row goes first.
    expect(vt.scrollback.slice(0, 2)).toEqual(['$ aragon', 'first']);
    expect(vt.scrollback.slice(2)).toEqual(big.slice(0, 23));
    expect(vt.screen()[0]).toBe('row 23');
    expectHugsComposer(vt, 20, 2, 'row 39');

    // ONE MORE BATCH, which is where an off-by-one `dropped` would show up: the row
    // that left the canvas must not be drawn again, and the row that leaves now must
    // be exactly the oldest one still on screen.
    frame(['> p', 'status'], ['next']);
    expect(vt.screen()[0]).toBe('row 24');
    expectHugsComposer(vt, 20, 2, 'next');
    expect(vt.history()).toEqual([
      '$ aragon', 'first', ...big, 'next', '> p', 'status',
    ]);
  });
});

describe('a resize is reconciled before the batch writes', () => {
  it('a_reprobe_with_the_cursor_parked_keeps_the_canvas (P0-1)', () => {
    const { vt, frame, anchor, writer } = session(20, 40);
    anchor(18);
    frame(['> p', 'status'], messages(6));
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 18, gapRows: 10, top: 1 });

    // The post-resize re-probe reports "nothing below the cursor", because the cursor
    // is parked on the last row. Reading that as the whole capacity collapses the
    // canvas and the next batch scrolls the visible content away a second time.
    anchor(0, 'probe');
    expect(writer.anchorStats()).toMatchObject({ state: 'pinned', canvasRows: 18, gapRows: 10 });
    const scrolled = vt.scrollback.length;
    frame(['> p', 'status 2']);
    expect(vt.scrollback.length).toBe(scrolled);
    expectHugsComposer(vt, 20, 2, 'm5');
  });

  it('resize_growth_then_probe_agrees_with_the_delta (P0-1)', () => {
    const build = () => {
      const t = session(20, 40, ['$ aragon'], 28);
      t.anchor(18);
      t.frame(['> p', 'status'], messages(6));
      t.setRows(28);
      t.resize();
      return t;
    };
    // Two independent routes to the same grid: the resize delta (`18 + 8`) and the
    // re-probe (`8 + 18`, because the cursor is still parked on the old row).
    const byDelta = build();
    byDelta.frame(['> p', 'status']);
    const byProbe = build();
    byProbe.anchor(8, 'probe');
    byProbe.frame(['> p', 'status']);
    for (const t of [byDelta, byProbe]) {
      expect(t.writer.anchorStats()).toMatchObject({ canvasRows: 26, top: 1 });
      expectHugsComposer(t.vt, 28, 2, 'm5');
    }
    expect(byProbe.vt.scrollback.length).toBe(byDelta.vt.scrollback.length);
  });

  it('a_reprobe_never_clips_a_live_canvas_on_a_tall_terminal (M17)', () => {
    const { vt, frame, anchor, writer } = session(300, 40);
    // The measured space is 298 rows; the start-of-canvas cap makes the canvas 200.
    anchor(298);
    expect(writer.anchorStats().top).toBe(299 - 200);
    frame(['> p', 'status'], Array.from({ length: 250 }, (_, i) => `wide ${i}`));
    expectHugsComposer(vt, 300, 2, 'wide 249');
    // Overflowing and scrolling grew the canvas past the cap; clipping it back would
    // make the next erase reach ABOVE the new top, wiping the rows above it.
    const grown = writer.anchorStats().canvasRows;
    expect(grown).toBeGreaterThan(200);
    anchor(0, 'probe');
    // capacity stays `grown`, so the canvas top stays 299 - 252 = 47. Clipping it to
    // 200 would move the top to 99 while the next `CUU` still reaches row 47.
    expect(writer.anchorStats().top).toBe(299 - grown);
    frame(['> p', 'status'], ['next']);
    expectHugsComposer(vt, 300, 2, 'next');
  });

  it('a_frame_after_a_row_growth_reconciles_without_an_event (P0-2)', () => {
    const { vt, frame, anchor, writer, setRows } = session(20, 40, ['$ aragon'], 28);
    anchor(18);
    frame(['> p', 'status'], messages(6));

    // `stdout.rows` changed but the `resize` event has not been dispatched yet.
    setRows(28);
    frame(['> p', 'status'], ['after']);
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 26, top: 1 });
    expectHugsComposer(vt, 28, 2, 'after');
  });

  it('a_width_change_between_batches_resets_before_it_writes (P0-2)', () => {
    const { vt, frame, anchor, writer, setCols } = session(20, 40);
    anchor(18);
    frame(['a'.repeat(30), 'b', 'c', 'd', 'e', 'f'], ['wide content that reflows']);

    // The terminal narrowed and the `resize` event has not arrived: erasing the
    // cached rows by their old height would cut the re-flowed lines in half.
    setCols(20);
    frame(['a'.repeat(10), 'b', 'c', 'd', 'e', 'f'], ['second']);
    expect(writer.anchorStats().state).toBe('unknown');
    expect(writer.scrollbackStats().anchorResets).toBe(1);
    // Whatever is printed from here is clipped to the NEW width (I-S13).
    frame(['a'.repeat(10), 'b', 'c', 'd', 'e', 'f'], ['w'.repeat(40)]);
    expect(vt.screen()).toContain('w'.repeat(19));
    expect(vt.forbidden).toEqual([]);

    // Measured again: it draws a canvas, back at the bottom.
    anchor(19 - vt.cursor().row);
    frame(['a'.repeat(10), 'b', 'c', 'd', 'e', 'f'], ['back']);
    expect(writer.anchorStats().state).toBe('pinned');
    expectHugsComposer(vt, 20, 6, 'back');
  });
});

describe('the legacy to canvas transition', () => {
  it('legacy_to_pinned_starts_the_canvas_at_the_region_top (I-B16)', () => {
    // No measurement at all: two frames park the region mid-screen. The first
    // measurement then has to place the canvas so its erase distance is exactly the
    // old region — anything larger erases host output, anything smaller leaves rows.
    const { vt, frame, anchor, writer } = session(20, 40);
    frame(['> p', 'status'], ['first']);
    frame(['> p', 'status'], ['second']);
    expect(writer.anchorStats().state).toBe('unknown');
    const cursorRow = vt.cursor().row;
    expect(vt.screen()[0]).toBe('$ aragon');
    expect(vt.screen()[1]).toBe('first');
    expect(vt.screen()[2]).toBe('second');
    expect(vt.screen()[cursorRow - 2]).toBe('> p');

    anchor(19 - cursorRow);
    expect(writer.anchorStats().top).toBe(cursorRow - 2);
    frame(['> p', 'status'], ['third']);
    expect(vt.screen()[0]).toBe('$ aragon');
    expect(vt.screen()[1]).toBe('first');
    expect(vt.screen()[2]).toBe('second');
    expectHugsComposer(vt, 20, 2, 'third');
  });

  it('never_emits_forbidden_sequences_on_any_path (I-B10)', () => {
    const { vt, frame, anchor, writer, drain, repaint, setRows, setCols, resize } =
      session(12, 30, ['$ aragon'], 16);
    anchor(10);
    frame(['> p', 's'], ['banner']);
    for (let i = 0; i < 12; i += 1) {
      frame(['p1', 'p2', '> p', 's'], [`entry ${i}`]);
      frame(['> p', 's']);
      drain.enqueue([`late ${i}`], { id: `l${i}`, kind: 'assistant' });
      repaint();
    }
    // An overflow batch, a reset, a re-seed and a growth all in one session.
    frame(['> p', 's'], Array.from({ length: 25 }, (_, i) => `push ${i}`));
    setRows(16);
    resize();
    frame(['> p', 's'], ['after growth']);
    setCols(20);
    resize();
    frame(['> p', 's'], ['after narrowing']);
    frame(['a'.repeat(40), 's'], ['wide']);
    writer.finalize(['bye']);
    expect(vt.forbidden).toEqual([]);
  });
});

/**
 * The FULL-HEIGHT region (tui-full-height-live-region AC-F5 / I-F1 / I-F2 / I-F3).
 *
 * `H = C = rows - 1` is the one height at which the canvas holds no blank row at all:
 * `need === capacity`, so `resolveCanvasLayout` derives `gap = 0`, `kept = []` and
 * `top = 0` for every batch (the spec proves it in section 5.5). These cases are the
 * screen-truth half of that proof, and because the feature does NOT touch this writer
 * they double as the guard for "the writer needs no change".
 */
const fullFrame = (rows: number): string[] =>
  Array.from({ length: rows }, (_, index) => `row ${index}`);

describe('the live region is the whole screen', () => {
  it('full_screen_region_has_no_gap (AC-F5)', () => {
    const { vt, frame, anchor, writer } = session(30, 120);
    anchor(0);
    frame(fullFrame(29), ['AragonAgent']);
    expect(writer.anchorStats()).toMatchObject({
      state: 'pinned', gapRows: 0, top: 0, canvasRows: 29, heldRows: 0,
    });
    // The region ends on the row above the parked cursor, with no blank band above it.
    expect(vt.screen()[28]).toBe('row 28');
    expect(vt.cursor().row).toBe(29);
    // The one printed row left through the top, once, and no blank row went with it.
    expect(vt.scrollback).toEqual(['$ aragon', 'AragonAgent']);
    expect(blanks(vt)).toBe(0);
  });

  it('printed_rows_leave_through_the_top (I-F3)', () => {
    const { vt, frame, anchor, writer } = session(30, 120);
    anchor(0);
    frame(fullFrame(29));
    const printed: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      printed.push(`answer ${i}`);
      frame(fullFrame(29), [`answer ${i}`]);
      // No content row joins the canvas: `kept` stays empty on every batch.
      expect(writer.anchorStats()).toMatchObject({ heldRows: 0, gapRows: 0, top: 0 });
    }
    expect(vt.scrollback).toEqual(['$ aragon', ...printed]);
    // The frame is still the visible screen; no row of it was pushed out.
    expect(vt.screen()[0]).toBe('row 0');
    expect(vt.screen()[28]).toBe('row 28');
    expect(blanks(vt)).toBe(0);
  });

  it('scrollback_holds_no_blank_rows (I-F1 / I-B3)', () => {
    const { vt, frame, anchor } = session(24, 80);
    anchor(0);
    frame(fullFrame(23));
    for (let i = 0; i < 20; i += 1) {
      // No blank row here on purpose: a blank row INSIDE an entry is the author's
      // layout and must survive (I-B9), so it would not be the writer's blank.
      frame(fullFrame(23), [`message ${i}`]);
      expect(blanks(vt)).toBe(0);
    }
    expect(vt.scrollback.length).toBeGreaterThan(0);
  });

  it('no_duplicate_rows_after_scroll (I-F8)', () => {
    const { vt, frame, anchor } = session(30, 120);
    anchor(0);
    frame(fullFrame(29));
    for (let i = 0; i < 6; i += 1) {
      frame(fullFrame(29), [`entry ${i}`]);
    }
    const history = vt.history();
    // Every printed row appears exactly once, in order, and no `row N` of the region
    // leaked into the scrollback (that would be a row drawn twice).
    expect(history.filter((line) => /^row \d+$/.test(line))).toHaveLength(29);
    expect(history).toEqual([
      '$ aragon',
      ...Array.from({ length: 6 }, (_, i) => `entry ${i}`),
      ...fullFrame(29),
    ]);
  });
});
