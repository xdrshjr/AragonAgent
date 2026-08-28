/**
 * AppShell (spec §4.3) — the frame that makes R2 true.
 *
 * In `fullscreen` the root box has a FIXED height of `frameHeight(rows)` and the
 * middle viewport is the only `flexGrow` child, so the bottom chrome (toast /
 * composer / status bar) is physically the last thing on the screen from the
 * very first frame — empty session, long session, mid-scroll, overlay open.
 *
 * In `inline` the same children are emitted in the same order with no height
 * constraint, i.e. byte-for-byte the v0.2.0 document-flow behavior.
 */

import React from 'react';
import { Box } from 'ink';
import { frameHeight, type RenderMode } from './frame.js';

export interface AppShellProps {
  mode: RenderMode;
  rows: number;
  cols: number;
  header: React.ReactNode;
  viewport: React.ReactNode;
  /**
   * The live subagent roster (team-subagents §6.1), or nothing.
   *
   * IT RENDERS IN THE BOTTOM CHROME OF THE FULL-SCREEN BRANCH, above `toast` and
   * below the viewport: the roster is transient status about the run in progress,
   * so it belongs with the other transient rows rather than inside the scrolling
   * transcript, where it would be interleaved with history and scroll away.
   */
  team?: React.ReactNode;
  /**
   * The right-hand region of the MIDDLE band (todo-plan-execution §3.9), or
   * nothing.
   *
   * NAMED FOR ITS POSITION, NOT ITS CONTENT (D-18): this file is a layout
   * primitive and has no business knowing what a todo is. `team` above already
   * leaks content vocabulary in here; there is no reason to repeat it.
   *
   * IT MUST BE RENDERED IN THE MIDDLE BAND, BESIDE THE VIEWPORT (C-6 / I-4) —
   * that is what makes it a rail rather than another row of bottom chrome. Moved
   * down into the bottom box it would stop being a column beside the transcript
   * and start eating viewport height, growing and shrinking the transcript every
   * time the list changed length.
   *
   * The INLINE branch does not include it at all — a structural guarantee rather
   * than a promise that the caller passes `null` (non-goal 4).
   */
  rail?: React.ReactNode;
  /**
   * The one-row plan strip for INLINE mode (todo-plan-followthrough §3.7), or
   * nothing.
   *
   * THE STRUCTURAL MIRROR OF `rail` ABOVE, in the opposite direction: the
   * FULL-SCREEN branch does not reference it at all. The reason is the same one
   * `rail`'s inline omission records — a prop that is merely SUPPOSED to be null
   * in one mode becomes non-null eventually, and then the rail and the strip are
   * both on screen showing the same list (I-6). Fullscreen has the rail; that is
   * the whole design.
   *
   * It sits between `viewport` and `team`, mirroring where the rail sits in the
   * other branch: last thing above the bottom chrome, so the strip and the
   * roster read top-to-bottom in the same order in both modes.
   */
  strip?: React.ReactNode;
  toast: React.ReactNode;
  composer: React.ReactNode;
  status: React.ReactNode;
}

export function AppShell({
  mode,
  rows,
  cols,
  header,
  viewport,
  team,
  rail,
  strip,
  toast,
  composer,
  status,
}: AppShellProps): React.ReactElement {
  if (mode === 'inline') {
    return (
      <Box flexDirection="column">
        {header}
        {viewport}
        {strip}
        {team}
        {toast}
        {composer}
        {status}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      height={frameHeight(rows)}
      width={cols}
      overflow="hidden"
    >
      <Box flexDirection="column" flexShrink={0}>
        {header}
      </Box>
      {/*
        THE ROW WRAPPER IS UNCONDITIONAL, present whether or not `rail` is
        (D-26). A wrapper that appeared only when a list existed would change the
        React tree's SHAPE the moment the model first called `todo_write`,
        remounting `ScrollViewport` and throwing away the scroll offset and the
        intent nonce it is careful to seed on mount. Yoga lays a single-child row
        out identically to the column it replaces, so the byte-identical claim
        survives the extra node (AC-24).
      */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {viewport}
        </Box>
        {rail}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {team}
        {toast}
        {composer}
        {status}
      </Box>
    </Box>
  );
}
