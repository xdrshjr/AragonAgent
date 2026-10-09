/** Renders an already allocated detail row; it never chooses visibility or animation. */
import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { StatusLinePlan } from './layout/status-layout.js';
export interface BottomStatusRowProps { plan: StatusLinePlan; columns: number; theme: Theme }
export function BottomStatusRow({ plan, columns, theme }: BottomStatusRowProps): React.ReactElement {
  const tones = { normal: theme.primary, muted: theme.muted, warning: theme.noticeWarn, error: theme.noticeError };
  return <Box height={1} width={columns} flexShrink={0} overflow="hidden">
    <Box width={1} flexShrink={0}><Text> </Text></Box>
    {plan.fields.map((field, index) => <React.Fragment key={field.id}>
      {index > 0 && <Box width={plan.separatorCells} flexShrink={0}><Text color={theme.muted}>{plan.separator}</Text></Box>}
      <Box width={field.cells} flexShrink={0}><Text wrap="truncate" color={tones[field.tone]}>{field.text}</Text></Box>
    </React.Fragment>)}
  </Box>;
}
