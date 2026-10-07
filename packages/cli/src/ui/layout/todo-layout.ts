import { TODO_LIMITS } from '../../todo/limits.js';
import { todoRailWidth } from './rail.js';

export interface TodoRailLayoutInput {
  cols: number;
  panelEnabled: boolean;
  overlayOpen: boolean;
  itemCount: number;
  viewportBudget: number;
  teamRows: number;
  queueRows?: number;
  popupRows: number;
  composerBaseRows?: number;
}

export interface TodoRailLayout {
  visible: boolean;
  reason: 'visible' | 'disabled' | 'overlay' | 'empty' | 'narrow' | 'short';
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
  const popupMaxHeight = Math.max(0, budget - teamRows - nonNegativeInt(input.queueRows ?? 0) - 1
    - nonNegativeInt(input.composerBaseRows ?? 0));
  const popupRows = popupMaxHeight < 3 ? 0 : Math.min(nonNegativeInt(input.popupRows), popupMaxHeight);
  const rows = budget;
  const width = todoRailWidth(cols);
  const reason = !input.panelEnabled ? 'disabled'
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
