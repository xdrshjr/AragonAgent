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
  toast,
  composer,
  status,
}: AppShellProps): React.ReactElement {
  if (mode === 'inline') {
    return (
      <Box flexDirection="column">
        {header}
        {viewport}
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
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {viewport}
      </Box>
      <Box flexDirection="column" flexShrink={0}>
        {toast}
        {composer}
        {status}
      </Box>
    </Box>
  );
}
