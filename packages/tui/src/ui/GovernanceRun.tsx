/**
 * GovernanceRun - paints one `Segment[]` run: the single place a governance layout's
 * semantic tones become Ink colours.
 *
 * ASCII ONLY. The panel, the card and the board all draw the same `Segment` vocabulary,
 * and three private copies of this loop is how their bold / tone handling drifts apart.
 */

import React from 'react';
import { Text } from 'ink';
import type { Theme } from './theme.js';
import { toneColor, type Segment } from './governance-status.js';

export interface GovernanceRunProps {
  segments: readonly Segment[];
  theme: Theme;
}

/** The segments as nested `Text`; the CALLER owns wrapping and truncation. */
export function GovernanceRun({ segments, theme }: GovernanceRunProps): React.ReactElement {
  return (
    <>
      {segments.map((part, index) => (
        <Text
          key={index}
          color={toneColor(part.tone, theme)}
          {...(part.bold ? { bold: true } : {})}
        >
          {part.text}
        </Text>
      ))}
    </>
  );
}

/** One display row: the run inside a `wrap="truncate"` `Text`, so it can never wrap. */
export function GovernanceLine({ segments, theme }: GovernanceRunProps): React.ReactElement {
  return (
    <Text wrap="truncate">
      <GovernanceRun segments={segments} theme={theme} />
    </Text>
  );
}
