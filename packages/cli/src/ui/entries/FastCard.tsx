/**
 * FastCard — one fast-model review in the transcript (fast-model-tier §6).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`.
 *
 * SINGLE AND QUIET, NEVER MORE THAN SIX ROWS. It renders through the shared
 * `EntryFrame` supplied by `EntryView`, so a review reads as one more step in
 * the transcript rather than a second kind of object.
 *
 * COLLAPSED BY CONSTRUCTION rather than by an expand toggle: the critique is
 * already clamped to `fast.reviewMaxChars` before it ever reaches here, so there
 * is nothing hidden for a `Ctrl+O` to reveal.
 *
 * `ok`, `failed` and `dropped` each render ONE muted line. `ok` is the common
 * case and must stay visually cheap — a full card every few turns saying
 * "nothing to report" would be the feature's most annoying possible surface —
 * while `failed` and `dropped` exist so that "it did nothing" is never the
 * observable outcome (R-8).
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { formatDuration } from '../../agent/usage.js';
import { FAST_LIMITS } from '../../fast/limits.js';

export type FastCardStatus = 'running' | 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';

export interface FastCardProps {
  reviewIndex: number;
  model: string;
  status: FastCardStatus;
  text?: string;
  detail?: string;
  turn: number;
  durationMs?: number;
  live: boolean;
  reducedMotion?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * The card's colour.
 *
 * `advice` is the ACCENT rather than a warning colour: a second opinion is not
 * an error, and colouring it like one would teach the user to read every review
 * as something having gone wrong.
 */
export function fastCardColor(status: FastCardStatus, theme: Theme): string | undefined {
  if (status === 'running') return theme.toolRunning;
  if (status === 'advice') return theme.accent;
  if (status === 'failed') return theme.toolError;
  return theme.muted;
}

/** The one-line summary that follows the header on every non-advice status. */
function statusLine(props: FastCardProps): string {
  switch (props.status) {
    case 'running':
      return 'reviewing...';
    case 'ok':
      return 'on track';
    case 'empty':
      return 'no answer';
    case 'failed':
      return props.detail ? `failed: ${props.detail}` : 'failed';
    case 'dropped':
      return props.detail ? `dropped: ${props.detail}` : 'dropped';
    default:
      return '';
  }
}

/**
 * Split the critique into at most `FAST_LIMITS.cardTextRows` lines.
 *
 * The clamp is a ROW budget, not a character one: `reviewMaxChars` already
 * bounded the text, and this only stops a critique with no whitespace at all
 * from turning into a wall on a narrow terminal. Ink wraps the rest.
 */
function textRows(text: string): string[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(0, FAST_LIMITS.cardTextRows);
}

function FastCardImpl(props: FastCardProps): React.ReactElement {
  const { reviewIndex, model, status, text, turn, durationMs, live, reducedMotion, theme, caps } =
    props;
  const glyphs = pickGlyphs(caps);
  const color = fastCardColor(status, theme);
  const duration = durationMs === undefined ? '' : `  ${glyphs.midDot}  ${formatDuration(durationMs)}`;
  const head = `fast review #${reviewIndex}  ${glyphs.midDot}  ${model}  ${glyphs.midDot}  turn ${turn}${duration}`;

  const showBody = status === 'advice' && text !== undefined && text.trim().length > 0;

  // COLOUR TRACKS `live`, MOTION TRACKS `animate` — one headline, two separate
  // decisions (single-spinner-while-running C-1 / D-7).
  //
  // These used to be two whole `<Text>` elements, so the still branch also
  // demoted the head to `theme.muted`. That was harmless while stillness meant
  // "the user set reducedMotion", but `App` now widens the prop to "this frame
  // does not animate here" for the whole of every run — and under the old shape
  // that would have greyed out every live fast review for the whole run, losing
  // the status colour along with the motion.
  //
  // Three things are load-bearing and all three are silent if dropped: the
  // leading two-space gutter that separates the head from the bold `fast` label,
  // the single space after the marker (the still form bakes it into its template
  // string), and `head` itself. `wrap="truncate"` now applies to the animated
  // path too, which it did not before: it is what the still branch always did,
  // it is the behaviour this card has in every state that is now common, and an
  // unbounded wrap inside a one-row headline is the worse failure.
  const animate = live && !reducedMotion && caps.unicode;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.accent} bold>
          fast
        </Text>
        <Text color={live ? color : theme.muted} wrap="truncate">
          {'  '}
          {animate ? (
            <>
              <Spinner type="dots" />{' '}
            </>
          ) : live ? (
            `${glyphs.spinnerStill} `
          ) : (
            ''
          )}
          {head}
        </Text>
      </Box>

      {showBody ? (
        <Box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={1}
          {...railBorderProps(glyphs.railVertical, theme.border)}
        >
          {textRows(text!).map((line, index) => (
            <Text key={index} color={theme.primary}>
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" flexShrink={0} paddingLeft={1}>
          <Text color={color} wrap="truncate">
            {statusLine(props)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` already preserves object identity for untouched entries, so the
 * props below are stable references on a settled card, and `theme` / `caps` are
 * `useMemo`d in `App.tsx` (I-L2-1).
 */
export const FastCard = React.memo(FastCardImpl);
