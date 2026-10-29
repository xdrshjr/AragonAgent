/**
 * The `/gov board` overlay's model and geometry (governance-mode section 10.5): the tab
 * model, the data adapters, the row builders and the scroll arithmetic - every decision
 * the overlay makes, in pure code.
 *
 * Pure and total: no Ink, no clock (`now` is not even needed: rows carry sequence
 * numbers, not times), no I/O. ASCII ONLY.
 *
 * TWO DATA SOURCES, ONE SHAPE. The live `GovernanceSnapshot` knows the roster and the
 * ticker; the work-package matrix, the full ledger and the claims live in `RunState` /
 * `LedgerState`. `GovernanceBoardData` is the UI's own flat projection of all of it, with
 * two builders: `boardDataFromSnapshot` (what the renderer always has) and
 * `boardDataFromRun` (what the wiring can supply). A board built from the snapshot alone
 * still reads correctly - the tabs it cannot fill say so instead of going blank.
 *
 * EVERY ROW IS ONE TERMINAL ROW. Rows are `Segment[]` rendered `wrap="truncate"`, so
 * scrolling is arithmetic on a list length (`sliceWindow`), never a re-measure.
 */

import type {
  Claim,
  Escalation,
  GovernanceSnapshot,
  LedgerState,
  RosterRow,
  RunState,
  WorkPackage,
} from '../../model/governance/types.js';
import type { Glyphs } from '../glyphs.js';
import {
  govChildStatus,
  labelTag,
  scoreText,
  scoreToneKey,
  segment,
  signedDeltaText,
  sortRoster,
  statusTone,
  type Segment,
  type Tone,
} from '../governance-status.js';
import {
  BOARD_EMPTY,
  BOARD_TAB_LABEL,
  ROLE_LABEL,
  STATE_WORD,
  WORKING_VERB,
  replacedByText,
} from '../governance-copy.js';
import { statusMarkerCell } from '../team-status.js';
import { cellWidth, fitCells, padCells } from './cells.js';
import { bindVoiceScope, type VoiceContext } from '../tool-voice.js';
import { sliceWindow } from './overlay-window.js';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type BoardTab = 'roster' | 'work' | 'ledger' | 'claims';
export const BOARD_TABS: readonly BoardTab[] = ['roster', 'work', 'ledger', 'claims'] as const;

/** Terminals narrower than this get the single-column form with a `1/4` pager. */
export const BOARD_NARROW_COLS = 80;
/** Recent ledger lines shown under each identity on the roster tab (spec 10.5). */
export const BOARD_RECENT_PER_AGENT = 5;
/** Ledger rows kept in the projection, newest first. */
export const BOARD_LEDGER_MAX = 200;

/** The tab `delta` steps away, wrapping at both ends. */
export function stepTab(tab: BoardTab, delta: number): BoardTab {
  const index = BOARD_TABS.indexOf(tab);
  const size = BOARD_TABS.length;
  return BOARD_TABS[(((index + delta) % size) + size) % size]!;
}

export function tabIndex(tab: BoardTab): number {
  return BOARD_TABS.indexOf(tab);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface BoardLedgerRow {
  seq: number;
  agentId: string;
  code: string;
  delta: number;
  provisional: boolean;
  /** `engine` / `inspector:insp`; '' when the source does not say. */
  by: string;
  reason: string;
  evidence: string;
  capped: boolean;
}

export interface BoardWorkPackage {
  id: string;
  title: string;
  status: WorkPackage['status'];
  reworkCount: number;
  assignee: string;
  reviewer: string;
  tester: string;
  fileCount: number;
  blockedAt: string;
}

export interface BoardClaimRow {
  id: string;
  kind: 'claim' | 'escalation';
  status: string;
  /** `missed_by_review`, `wp_rework_cap`, ... */
  detail: string;
  /** Who is involved: `dev1 -> rev2` for a claim, the WP / phase for an escalation. */
  subject: string;
  text: string;
}

export interface GovernanceBoardData {
  snapshot: GovernanceSnapshot;
  workPackages: BoardWorkPackage[];
  ledger: BoardLedgerRow[];
  claims: BoardClaimRow[];
  /** Absolute path of `board.md`, for the `e` key; null when unknown. */
  boardPath: string | null;
}

/** What the renderer always has: the live snapshot. WPs and claims stay empty. */
export function boardDataFromSnapshot(
  snapshot: GovernanceSnapshot,
  boardPath: string | null = null,
): GovernanceBoardData {
  const ledger = [...snapshot.recent]
    .sort((a, b) => b.at - a.at)
    .map((row, index): BoardLedgerRow => ({
      seq: snapshot.recent.length - index,
      agentId: row.agentId,
      code: row.code,
      delta: row.delta,
      provisional: row.provisional,
      by: '',
      reason: row.reason,
      evidence: '',
      capped: false,
    }));
  return { snapshot, workPackages: [], ledger, claims: [], boardPath };
}

function workPackageRow(wp: WorkPackage): BoardWorkPackage {
  return {
    id: wp.id,
    title: wp.title,
    status: wp.status,
    reworkCount: wp.reworkCount,
    assignee: wp.assignee ?? '',
    reviewer: wp.reviewer ?? '',
    tester: wp.tester ?? '',
    fileCount: wp.files.length,
    blockedAt: wp.blockedAt ?? '',
  };
}

function claimRow(claim: Claim): BoardClaimRow {
  return {
    id: claim.id,
    kind: 'claim',
    status: claim.status,
    detail: claim.kind,
    subject: `${claim.raisedBy} -> ${claim.against} (${claim.wpId})`,
    text: claim.rulingText ?? claim.justification,
  };
}

function escalationRow(esc: Escalation): BoardClaimRow {
  return {
    id: esc.id,
    kind: 'escalation',
    status: esc.status,
    detail: esc.kind,
    subject: esc.wpId ?? (esc.phase === undefined ? '' : `phase ${esc.phase + 1}`),
    text: esc.ruling ?? esc.topic,
  };
}

function ledgerRows(ledger: LedgerState): BoardLedgerRow[] {
  const rows: BoardLedgerRow[] = [];
  for (const agent of Object.values(ledger.agents)) {
    for (const entry of agent.history) {
      rows.push({
        seq: entry.seq,
        agentId: agent.id,
        code: entry.code,
        delta: entry.delta,
        provisional: entry.settlement === 'provisional',
        by: entry.by,
        reason: entry.reason,
        evidence: entry.evidence ?? '',
        capped: entry.capped !== undefined,
      });
    }
  }
  return rows.sort((a, b) => b.seq - a.seq).slice(0, BOARD_LEDGER_MAX);
}

export interface BoardDataInput {
  snapshot: GovernanceSnapshot;
  run: RunState;
  ledger: LedgerState;
  boardPath?: string | null;
}

/** The full projection, for a wiring that can read the run and the ledger. */
export function boardDataFromRun(input: BoardDataInput): GovernanceBoardData {
  const { snapshot, run, ledger } = input;
  return {
    snapshot,
    workPackages: run.wpOrder
      .map((id) => run.workPackages[id])
      .filter((wp): wp is WorkPackage => wp !== undefined)
      .map(workPackageRow),
    ledger: ledgerRows(ledger),
    claims: [...run.claims.map(claimRow), ...run.escalations.map(escalationRow)],
    boardPath: input.boardPath ?? null,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface BoardLine {
  key: string;
  segments: Segment[];
}

function boardLine(key: string, segments: Segment[]): BoardLine {
  return { key, segments };
}

function emptyLine(text: string): BoardLine[] {
  return [boardLine('empty', [segment(text, 'muted')])];
}

function head(key: string, text: string): BoardLine {
  return boardLine(key, [segment(text, 'muted')]);
}

function agentState(row: RosterRow): string {
  return row.state === 'working' ? WORKING_VERB[row.role] : STATE_WORD[row.state];
}

function recentLines(data: GovernanceBoardData, agentId: string): BoardLine[] {
  return data.ledger
    .filter((row) => row.agentId === agentId)
    .slice(0, BOARD_RECENT_PER_AGENT)
    .map((row): BoardLine => boardLine(`${agentId}:r${row.seq}`, [
      segment('      ', 'muted'),
      segment(
        padCells(signedDeltaText(row.delta, row.provisional), 7),
        row.delta >= 0 ? 'ok' : 'error',
      ),
      segment(padCells(row.code, 5), 'muted'),
      segment(row.reason.replace(/\s+/g, ' '), 'text'),
      ...(row.capped ? [segment(` [capped]`, 'warn')] : []),
    ]));
}

/** Persona name cell on the board (a name plus one cell of air). */
const BOARD_NAME_CELLS = 7;

function rosterIdentityLine(
  row: RosterRow,
  glyphs: Glyphs,
  narrow: boolean,
  voice?: VoiceContext,
): BoardLine {
  const status = govChildStatus(row.state);
  const nameOf = voice?.nameOf;
  const nameSegment: Segment[] = nameOf === undefined
    ? []
    : [segment(padCells(nameOf(row.id), BOARD_NAME_CELLS), 'primary', true)];
  const tone = statusTone(status);
  const score = row.confirmed === null ? '-' : scoreText(row.confirmed);
  const prov = row.provisional > 0 ? `+${row.provisional}P` : '';
  const tag = labelTag(row.label);
  const marker = ` ${statusMarkerCell(status, glyphs)} `;
  if (narrow) {
    return boardLine(row.id, [
      segment(marker, tone),
      ...nameSegment,
      segment(padCells(row.id, 9), 'primary'),
      segment(padCells(ROLE_LABEL[row.role], 5), 'muted'),
      segment(padCells(score, 5), scoreToneKey(row.label), true),
      segment(prov, 'muted'),
      ...(tag === '' ? [] : [segment(` ${tag}`, scoreToneKey(row.label), true)]),
    ]);
  }
  const state = row.state === 'eliminated'
    ? replacedByText(row.replacedBy, nameOf)
    : agentState(row);
  return boardLine(row.id, [
    segment(marker, tone),
    ...nameSegment,
    segment(padCells(row.id, 10), 'primary'),
    segment(padCells(ROLE_LABEL[row.role], 6), 'muted'),
    segment(padCells(`g${row.generation}`, 4), 'muted'),
    segment(padCells(score, 6), scoreToneKey(row.label), true),
    segment(padCells(prov, 7), 'muted'),
    segment(padCells(tag, 8), scoreToneKey(row.label), true),
    segment(padCells(state, 22), tone),
    segment(row.wpId ?? '-', 'text'),
  ]);
}

function rosterRows(
  data: GovernanceBoardData,
  glyphs: Glyphs,
  narrow: boolean,
  voice?: VoiceContext,
): BoardLine[] {
  const roster = sortRoster(data.snapshot.roster);
  if (roster.length === 0) return emptyLine(BOARD_EMPTY.roster);
  // The header gains a `name` column in step with the rows; absent without a voice.
  const header = voice === undefined
    ? '    id        role  gen score  prov   label   state                 work'
    : '    name   id         role  gen score  prov   label   state                 work';
  const lines: BoardLine[] = narrow ? [] : [head('h', header)];
  for (const row of roster) {
    lines.push(rosterIdentityLine(row, glyphs, narrow, voice));
    lines.push(...recentLines(data, row.id));
  }
  return lines;
}

const WP_TONE: Readonly<Record<WorkPackage['status'], Tone>> = {
  pending: 'pending',
  dev_running: 'running',
  awaiting_review: 'pending',
  review_running: 'running',
  awaiting_test: 'pending',
  test_running: 'running',
  rework: 'warn',
  tested_ok: 'ok',
  integrated: 'ok',
  blocked: 'error',
  dropped: 'muted',
};

function workRows(data: GovernanceBoardData, narrow: boolean): BoardLine[] {
  if (data.workPackages.length === 0) return emptyLine(BOARD_EMPTY.work);
  const lines: BoardLine[] = narrow
    ? []
    : [head('h', 'wp          status            rw  dev      rev      test     files  title')];
  for (const wp of data.workPackages) {
    const status = wp.blockedAt === '' ? wp.status : `${wp.status}@${wp.blockedAt}`;
    if (narrow) {
      lines.push(boardLine(wp.id, [
        segment(padCells(wp.id, 12), 'primary'),
        segment(status, WP_TONE[wp.status]),
        ...(wp.reworkCount > 0 ? [segment(` rw${wp.reworkCount}`, 'warn')] : []),
      ]));
      lines.push(boardLine(`${wp.id}:t`, [segment(`  ${wp.title}`, 'muted')]));
      continue;
    }
    lines.push(boardLine(wp.id, [
      segment(padCells(wp.id, 12), 'primary'),
      segment(padCells(status, 18), WP_TONE[wp.status]),
      segment(padCells(String(wp.reworkCount), 4), wp.reworkCount > 0 ? 'warn' : 'muted'),
      segment(padCells(wp.assignee || '-', 9), 'text'),
      segment(padCells(wp.reviewer || '-', 9), 'text'),
      segment(padCells(wp.tester || '-', 9), 'text'),
      segment(padCells(String(wp.fileCount), 7), 'muted'),
      segment(wp.title, 'muted'),
    ]));
  }
  return lines;
}

function ledgerBoardRows(data: GovernanceBoardData, narrow: boolean): BoardLine[] {
  if (data.ledger.length === 0) return emptyLine(BOARD_EMPTY.ledger);
  const lines: BoardLine[] = narrow
    ? []
    : [head('h', '#      agent     delta   code  by                 reason')];
  for (const row of data.ledger) {
    const tone: Tone = row.delta >= 0 ? 'ok' : 'error';
    const amount = signedDeltaText(row.delta, row.provisional);
    const reason = row.reason.replace(/\s+/g, ' ');
    const cap = row.capped ? [segment(' [capped]', 'warn')] : [];
    if (narrow) {
      lines.push(boardLine(`l${row.seq}:${row.agentId}`, [
        segment(padCells(row.agentId, 9), 'primary'),
        segment(padCells(amount, 7), tone),
        segment(padCells(row.code, 5), 'muted'),
        segment(reason, 'text'),
        ...cap,
      ]));
    } else {
      lines.push(boardLine(`l${row.seq}:${row.agentId}`, [
        segment(padCells(String(row.seq), 7), 'muted'),
        segment(padCells(row.agentId, 10), 'primary'),
        segment(padCells(amount, 8), tone),
        segment(padCells(row.code, 6), 'muted'),
        segment(padCells(row.by, 19), 'muted'),
        segment(reason, 'text'),
        ...cap,
      ]));
    }
    if (row.evidence !== '') {
      lines.push(boardLine(`l${row.seq}:${row.agentId}:e`, [
        segment(`        evidence: ${row.evidence.replace(/\s+/g, ' ')}`, 'muted'),
      ]));
    }
  }
  return lines;
}

function claimsRows(data: GovernanceBoardData, narrow: boolean): BoardLine[] {
  if (data.claims.length === 0) return emptyLine(BOARD_EMPTY.claims);
  const lines: BoardLine[] = [];
  for (const claim of data.claims) {
    const open = claim.status === 'open';
    lines.push(boardLine(claim.id, [
      segment(padCells(claim.id, 8), 'primary'),
      segment(padCells(claim.status, 10), open ? 'warn' : 'ok', open),
      ...(narrow ? [] : [segment(padCells(claim.detail, 20), 'muted')]),
      segment(claim.subject, 'text'),
    ]));
    if (claim.text !== '') {
      lines.push(boardLine(`${claim.id}:t`, [
        segment(`        ${claim.text.replace(/\s+/g, ' ')}`, 'muted'),
      ]));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface BoardTabStrip {
  segments: Segment[];
  /** `1/4` in the narrow form, `''` in the wide one. */
  pager: string;
}

function tabCount(tab: BoardTab, data: GovernanceBoardData): number {
  switch (tab) {
    case 'roster':
      return data.snapshot.roster.length;
    case 'work':
      return data.workPackages.length;
    case 'ledger':
      return data.ledger.length;
    case 'claims':
      return data.claims.filter((claim) => claim.status === 'open').length;
  }
}

export function buildTabStrip(
  tab: BoardTab,
  data: GovernanceBoardData,
  narrow: boolean,
  glyphs: Glyphs,
): BoardTabStrip {
  if (narrow) {
    const pager = `${tabIndex(tab) + 1}/${BOARD_TABS.length}`;
    return {
      pager,
      segments: [
        segment(`${glyphs.arrowLeft} `, 'muted'),
        segment(BOARD_TAB_LABEL[tab], 'govern', true),
        segment(` ${pager} ${glyphs.arrowRight}`, 'muted'),
      ],
    };
  }
  const segments: Segment[] = [];
  BOARD_TABS.forEach((candidate, index) => {
    if (index > 0) segments.push(segment(`  ${glyphs.midDot}  `, 'border'));
    const active = candidate === tab;
    const count = tabCount(candidate, data);
    segments.push(segment(
      `${active ? glyphs.cursor : ' '}${BOARD_TAB_LABEL[candidate]}`,
      active ? 'govern' : 'muted',
      active,
    ));
    if (count > 0) segments.push(segment(` ${count}`, active ? 'text' : 'hint'));
  });
  return { segments, pager: '' };
}

export interface GovernanceBoardInput {
  /** Overlay CONTENT width (the frame's chrome already subtracted). */
  cols: number;
  tab: BoardTab;
  data: GovernanceBoardData | null;
  glyphs: Glyphs;
  /**
   * Persona names for the roster tab. Absent = the pre-persona board, byte for byte.
   * Names resolve in the run's scope (`data.snapshot.runId`).
   */
  voice?: VoiceContext;
}

export interface GovernanceBoardLayout {
  narrow: boolean;
  tabStrip: BoardTabStrip;
  /** Every row of the active tab; the overlay windows them. */
  lines: BoardLine[];
}

const NO_RUN_LINES: BoardLine[] = [boardLine('norun', [segment(BOARD_EMPTY.noRun, 'muted')])];

export function buildGovernanceBoardLayout(input: GovernanceBoardInput): GovernanceBoardLayout {
  const { tab, data, glyphs } = input;
  const narrow = input.cols < BOARD_NARROW_COLS;
  if (data === null) {
    const strip = { segments: [segment(BOARD_TAB_LABEL[tab], 'govern', true)], pager: '' };
    return { narrow, tabStrip: strip, lines: NO_RUN_LINES };
  }
  const tabStrip = buildTabStrip(tab, data, narrow, glyphs);
  switch (tab) {
    case 'roster':
      return {
        narrow,
        tabStrip,
        lines: rosterRows(
          data, glyphs, narrow,
          input.voice === undefined ? undefined : bindVoiceScope(input.voice, data.snapshot.runId),
        ),
      };
    case 'work':
      return { narrow, tabStrip, lines: workRows(data, narrow) };
    case 'ledger':
      return { narrow, tabStrip, lines: ledgerBoardRows(data, narrow) };
    case 'claims':
      return { narrow, tabStrip, lines: claimsRows(data, narrow) };
  }
}

// ---------------------------------------------------------------------------
// Scroll windowing
// ---------------------------------------------------------------------------

/** Body rows left for content once the tab strip has taken one of the frame's rows. */
export function boardBodyRows(frameBodyRows: number): number {
  return Math.max(1, Math.floor(frameBodyRows) - 1);
}

export interface BoardWindow {
  start: number;
  visible: number;
  total: number;
  /** The offset after clamping: feed it back so the owner's counter cannot run away. */
  clamped: number;
}

export function boardWindow(total: number, offset: number, height: number): BoardWindow {
  return sliceWindow(total, offset, height);
}

/** Position text for the footer, e.g. `3-14/40`; '' when everything fits. */
export function boardPosition(window: BoardWindow, glyphs: Glyphs): string {
  if (window.visible >= window.total) return '';
  const up = window.start > 0 ? glyphs.arrowUp : ' ';
  const down = window.start + window.visible < window.total ? glyphs.arrowDown : ' ';
  return `${up}${down} ${window.start + 1}-${window.start + window.visible}/${window.total}`;
}

/** Footer hint, shortened to the width the frame can print on one row. */
export function boardHint(cols: number, glyphs: Glyphs): string {
  const dot = ` ${glyphs.midDot} `;
  const full = [
    `${glyphs.arrowLeft}/${glyphs.arrowRight} tab`,
    `${glyphs.arrowUp}/${glyphs.arrowDown} PgUp/PgDn scroll`,
    'e copy path',
    'Esc close',
  ];
  for (let size = full.length; size >= 1; size -= 1) {
    const kept = size === full.length ? full : [...full.slice(0, size - 1), full[full.length - 1]!];
    const text = kept.join(dot);
    if (cellWidth(text) <= cols) return text;
  }
  return fitCells('Esc close', Math.max(0, cols), glyphs.ellipsis);
}
