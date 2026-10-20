import { describe, expect, it } from 'vitest';
import {
  applyResizeGrowth,
  clampSpaceBelow,
  resolveCanvasLayout,
  screenCapacity,
  UNKNOWN_CANVAS,
  type CanvasLayoutInput,
} from '../ui/scrollback/canvas.js';

/**
 * The canvas arithmetic, on its own (tui-canvas-bottom-anchor §11.2).
 *
 * Every screen-truth test in `scrollback-canvas-vt.test.ts` depends on these numbers
 * being right, so they are pinned twice: by example (the numbers the design document
 * quotes) and by property (a random walk over the whole input domain, because the
 * interesting failures are off-by-one at a boundary nobody thought to sample).
 */

/** `capacity` is what was measured; `top` follows from it: `top = C - capacity`. */
function layout(input: Partial<CanvasLayoutInput> & { capacity: number }): ReturnType<
  typeof resolveCanvasLayout
> {
  return resolveCanvasLayout({
    top: 0, heldRows: 0, statRows: 0, frameRows: 0, lead: 0, ...input,
  });
}

const C_OF = (input: Partial<CanvasLayoutInput> & { capacity: number }): number =>
  (input.top ?? 0) + input.capacity;

describe('resolveCanvasLayout', () => {
  it('fits_when_the_content_is_short', () => {
    // §6.5 row 2: a 36-row canvas holding 13 content rows and a 3-row region.
    const out = layout({ capacity: 36, top: 3, heldRows: 11, statRows: 2, frameRows: 3 });
    expect(out).toEqual({
      heldRows: 13, gap: 20, scroll: 0, dropped: 0, top: 3, canvasRows: 36,
    });
  });

  it('a_shrinking_frame_moves_the_gap_to_the_top', () => {
    // The batch the user complained about: the region collapses and the rows it gives
    // back become blank space ABOVE the content, never between it and the composer.
    const grown = layout({ capacity: 36, top: 3, heldRows: 13, frameRows: 12 });
    const collapsed = layout({ capacity: 36, top: 3, heldRows: 13, frameRows: 3 });
    expect(grown.gap).toBe(11);
    expect(collapsed.gap).toBe(20);
    // Nothing moved off the screen in either direction.
    expect(collapsed.scroll).toBe(0);
    expect(collapsed.dropped).toBe(0);
    expect(collapsed.heldRows).toBe(13);
  });

  it('growing_content_eats_the_gap_first', () => {
    const out = layout({ capacity: 36, top: 3, heldRows: 21, statRows: 6, frameRows: 3 });
    expect(out.gap).toBe(6);
    const filled = layout({ capacity: 36, top: 3, heldRows: 27, statRows: 6, frameRows: 3 });
    expect(filled.gap).toBe(0);
    expect(filled.scroll).toBe(0);
    expect(filled.heldRows).toBe(33);
  });

  it('growing_past_the_gap_scrolls_the_head', () => {
    // §6.5 row 6: 40 statics against 27 held rows on a canvas of 36 with 3 rows of
    // host output above it.
    const out = layout({ capacity: 36, top: 3, heldRows: 27, statRows: 40, frameRows: 3 });
    expect(out).toEqual({
      heldRows: 36, gap: 0, scroll: 34, dropped: 31, top: 0, canvasRows: 39,
    });
    // The 31 dropped content rows plus the 3 host rows are exactly the 34 scrolled.
    expect(out.dropped + 3).toBe(out.scroll);
  });

  it('a_reseed_pays_one_row_for_its_crlf', () => {
    const plain = layout({ capacity: 18, top: 1, statRows: 4, frameRows: 2 });
    const reseed = layout({ capacity: 18, top: 1, statRows: 4, frameRows: 2, lead: 1 });
    expect(plain.gap).toBe(12);
    expect(reseed.gap).toBe(11);
    // The canvas starts one row lower and is one row shorter, so its bottom is still
    // the row above the parked cursor.
    expect(reseed.top).toBe(plain.top + 1);
    expect(reseed.top + reseed.canvasRows).toBe(plain.top + plain.canvasRows);
  });

  it('unknown_capacity_yields_no_canvas', () => {
    const out = layout({ capacity: 0, heldRows: 4, statRows: 2, frameRows: 2 });
    expect(out.gap).toBe(0);
    // Nothing fits at all: every row the batch writes leaves the screen at once, and
    // no content row survives on the canvas.
    expect(out.canvasRows).toBe(0);
    expect(out.scroll).toBe(8);
    expect(out.dropped).toBe(6);
    expect(out.heldRows).toBe(0);
  });

  it('clamps_broken_numbers_instead_of_growing_a_NaN_row', () => {
    const out = resolveCanvasLayout({
      capacity: Number.NaN, top: Number.NaN, heldRows: Number.NaN,
      statRows: Number.POSITIVE_INFINITY, frameRows: Number.NaN, lead: Number.NaN,
    });
    expect(out).toEqual({ heldRows: 0, gap: 0, scroll: 0, dropped: 0, top: 0, canvasRows: 0 });
  });

  it('property_LB1_canvas_exactly_fills_the_capacity', () => {
    const failures: string[] = [];
    for (const input of randomInputs(5000)) {
      const out = resolveCanvasLayout(input);
      const sum = out.gap + out.heldRows + (input.frameRows);
      if (sum !== out.canvasRows || out.canvasRows < 0) {
        failures.push(`${JSON.stringify(input)} => ${JSON.stringify(out)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('property_LB2_no_row_is_lost_or_duplicated', () => {
    const failures: string[] = [];
    for (const input of randomInputs(5000)) {
      const out = resolveCanvasLayout(input);
      if (input.heldRows + input.statRows !== out.heldRows + out.dropped) {
        failures.push(`LB-2 sum ${JSON.stringify(input)} => ${JSON.stringify(out)}`);
      }
      if (out.dropped < 0 || out.dropped > input.heldRows + input.statRows) {
        failures.push(`LB-2 range ${JSON.stringify(input)} => ${JSON.stringify(out)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('property_LB3_the_canvas_bottom_is_R_minus_2', () => {
    const failures: string[] = [];
    for (const input of randomInputs(5000)) {
      const out = resolveCanvasLayout(input);
      if (out.top + out.canvasRows !== input.capacity + input.top) {
        failures.push(`LB-3 ${JSON.stringify(input)} => ${JSON.stringify(out)}`);
      }
      if (out.top < 0) failures.push(`LB-3 top ${JSON.stringify(input)}`);
    }
    expect(failures).toEqual([]);
  });

  it('property_a_scrolling_batch_never_keeps_a_gap', () => {
    // I-B3's arithmetic half: a gap row that is not skipped is a row the terminal
    // could push into the scrollback, so `scroll > 0 => gap === 0`.
    const failures: string[] = [];
    for (const input of randomInputs(5000)) {
      const out = resolveCanvasLayout(input);
      if (out.scroll > 0 && out.gap !== 0) failures.push(JSON.stringify(input));
    }
    expect(failures).toEqual([]);
  });
});

describe('screenCapacity and clampSpaceBelow', () => {
  it('the parked row is never part of the capacity', () => {
    expect(screenCapacity(24)).toBe(23);
    expect(screenCapacity(1)).toBe(0);
    expect(screenCapacity(0)).toBe(0);
    expect(screenCapacity(undefined)).toBe(0);
    expect(screenCapacity(Number.NaN)).toBe(0);
  });

  it('clamps_a_measurement_into_the_screen', () => {
    expect(clampSpaceBelow(12, 31)).toBe(12);
    expect(clampSpaceBelow(-3, 31)).toBe(0);
    expect(clampSpaceBelow(9_999, 31)).toBe(30);
    expect(clampSpaceBelow(4.9, 31)).toBe(4);
    expect(clampSpaceBelow(Number.NaN, 31)).toBe(0);
  });

  it('does not guess when the height is unknown', () => {
    expect(clampSpaceBelow(12, undefined)).toBe(0);
    expect(clampSpaceBelow(12, Number.NaN)).toBe(0);
  });
});

describe('applyResizeGrowth', () => {
  it('adds_the_exact_delta', () => {
    expect(applyResizeGrowth(18, 20, 28)).toBe(26);
    expect(applyResizeGrowth(0, 10, 14)).toBe(4);
  });

  it('never shrinks here: a smaller terminal is re-measured instead', () => {
    expect(applyResizeGrowth(18, 28, 20)).toBe(18);
    expect(applyResizeGrowth(18, Number.NaN, 20)).toBe(18);
    expect(applyResizeGrowth(Number.NaN, 20, 28)).toBe(0);
  });
});

describe('the exported constants', () => {
  it('an unknown canvas carries no geometry it could be trusted on', () => {
    expect(UNKNOWN_CANVAS).toEqual({ kind: 'unknown' });
  });
});

/**
 * A deterministic sweep over the input domain §5.3 states, not a random sample: the
 * generator walks a fixed LCG so a failure is reproducible without a seed file.
 */
function randomInputs(count: number): CanvasLayoutInput[] {
  let state = 0x2f6e2b1;
  const next = (max: number): number => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state % (max + 1);
  };
  const out: CanvasLayoutInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const capacity = next(200);
    const top = next(200);
    out.push({
      capacity,
      top,
      heldRows: next(200),
      statRows: next(200),
      // I-S1 guarantees `frame <= capacity + top`: the region never fills the screen.
      frameRows: next(capacity + top),
      lead: next(1),
    });
  }
  return out;
}
