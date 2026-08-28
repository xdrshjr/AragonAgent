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

export interface ActivityLineProps {
  /** Epoch ms the current run began — the phrase sequence's seed. */
  startedAt: number;
  /** `Date.now() - startedAt`, already computed by App's 200 ms ticker. */
  elapsedMs: number;
  reducedMotion: boolean;
  /**
   * The name of the tool currently in flight, or `undefined`
   * (agent-activity-presentation-live L4 / D-31).
   *
   * `status === 'running'` covers the WHOLE turn, including the minutes the
   * model is idle and a child process is doing the work. Round 1 chose the
   * thinking vocabulary deliberately for the gap before the first token, and it
   * is right for that gap; a UI that says "Pondering" while `npm test` runs is
   * not calm, it is wrong.
   */
  runningTool?: string;
  /**
   * A context compaction is in flight (context-auto-compaction §6.1).
   *
   * HIGHEST PRECEDENCE IN THE LABEL LADDER, above `runningTool` and above the
   * rotating phrase. Compaction happens BEFORE `turn_start`, i.e. at a moment
   * when `status` is `'running'` but no tool is in flight — precisely the window
   * in which the phrase rotation would say something false, and it can last
   * tens of seconds. `runningTool` already established the principle one step
   * back: a UI that says "Pondering" while `npm test` runs is not calm, it is
   * wrong, and one that says it while a 30 k-token summarization runs is the same
   * error.
   *
   * STILL NO SECOND SPINNER. `single-spinner-while-running`'s D-1 stands: this
   * row owns the only animation while it is mounted, and the compaction card
   * follows `FastCard` in taking a `reducedMotion` that `App` has already
   * widened.
   */
  compacting?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

export function ActivityLine({
  startedAt,
  elapsedMs,
  reducedMotion,
  runningTool,
  compacting,
  theme,
  caps,
}: ActivityLineProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  // PURE AND DERIVED FROM `(startedAt, now)`, so the sequence does not need to
  // keep rotating underneath the tool label: when the tool settles the phrase
  // resumes at the position the clock implies, with no state anywhere.
  const phrase = pickActivityPhrase(startedAt, startedAt + elapsedMs, !reducedMotion);
  // `Running ${name}` rather than a per-tool verb table: a table would be a
  // SECOND registry of tool names, and `toolGlyph` is already the one place that
  // knows them. Everything round 1 legislated for this row survives — one row,
  // no digits, no `esc abort`, no width ladder, ASCII only.
  // THREE RUNGS, MOST SPECIFIC FIRST. `Compacting context` outranks a tool name
  // because compaction can be the only thing happening, and it outranks the
  // phrase for the reason `runningTool` does. ASCII only, and the ellipsis comes
  // from `pickGlyphs` like every other one on this row.
  const label = compacting
    ? `Compacting context${glyphs.ellipsis}`
    : runningTool
    ? `Running ${runningTool}`
    : `${phrase}${glyphs.ellipsis}`;
  // The IDENTICAL branch `Transcript.tsx` uses for the assistant role marker, and
  // it must stay identical: braille dots are both an animation AND a Unicode-only
  // glyph, so reduced motion and an ASCII terminal fall back to the same marker.
  //
  // Through `liveSpinner` rather than inline, so this row and the glyph
  // `BottomStatusRow` composes beside a toast can never disagree about WHEN the
  // spinner is live — the same reason `App` names its mount condition once.
  const spinner = liveSpinner(reducedMotion, caps) ?? glyphs.spinnerStill;

  return (
    <Box flexShrink={0}>
      <Text wrap="truncate" color={theme.thinking}>
        {' '}
        {spinner} {label}
      </Text>
    </Box>
  );
}
