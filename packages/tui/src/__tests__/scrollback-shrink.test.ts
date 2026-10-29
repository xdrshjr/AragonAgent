/**
 * A shorter terminal must never paint the previous frame twice
 * (the duplicate-status-row defect; fix B-prime / I-B17).
 *
 * THE DEFECT THIS LOCKS DOWN
 * --------------------------
 * `rows` has two readers with different latencies: React (`useTerminalSize`, throttled)
 * and the writer (`process.stdout.rows`, live). A shrink used to answer every geometry
 * mismatch with `reset()`, which drops `canvasRows` -- the ONLY number that can erase
 * what is already on screen. The next batch therefore became a SEED, and a seed assumes
 * nothing is below the cursor (`writer-shapes.ts:60-64`). After a shrink that is false:
 * the batch overflowed the screen, the terminal scrolled to absorb it, and the previous
 * frame -- status row last -- landed in the scrollback. One terminal, two status rows.
 *
 * THE FIX THESE TESTS PIN
 * -----------------------
 *  - a shrink RE-PINS the canvas onto the rows the screen kept (its suffix) instead of
 *    dropping it, so the next batch is a diff/repaint against a real screen;
 *  - a frame taller than the screen gives way at its TOP instead of being swallowed,
 *    so the composer and the status line stay addressable.
 *
 * Asserted against the REAL `createScrollbackWriter` driven through the repo's own VT
 * model (`helpers/mini-vt.ts`); nothing about the writer is mocked.
 *
 * Acceptance criteria W1-W7 and edge cases E1-E10 are named in the analysis report.
 */
import { describe, expect, it } from 'vitest';
import { eraseLinesPrefix } from '../ui/frame-differ.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { createMiniVt, type MiniVt } from '../testing/mini-vt.js';

const ESC = '\x1b[';
const COLS = 100;

/** Status wording copied from the report's screenshot (OCR, 2028 x 1124 px). */
const STATUS_OLD =
  '\u00b7 Running tool bash | BUILD | Context 6% | Think xhigh | 21 tok/s | 49.3s | 0ms';
const STATUS_NEW =
  '\u00b7 Running tool bash | BUILD | Context 6% | Think xhigh | 19 tok/s | 52.9s | 0ms';

/**
 * A frame of `height` rows shaped like the native region: `[header][band ...][composer]
 * [status]`. The STATUS row is last, which is the row the screenshot shows twice.
 */
function region(height: number, status: string): string[] {
  const lines: string[] = ['AragonAgent  openai:deepseek-flash'];
  while (lines.length < height - 2) lines.push('band row');
  lines.push('+ Add a follow-up');
  lines.push(status);
  return lines;
}

function session(rows: number, options: { requestAnchorProbe?: () => void } = {}) {
  const vt: MiniVt = createMiniVt(rows, COLS);
  vt.write('$ aragon\r\n');
  const drain = createScrollbackDrain();
  let height: number | undefined = rows;
  let width = COLS;
  let inkCount = 0;
  const writer = createScrollbackWriter({
    rows: () => height, cols: () => width, sync: false, fullEveryFrame: false, drain,
    requestAnchorProbe: options.requestAnchorProbe,
  });
  /** Exactly Ink's emit shape: erase the previous frame, write this one. */
  const frame = (lines: string[], statics: string[] = []): string => {
    if (statics.length > 0) drain.enqueue(statics, { id: String(Math.random()), kind: 'user' });
    const chunk = eraseLinesPrefix(inkCount) + lines.join('\n') + '\n';
    inkCount = lines.length + 1;
    const out = writer.transform(chunk);
    const bytes = out === null ? chunk : out;
    vt.write(bytes);
    return bytes;
  };
  /** What the host does with `repaint()`: write the bytes, and hand them back. */
  const repaint = (): string => {
    const out = writer.repaint();
    vt.write(out);
    return out;
  };
  return {
    vt, writer, frame, repaint,
    setRows: (value: number | undefined) => { height = value; },
    setCols: (value: number) => { width = value; },
    resize: () => writer.onResize?.(),
    anchor: (spaceBelow: number) => writer.setAnchorSpaceBelow(spaceBelow, 'probe'),
    resets: () => writer.scrollbackStats().anchorResets,
  };
}

/** Every screen or scrollback row that looks like the status line (W1). */
function statusRows(vt: MiniVt): string[] {
  return [...vt.scrollback, ...vt.screen()].filter((line) => line.includes('tok/s'));
}

describe('a shrink keeps the canvas and re-pins it (W1 / W6 / E1)', () => {
  it('a_terminal_shrink_during_the_50ms_throttle_window_leaves_one_status_row', () => {
    const ROWS = 20;
    const { vt, frame, resize, setRows, anchor } = session(ROWS);

    anchor(ROWS - 2);
    // Steady state: the writer has a canvas and knows its height.
    frame(region(ROWS - 1, STATUS_OLD));
    frame(region(ROWS - 1, STATUS_OLD));
    expect(statusRows(vt)).toHaveLength(1);

    // The user drags the window one row shorter. The writer reads `process.stdout.rows`
    // live and learns immediately, while React is still inside `RESIZE_THROTTLE_MS` and
    // therefore still emits a frame of the OLD height - one row taller than the screen.
    setRows(ROWS - 1);
    resize();
    frame(region(ROWS - 1, STATUS_NEW));

    // React catches up one tick later.
    frame(region(ROWS - 2, STATUS_NEW));

    // The region owns a single `height={1}` status slot (ScrollbackShell.tsx:190) and
    // only one component in the app can produce these fields.
    expect(statusRows(vt)).toHaveLength(1);
    expect(statusRows(vt)[0]).toBe(STATUS_NEW);
  });

  it('the_same_sequence_with_the_writer_informed_late_leaves_no_trace (control)', () => {
    const ROWS = 20;
    const { vt, frame, resize, setRows, anchor } = session(ROWS);

    anchor(ROWS - 2);
    frame(region(ROWS - 1, STATUS_OLD));
    frame(region(ROWS - 1, STATUS_OLD));

    // React re-renders FIRST (the honest order), the writer learns after.
    frame(region(ROWS - 2, STATUS_NEW));
    setRows(ROWS - 1);
    resize();
    frame(region(ROWS - 2, STATUS_NEW));

    expect(statusRows(vt)).toHaveLength(1);
  });

  it('one_row_shrink_keeps_pinned_geometry_and_leaves_the_scrollback (E1 / W2 / W3)', () => {
    const ROWS = 20;
    const { vt, writer, frame, resize, setRows, anchor, resets } = session(ROWS);
    anchor(ROWS - 2);
    frame(region(ROWS - 1, STATUS_OLD));
    frame(region(ROWS - 1, STATUS_OLD));
    const before = writer.anchorStats();
    const history = vt.scrollback.length;

    setRows(ROWS - 1);
    resize();
    expect(writer.anchorStats().state).toBe('pinned');
    expect(resets()).toBe(0);
    expect(writer.anchorStats().canvasRows).toBe(Math.min(before.canvasRows, ROWS - 2));
    // LB-3: the canvas still ends on the parked row, which is what the next CUU assumes.
    const shrunk = writer.anchorStats();
    expect(shrunk.top + shrunk.canvasRows).toBe(ROWS - 2);

    frame(region(ROWS - 2, STATUS_NEW));
    // The gap is re-derived, never carried over as a blank band above the region (W2).
    expect(writer.anchorStats().gapRows).toBe(0);
    expect(writer.anchorStats().state).toBe('pinned');
    // Nothing of this session was pushed into the scrollback (W3).
    expect(vt.scrollback.length).toBe(history);
    expect(statusRows(vt)).toHaveLength(1);
  });
});

describe('the geometry survives every shrink shape (E2 / E7 / E8 / E10)', () => {
  it('consecutive_shrinks_never_drift_off_the_parked_row (E7)', () => {
    const ROWS = 30;
    const { writer, frame, resize, setRows, anchor, resets } = session(ROWS);
    anchor(ROWS - 2);
    frame(region(ROWS - 1, STATUS_OLD));

    for (let rows = ROWS - 1; rows >= 12; rows -= 1) {
      setRows(rows);
      resize();
      const stats = writer.anchorStats();
      expect(stats.state).toBe('pinned');
      // LB-3 on every step: `top + capacity === rows - 1`, by construction not by luck.
      expect(stats.top + stats.canvasRows).toBe(rows - 1);
      // The erase distance never claims more rows than the screen has.
      expect(stats.canvasRows).toBeLessThanOrEqual(rows - 1);
      frame(region(Math.min(rows - 1, stats.canvasRows), STATUS_OLD));
    }
    expect(resets()).toBe(0);
  });

  it('a_drastic_shrink_never_resets_and_never_duplicates (E2)', () => {
    const { vt, writer, frame, resize, setRows, anchor, resets } = session(33);
    anchor(31);
    frame(region(32, STATUS_OLD));

    setRows(12);
    resize();
    const stats = writer.anchorStats();
    expect(stats.state).toBe('pinned');
    expect(stats.canvasRows).toBe(11);
    expect(stats.top).toBe(0);
    expect(resets()).toBe(0);

    frame(region(11, STATUS_NEW));
    expect(statusRows(vt)).toHaveLength(1);
  });

  it('a_shrink_then_a_growth_widens_the_canvas_instead_of_reseeding (E8)', () => {
    const { writer, frame, resize, setRows, anchor, resets } = session(20);
    anchor(18);
    frame(region(19, STATUS_OLD));

    setRows(16);
    resize();
    const shrunk = writer.anchorStats();
    setRows(20);
    resize();
    // A growth adds the rows BELOW the cursor to the canvas that survived (D6), and the
    // canvas already on screen keeps its height until the next batch redraws it.
    expect(writer.anchorStats().top).toBe(shrunk.top);
    expect(writer.anchorStats().canvasRows).toBe(shrunk.canvasRows);
    // The next batch erases exactly what it drew, then takes the widened capacity.
    const out = frame(region(19, STATUS_NEW));
    expect(out.startsWith(`${ESC}${shrunk.canvasRows}A`)).toBe(true);
    expect(writer.anchorStats().canvasRows).toBe(19);
    expect(resets()).toBe(0);
  });

  it('content_rows_on_the_canvas_survive_a_shrink_as_a_suffix (E10)', () => {
    const { writer, frame, resize, setRows, anchor, resets } = session(20);
    anchor(18);
    frame(['> p', 'status'], ['content one', 'content two', 'content three']);
    const before = writer.anchorStats();
    expect(before.heldRows).toBeGreaterThanOrEqual(3);

    setRows(12);
    resize();
    const shrunk = writer.anchorStats();
    expect(shrunk.state).toBe('pinned');
    // No content row is lost that the screen could still show: the cache is trimmed to
    // the canvas that is left, and `held` is its tail.
    expect(shrunk.heldRows).toBeLessThanOrEqual(Math.min(before.heldRows, 11));
    expect(shrunk.heldRows).toBeGreaterThan(0);
    expect(resets()).toBe(0);
    frame(['> p', 'status']);
    expect(writer.anchorStats().state).toBe('pinned');
  });
});

describe('a frame taller than the screen gives way at its top (W4 / W7)', () => {
  it('clips_the_top_and_still_draws_instead_of_swallowing_the_frame', () => {
    const ROWS = 12;
    const { writer, frame, anchor, resets } = session(ROWS);
    anchor(ROWS - 2);
    frame(['header', '+ Add a follow-up', 'status']);
    const canvas = writer.anchorStats().canvasRows;

    // Two rows too many for the screen (I-S1 says it cannot happen; a stale React height
    // makes it happen). It must be DRAWN, not swallowed: a swallowed frame leaves the
    // previous frame on screen, which is the symptom the user reported.
    const tall = [
      'OLDEST-ROW', 'ALSO-OLD', 'band a', 'band b', 'band c', 'band d', 'band e',
      'band f', 'band g', 'band h', 'band i', '+ Add a follow-up', STATUS_NEW,
    ];
    expect(tall.length + 1).toBeGreaterThan(ROWS);
    const out = frame(tall);
    expect(out).not.toBe('');
    // The whole canvas is rewritten from its top...
    expect(out.startsWith(`${ESC}${canvas}A`)).toBe(true);
    // ... the oldest rows gave way, the interactive rows did not.
    expect(out).not.toContain('OLDEST-ROW');
    expect(out).not.toContain('ALSO-OLD');
    expect(out).toContain('+ Add a follow-up');
    expect(out).toContain(STATUS_NEW);
    expect(writer.scrollbackStats().tallFramesTrimmed).toBe(1);
    expect(resets()).toBe(0);
    expect(writer.anchorStats().state).toBe('pinned');
  });

  it('trims exactly to rows - 1 rows, never a row short (W4)', () => {
    const ROWS = 8;
    const { writer, frame, anchor } = session(ROWS);
    anchor(ROWS - 2);
    frame(['header', 'status']);
    // 12 rows for an 8-row terminal: 11 rows of canvas are addressable.
    const frameRows = Array.from({ length: 12 }, (_, i) => `row ${i}`);
    const out = frame(frameRows);
    const painted = out.split('\r\n').filter((line) => line.includes('row '));
    expect(painted.length).toBe(ROWS - 1);
    // The TOP of the frame is what left, so the last row is still drawn.
    expect(out).toContain(`row ${frameRows.length - 1}`);
    expect(out).not.toContain('row 0');
  });
});

describe('the degenerate and orthogonal paths keep their old answer (E3 / E4)', () => {
  it('a_terminal_with_no_row_above_the_parked_one_still_resets (E3)', () => {
    const ROWS = 20;
    const { writer, frame, resize, setRows, anchor, resets } = session(ROWS);
    anchor(ROWS - 2);
    frame(region(ROWS - 1, STATUS_OLD));

    setRows(1);
    resize();
    // `screenCapacity(1) === 0`: no canvas is addressable, so re-measuring is honest.
    expect(writer.anchorStats().state).toBe('unknown');
    expect(resets()).toBe(1);
  });

  it('a_width_change_during_a_shrink_still_resets (E4)', () => {
    const { writer, frame, resize, setRows, setCols, anchor, resets } = session(20);
    anchor(18);
    frame(['> p', 'status'], ['hello']);
    // A drag of the corner changes BOTH: the width change re-flows the rows themselves,
    // so the cache describes nothing and the old answer -- drop and re-measure -- stands.
    setRows(16);
    setCols(60);
    resize();
    expect(writer.anchorStats().state).toBe('unknown');
    expect(resets()).toBe(1);
    // The shrink alone, on the same terminal, keeps the canvas.
    frame(['> p', 'status']);
    anchor(14);
    frame(['> p', 'status']);
    setRows(14);
    resize();
    expect(writer.anchorStats().state).toBe('pinned');
    expect(resets()).toBe(1);
  });
});

describe('the re-pin keeps its neighbours honest (I-B7 / I-B14 / W4)', () => {
  it('an_unmeasured_canvas_still_resets_instead_of_inventing_a_geometry (I-B7)', () => {
    const ROWS = 20;
    const { writer, frame, resize, setRows, resets } = session(ROWS);
    // No `anchor()` call: this writer never learned where the cursor is, so it is on the
    // append path and its bytes are the pre-canvas ones. A re-pin needs a measured row to
    // pin onto, and a canvas guessed at `rows - 1` could erase the user's own rows.
    frame(['header', '+ Add a follow-up', STATUS_OLD]);
    expect(writer.anchorStats().state).toBe('unknown');

    setRows(ROWS - 1);
    resize();
    expect(writer.anchorStats().state).toBe('unknown');
    expect(resets()).toBe(1);

    // The next batch is still a SEED from a null cache: a leading CRLF and no `CUU`, which
    // is the pre-canvas byte shape kept exactly (I-B7). The append path never erases on a
    // guess (I-S8), so it owns no canvas to report either.
    const out = frame(['header', '+ Add a follow-up', STATUS_OLD]);
    expect(out.startsWith('\r')).toBe(true);
    expect(out).not.toMatch(/\x1b\[\d+A/);
    expect(writer.anchorStats().canvasRows).toBe(0);
  });

  it('asks_the_host_for_one_re_probe_after_a_shrink (I-B14 / E6)', () => {
    const ROWS = 24;
    const probes: string[] = [];
    const { writer, frame, resize, setRows, anchor } = session(ROWS, {
      requestAnchorProbe: () => probes.push('probe'),
    });
    anchor(ROWS - 2);
    frame(region(ROWS - 1, STATUS_OLD));
    const before = probes.length;

    setRows(ROWS - 1);
    resize();
    // Keeping the canvas bets that the parked row is still `rows - 1`; the measurement is
    // what confirms the terminal agrees. A request is not a measurement, so the re-probe
    // counter (which `/perf` reports per settle) stays where it was.
    expect(probes.length).toBe(before + 1);
    expect(writer.scrollbackStats().anchorReprobes).toBe(0);
  });

  it('a_repaint_of_a_frame_that_predates_the_shrink_gives_way_at_its_top (W4 / W7)', () => {
    const ROWS = 20;
    const { writer, frame, resize, setRows, anchor, repaint } = session(ROWS);
    anchor(ROWS - 2);
    frame(region(ROWS - 1, STATUS_OLD));

    // The screen loses eight rows while Ink's frame is still the old 19-row one. The host
    // answers the re-pin with `repaint()`, and replaying that frame whole would overflow
    // the new screen and push this session's own rows into the scrollback.
    setRows(12);
    resize();
    const canvas = writer.anchorStats().canvasRows;
    const out = repaint();
    expect(out).not.toBe('');
    expect(writer.scrollbackStats().tallFramesTrimmed).toBe(1);
    // The erase distance is the canvas that really survived; the drawn region is trimmed to
    // the rows the screen has, oldest first, so the interactive rows are still drawn.
    expect(out.startsWith(`${ESC}${canvas}A`)).toBe(true);
    expect(out).not.toContain('AragonAgent  openai:deepseek-flash');
    expect(out).toContain('+ Add a follow-up');
    expect(out).toContain(STATUS_OLD);
  });
});
