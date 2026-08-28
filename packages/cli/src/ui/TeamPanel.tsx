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
import { selectPanelRows } from '../team/panel-rows.js';
import type { SubagentRun, TeamSnapshot } from '../team/types.js';

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

export function TeamPanel({
  snapshot,
  rows,
  cols,
  reducedMotion,
  theme,
  caps,
  now,
}: TeamPanelProps): React.ReactElement {
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

  // Below 20 rows the roster is more expensive than the transcript it displaces,
  // so the panel degrades to the one line that still answers "is something
  // running, and for how long" (§6.4).
  if (rows < TEAM_LIMITS.panelCollapseRows) {
    return <Box flexDirection="column" flexShrink={0}>{header}</Box>;
  }

  // RANKED, not sliced by array index (F-2). The slot pool hands out indices in
  // order, so `slice(0, 5)` showed the five children that finished FIRST and hid
  // everything still working behind `+N more` - at exactly the fan-out widths
  // the requirement permits.
  const { visible, hiddenTotal, hiddenRunning } = selectPanelRows(
    snapshot.runs,
    TEAM_LIMITS.panelMaxRows,
  );

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
            {/* A trailing `~` marks a fast-tier child, inside the existing
                8-column label field — see the note in `TeamCard`. */}
            <Text color={theme.primary}>
              {`${run.label}${run.tier === 'fast' ? '~' : ''}`.padEnd(8).slice(0, 8)}
            </Text>
            {/*
              The description is the ONLY flexible column, so the activity and
              elapsed columns never lose characters under width pressure — the
              same degradation discipline `StatusBar` documents for its left
              cluster.
            */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={theme.muted}>
                {run.description}
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
                {activityLine(run, cols)}
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
      {snapshot.lastMessage && (
        <Text wrap="truncate" color={theme.muted}>
          {' '}
          {glyphs.teamMail} {snapshot.lastMessage.from} {glyphs.arrowRight} {snapshot.lastMessage.to}
          : {snapshot.lastMessage.subject}
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
