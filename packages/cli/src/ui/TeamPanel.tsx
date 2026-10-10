/**
 * TeamPanel — the live subagent roster (team-subagents §6.1).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`; a literal here bypasses the
 * capability probe and shows mojibake on a legacy console (`glyphs.ts` header).
 *
 * RENDERED ONLY WHILE A DISPATCH IS RUNNING (D-11). The requirement says "(dang
 * you de shi hou)" — when there is one — and a permanent zero-row region would
 * be furniture. `App` passes `null` the rest of the time and this component is
 * not mounted at all, so a session that never delegates has zero rows and zero
 * layout shift.
 *
 * IT MUST BE MOUNTED IN `AppShell`'s BOTTOM CHROME (I-10), not in the middle
 * band. The roster is transient status about the run in progress, so it belongs
 * with the other transient rows — toast, composer, status bar — rather than
 * inside the scrolling transcript, where it would be interleaved with history
 * and scroll out of sight exactly when the user wants to watch it.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { formatDuration } from '../agent/usage.js';
import { describeToolActivity, sanitizeActivity } from '../team/activity.js';
import { TEAM_LIMITS } from '../team/limits.js';
import { buildTeamPanelLayout, type TeamPanelLayout } from './layout/team-panel.js';
import type { OverseerAction, SubagentRun, TeamSnapshot } from '../team/types.js';

export interface TeamPanelProps {
  snapshot: TeamSnapshot;
  /** Terminal rows, for the one-line collapse below `panelCollapseRows`. */
  rows: number;
  /**
   * Terminal columns. REQUIRED, not optional (D-13): an optional width
   * defaulting to narrow would silently produce the degraded form forever if a
   * call site forgot it, where a required prop fails at compile time.
   */
  cols: number;
  reducedMotion: boolean;
  theme: Theme;
  caps: TermCapabilities;
  /** Injectable clock so the panel test does not depend on wall time. */
  now?: number;
  layout?: TeamPanelLayout;
}

function isRunning(run: SubagentRun): boolean {
  return run.phase === 'starting' || run.phase === 'thinking' || run.phase === 'tool' ||
    run.phase === 'waiting';
}

function isSettled(run: SubagentRun): boolean {
  return run.phase === 'done' || run.phase === 'failed' || run.phase === 'aborted';
}

function statusColor(run: SubagentRun, theme: Theme): string | undefined {
  if (run.phase === 'failed' || run.phase === 'aborted') return theme.toolError;
  if (run.phase === 'done') return theme.toolDone;
  if (isRunning(run)) return theme.toolRunning;
  return theme.muted;
}

/**
 * How many characters the activity column may spend at this width (P0-1).
 *
 * `TEAM_LIMITS.activityChars` is a STORAGE ceiling; a terminal has a COLUMN
 * budget, and the two are not the same number. The row is
 *
 *     marker(3) + label(8) + description(flex) + 2 + activity + 2 + elapsed(~6)
 *
 * and the comment on the description cell below promises that activity and
 * elapsed never lose characters, i.e. that `description` absorbs ALL width
 * pressure. A 64-character prose tail plus `writing: ` is 73, which on an
 * 80-column terminal needs 94 columns before `description` gets one. The promise
 * cannot be kept by wishing; the column has to be sized from `cols`.
 *
 * `WIDE_CHAR_ALLOWANCE` is the concession to there being no display-width helper
 * in production code: this budget is denominated in code units while the
 * terminal is denominated in columns, and CJK and emoji occupy two columns per
 * unit, so the budget is halved against the reserve rather than spent to the
 * last cell. Erring small costs a few characters of prose; erring large costs
 * the elapsed column.
 */
const ROW_RESERVED_COLS = 3 + 8 + 2 + 2 + 8 + 12; // marker, label, gaps, elapsed, min description
const WIDE_CHAR_ALLOWANCE = 2;

export function activityBudget(cols: number): number {
  const spare = Math.floor((cols - ROW_RESERVED_COLS) / WIDE_CHAR_ALLOWANCE);
  return Math.max(TEAM_LIMITS.activityMinChars, Math.min(TEAM_LIMITS.activityChars, spare));
}

/**
 * The middle column: what this child is doing right now, in a few words.
 *
 * Two width policies, answering different questions. `wide` decides WHICH FACT
 * to show - a whole path or its basename, a whole command line or its program
 * name - mirroring `StatusBar`'s `statusCompactCols` degradation rather than
 * inventing a second threshold. `activityBudget(cols)` decides HOW MUCH OF IT
 * FITS, and it is a continuous function of width rather than a threshold,
 * because the failure it prevents - a row wider than the terminal - is
 * continuous.
 *
 * Exported for the same reason `buildSubagentTools` is: the width bound is the
 * property this round has to keep, and asserting it through a rendered frame
 * cannot distinguish "the arithmetic clamped it" from "Ink truncated it" - which
 * is precisely the confusion that let v1's fixed-width column look fine at 100
 * columns and break at 80.
 */
export function activityLine(run: SubagentRun, cols: number): string {
  const wide = cols >= TEAM_LIMITS.activityWideCols;
  const budget = activityBudget(cols);
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

/** The past-tense word the supervisor badge and status line render. */
function interventionWord(action: OverseerAction): string {
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
 * The activity column WITH the badge composed in (AC-5 / risk table): the
 * badge rides the SAME `activityBudget(cols)` allocation the prose uses, so
 * a row can never grow past its terminal; on a narrow terminal the badge
 * degrades to the action word alone - the who-acted fact outranks the
 * what-they-are-doing tail exactly when there is room for only one.
 */
export function activityWithBadge(run: SubagentRun, cols: number, at: number): string {
  const last = run.lastIntervention;
  if (last === undefined) return activityLine(run, cols);
  const badge = overseerBadge(run, at);
  if (cols < TEAM_LIMITS.activityWideCols) return interventionWord(last.action);
  return sanitizeActivity(`${badge}; ${activityLine(run, cols)}`, activityBudget(cols));
}

/**
 * The panel's one supervisor status line (AC-5): the most recent intervention
 * across the roster, human-phrased. Empty when the supervisor has not acted
 * yet - furniture that says nothing is worse than no line.
 */
export function supervisorStatusLine(runs: SubagentRun[], at: number): string {
  let label = '';
  let latest: NonNullable<SubagentRun['lastIntervention']> | undefined;
  for (const run of runs) {
    const last = run.lastIntervention;
    if (last !== undefined && (latest === undefined || last.at > latest.at)) {
      latest = last;
      label = run.label;
    }
  }
  if (latest === undefined) return '';
  const ago = formatDuration(Math.max(0, at - latest.at));
  const head = latest.reasonHead.length > 0 ? ` (${latest.reasonHead})` : '';
  return `supervisor: ${interventionWord(latest.action)} ${label} ${ago} ago${head}`;
}

export function TeamPanel({
  snapshot,
  rows,
  cols,
  reducedMotion,
  theme,
  caps,
  now,
  layout,
}: TeamPanelProps): React.ReactElement | null {
  const projection = layout ?? buildTeamPanelLayout({
    snapshot, terminalRows: rows, availableRows: Infinity,
  });
  if (projection.rowCount === 0) return null;
  const glyphs = pickGlyphs(caps);
  const at = now ?? Date.now();
  const running = snapshot.runs.filter(isRunning).length;
  const done = snapshot.runs.filter(isSettled).length;
  const elapsed = formatDuration(Math.max(0, at - snapshot.startedAt));

  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate" color={theme.accent} bold>
        {glyphs.teamAgent} team{'  '}
        <Text color={theme.muted}>
          {running} running {glyphs.midDot} {done} done {glyphs.midDot} {elapsed}
        </Text>
      </Text>
      {snapshot.messageCount > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {glyphs.teamMail} {snapshot.messageCount}
        </Text>
      )}
    </Box>
  );

  // Short terminals or a long draft leave only the shared header projection,
  // which still answers whether anything is running and for how long.
  if (projection.collapsed) {
    return <Box flexDirection="column" flexShrink={0}>{header}</Box>;
  }

  // RANKED, not sliced by array index (F-2). The slot pool hands out indices in
  // order, so `slice(0, 5)` showed the five children that finished FIRST and hid
  // everything still working behind `+N more` - at exactly the fan-out widths
  // the requirement permits.
  const { visible, hiddenTotal, hiddenRunning } = projection;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {header}
      {visible.map((run) => {
        const color = statusColor(run, theme);
        // One spinner per RUNNING row, and the row cap is 5 precisely because
        // five is the documented maximum number of simultaneous spinners. Both
        // `reducedMotion` and a non-Unicode terminal fall back to the same
        // static marker, exactly as `AssistantEntry` and `ToolCard` already do.
        const animate = isRunning(run) && !reducedMotion && caps.unicode;
        return (
          <Box key={run.label} flexDirection="row">
            <Text color={color}>
              {' '}
              {animate ? <Spinner type="dots" /> : marker(run, glyphs)}{' '}
            </Text>
            <Text color={theme.primary}>
              {run.label.padEnd(8).slice(0, 8)}
            </Text>
            {/*
              The description is the ONLY flexible column, so the activity and
              elapsed columns never lose characters under width pressure — the
              same degradation discipline `StatusBar` documents for its left
              cluster.
            */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={theme.muted}>
                {/* Truncation preserves explicit newlines; the shared budget
                    reserves one row, so normalize only the display copy. */}
                {run.description.replace(/\s+/g, ' ')}
              </Text>
            </Box>
            {/*
              BELT AND BRACES, on purpose (P0-1). `activityBudget` keeps the row
              READABLE; `flexShrink` plus `overflow` keeps a miscounted wide
              character from pushing the elapsed column off the screen. Neither
              alone is sufficient: arithmetic cannot see double-width glyphs, and
              flex-shrink alone would silently eat the whole column at 80 columns
              instead of showing a short, true phrase.
            */}
            <Box flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={color}>
                {'  '}
                {activityWithBadge(run, cols, at)}
              </Text>
            </Box>
            <Text wrap="truncate" color={theme.muted}>
              {'  '}
              {run.startedAt ? formatDuration(Math.max(0, (run.endedAt ?? at) - run.startedAt)) : ''}
            </Text>
          </Box>
        );
      })}
      {hiddenTotal > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'  '}+{hiddenTotal} more
          {hiddenRunning > 0 ? ` (${hiddenRunning} running)` : ''}
        </Text>
      )}
      {(() => {
        // The panel's supervisor line (AC-5): one row, only when the
        // supervisor has actually acted - the per-row badges above already
        // carry the per-child facts.
        const line = supervisorStatusLine(snapshot.runs, at);
        return line ? (
          <Text wrap="truncate" color={theme.muted}>
            {'  '}{line}
          </Text>
        ) : null;
      })()}
      {snapshot.lastMessage && (
        <Text wrap="truncate" color={theme.muted}>
          {' '}
          {glyphs.teamMail} {snapshot.lastMessage.from} {glyphs.arrowRight} {snapshot.lastMessage.to}
          : {snapshot.lastMessage.subject.replace(/\s+/g, ' ')}
        </Text>
      )}
    </Box>
  );
}

function marker(run: SubagentRun, glyphs: ReturnType<typeof pickGlyphs>): string {
  if (run.phase === 'done') return glyphs.toolDone;
  if (run.phase === 'failed' || run.phase === 'aborted') return glyphs.toolError;
  if (run.phase === 'queued') return glyphs.toolPending;
  return glyphs.spinnerStill;
}
