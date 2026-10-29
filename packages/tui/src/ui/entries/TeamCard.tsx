/**
 * TeamCard — the settled-dispatch transcript entry (team-subagents §6.3).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`.
 *
 * The panel is EPHEMERAL and this card is the HISTORY. It renders like a
 * `ToolCard` — same `EntryFrame` supplied by `EntryView`, same left rail for the
 * expanded body — so a dispatch reads as one more step in the transcript rather
 * than a second kind of object.
 *
 * `Ctrl+O` expands it to the per-agent summaries, which is why `App.tsx`'s
 * Ctrl+O finder had to widen from `kind === 'tool'` to `tool || team`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { formatDuration } from '../../model/agent/usage.js';
import type { SubagentRun } from '../../model/team/types.js';
import type { VoiceContext } from '../tool-voice.js';
import {
  childElapsedMs,
  childStatus,
  outcomePhrase,
  rosterCounts,
  statusColor,
  statusMarkerCell,
  type RosterCounts,
} from '../team-status.js';

export interface TeamCardProps {
  requested: number;
  runs: SubagentRun[];
  aborted: boolean;
  durationMs?: number;
  active: boolean;
  expanded?: boolean;
  reducedMotion?: boolean;
  /**
   * Names the children (already bound to this dispatch's scope by the caller). A
   * REQUIRED prop for the reason `TeamPanel.voice` records: no context, and a
   * forgotten call site is a compile error instead of a card with no names.
   */
  voice: VoiceContext;
  theme: Theme;
  caps: TermCapabilities;
  /**
   * Wall-clock seconds, set only while the dispatch is live (`nowSecFor`). WITHOUT
   * IT a running child's elapsed time came from `(endedAt ?? 0) - startedAt` - a
   * negative number clamped to `0ms`, the readout that contradicted the roster
   * beside it (A-1 / E4).
   */
  nowSec?: number;
}

/**
 * The card's aggregate colour.
 *
 * FAILURES DOMINATE, THEN A CANCELLATION, THEN A DISPATCH THAT NEVER SETTLED.
 * The old version asked `runs.some((r) => !isOk(r))`, so an entry whose children
 * were still working - and one the user had cancelled - was painted `toolError`
 * (A-1 / E8). `RosterCounts` is passed IN rather than recomputed, so this colour
 * and the headline cannot disagree inside one card.
 */
export function teamCardColor(
  counts: RosterCounts,
  active: boolean,
  aborted: boolean,
  theme: Theme,
): string | undefined {
  if (active) return theme.toolRunning;
  if (counts.failed > 0) return theme.toolError;
  if (aborted || counts.aborted > 0 || counts.queued > 0 || counts.running > 0) {
    return theme.noticeWarn;
  }
  return theme.toolDone;
}

/** `nowSec` is seconds (`App`'s 1 Hz clock); a card measures in milliseconds. */
function liveClockMs(nowSec: number | undefined): number {
  return nowSec === undefined ? Date.now() : nowSec * 1000;
}

/**
 * The elapsed column for one child: a MEASUREMENT, or an empty cell.
 *
 * `liveNow` is defined only while the dispatch is live, and that distinction is the
 * whole point. A child restored by `/resume` keeps its `startedAt` and has no
 * `endedAt` - `session/persist.ts` settles the ENTRY, it does not invent an end time
 * for the run - so a figure computed against `Date.now()` would claim hours of work
 * that never happened, next to an `interrupted (session resumed)` headline that says
 * the opposite. An unmeasurable duration is left blank instead.
 */
function elapsedCell(run: SubagentRun, liveNow: number | undefined): string {
  const end = run.endedAt ?? liveNow;
  if (run.startedAt === undefined || end === undefined) return '';
  return formatDuration(childElapsedMs(run, end));
}

function TeamCardImpl(props: TeamCardProps): React.ReactElement {
  const { requested, runs, aborted, durationMs, active, expanded, reducedMotion, theme, caps } =
    props;
  const glyphs = pickGlyphs(caps);
  // ONE COUNTING AUTHORITY (A-1): `ok`/`failed` used to be `isOk(...)` and
  // `runs.length - ok`, which counted a cancelled child - and a still-working one -
  // as a failed one (E3 / E8).
  const counts = rosterCounts(runs);
  const color = teamCardColor(counts, active, aborted, theme);
  // A CLOCK ONLY WHILE THE DISPATCH IS LIVE: a settled card has nothing left to time,
  // and a clock in the settled path is how a resumed dispatch came to read like a run
  // that is still going (`elapsedCell`).
  const liveNow = active ? liveClockMs(props.nowSec) : undefined;

  // A dispatch entry restored from `/resume` is settled and aborted but has no
  // duration: nothing measured it, because the process it belonged to is gone.
  // Saying so plainly beats rendering `0.0s (0 ok, 3 failed)`, which reads like
  // a dispatch that ran and lost (§5.3 / P1-5).
  const interrupted = !active && aborted && durationMs === undefined;

  const headline = interrupted
    ? 'interrupted (session resumed)'
    : active
    ? `${counts.queued + counts.running} running`
    : `${formatDuration(durationMs ?? 0)}  (${outcomePhrase(counts)})`;

  const count = `${runs.length} ${runs.length === 1 ? 'subagent' : 'subagents'}`;
  const dropped = requested > runs.length ? `  (${runs.length} of ${requested} requested)` : '';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.accent} bold>
          team
        </Text>
        <Text color={theme.muted}>
          {' '}
          {count}
          {dropped}
          {'  '}
        </Text>
        {active && !reducedMotion && caps.unicode ? (
          <Text color={color}>
            <Spinner type="dots" /> {headline}
          </Text>
        ) : (
          <Text color={color}>
            {active ? `${glyphs.spinnerStill} ` : ''}
            {headline}
          </Text>
        )}
      </Box>

      <Box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        {...railBorderProps(glyphs.railVertical, theme.border)}
      >
        {runs.map((run) => (
          <Text key={run.label} wrap="truncate">
            {/*
              ONE STATUS AUTHORITY (A-1): this used to be the binary `isOk` fallback
              (`phase === 'done' && !error`), which painted six of the eight phases -
              every child that was still working - with the FAILURE cross, and left a
              cancelled child indistinguishable from a broken one (E3 / E8).
            */}
            <Text color={statusColor(childStatus(run), theme)}>
              {statusMarkerCell(childStatus(run), glyphs)}
            </Text>
            {/*
              A TRAILING `~` MARKS A FAST-TIER CHILD, inside the existing
              8-column label field rather than beside it: the roster's columns
              are already tight at 80 columns, and one ASCII character is
              cheaper than a ninth column. ASCII literal, not a glyph, because
              `src/team/**` and this file are both glyph-scanned and `~` is safe
              on every terminal.
            */}
            <Text color={theme.primary} bold>
              {' '}
              {props.voice.nameOf(run.label).padEnd(7).slice(0, 7)}
            </Text>
            <Text color={theme.muted}>
              {run.label.padEnd(8).slice(0, 8)}
            </Text>
            <Text color={theme.muted}>
              {' '}
              {run.description}
              {'  '}
              {elapsedCell(run, liveNow)}
              {`  ${run.turns} turns`}
              {run.filesTouched.length > 0 ? `  ${run.filesTouched.length} files` : ''}
              {run.error ? `  ${run.error}` : ''}
            </Text>
            {/*
              A child's API retry (llm-api-retry-backoff §6.10 / R-14). Without this
              a subagent spending three minutes in backoff shows nothing anywhere —
              its `retry_scheduled` reaches its OWN `Agent` listeners and never the
              lead's `ViewState` — and the dispatch simply appears hung.
              Warn-toned and appended rather than replacing the phase, because the
              scheduler still considers the child to be thinking.
            */}
            {run.retry && (
              <Text color={theme.noticeWarn} bold>
                {'  '}retry {run.retry.attempt}/{run.retry.maxRetries}
              </Text>
            )}
          </Text>
        ))}

        {expanded &&
          runs.map((run) => (
            <Box key={`s-${run.label}`} flexDirection="column" marginTop={1}>
              <Text color={theme.accent}>
                {run.label} {glyphs.midDot} {run.description}
              </Text>
              <Text color={theme.muted}>{run.summary ?? '(no summary)'}</Text>
            </Box>
          ))}

        {!expanded && !active && runs.length > 0 && (
          <Text color={theme.muted}>
            +{runs.length} {runs.length === 1 ? 'summary' : 'summaries'} (Ctrl+O)
          </Text>
        )}
        {expanded && <Text color={theme.muted}>(Ctrl+O to collapse)</Text>}
      </Box>
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` already preserves object identity for untouched entries, so the
 * array props below are stable references on a settled card, and `theme` /
 * `caps` are `useMemo`d in `App.tsx` (I-L2-1).
 */
export const TeamCard = React.memo(TeamCardImpl);
