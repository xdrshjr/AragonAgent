/**
 * WaitCard - the five-row card a running `job_wait` is drawn as
 * (extended-job-wait §3.8.2).
 *
 * ASCII ONLY: every non-ASCII cell is a `pickGlyphs` result and every sentence the
 * user did not get from the job itself is in `interactionCopy`.
 *
 * FIVE ROWS, IN EVERY STATE (I-10). A branch may change what a row SAYS, never how
 * many rows there are: `estimateEntryRows` charges exactly `separation + 5`, and a
 * card that is one row short makes the viewport jump while one row long makes the
 * height estimate an under-count - the direction `virtual-window.ts` names unsafe.
 * Every row is `wrap="truncate"` for the same reason.
 *
 * ONE CLOCK. Every number is a subtraction between an epoch stamped by
 * `buildWaitView` and the `nowSec` the transcript already ticks at 1 Hz; there is
 * no timer in this file, and the spinner is the app's shared factory, which this
 * card REPLACES `ToolCard`'s badge with rather than adding to.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { liveSpinner } from '../ActivityLine.js';
import { railBorderProps } from '../layout/Gutter.js';
import { interactionCopy } from '../interaction-copy.js';
import {
  WAIT_BAR_MIN_COLS,
  barCellsFor,
  formatWaitClock,
  percentOf,
  renderBar,
} from '../layout/wait-bar.js';
import type { WaitView } from '../../model/proc/wait-view.js';

export interface WaitCardProps {
  view: WaitView;
  /** Wall-clock seconds from the transcript's 1 Hz clock; absent before the first tick. */
  nowSec?: number | undefined;
  reducedMotion?: boolean | undefined;
  theme: Theme;
  caps: TermCapabilities;
}

/** Empty `<Text>` measures zero rows in Ink, so a blank row is drawn as a space. */
function filled(text: string): string {
  return text.length > 0 ? text : ' ';
}

function WaitCardImpl(props: WaitCardProps): React.ReactElement {
  const { view, reducedMotion, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  // Before the first tick the clock reads the instant the wait began.
  const nowMs = Math.max(
    view.waitStartedAt,
    props.nowSec !== undefined ? props.nowSec * 1000 : view.waitStartedAt,
  );
  const waited = nowMs - view.waitStartedAt;
  const remaining = Math.max(0, view.upToMs - waited);
  const upTo = formatWaitClock(view.upToMs);
  const dot = ` ${glyphs.midDot} `;

  // ROW 1 - what, and the clock.
  const spinner = liveSpinner(reducedMotion ?? false, caps);
  const title = `Waiting for ${view.jobLabel}`;
  const clock = `${formatWaitClock(waited)} of ${upTo}`;

  // ROW 2 - the bar. THE JOB'S OWN PROGRESS WINS; with none, the bar shows the wait
  // window itself and the words say so (D-10), so the two meanings never share a
  // bar silently.
  const jobFraction = view.progress?.fraction ?? null;
  const windowFraction = view.upToMs > 0 ? waited / view.upToMs : 0;
  const barFraction = jobFraction ?? windowFraction;
  const showBar = cols >= WAIT_BAR_MIN_COLS;
  const bar = showBar
    ? `${renderBar(barFraction, barCellsFor(cols), glyphs)}  `
    : '';
  let barText: string;
  if (jobFraction !== null && view.progress) {
    barText =
      view.progress.kind === 'percent'
        ? view.progress.text
        : `${percentOf(jobFraction)}%  ${view.progress.text}`;
  } else {
    barText = `${percentOf(windowFraction)}%  of this ${upTo} wait`;
    if (view.progress) barText += `  ${view.progress.text}`;
  }

  // ROW 3 - the two clocks.
  let clocks: string;
  if (view.jobLabel.endsWith(' jobs')) {
    const rule = view.mode === 'any' ? 'ANY finishes' : 'ALL finish';
    clocks = `${view.liveJobs} ${view.liveJobs === 1 ? 'job' : 'jobs'} live${dot}this wait ends when ${rule}`;
  } else {
    clocks =
      `job ${view.status} ${formatWaitClock(Math.max(0, nowMs - view.jobStartedAt))}${dot}` +
      `this wait ends in ${formatWaitClock(remaining)}, or sooner if the job finishes`;
  }

  // ROW 4 - what the job last said, or a calm note that silence is not failure (D-11).
  const quietMs = Math.max(0, nowMs - view.lastOutputAt);
  const quiet = view.lastRow !== undefined && quietMs > view.stallSeconds * 1000;
  const lastRowText = quiet
    ? `quiet for ${formatWaitClock(quietMs)} - the job is still alive; this is not a failure`
    : (view.lastRow ?? 'no output yet');
  const ago = view.lastRow !== undefined && !quiet ? `${formatWaitClock(quietMs)} ago` : '';

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {spinner ? <Text color={theme.toolRunning}>{spinner} </Text> : (
          <Text color={theme.toolRunning}>{glyphs.spinnerStill} </Text>
        )}
        <Text color={theme.accent} bold>
          {title}
        </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={theme.muted} wrap="truncate">
            {view.command.length > 0 ? `  ${view.command}` : ' '}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color={theme.muted}> {clock}</Text>
        </Box>
      </Box>
      <Box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        {...railBorderProps(glyphs.railVertical, theme.border)}
      >
        <Text wrap="truncate">
          <Text color={theme.toolRunning}>{bar}</Text>
          <Text color={theme.primary}>{filled(barText)}</Text>
        </Text>
        <Text color={theme.muted} wrap="truncate">
          {filled(clocks)}
        </Text>
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text color={quiet ? theme.noticeWarn : theme.muted} wrap="truncate">
              {filled(lastRowText)}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={theme.muted}>{ago.length > 0 ? ` ${ago}` : ' '}</Text>
          </Box>
        </Box>
        <Text color={theme.muted} wrap="truncate">
          {interactionCopy.waitHintSend}
          {dot}
          {interactionCopy.waitHintStop}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator: the reducer writes a fresh `view`
 * object once a second, which is exactly the one change that must re-render.
 */
export const WaitCard = React.memo(WaitCardImpl);
