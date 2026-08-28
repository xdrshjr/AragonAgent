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
import type { CopyVia } from '../ui/clipboard.js';
import { getTheme } from '../ui/theme.js';

const CAPS = { colorLevel: 0, unicode: true } as const;
const THEME = getTheme('cool', CAPS);
const FRAME = ['first line here', 'second line here', 'third line here', 'fourth line here'];

interface Harness {
  emit(event: MouseEvent): void;
  controller: ReturnType<typeof createSelectionController>;
  copied: string[];
  toasts: { via: CopyVia; lines: number; chars: number }[];
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
    copied: [] as string[],
    toasts: [] as { via: CopyVia; lines: number; chars: number }[],
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
    copy: (text) => {
      state.copied.push(text);
      return 'osc52';
    },
    onCopied: (via, lines, chars) => state.toasts.push({ via, lines, chars }),
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
    get copied() {
      return state.copied;
    },
    get toasts() {
      return state.toasts;
    },
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

describe('press → drag → release', () => {
  it('T-10: copies exactly the dragged text, once', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1)); // row 0, col 6
    h.emit(drag(11, 1)); // row 0, col 10
    vi.advanceTimersByTime(20); // flush the 16 ms motion coalescer
    h.emit(release(11, 1));
    expect(h.copied).toEqual(['line']);
    expect(h.toasts).toEqual([{ via: 'osc52', lines: 1, chars: 4 }]);
    h.controller.dispose();
  });

  it('copies a multi-row selection with linear semantics', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1)); // row 0, col 6
    h.emit(drag(6, 2)); // row 1, col 5
    vi.advanceTimersByTime(20);
    h.emit(release(6, 2));
    expect(h.copied).toEqual(['line here\nsecon']);
    h.controller.dispose();
  });

  it('holds the viewport for the duration of the drag and lets go on release', () => {
    // S2's `hold` is what makes a screen-anchored selection HONEST: the rows
    // under the pointer freeze, so the highlight the user sees is the text they
    // get (D-7). Shipping S3 without it would produce a selection that slides out
    // from under the pointer during a streaming run.
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    expect(h.holds).toEqual([true]);
    h.emit(drag(11, 1));
    vi.advanceTimersByTime(20);
    h.emit(release(11, 1));
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
  it('T-11: a plain click copies nothing and leaves no one-cell highlight', () => {
    vi.useFakeTimers();
    const h = harness();
    h.emit(press(7, 1));
    h.emit(release(7, 1));
    expect(h.copied).toEqual([]);
    expect(h.toasts).toEqual([]);
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
    expect(h.copied).toEqual([]);
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
    expect(h.copied).toEqual([]);
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

describe('T-29 — the lost-release watchdog (I-11)', () => {
  it('releases `hold` after `holdMaxMs` of stillness and KEEPS the selection', () => {
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
    // The selection SURVIVES: the user may still want to copy it, and throwing it
    // away would turn a terminal quirk into lost work.
    expect(h.paint()).toEqual(painted);
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
    expect(h.copied).toHaveLength(1);
    expect(h.copied[0]).toContain('first line here');
    h.controller.dispose();
  });
});
