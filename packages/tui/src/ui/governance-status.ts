/**
 * Governance status: snapshot -> display derivations (governance-mode section 10.3).
 *
 * Pure: no Ink, no clock (callers inject `now`), no I/O. ASCII ONLY.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. The panel, the chip, the card and the board each
 * need the same few JUDGEMENTS - which colour a score label gets, whether a score change
 * is still inside its emphasis window, which pipeline step is current, what an agent's
 * state looks like to `team-status.ts`. Putting each judgement here once is the same
 * discipline `team-status.ts` records: the roster, the card and the chip used to disagree
 * about what "running" looked like because nine files each answered it.
 *
 * COLOUR IS A SEMANTIC KEY, NOT A THEME FIELD. The layout modules emit `Tone` values and
 * the components resolve them through `toneColor`, so a layout test never needs a `Theme`
 * and a theme change never touches a layout.
 */

import type {
  GovAgentState,
  GovRole,
  GovernanceSnapshot,
  RosterRow,
  RunStatus,
  StageKind,
} from '../model/governance/types.js';
import { POSTURE_LABEL, type Posture } from '../model/governance/posture.js';
import { MODE_LABEL, type AgentMode } from '../model/agent/agent-mode.js';
import { GOV_LIMITS } from '../model/governance/limits.js';
import type { ChildStatus } from './team-status.js';
import type { Theme } from './theme.js';

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

/** Semantic colour slots shared by every governance surface. */
export type Tone =
  | 'text'
  | 'muted'
  | 'hint'
  | 'border'
  | 'primary'
  | 'govern'
  | 'ok'
  | 'warn'
  | 'error'
  | 'pending'
  | 'running';

/**
 * A table, not a switch: exhaustive over `Tone` at compile time (a new tone is a
 * missing-key error) and flat in complexity however many tones there are.
 */
const TONE_COLOR: Readonly<Record<Tone, (theme: Theme) => string | undefined>> = {
  text: (theme) => theme.assistant,
  muted: (theme) => theme.muted,
  hint: (theme) => theme.hintFg,
  border: (theme) => theme.border,
  primary: (theme) => theme.primary,
  govern: (theme) => theme.governAccent,
  ok: (theme) => theme.toolDone,
  warn: (theme) => theme.noticeWarn,
  error: (theme) => theme.noticeError,
  pending: (theme) => theme.toolPending,
  running: (theme) => theme.toolRunning,
};

/** Resolve a tone against a theme. The ONLY place a `Tone` becomes a colour. */
export function toneColor(tone: Tone, theme: Theme): string | undefined {
  return TONE_COLOR[tone](theme);
}

/** A run of text in one tone: the unit every layout line is made of. */
export interface Segment {
  text: string;
  tone: Tone;
  bold?: boolean;
}

export function segment(text: string, tone: Tone, bold = false): Segment {
  return bold ? { text, tone, bold } : { text, tone };
}

// ---------------------------------------------------------------------------
// Agent state -> the team roster's vocabulary
// ---------------------------------------------------------------------------

/**
 * A governance agent state, read as a `team-status.ts` `ChildStatus`, so the glyph and
 * the colour come from THAT module (`statusGlyph` / `statusMarkerCell`) and not from a
 * second table (spec 10.3, "do not make a second copy").
 *
 * `idle` and `queued` are both "not doing anything yet"; `eliminated` borrows the
 * failure reading because the marker for it is the cross and the colour is the error
 * colour - the row's TEXT says `replaced by ...`, which is what stops it reading as a
 * crash.
 */
const STATUS_BY_STATE: Readonly<Record<GovAgentState, ChildStatus>> = {
  queued: 'queued',
  idle: 'queued',
  working: 'running',
  submitted: 'done',
  failed: 'failed',
  eliminated: 'failed',
};

export function govChildStatus(state: GovAgentState): ChildStatus {
  return STATUS_BY_STATE[state];
}

/**
 * The tone that `statusColor(status, theme)` resolves to, as a key. A test pins the pair
 * (`toneColor(statusTone(s), theme) === statusColor(s, theme)` for every status and every
 * theme) so the two tables cannot drift apart.
 */
const TONE_BY_STATUS: Readonly<Record<ChildStatus, Tone>> = {
  queued: 'pending',
  running: 'running',
  done: 'ok',
  failed: 'error',
  aborted: 'warn',
};

export function statusTone(status: ChildStatus): Tone {
  return TONE_BY_STATUS[status];
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** How a standing label reads on screen. */
export type ScoreTone = 'ok' | 'warn' | 'danger' | 'muted';

export function scoreTone(label: RosterRow['label']): ScoreTone {
  switch (label) {
    case 'NORMAL':
      return 'ok';
    case 'WARNING':
      return 'warn';
    case 'DANGER':
    case 'KILLED':
      return 'danger';
    case 'NOT_SCORED':
      return 'muted';
  }
}

const TONE_BY_SCORE: Readonly<Record<ScoreTone, Tone>> = {
  ok: 'ok',
  warn: 'warn',
  danger: 'error',
  muted: 'muted',
};

export function scoreToneKey(label: RosterRow['label']): Tone {
  return TONE_BY_SCORE[scoreTone(label)];
}

/** The short word for a label in the roster's tag column; `NORMAL` says nothing. */
export function labelTag(label: RosterRow['label']): string {
  switch (label) {
    case 'WARNING':
      return 'WARN';
    case 'DANGER':
      return 'DANGER';
    case 'KILLED':
      return 'KILLED';
    case 'NORMAL':
    case 'NOT_SCORED':
      return '';
  }
}

/** Scored agents start here; the gauge is full at this value. */
export const GAUGE_FULL_SCORE = GOV_LIMITS.initialTokens;
export const GAUGE_CELLS = 10;

/**
 * Filled cells of the 10-cell score gauge: `round(confirmed / 100 * 10)` clamped to
 * [0, 10] (spec 10.3). Non-finite input draws an empty bar rather than throwing - the
 * gauge is decoration over a number that is printed beside it.
 */
export function gaugeFilledCells(confirmed: number): number {
  if (!Number.isFinite(confirmed)) return 0;
  const raw = Math.round((confirmed / GAUGE_FULL_SCORE) * GAUGE_CELLS);
  return Math.min(GAUGE_CELLS, Math.max(0, raw));
}

/** `115+` when the score is over the starting value, otherwise the plain number. */
export function scoreText(confirmed: number): string {
  const rounded = Math.round(confirmed);
  return rounded > GAUGE_FULL_SCORE ? `${rounded}+` : String(Math.max(0, rounded));
}

// ---------------------------------------------------------------------------
// Delta emphasis (AC-27)
// ---------------------------------------------------------------------------

/** How long a score change stays emphasised on its row. */
export const DELTA_EMPHASIS_MS = 4000;

export interface DeltaCell {
  /** `+10` / `-20`, or '' when the row has nothing to say. */
  text: string;
  tone: Tone;
  bold: boolean;
}

const NO_DELTA: DeltaCell = { text: '', tone: 'muted', bold: false };

/** Signed delta text; a provisional gain carries the `P` suffix (`+15P`). */
export function signedDeltaText(delta: number, provisional: boolean): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  return `${sign}${Math.abs(Math.round(delta))}${provisional && delta > 0 ? 'P' : ''}`;
}

/**
 * The emphasised delta of a row.
 *
 * Motion allowed: bold + coloured for `DELTA_EMPHASIS_MS` after the change, then gone.
 * Reduced motion: nothing is time-windowed, so nothing flashes - the delta stays, plain,
 * until the engine replaces or clears `lastDelta` at the next phase (spec 10.3 "the
 * increment text is kept until the next phase"). A zero delta says nothing in either mode.
 */
export function deltaCell(row: RosterRow, now: number, reducedMotion: boolean): DeltaCell {
  const last = row.lastDelta;
  if (last === null || last.delta === 0) return NO_DELTA;
  const tone: Tone = last.delta > 0 ? 'ok' : 'error';
  const text = signedDeltaText(last.delta, last.provisional);
  if (reducedMotion) return { text, tone, bold: false };
  const age = now - last.at;
  if (age < 0 || age > DELTA_EMPHASIS_MS) return NO_DELTA;
  return { text, tone, bold: true };
}

// ---------------------------------------------------------------------------
// Run level
// ---------------------------------------------------------------------------

/** The display modes of the legion panel (spec 10.3 mount rules). */
export type GovernancePanelMode = 'none' | 'run-strip' | 'panel';

/**
 * Mount rule (D-17): a running stage -> the full panel (which REPLACES the team roster);
 * a live run between stages -> the two-line strip; no run, a closed run or an abandoned
 * run -> nothing at all (zero rows, zero layout shift).
 */
export function governancePanelMode(snapshot: GovernanceSnapshot | null): GovernancePanelMode {
  if (snapshot === null) return 'none';
  if (isFinishedRun(snapshot.status)) return 'none';
  return snapshot.stageRunning ? 'panel' : 'run-strip';
}

/** Which component owns the bottom transient region's live roster. */
export type LiveRosterSurface = 'governance' | 'team' | 'none';

/**
 * EXACTLY ONE LIVE ROSTER (D-17 / AC-25). A running governed stage owns the region even
 * though the same children are also in `state.team` (the reducer still writes it for
 * `/agents`); between stages the two-line strip shows only when no dispatch is live; with
 * no live governed run the team roster behaves exactly as it always did.
 */
export function liveRosterSurface(
  snapshot: GovernanceSnapshot | null,
  teamLive: boolean,
): LiveRosterSurface {
  const mode = governancePanelMode(snapshot);
  if (mode === 'panel') return 'governance';
  if (mode === 'run-strip' && !teamLive) return 'governance';
  return teamLive ? 'team' : 'none';
}

export function isFinishedRun(status: RunStatus): boolean {
  return status === 'closed' || status === 'abandoned';
}

/** Agents currently doing something: the minimal tier's "4 working". */
export function workingCount(snapshot: GovernanceSnapshot): number {
  return snapshot.roster.filter((row) => row.state === 'working').length;
}

/** Display position in the pipeline: the active step's key, or the stage, or null. */
export function activeStepKey(snapshot: GovernanceSnapshot): StageKind | null {
  const active = snapshot.pipeline.find((step) => step.state === 'active');
  if (active !== undefined && active.key !== 'intake') return active.key;
  return snapshot.stage;
}

/** Tokens spent by the governed team (spec 8.5: team tokens, never the session total). */
export function teamTokens(snapshot: GovernanceSnapshot): number {
  const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = snapshot.usage;
  return inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
}

/**
 * Budget readout for the chip's `$` hint: 'none' without a budget, 'warn' from 80%,
 * 'over' from 100% (spec 8.5). Only budgets > 0 are budgets.
 */
export function budgetState(snapshot: GovernanceSnapshot): 'none' | 'ok' | 'warn' | 'over' {
  if (snapshot.budgetTokens <= 0) return 'none';
  const fraction = teamTokens(snapshot) / snapshot.budgetTokens;
  if (fraction >= 1) return 'over';
  return fraction >= GOV_LIMITS.budgetWarnFraction ? 'warn' : 'ok';
}

/** Short run id for the header: the last five alphanumerics, so ids that share a prefix differ. */
export function shortRunId(runId: string): string {
  const clean = runId.replace(/[^A-Za-z0-9]/g, '');
  return clean.length <= 5 ? clean : clean.slice(clean.length - 5);
}

// ---------------------------------------------------------------------------
// Eliminated members (AC-27, second half)
// ---------------------------------------------------------------------------

/** Phase at which each eliminated id was FIRST seen eliminated. */
export type EliminatedSince = Readonly<Record<string, number>>;

/**
 * Fold a snapshot into the first-seen-eliminated map.
 *
 * WHY THE PANEL KEEPS THIS ITSELF: `RosterRow` carries no "eliminated in phase N" field,
 * and the board still needs the full roster from the same snapshot, so the engine cannot
 * simply drop the row. A member that disappears from the map's keys (never happens) or
 * that was never seen eliminated is treated as "eliminated now" by `isRetired`. Returns
 * the SAME object when nothing changed so React memo / ref comparisons stay cheap.
 */
export function trackEliminated(
  previous: EliminatedSince,
  snapshot: GovernanceSnapshot,
): EliminatedSince {
  let next: Record<string, number> | null = null;
  for (const row of snapshot.roster) {
    if (row.state !== 'eliminated' || previous[row.id] !== undefined) continue;
    next ??= { ...previous };
    next[row.id] = snapshot.phase;
  }
  return next ?? previous;
}

/**
 * True when an eliminated member's one visible phase is over: it was first seen in an
 * earlier phase than the one now displayed.
 */
export function isRetired(row: RosterRow, phase: number, since: EliminatedSince): boolean {
  if (row.state !== 'eliminated') return false;
  const seen = since[row.id];
  return seen !== undefined && phase > seen;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const ROLE_ORDER: Readonly<Record<GovRole, number>> = { DEV: 0, REV: 1, TEST: 2, INSP: 3 };

/**
 * Roster order: DEV -> REV -> TEST -> INSP, active members before eliminated ones, then
 * by generation and id so `dev2` precedes its successor `dev2-r1` and the order is total
 * (a stable roster does not reshuffle between snapshots).
 */
export function sortRoster(roster: readonly RosterRow[]): RosterRow[] {
  return [...roster].sort((a, b) => {
    const gone = Number(a.state === 'eliminated') - Number(b.state === 'eliminated');
    if (gone !== 0) return gone;
    const role = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
    if (role !== 0) return role;
    if (a.generation !== b.generation) return a.generation - b.generation;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// PLAN+GOVERN interview chip
// ---------------------------------------------------------------------------

/**
 * `PLAN+GOVERN  interview round 2/2+` while rounds are still owed, and `... 2/2 OK` once
 * the minimum is met (governance-mode 10.6). The trailing `+` reads "at least this many":
 * the model may ask more rounds than the minimum.
 */
export function interviewChipText(round: number, required: number): string {
  const answered = Math.max(0, Math.floor(round));
  const needed = Math.max(0, Math.floor(required));
  const met = answered >= needed;
  return `${POSTURE_LABEL.plan_govern}  interview round ${answered}/${needed}${met ? ' OK' : '+'}`;
}

// ---------------------------------------------------------------------------
// Posture words
// ---------------------------------------------------------------------------

/**
 * A `/gov pause` is waiting for the running stage to finish (governance-mode-v1-1 6.4).
 * Only meaningful while the run is still `executing`: once it is `paused` the request has
 * been redeemed, and an `escalated` run drops it.
 */
export function isPausePending(snapshot: GovernanceSnapshot): boolean {
  return snapshot.pauseRequested === true && snapshot.status === 'executing';
}

/** True for the two governed postures, given a mode OR posture value as a string. */
export function isGovernedModeValue(value: string | null | undefined): boolean {
  return value === 'govern' || value === 'plan_govern';
}

/**
 * The status row's word for a mode OR a posture. `MODE_LABEL` answers for `build` /
 * `plan` (so the byte-identical pre-governance output is preserved); the two governed
 * postures are the only values that reach the second table.
 *
 * Short form: the first letter, except `plan_govern` which is `PG` - `P` is already PLAN
 * and a status row that cannot tell them apart has defeated the badge.
 */
export function modeWord(value: string, full: boolean): string | undefined {
  const label = MODE_LABEL[value as AgentMode] ?? POSTURE_LABEL[value as Posture];
  if (label === undefined) return undefined;
  if (full) return label;
  return value === 'plan_govern' ? 'PG' : label[0];
}
