/**
 * The Agents board's row model — pure projection, no Ink (tui-subagent-panel §4.4 / §7).
 *
 * WHY A PURE MODULE AND NOT JSX. The board's whole value is that it shows EVERY fact
 * about every child, and the two things that can go wrong with that are both
 * properties of a list: a row wider than the overlay (which silently desynchronises
 * `OverlayFrame`'s position indicator) and a row count that grows without a bound.
 * Both are assertable here, against plain strings, without a terminal - which is the
 * same reason `layout/team-panel.ts` and `layout/budget.ts` are separate modules.
 *
 * LIVE-ONLY RULE (§4.4.2, RV-P0-2). The board has two sources with DIFFERENT fields:
 * a live `TeamSnapshot` (has `messageCount`, `startedAt`, the activity prose and the
 * timeline) and a settled `kind: 'team'` entry (has `durationMs` and the runs, and
 * nothing else - `agent/reducer.ts`'s entry member carries no `messageCount` and no
 * `startedAt`). A section whose source is missing is OMITTED, never filled with a
 * zero: `mail 0` would be a lie, and an empty section title tells the reader nothing.
 * The one section that survives both sources is `result` (`summary` / `error` is
 * never stripped), which is precisely the fact a user opens the board to find.
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts`'s static scan, so every symbol
 * (the ellipsis, the separator, the cursor) arrives through `glyphs`.
 */

import type { Entry } from '../../model/agent/reducer.js';
import { TEAM_LIMITS } from '../../model/team/limits.js';
import type { SubagentRun, TeamSnapshot } from '../../model/team/types.js';
import type { Glyphs } from '../glyphs.js';
import {
  childStatus,
  lastTeamEntry,
  rosterCounts,
  rosterHeadline,
  statusMarkerCell,
} from '../team-status.js';
import { formatDuration, formatTokens } from '../../model/agent/usage.js';
import { sanitizeActivity } from '../../model/team/activity.js';
import { activityWithBadge, teamRowGeometry } from './team-row.js';
import { bindVoiceScope, toolPhrase, type VoiceContext } from '../tool-voice.js';
import { alignRightCells, fitCells, padCells, wrapCells } from './cells.js';

export type BoardRowKind = 'summary' | 'blank' | 'section' | 'child' | 'field' | 'event' | 'hint';

/** Which palette slot a row draws with. Mapped to `Theme` one level up, in the component. */
export type BoardTone = 'accent' | 'primary' | 'muted' | 'warn' | 'error' | 'done' | 'hint';

export interface BoardRow {
  /** React key: stable and unique (`kind:subject:index`). */
  key: string;
  kind: BoardRowKind;
  /** One already-folded line, safe to hand to `<Text wrap="truncate">`. */
  text: string;
  tone: BoardTone;
  selected?: boolean;
}

export interface BoardSource {
  dispatchId: string;
  active: boolean;
  /**
   * When the dispatch started. **A settled `team` entry has no such field**
   * (`agent/reducer.ts`'s entry member), so it is optional: with no `startedAt` the
   * summary shows `durationMs` alone rather than inventing an absolute instant.
   */
  startedAt?: number;
  endedAt?: number;
  requested: number;
  runs: readonly SubagentRun[];
  /**
   * Team-mail count. Live snapshots carry it; a settled entry does **not** - absent
   * means the clause is omitted rather than rendered as `mail 0` (RV-P0-2).
   */
  messageCount?: number;
  /** A settled entry's own total (`teamEnd` writes it). */
  durationMs?: number;
}

/**
 * The board's single source shape, resolved in ONE place.
 *
 * PRIORITY: live snapshot > (the component's frozen copy) > the most recent settled
 * entry. This function answers the first and the third; the frozen copy belongs to
 * the component because it only exists while a dispatch is being read (§4.4.5).
 */
export function resolveBoardSource(input: {
  team: TeamSnapshot | null;
  entries: readonly Entry[];
}): BoardSource | null {
  const { team } = input;
  if (team !== null) {
    return {
      dispatchId: team.dispatchId,
      active: team.active,
      startedAt: team.startedAt,
      requested: team.requested,
      runs: team.runs,
      messageCount: team.messageCount,
    };
  }
  const entry = lastTeamEntry(input.entries);
  if (entry === null) return null;
  return {
    dispatchId: entry.dispatchId,
    active: entry.active === true,
    requested: entry.requested,
    runs: entry.runs,
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
  };
}

/**
 * The child the board is showing, resolved from its LABEL every frame (D-8).
 *
 * Labels are the only stable handle: `panel-rows.ts` re-sorts the roster by phase, so
 * an index would silently jump to a different child the moment one of them settles.
 * Fallback order is "the first running child, else the first child", which is the
 * one a reader opening the board mid-dispatch wants.
 */
export function resolveSelection(
  runs: readonly SubagentRun[],
  label: string | null,
): SubagentRun | null {
  const named = label === null ? undefined : runs.find((run) => run.label === label);
  if (named !== undefined) return named;
  return runs.find((run) => childStatus(run) === 'running') ?? runs[0] ?? null;
}

/** Fixed label column of a `field` row, and the value column of its wide form. */
const FIELD_LABEL_CELLS = 11;
const FIELD_WIDE_VALUE_CELLS = 23;
/** Rows of prose a `now` / `result` section may spend. */
const NOW_MAX_ROWS = 6;
const RESULT_MAX_ROWS = 12;
/** Board width at which the field rows go 2-up, and the narrowest width that pads. */
const BOARD_WIDE_COLS = 110;
const BOARD_INLINE_COLS = 40;

export interface AgentBoardInput {
  source: BoardSource;
  /** Overlay content width. */
  cols: number;
  now: number;
  selectedLabel: string | null;
  glyphs: Glyphs;
  native: boolean;
  /**
   * Names the children and words the timeline. REQUIRED (D-15): a forgotten call site
   * is a compile error rather than a board that silently shows no names.
   */
  voice: VoiceContext;
}

/**
 * The board's rows, in the order a reader wants them: what the dispatch did, then who
 * is in it, then everything about the selected child, then its history.
 *
 * Bounded by `TEAM_LIMITS.boardMaxRows`, and the truncation is ANNOUNCED rather than
 * silent - a list that stops mid-fact with no notice reads as a rendering bug.
 */
export function buildAgentBoardRows(rawInput: AgentBoardInput): BoardRow[] {
  // NAMES ARE RESOLVED IN THE SOURCE'S OWN SCOPE: a settled dispatch is shown after
  // `state.team` is gone, so only the source knows which dispatch it was.
  const input: AgentBoardInput = {
    ...rawInput,
    voice: bindVoiceScope(rawInput.voice, rawInput.source.dispatchId),
  };
  const { source, glyphs } = input;
  const cols = normalizeCols(input.cols);
  const rows: BoardRow[] = [];
  const selected = resolveSelection(source.runs, input.selectedLabel);

  appendSummary(rows, input, selected);
  appendChildren(rows, input, selected, cols);
  if (selected !== null) {
    appendFacts(rows, input, selected, cols);
    appendProse(rows, input, selected, cols);
    appendTimeline(rows, input, selected, cols);
  }
  if (rows.length > TEAM_LIMITS.boardMaxRows) {
    const kept = rows.slice(0, TEAM_LIMITS.boardMaxRows);
    const dropped = rows.length - TEAM_LIMITS.boardMaxRows;
    kept[kept.length - 1] = {
      key: 'truncated',
      kind: 'hint',
      text: fitCells(`+${dropped} more rows`, cols, glyphs.ellipsis),
      tone: 'hint',
    };
    return kept;
  }
  return rows;
}

function normalizeCols(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** A section title, then nothing else: callers add the body. */
function pushSection(rows: BoardRow[], title: string, cols: number, glyphs: Glyphs): void {
  rows.push({
    key: `section:${title}`,
    kind: 'section',
    text: fitCells(title, cols, glyphs.ellipsis),
    tone: 'accent',
  });
}

function pushBlank(rows: BoardRow[], key: string): void {
  rows.push({ key: `blank:${key}`, kind: 'blank', text: '', tone: 'muted' });
}

/**
 * Two summary lines, each a left clause and a right-anchored figure.
 *
 * The right figure is `alignRightCells`-ed rather than flex-ended because the row is a
 * STRING here: the board hands `OverlayFrame` one element per row, so a row has to be
 * a single measured line or the position indicator desynchronises.
 */
function summaryRow(
  rows: BoardRow[],
  key: string,
  left: string,
  right: string,
  cols: number,
  glyphs: Glyphs,
  tone: BoardTone,
): void {
  if (cols === 0) return;
  const rightCells = Math.min(right.length, Math.max(0, cols - 1));
  const leftCells = Math.max(0, cols - rightCells - 1);
  const body = `${padCells(fitCells(left, leftCells, glyphs.ellipsis), leftCells)} ${right.slice(0, rightCells)}`;
  rows.push({
    key,
    kind: 'summary',
    text: padCells(fitCells(body, cols, glyphs.ellipsis), cols),
    tone,
  });
}

function appendSummary(rows: BoardRow[], input: AgentBoardInput, selected: SubagentRun | null): void {
  const { source, glyphs } = input;
  const cols = normalizeCols(input.cols);
  const counts = rosterCounts(source.runs);
  // A settled entry has no `startedAt`, so only `durationMs` is honest there; a live
  // one may have neither (a dispatch that has not been stamped yet).
  const totalMs = source.active && source.startedAt !== undefined
    ? Math.max(0, input.now - source.startedAt)
    : source.durationMs;
  const clock = totalMs === undefined ? '' : formatDuration(totalMs);
  summaryRow(rows, 'summary:counts', rosterHeadline(counts, glyphs, cols), clock,
    cols, glyphs, 'primary');

  const figures: string[] = [];
  // THE LIVE-ONLY CLAUSE (I-15): no `messageCount` means no `mail` clause at all.
  if (source.messageCount !== undefined) figures.push(`mail ${source.messageCount}`);
  const toolCalls = source.runs.reduce((sum, run) => sum + run.toolCalls, 0);
  figures.push(`${toolCalls} tool calls`);
  const usage = source.runs.reduce(
    (acc, run) => ({
      inputTokens: acc.inputTokens + run.usage.inputTokens,
      outputTokens: acc.outputTokens + run.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  figures.push(`${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`);
  const children = `${source.runs.length} children`;
  if (cols >= BOARD_INLINE_COLS) {
    summaryRow(rows, 'summary:figures', figures.join(` ${glyphs.midDot} `), children,
      cols, glyphs, 'muted');
  }
  pushBlank(rows, 'summary');
  if (selected === null) pushSection(rows, 'no children', cols, glyphs);
}

/**
 * Every child, not the panel's `panelMaxRows` five: the board is the place a reader
 * goes to see the child the panel folded away behind `+N more`.
 *
 * EACH ROW REUSES THE PANEL'S GEOMETRY one cell narrower and prefixes a cursor, so the
 * columns line up with the panel exactly - "the same table at a second zoom level"
 * (§1) rather than a second layout to keep in step.
 */
function appendChildren(
  rows: BoardRow[],
  input: AgentBoardInput,
  selected: SubagentRun | null,
  cols: number,
): void {
  const { glyphs, source } = input;
  pushSection(rows, 'children', cols, glyphs);
  const inner = Math.max(0, cols - 1);
  const geometry = teamRowGeometry(inner, glyphs, { showName: true });
  for (const run of source.runs) {
    const isSelected = selected !== null && run.label === selected.label;
    const marker = statusMarkerCell(childStatus(run), glyphs);
    const label = run.label.padEnd(8).slice(0, 8);
    const name = fitCells(input.voice.nameOf(run.label), geometry.name, glyphs.ellipsis);
    const descriptionCells = Math.max(
      0,
      inner - geometry.marker - geometry.name - geometry.label - geometry.gap
        - geometry.activity - geometry.clock,
    );
    const description = fitCells(run.description.replace(/\s+/g, ' '), descriptionCells, glyphs.ellipsis);
    // THE MARKER TIER IS PASSED THROUGH (R-10): the ASCII tier's marker cell is 6 columns,
    // so a budget computed against the Unicode tier's 3 would promise two columns this row
    // does not have. `fitCells` is the second gate; the first one has to be told the truth
    // or the text is ellipsised where it did fit.
    const activity = fitCells(
      activityWithBadge(run, inner, input.now, geometry.marker, input.voice),
      geometry.activity,
      glyphs.ellipsis,
    );
    const clock = run.startedAt === undefined
      ? ''
      : formatDuration(Math.max(0, (run.endedAt ?? input.now) - run.startedAt));
    const text = [
      isSelected ? glyphs.cursor : ' ',
      padCells(`${marker} `, geometry.marker),
      padCells(name, geometry.name),
      padCells(label, geometry.label),
      padCells(description, descriptionCells),
      padCells(' '.repeat(geometry.gap), geometry.gap),
      padCells(activity, geometry.activity),
      alignRightCells(clock, geometry.clock, glyphs.ellipsis),
    ].join('');
    rows.push({
      key: `child:${run.label}`,
      kind: 'child',
      text: padCells(fitCells(text, cols, glyphs.ellipsis), cols),
      tone: isSelected ? 'primary' : 'muted',
      ...(isSelected ? { selected: true } : {}),
    });
  }
  pushBlank(rows, 'children');
}

/** The selected child's fixed-order fact list (§4.4.2's table, top to bottom). */
function appendFacts(
  rows: BoardRow[],
  input: AgentBoardInput,
  run: SubagentRun,
  cols: number,
): void {
  const { glyphs } = input;
  const name = input.voice.nameOf(run.label);
  pushSection(rows, [name, run.label, run.description].filter((part) => part.length > 0)
    .join(` ${glyphs.midDot} `), cols, glyphs);
  const facts = factPairs(run, glyphs);
  // Two facts per row when there is room, one otherwise; the pairing is done here
  // rather than in the component so the row COUNT is assertable.
  const step = cols >= BOARD_WIDE_COLS ? 2 : 1;
  for (let index = 0; index < facts.length; index += step) {
    const first = facts[index];
    if (first === undefined) continue;
    const second = step === 2 ? facts[index + 1] : undefined;
    rows.push({
      key: `field:${first[0]}:${index}`,
      kind: 'field',
      text: second === undefined
        ? fieldCells(first, cols, glyphs)
        : fieldPairCells(first, second, cols, glyphs),
      tone: 'primary',
    });
  }
  pushBlank(rows, 'facts');
}

/** The width one field occupies in the 2-up form: its label plus its value column. */
const FIELD_PAIR_CELLS = FIELD_LABEL_CELLS + FIELD_WIDE_VALUE_CELLS;

/** One `label  value` field, padded so two of them stand in columns. */
function fieldCells(pair: readonly [string, string], cols: number, glyphs: Glyphs): string {
  const width = Math.max(0, cols);
  return [
    padCells(fitCells(pair[0], FIELD_LABEL_CELLS - 1, glyphs.ellipsis), FIELD_LABEL_CELLS - 1),
    ' ',
    fitCells(pair[1], Math.max(0, width - FIELD_LABEL_CELLS), glyphs.ellipsis),
  ].join('');
}

/**
 * Two fields side by side, each with its own label and value column.
 *
 * BUILT FROM THE LEFT FIELD'S WIDTH, not from slicing a full-width row: a slice counts
 * code units while a row is measured in cells, so a wide character in the first value
 * could be cut in half and both columns would drift. `fieldCells` measures, so one space
 * of gutter and a 34-cell left field are what fix the right field's offset.
 */
function fieldPairCells(
  first: readonly [string, string],
  second: readonly [string, string],
  cols: number,
  glyphs: Glyphs,
): string {
  const right = Math.max(0, cols - FIELD_PAIR_CELLS - 1);
  return `${fieldCells(first, FIELD_PAIR_CELLS, glyphs)} ${fieldCells(second, right, glyphs)}`;
}
/**
 * The facts, in a FIXED order, and with the zero-valued ones ABSENT.
 *
 * `supervisor` / `retries` / `compactions` / `truncated` only appear when they carry a
 * fact; a row reading `supervisor  0` teaches a reader nothing and pushes the section
 * a row down for every child that was never touched.
 */
export function factPairs(run: SubagentRun, glyphs: Glyphs): [string, string][] {
  const status = childStatus(run);
  const state = status === 'running' ? `${status} ${glyphs.midDot} ${run.phase}` : status;
  const pairs: [string, string][] = [
    ['state', state],
    ['turns', String(run.turns)],
    ['tools', String(run.toolCalls)],
    ['tokens', `${formatTokens(run.usage.inputTokens)} / ${formatTokens(run.usage.outputTokens)}`],
  ];
  if (run.filesTouched.length > 0) {
    const head = run.filesTouched.slice(0, 3).join(', ');
    const more = run.filesTouched.length > 3 ? ` (+${run.filesTouched.length - 3})` : '';
    pairs.push(['files', `${run.filesTouched.length} (${head}${more})`]);
  }
  pairs.push(['mail', `${run.messagesSent} sent ${glyphs.midDot} ${run.blockedWaits ?? 0} blocked`]);
  if ((run.interventions ?? 0) > 0 || (run.replacements ?? 0) > 0) {
    const looks = `${run.interventions ?? 0} looks`;
    const replaced = (run.replacements ?? 0) > 0 ? ` ${glyphs.midDot} ${run.replacements} replaced` : '';
    const last = run.lastIntervention === undefined
      ? ''
      : ` ${glyphs.midDot} ${run.lastIntervention.action}`;
    pairs.push(['supervisor', `${looks}${replaced}${last}`]);
  }
  if (run.retry !== undefined) {
    pairs.push(['retries', `retrying ${run.retry.attempt}/${run.retry.maxRetries}`]);
  } else if ((run.retries ?? 0) > 0) {
    pairs.push(['retries', `${run.retries} cold start`]);
  }
  if ((run.compactions ?? 0) > 0) pairs.push(['compactions', String(run.compactions)]);
  if (run.truncated === true) pairs.push(['truncated', 'stopped at turn cap']);
  return pairs;
}

/**
 * `now` and `result`: the two prose sections, both folded by DISPLAY WIDTH.
 *
 * LIVE-ONLY, and honestly so: `now` needs `run.activity`, which is stripped on the way
 * out of the dispatch, so a settled board says one line instead of drawing an empty
 * section (I-15). `result` survives both sources and is the section a reader opens the
 * board for when a child failed.
 */
function appendProse(
  rows: BoardRow[],
  input: AgentBoardInput,
  run: SubagentRun,
  cols: number,
): void {
  const { glyphs } = input;
  pushSection(rows, 'now', cols, glyphs);
  const now = run.activity === undefined
    ? ''
    : sanitizeActivity(run.activity, TEAM_LIMITS.timelineTextChars);
  if (now.length === 0) {
    pushUnavailable(rows, 'now', cols, glyphs);
  } else {
    const wrapped = wrapCells(now, Math.max(0, cols - 2), NOW_MAX_ROWS, glyphs.ellipsis);
    wrapped.lines.forEach((line, index) => {
      rows.push({ key: `now:${index}`, kind: 'event', text: fitCells(`  ${line}`, cols, glyphs.ellipsis), tone: 'muted' });
    });
  }

  pushSection(rows, 'result', cols, glyphs);
  const result = run.error ?? run.summary ?? '';
  if (result.length === 0) {
    pushUnavailable(rows, 'result', cols, glyphs);
    return;
  }
  const wrapped = wrapCells(result, Math.max(0, cols - 2), RESULT_MAX_ROWS, glyphs.ellipsis);
  wrapped.lines.forEach((line, index) => {
    rows.push({
      key: `result:${index}`,
      kind: 'event',
      text: fitCells(`  ${line}`, cols, glyphs.ellipsis),
      tone: run.error !== undefined ? 'error' : 'primary',
    });
  });
}

/**
 * The one honest sentence that replaces a section whose source is gone (§4.4.2 rule 2).
 *
 * QUOTE-SAFE AND PATH-FREE: it names the reason ("live only") rather than apologising,
 * because the fact that matters is that the reader is not being shown a stale copy.
 */
function pushUnavailable(rows: BoardRow[], section: string, cols: number, glyphs: Glyphs): void {
  rows.push({
    key: `unavailable:${section}`,
    kind: 'hint',
    text: fitCells('  live only - not available after the dispatch ended', cols, glyphs.ellipsis),
    tone: 'hint',
  });
}

/** The 24-event ring, oldest first, each prefixed with its offset from the start. */
function appendTimeline(
  rows: BoardRow[],
  input: AgentBoardInput,
  run: SubagentRun,
  cols: number,
): void {
  const { glyphs } = input;
  pushSection(rows, 'timeline', cols, glyphs);
  const timeline = run.timeline ?? [];
  if (timeline.length === 0) {
    pushUnavailable(rows, 'timeline', cols, glyphs);
    return;
  }
  const start = run.startedAt ?? timeline[0]?.at ?? 0;
  timeline.forEach((entry, index) => {
    const offset = `+${formatDuration(Math.max(0, entry.at - start))}`;
    const mark = entry.ok === undefined ? '' : entry.ok ? ' ok' : ' failed';
    const took = entry.ms === undefined ? '' : ` ${formatDuration(entry.ms)}`;
    // FRIENDLY WORDING for tool lines, in the neutral variant 0: a timeline is a RECORD
    // and a record gets plain words, not the rotating jokes of the live row (D-6).
    const line = input.voice.mode === 'friendly' && entry.tool !== undefined
      ? toolPhrase({ tool: entry.tool, args: entry.args, wide: true, variantSeed: 0, budget: 200 },
        { ...input.voice, reducedMotion: true })
      : entry.text;
    const text = `  ${padCells(offset, 8)} ${line}${took}${mark}`;
    rows.push({
      key: `event:${index}`,
      kind: 'event',
      text: fitCells(text, cols, glyphs.ellipsis),
      tone: entry.ok === false ? 'warn' : 'muted',
    });
  });
}
