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

/**
 * The share of `popupMaxHeight` a completion menu may actually occupy (defect 10).
 *
 * `popupCapacity` answers "how much COULD the editor slot take", and its floor is
 * one message row - right for a picker that owns the frame, wrong for a menu that
 * opens over a conversation. At 20 rows the whole capacity is 13, which leaves one
 * transcript row and no TODO rail at all (measured, `todo-app-layout.test.tsx`).
 * Half keeps the menu growing with the terminal - 6 rows at 20, 11 at 30, 16 at 40 -
 * while the conversation and the rail keep their rows.
 *
 * A divisor rather than a row count or a fraction of the terminal: it is the only
 * form that stays derived from the frame budget instead of becoming a second
 * authority beside it, and it cannot drift when `popupCapacity` changes.
 */
export const POPUP_CAPACITY_SHARE = 2;

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
