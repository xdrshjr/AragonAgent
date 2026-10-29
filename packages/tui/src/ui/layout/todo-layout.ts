import { TODO_LIMITS } from '../../model/todo/limits.js';
import { derivePlanPhase } from '../../model/todo/acceptance.js';
import { buildPlanSections } from '../../model/todo/plan-sections.js';
import type { TodoSnapshot } from '../../model/todo/types.js';
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

export interface AcceptanceChipInput {
  snapshot: TodoSnapshot | null;
  /** Rows the rail (in-band or full-screen) actually drew; 0 means it drew none. */
  railRows: number;
  width: number;
}

/**
 * Does the acceptance count still need the status-bar chip
 * (todo-acceptance-criteria §6.11)?
 *
 * HERE, NEXT TO `buildTodoRailLayout`, because it answers the same question from
 * the same inputs: "what did the rail actually draw". Putting it in `App` - a
 * 3,215-line registered oversize file - would give one fact a second owner, which
 * is precisely what `scrollback/band.ts`'s "one number, one owner" rule exists to
 * prevent (P1-8 / C-9).
 *
 * THE RULE IS ABOUT THE RAIL, NOT ABOUT THE SECTION: while the section is `visible`
 * or `summary` the rail is already reporting the count, so a chip would repeat it in
 * the same glance (RV-P2-4). Only two situations leave the count unreported - no rail
 * at all, and the single `rows === 3 && footer` corner where the panel is up but the
 * section could not be fitted.
 */
export function acceptanceChip(
  input: AcceptanceChipInput,
): { checked: number; total: number; failed: number } | null {
  const acceptance = input.snapshot?.acceptance;
  if (!acceptance || acceptance.total === 0) return null;

  const chip = {
    checked: acceptance.checkedCount,
    total: acceptance.total,
    failed: acceptance.failedCount,
  };
  if (input.railRows <= 0) return chip;
  return acceptanceSectionOf(input) === 'absent' ? chip : null;
}

/**
 * Which rung the acceptance section reached in the rail, for `/perf`'s band line
 * (§6.9.6).
 *
 * `n/a` means "this plan has no criteria", which is a different fact from `absent`
 * ("the plan has criteria and the rail could not show them"). Both come from the
 * same `buildPlanSections` call the rail rendered with, so the readout cannot
 * disagree with the screen.
 */
export function acceptanceRung(
  input: AcceptanceChipInput,
): 'visible' | 'summary' | 'absent' | 'n/a' {
  const acceptance = input.snapshot?.acceptance;
  if (!acceptance || acceptance.total === 0) return 'n/a';
  // No rail drawn at all: the section is not on screen, and saying `absent` is the
  // one honest answer for that.
  if (input.railRows <= 0) return 'absent';
  return acceptanceSectionOf(input) ?? 'absent';
}

/**
 * The section's reason for a given rail, or `null` when the plan has no criteria.
 *
 * `showGauge` is assumed TRUE. That is the conservative direction for the ROW BUDGET -
 * it can only make the rail look shorter - and it cannot change the REASON at all: the
 * compact rung (rows < 6, where the real gauge is always off) ignores `available`
 * entirely, and the full rung spends the difference on item rows. So this readout can
 * never disagree with the rail about `visible` / `summary` / `absent`, and the chip
 * therefore never duplicates a count the rail is already showing (RV-P2-4).
 */
function acceptanceSectionOf(
  input: AcceptanceChipInput,
): 'visible' | 'summary' | 'absent' | null {
  const snapshot = input.snapshot;
  const acceptance = snapshot?.acceptance;
  if (!snapshot || !acceptance || acceptance.total === 0) return null;
  const sections = buildPlanSections({
    rows: input.railRows,
    width: input.width,
    phase: derivePlanPhase(snapshot.items, acceptance.items),
    todoCount: snapshot.items.length,
    acceptanceCount: acceptance.total,
    showGauge: true,
  });
  return sections.acceptance?.reason ?? null;
}
