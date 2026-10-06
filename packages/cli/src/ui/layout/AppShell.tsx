/** Stable fullscreen slots preserve the editor during overlays and small resizes. */

import React from 'react';
import { Box } from 'ink';
import { frameHeight } from './frame.js';

export interface AppShellProps {
  rows: number;
  cols: number;
  header: React.ReactNode;
  viewport: React.ReactNode;
  toast: React.ReactNode;
  status: React.ReactNode;
  inactive?: boolean;
  placeholder?: React.ReactNode;
}

export function AppShell({
  rows,
  cols,
  header,
  viewport,
  toast,
  status,
  inactive = false,
  placeholder,
}: AppShellProps): React.ReactElement {

  return (
    <Box
      flexDirection="column"
      height={frameHeight(rows)}
      width={cols}
      overflow="hidden"
    >
      <Box display={inactive ? 'none' : 'flex'} flexDirection="column"
        height={frameHeight(rows)} width={cols} overflow="hidden">
        <Box height={1} flexShrink={0} overflow="hidden">{header}</Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {viewport}
        </Box>
        <Box height={1} flexShrink={0} overflow="hidden">{toast}</Box>
        <Box height={1} flexShrink={0} overflow="hidden">{status}</Box>
      </Box>
      <Box display={inactive ? 'flex' : 'none'} height={frameHeight(rows)}
        overflow="hidden">{placeholder}</Box>
    </Box>
  );
}
