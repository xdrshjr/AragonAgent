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
  /**
   * Whether pressing `Ctrl+T` would actually reveal THIS entry's body — i.e.
   * `mode === 'fullscreen'` (D-16 / P0-2).
   *
   * In inline mode a settled entry has already been printed into Ink's
   * `<Static>`, which cannot un-print or re-print (`Transcript.tsx:9-10`), and
   * the settled boundary is held monotonic precisely so an entry never flows back
   * out. With thinking hidden by default the body is never printed there AT ALL,
   * so a row reading `ctrl+t to show` would be an instruction that provably does
   * nothing. The row degrades to `* thought for 12s` instead — still honest that
   * reasoning happened and how long it took, and silent about a key that cannot
   * deliver.
   */
  revealable?: boolean;
  /**
   * Inline mode only (L5): keep at most this many rows of a LIVE entry, so the
   * non-`<Static>` region cannot reach `stdout.rows`. `undefined` means no
   * clamp on the ANSWER BODY, which is what the full-screen branch passes — so
   * the rendered answer there is byte-identical to a pre-feature build. (The
   * thinking block has its own streaming clamp below and is not covered by that
   * statement.)
   */
  liveClampRows?: number;
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
    revealable,
    liveClampRows,
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
  const thinkingRows = liveClampRows ?? (streaming ? STREAMING_THINKING_ROWS : undefined);
  const clampedThinking =
    hasThinking && thinkingRows !== undefined
      ? clampLiveText(thinking!, thinkingRows)
      : { text: thinking ?? '', hiddenRows: 0 };
  const body =
    liveClampRows === undefined ? { text, hiddenRows: 0 } : clampLiveText(text, liveClampRows);

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

      {/*
        THE COLLAPSED MARKER (§3.1.3). Hiding information without saying that it
        exists is how a "clean" UI becomes a dishonest one; this row is the whole
        difference. It names that reasoning happened, how long it took, and — in
        the mode where the key can deliver — how to see it.

        `!streaming` IS REQUIRED. While the run is live the activity line is the
        live surface; a second live marker inside the transcript would duplicate
        it and would also keep the entry off `<Static>`.
      */}
      {hasThinking && !thinkingVisible && !streaming && (
        <Text wrap="truncate" color={theme.muted}>
          {glyphs.thinking} thought
          {thinkingMs !== undefined ? ` for ${formatDuration(thinkingMs)}` : ''}
          {revealable ? ` ${glyphs.midDot} ctrl+t to show` : ''}
        </Text>
      )}

      {(hasText || streaming) && (
        <Box flexDirection="column">
          {body.hiddenRows > 0 && (
            <Text wrap="truncate" color={theme.muted}>
              {glyphs.ellipsis} {body.hiddenRows} earlier{' '}
              {body.hiddenRows === 1 ? 'line' : 'lines'} {glyphs.midDot} shown in full when this
              entry finishes
            </Text>
          )}
          {hasText ? (
            <Markdown text={body.text} theme={theme} caps={caps} />
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
