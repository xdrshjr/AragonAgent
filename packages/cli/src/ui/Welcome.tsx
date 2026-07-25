/**
 * Welcome / empty-state card (spec §3.3). Rendered by App only while the
 * transcript is empty (`entries.length === 0`), below the header banner. Carries
 * the onboarding affordances the header used to inline: active model + key
 * status, the full-permission caution, a few example prompts, and a command
 * footer. When no key is configured it leads with a getting-started hint.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';

interface WelcomeProps {
  provider: string;
  model: string;
  hasKey: boolean;
  theme: Theme;
}

const EXAMPLES = [
  'Explain what this repository does',
  'Find and fix the failing test in src/',
  'Add a --json flag to the CLI and update the README',
];

export function Welcome({ provider, model, hasKey, theme }: WelcomeProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={theme.assistant}>
        Welcome to ArgonAgent — a coding agent in your terminal.
      </Text>
      <Text color={theme.muted}>
        Model <Text color={theme.accent}>{provider}:{model}</Text>
        {hasKey ? '' : '  ·  no API key set'}
      </Text>

      {!hasKey && (
        <Box marginTop={1}>
          <Text color={theme.noticeWarn}>
            → Run /settings (or set ANTHROPIC_API_KEY) to get started.
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.noticeWarn}>
          {theme.symbols.warn} Full permission, no sandbox: bash runs and files are written directly.
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>Try:</Text>
        {EXAMPLES.map((ex) => (
          <Text key={ex}>
            <Text color={theme.accent}>{theme.symbols.bullet} </Text>
            <Text color={theme.assistant}>{ex}</Text>
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>
          /help commands · /model switch · /settings keys · Ctrl+C twice to exit
        </Text>
      </Box>
    </Box>
  );
}
