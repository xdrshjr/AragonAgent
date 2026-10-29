/**
 * Render a `user` entry that carries an invocation card (tui-invocation-cards).
 *
 * Like `UserEntry`, this renders CONTENT only: the role glyph, rail and spacing belong
 * to `EntryFrame`, so the card stays "the user's turn" for density, turn counting and
 * the settled boundary. The header text comes from `invocationHeaderSegments` and is
 * never assembled here (RV-10); the row count it implies is `invocationCardRows`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import type { InvocationCard as InvocationCardData } from '../../model/agent/invocation-card.js';
import {
  invocationHeaderSegments,
  invocationHiddenText,
  invocationInputText,
  type InvocationTone,
} from '../layout/invocation-card.js';
import { GUTTER_WIDTH } from '../layout/Gutter.js';
import { useTerminalSize } from '../layout/useTerminalSize.js';
import { fitCells } from '../layout/cells.js';

function toneColor(tone: InvocationTone, theme: Theme): string | undefined {
  if (tone === 'label') return theme.accent;
  if (tone === 'name') return theme.user;
  return theme.muted;
}

function InvocationCardImpl({
  card,
  theme,
  caps,
}: {
  card: InvocationCardData;
  theme: Theme;
  caps: TermCapabilities;
}): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const { cols } = useTerminalSize();
  const usable = Math.max(1, cols - GUTTER_WIDTH);
  const header = invocationHeaderSegments(card, glyphs, usable);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {header.map((part, index) => (
          <Text key={index} color={toneColor(part.tone, theme)} bold={part.bold}>
            {part.text}
          </Text>
        ))}
      </Text>
      {card.input !== '' && <Text color={theme.user}>{invocationInputText(card)}</Text>}
      {card.inputHidden > 0 && (
        <Text color={theme.muted} wrap="truncate">{invocationHiddenText(card, glyphs)}</Text>
      )}
      {card.note !== undefined && card.note !== '' && (
        <Text color={theme.muted} wrap="truncate">{fitCells(card.note, usable, glyphs.ellipsis)}</Text>
      )}
    </Box>
  );
}

/** Default comparator: `mapEntry` preserves identity for untouched entries (L2 / R3). */
export const InvocationCard = React.memo(InvocationCardImpl);
