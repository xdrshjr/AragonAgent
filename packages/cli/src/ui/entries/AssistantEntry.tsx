/**
 * Render a streaming assistant entry: an optional collapsible thinking block
 * above the markdown-rendered answer text. Empty entries render nothing (a turn
 * that only produced tool calls has no assistant text).
 *
 * The role glyph and spacing belong to `EntryFrame` (§4.3) — including the
 * streaming spinner, which IS the role marker while text is arriving.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { Markdown } from '../Markdown.js';

interface AssistantEntryProps {
  text: string;
  thinking?: string;
  thinkingOpen: boolean;
  thinkingVisible: boolean;
  streaming: boolean;
  aborted?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

export function AssistantEntry(props: AssistantEntryProps): React.ReactElement | null {
  const { text, thinking, thinkingOpen, thinkingVisible, streaming, aborted, theme, caps } = props;
  const glyphs = pickGlyphs(caps);

  const hasThinking = !!thinking && thinking.trim().length > 0;
  const hasText = text.trim().length > 0;

  if (!hasThinking && !hasText && !streaming) return null;

  return (
    <Box flexDirection="column">
      {hasThinking && thinkingVisible && (
        <Box flexDirection="column">
          <Text wrap="truncate" color={theme.thinking}>
            {glyphs.thinking} thinking{thinkingOpen ? glyphs.ellipsis : ''}
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
        <Box flexDirection="column">
          {hasText ? (
            <Markdown text={text} theme={theme} caps={caps} />
          ) : (
            <Text color={theme.muted}>{glyphs.ellipsis}</Text>
          )}
          {aborted && <Text color={theme.noticeWarn}>[aborted]</Text>}
        </Box>
      )}
    </Box>
  );
}
