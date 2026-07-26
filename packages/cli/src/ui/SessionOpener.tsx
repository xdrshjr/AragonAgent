/**
 * SessionOpener (spec §4.2 / §4.8) — the opening wordmark plus the getting
 * started card, rendered as the FIRST BLOCK OF VIEWPORT CONTENT rather than as
 * part of the fixed header.
 *
 * That relocation is the whole point. As header chrome the wordmark occupied
 * permanent vertical budget for what is a one-off greeting, so it had to be
 * yanked away the instant the first message arrived — a 7-row jump and a full
 * reflow. As content it simply scrolls out of view like anything else, which is
 * both calmer and what the reference implementation does.
 *
 * Absorbs the former `Welcome.tsx`, whose 8-row round-bordered card spent 4 rows
 * on a border and two blank lines — over half of a short terminal's empty-session
 * viewport carrying no information.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { Logo, type OpenerVariant } from './Logo.js';

export interface SessionOpenerProps {
  variant: OpenerVariant;
  version: string;
  cwd: string;
  hasKey: boolean;
  /** Drives the last-ditch squeeze to a single line on very short terminals. */
  viewportRows: number;
  theme: Theme;
  caps: TermCapabilities;
}

const EXAMPLE = 'Explain what this repository does';

/** Below this the opener keeps only the safety warning. */
const TERSE_VIEWPORT_ROWS = 10;

export function SessionOpener({
  variant,
  version,
  cwd,
  hasKey,
  viewportRows,
  theme,
  caps,
}: SessionOpenerProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const terse = viewportRows < TERSE_VIEWPORT_ROWS;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {!terse && variant !== 'none' && <Logo variant={variant} theme={theme} caps={caps} />}
      {!terse && (
        <Text wrap="truncate">
          <Text color={theme.muted}>
            v{version}
            {'  '}
            {cwd}
          </Text>
        </Text>
      )}
      <Text wrap="truncate" color={theme.noticeWarn}>
        {glyphs.warn} Full permission, no sandbox: bash runs and files are written directly.
      </Text>
      {!hasKey && (
        <Text wrap="truncate" color={theme.noticeWarn}>
          {glyphs.arrowRight} Run /settings (or set ANTHROPIC_API_KEY) to get started.
        </Text>
      )}
      {!terse && hasKey && (
        <Text wrap="truncate">
          <Text color={theme.accent}>{glyphs.bullet} </Text>
          <Text color={theme.hintFg ?? theme.muted}>{EXAMPLE}</Text>
        </Text>
      )}
    </Box>
  );
}
