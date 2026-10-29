/** Responsive TODO rail widths, measured in terminal columns including chrome. */
const RAIL_FRACTION = 0.15;
export const TODO_RAIL_MIN_COLS = 14;
export const TODO_RAIL_MAX_COLS = 36;
export const TODO_TRANSCRIPT_MIN_COLS = 62;
export const TODO_RAIL_MIN_TOTAL_COLS = TODO_TRANSCRIPT_MIN_COLS + TODO_RAIL_MIN_COLS;
export const TODO_RAIL_INDEX_MIN_COLS = 22;

/** Return a non-decreasing rail width; invalid or narrow terminals have no rail. */
export function todoRailWidth(cols: number): number {
  if (!Number.isFinite(cols)) return 0;
  const columns = Math.floor(cols);
  if (columns < TODO_RAIL_MIN_TOTAL_COLS) return 0;
  return Math.min(
    TODO_RAIL_MAX_COLS,
    Math.max(TODO_RAIL_MIN_COLS, Math.round(columns * RAIL_FRACTION)),
  );
}
