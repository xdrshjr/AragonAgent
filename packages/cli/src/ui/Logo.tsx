/**
 * Brand wordmark (spec §5.1 / R1). The first row of the frame always starts
 * with a brand glyph, at every terminal size and every capability tier.
 */

import React from 'react';
import { Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { gradientLine } from './gradient.js';

/** 6 rows × 52 columns, every row equal width (pinned by logo.test.ts). */
export const LOGO_ART: readonly string[] = [
  ' █████╗ ██████╗  █████╗  ██████╗  ██████╗ ███╗   ██╗',
  '██╔══██╗██╔══██╗██╔══██╗██╔════╝ ██╔═══██╗████╗  ██║',
  '███████║██████╔╝███████║██║  ███╗██║   ██║██╔██╗ ██║',
  '██╔══██║██╔══██╗██╔══██║██║   ██║██║   ██║██║╚██╗██║',
  '██║  ██║██║  ██║██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║',
  '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝',
];

export const LOGO_ART_WIDTH = 52;

export type HeaderVariant = 'bar' | 'mini';
/** How the one-off opening wordmark renders inside the viewport (§4.2). */
export type OpenerVariant = 'art' | 'banner' | 'none';

/** Minimum viewport rows / cols each tier needs before it earns its budget. */
const ART_MIN_VIEWPORT_ROWS = 14;
/**
 * 4 columns of headroom on purpose: the art renders with `wrap="truncate"`, so
 * at zero headroom anything upstream claiming a single column silently shears
 * the right edge off the `N`. Between `LOGO_ART_WIDTH` and this threshold the
 * opener degrades to `banner`, which is the intended fallback (rename C2).
 */
const ART_MIN_COLS = LOGO_ART_WIDTH + 4;
const BANNER_MIN_COLS = 48;
const BAR_MIN_COLS = 40;

export function pickHeaderVariant(cols: number): HeaderVariant {
  return cols >= BAR_MIN_COLS ? 'bar' : 'mini';
}

/**
 * Pick the opening wordmark tier.
 *
 * Judged against VIEWPORT rows rather than terminal rows because the wordmark
 * now spends the viewport's budget, not the frame's: the test has to be against
 * the account being charged.
 *
 * No hand-drawn ASCII fallback for `art`: figlet-style art is hard to keep
 * column-aligned, and a terminal without Unicode should not be paying six rows
 * for a wordmark in the first place. `banner` still carries the brand there, and
 * the always-present header bar carries it even at `none` (R1).
 */
export function pickOpenerVariant(
  viewportRows: number,
  cols: number,
  caps: TermCapabilities,
): OpenerVariant {
  if (
    viewportRows >= ART_MIN_VIEWPORT_ROWS &&
    cols >= ART_MIN_COLS &&
    caps.unicode &&
    caps.colorLevel >= 2
  ) {
    return 'art';
  }
  if (cols >= BANNER_MIN_COLS) return 'banner';
  return 'none';
}

/** Rotate the gradient stops by one per row so the block reads as a diagonal sheen. */
function shiftStops(stops: string[], row: number): string[] {
  if (stops.length === 0) return stops;
  const at = row % stops.length;
  return [...stops.slice(at), ...stops.slice(0, at)];
}

export interface LogoProps {
  /** `art` / `banner` come from `SessionOpener`; `bar` / `mini` from `Header`. */
  variant: HeaderVariant | OpenerVariant;
  theme: Theme;
  caps: TermCapabilities;
}

export function Logo({ variant, theme, caps }: LogoProps): React.ReactElement | null {
  const wordmark = `${theme.symbols.wordmark} AragonAgent`;

  if (variant === 'none') return null;

  if (variant === 'art') {
    return (
      <>
        {LOGO_ART.map((line, i) => (
          <Text
            key={i}
            wrap="truncate"
            color={theme.gradient.length > 0 ? undefined : theme.logoShadow}
          >
            {gradientLine(line, shiftStops(theme.gradient, i), caps.colorLevel)}
          </Text>
        ))}
      </>
    );
  }

  if (variant === 'banner') {
    return (
      <Text wrap="truncate" bold color={theme.gradient.length > 0 ? undefined : theme.primary}>
        {gradientLine(wordmark, theme.gradient, caps.colorLevel)}
      </Text>
    );
  }

  return (
    <Text bold color={theme.primary}>
      {wordmark}
    </Text>
  );
}
