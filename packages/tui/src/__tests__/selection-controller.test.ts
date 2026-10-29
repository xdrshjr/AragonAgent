/**
 * The selection controller (tui-selection-and-scroll-follow §4.4).
 *
 * Driven through a fake `MouseSource`, so these cases are about the LIFECYCLE —
 * press, drag, release, and the three ways `hold` can be let go of — rather than
 * about a terminal.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { MouseEvent } from '../input/mouse-events.js';
import type { MouseSource } from '../input/stdin-filter.js';
import { createSelectionController } from '../ui/selection/selection-controller.js';
import { getTheme } from '../ui/theme.js';

const CAPS = { colorLevel: 0, unicode: true } as const;
const THEME = getTheme('cool', CAPS);
const FRAME = ['first line here', 'second line here', 'third line here', 'fourth line here'];

interface Harness {
  emit(event: MouseEvent): void;
  controller: ReturnType<typeof createSelectionController>;
  repaints: number;
  redraws: number;
  paint(): string[];
  holds: boolean[];
}

function harness(over: { holdMaxMs?: number; repaintOk?: boolean; selectable?: () => boolean } = {}): Harness {
  const listeners = new Set<(event: MouseEvent) => void>();
  const source: MouseSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const state = {
    repaints: 0,
    redraws: 0,
    holds: [] as boolean[],
  };
  const controller = createSelectionController({
    source,
    repaint: () => {
      state.repaints += 1;
      return over.repaintOk ?? true;
    },
    requestRedraw: () => {
      state.redraws += 1;
    },
    theme: () => THEME,
    caps: CAPS,
    cols: () => 40,
    ...(over.selectable ? { isSelectable: over.selectable } : {}),
    // Off by default: only the case that is ABOUT the watchdog should have one.
    holdMaxMs: over.holdMaxMs ?? 0,
  });
  controller.onHoldChange((hold) => state.holds.push(hold));
  // Seed the mirror, exactly as the differ's first frame would.
  controller.decorate(FRAME);
  return {
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    controller,
    paint: () => controller.decorate(FRAME),
    get repaints() {
      return state.repaints;
    },
    get redraws() {
      return state.redraws;
    },
    get holds() {
      return state.holds;
    },
  };
}

/** SGR coordinates are 1-based; frame line `i` is terminal row `i + 1`. */
const press = (x: number, y: number, button: 0 | 1 | 2 = 0): MouseEvent => ({
  kind: 'press',
  button,
  x,
  y,
  shift: false,
  alt: false,
  ctrl: false,
});
const drag = (x: number, y: number): MouseEvent => ({
  kind: 'drag',
  button: 0,
  x,
  y,
  shift: false,
  alt: false,
  ctrl: false,
});
const release = (x: number, y: number): MouseEvent => ({
  kind: 'release',
  button: 0,
  x,
  y,
  shift: false,
  alt: false,
  ctrl: false,
});
const wheel = (): MouseEvent => ({
  kind: 'wheel',
  dir: 'up',
  x: 1,
  y: 1,
  shift: false,
  alt: false,
  ctrl: false,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('settled selection validity', () => {
  function settle(h: Harness): void {
    h.emit(press(1, 1));
    h.emit(drag(6, 1));
    h.emit(release(6, 1));
  }

  it('invalidates changed selected cells before notifying a repainting listener', async () => {
    const h = harness();
    settle(h);
    const frame = ['other line here', ...FRAME.slice(1)];
    const notify = vi.fn(() => h.controller.decorate(frame));
    h.controller.onHoldChange(notify);
    expect(h.controller.decorate(frame)).toEqual(frame);
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.holds).toEqual([true, false]);
    h.controller.dispose();
  });

  it('preserves selection when only color or cells outside it change', () => {
    const h = harness();
    settle(h);
    h.controller.decorate(['\x1b[31mfirst\x1b[0m changed', ...FRAME.slice(1)]);
    expect(h.controller.takeSelection()?.text).toBe('first');
    h.controller.dispose();
  });

  it('clears a settled selection on a wheel event even without viewport movement', () => {
    const h = harness();
    settle(h);
    h.emit(wheel());
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(h.holds).toEqual([true, false]);
    h.controller.dispose();
  });

  it('does not expose the old selection while a new drag is in progress', () => {
    const h = harness();
    settle(h);
    h.emit(press(8, 2));
    expect(h.controller.hasPendingSelection()).toBe(false);
    h.controller.dispose();
  });

  it('watchdog removes both highlight and hold', () => {
    vi.useFakeTimers();
    const h = harness({ holdMaxMs: 100 });
    h.emit(press(1, 1));
    h.emit(drag(6, 1));
    vi.advanceTimersByTime(100);
    expect(h.paint()).toEqual(FRAME);
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(h.holds).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  });

  it.each(['reselect', 'dispose'])('does not deliver obsolete release after %s', async (action) => {
    const h = harness();
    settle(h);
    const notify = vi.fn();
    h.controller.onHoldChange(notify);
    h.controller.decorate(['other', ...FRAME.slice(1)]);
    if (action === 'reselect') h.emit(press(1, 2));
    else h.controller.dispose();
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});

describe('press → drag → release (tui-shift-enter-copy-queue 4.2)', () => {
  it('T-10: settles exactly the dragged text; Ctrl+C takes it once', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1)); // row 0, col 6
    h.emit(drag(11, 1)); // row 0, col 10
    vi.advanceTimersByTime(20); // flush the 16 ms motion coalescer
    h.emit(release(11, 1));
    // The release copies NOTHING any more: the highlight is a PROMISE that
    // waits for the commit key, not a receipt for a copy that happened.
    expect(h.controller.hasPendingSelection()).toBe(true);
    expect(h.paint()).not.toEqual(FRAME);
    expect(h.controller.takeSelection()).toEqual({ text: 'line', lines: 1 });
    // Consumed exactly once, and the take cleared highlight AND hold.
    expect(h.controller.takeSelection()).toBeNull();
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });

  it('takes a multi-row selection with linear semantics and its line count', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1)); // row 0, col 6
    h.emit(drag(6, 2)); // row 1, col 5
    vi.advanceTimersByTime(20);
    h.emit(release(6, 2));
    expect(h.controller.takeSelection()).toEqual({
      text: 'line here\nsecon',
      lines: 2,
    });
    h.controller.dispose();
  });

  it('holds the viewport through the drag AND the pending state; the take releases it', () => {
    // S2's `hold` is what makes a screen-anchored selection HONEST: the rows
    // under the pointer freeze, so the highlight the user sees is the text they
    // get (D-7). Since tui-shift-enter-copy-queue (4.2.3) the freeze OUTLIVES
    // the release -- streaming output must not push the promised rows away
    // between mouse-up and Ctrl+C -- and the take (or clear) is the exit.
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    expect(h.holds).toEqual([true]);
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(11, 1));
    expect(h.holds).toEqual([true]); // STILL held after mouse-up
    h.controller.takeSelection();
    expect(h.holds).toEqual([true, false]);
    h.controller.dispose();
  });

  it('coalesces a burst of motion into ONE repaint', () => {
    // A fast drag across 40 columns costs about three repaints of a few rows
    // each, not forty full frames (§4.4.3).
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(1, 1));
    const before = h.repaints;
    for (let x = 2; x <= 20; x += 1) h.emit(drag(x, 1));
    expect(h.repaints).toBe(before); // nothing painted yet
    vi.advanceTimersByTime(20);
    expect(h.repaints).toBe(before + 1);
    h.controller.dispose();
  });
});

describe('the cases that must NOT copy', () => {
  it('T-11: a plain click settles nothing and leaves no one-cell highlight', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    h.emit(release(7, 1));
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(h.controller.takeSelection()).toBeNull();
    // Nothing painted: `decorate` is the identity again.
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });

  it('T-13: `isSelectable() === false` makes a press a no-op', () => {
    vi.useFakeTimers();
    const h = harness({ selectable: () => false });
    h.emit(press(7, 1));
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(11, 1));
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(h.holds).toEqual([]);
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });

  it('`setEnabled(false)` closes the gate and drops what was selected', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(11, 1));
    expect(h.paint()).not.toEqual(FRAME); // the highlight survives a release

    h.controller.setEnabled(false);
    expect(h.paint()).toEqual(FRAME);
    h.emit(press(7, 1));
    expect(h.holds).toEqual([true, false]); // no third transition
    h.controller.dispose();
  });

  it('a non-left button clears rather than starting a selection', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(11, 1));
    h.emit(press(3, 2, 2)); // right button
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });
});

describe('I-9 — a highlight must never outlive the rows it sits on', () => {
  it('T-12: `clear()` drops the selection and the drag together', () => {
    // `App` calls this on every key, on resize, on an overlay, and from the
    // differ's `onInvalidate`. It is ALSO one of the three ways out of a `hold`
    // that lost its release (I-11).
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    expect(h.holds).toEqual([true]);
    h.controller.clear();
    expect(h.holds).toEqual([true, false]);
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });

  it('T-12: a wheel notch during a drag abandons it', () => {
    // A wheel during a drag is a user changing their mind, not extending a
    // selection; N1 already declines auto-scroll-while-dragging. The notch then
    // scrolls normally, because the wheel router is a separate subscriber.
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(wheel());
    expect(h.holds).toEqual([true, false]);
    expect(h.paint()).toEqual(FRAME);
    h.emit(release(11, 1));
    expect(h.controller.hasPendingSelection()).toBe(false);
    h.controller.dispose();
  });

  it('`clear()` with nothing selected does no work at all', () => {
    // `onInvalidate` fires on every resize and every foreign write, so a session
    // that has never selected anything must not pay a repaint for each one.
    const h = harness();
    const before = h.repaints;
    h.controller.clear();
    h.controller.clear();
    expect(h.repaints).toBe(before);
    expect(h.redraws).toBe(0);
    h.controller.dispose();
  });
});

describe('the settled state exits (tui-shift-enter-copy-queue 4.2.3)', () => {
  function settle(): ReturnType<typeof harness> {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(11, 1));
    expect(h.controller.hasPendingSelection()).toBe(true);
    return h;
  }

  it('`clear()` releases the hold and drops the highlight', () => {
    const h = settle();
    expect(h.holds).toEqual([true]);
    h.controller.clear();
    expect(h.holds).toEqual([true, false]);
    expect(h.paint()).toEqual(FRAME);
    expect(h.controller.takeSelection()).toBeNull();
    h.controller.dispose();
  });

  it('`setEnabled(false)` releases the hold too (overlay opens)', () => {
    const h = settle();
    h.controller.setEnabled(false);
    expect(h.holds).toEqual([true, false]);
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });

  it('`dispose()` releases the hold even with a selection pending', () => {
    const h = settle();
    h.controller.dispose();
    expect(h.holds).toEqual([true, false]);
  });
});

describe('T-29 — the lost-release watchdog (I-11)', () => {
  it('releases hold and removes the stale highlight after holdMaxMs of stillness', () => {
    // ═══ THE FREEZE THIS CATCHES IS SILENT AND PERMANENT ═══
    //
    // Three ways to never get a release: the button comes up while the terminal
    // does not have focus, the emulator swallows it, or the terminal fell back to
    // X10 (which the parser refuses to decode buttons from, for this reason).
    // Without a watchdog, `hold` never clears — content anchoring never lets go,
    // Rule B's third condition never passes, and the transcript is frozen for the
    // rest of the session with nothing raised anywhere.
    vi.useFakeTimers();
    const h = harness({ holdMaxMs: 30_000 });
    h.emit(press(7, 1));
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    const painted = h.paint();
    expect(painted).not.toEqual(FRAME);

    vi.advanceTimersByTime(30_001);
    expect(h.holds).toEqual([true, false]);
    // A lost release cannot leave a highlight which Ctrl+C cannot consume.
    expect(h.controller.hasPendingSelection()).toBe(false);
    expect(h.paint()).toEqual(FRAME);
    h.controller.dispose();
  });

  it('is reset by every motion report, so a slow drag is not cut short', () => {
    // It measures STILLNESS, not the duration of the drag (R-12).
    vi.useFakeTimers();
    const h = harness({ holdMaxMs: 1000 });
    h.emit(press(7, 1));
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(800);
      h.emit(drag(8 + i, 1));
    }
    expect(h.holds).toEqual([true]);
    vi.advanceTimersByTime(1001);
    expect(h.holds).toEqual([true, false]);
    h.controller.dispose();
  });
});

describe('the repaint fallback (§4.4.3)', () => {
  it('asks for a React redraw when the differ has no cache to paint from', () => {
    // `repaint()` returning `''` is a REAL state — an `invalidate()` leaves no
    // origin to address from — and the fallback is one frame later rather than
    // never.
    vi.useFakeTimers();
    const h = harness({ repaintOk: false });
    h.emit(press(7, 1));
    expect(h.redraws).toBe(1);
    h.controller.dispose();
  });

  it('does NOT ask for one when merely clearing', () => {
    // After an invalidate the raw frame is already on screen without a
    // highlight, so a redraw would buy nothing — and `onInvalidate` fires often
    // enough that requesting one would be a nonce bump per resize.
    vi.useFakeTimers();
    const h = harness({ repaintOk: false });
    h.emit(press(7, 1));
    const after = h.redraws;
    h.controller.clear();
    expect(h.redraws).toBe(after);
    h.controller.dispose();
  });
});

describe('decorate', () => {
  it('is the identity while nothing is selected', () => {
    const h = harness();
    expect(h.controller.decorate(FRAME)).toEqual(FRAME);
    h.controller.dispose();
  });

  it('paints only the rows the selection covers', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(3, 2)); // row 1
    h.emit(drag(9, 3)); // row 2
    vi.advanceTimersByTime(20);
    const painted = h.paint();
    expect(painted[0]).toBe(FRAME[0]);
    expect(painted[1]).not.toBe(FRAME[1]);
    expect(painted[2]).not.toBe(FRAME[2]);
    expect(painted[3]).toBe(FRAME[3]);
    // The line count MUST be preserved, or absolute addressing shifts (I-2).
    expect(painted).toHaveLength(FRAME.length);
    h.controller.dispose();
  });

  it('clamps a report whose coordinates fall outside the frame', () => {
    // A terminal that resized mid-drag must not index past the mirror.
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(999, 999));
    h.emit(drag(1, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(1, 1));
    const payload = h.controller.takeSelection();
    expect(payload).not.toBeNull();
    expect(payload?.text).toContain('first line here');
    h.controller.dispose();
  });
});
