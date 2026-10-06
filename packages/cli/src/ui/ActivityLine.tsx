/**
 * The live working line (agent-activity-presentation §3.2.2).
 *
 * Exactly one row, immediately above the composer, while a run is in flight:
 *
 *     * Percolating...
 *
 * THE ROW CARRIES THE PHRASE AND NOTHING ELSE, AND THAT IS THE WHOLE OF ITS
 * DESIGN (D-5 / P1-1). No elapsed clock, no token count, no `esc abort`, at any
 * width. Every one of those is already on screen while running: the status bar
 * renders `formatDuration(elapsedMs)` under exactly the `running` condition that
 * mounts this row and the token cluster at `cols >= 72`, and both composers carry
 * the abort hint. Duplicated rows are precisely what the v0.4.0 removal of the
 * status bar's hint cluster was for, and that rule does not distinguish between a
 * duplicated string and a duplicated number.
 *
 * Because there are no clusters there is NO WIDTH LADDER: one row, one
 * truncating `<Text>`, identical at 200 columns and at 40. `cols` is therefore
 * not a prop — nothing on the row depends on width, and a prop that changed on
 * every resize but was never read would be a false dependency on a memo boundary.
 *
 * What is left is the one thing the status bar cannot say: THAT THE SILENCE IS
 * WORK. The bar shows state; this row shows life.
 *
 * THIS ROW OWNS THE ONLY ANIMATED SPINNER WHILE IT IS MOUNTED
 * (single-spinner-while-running D-1). Seven other sites can animate — the
 * streaming assistant marker, the tool badge, the team/fast/retry cards, and the
 * two panels' rows — and each was independently right to. Emergently they put up
 * to five braille animations on adjacent rows, each on its own 80 ms timer: one
 * piece of information rendered five times and out of phase, which is the same
 * duplication the paragraph above legislates against for text. So `App` widens
 * the `reducedMotion` it hands those seven to `cfg.reducedMotion || (running &&
 * !overlay)`, and they all fall back to the static glyphs they already had.
 *
 * THIS COMPONENT KEEPS THE RAW CONFIG FLAG, and that asymmetry is deliberate
 * (D-5). It reads the flag TWICE: once for the spinner below, and once for
 * `pickActivityPhrase`'s rotation. Handing it the widened value would freeze the
 * phrase at the first word of every run — a second, unrelated regression, and
 * one nobody would connect to a change about icons.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { pickActivityPhrase } from './activity-phrases.js';
import type { RunActivity } from './run-status-row.js';

/**
 * The animated spinner this row draws while it is live, or `null` when it would
 * be STATIC — an ASCII terminal, or a user who asked for stillness.
 *
 * A FACTORY, NOT A COMPONENT, and the distinction is load-bearing. A
 * `<LiveSpinner/>` element whose own render returned `null` would still be
 * truthy at the call site — the exact trap `BottomStatusRow`'s `update` prop
 * documents at length. Callers test the RETURN VALUE and get a real answer.
 *
 * It is exported so `BottomStatusRow` can put the bare glyph beside a toast
 * without importing `ink-spinner` itself: `spinner-census.test.ts` enumerates
 * every file under `src/ui/**` that imports it, and that list is the checklist
 * for "who is allowed to animate". One more importer is one more site a future
 * reader has to reason about; one more caller of this function is not.
 */
export function liveSpinner(
  reducedMotion: boolean,
  caps: TermCapabilities,
): React.ReactElement | null {
  return caps.unicode && !reducedMotion ? <Spinner type="dots" /> : null;
}

/**
 * The label ladder, MOST SPECIFIC FIRST: `Compacting context` outranks a tool name
 * because compaction can be the only thing happening, and the tool name outranks
 * the rotating phrase for the reason `runningTool` exists at all. One
 * implementation, because the fixed bottom row and the run status row above the
 * input must never disagree about what the agent is doing.
 *
 * `Running ${name}` rather than a per-tool verb table: a table would be a SECOND
 * registry of tool names, and `toolGlyph` is already the one place that knows
 * them. ASCII only, and the ellipsis comes from `pickGlyphs` like every other one.
 */
export function resolveActivityLabel(
  activity: RunActivity,
  glyphs: ReturnType<typeof pickGlyphs>,
): string {
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
   * False draws the STATIC glyph even when motion is allowed. The run status row
   * uses it when it has scrolled out of the viewport (the fixed bottom row owns
   * the animation then) or an overlay covers the chat. The phrase still rotates
   * from the RAW `reducedMotion`, so a still icon never freezes the wording.
   */
  spinnerLive?: boolean;
  /** Prefix one space (the fixed bottom row's indent); the run row indents itself. */
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
  // The IDENTICAL branch `Transcript.tsx` uses for the assistant role marker, and
  // it must stay identical: braille dots are both an animation AND a Unicode-only
  // glyph, so reduced motion and an ASCII terminal fall back to the same marker.
  //
  // Through `liveSpinner` rather than inline, so this row and the glyph
  // `BottomStatusRow` composes beside a toast can never disagree about WHEN the
  // spinner is live - the same reason `App` names its mount condition once.
  const spinner = (spinnerLive ? liveSpinner(activity.reducedMotion, caps) : null) ??
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
