import { TODO_LIMITS } from '../../todo/limits.js';
import type { RenderMode } from './frame.js';
import { todoRailWidth } from './rail.js';

export interface TodoRailLayoutInput {
  mode: RenderMode;
  cols: number;
  panelEnabled: boolean;
  overlayOpen: boolean;
  itemCount: number;
  viewportBudget: number;
  teamRows: number;
  popupRows: number;
}

export interface TodoRailLayout {
  visible: boolean;
  reason: 'visible' | 'inline' | 'disabled' | 'overlay' | 'empty' | 'narrow' | 'short';
  width: number;
  rows: number;
  contentCols: number;
  popupMaxHeight: number;
}

/** Allocate columns and rows from the same team/menu projections as the renderers.
 * Invalid geometry becomes zero, excess team/menu rows are clamped. Menu capacity
 * never depends on menu occupancy or rail visibility, preventing feedback loops.
 */
export function buildTodoRailLayout(input: TodoRailLayoutInput): TodoRailLayout {
  const cols = nonNegativeInt(input.cols);
  const budget = nonNegativeInt(input.viewportBudget);
  const teamRows = Math.min(budget, nonNegativeInt(input.teamRows));
  const popupMaxHeight = Math.max(0, budget - teamRows - TODO_LIMITS.panelMinRows);
  const popupRows = popupMaxHeight < 3 ? 0 : Math.min(nonNegativeInt(input.popupRows), popupMaxHeight);
  const rows = budget - teamRows - popupRows;
  const width = todoRailWidth(cols);
  const reason = input.mode !== 'fullscreen' ? 'inline'
    : !input.panelEnabled ? 'disabled'
    : input.overlayOpen ? 'overlay'
    : nonNegativeInt(input.itemCount) === 0 ? 'empty'
    : width === 0 ? 'narrow'
    : rows < TODO_LIMITS.panelMinRows ? 'short'
    : 'visible';
  const visible = reason === 'visible';
  return { visible, reason, width, rows, contentCols: cols - (visible ? width : 0), popupMaxHeight };
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
