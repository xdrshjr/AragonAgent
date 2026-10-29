/**
 * The legion panel's geometry: every decision `GovernancePanel` draws (governance-mode
 * section 10.3), made in pure code so it can be tested without a terminal.
 *
 * Pure and total: no Ink, no clock (`now` is injected), no I/O. ASCII ONLY.
 *
 * THE COMPONENT ONLY COLOURS AND PLACES. Tier, header, step strip, roster columns and
 * cell text, overflow line and ticker are all computed here; a test that wants to know
 * what the panel says at 80 columns asks this module and never renders.
 *
 * FOUR TIERS, chosen from the terminal's size alone (`selectTier`):
 *   full      >= 100 cols and >= 26 rows   header + step strip + roster (with gauge) + ticker
 *   standard  80-99 cols (rows >= 26)      the same without the activity column
 *   compact   60-79 cols, or rows < 26     header with the stage name + a bare roster
 *   minimal   < 60 cols or rows < 20       ONE line
 * and a tier that does not fit the caller's `availableRows` steps DOWN rather than
 * overflowing - the band clamps the panel's height, and a clipped last row is the one
 * outcome worse than a smaller tier.
 */

import type { GovernanceSnapshot, RosterRow } from '../../model/governance/types.js';
import { formatCost, formatDuration, formatTokens } from '../../model/agent/usage.js';
import type { Glyphs } from '../glyphs.js';
import {
  activeStepKey,
  isFinishedRun,
  isPausePending,
  isRetired,
  segment,
  shortRunId,
  signedDeltaText,
  sortRoster,
  teamTokens,
  workingCount,
  type EliminatedSince,
  type Segment,
} from '../governance-status.js';
import {
  GOV_TITLE,
  PANEL_BOARD_HINT,
  PANEL_HEALTH_LABEL,
  PANEL_LEDGER_LABEL,
  PANEL_TOKEN_UNIT,
  PIPELINE_LABEL,
  STATUS_WORD,
  moreText,
  phaseLongText,
  pausingText,
  phaseText,
  workingCountText,
} from '../governance-copy.js';
import { cellWidth, fitCells } from './cells.js';
import type { VoiceContext } from '../tool-voice.js';
import {
  PANEL_MARGIN_CELLS,
  buildRosterLine,
  columnPlan,
  markerCells,
  type PanelTier,
  type RosterColumn,
  type RosterLine,
} from './governance-roster.js';

export type { PanelTier } from './governance-roster.js';

export const PANEL_TIER_COLS = { full: 100, standard: 80, compact: 60 } as const;
export const PANEL_TIER_ROWS = { full: 26, minimal: 20 } as const;

/** Roster rows shown: `clamp(rows - 16, 2, 10)` (spec 10.3). */
export function maxRosterRows(rows: number): number {
  const free = Number.isFinite(rows) ? Math.floor(rows) - 16 : 0;
  return Math.min(10, Math.max(2, free));
}

/** The tier the terminal's size asks for, before any height budget is applied. */
export function selectTier(cols: number, rows: number): PanelTier {
  if (cols < PANEL_TIER_COLS.compact || rows < PANEL_TIER_ROWS.minimal) return 'minimal';
  if (rows < PANEL_TIER_ROWS.full || cols < PANEL_TIER_COLS.standard) return 'compact';
  return cols >= PANEL_TIER_COLS.full ? 'full' : 'standard';
}

const NEXT_SMALLER: Readonly<Record<PanelTier, PanelTier | null>> = {
  full: 'standard',
  standard: 'compact',
  compact: 'minimal',
  minimal: null,
};

/** One display line: a flexible left run and an optional right-anchored run. */
export interface PanelLine {
  left: Segment[];
  right: Segment[];
  /** Cells the right run occupies (0 when there is none). */
  rightCells: number;
}

export interface GovernancePanelInput {
  cols: number;
  rows: number;
  snapshot: GovernanceSnapshot | null;
  glyphs: Glyphs;
  reducedMotion: boolean;
  now: number;
  /** `panel` while a stage runs; `run-strip` between stages (header + step strip only). */
  mode?: 'panel' | 'run-strip';
  /** Height budget the caller can spare; tiers step down to fit. Default unlimited. */
  availableRows?: number;
  /** First-seen-eliminated phases, so a replaced member leaves after one phase. */
  eliminatedSince?: EliminatedSince;
  /**
   * Persona names and friendly wording. PASSING IT IS WHAT TURNS THE NAME COLUMN ON;
   * absent reproduces the pre-persona layout exactly (older tests rely on that).
   */
  voice?: VoiceContext;
}

export interface GovernancePanelLayout {
  tier: PanelTier;
  mode: 'panel' | 'run-strip';
  /** Terminal columns this layout was built for. */
  cols: number;
  /** `cols` minus the margin: the budget every line is planned against. */
  innerCols: number;
  height: number;
  header: PanelLine | null;
  pipeline: PanelLine | null;
  /** Width of the horizontal rule above and below the roster; 0 = no rules. */
  ruleCells: number;
  columns: RosterColumn[];
  rosterRows: RosterLine[];
  overflow: string | null;
  ticker: PanelLine[];
}

const EMPTY: GovernancePanelLayout = {
  tier: 'minimal',
  mode: 'panel',
  cols: 0,
  innerCols: 0,
  height: 0,
  header: null,
  pipeline: null,
  ruleCells: 0,
  columns: [],
  rosterRows: [],
  overflow: null,
  ticker: [],
};

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function segmentsCells(segments: readonly Segment[]): number {
  return segments.reduce((sum, part) => sum + cellWidth(part.text), 0);
}

function line(left: Segment[], right: Segment[] = []): PanelLine {
  return { left, right, rightCells: segmentsCells(right) };
}

const SEPARATOR = ' ';

/** The parts joined by the glyph tier's middle dot, the dot itself in `muted`. */
function joined(parts: readonly Segment[], glyphs: Glyphs): Segment[] {
  const out: Segment[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(segment(`${SEPARATOR}${glyphs.midDot}${SEPARATOR}`, 'muted'));
    out.push(part);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function stageWord(snapshot: GovernanceSnapshot): string {
  const key = activeStepKey(snapshot);
  return key === null ? '' : PIPELINE_LABEL[key];
}

function statusSegments(snapshot: GovernanceSnapshot): Segment[] {
  // A pending `/gov pause` outranks the plain status: the run is still executing, and the
  // one thing the user needs to see is that the stop is coming and nothing is killed.
  if (isPausePending(snapshot)) {
    return [segment(pausingText(stageWord(snapshot)), 'warn', true)];
  }
  if (snapshot.status === 'paused') return [segment(STATUS_WORD.paused, 'warn', true)];
  if (snapshot.status === 'escalated') return [segment(STATUS_WORD.escalated, 'warn', true)];
  return [];
}

/** The right-hand figures, most expendable last: cost, then tokens, then health. */
function headerFigures(snapshot: GovernanceSnapshot, withCost: boolean): Segment[][] {
  const figures: Segment[][] = [];
  if (snapshot.health !== null) {
    figures.push([
      segment(`${PANEL_HEALTH_LABEL} `, 'muted'),
      segment(String(Math.round(snapshot.health)), 'text', true),
    ]);
  }
  figures.push([segment(`${formatTokens(teamTokens(snapshot))} ${PANEL_TOKEN_UNIT}`, 'muted')]);
  if (withCost && snapshot.usage.costUsd !== null) {
    figures.push([segment(formatCost(snapshot.usage.costUsd), 'muted')]);
  }
  return figures;
}

function spaced(figures: readonly Segment[][]): Segment[] {
  const out: Segment[] = [];
  figures.forEach((figure, index) => {
    if (index > 0) out.push(segment('   ', 'muted'));
    out.push(...figure);
  });
  return out;
}

function buildHeader(
  snapshot: GovernanceSnapshot,
  inner: number,
  now: number,
  glyphs: Glyphs,
  withCost: boolean,
): PanelLine {
  const elapsed = formatDuration(Math.max(0, now - snapshot.startedAt));
  const parts: Segment[] = [
    segment(`run ${shortRunId(snapshot.runId)}`, 'muted'),
    segment(phaseLongText(snapshot.phase, snapshot.phaseCount), 'text'),
  ];
  // `pausing after REVIEW` already names the stage; saying it twice is noise on a short row.
  const stage = isPausePending(snapshot) ? '' : stageWord(snapshot);
  if (stage !== '') parts.push(segment(stage, 'primary', true));
  parts.push(segment(elapsed, 'muted'));
  const title = [segment(GOV_TITLE, 'govern', true), ...statusSegments(snapshot).flatMap((s) => [
    segment(' ', 'muted'),
    s,
  ])];
  const left = [...title, segment('  ', 'muted'), ...joined(parts, glyphs)];
  const figures = headerFigures(snapshot, withCost);
  while (figures.length > 0) {
    const right = spaced(figures);
    if (segmentsCells(left) + segmentsCells(right) + 2 <= inner) return line(left, right);
    figures.pop();
  }
  return line(left);
}

/** Compact header: the stage name replaces the step strip (spec 10.3). */
function buildCompactHeader(
  snapshot: GovernanceSnapshot,
  inner: number,
  now: number,
  glyphs: Glyphs,
): PanelLine {
  const parts: Segment[] = [segment(phaseText(snapshot.phase, snapshot.phaseCount), 'text')];
  const stage = isPausePending(snapshot) ? '' : stageWord(snapshot);
  if (stage !== '') parts.push(segment(stage, 'primary', true));
  parts.push(segment(formatDuration(Math.max(0, now - snapshot.startedAt)), 'muted'));
  const title = [segment(GOV_TITLE, 'govern', true), ...statusSegments(snapshot).flatMap((s) => [
    segment(' ', 'muted'),
    s,
  ])];
  const left = [...title, segment(' ', 'muted'), ...joined(parts, glyphs)];
  if (snapshot.health === null) return line(left);
  const right = [
    segment(`${PANEL_HEALTH_LABEL} `, 'muted'),
    segment(String(Math.round(snapshot.health)), 'text', true),
  ];
  return segmentsCells(left) + segmentsCells(right) + 2 <= inner ? line(left, right) : line(left);
}

// ---------------------------------------------------------------------------
// Step strip
// ---------------------------------------------------------------------------

function stepSegments(snapshot: GovernanceSnapshot, glyphs: Glyphs): Segment[][] {
  return snapshot.pipeline.map((step): Segment[] => {
    const label = PIPELINE_LABEL[step.key];
    if (step.state === 'done') {
      return [segment(label, 'ok'), segment(` ${glyphs.check}`, 'ok')];
    }
    if (step.state === 'active') return [segment(`${glyphs.cursor}${label}`, 'govern', true)];
    return [segment(label, 'muted')];
  });
}

function flattenSteps(steps: readonly Segment[][], glyphs: Glyphs, leadingGap: boolean): Segment[] {
  const out: Segment[] = leadingGap
    ? [segment(`${glyphs.ellipsis} ${glyphs.hrule} `, 'muted')]
    : [];
  steps.forEach((step, index) => {
    if (index > 0) out.push(segment(` ${glyphs.hrule} `, 'border'));
    out.push(...step);
  });
  return out;
}

/**
 * The step strip, with the rework note right-anchored. A strip too wide for the row loses
 * its OLDEST steps first (they are the ones already done), marked with a leading ellipsis,
 * so the current step and what is still to come always stay visible.
 */
function buildPipeline(
  snapshot: GovernanceSnapshot,
  inner: number,
  glyphs: Glyphs,
): PanelLine | null {
  const steps = stepSegments(snapshot, glyphs);
  if (steps.length === 0) return null;
  const note = snapshot.reworkNote === null ? [] : [segment(snapshot.reworkNote, 'warn')];
  const noteCells = segmentsCells(note);
  const activeIndex = Math.max(0, snapshot.pipeline.findIndex((s) => s.state === 'active'));
  for (const withNote of note.length > 0 ? [true, false] : [false]) {
    const budget = inner - (withNote ? noteCells + 2 : 0);
    for (let start = 0; start <= Math.min(activeIndex, steps.length - 1); start += 1) {
      const left = flattenSteps(steps.slice(start), glyphs, start > 0);
      if (segmentsCells(left) <= budget) return line(left, withNote ? note : []);
    }
  }
  return line(flattenSteps(steps.slice(activeIndex), glyphs, activeIndex > 0));
}

// ---------------------------------------------------------------------------
// Ticker
// ---------------------------------------------------------------------------

function tickerEntry(row: GovernanceSnapshot['recent'][number]): string {
  const amount = signedDeltaText(row.delta, row.provisional);
  return `${row.agentId} ${amount} ${row.code} ${row.reason}`.replace(/\s+/g, ' ').trim();
}

/**
 * The ledger ticker: the most recent entries, newest first, joined by a middle dot.
 *
 * An ALERT outranks it. A budget warning or an escalation is the one thing the panel
 * cannot afford to scroll past, and the row is already the panel's quiet last line.
 */
function buildTicker(snapshot: GovernanceSnapshot, inner: number, glyphs: Glyphs): PanelLine[] {
  const alert = snapshot.alerts[0];
  if (alert !== undefined) {
    const text = fitCells(`${glyphs.warn} ${alert}`, inner, glyphs.ellipsis);
    return [line([segment(text, 'warn')])];
  }
  if (snapshot.recent.length === 0) return [];
  const label = `${PANEL_LEDGER_LABEL}  `;
  const separator = `  ${glyphs.midDot}  `;
  const budget = Math.max(0, inner - cellWidth(label));
  let body = '';
  // Sorted by time here rather than trusting the producer's order: the ticker's whole
  // meaning is "newest first".
  for (const row of [...snapshot.recent].sort((a, b) => b.at - a.at)) {
    const next = body === '' ? tickerEntry(row) : `${body}${separator}${tickerEntry(row)}`;
    if (body !== '' && cellWidth(next) > budget) break;
    body = next;
  }
  const shown = fitCells(body, budget, glyphs.ellipsis);
  return [line([segment(label, 'muted'), segment(shown, 'text')])];
}

// ---------------------------------------------------------------------------
// Minimal tier
// ---------------------------------------------------------------------------

function minimalCandidates(snapshot: GovernanceSnapshot, glyphs: Glyphs): string[] {
  const status = isPausePending(snapshot)
    ? ` ${STATUS_WORD.pausing}`
    : snapshot.status === 'paused' || snapshot.status === 'escalated'
      ? ` ${STATUS_WORD[snapshot.status]}`
      : '';
  const stage = stageWord(snapshot);
  const base = `${GOV_TITLE}${status} ${phaseText(snapshot.phase, snapshot.phaseCount)}`;
  const staged = stage === '' ? base : `${base} ${stage}`;
  const dot = ` ${glyphs.midDot} `;
  const working = workingCountText(workingCount(snapshot));
  const health = snapshot.health === null
    ? ''
    : `${dot}${PANEL_HEALTH_LABEL} ${Math.round(snapshot.health)}`;
  return [
    `${staged}${dot}${working}${health}${dot}${PANEL_BOARD_HINT}`,
    `${staged}${dot}${working}${health}`,
    `${staged}${dot}${working}`,
    staged,
    base,
    GOV_TITLE,
  ];
}

function buildMinimal(snapshot: GovernanceSnapshot, inner: number, glyphs: Glyphs): PanelLine {
  const fits = (candidate: string): boolean => cellWidth(candidate) <= inner;
  const text = minimalCandidates(snapshot, glyphs).find(fits)
    ?? fitCells(GOV_TITLE, inner, glyphs.ellipsis);
  const split = text.indexOf(' ');
  const head = split < 0 ? text : text.slice(0, split);
  const rest = split < 0 ? '' : text.slice(split);
  return line([segment(head, 'govern', true), ...(rest === '' ? [] : [segment(rest, 'muted')])]);
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

interface RosterSelection {
  visible: RosterRow[];
  hidden: number;
}

function selectRoster(
  snapshot: GovernanceSnapshot,
  rows: number,
  since: EliminatedSince,
): RosterSelection {
  const present = sortRoster(snapshot.roster)
    .filter((row) => !isRetired(row, snapshot.phase, since));
  const cap = maxRosterRows(rows);
  if (present.length <= cap) return { visible: present, hidden: 0 };
  // One row of the cap is spent on the `+N more` line, so a hidden roster never makes
  // the panel taller than the budget `maxRosterRows` promised.
  const shown = Math.max(1, cap - 1);
  return { visible: present.slice(0, shown), hidden: present.length - shown };
}

function buildTier(input: GovernancePanelInput, tier: PanelTier): GovernancePanelLayout {
  const snapshot = input.snapshot!;
  const cols = nonNegativeInt(input.cols);
  const inner = Math.max(0, cols - PANEL_MARGIN_CELLS);
  const mode = input.mode ?? 'panel';
  const base = { ...EMPTY, tier, mode, cols, innerCols: inner };
  if (tier === 'minimal') {
    return { ...base, height: 1, header: buildMinimal(snapshot, inner, input.glyphs) };
  }
  const compact = tier === 'compact';
  const header = compact
    ? buildCompactHeader(snapshot, inner, input.now, input.glyphs)
    : buildHeader(snapshot, inner, input.now, input.glyphs, tier === 'full');
  const pipeline = compact ? null : buildPipeline(snapshot, inner, input.glyphs);
  if (mode === 'run-strip') {
    return { ...base, height: 1 + Number(pipeline !== null), header, pipeline };
  }
  const columns = columnPlan(tier, inner, markerCells(input.glyphs), input.voice !== undefined);
  const { visible, hidden } = selectRoster(snapshot, input.rows, input.eliminatedSince ?? {});
  const rosterRows = visible.map((row) => buildRosterLine({
    columns, row, glyphs: input.glyphs, now: input.now, reducedMotion: input.reducedMotion,
    ...(input.voice !== undefined ? { voice: input.voice } : {}),
  }));
  const ticker = compact ? [] : buildTicker(snapshot, inner, input.glyphs);
  const ruled = !compact && rosterRows.length > 0;
  const overflow = hidden > 0 ? fitCells(moreText(hidden), inner, input.glyphs.ellipsis) : null;
  const height = 1 + Number(pipeline !== null) + 2 * Number(ruled) + rosterRows.length
    + Number(overflow !== null) + ticker.length;
  return {
    ...base,
    height,
    header,
    pipeline,
    ruleCells: ruled ? inner : 0,
    columns,
    rosterRows,
    overflow,
    ticker,
  };
}

/**
 * Plan the panel for a terminal and a snapshot.
 *
 * `null` snapshot, or a finished run, plans to height 0 (nothing mounts - zero rows and
 * zero layout shift, the `TeamPanel` D-11 rule). The caller's `availableRows` is a
 * ceiling: tiers step down until one fits, and `minimal` is a single row or, with no row to
 * spare, nothing.
 */
export function buildGovernancePanelLayout(input: GovernancePanelInput): GovernancePanelLayout {
  if (input.snapshot === null || isFinishedRun(input.snapshot.status)) return EMPTY;
  const available = input.availableRows === undefined
    ? Infinity
    : nonNegativeInt(input.availableRows);
  let tier: PanelTier | null = selectTier(nonNegativeInt(input.cols), nonNegativeInt(input.rows));
  while (tier !== null) {
    const layout = buildTier(input, tier);
    if (layout.height <= available) return layout;
    tier = NEXT_SMALLER[tier];
  }
  return { ...EMPTY, cols: nonNegativeInt(input.cols) };
}
