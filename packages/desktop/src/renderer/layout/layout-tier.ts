/**
 * How the shell degrades when the window is too narrow for icon rail + sidebar + main + inspector.
 * Pure, so every boundary is unit-tested. All widths are CSS px (what a ResizeObserver reports), NOT
 * window pixels: at the 1.6 maximum zoom an 800px window is only 500 CSS px wide.
 *
 *   1  everything fits: the sidebar shows and the inspector keeps the width the user gave it.
 *   2  the sidebar does not fit next to the inspector: it hides itself (the preference is untouched,
 *      so it comes back when there is room). The threshold follows the user's sidebar width.
 *   3  not even rail + inspector + main fit: the minimums relax so the page still never scrolls
 *      sideways (the tab strip scrolls instead of wrapping).
 */

export const RAIL_WIDTH = 48;
export const RESIZER_WIDTH = 5;
export const INSPECTOR_MIN = 320;
export const MAIN_MIN = 360;
export const INSPECTOR_MIN_TIGHT = 280;
export const MAIN_MIN_TIGHT = 240;

export type LayoutTier = 1 | 2 | 3;

export function widthNeeded(sidebarVisible: boolean, sidebarWidth: number): number {
  return RAIL_WIDTH + (sidebarVisible ? sidebarWidth + RESIZER_WIDTH : 0) + INSPECTOR_MIN + MAIN_MIN;
}

export function computeLayoutTier(
  bodyWidth: number, sidebarWidth: number, inspectorVisible: boolean, inSettings: boolean,
): LayoutTier {
  // Unmeasured (first render, jsdom) is not "narrow".
  if (!inspectorVisible || inSettings || bodyWidth <= 0) return 1;
  if (bodyWidth >= widthNeeded(true, sidebarWidth)) return 1;
  if (bodyWidth >= widthNeeded(false, sidebarWidth)) return 2;
  return 3;
}

/** The widest the inspector may usefully be: what is left after the rail, sidebar and a usable main. */
export function inspectorMaxWidth(
  bodyWidth: number, sidebarVisible: boolean, sidebarWidth: number, tier: LayoutTier,
): number {
  const mainMin = tier === 3 ? MAIN_MIN_TIGHT : MAIN_MIN;
  const room = bodyWidth - RAIL_WIDTH - (sidebarVisible ? sidebarWidth + RESIZER_WIDTH : 0) - mainMin;
  return Math.max(tier === 3 ? INSPECTOR_MIN_TIGHT : INSPECTOR_MIN, Math.min(640, room));
}
