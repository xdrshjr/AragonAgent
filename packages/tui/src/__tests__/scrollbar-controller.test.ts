import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScrollbarController } from '../ui/scrollbar-controller.js';
import { thumbRange } from '../ui/layout/scroll-indicator.js';
import type { ButtonEvent } from '../input/mouse-events.js';

const event = (kind: ButtonEvent['kind'], y: number, x = 80): ButtonEvent =>
  ({ kind, x, y, button: 0, shift: false, alt: false, ctrl: false });

function setup(offset = 41) {
  const setOffset = vi.fn();
  const page = vi.fn();
  const onHold = vi.fn();
  const geometry = { trackTop: 2, trackCol: 80, trackRows: 20,
    contentRows: 100, offset, thumb: thumbRange(20, 100, offset, true), revision: 1 };
  const controller = createScrollbarController({ getGeometry: () => geometry,
    setOffset, page, onHold, onStart: vi.fn(), isEnabled: () => true });
  return { controller, geometry, setOffset, page, onHold };
}

describe('scrollbar gestures', () => {
  afterEach(() => vi.useRealTimers());
  it('discards pending movement on geometry invalidation and explicit cancellation', () => {
    vi.useFakeTimers();
    const { controller, geometry, setOffset } = setup();
    controller.handle(event('press', 11));
    controller.handle(event('drag', 15));
    geometry.revision++;
    vi.advanceTimersByTime(16);
    expect(controller.isCaptured()).toBe(false);
    expect(setOffset).not.toHaveBeenCalled();
    controller.handle(event('press', 11));
    controller.handle(event('drag', 16));
    controller.cancel();
    vi.advanceTimersByTime(30);
    expect(setOffset).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
  it('consumes non-overflowing track gestures without paging or leaking release', () => {
    const { controller, geometry, page, setOffset } = setup();
    geometry.contentRows = 20;
    geometry.thumb = null;
    expect(controller.handle(event('press', 10))).toBe(true);
    expect(controller.handle({ ...event('release', 12, 1), ctrl: true })).toBe(true);
    expect(page).not.toHaveBeenCalled();
    expect(setOffset).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('does not steal a body selection or a modified press', () => {
    const { controller, setOffset } = setup();
    expect(controller.handle(event('press', 11, 1))).toBe(false);
    expect(controller.handle(event('drag', 12))).toBe(false);
    expect(controller.handle(event('release', 12))).toBe(false);
    expect(controller.handle({ ...event('press', 11), shift: true })).toBe(false);
    expect(controller.handle(event('press', Number.NaN))).toBe(false);
    expect(setOffset).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('does not quantize an unmoved press and release', () => {
    const { controller, setOffset } = setup();
    expect(controller.handle(event('press', 11))).toBe(true);
    controller.handle(event('drag', 11, 20));
    controller.handle(event('release', 11));
    expect(setOffset).not.toHaveBeenCalled();
    expect(controller.isCaptured()).toBe(false);
    controller.dispose();
  });
  it('coalesces moves, keeps capture outside the track and flushes release', () => {
    vi.useFakeTimers();
    const { controller, setOffset } = setup();
    controller.handle(event('press', 11));
    for (let i = 0; i < 100; i++) controller.handle(event('drag', 12 + i % 5, 1));
    expect(setOffset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(setOffset).toHaveBeenCalledTimes(1);
    controller.handle({ ...event('release', 30, 1), shift: true });
    expect(setOffset).toHaveBeenLastCalledWith(0);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pages once and expires missing releases without copying late events', () => {
    vi.useFakeTimers();
    const { controller, page } = setup();
    controller.handle(event('press', 2));
    controller.handle(event('drag', 3));
    expect(page).toHaveBeenCalledExactlyOnceWith('pageUp');
    vi.advanceTimersByTime(30000);
    expect(controller.isCaptured()).toBe(false);
    expect(controller.handle(event('release', 3))).toBe(true);
    controller.dispose();
  });
});
