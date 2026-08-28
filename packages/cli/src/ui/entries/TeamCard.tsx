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
import { formatDuration } from '../../agent/usage.js';
import type { SubagentRun } from '../../team/types.js';

export interface TeamCardProps {
  requested: number;
  runs: SubagentRun[];
  aborted: boolean;
  durationMs?: number;
  active: boolean;
  expanded?: boolean;
  reducedMotion?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

function isOk(run: SubagentRun): boolean {
  return run.phase === 'done' && !run.error;
}

/** The card's aggregate colour: any failure dominates. */
export function teamCardColor(
  runs: SubagentRun[],
  active: boolean,
  aborted: boolean,
  theme: Theme,
): string | undefined {
  if (active) return theme.toolRunning;
  if (aborted || runs.some((r) => !isOk(r))) return theme.toolError;
  return theme.toolDone;
}

function TeamCardImpl(props: TeamCardProps): React.ReactElement {
  const { requested, runs, aborted, durationMs, active, expanded, reducedMotion, theme, caps } =
    props;
  const glyphs = pickGlyphs(caps);
  const color = teamCardColor(runs, active, aborted, theme);
  const ok = runs.filter(isOk).length;
  const failed = runs.length - ok;

  // A dispatch entry restored from `/resume` is settled and aborted but has no
  // duration: nothing measured it, because the process it belonged to is gone.
  // Saying so plainly beats rendering `0.0s (0 ok, 3 failed)`, which reads like
  // a dispatch that ran and lost (§5.3 / P1-5).
  const interrupted = !active && aborted && durationMs === undefined;

  const settled = runs.filter(
    (r) => r.phase === 'done' || r.phase === 'failed' || r.phase === 'aborted',
  ).length;
  const headline = interrupted
    ? 'interrupted (session resumed)'
    : active
    ? `${runs.length - settled} running`
    : `${formatDuration(durationMs ?? 0)}  (${ok} ok, ${failed} failed)`;

  const count = `${runs.length} ${runs.length === 1 ? 'subagent' : 'subagents'}`;
  const dropped = requested > runs.length ? `  (${runs.length} of ${requested} requested)` : '';
  // ABSENT WHEN NO FAST CHILD RAN, so an ordinary dispatch's card is unchanged
  // (fast-model-tier §6). `n fast` rather than a ratio: the total is already one
  // column to the left.
  const fastCount = runs.filter((r) => r.tier === 'fast').length;
  const fastNote = fastCount > 0 ? `  ${fastCount} fast` : '';

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
          {fastNote}
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
            <Text color={isOk(run) ? theme.toolDone : theme.toolError}>
              {isOk(run) ? glyphs.toolDone : glyphs.toolError}
            </Text>
            {/*
              A TRAILING `~` MARKS A FAST-TIER CHILD, inside the existing
              8-column label field rather than beside it: the roster's columns
              are already tight at 80 columns, and one ASCII character is
              cheaper than a ninth column. ASCII literal, not a glyph, because
              `src/team/**` and this file are both glyph-scanned and `~` is safe
              on every terminal.
            */}
            <Text color={theme.primary}>
              {' '}
              {`${run.label}${run.tier === 'fast' ? '~' : ''}`.padEnd(8).slice(0, 8)}
            </Text>
            <Text color={theme.muted}>
              {' '}
              {run.description}
              {'  '}
              {run.startedAt ? formatDuration(Math.max(0, (run.endedAt ?? 0) - run.startedAt)) : ''}
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
