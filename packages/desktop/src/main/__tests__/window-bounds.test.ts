/** AC-71 (unit half) / AC-72: where a window opens, and that zoom survives every write. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDesktopState, normalizeDesktopState, serializeDesktopState, type WindowState } from '../../shared/desktop-state.js';
import {
  DEFAULT_SIZE, MIN_SIZE, TrailingDebounce, ZOOM_MAX, ZOOM_MIN, buildWindowState, clampZoom, isReachable,
  planWindowBounds, type Rect,
} from '../window-bounds.js';

const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: Rect = { x: -1600, y: 0, width: 1600, height: 900 };
const saved = (bounds: { x?: number; y?: number; width: number; height: number }, extra: { maximized?: boolean; zoom?: number } = {}) =>
  ({ bounds, maximized: extra.maximized ?? false, ...(extra.zoom === undefined ? {} : { zoom: extra.zoom }) });

describe('planWindowBounds', () => {
  it('no saved state: the fallback size, not maximized, zoom 1', () => {
    expect(planWindowBounds(undefined, [SCREEN])).toEqual({ bounds: { ...DEFAULT_SIZE }, maximize: false, zoom: 1 });
    expect(planWindowBounds(undefined, [SCREEN], { width: 900, height: 600 }).bounds).toEqual({ width: 900, height: 600 });
  });

  it('keeps a saved position and size that fit', () => {
    const plan = planWindowBounds(saved({ x: 120, y: 90, width: 1000, height: 700 }), [SCREEN]);
    expect(plan.bounds).toEqual({ x: 120, y: 90, width: 1000, height: 700 });
  });

  it('clamps the size to the minimum and to the largest display', () => {
    expect(planWindowBounds(saved({ x: 0, y: 0, width: 100, height: 100 }), [SCREEN]).bounds)
      .toMatchObject({ width: MIN_SIZE.width, height: MIN_SIZE.height });
    expect(planWindowBounds(saved({ x: 0, y: 0, width: 9000, height: 9000 }), [SCREEN]).bounds)
      .toMatchObject({ width: SCREEN.width, height: SCREEN.height });
  });

  it('a missing x or y keeps only the size (the OS places the window)', () => {
    expect(planWindowBounds(saved({ x: 50, width: 1000, height: 700 }), [SCREEN]).bounds).toEqual({ width: 1000, height: 700 });
    expect(planWindowBounds(saved({ width: 1000, height: 700 }), [SCREEN]).bounds).toEqual({ width: 1000, height: 700 });
  });

  it('a position entirely off every display keeps only the size', () => {
    expect(planWindowBounds(saved({ x: 5000, y: 5000, width: 1000, height: 700 }), [SCREEN]).bounds).toEqual({ width: 1000, height: 700 });
  });

  it('a window only partly on screen is kept when at least 40 px of the title bar is reachable', () => {
    expect(planWindowBounds(saved({ x: 1900 - 41, y: 10, width: 1000, height: 700 }), [SCREEN]).bounds).toMatchObject({ x: 1859 });
    expect(planWindowBounds(saved({ x: 1900, y: 10, width: 1000, height: 700 }), [SCREEN]).bounds).toEqual({ width: 1000, height: 700 });
    // the title bar below the work area is not grabbable even if the body overlaps
    expect(planWindowBounds(saved({ x: 100, y: 1040, width: 1000, height: 700 }), [SCREEN]).bounds).toEqual({ width: 1000, height: 700 });
  });

  it('a negative-coordinate secondary display counts', () => {
    expect(planWindowBounds(saved({ x: -1500, y: 50, width: 1000, height: 700 }), [SCREEN, SECOND]).bounds).toMatchObject({ x: -1500, y: 50 });
    // the same coordinates with that display gone fall back to size-only
    expect(planWindowBounds(saved({ x: -1500, y: 50, width: 1000, height: 700 }), [SCREEN]).bounds).toEqual({ width: 1000, height: 700 });
  });

  it('maximized is carried through', () => {
    expect(planWindowBounds(saved({ x: 10, y: 10, width: 1000, height: 700 }, { maximized: true }), [SCREEN]).maximize).toBe(true);
    expect(planWindowBounds(saved({ x: 10, y: 10, width: 1000, height: 700 }), [SCREEN]).maximize).toBe(false);
  });

  it('zoom is clamped, rounded and defaults to 1 when absent or not finite', () => {
    const zoomOf = (zoom: number | undefined) => planWindowBounds(saved({ width: 1000, height: 700 }, zoom === undefined ? {} : { zoom }), [SCREEN]).zoom;
    expect(zoomOf(undefined)).toBe(1);
    expect(zoomOf(1.25)).toBe(1.25);
    expect(zoomOf(9)).toBe(ZOOM_MAX);
    expect(zoomOf(0.1)).toBe(ZOOM_MIN);
    expect(zoomOf(Number.NaN)).toBe(1);
    expect(zoomOf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(zoomOf(1.2000000001)).toBe(1.2);
  });

  it('isReachable agrees with the plan', () => {
    expect(isReachable({ x: 0, y: 0, width: 800, height: 600 }, [SCREEN])).toBe(true);
    expect(isReachable({ x: 3000, y: 0, width: 800, height: 600 }, [SCREEN])).toBe(false);
  });
});

describe('zoom survives persistence (F17: normalizeWindow and persist rebuild the object field by field)', () => {
  const live = { bounds: { x: 10, y: 20, width: 1000, height: 700 }, normalBounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: false, zoom: 1.25 };

  it('a zoom round-trips through disk normalisation', () => {
    const state = normalizeDesktopState(serializeDesktopState({ ...defaultDesktopState(), windows: [buildWindowState(live, undefined)] }));
    expect(state.windows[0]?.zoom).toBe(1.25);
  });

  it('an old file without zoom reads as "absent" (treated as 1), and an invalid zoom is dropped or clamped', () => {
    const base = { bounds: { width: 1000, height: 700 } };
    expect(normalizeDesktopState({ windows: [base] }).windows[0]?.zoom).toBeUndefined();
    expect(normalizeDesktopState({ windows: [{ ...base, zoom: 'big' }] }).windows[0]?.zoom).toBeUndefined();
    expect(normalizeDesktopState({ windows: [{ ...base, zoom: 7 }] }).windows[0]?.zoom).toBe(ZOOM_MAX);
    expect(clampZoom(undefined)).toBe(1);
  });

  it('a move / resize write keeps the zoom and the panel layout it did not touch', () => {
    const previous: WindowState = {
      id: 'w1', bounds: { width: 1, height: 1 }, maximized: false, zoom: 1.5, sidebarWidth: 300, inspectorWidth: 400,
      inspectorOpen: true, inspectorTab: 'plan', openSessions: ['a'], activeSession: 'a',
    };
    const next = buildWindowState({ ...live, zoom: 1.5 }, previous);
    expect(next.zoom).toBe(1.5);
    expect(next).toMatchObject({ sidebarWidth: 300, inspectorWidth: 400, inspectorOpen: true, inspectorTab: 'plan', activeSession: 'a' });
  });

  it('a move / resize write keeps the chrome theme, and a live theme wins over the stored one', () => {
    const previous: WindowState = {
      id: 'w1', bounds: { width: 1, height: 1 }, maximized: false, sidebarWidth: 300, inspectorWidth: 400,
      inspectorOpen: false, inspectorTab: 'changes', openSessions: [], activeSession: null, chromeTheme: 'warm',
    };
    expect(buildWindowState(live, previous).chromeTheme).toBe('warm');
    expect(buildWindowState({ ...live, chromeTheme: 'dark' }, previous).chromeTheme).toBe('dark');
    expect(buildWindowState(live, undefined).chromeTheme).toBeUndefined();
    const round = normalizeDesktopState({ windows: [buildWindowState({ ...live, chromeTheme: 'dark' }, previous)] });
    expect(round.windows[0]?.chromeTheme).toBe('dark');
  });

  it('the plan carries the saved chrome theme so the first frame is already right', () => {
    const plan = planWindowBounds({ bounds: { width: 1000, height: 700 }, maximized: false, chromeTheme: 'warm' }, [], DEFAULT_SIZE);
    expect(plan.chromeTheme).toBe('warm');
    expect(planWindowBounds(undefined, [], DEFAULT_SIZE).chromeTheme).toBeUndefined();
  });

  it('a maximized window saves its normal bounds so un-maximizing returns to them', () => {
    const next = buildWindowState({ ...live, bounds: { x: 0, y: 0, width: 1920, height: 1040 }, maximized: true }, undefined);
    expect(next.bounds).toEqual(live.normalBounds);
    expect(next.maximized).toBe(true);
  });
});

describe('TrailingDebounce (AC-71: N move events -> at most 2 writes)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('collapses a drag into one write after the quiet period', () => {
    const run = vi.fn();
    const debounce = new TrailingDebounce(run, 400);
    for (let index = 0; index < 60; index += 1) { debounce.trigger(); vi.advanceTimersByTime(16); }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('flush writes at once when something is pending, and never when nothing is', () => {
    const run = vi.fn();
    const debounce = new TrailingDebounce(run, 400);
    debounce.flush();
    expect(run).not.toHaveBeenCalled();
    debounce.trigger();
    debounce.flush();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel drops a pending write', () => {
    const run = vi.fn();
    const debounce = new TrailingDebounce(run, 400);
    debounce.trigger();
    debounce.cancel();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});
