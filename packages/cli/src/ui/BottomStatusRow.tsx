/** The permanent action/feedback row. StatusBar owns all activity animation. */
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from './theme.js';
import type { Toast } from '../agent/reducer.js';
import { buildActionClauses, type ActionHintInput } from './interaction-hints.js';

export interface BottomStatusRowProps {
  toasts: Toast[];
  hints?: ActionHintInput;
  /** Legacy assembly props are accepted but never mount an activity spinner. */
  activity?: React.ReactNode;
  activityGlyph?: React.ReactElement | null;
  update?: React.ReactNode;
  theme: Theme;
}

export function BottomStatusRow(props: BottomStatusRowProps): React.ReactElement {
  const { stdout } = useStdout();
  const toast = props.toasts[props.toasts.length - 1];
  const hints = props.hints ?? { cols: stdout?.columns ?? 80,
    interactionPhase: props.activity ? 'running' as const : 'idle' as const };
  const clauses = buildActionClauses({ ...hints, toast: hints.toast ?? toast?.text,
    updateAvailable: hints.updateAvailable ?? Boolean(props.update) });
  return <Box height={1} width={hints.cols} flexShrink={0}>
    <Text color={toast?.level === 'error' ? props.theme.noticeError : props.theme.muted}>
      {' '}{clauses.join(' | ')}
    </Text>
  </Box>;
}
