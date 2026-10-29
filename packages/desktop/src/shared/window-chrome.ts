/**
 * The colours of the native window chrome (the Windows / Linux caption-button strip and the
 * window background), keyed by the APPLICATION theme.
 *
 * The application theme comes from the engine's `config.json` and only the renderer resolves it, so
 * the main process cannot derive these from the OS theme (`nativeTheme`): with "OS light + app dark"
 * that gives a white caption strip on a dark window. The renderer tells the main process which theme
 * is showing (`window:set-chrome`) and this table is the single place the answer becomes a colour.
 *
 * Each value mirrors a token in `renderer/styles/tokens.css`; `__tests__/window-chrome.test.ts`
 * reads that stylesheet and fails when the two drift. This file is the only main-process source of
 * raw colours.
 */

export type ChromeTheme = 'dark' | 'light' | 'warm';

export interface ChromeColors {
  /** `--bg-surface-100`: the title bar background, which the caption strip must match. */
  bar: string;
  /** `--fg-default`: the minimise / maximise / close glyphs. */
  symbol: string;
  /** `--bg-default`: the window background (what shows while resizing or repainting). */
  page: string;
}

/** Height of the in-page title bar in CSS px at zoom 1 (`--titlebar-h`). */
export const TITLE_BAR_HEIGHT = 40;

export const CHROME_COLORS: Record<ChromeTheme, ChromeColors> = {
  dark: { bar: '#171717', symbol: '#fafafa', page: '#121212' },
  light: { bar: '#ffffff', symbol: '#171717', page: '#fcfcfc' },
  warm: { bar: '#191815', symbol: '#faf8f3', page: '#131210' },
};

export function isChromeTheme(value: unknown): value is ChromeTheme {
  return value === 'dark' || value === 'light' || value === 'warm';
}

/** The colours for an application theme; with none known yet (first launch) follow the OS. */
export function chromeColors(theme: ChromeTheme | undefined, osDark: boolean): ChromeColors {
  return CHROME_COLORS[theme ?? (osDark ? 'dark' : 'light')];
}

export interface OverlayParams {
  color: string;
  symbolColor: string;
  height: number;
  backgroundColor: string;
}

/**
 * What to hand to Electron for the caption-button strip and the window background. The strip is one
 * pixel shorter than the title bar so it leaves the bar's bottom divider line unbroken.
 */
export function overlayFor(theme: ChromeTheme | undefined, osDark: boolean, zoom: number): OverlayParams {
  const colors = chromeColors(theme, osDark);
  return {
    color: colors.bar,
    symbolColor: colors.symbol,
    height: Math.max(1, Math.round(TITLE_BAR_HEIGHT * zoom) - 1),
    backgroundColor: colors.page,
  };
}
