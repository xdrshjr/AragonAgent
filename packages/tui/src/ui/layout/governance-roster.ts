/**
 * Roster geometry and cell text for the legion panel (governance-mode section 10.3).
 *
 * Pure and total: no Ink, no clock, no terminal. ASCII ONLY.
 *
 * WHY COMPUTED FIXED-WIDTH COLUMNS. Same lesson as `team-row.ts`, whose header records
 * it at length: a fixed-height parent makes Yoga size a flex column to its widest CHILD,
 * so a row placed by `flexGrow` stops short of the terminal and the cells to its right
 * lose their absolute offsets. Every column below therefore has a COMPUTED integer width
 * and exactly ONE column is elastic; it sits between the fixed cluster on its left and
 * the fixed `delta` cell on its right, so the score change always lands in the row's
 * last column whatever the activity text says.
 *
 * `columnPlan` is TOTAL: for any width (including 0 and 400) the widths never sum past
 * the width it was given. `governance-panel-layout.test.ts` runs it for every width.
 */

import type { RosterRow } from '../../model/governance/types.js';
import type { Glyphs } from '../glyphs.js';
import { statusMarkerCell, statusMarkerWidth } from '../team-status.js';
import {
  GAUGE_CELLS,
  deltaCell,
  gaugeFilledCells,
  govChildStatus,
  labelTag,
  scoreText,
  scoreToneKey,
  segment,
  statusTone,
  type Segment,
  type Tone,
} from '../governance-status.js';
import {
  NOT_SCORED,
  ROLE_LABEL,
  STATE_WORD,
  WORKING_VERB,
  replacedByText,
} from '../governance-copy.js';
import { cellWidth, fitCells } from './cells.js';
import { DEVELOPER_VOICE, friendlyActivity, type VoiceContext } from '../tool-voice.js';
import { PERSONA_NAME_MAX_CHARS } from '../persona-names.js';

export type PanelTier = 'full' | 'standard' | 'compact' | 'minimal';

export type RosterColumnKey =
  | 'marker'
  | 'name'
  | 'id'
  | 'role'
  | 'state'
  | 'gauge'
  | 'score'
  | 'prov'
  | 'tag'
  | 'wp'
  | 'activity'
  | 'delta'
  | 'note';

export interface RosterColumn {
  key: RosterColumnKey;
  /** Final integer width in terminal columns (the elastic column's is what is left). */
  width: number;
  elastic: boolean;
  align: 'left' | 'right';
}

interface ColumnSpec {
  key: RosterColumnKey;
  width: number;
  elastic?: true;
  align?: 'right';
  /** Higher drops first when the row cannot fit; absent = never dropped. */
  drop?: number;
}

/** The elastic column keeps at least this many columns, else it is dropped (activity) or kept (wp). */
const ELASTIC_MIN_CELLS = { activity: 12, wp: 6 } as const;

/** One leading margin column, drawn by the component. */
export const PANEL_MARGIN_CELLS = 1;

/** Persona name cell: a name of up to `PERSONA_NAME_MAX_CHARS` plus one cell of air. */
const NAME_CELLS = PERSONA_NAME_MAX_CHARS + 1;
/**
 * `id` rank when names are shown: it is the FIRST cell to give way (above `tag`'s 6),
 * because the name and role already carry identity and the engine id stays in
 * `/gov board`. Never dropped (no rank) without names, keeping the baseline layout.
 */
const ID_DROP_WITH_NAME = 7;

function columnSpecs(tier: PanelTier, markerCells: number, showName: boolean): ColumnSpec[] {
  const marker: ColumnSpec = { key: 'marker', width: markerCells };
  const delta: ColumnSpec = { key: 'delta', width: 7, align: 'right', drop: 2 };
  // NAME NEVER DROPS (no `drop`): it is the row's identity, so it is the last thing to go.
  const name: ColumnSpec[] = showName ? [{ key: 'name', width: NAME_CELLS }] : [];
  const id: ColumnSpec = showName
    ? { key: 'id', width: 8, drop: ID_DROP_WITH_NAME }
    : { key: 'id', width: 8 };
  const role: ColumnSpec = { key: 'role', width: 6, drop: 3 };
  // With names the role reads straight after the name (`Wren  DEV  dev1-r1`).
  const identity: ColumnSpec[] = showName ? [...name, role, id] : [id, role];
  switch (tier) {
    case 'full':
      return [
        marker,
        ...identity,
        { key: 'state', width: 12 },
        { key: 'gauge', width: GAUGE_CELLS + 1, drop: 5 },
        { key: 'score', width: 5, align: 'right' },
        { key: 'prov', width: 7, drop: 4 },
        { key: 'tag', width: 8, drop: 6 },
        { key: 'wp', width: 11 },
        { key: 'activity', width: 0, elastic: true },
        delta,
      ];
    case 'standard':
      return [
        marker,
        ...identity,
        { key: 'state', width: 12 },
        { key: 'gauge', width: GAUGE_CELLS + 1, drop: 5 },
        { key: 'score', width: 5, align: 'right' },
        { key: 'prov', width: 7, drop: 4 },
        { key: 'tag', width: 8, drop: 6 },
        { key: 'wp', width: 0, elastic: true },
        delta,
      ];
    default:
      return [
        marker,
        ...name,
        id,
        { key: 'state', width: 12, drop: 3 },
        { key: 'score', width: 5, align: 'right' },
        { key: 'wp', width: 0, elastic: true },
        delta,
      ];
  }
}

function fixedSum(specs: readonly ColumnSpec[]): number {
  return specs.reduce((sum, spec) => sum + (spec.elastic ? 0 : spec.width), 0);
}

/** The column that gives way first: the highest `drop` rank, or -1 when none can. */
function dropVictim(specs: readonly ColumnSpec[]): number {
  let victim = -1;
  let rank = 0;
  specs.forEach((spec, index) => {
    if (spec.drop !== undefined && spec.drop > rank) {
      rank = spec.drop;
      victim = index;
    }
  });
  return victim;
}

/** Last-resort squeeze so the sum NEVER exceeds `inner`, from the right edge inward. */
function squeeze(columns: RosterColumn[], inner: number): void {
  let over = columns.reduce((sum, column) => sum + column.width, 0) - inner;
  for (let index = columns.length - 1; index >= 0 && over > 0; index -= 1) {
    const column = columns[index]!;
    const cut = Math.min(column.width, over);
    column.width -= cut;
    over -= cut;
  }
}

/**
 * Give the activity column up and make the work-package cell the elastic one, which turns
 * a `full` row into a `standard` one without losing the single-elastic-column invariant.
 */
function promoteWorkPackage(specs: readonly ColumnSpec[]): ColumnSpec[] {
  return specs
    .filter((spec) => spec.key !== 'activity')
    .map((spec): ColumnSpec => (spec.key === 'wp' ? { key: 'wp', width: 0, elastic: true } : spec));
}

/**
 * The row's columns for a tier at `inner` columns (the terminal width minus the margin).
 *
 * THE DROP LADDER IS THE SPECIFICATION, in the order the cells give way: the activity
 * text first (the only column whose loss costs nothing structural - the work-package cell
 * becomes the elastic one), then the tag, gauge, provisional, role and delta cells. The
 * elastic column keeps at least its floor; when even the fixed cluster does not fit,
 * `squeeze` trims from the right so the sum stays inside `inner` for any input.
 */
export function columnPlan(
  tier: PanelTier,
  inner: number,
  markerCells: number,
  showName = false,
): RosterColumn[] {
  const width = Number.isFinite(inner) ? Math.max(0, Math.floor(inner)) : 0;
  let specs = columnSpecs(tier, markerCells, showName);
  const floorOf = (spec: ColumnSpec | undefined): number =>
    spec?.key === 'activity' ? ELASTIC_MIN_CELLS.activity : ELASTIC_MIN_CELLS.wp;
  for (;;) {
    const elastic = specs.find((spec) => spec.elastic === true);
    if (fixedSum(specs) + floorOf(elastic) <= width) break;
    if (elastic?.key === 'activity') {
      specs = promoteWorkPackage(specs);
      continue;
    }
    const victim = dropVictim(specs);
    if (victim < 0) break;
    specs = specs.filter((_, index) => index !== victim);
  }
  const remaining = Math.max(0, width - fixedSum(specs));
  const columns: RosterColumn[] = specs.map((spec) => ({
    key: spec.key,
    width: spec.elastic ? remaining : spec.width,
    elastic: spec.elastic === true,
    align: spec.align ?? 'left',
  }));
  squeeze(columns, width);
  return columns;
}

export function columnsWidth(columns: readonly RosterColumn[]): number {
  return columns.reduce((sum, column) => sum + column.width, 0);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export interface RosterCell {
  key: RosterColumnKey;
  width: number;
  elastic: boolean;
  align: 'left' | 'right';
  segments: Segment[];
}

export interface RosterLine {
  /** `row.id`; stable across snapshots so React keys do not churn. */
  key: string;
  kind: 'agent' | 'eliminated';
  cells: RosterCell[];
}

const BLANK_TONE: Tone = 'muted';

function textCell(
  column: RosterColumn,
  text: string,
  tone: Tone,
  ellipsis: string,
  bold = false,
): RosterCell {
  const clipped = column.width === 0 ? '' : fitCells(text, column.width, ellipsis);
  return {
    key: column.key,
    width: column.width,
    elastic: column.elastic,
    align: column.align,
    segments: clipped === '' ? [] : [segment(clipped, tone, bold)],
  };
}

function leading(text: string): string {
  return text === '' ? '' : ` ${text}`;
}

/** `not scored` replaces the gauge for the inspector (spec 5.1: never scored). */
function gaugeCell(column: RosterColumn, row: RosterRow, glyphs: Glyphs): RosterCell {
  if (row.confirmed === null) return textCell(column, NOT_SCORED, 'muted', glyphs.ellipsis);
  const filled = gaugeFilledCells(row.confirmed);
  const bar: Segment[] = [
    segment(glyphs.gaugeFull.repeat(filled), scoreToneKey(row.label)),
    segment(glyphs.gaugeEmpty.repeat(GAUGE_CELLS - filled), 'border'),
  ].filter((part) => part.text !== '');
  return {
    key: column.key,
    width: column.width,
    elastic: false,
    align: 'left',
    segments: bar,
  };
}

function stateText(row: RosterRow): string {
  return row.state === 'working' ? WORKING_VERB[row.role] : STATE_WORD[row.state];
}

function rightAligned(column: RosterColumn, text: string): string {
  return ' '.repeat(Math.max(0, column.width - cellWidth(text))) + text;
}

interface CellContext {
  glyphs: Glyphs;
  now: number;
  reducedMotion: boolean;
  voice: VoiceContext;
}

type CellBuilder = (column: RosterColumn, row: RosterRow, ctx: CellContext) => RosterCell;

/** Mirrors `activityWideCols`'s intent: full paths only when the cell can hold them. */
const WIDE_ACTIVITY_CELLS = 40;

/**
 * The activity words. DEVELOPER voice (or a snapshot with no structured fields) prints the
 * legacy string untouched. FRIENDLY voice NEVER prints it: in the `thinking` phase that
 * string is the previous tool's raw id, and in a terminal phase it is the last one.
 */
function activityText(row: RosterRow, column: RosterColumn, ctx: CellContext): string {
  if (ctx.voice.mode !== 'friendly' || row.activityPhase === undefined) {
    return row.activity.replace(/\s+/g, ' ').trim();
  }
  return friendlyActivity(
    {
      phase: row.activityPhase,
      tool: row.activityTool,
      args: row.activityArgs,
      text: row.activityText,
      calls: row.activityCalls ?? 0,
    },
    {
      seed: row.id,
      budget: Math.max(0, column.width - 1),
      wide: column.width >= WIDE_ACTIVITY_CELLS,
      at: ctx.now,
      ellipsis: ctx.glyphs.ellipsis,
    },
    ctx.voice,
  );
}

function scoreCell(column: RosterColumn, row: RosterRow, ctx: CellContext): RosterCell {
  const ell = ctx.glyphs.ellipsis;
  if (row.confirmed === null) return textCell(column, '', BLANK_TONE, ell);
  const text = rightAligned(column, scoreText(row.confirmed));
  return textCell(column, text, scoreToneKey(row.label), ell);
}

function deltaColumnCell(column: RosterColumn, row: RosterRow, ctx: CellContext): RosterCell {
  const delta = deltaCell(row, ctx.now, ctx.reducedMotion);
  const text = delta.text === '' ? '' : rightAligned(column, delta.text);
  return textCell(column, text, delta.tone, ctx.glyphs.ellipsis, delta.bold);
}

/** One builder per column: a table, so adding a column cannot raise a function's complexity. */
const CELL_BUILDERS: Readonly<Record<RosterColumnKey, CellBuilder>> = {
  marker: (column, row, ctx) => {
    const status = govChildStatus(row.state);
    const text = ` ${statusMarkerCell(status, ctx.glyphs)} `;
    return textCell(column, text, statusTone(status), ctx.glyphs.ellipsis);
  },
  name: (column, row, ctx) =>
    textCell(column, ctx.voice.nameOf(row.id), 'primary', ctx.glyphs.ellipsis, true),
  id: (column, row, ctx) => textCell(column, row.id, 'primary', ctx.glyphs.ellipsis),
  role: (column, row, ctx) => textCell(column, ROLE_LABEL[row.role], 'muted', ctx.glyphs.ellipsis),
  state: (column, row, ctx) => {
    const tone = statusTone(govChildStatus(row.state));
    return textCell(column, stateText(row), tone, ctx.glyphs.ellipsis);
  },
  gauge: (column, row, ctx) => gaugeCell(column, row, ctx.glyphs),
  score: scoreCell,
  prov: (column, row, ctx) => {
    const text = row.provisional > 0 ? leading(`+${row.provisional}P`) : '';
    return textCell(column, text, 'muted', ctx.glyphs.ellipsis);
  },
  tag: (column, row, ctx) => {
    const text = leading(labelTag(row.label));
    return textCell(column, text, scoreToneKey(row.label), ctx.glyphs.ellipsis, true);
  },
  wp: (column, row, ctx) => textCell(column, leading(row.wpId ?? '-'), 'text', ctx.glyphs.ellipsis),
  activity: (column, row, ctx) => {
    const text = leading(activityText(row, column, ctx));
    return textCell(column, text, 'muted', ctx.glyphs.ellipsis);
  },
  delta: deltaColumnCell,
  note: (column, _row, ctx) => textCell(column, '', BLANK_TONE, ctx.glyphs.ellipsis),
};

function cellFor(column: RosterColumn, row: RosterRow, ctx: CellContext): RosterCell {
  return CELL_BUILDERS[column.key](column, row, ctx);
}

/** Columns a replaced member's one-line note spans. */
const NOTE_SPAN: ReadonlySet<RosterColumnKey> = new Set(['state', 'gauge', 'score', 'prov', 'tag']);

/**
 * A replaced member: marker, id and role stay (so the row is recognisable), and one
 * muted note spans the state-through-tag cells. The note NAMES the successor, which is the
 * information the member's vanishing from the panel next phase would otherwise erase.
 */
function eliminatedCells(
  columns: readonly RosterColumn[],
  row: RosterRow,
  ctx: CellContext,
): RosterCell[] {
  const cells: RosterCell[] = [];
  let spanned = 0;
  let spanColumn: RosterColumn | null = null;
  const flush = (): void => {
    if (spanColumn === null) return;
    const merged: RosterColumn = { ...spanColumn, key: 'note', width: spanned, align: 'left' };
    const text = ` ${replacedByText(row.replacedBy, ctx.voice.nameOf)}`;
    cells.push(textCell(merged, text, 'muted', ctx.glyphs.ellipsis));
    spanColumn = null;
    spanned = 0;
  };
  for (const column of columns) {
    if (NOTE_SPAN.has(column.key)) {
      spanColumn ??= column;
      spanned += column.width;
      continue;
    }
    flush();
    const cell = cellFor(column, row, ctx);
    const quiet = column.key === 'id' || column.key === 'role' || column.key === 'marker'
      || column.key === 'name';
    cells.push(quiet ? mute(cell) : blank(cell));
  }
  flush();
  return cells;
}

function mute(cell: RosterCell): RosterCell {
  return { ...cell, segments: cell.segments.map((part): Segment => ({ ...part, tone: 'muted' })) };
}

function blank(cell: RosterCell): RosterCell {
  return { ...cell, segments: [] };
}

export interface RosterLineInput {
  columns: readonly RosterColumn[];
  row: RosterRow;
  glyphs: Glyphs;
  now: number;
  reducedMotion: boolean;
  /** Absent = developer wording and no name text (the baseline). */
  voice?: VoiceContext;
}

/** One roster row's cells, text already clamped to its cell. */
export function buildRosterLine(input: RosterLineInput): RosterLine {
  const { columns, row, glyphs, now, reducedMotion } = input;
  const ctx: CellContext = { glyphs, now, reducedMotion, voice: input.voice ?? DEVELOPER_VOICE };
  if (row.state === 'eliminated') {
    return { key: row.id, kind: 'eliminated', cells: eliminatedCells(columns, row, ctx) };
  }
  return { key: row.id, kind: 'agent', cells: columns.map((column) => cellFor(column, row, ctx)) };
}

/** The marker cell's width in the current glyph tier: 1 + widest marker + 1. */
export function markerCells(glyphs: Glyphs): number {
  return 1 + statusMarkerWidth(glyphs) + 1;
}
