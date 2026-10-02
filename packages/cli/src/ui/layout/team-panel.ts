import { TEAM_LIMITS } from '../../team/limits.js';
import { selectPanelRows } from '../../team/panel-rows.js';
import type { SubagentRun, TeamSnapshot } from '../../team/types.js';
import { TODO_LIMITS } from '../../todo/limits.js';

export interface TeamPanelLayout {
  collapsed: boolean;
  rowCount: number;
  visible: SubagentRun[];
  hiddenTotal: number;
  hiddenRunning: number;
}

export interface TeamPanelLayoutInput {
  snapshot: TeamSnapshot | null;
  terminalRows: number;
  availableRows: number;
}

/** Project actual roster rows, preserving three middle rows when expanded.
 * Invalid geometry becomes zero; legacy callers may pass positive Infinity
 * for an unlimited available-row budget. Does not throw or mutate the snapshot.
 */
export function buildTeamPanelLayout(input: TeamPanelLayoutInput): TeamPanelLayout {
  const available = input.availableRows === Infinity ? Infinity : nonNegativeInt(input.availableRows);
  if (!input.snapshot || available < 1) {
    return { collapsed: true, rowCount: 0, visible: [], hiddenTotal: 0, hiddenRunning: 0 };
  }
  const selection = selectPanelRows(input.snapshot.runs, TEAM_LIMITS.panelMaxRows);
  const natural = 1 + selection.visible.length + Number(selection.hiddenTotal > 0)
    + Number(Boolean(input.snapshot.lastMessage));
  const collapsed = nonNegativeInt(input.terminalRows) < TEAM_LIMITS.panelCollapseRows
    || available - natural < TODO_LIMITS.panelMinRows;
  return { ...selection, collapsed, rowCount: collapsed ? 1 : natural };
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
