import { describe, expect, it, vi } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { fillBytes } from '../ui/scrollback/writer-shapes.js';
import { createMiniVt, type MiniVt } from './helpers/mini-vt.js';

/**
 * Screen-truth tests for the CANVAS geometry, migrated from the previous feature's
 * anchor suite (tui-canvas-bottom-anchor §11.4).
 *
 * Asserted on a VT model WITH scrollback, not on byte strings: "the reply touches the
 * composer" is a statement about the screen, and a byte assertion would only restate
 * the implementation. `gap`'s invisibility is asserted the same way — as "no blank
 * row ever appears in `scrollback`" (I-B3) rather than "the bytes contain five CUDs".
 *
 * `startRows` lets the writer believe in a shorter terminal than the model, which is
 * exactly what a window drag looks like from inside the process.
 */
function session(rows = 20, cols = 40, shell: string[] = ['$ aragon'], startRows = rows) {
  const vt: MiniVt = createMiniVt(rows, cols);
  for (const line of shell) vt.write(line + '\r\n');
  const drain = createScrollbackDrain();
  let height = startRows;
  let width = cols;
  const writer = createScrollbackWriter({
    rows: () => height,
    cols: () => width,
    sync: false,
    fullEveryFrame: false,
    drain,
  });
  let inkCount = 0;
  let emitted: string[] = [];
  const frame = (lines: string[], statics: string[] = []): void => {
    if (statics.length > 0) drain.enqueue(statics, { id: String(Math.random()), kind: 'user' });
    const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
    inkCount = lines.length + 1;
    const out = writer.transform(chunk);
    emitted.push(out === null ? chunk : out);
    vt.write(out === null ? chunk : out);
  };
  const repaint = (): void => {
    const out = writer.repaint();
    emitted.push(out);
    if (out.length > 0) vt.write(out);
  };
  return {
    vt, drain, writer, frame, repaint,
    last: () => emitted[emitted.length - 1] ?? '',
    setRows: (value: number) => { height = value; },
    setCols: (value: number) => { width = value; },
    resize: () => writer.onResize?.(),
    anchor: (spaceBelow: number, source: 'probe' | 'fill' = 'probe') =>
      writer.setAnchorSpaceBelow(spaceBelow, source),
  };
}

/** The gap's whole point: blank rows may exist ABOVE the content, never in history. */
function blanksInScrollback(vt: MiniVt): number {
  return vt.scrollback.filter((line) => line === '').length;
}

describe('the canvas against a scrolling terminal model', () => {
  it('first_batch_lands_the_region_on_the_last_rows', () => {
    // R=31, H=6, S=2, and the probe reports 27 rows below the cursor (row 3).
    const { vt, frame, anchor } = session(31, 40, ['$ ls', 'a.txt', '$ aragon']);
    anchor(27);
    frame(
      ['preview', 'preview 2', '> prompt', '', 'status', 'details'],
      ['Welcome', 'v1'],
    );
    const screen = vt.screen();
    // Parked on the last row, region on the rows above it.
    expect(vt.cursor().row).toBe(30);
    expect(screen[30]).toBe('');
    expect(screen[29]).toBe('details');
    expect(screen[28]).toBe('status');
    // History is untouched and still starts the screen.
    expect(screen.slice(0, 3)).toEqual(['$ ls', 'a.txt', '$ aragon']);
    // The two static rows hug the region top; the 19-row gap is ABOVE them, because
    // this conversation has not filled the screen yet (the reported defect: they used
    // to sit right under the shell output with 19 blank rows below them).
    expect(screen[22]).toBe('Welcome');
    expect(screen[23]).toBe('v1');
    expect(screen[24]).toBe('preview');
    expect(screen.slice(3, 22)).toEqual(new Array(19).fill(''));
    expect(blanksInScrollback(vt)).toBe(0);
    expect(vt.forbidden).toEqual([]);
  });

  it('short_conversation_keeps_the_region_pinned', () => {
    // The screenshot's case: a conversation that never fills the screen. After EVERY
    // reply the composer stays on the last rows AND the answer touches it.
    const { vt, frame, anchor } = session(20, 40);
    anchor(18);
    frame(['> prompt', 'status']);
    for (let i = 0; i < 10; i += 1) {
      frame(['> prompt', 'status'], [`message ${i}`]);
      expect(vt.cursor().row).toBe(19);
      expect(vt.screen()[18]).toBe('status');
      expect(vt.screen()[19]).toBe('');
      expect(vt.screen()[16]).toBe(`message ${i}`);
    }
    expect(blanksInScrollback(vt)).toBe(0);
  });

  it('region_shrink_does_not_float_upward (RV-10 regression guard)', () => {
    const { vt, frame, anchor, writer } = session(14, 40);
    anchor(12);
    frame(['a', 'b', 'c', 'd', 'e', 'f'], ['m0']);
    expect(writer.anchorStats().gapRows).toBe(5);
    expect(vt.cursor().row).toBe(13);
    expect(vt.screen()[6]).toBe('m0');

    // The preview collapses to three rows: the rows it gives back become gap ABOVE the
    // content, so the content moves DOWN with the region and the composer never floats.
    frame(['x', 'y', 'z']);
    expect(writer.anchorStats().gapRows).toBe(8);
    expect(vt.cursor().row).toBe(13);
    expect(vt.screen()[12]).toBe('z');
    expect(vt.screen()[13]).toBe('');
    expect(vt.screen()[9]).toBe('m0');
    // The host's own output was not touched.
    expect(vt.screen()[0]).toBe('$ aragon');
    expect(blanksInScrollback(vt)).toBe(0);
  });

  it('region_growth_into_the_gap_does_not_move_history', () => {
    const { vt, frame, anchor, writer } = session(14, 40);
    anchor(12);
    frame(['a', 'b', 'c', 'd', 'e', 'f'], ['m0']);
    expect(vt.screen()[6]).toBe('m0');
    // The preview ratchet adds two rows: they come out of the gap, so the content moves
    // UP instead of the composer moving down.
    frame(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(writer.anchorStats().gapRows).toBe(3);
    expect(vt.cursor().row).toBe(13);
    expect(vt.screen()[12]).toBe('h');
    expect(vt.screen()[4]).toBe('m0');
    expect(vt.screen()[0]).toBe('$ aragon');
    expect(blanksInScrollback(vt)).toBe(0);
  });

  it('pad_rows_never_reach_scrollback (I-A4 / I-B3)', () => {
    const { vt, frame, anchor } = session(12, 40);
    anchor(10);
    frame(['> p', 's']);
    for (let i = 0; i < 24; i += 1) {
      frame(['> p', 's'], [`message ${i}`]);
      expect(blanksInScrollback(vt)).toBe(0);
    }
    // The session really did overflow, so the assertion above is not vacuous.
    expect(vt.scrollback.length).toBeGreaterThan(0);
  });

  it('fill_fallback_pins_from_the_first_row', () => {
    // The probe failed: `enterNativeScreen` wrote `rows - 1` line feeds first, so the
    // cursor starts on the last row and `gap = 0`.
    const { vt, frame, anchor, writer } = session(10, 40);
    vt.write(fillBytes(9));
    expect(vt.cursor().row).toBe(9);
    anchor(0, 'fill');
    frame(['> p', 'status'], ['Welcome']);
    expect(vt.cursor().row).toBe(9);
    expect(vt.screen()[8]).toBe('status');
    expect(vt.screen()[7]).toBe('> p');
    expect(vt.screen()[6]).toBe('Welcome');
    // THE DOCUMENTED COST (R1 / L1): the fill's own blank rows are in the scrollback.
    // It happens once per session and only on a terminal that cannot measure itself.
    expect(blanksInScrollback(vt)).toBeGreaterThan(0);
    expect(writer.anchorStats().source).toBe('fill');
  });

  it('resize_growth_re_pins_without_a_probe', () => {
    // The model is 14 rows tall so the grown screen exists; the writer starts at 10,
    // exactly like a window that the user then drags taller.
    const { vt, frame, anchor, resize, setRows, writer } = session(14, 40, ['$ aragon'], 10);
    anchor(8);
    frame(['> p', 'status']);
    expect(writer.anchorStats().gapRows).toBe(6);
    expect(vt.cursor().row).toBe(9);

    // The terminal appends rows BELOW the cursor, so the capacity grows by exactly the
    // difference and the next batch is already pinned — no measurement involved.
    setRows(14);
    resize();
    frame(['> p', 'status']);
    expect(vt.cursor().row).toBe(13);
    expect(vt.screen()[12]).toBe('status');
    expect(vt.screen()[13]).toBe('');
    expect(writer.anchorStats()).toMatchObject({ canvasRows: 12, gapRows: 10, top: 1 });
    expect(blanksInScrollback(vt)).toBe(0);
  });

  it('a_probe_result_repaints_without_new_statics (P0-2)', () => {
    const { frame, anchor, writer } = session(20, 40);
    anchor(18);
    frame(['> p', 'status']);
    // Idle feed: without `anchorDirty` the guard returns '' and the measurement would
    // be consumed by nothing.
    expect(writer.repaint()).toBe('');
    anchor(0, 'probe');
    expect(writer.repaint()).not.toBe('');
    // And the flag is one-shot: a second idle repaint writes nothing again.
    expect(writer.repaint()).toBe('');
    expect(writer.anchorStats().source).toBe('probe');
  });

  it('finalize_erases_the_canvas_and_prints_the_summary_after_history', () => {
    const { vt, frame, anchor, writer } = session(14, 40);
    anchor(12);
    frame(['> p', 'status'], ['hello']);
    vt.write(writer.finalize(['Session ended']));
    // Erasing only the region would leave the gap's blank rows behind as a dead band.
    expect(vt.history()).toEqual(['$ aragon', 'hello', 'Session ended']);
    expect(vt.cursor().col).toBe(0);
    expect(vt.screen()[vt.cursor().row]).toBe('');
    expect(vt.forbidden).toEqual([]);
  });

  it('unknown_anchor_matches_the_current_bytes (I-A8)', () => {
    // No measurement: the region hugs the last history row, exactly as before either
    // anchor existed. Asserted as the resulting screen, which is what the old byte
    // tests already pinned.
    const { vt, frame, writer } = session(14, 40);
    frame(['> p', 'status'], ['hello']);
    expect(vt.history()).toEqual(['$ aragon', 'hello', '> p', 'status']);
    expect(vt.cursor().row).toBe(4);
    expect(writer.anchorStats()).toMatchObject({ state: 'unknown', canvasRows: 0, heldRows: 0 });
  });

  it('a_unknown_resize_window_reseeds_instead_of_estimating (P1-4)', () => {
    // I-B7's one deliberate byte change: the reflow ESTIMATE is gone, so a width change
    // in the unmeasured window resets and re-seeds instead of guessing an erase height.
    const { vt, frame, writer, setCols, resize, last } = session(14, 40);
    frame(['x'.repeat(70), 'y'], ['hello']);
    const scrolled = vt.scrollback.length;
    setCols(20);
    resize();
    expect(writer.scrollbackStats().anchorResets).toBe(1);
    frame(['x'.repeat(20), 'y'], ['after']);
    expect(last().startsWith('\r\n\r')).toBe(true);
    expect(writer.anchorStats().state).toBe('unknown');
    // Nothing was erased on a guess: the earlier rows are still in the history, once.
    expect(vt.history().filter((row) => row === 'hello')).toHaveLength(1);
    expect(vt.scrollback.length).toBeGreaterThanOrEqual(scrolled);
    expect(vt.forbidden).toEqual([]);
  });

  it('reseed_batch_does_not_overfill_by_one_row (P1-1 / M11)', () => {
    const { vt, frame, anchor, writer } = session(30, 40);
    anchor(10);
    frame(['> p', 'status']);
    expect(vt.cursor().row).toBe(11);
    const scrolledBefore = vt.scrollback.length;

    // Geometry lost, then a fresh measurement, then the next Ink frame: that batch is
    // a RE-SEED, which starts with its own CRLF and therefore has one row less to
    // spend on the gap. Forgetting that subtraction overfills by exactly one row.
    writer.invalidate();
    anchor(18, 'probe');
    frame(['> p', 'status'], ['after reseed']);

    expect(vt.cursor().row).toBe(29);
    expect(vt.screen()[29]).toBe('');
    expect(vt.screen()[28]).toBe('status');
    expect(vt.screen()[27]).toBe('> p');
    // The one-row error showed up HERE: a row of the host's own history was consumed.
    expect(vt.scrollback.length).toBe(scrolledBefore);
    expect(blanksInScrollback(vt)).toBe(0);
  });

  it('a_reseed_batch_leaves_the_canvas_on_the_bottom (LB-3)', () => {
    const { frame, anchor, writer } = session(30, 40);
    anchor(10);
    frame(['> p', 'status']);
    writer.invalidate();
    anchor(18, 'probe');
    frame(['> p', 'status'], ['after reseed']);
    // `capacity + top` must equal `rows - 1`, or the next batch's `CUU` lands off by
    // the difference and either leaves a blank row or eats one.
    const stats = writer.anchorStats();
    expect(stats.top + stats.canvasRows).toBe(29);
    expect(stats.top).toBe(12);
  });

  it('an_invalidate_then_probe_re_pins_on_the_next_frame (P0-2)', () => {
    const { vt, frame, anchor, writer } = session(20, 40);
    anchor(18);
    frame(['> p', 'status']);
    writer.invalidate();
    expect(writer.anchorStats().state).toBe('unknown');
    // Honest limitation: with no `prev` there is nothing to repaint, so the new
    // measurement is only RECORDED here and lands on the next real Ink frame.
    anchor(6, 'probe');
    expect(writer.repaint()).toBe('');
    frame(['> p', 'status'], ['after']);
    expect(writer.anchorStats().state).toBe('pinned');
    expect(vt.cursor().row).toBe(19);
    expect(vt.screen()[18]).toBe('status');
  });

  it('a_width_change_resets_instead_of_guessing (P1-2 / M7)', () => {
    const { frame, anchor, writer, resize, setCols } = session(20, 40);
    anchor(18);
    frame(['a'.repeat(30), 'b', 'c', 'd', 'e', 'f']);

    // Narrowing the terminal re-flows rows the cache still describes at the old width,
    // so the only safe move is to drop the geometry and re-measure (D5).
    setCols(12);
    resize();
    expect(writer.anchorStats().state).toBe('unknown');
    expect(writer.scrollbackStats().anchorResets).toBe(1);
    frame(['a'.repeat(10), 'b', 'c', 'd', 'e', 'f']);
    expect(writer.anchorStats().state).toBe('unknown');

    // Once measured again it draws a canvas at the bottom of the narrow screen.
    anchor(19 - 8);
    frame(['a'.repeat(10), 'b', 'c', 'd', 'e', 'f']);
    expect(writer.anchorStats().state).toBe('pinned');
  });

  it('a_shrink_resets_instead_of_dropping_rows (M8)', () => {
    const { vt, frame, anchor, writer, resize, setRows } = session(14, 40);
    anchor(12);
    frame(['> p', 'status'], ['kept one']);
    frame(['> p', 'status'], ['kept two']);
    const history = vt.history();

    // A shorter terminal deleted rows; they are gone and must not be redrawn, and the
    // cached erase distance no longer describes anything on screen.
    setRows(10);
    resize();
    expect(writer.anchorStats().state).toBe('unknown');
    expect(writer.scrollbackStats().anchorResets).toBe(1);
    frame(['> p', 'status'], ['after shrink']);
    // Nothing was lost: every printed row is still in the history exactly once.
    for (const row of history) {
      expect(vt.history().filter((line) => line === row).length).toBeGreaterThanOrEqual(1);
    }
    expect(vt.history().filter((row) => row === 'after shrink')).toHaveLength(1);
    expect(vt.forbidden).toEqual([]);
  });

  it('never_emits_forbidden_sequences_when_anchored (I-A5 / AC-B7)', () => {
    const { frame, anchor, repaint, drain, resize, setRows, vt } = session(11, 30);
    anchor(9);
    frame(['> p', 's'], ['banner']);
    for (let i = 0; i < 12; i += 1) {
      frame(['preview a', 'preview b', '> p', 's'], [`entry ${i}`]);
      frame(['> p', 's']);
      drain.enqueue([`late ${i}`], { id: `l${i}`, kind: 'assistant' });
      repaint();
    }
    setRows(15);
    resize();
    frame(['> p', 's'], Array.from({ length: 14 }, (_, i) => `push ${i}`));
    expect(vt.forbidden).toEqual([]);
  });

  it('asks the host for a re-probe and never writes one itself (P0-3)', () => {
    const requestAnchorProbe = vi.fn();
    const { writer, frame } = session(20, 40);
    const probed = createScrollbackWriter({
      rows: () => 20, cols: () => 40, sync: false, fullEveryFrame: false,
      drain: createScrollbackDrain(), requestAnchorProbe,
    });
    // Nothing measured yet: do not interrogate a terminal that never answered.
    probed.onResize?.();
    expect(requestAnchorProbe).not.toHaveBeenCalled();
    probed.setAnchorSpaceBelow(18, 'probe');
    probed.onResize?.();
    expect(requestAnchorProbe.mock.calls.length).toBeGreaterThan(0);
    // The writer never emits a probe byte itself: it only asks.
    const out = probed.transform(`${eraseLinesPrefix(0)}> p\nstatus\n`);
    expect(out).not.toContain('\x1b[6n');
    expect(writer.repaint()).toBe('');
    frame(['> p', 'status']);
  });
});
