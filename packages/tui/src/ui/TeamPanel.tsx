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
 *
 * IT IS THE ONLY LIVE SUBAGENT SURFACE (tui-subagent-double-roster A-2). The
 * transcript's `team` card is suppressed while its dispatch is active
 * (`team-status.ts::isLiveTeamCard`), so this roster is what the user watches
 * during a dispatch and the card becomes the history afterwards. Native mode
 * draws it as the band's BOTTOM, FULL-WIDTH slot (`ScrollbackShell`), i.e.
 * directly above the composer and spanning the TODO rail's columns as well; the
 * full-screen mode draws it in the viewport footer, which is already above the
 * composer.
 *
 * THE ROW IS A TABLE, NOT A PARAGRAPH (tui-subagent-panel §0.1 / §4.2). The
 * columns are placed by COMPUTED widths (`layout/team-row.ts`) inside fixed-width
 * boxes, never by `flexGrow`: a fixed-height parent box makes Yoga size a column
 * to its widest child, so the old row measured 48 columns inside a 100-column
 * terminal and the clock stopped beside the description instead of at the right
 * edge. The description is the only flexible cell, which is what keeps the two
 * right-hand cells at their absolute offsets.
 *
 * EVERY PHASE -> GLYPH / COLOUR / COUNT DECISION COMES FROM `team-status.ts`.
 * The local copies this file used to carry are gone on purpose: the transcript
 * card kept a second copy and the two disagreed about what "running" looks like.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import {
  childStatus,
  isRunningStatus,
  rosterCounts,
  rosterHeadline,
  statusColor,
} from './team-status.js';
import { formatDuration } from '../model/agent/usage.js';
import { buildTeamPanelLayout, type TeamPanelLayout } from './layout/team-panel.js';
import {
  interventionWord,
  teamRowCells,
  teamRowGeometry,
  TEAM_CLOCK_CELLS,
} from './layout/team-row.js';
import { fitCells } from './layout/cells.js';
import type { SubagentRun, TeamSnapshot } from '../model/team/types.js';
import type { VoiceContext } from './tool-voice.js';

/**
 * THE ACTIVITY / BADGE HELPERS LIVE IN `layout/team-row.ts` NOW (v2 implementation
 * note, recorded in the spec's "implementation findings"). `teamRowCells` has to
 * compose the activity text with the supervisor badge, so keeping those functions
 * in this component would make the two modules import each other. They are
 * re-exported here so every existing import site keeps its path.
 */
export {
  activityBudget,
  activityLine,
  activityWithBadge,
  overseerBadge,
  teamClockText,
  teamRowCells,
  teamRowGeometry,
} from './layout/team-row.js';

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

/** Columns the `ctrl+b` hint cell spends, and the width below which it is dropped. */
const HINT_CELLS = 'ctrl+b'.length;
const HINT_MIN_COLS = 100;

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
  /**
   * How names and activity are worded. REQUIRED, like `cols` (D-13/D-15): an optional
   * voice defaulting to developer wording would silently drop the persona names
   * forever if a call site forgot it, where a required prop fails at compile time.
   * A prop and not a React context, because the native scrollback replay renders in a
   * second Ink instance that has no provider.
   */
  voice: VoiceContext;
  theme: Theme;
  caps: TermCapabilities;
  /** Injectable clock so the panel test does not depend on wall time. */
  now?: number;
  layout?: TeamPanelLayout;
}

export function TeamPanel({
  snapshot,
  rows,
  cols,
  reducedMotion,
  voice,
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
  // ONE COUNTING AUTHORITY (A-1): `queued` used to fall between `isRunning` and
  // `isSettled`, so a fresh dispatch read `0 running  0 done` above rows that each
  // said `queued`.
  const counts = rosterCounts(snapshot.runs);
  const elapsed = formatDuration(Math.max(0, at - snapshot.startedAt));
  const g = teamRowGeometry(cols, glyphs, { showName: true });
  // The description is the one elastic cell; its width is what the fixed cells leave.
  // Clamped here with the TIER's ellipsis rather than left to Ink's `wrap="truncate"`,
  // which draws a non-ASCII ellipsis even on a terminal without Unicode.
  const descriptionCells = Math.max(
    0, cols - g.marker - g.name - g.label - g.gap - g.activity - g.clock,
  );

  // WIDTH IS BUDGETED ONCE (I-13). `rosterHeadline` subtracts its own
  // HEADER_RESERVED_COLS(16) - it takes the ROW's column count, not a budget - so
  // the caller may only take away the cells this feature ADDS. Subtracting 16 here
  // too would spend the reserve twice and drop `done` / `queued` from a 100-column
  // header that has room for them.
  const showHint = cols >= HINT_MIN_COLS && !projection.collapsed;
  const headlineCols = Math.max(0, cols - TEAM_CLOCK_CELLS - (showHint ? HINT_CELLS : 0));
  const mailText = `${glyphs.teamMail} ${snapshot.messageCount}`;
  // The badge takes its NATURAL width and the flexible left cell gives way: it is
  // the only header cell whose content length varies, and pinning it to a computed
  // width would clip `@ 12` on a row that has room for it.
  const mailCells = Math.min(mailText.length, Math.max(0, cols - TEAM_CLOCK_CELLS));

  /**
   * The header is the row's own geometry one level up: a flexible left cell and
   * fixed right-hand cells, so the dispatch clock and every child clock stand in
   * the SAME column (I-5 / AC-2).
   *
   * THE ELAPSED TIME APPEARS ONLY IN THE CLOCK CELL (§4.3 / RV-P2-9). The old
   * header also carried it inline among the count clauses; with a right-edge clock
   * that would be the same number twice, and the pair could disagree for one frame
   * every 200 ms.
   */
  const header = (
    <Box flexDirection="row" width="100%" height={1} flexShrink={0} overflow="hidden">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate" color={theme.accent} bold>
          {glyphs.teamAgent}{' team  '}
          <Text color={theme.muted}>{rosterHeadline(counts, glyphs, headlineCols)}</Text>
        </Text>
      </Box>
      {showHint && (
        <Box width={HINT_CELLS} flexShrink={0} justifyContent="flex-end">
          <Text color={theme.hintFg}>ctrl+b</Text>
        </Box>
      )}
      {snapshot.messageCount > 0 && (
        <Box width={mailCells} flexShrink={0} justifyContent="flex-end">
          <Text wrap="truncate" color={theme.muted}>{mailText}</Text>
        </Box>
      )}
      <Box width={TEAM_CLOCK_CELLS} flexShrink={0} justifyContent="flex-end">
        <Text wrap="truncate" color={theme.accent} bold>{elapsed}</Text>
      </Box>
    </Box>
  );

  // Short terminals or a long draft leave only the shared header projection,
  // which still answers whether anything is running and for how long. The header
  // keeps the count clauses AND the right-edge clock, so the collapsed form loses
  // no information - only the per-child rows.
  if (projection.collapsed) {
    return <Box flexDirection="column" width="100%" flexShrink={0}>{header}</Box>;
  }

  // RANKED, not sliced by array index (F-2). The slot pool hands out indices in
  // order, so `slice(0, 5)` showed the five children that finished FIRST and hid
  // everything still working behind `+N more` - at exactly the fan-out widths
  // the requirement permits.
  const { visible, hiddenTotal, hiddenRunning } = projection;
  const supervisorLine = supervisorStatusLine(snapshot.runs, at);

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      {header}
      {visible.map((run) => {
        const status = childStatus(run);
        const color = statusColor(status, theme);
        // One spinner per RUNNING row, and the row cap is 5 precisely because
        // five is the documented maximum number of simultaneous spinners. Both
        // `reducedMotion` and a non-Unicode terminal fall back to the same
        // static marker, exactly as `AssistantEntry` and `ToolCard` already do.
        const animate = isRunningStatus(status) && !reducedMotion && caps.unicode;
        const cells = teamRowCells(run, cols, at, glyphs, voice);
        return (
          <Box key={run.label} flexDirection="row" width="100%" height={1}
            flexShrink={0} overflow="hidden">
            <Box width={g.marker} flexShrink={0}>
              <Text wrap="truncate" color={color}>
                {' '}
                {animate ? <Spinner type="dots" /> : cells.marker}
                {' '}
              </Text>
            </Box>
            {/* THE NAME IS THE LEAD, THE ROLE THE SUPPORTING WORD: bold primary beside a
                muted label makes the hierarchy readable at a glance. */}
            {g.name > 0 && (
              <Box width={g.name} flexShrink={0}>
                <Text wrap="truncate" color={theme.primary} bold>{cells.name}</Text>
              </Box>
            )}
            <Box width={g.label} flexShrink={0}>
              <Text wrap="truncate" color={theme.muted}>{cells.label}</Text>
            </Box>
            {/*
              The description is the ONLY flexible column, so the activity and
              clock cells never lose characters under width pressure - the same
              degradation discipline `StatusBar` documents for its left cluster.
              Its width is whatever the fixed cells leave, and `teamRowGeometry`
              has already proven that to be >= 0.
            */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={theme.muted}>
                {fitCells(cells.description, descriptionCells, glyphs.ellipsis)}
              </Text>
            </Box>
            <Box width={g.gap} flexShrink={0}><Text> </Text></Box>
            <Box width={g.activity} flexShrink={0} overflow="hidden">
              <Text wrap="truncate" color={color}>{cells.activity}</Text>
            </Box>
            {/* THE CLOCK IS THE ROW'S LAST CELL and it is right-aligned inside a
                fixed box, so its last character lands on the row's last column
                whatever the cell contains (I-5). */}
            <Box width={g.clock} flexShrink={0} justifyContent="flex-end">
              <Text wrap="truncate" color={theme.muted}>{cells.clock}</Text>
            </Box>
          </Box>
        );
      })}
      {hiddenTotal > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'  '}+{hiddenTotal} more
          {hiddenRunning > 0 ? ` (${hiddenRunning} running)` : ''}
        </Text>
      )}
      {supervisorLine.length > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'  '}{fitCells(supervisorLine, Math.max(0, cols - 2), glyphs.ellipsis)}
        </Text>
      )}
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
