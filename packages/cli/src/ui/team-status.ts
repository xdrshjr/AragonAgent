/**
 * Team status — the ONE authority that answers "what state is this child in, and
 * how is that drawn / counted / timed" (tui-subagent-double-roster A-1).
 *
 * WHY THIS FILE EXISTS. The phase -> glyph / colour / count question used to be
 * answered by nine copies in seven files, and they disagreed. The transcript card
 * asked `isOk(run) ? toolDone : toolError`, so six of the eight phases - every
 * child that was still working - were painted with the FAILURE glyph, and an
 * aborted child was counted as a failed one forever. That is not a palette
 * mistake, it is a judgement implemented in the wrong number of places.
 *
 * THE VOCABULARY IS THE DOMAIN'S (analysis A-1' item 3). `ChildStatus` reuses
 * `SubagentPhase`'s own words - `queued` / `running` / `done` / `failed` /
 * `aborted` - and never invents a second dictionary (`pending` was proposed and
 * rejected: `SubagentPhase` does not have it, and two words for one state is how
 * the tenth copy gets written).
 *
 * FIVE STATES, NOT FOUR (A-1' item 2). `aborted` is NOT a failure. The runtime
 * distinguishes them on purpose (`Runtime.settlePhase`: aborted first, then the
 * timeout, then the error), and a user pressing Esc must not read their own
 * action back as "3 failed". So `aborted` takes `glyphs.warn` and
 * `theme.noticeWarn`, which collide with neither the done tick nor the failed
 * cross in either glyph tier.
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts`'s static scan, so every
 * symbol here is injected through `pickGlyphs(caps)`.
 */

import type { Entry } from '../agent/reducer.js';
import type { SubagentRun } from '../team/types.js';
import type { Glyphs } from './glyphs.js';
import type { Theme } from './theme.js';

/**
 * The five readings a child can have on screen. A TOTAL mapping of
 * `SubagentPhase`, which is why `childStatus` needs no guard clauses: `starting`,
 * `thinking`, `tool` and `waiting` are all "this child is working right now", and
 * the per-row activity column is what tells them apart.
 */
export type ChildStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted';

const STATUS_BY_PHASE: Readonly<Record<SubagentRun['phase'], ChildStatus>> = {
  queued: 'queued',
  starting: 'running',
  thinking: 'running',
  tool: 'running',
  waiting: 'running',
  done: 'done',
  failed: 'failed',
  aborted: 'aborted',
};

/**
 * The status of one child.
 *
 * A LOOKUP TABLE RATHER THAN A SWITCH, because the mapping is the whole content
 * of this function: a `Record` keyed by the phase union is exhaustive at compile
 * time (a new phase is a missing-key error) and cannot drift from the type.
 */
export function childStatus(run: SubagentRun): ChildStatus {
  return STATUS_BY_PHASE[run.phase];
}

/** Per-status totals of a roster. `total` is the roster size, not the sum. */
export interface RosterCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  aborted: number;
  total: number;
}

/**
 * Count a roster once, by status.
 *
 * THE HEADER, THE CARD HEADLINE AND THE STATUS CHIP ALL READ THIS. Before it
 * existed the header filtered `phase !== 'queued' && ...` for "running" and the
 * card subtracted `runs.length - isOk(runs)`, so the same dispatch reported
 * `0 running` above two rows reading `queued` and `1 failed` for a child that had
 * never started.
 */
export function rosterCounts(runs: readonly SubagentRun[]): RosterCounts {
  const counts: RosterCounts = {
    queued: 0, running: 0, done: 0, failed: 0, aborted: 0, total: runs.length,
  };
  for (const run of runs) counts[childStatus(run)] += 1;
  return counts;
}

/** True while the child is doing something - the only state that animates. */
export function isRunningStatus(status: ChildStatus): boolean {
  return status === 'running';
}

/** True once the child's outcome is final, whatever it is. */
export function isSettledStatus(status: ChildStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'aborted';
}

/**
 * The static marker for a status.
 *
 * `running` gets `spinnerStill` because the animated `<Spinner>` is the caller's
 * job: it needs `reducedMotion` and `caps.unicode`, and a component that owns its
 * own `ink-spinner` is what `spinner-census.test.ts` counts. The caller swaps this
 * glyph for the spinner when it may animate.
 */
export function statusGlyph(status: ChildStatus, glyphs: Glyphs): string {
  switch (status) {
    case 'queued':
      return glyphs.toolPending;
    case 'running':
      return glyphs.spinnerStill;
    case 'done':
      return glyphs.toolDone;
    case 'failed':
      return glyphs.toolError;
    case 'aborted':
      return glyphs.warn;
  }
}

/** The widest marker this terminal's tier can produce (1 in Unicode, 4 in ASCII). */
function markerWidth(glyphs: Glyphs): number {
  return Math.max(
    glyphs.toolPending.length,
    glyphs.spinnerStill.length,
    glyphs.toolDone.length,
    glyphs.toolError.length,
    glyphs.warn.length,
  );
}

/**
 * The marker padded to the tier's widest one, for the leading cell of a row.
 *
 * THE PADDING IS NOT COSMETIC (A-1'a): the ASCII tier spells `[ok]` (4), `[x]` (3)
 * and `!` (1), so an unpadded marker cell starts every label at a different
 * column and the roster stops reading as a table. `TodoPanel` pads its marker cell
 * for the same reason. The Unicode tier's markers are all one cell wide, so the
 * padding is a no-op there.
 */
export function statusMarkerCell(status: ChildStatus, glyphs: Glyphs): string {
  return statusGlyph(status, glyphs).padEnd(markerWidth(glyphs));
}

/**
 * The colour of a status. One reading for the roster row, the card row and the
 * card's rail marker.
 *
 * `aborted` deliberately does NOT share `toolError` with `failed`: an abort is the
 * user's own Esc, and the analysis found that painting it red made a cancelled
 * dispatch permanently unreadable in the history.
 */
export function statusColor(status: ChildStatus, theme: Theme): string | undefined {
  switch (status) {
    case 'queued':
      return theme.toolPending;
    case 'running':
      return theme.toolRunning;
    case 'done':
      return theme.toolDone;
    case 'failed':
      return theme.toolError;
    case 'aborted':
      return theme.noticeWarn;
  }
}

/**
 * How long this child has been (or was) working, in ms.
 *
 * `endedAt ?? now`, NOT `endedAt ?? 0`. The transcript card used the latter, which
 * made every RUNNING child read `0ms` while the roster beside it read `1m05s` for
 * the same child - the pair of contradictory readouts the reporter screenshotted.
 */
export function childElapsedMs(run: SubagentRun, now: number): number {
  if (run.startedAt === undefined) return 0;
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

/**
 * Columns the roster header spends on `team` (plus its marker) and on the
 * incoming-message badge, so the count clauses are planned against what is left.
 */
const HEADER_RESERVED_COLS = 16;
const HEADER_MIN_CLAUSE_COLS = 12;

interface CountClause {
  /** Higher wins the width fight; see `rosterHeadline`. */
  priority: number;
  text: string;
}

function joinClauses(clauses: readonly CountClause[], glyphs: Glyphs): string {
  return clauses.map((clause) => clause.text).join(` ${glyphs.midDot} `);
}

/** Drop the clause that can be spared first, keeping display order intact. */
function dropLowestPriority(clauses: readonly CountClause[]): CountClause[] {
  let victim = 0;
  for (let index = 1; index < clauses.length; index += 1) {
    if (clauses[index]!.priority < clauses[victim]!.priority) victim = index;
  }
  return clauses.filter((_, index) => index !== victim);
}

/**
 * The roster header's count section, e.g. `2 running · 0 done · 1 queued`.
 *
 * `queued` IS COUNTED (the old `isRunning` excluded it, so a fresh dispatch
 * announced `0 running · 0 done` above five rows that each said `queued`), and a
 * non-zero bucket is always named even when nothing is running - a roster whose
 * children are all `aborted` must say so rather than `0 running · 0 done`.
 *
 * WIDTH LADDER: narrow terminals drop the least urgent clause first, in the order
 * `done`, `aborted`, `failed`, `queued`; `running` is never dropped. The order is
 * a product decision, not a detail: while a dispatch is live, what is happening
 * now outranks what has already finished, and the per-row activity column carries
 * the finished children's own facts anyway.
 */
export function rosterHeadline(counts: RosterCounts, glyphs: Glyphs, cols: number): string {
  const clauses: CountClause[] = [
    { priority: 5, text: `${counts.running} running` },
    { priority: 1, text: `${counts.done} done` },
  ];
  if (counts.queued > 0) clauses.push({ priority: 4, text: `${counts.queued} queued` });
  if (counts.failed > 0) clauses.push({ priority: 3, text: `${counts.failed} failed` });
  if (counts.aborted > 0) clauses.push({ priority: 2, text: `${counts.aborted} aborted` });
  const budget = Math.max(HEADER_MIN_CLAUSE_COLS, cols - HEADER_RESERVED_COLS);
  let kept = clauses;
  while (kept.length > 1 && joinClauses(kept, glyphs).length > budget) {
    kept = dropLowestPriority(kept);
  }
  return joinClauses(kept, glyphs);
}

/**
 * The settled card's outcome buckets, e.g. `2 ok, 1 aborted, 1 failed`.
 *
 * `ok` is always shown (it is the denominator a reader compares against) and a
 * zero bucket is omitted, so a clean dispatch still reads `3 ok` and a failed one
 * no longer claims that a cancelled child failed.
 */
export function outcomePhrase(counts: RosterCounts): string {
  const parts = [`${counts.done} ok`];
  if (counts.aborted > 0) parts.push(`${counts.aborted} aborted`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(', ');
}

/**
 * Whether this entry is the transcript card of a dispatch that is STILL RUNNING,
 * i.e. the second live surface the reporter saw beside the roster.
 *
 * ONE PREDICATE, FOUR CONSUMERS (analysis A-2'): the transcript's `case 'team'`
 * and `estimateEntryRows` (so the virtual window and the frame agree), the tail
 * window and `LiveTail` (so the pump's print plan and the box agree), and the
 * `Ctrl+O` finder plus `reprintExpanded` (so a keypress cannot print a stale
 * snapshot of a card that is still being rewritten). `state.entries` is NEVER
 * filtered: the entry's lifecycle and `session/persist.ts`'s `interrupted`
 * normalisation depend on it staying there.
 */
export function isLiveTeamCard(entry: Entry): boolean {
  return entry.kind === 'team' && entry.active === true;
}
