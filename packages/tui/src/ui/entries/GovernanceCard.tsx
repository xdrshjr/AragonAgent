/**
 * GovernanceCard - the settlement card for a `kind: 'governance'` entry
 * (governance-mode section 10.4).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`, through the layout.
 *
 * It renders inside the `EntryFrame` that `Transcript.tsx` supplies, so the left rail is
 * the card's frame - no second box drawn inside the rail. (The spec sketches a
 * rounded box; nested inside the gutter rail it would be two frames for one thing, and the
 * rail already carries the tone colour. Recorded as a deliberate deviation.)
 *
 * EVERY LINE TRUNCATES, none wraps, so the card's height is a function of its data alone
 * (`governanceCardRows`) and `virtual-window.ts::estimateEntryRows` is exact rather than an
 * upper bound. A narrow terminal therefore degrades by truncation to one plain line per
 * agent without any width-dependent branch here.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { GovernanceCardData } from '../../model/governance/types.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { toneColor } from '../governance-status.js';
import { GovernanceLine, GovernanceRun } from '../GovernanceRun.js';
import { buildGovernanceCardLayout, cardTone } from '../layout/governance-card.js';
import type { VoiceContext } from '../tool-voice.js';

export interface GovernanceCardProps {
  card: GovernanceCardData;
  /**
   * Persona names. REQUIRED and a prop, never a context (the native scrollback replay
   * renders this in a second Ink instance with no provider).
   */
  voice: VoiceContext;
  theme: Theme;
  caps: TermCapabilities;
}

/** The rail colour: the card's verdict, resolved like every other governance tone. */
export function governanceCardColor(card: GovernanceCardData, theme: Theme): string | undefined {
  return toneColor(cardTone(card), theme);
}

function GovernanceCardImpl({ card, voice, theme, caps }: GovernanceCardProps): React.ReactElement {
  const layout = buildGovernanceCardLayout(card, pickGlyphs(caps), voice);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <GovernanceLine segments={layout.title} theme={theme} />
      {layout.headline && (
        <GovernanceLine segments={layout.headline} theme={theme} />
      )}
      {layout.tableHeader && (
        <Text wrap="truncate">
          {layout.tableHeader.map((cell, index) => (
            <GovernanceRun key={index} segments={cell} theme={theme} />
          ))}
        </Text>
      )}
      {layout.rows.map((row) => (
        <Text key={row.key} wrap="truncate">
          {row.cells.map((cell, index) => (
            <GovernanceRun key={index} segments={cell} theme={theme} />
          ))}
        </Text>
      ))}
      {layout.notes && <GovernanceLine segments={layout.notes} theme={theme} />}
    </Box>
  );
}

export const GovernanceCard = React.memo(GovernanceCardImpl);
