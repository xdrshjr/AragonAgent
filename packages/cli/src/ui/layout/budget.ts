/** One height budget for the transcript, fixed editor and status slots. */
import { draftMaxRows } from '../composer-limits.js';
import { MIN_FULLSCREEN_ROWS, MIN_FULLSCREEN_COLS } from './frame.js';

export const HINT_MIN_ROWS = 20;
export interface FrameBudgetInput {
  rows?: number;
  cols?: number;
  draftRows: number;
  popupRows: number;
  statusExpanded: boolean;
}
export interface FrameBudget {
  rows: number;
  cols: number;
  inactive: boolean;
  frameRows: number;
  headerRows: number;
  statusRows: 0 | 1 | 2;
  composerRows: number;
  composerSlotRows: number;
  popupRows: number;
  popupMaxHeight: number;
  viewportRows: number;
  composerCols: number;
}
const dimension = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

/** Clamp the displayed draft, independently of any transcript or panel content. */
export function clampDraftRows(rows: number, draftRows: number): number {
  const wanted = Number.isFinite(draftRows) ? Math.floor(draftRows) : 1;
  return Math.max(1, Math.min(wanted, draftMaxRows(rows)));
}

/** Total menu capacity, including its borders; reserve at least one message row. */
export function popupCapacity(rows: number, draftRows: number, statusExpanded: boolean): number {
  return Math.max(0, rows - 1 - 1 - (statusExpanded ? 2 : 1)
    - 2 - clampDraftRows(rows, draftRows) - 1);
}

/** Normalize terminal dimensions once and conserve every visible frame row. */
export function buildFrameBudget(input: FrameBudgetInput): FrameBudget {
  const rows = dimension(input.rows, 24);
  const cols = dimension(input.cols, 80);
  const frameRows = rows - 1;
  const composerCols = Math.max(0, cols - 1);
  const inactive = rows < MIN_FULLSCREEN_ROWS || cols < MIN_FULLSCREEN_COLS;
  if (inactive) return { rows, cols, inactive, frameRows, composerCols, headerRows: 0,
    statusRows: 0, composerRows: 0, composerSlotRows: 0, popupRows: 0,
    popupMaxHeight: 0, viewportRows: 0 };
  const statusRows = input.statusExpanded ? 2 : 1;
  const composerRows = 2 + clampDraftRows(rows, input.draftRows);
  const popupMaxHeight = popupCapacity(rows, input.draftRows, input.statusExpanded);
  const requested = Number.isFinite(input.popupRows) ? Math.floor(input.popupRows) : 0;
  const candidate = Math.max(0, Math.min(requested, popupMaxHeight));
  const popupRows = candidate >= 3 ? candidate : 0;
  const composerSlotRows = composerRows + popupRows;
  return { rows, cols, inactive, frameRows, composerCols, headerRows: 1, statusRows,
    composerRows, composerSlotRows, popupRows, popupMaxHeight,
    viewportRows: frameRows - 1 - statusRows - composerSlotRows };
}
