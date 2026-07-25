/**
 * Header (spec §3.3). An expanded gradient wordmark banner with a model chip and
 * an API-key status dot while the transcript is empty; a slim single-line sticky
 * bar (progressive disclosure) once a turn exists. The big banner is only ever
 * rendered in the empty-state live frame so it never drifts below the `<Static>`
 * history (P1-4 — read with §3.8).
 */

import React from 'react';
import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { basename } from 'node:path';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { gradientLine } from './gradient.js';

interface HeaderProps {
  version: string;
  cwd: string;
  provider: string;
  model: string;
  hasKey: boolean;
  compact: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/** Collapse the home directory to `~` for a shorter path display. */
function tildeCwd(cwd: string): string {
  const home = homedir();
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

function KeyDot({ hasKey, theme }: { hasKey: boolean; theme: Theme }): React.ReactElement {
  return (
    <Text color={hasKey ? theme.toolDone : theme.toolRunning}>
      {hasKey ? theme.symbols.keyOn : theme.symbols.keyOff} {hasKey ? 'key set' : 'no key'}
    </Text>
  );
}

export function Header({
  version,
  cwd,
  provider,
  model,
  hasKey,
  compact,
  theme,
  caps,
}: HeaderProps): React.ReactElement {
  const wordmark = `${theme.symbols.wordmark} ArgonAgent`;

  if (compact) {
    return (
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme.primary} bold>
          {theme.symbols.wordmark} ArgonAgent
        </Text>
        <Text color={theme.accent}>
          {'  '}
          {provider}:{model}
        </Text>
        <Text color={theme.muted}>  {basename(cwd) || cwd}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color={theme.gradient.length > 0 ? undefined : theme.primary}>
        {gradientLine(wordmark, theme.gradient, caps.colorLevel)}
      </Text>
      <Box flexDirection="row">
        <Text color={theme.muted}>v{version}</Text>
        <Text color={theme.accent}>
          {'  '}
          {provider}:{model}
        </Text>
        <Text>{'  '}</Text>
        <KeyDot hasKey={hasKey} theme={theme} />
      </Box>
      <Text color={theme.muted}>{tildeCwd(cwd)}</Text>
    </Box>
  );
}
