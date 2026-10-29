/**
 * Panel row geometry — the ONE authority for how a subagent row is measured and
 * what it says (tui-subagent-panel §4.2 / §6.1).
 *
 * WHY THIS FILE EXISTS. The roster used to place its right-hand columns by
 * `flexGrow`, and a fixed-height parent box makes Yoga stretch the column to its
 * widest CHILD instead of to the available width: on a 100-column terminal inside
 * the band slot the row measured 48 (spec §0.1, cases 3/4), so `grep  22.1s` sat
 * hard against the description and the right half of the row was blank. Flex
 * cannot fix that, because the number it needs - "how wide is this terminal" - is
 * not part of the layout it is given. So the widths are COMPUTED here, by a total
 * pure function, and the component only places fixed-width boxes at the offsets
 * this module names.
 *
 * THE FIVE CELLS, in drawing order:
 *
 *     marker(1+status+1) label(8) description(flex) gap(2) activity(n) clock(8)
 *
 * `description` is the ONLY flexible cell, and it is the one that absorbs every
 * width pressure - the same degradation discipline `StatusBar` documents for its
 * left cluster. The two right-hand cells are fixed and `flexShrink={0}`, so their
 * absolute offsets follow from `rowWidth = parentWidth` and the sum of the fixed
 * cells in front of them, and never from how a particular frame allocates slack.
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts`'s static scan.
 *
 * THE ACTIVITY HELPERS LIVE HERE TOO (v2 implementation note, recorded in the
 * spec's "implementation findings"). `teamRowCells` has to compose the activity
 * text with the supervisor badge, which is what `activityWithBadge` already does;
 * leaving those in `TeamPanel.tsx` would make this module and the component
 * import each other. `TeamPanel` therefore RE-EXPORTS every symbol below, so the
 * existing import sites (three test files) keep their import path unchanged.
 */

import { describeToolActivity, sanitizeActivity } from '../../model/team/activity.js';
import { teamPhaseText, type VoiceContext } from '../tool-voice.js';
import { TEAM_LIMITS } from '../../model/team/limits.js';
import type { OverseerAction, SubagentRun } from '../../model/team/types.js';
import { formatDuration } from '../../model/agent/usage.js';
import type { Glyphs } from '../glyphs.js';
import { fitCells } from './cells.js';
import { childElapsedMs, childStatus, statusMarkerCell, statusMarkerWidth } from '../team-status.js';

/** The clock cell: wide enough for `125m07s` (7) with one column of headroom. */
export const TEAM_CLOCK_CELLS = 8;
/** `run.label.padEnd(8).slice(0,8)` — unchanged from the row this replaces. */
export const TEAM_LABEL_CELLS = 8;
/**
 * The persona-name cell: a name of at most `PERSONA_NAME_MAX_CHARS` (6) plus one
 * cell of air before the role. Only present when the caller asks for names.
 */
export const TEAM_NAME_CELLS = 7;
/** The role cell never shrinks below this before the name itself would give way. */
const MIN_ROLE_CELLS = 5;
/** The two spaces in front of the activity cell. */
export const TEAM_GAP_CELLS = 2;
/**
 * The description column's floor: below this the row is unreadable, so the
 * activity cell gives way instead (`activityDropCols`).
 */
export const TEAM_MIN_DESCRIPTION_CELLS = 12;

/**
 * The concession to code units vs terminal columns, inherited verbatim from the
 * `WIDE_CHAR_ALLOWANCE` comment on the row this replaces: this budget is
 * denominated in code units while the terminal is denominated in columns, and CJK
 * and emoji occupy two columns per unit, so the budget is halved against the
 * reserve rather than spent to the last cell. Erring small costs a few characters
 * of prose; erring large costs the clock column.
 */
const WIDE_CHAR_ALLOWANCE = 2;

/** The marker cell of the Unicode tier, used as the default by callers that pass no tier. */
const DEFAULT_MARKER_CELLS = 3;

export interface TeamRowGeometry {
  marker: number;
  /** Persona name cell; 0 unless the caller asked for names (`showName`). */
  name: number;
  label: number;
  gap: number;
  activity: number;
  clock: number;
  /** The description column's reserved MINIMUM; the real width comes from flex. */
  minDescription: number;
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * How many characters the activity cell may spend at this width.
 *
 * `TEAM_LIMITS.activityChars` is a STORAGE ceiling; a terminal has a COLUMN
 * budget, and the two are not the same number. Below
 * `TEAM_LIMITS.activityDropCols` the cell gives way ENTIRELY (returns 0) rather
 * than shrinking to its 12-character floor: at 40 columns those twelve characters
 * would push the description below its own floor, and "who is doing what" outranks
 * "what they are writing right now" exactly when there is room for one of them.
 * That is a semantic change to a shipped assertion (`activityBudget(40)` used to
 * return 12) and is recorded in the spec's §10 collateral table.
 *
 * `markerCells` defaults to the Unicode tier so the three existing single-argument
 * call sites keep compiling; the panel passes the real tier's width.
 */
export function activityBudget(
  cols: number,
  markerCells: number = DEFAULT_MARKER_CELLS,
  nameCells = 0,
): number {
  const dropCols = nameCells > 0
    ? TEAM_LIMITS.activityDropColsWithName
    : TEAM_LIMITS.activityDropCols;
  if (!Number.isFinite(cols) || cols < dropCols) return 0;
  const fixed = markerCells + nameCells + TEAM_LABEL_CELLS + TEAM_GAP_CELLS + TEAM_CLOCK_CELLS
    + TEAM_MIN_DESCRIPTION_CELLS;
  const spare = Math.floor((cols - fixed) / WIDE_CHAR_ALLOWANCE);
  return Math.max(TEAM_LIMITS.activityMinChars, Math.min(TEAM_LIMITS.activityChars, spare));
}

/**
 * The row's cell widths. A TOTAL function: every cell is a non-negative integer
 * and the five of them never sum past `cols`, for any `cols >= 0` and either
 * glyph tier (I-3, `team-row-geometry.test.ts`'s property test).
 *
 * THE LADDER IS THE SPECIFICATION (§4.2.2), in the order the cells give way:
 *   1. a wide enough terminal gets the business budget;
 *   2. below `activityDropCols` the activity cell is 0;
 *   3. description still negative -> the gap goes;
 *   4. still negative -> the label shrinks to `max(3, cols - marker - clock)`;
 *   5. still negative -> the clock shrinks (`cols < marker + 3 + clock`);
 *   6. the residue (a terminal narrower than the marker itself) is clamped so the
 *      sum stays inside `cols` — unreachable on a real device, where native mode
 *      degrades to the placeholder below 40x12, but the function is total because
 *      the property test runs `cols = 1..400`.
 *
 * WITH `showName` THE LADDER GAINS TWO RUNGS (persona names). A description floor
 * comes right after the activity drop: when the name cell leaves the description
 * under its 12-cell minimum, the gap goes and then the ROLE cell shrinks (never below
 * 5) - an ASCII marker is 6 wide, so 40 columns would otherwise leave 9. And the NAME
 * is the LAST thing to give way (a name is the row's identity), only in the
 * unreachable < 40 column region. `showName` defaults to false, which keeps every
 * pre-existing call byte-identical.
 */
export function teamRowGeometry(
  cols: number,
  glyphs: Glyphs,
  opts: { showName?: boolean } = {},
): TeamRowGeometry {
  const width = nonNegativeInt(cols);
  const markerCells = 1 + statusMarkerWidth(glyphs) + 1;
  const showName = opts.showName === true;
  const cells = {
    marker: Math.min(markerCells, width),
    name: showName ? Math.min(TEAM_NAME_CELLS, Math.max(0, width - markerCells)) : 0,
    label: TEAM_LABEL_CELLS,
    gap: TEAM_GAP_CELLS,
    activity: activityBudget(width, markerCells, showName ? TEAM_NAME_CELLS : 0),
    clock: TEAM_CLOCK_CELLS,
    minDescription: TEAM_MIN_DESCRIPTION_CELLS,
  };
  const sum = (): number =>
    cells.marker + cells.name + cells.label + cells.gap + cells.activity + cells.clock;

  if (showName && width - sum() < TEAM_MIN_DESCRIPTION_CELLS) {
    cells.gap = 0;
    const shortfall = TEAM_MIN_DESCRIPTION_CELLS - (width - sum());
    if (shortfall > 0) cells.label = Math.max(MIN_ROLE_CELLS, cells.label - shortfall);
  }
  if (sum() > width) cells.gap = 0;
  if (sum() > width) {
    cells.label = Math.max(3, width - cells.marker - cells.name - cells.clock);
  }
  if (sum() > width) {
    cells.clock = Math.max(0, Math.min(
      TEAM_CLOCK_CELLS, width - cells.marker - cells.name - cells.label,
    ));
  }
  if (sum() > width) cells.name = 0;
  if (sum() > width) cells.label = Math.max(0, Math.min(cells.label, width - cells.marker));

  cells.minDescription = sum() >= width ? 0 : TEAM_MIN_DESCRIPTION_CELLS;
  return cells;
}

/**
 * The clock cell's text: this child's elapsed time, or empty when it never
 * started (a `queued` row has no clock to show, and `0ms` would be a lie).
 */
export function teamClockText(run: SubagentRun, at: number): string {
  return run.startedAt === undefined ? '' : formatDuration(childElapsedMs(run, at));
}

/** The past-tense word the supervisor badge and status line render. */
export function interventionWord(action: OverseerAction): string {
  switch (action) {
    case 'nudge':
      return 'nudged';
    case 'replace':
      return 'replaced';
    case 'abandon':
      return 'abandoned';
    default:
      return 'waited';
  }
}

/**
 * The row's supervisor badge (subagent-overseer-v2 AC-5): what the supervisor
 * last did to THIS child and how long ago, e.g. `nudged 2m03s`.
 *
 * `lastIntervention.at` is ABSOLUTE epoch ms (R-P2-3), the same units as
 * `startedAt`, so this is one subtraction - no second clock convention.
 */
export function overseerBadge(run: SubagentRun, at: number): string {
  const last = run.lastIntervention;
  if (last === undefined) return '';
  return `${interventionWord(last.action)} ${formatDuration(Math.max(0, at - last.at))}`;
}

/**
 * The middle cell: what this child is doing right now, in a few words.
 *
 * Two width policies, answering different questions. `wide` decides WHICH FACT to
 * show - a whole path or its basename, a whole command line or its program name -
 * mirroring `StatusBar`'s `statusCompactCols` degradation rather than inventing a
 * second threshold. `activityBudget(cols)` decides HOW MUCH OF IT FITS, and it is
 * a continuous function of width rather than a threshold, because the failure it
 * prevents - a row wider than the terminal - is continuous.
 */
export function activityLine(
  run: SubagentRun,
  cols: number,
  markerCells?: number,
  voice?: VoiceContext,
  at?: number,
): string {
  const wide = cols >= TEAM_LIMITS.activityWideCols;
  // A voice means the caller drew a persona-name cell, which narrows this budget too.
  const budget = activityBudget(cols, markerCells, voice === undefined ? 0 : TEAM_NAME_CELLS);
  // FRIENDLY WORDING for the five LIVE phases only. `done` / `failed` / `aborted`
  // fall through to the plain text below in BOTH modes: an outcome is never played
  // for laughs, and the words are depended on by tests and by muscle memory.
  if (voice !== undefined && voice.mode === 'friendly' && isLivePhase(run.phase)) {
    return teamPhaseText(
      run,
      { budget, wide, at: at ?? run.startedAt ?? 0, ellipsis: '...' },
      voice,
    );
  }
  switch (run.phase) {
    case 'queued':
      return 'queued';
    case 'starting':
      // The one row that legitimately restarts its clock, saying why (P2-4):
      // F-2 ranks the running group by `startedAt` and a retry re-stamps it.
      return run.retries ? 'starting (retry)' : 'starting';
    case 'thinking':
      // Clamped AT RENDER, against this terminal's budget. `run.activity` was
      // clamped at STORE against `activityChars`; that is a ceiling, not a fit.
      return run.activity ? `writing: ${sanitizeActivity(run.activity, budget)}` : 'thinking';
    case 'tool':
    case 'waiting':
      return run.lastTool
        ? sanitizeActivity(describeToolActivity(run.lastTool, run.activityArgs, wide), budget)
        : run.phase === 'waiting'
          ? 'waiting for mail'
          : 'tool';
    case 'done':
      // `compacted N` ON THE SETTLED ROW ONLY (hardening §3.4.4 / W3). A running
      // row is already competing for `activityBudget(cols)` with the child's own
      // prose, and a marker that displaces what the child is DOING right now
      // buys nothing - the dispatch report carries the same fact for good.
      return run.compactions
        ? `done  ${run.turns} turns  compacted ${run.compactions}`
        : `done  ${run.turns} turns`;
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'aborted';
  }
}

function isLivePhase(phase: SubagentRun['phase']): boolean {
  return phase !== 'done' && phase !== 'failed' && phase !== 'aborted';
}

/**
 * The activity cell WITH the badge composed in (AC-5 / risk table): the badge
 * rides the SAME allocation the prose uses, so a row can never grow past its
 * terminal; on a narrow terminal the badge degrades to the action word alone -
 * the who-acted fact outranks the what-they-are-doing tail exactly when there is
 * room for only one.
 */
export function activityWithBadge(
  run: SubagentRun,
  cols: number,
  at: number,
  markerCells?: number,
  voice?: VoiceContext,
): string {
  const last = run.lastIntervention;
  if (last === undefined) return activityLine(run, cols, markerCells, voice, at);
  const badge = overseerBadge(run, at);
  if (cols < TEAM_LIMITS.activityWideCols) return interventionWord(last.action);
  return sanitizeActivity(
    `${badge}; ${activityLine(run, cols, markerCells, voice, at)}`,
    activityBudget(cols, markerCells, voice === undefined ? 0 : TEAM_NAME_CELLS),
  );
}

/** The five text fragments of one row, each already clamped to its cell's policy. */
export interface TeamRowCells {
  marker: string;
  /** The persona name, clamped to its cell; `''` when the row carries no name. */
  name: string;
  label: string;
  description: string;
  activity: string;
  clock: string;
}

/**
 * The five text fragments of one row.
 *
 * The description is normalized here rather than in the component because
 * truncation preserves explicit newlines and the band reserves exactly ONE row
 * for a child: a description carrying a newline would make the row two rows tall
 * and every row below it would land one row lower than `band.teamRows` allows.
 */
export function teamRowCells(
  run: SubagentRun,
  cols: number,
  at: number,
  glyphs: Glyphs,
  voice?: VoiceContext,
): TeamRowCells {
  // PASSING A VOICE IS WHAT TURNS THE NAME CELL ON. Omitting it reproduces the
  // pre-persona row exactly, which the older geometry tests rely on.
  const geometry = teamRowGeometry(cols, glyphs, { showName: voice !== undefined });
  // THE TEXT IS CLAMPED TO THE SAME WIDTH THE GEOMETRY ALLOCATED, so a cell's content
  // measures no more than its box. `activityWithBadge` already clamps to the business
  // budget; this is the belt-and-braces that also covers the two cases the budget alone
  // cannot express - a ZERO-width cell (below `activityDropCols`, where the answer is
  // "no activity column at all", not "a nine-character word in a zero-column box") and
  // a wide character straddling the edge.
  const activity = geometry.activity === 0
    ? ''
    : fitCells(
      activityWithBadge(run, cols, at, geometry.marker, voice),
      geometry.activity,
      glyphs.ellipsis,
    );
  return {
    marker: statusMarkerCell(childStatus(run), glyphs),
    name: voice === undefined || geometry.name === 0
      ? ''
      : fitCells(voice.nameOf(run.label), geometry.name, glyphs.ellipsis),
    label: run.label.padEnd(TEAM_LABEL_CELLS).slice(0, TEAM_LABEL_CELLS),
    description: run.description.replace(/\s+/g, ' '),
    activity,
    clock: teamClockText(run, at),
  };
}
