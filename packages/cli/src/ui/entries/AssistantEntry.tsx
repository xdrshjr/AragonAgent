/**
 * Render a streaming assistant entry: an optional collapsible thinking block
 * above the markdown-rendered answer text. Empty entries render nothing (a turn
 * that only produced tool calls has no assistant text).
 *
 * The role glyph and spacing belong to `EntryFrame` (§4.3) — including the
 * streaming spinner, which IS the role marker while text is arriving.
 *
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3):
 * every prop here is a scalar except `theme` and `caps`, both of which are
 * `useMemo`d in `App.tsx` and therefore referentially stable across frames
 * (I-L2-1, asserted by `render-memo.test.tsx`). If either ever becomes a fresh
 * object per render this boundary silently becomes a no-op — which is exactly
 * why that assertion exists rather than a comment.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { Markdown } from '../Markdown.js';
import { splitLinesCached } from '../render-cache.js';
import { clampLiveText } from '../live-clamp.js';
import { formatDuration } from '../../agent/usage.js';

interface AssistantEntryProps {
  text: string;
  thinking?: string;
  thinkingOpen: boolean;
  thinkingVisible: boolean;
  streaming: boolean;
  aborted?: boolean;
  /**
   * Sealed reasoning time (§3.1.2). OMITTED WHEN UNKNOWN rather than printed as
   * `0s`: a session restored from a file written by an older build has none, and
   * `thought for 0s` is a lie where a bare `thought` is merely terse.
   */
  thinkingMs?: number;

  theme: Theme;
  caps: TermCapabilities;
}

function AssistantEntryImpl(props: AssistantEntryProps): React.ReactElement | null {
  const {
    text,
    thinking,
    thinkingOpen,
    thinkingVisible,
    streaming,
    aborted,
    thinkingMs,
    theme,
    caps,
  } = props;
  const glyphs = pickGlyphs(caps);

  const hasThinking = !!thinking && thinking.trim().length > 0;
  const hasText = text.trim().length > 0;

  if (!hasThinking && !hasText && !streaming) return null;

  // The thinking block is clamped to its TAIL while streaming even in
  // full-screen mode: it is scratch reasoning the user reads the newest end of,
  // and an unbounded one is the single easiest way to push a live entry past the
  // whole viewport.
  const thinkingRows = streaming ? STREAMING_THINKING_ROWS : undefined;
  const clampedThinking =
    hasThinking && thinkingRows !== undefined
      ? clampLiveText(thinking!, thinkingRows)
      : { text: thinking ?? '', hiddenRows: 0 };

  return (
    <Box flexDirection="column">
      {hasThinking && thinkingVisible && (
        <Box flexDirection="column">
          <Text wrap="truncate" color={theme.thinking}>
            {glyphs.thinking} thinking{thinkingOpen ? glyphs.ellipsis : ''}
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            {clampedThinking.hiddenRows > 0 && (
              <Text color={theme.muted}>
                {glyphs.ellipsis} {clampedThinking.hiddenRows} earlier{' '}
                {clampedThinking.hiddenRows === 1 ? 'line' : 'lines'}
              </Text>
            )}
            {splitLinesCached(clampedThinking.text).map((line, i) => (
              <Text key={i} color={theme.thinking} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        </Box>
      )}
      {hasThinking && !thinkingVisible && !streaming && (
        <Text wrap="truncate" color={theme.muted}>
          {glyphs.thinking} thought
          {thinkingMs !== undefined ? ` for ${formatDuration(thinkingMs)}` : ''}
          {` ${glyphs.midDot} ctrl+t to show`}
        </Text>
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

/** Rows of live thinking kept on screen while an answer streams. */
const STREAMING_THINKING_ROWS = 24;

export const AssistantEntry = React.memo(AssistantEntryImpl);
