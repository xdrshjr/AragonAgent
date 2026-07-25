/**
 * Status bar (spec §3.4). Width-aware single line: a left cluster (run status,
 * model, thinking level) and a right cluster (context gauge with threshold
 * color, tokens, cost, and — while running — a tokens/sec read-out and elapsed
 * timer), plus a state-dependent far-right hint. Clusters drop out gracefully on
 * narrow terminals.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import type { UsageTotal } from '../agent/reducer.js';
import { formatCost, formatTokens, formatDuration } from '../agent/usage.js';
import { buildGauge } from './gauge.js';

interface StatusBarProps {
  model: string;
  provider: string;
  usageTotal: UsageTotal;
  contextTokens: number;
  contextWindow: number;
  contextWindowKnown: boolean;
  status: 'idle' | 'running';
  elapsedMs: number;
  thinkingLevel: string;
  tokPerSec: number;
  theme: Theme;
  caps: TermCapabilities;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const {
    model,
    provider,
    usageTotal,
    contextTokens,
    contextWindow,
    contextWindowKnown,
    status,
    elapsedMs,
    thinkingLevel,
    tokPerSec,
    theme,
    caps,
  } = props;

  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const running = status === 'running';

  const pct =
    contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
  const gauge = buildGauge(pct, cols < 72 ? 8 : 12, theme, caps);
  const pctLabel = `${contextWindowKnown ? '' : '~'}${gauge.pct}%`;
  const tokens = `${formatTokens(usageTotal.inputTokens)}↑ ${formatTokens(usageTotal.outputTokens)}↓`;

  const statusGlyph = running ? theme.symbols.toolRunning : theme.symbols.toolPending;
  const hint = running ? 'esc abort · type to steer' : 'enter send · / cmd · ? help';

  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
    >
      <Box flexDirection="row">
        <Text color={running ? theme.toolRunning : theme.toolDone}>
          {statusGlyph} {running ? 'running' : 'idle'}
        </Text>
        {cols >= 60 && (
          <Text color={theme.muted}>
            {'  '}
            {provider}:{model}
          </Text>
        )}
        {thinkingLevel !== 'off' && cols >= 72 && (
          <Text color={theme.accent}>  think:{thinkingLevel}</Text>
        )}
      </Box>

      <Box flexDirection="row">
        {cols >= 60 && (
          <Text>
            <Text color={theme.muted}>[</Text>
            <Text color={gauge.fillColor}>{gauge.filled}</Text>
            <Text color={gauge.trackColor}>{gauge.empty}</Text>
            <Text color={theme.muted}>] </Text>
          </Text>
        )}
        <Text color={theme.muted}>{pctLabel}</Text>
        {cols >= 72 && <Text color={theme.muted}>  {tokens}</Text>}
        <Text color={theme.muted}>  {formatCost(usageTotal.costUsd)}</Text>
        {running && (
          <Text color={theme.muted}>
            {tokPerSec > 0 && cols >= 72 ? `  ${tokPerSec} tok/s` : ''}  {formatDuration(elapsedMs)}
          </Text>
        )}
        {cols >= 96 && <Text color={theme.muted}>  · {hint}</Text>}
      </Box>
    </Box>
  );
}
