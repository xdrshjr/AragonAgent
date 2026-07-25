/**
 * Render a streaming assistant entry: an optional collapsible thinking block
 * above the markdown-rendered answer text. Empty entries render nothing (a turn
 * that only produced tool calls has no assistant text).
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { SYMBOLS, type Theme } from '../theme.js';
import { Markdown } from '../Markdown.js';

interface AssistantEntryProps {
  text: string;
  thinking?: string;
  thinkingOpen: boolean;
  thinkingVisible: boolean;
  streaming: boolean;
  aborted?: boolean;
  theme: Theme;
}

export function AssistantEntry(props: AssistantEntryProps): React.ReactElement | null {
  const { text, thinking, thinkingOpen, thinkingVisible, streaming, aborted, theme } = props;

  const hasThinking = !!thinking && thinking.trim().length > 0;
  const hasText = text.trim().length > 0;

  if (!hasThinking && !hasText && !streaming) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {hasThinking && thinkingVisible && (
        <Box flexDirection="column" marginBottom={hasText ? 1 : 0}>
          <Text color={theme.thinking}>
            {SYMBOLS.thinking} thinking{thinkingOpen ? '…' : ''}
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            {thinking!.split('\n').map((line, i) => (
              <Text key={i} color={theme.thinking} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {(hasText || streaming) && (
        <Box flexDirection="row">
          <Text color={theme.primary}>
            {streaming ? <Spinner type="dots" /> : SYMBOLS.assistant}{' '}
          </Text>
          <Box flexDirection="column">
            {hasText ? <Markdown text={text} theme={theme} /> : <Text color={theme.muted}>…</Text>}
            {aborted && <Text color={theme.noticeWarn}>[aborted]</Text>}
          </Box>
        </Box>
      )}
    </Box>
  );
}
