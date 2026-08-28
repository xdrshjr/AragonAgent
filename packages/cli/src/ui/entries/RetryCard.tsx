/**
 * RetryCard — the one-line retry entry (llm-api-retry-backoff §6.5).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`, and the line itself is built by
 * the pure `formatRetryLine` in `agent/retry-view.ts` so it can be asserted
 * without a terminal.
 *
 * ONE LINE. ALWAYS ONE LINE. Ten retries rendered as ten notices would bury the
 * transcript in the one moment the user most needs it legible, so this card is
 * rewritten in place for the whole turn and settles into a single row of history.
 * Amber while in flight, muted once recovered, red once the ladder is exhausted.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { formatRetryLine, type RetryPhase } from '../../agent/retry-view.js';

export interface RetryCardProps {
  attempt: number;
  maxRetries: number;
  errorType: string;
  phase: RetryPhase;
  resumeAt?: number;
  totalRetries?: number;
  elapsedMs?: number;
  /**
   * `Date.now()` at render, injected so the component stays testable.
   *
   * The countdown is recomputed from `resumeAt - now` on every frame; `App` runs a
   * 1 Hz tick ONLY while the phase is `waiting`, so an idle session has no timer.
   */
  now: number;
  /**
   * Whether Esc would actually be felt. `App` passes `true` only for an
   * interactive session, because the hint has to be the truth: the wait is
   * signal-aware in `withRetry`, so Esc lands within a frame — but there is no Esc
   * in headless mode to promise.
   */
  interactive?: boolean;
  reducedMotion?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * The card's tone. `exhausted` is the only failure: an `interrupted` card records
 * a user decision, and colouring that red would blame them for it.
 */
export function retryCardColor(phase: RetryPhase, theme: Theme): string | undefined {
  if (phase === 'waiting' || phase === 'retrying') return theme.noticeWarn;
  if (phase === 'exhausted') return theme.noticeError;
  return theme.muted;
}

function RetryCardImpl(props: RetryCardProps): React.ReactElement {
  const {
    attempt,
    maxRetries,
    errorType,
    phase,
    resumeAt,
    totalRetries,
    elapsedMs,
    now,
    // DEFAULTS TO TRUE: reaching this component means a TUI is mounted, and the
    // TUI always binds Esc to abort. The prop exists so headless-shaped callers
    // and the render tests can assert the suppressed form.
    interactive = true,
    reducedMotion,
    theme,
    caps,
  } = props;
  const glyphs = pickGlyphs(caps);
  const color = retryCardColor(phase, theme);
  const inFlight = phase === 'waiting' || phase === 'retrying';
  const line = formatRetryLine(
    {
      attempt,
      maxRetries,
      errorType,
      phase,
      ...(resumeAt !== undefined ? { resumeAt } : {}),
      ...(totalRetries !== undefined ? { totalRetries } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    },
    glyphs,
    now,
  );

  // REDUCED MOTION SUPPRESSES THE SPINNER AND KEEPS THE COUNTDOWN. A frozen number
  // is not calmer, it is broken: reduced motion is about animation, and a
  // countdown is information.
  const animate = inFlight && !reducedMotion && caps.unicode;

  return (
    <Box flexDirection="row">
      {animate ? (
        <Text color={color}>
          <Spinner type="dots" />{' '}
        </Text>
      ) : null}
      <Text color={color} wrap="truncate">
        {line}
      </Text>
      {phase === 'waiting' && interactive && (
        <Text color={theme.muted}>{'  '}Esc to cancel</Text>
      )}
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` preserves object identity for untouched entries, and `theme` / `caps`
 * are `useMemo`d in `App.tsx` (I-L2-1). `now` changes once a second while the card
 * is waiting, which is exactly when it must re-render.
 */
export const RetryCard = React.memo(RetryCardImpl);
