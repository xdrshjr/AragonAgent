/**
 * Which geometry a window should open with. Pure and Electron-free so every rule is unit-tested;
 * `window-manager.ts` supplies the connected displays' work areas and applies the result.
 *
 * Rules, in order: no saved state -> the fallback size; size clamped to [MIN_SIZE, largest work
 * area]; a position is kept only when the title bar is still reachable on some display (otherwise
 * the OS places the window and only the size survives); zoom clamped to [ZOOM_MIN, ZOOM_MAX].
 */

import { LIMITS, clampZoom, type WindowState } from '../shared/desktop-state.js';
import type { ChromeTheme } from '../shared/window-chrome.js';

export { clampZoom, ZOOM_MAX, ZOOM_MIN } from '../shared/desktop-state.js';

export interface Rect { x: number; y: number; width: number; height: number }

export interface SavedWindow {
  bounds: { x?: number; y?: number; width: number; height: number };
  maximized: boolean;
  zoom?: number;
  chromeTheme?: ChromeTheme;
}

export interface BoundsPlan {
  bounds: Partial<Rect> & { width: number; height: number };
  maximize: boolean;
  zoom: number;
  /** The last theme the chrome was painted for, so the first frame already has the right colours. */
  chromeTheme?: ChromeTheme;
}

export const MIN_SIZE = { width: 800, height: 560 } as const;
export const DEFAULT_SIZE = { width: 1280, height: 820 } as const;
/** How much of the window must stay inside a display for the saved position to be trusted. */
const REACH = 40;

/** True when the title bar strip of `bounds` can be grabbed on at least one display. */
export function isReachable(bounds: Rect, displays: readonly Rect[]): boolean {
  return displays.some((area) =>
    bounds.x < area.x + area.width - REACH && bounds.x + bounds.width > area.x + REACH
    && bounds.y < area.y + area.height - REACH && bounds.y + REACH > area.y);
}

export function planWindowBounds(
  saved: SavedWindow | undefined,
  displays: readonly Rect[],
  fallback: { width: number; height: number } = DEFAULT_SIZE,
): BoundsPlan {
  if (!saved) return { bounds: { ...fallback }, maximize: false, zoom: 1 };
  const maxWidth = displays.reduce((best, area) => Math.max(best, area.width), 0) || Number.POSITIVE_INFINITY;
  const maxHeight = displays.reduce((best, area) => Math.max(best, area.height), 0) || Number.POSITIVE_INFINITY;
  const width = Math.round(Math.min(Math.max(saved.bounds.width, MIN_SIZE.width), Math.max(maxWidth, MIN_SIZE.width)));
  const height = Math.round(Math.min(Math.max(saved.bounds.height, MIN_SIZE.height), Math.max(maxHeight, MIN_SIZE.height)));
  const { x, y } = saved.bounds;
  const sizeOnly = { width, height };
  const positioned = x !== undefined && y !== undefined && isReachable({ x, y, width, height }, displays);
  return {
    bounds: positioned ? { x, y, width, height } : sizeOnly,
    maximize: saved.maximized === true,
    zoom: clampZoom(saved.zoom),
    ...(saved.chromeTheme === undefined ? {} : { chromeTheme: saved.chromeTheme }),
  };
}

export interface LiveWindow {
  bounds: Rect;
  /** The un-maximized bounds; used when `maximized` so restoring returns to the normal size. */
  normalBounds: Rect;
  maximized: boolean;
  zoom: number;
  /** The theme the chrome is painted for; absent until the renderer has reported one. */
  chromeTheme?: ChromeTheme;
}

/**
 * The `WindowState` to persist for a live window. `zoom` and `chromeTheme` are written explicitly
 * because `normalizeWindow` rebuilds the object field by field: a field left out here is silently
 * lost on every move or resize.
 */
export function buildWindowState(live: LiveWindow, previous: WindowState | undefined): WindowState {
  const chromeTheme = live.chromeTheme ?? previous?.chromeTheme;
  return {
    id: 'w1',
    bounds: live.maximized ? { ...live.normalBounds } : { ...live.bounds },
    maximized: live.maximized,
    zoom: clampZoom(live.zoom),
    ...(chromeTheme === undefined ? {} : { chromeTheme }),
    sidebarWidth: previous?.sidebarWidth ?? 260,
    inspectorWidth: previous?.inspectorWidth ?? LIMITS.inspectorWidth.fallback,
    inspectorOpen: previous?.inspectorOpen ?? false,
    inspectorTab: previous?.inspectorTab ?? 'changes',
    openSessions: previous?.openSessions ?? [],
    activeSession: previous?.activeSession ?? null,
  };
}

/** Trailing-edge debounce with an explicit flush; the clock is injectable for tests. */
export class TrailingDebounce {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly run: () => void, private readonly waitMs: number) {}

  trigger(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, this.waitMs);
  }

  /** Run now if something is pending. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.run();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
