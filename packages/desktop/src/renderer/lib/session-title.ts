/**
 * A session title for DISPLAY. Titles are free text (a dispatched task's whole brief can become one):
 * they contain newlines, runs of spaces and can be thousands of characters long. A one-line row has
 * to collapse the whitespace, and must not hand the layout engine a 5000-character string to measure
 * only to cut it with an ellipsis. The stored title is never changed.
 */

/** Visible row text: the CSS ellipsis cuts it much sooner, this only bounds the work. */
export const TITLE_ROW_MAX = 200;
/** The hover tooltip: long enough to read the brief, short enough not to fill the screen. */
export const TITLE_TOOLTIP_MAX = 400;

export function displayTitle(raw: string | null | undefined, fallback: string, max: number): string {
  const collapsed = (raw ?? '').replace(/\s+/gu, ' ').trim();
  if (collapsed === '') return fallback;
  // Spread by code point so a surrogate pair is never cut in half.
  const points = [...collapsed];
  return points.length > max ? `${points.slice(0, max).join('')}…` : collapsed;
}
