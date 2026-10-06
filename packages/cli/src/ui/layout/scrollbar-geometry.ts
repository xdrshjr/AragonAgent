import type { ThumbRange } from './scroll-indicator.js';

export interface ScrollbarGeometry {
  trackTop: number;
  trackCol: number;
  trackRows: number;
  contentRows: number;
  offset: number;
  thumb: ThumbRange | null;
  revision: number;
}

export interface ThumbOffsetInput {
  geometry: ScrollbarGeometry;
  pointerY: number;
  grabRow: number;
}

/** Convert a captured pointer to a bottom-relative offset, with exact endpoints. */
export function offsetForThumb({ geometry: g, pointerY, grabRow }: ThumbOffsetInput): number {
  const values = [g.trackTop, g.trackRows, g.contentRows, pointerY, grabRow];
  if (!values.every(Number.isFinite) || !g.thumb) return g.offset;
  const overflow = Math.max(0, g.contentRows - g.trackRows);
  const travel = g.trackRows - g.thumb.size;
  if (travel <= 0 || overflow === 0) return g.offset;
  const grab = Math.min(Math.max(0, Math.floor(grabRow)), g.thumb.size - 1);
  const top = Math.min(travel, Math.max(0, Math.floor(pointerY) - g.trackTop - grab));
  return overflow - Math.round(top / travel * overflow);
}
