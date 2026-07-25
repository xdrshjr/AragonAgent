/** Help overlay — keybindings and slash-command reference (spec §5.2 / §5.3). */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

const KEYS: [string, string][] = [
  ['Enter', 'Submit (idle) / queue steering (running)'],
  ['Alt+Enter / Shift+Enter', 'Insert newline'],
  ['Esc', 'Abort run / close overlay'],
  ['Ctrl+C ×2', 'Exit'],
  ['Ctrl+L', 'Clear screen'],
  ['Ctrl+T', 'Toggle thinking blocks'],
  ['Up / Down', 'Prompt history (empty input)'],
];

const COMMANDS: [string, string][] = [
  ['/help', 'Show this help'],
  ['/model', 'Open the model picker'],
  ['/settings', 'Open the settings screen'],
  ['/thinking <level>', 'Set thinking level'],
  ['/tools', 'List active tools'],
  ['/clear', 'Clear the visible transcript'],
  ['/reset', 'New conversation'],
  ['/cwd [dir]', 'Show or change the tool working directory'],
  ['/save [file]', 'Save the session to JSON'],
  ['/resume [file]', 'Load a saved session'],
  ['/copy', 'Copy the last answer to the clipboard'],
  ['/exit', 'Exit'],
];

export function HelpOverlay({ theme }: { theme: Theme }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginTop={1}
    >
      <Text color={theme.primary} bold>
        Help — press Esc to close
      </Text>
      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          Keybindings
        </Text>
      </Box>
      {KEYS.map(([k, d]) => (
        <Text key={k}>
          <Text color={theme.primary}>{k.padEnd(24)}</Text>
          <Text color={theme.muted}>{d}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          Slash commands
        </Text>
      </Box>
      {COMMANDS.map(([c, d]) => (
        <Text key={c}>
          <Text color={theme.primary}>{c.padEnd(24)}</Text>
          <Text color={theme.muted}>{d}</Text>
        </Text>
      ))}
    </Box>
  );
}
