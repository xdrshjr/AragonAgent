/** Legacy activity presentation. Explicit facts share the global status label mapping.
 * StatusBar owns the application's sole live spinner via the factory below.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { pickActivityPhrase } from './activity-phrases.js';
import type { RunActivity } from './run-status-row.js';
import { phaseLabels } from './layout/status-layout.js';

/** Shared animation factory; returns null for ASCII or reduced-motion terminals. */
export function liveSpinner(
  reducedMotion: boolean,
  caps: TermCapabilities,
): React.ReactElement | null {
  return caps.unicode && !reducedMotion ? <Spinner type="dots" /> : null;
}

/** Explicit execution facts outrank compatibility tool names and rotating phrases. */
export function resolveActivityLabel(
  activity: RunActivity,
  glyphs: ReturnType<typeof pickGlyphs>,
): string {
  if (activity.phase !== undefined || activity.activeTool !== undefined || activity.outcome !== undefined) {
    return phaseLabels({
      phase: activity.phase ?? (activity.activeTool ? 'tool' : 'idle'),
      activeTool: activity.activeTool, runOutcome: activity.outcome, compacting: activity.compacting,
    })[1];
  }
  if (activity.compacting) return `Compacting context${glyphs.ellipsis}`;
  if (activity.runningTool) return `Running ${activity.runningTool}`;
  // PURE AND DERIVED FROM `(startedAt, now)`, so the sequence does not need to
  // keep rotating underneath the tool label: when the tool settles the phrase
  // resumes at the position the clock implies, with no state anywhere.
  const phrase = pickActivityPhrase(
    activity.startedAt,
    activity.startedAt + activity.elapsedMs,
    !activity.reducedMotion,
  );
  return `${phrase}${glyphs.ellipsis}`;
}

export interface ActivityLabelProps extends RunActivity {
  /**
   * False forces a static glyph. Compatibility phrases still follow reducedMotion.
   */
  spinnerLive?: boolean;
  /** Prefix one space for compatibility line consumers. */
  leadingSpace?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/** `<spinner> <label>` as ONE truncating `<Text>`; the only place that composes them. */
export function ActivityLabel({
  spinnerLive = true,
  leadingSpace = false,
  theme,
  caps,
  ...activity
}: ActivityLabelProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const label = resolveActivityLabel(activity, glyphs);
  const settled = activity.phase === 'idle' || (activity.phase === undefined
    && activity.outcome !== undefined && activity.outcome !== 'none' && !activity.activeTool);
  const spinner = (spinnerLive && (!settled || activity.compacting) ? liveSpinner(activity.reducedMotion, caps) : null) ??
    glyphs.spinnerStill;
  return (
    <Text wrap="truncate" color={theme.thinking}>
      {leadingSpace ? ' ' : ''}
      {spinner} {label}
    </Text>
  );
}

export type ActivityLineProps = Omit<ActivityLabelProps, 'spinnerLive' | 'leadingSpace'>;

export function ActivityLine(props: ActivityLineProps): React.ReactElement {
  return (
    <Box flexShrink={0}>
      <ActivityLabel {...props} leadingSpace />
    </Box>
  );
}
