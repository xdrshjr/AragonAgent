/** Stable fullscreen slots preserve the editor during overlays and small resizes. */

import React from 'react';
import { Box } from 'ink';
import { frameHeight } from './frame.js';

export interface AppShellProps {
  rows: number;
  cols: number;
  header: React.ReactNode;
  viewport: React.ReactNode;
  composer: React.ReactNode;
  composerSlotRows: number;
  viewportRows: number;
  details?: React.ReactNode;
  statusRows: 0 | 1 | 2;
  status: React.ReactNode;
  inactive?: boolean;
  placeholder?: React.ReactNode;
}

export function AppShell({
  rows,
  cols,
  header,
  viewport,
  composer, composerSlotRows, viewportRows, details, statusRows,
  status,
  inactive = false,
  placeholder,
}: AppShellProps): React.ReactElement {

  return (
    <Box
      flexDirection="column"
      height={frameHeight(rows)}
      width={cols}
      overflow="hidden" flexShrink={0}
    >
      <Box display={inactive ? 'none' : 'flex'} flexDirection="column"
        height={frameHeight(rows)} width={cols} overflow="hidden" flexShrink={0}>
        <Box height={1} flexShrink={0} overflow="hidden">{header}</Box>
        <Box flexDirection="column" height={viewportRows} flexShrink={0} overflow="hidden">
          {viewport}
        </Box>
        <Box flexDirection="column" height={composerSlotRows} justifyContent="flex-end"
          flexShrink={0} overflow="hidden">{composer}</Box>
        <Box height={statusRows > 0 ? 1 : 0} flexShrink={0} overflow="hidden">{status}</Box>
        {statusRows === 2 && <Box height={1} flexShrink={0} overflow="hidden">{details}</Box>}
      </Box>
      <Box display={inactive ? 'flex' : 'none'} height={frameHeight(rows)}
        overflow="hidden">{placeholder}</Box>
    </Box>
  );
}
