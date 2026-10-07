import React from 'react';
import { Box, Text } from 'ink';
import type { QueueLayout } from './layout/queue-layout.js';
import type { Theme } from './theme.js';

/** Persistent receipt-backed footer, with no timer or separate queue state. */
export const QueuePanel = React.memo(function QueuePanel({ layout, theme }: {
  layout: QueueLayout; theme: Theme;
}): React.ReactElement | null {
  if (!layout.rows) return null;
  return <Box flexDirection="column" flexShrink={0} height={layout.rows}>
    <Text color={theme.accent} wrap="truncate">{layout.title}</Text>
    {layout.rows > 1 && layout.items.map((item) => <Text key={item.queueId} color={theme.muted}
      wrap="truncate">{item.label}</Text>)}
  </Box>;
});
