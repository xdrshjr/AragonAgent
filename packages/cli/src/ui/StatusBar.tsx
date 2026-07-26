/**
 * Status bar (spec §4.8). Width-aware, borderless, EXACTLY one row: a left
 * cluster (run status, model, thinking level) and a right cluster (context
 * gauge, tokens, cost, tokens/sec + elapsed while running, off-bottom `↑N`).
 * Clusters drop out gracefully on narrow terminals.
 *
 * Dropping the round border here buys back 3 rows of a 24-row terminal — an
 * eighth of the screen was being spent framing a single line of text.
 */

import React from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import type { UsageTotal } from '../agent/reducer.js';
import { formatCost, formatTokens, formatDuration } from '../agent/usage.js';
import { buildGauge } from './gauge.js';

interface StatusBarProps {
  model: string;
  provider: string;
  usageTotal: UsageTotal;
  contextTokens: number;
  contextWindow: number;
  contextWindowKnown: boolean;
  status: 'idle' | 'running';
  elapsedMs: number;
  thinkingLevel: string;
  tokPerSec: number;
  theme: Theme;
  caps: TermCapabilities;
  /**
   * Lines scrolled off the bottom; > 0 renders `↑N`. Inline mode has no
   * self-drawn viewport, so it simply never sends anything but 0 — the bar
   * needs no render-mode branch of its own.
   */
  scrolledLines?: number;
  /**
   * Ctrl+L redraw carrier — invariant I-5 (spec §4.13). See `redrawChar`.
   */
  redrawNonce?: number;
}

/**
 * I-5 — DO NOT "CLEAN THIS UP". Ink short-circuits identical output at TWO
 * gates (`ink.js:132` and `log-update.js:13`), so a fixed frame whose React
 * output has not changed is never repainted. `Ctrl+L` therefore cannot work by
 * writing an escape sequence; it works by making the rendered STRING differ.
 * This alternates the status bar's left gutter between U+0020 and U+00A0: both
 * render one invisible column, so there is zero visual or layout difference,
 * but the bytes differ and both gates open.
 *
 * It must sit at the START of the line: Ink `trimEnd()`s every row (output.js),
 * and JS `trimEnd` strips U+00A0 too — a trailing carrier would be deleted and
 * Ctrl+L would degrade to a silent no-op.
 */
/** Built by code point so no formatter can normalize it back to a plain space. */
const NBSP = String.fromCharCode(0x00a0);

function redrawChar(nonce: number): string {
  return nonce % 2 === 0 ? ' ' : NBSP;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const {
    model,
    provider,
    usageTotal,
    contextTokens,
    contextWindow,
    contextWindowKnown,
    status,
    elapsedMs,
    thinkingLevel,
    tokPerSec,
    theme,
    caps,
    scrolledLines = 0,
    redrawNonce = 0,
  } = props;

  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const running = status === 'running';

  const glyphs = pickGlyphs(caps);
  const pct =
    contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;
  const gauge = buildGauge(pct, cols < 72 ? 8 : 12, theme, caps);
  const pctLabel = `${contextWindowKnown ? '' : '~'}${gauge.pct}%`;
  const tokens = `${formatTokens(usageTotal.inputTokens)}${glyphs.arrowUp} ${formatTokens(
    usageTotal.outputTokens,
  )}${glyphs.arrowDown}`;

  const statusGlyph = running ? theme.symbols.toolRunning : theme.symbols.toolPending;

  return (
    // `flexShrink={0}` on the left cluster is not cosmetic. When the two clusters
    // over-subscribe the row, yoga shrinks the flexible children and Ink's text
    // measurement drops a character from EACH of them — the bar renders "idl"
    // and "? hel" rather than truncating cleanly at one end. Pinning the left
    // cluster keeps the run status and model intact and makes the degradation
    // land in one predictable place.
    <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <Box flexDirection="row" flexShrink={0}>
        <Text color={running ? theme.toolRunning : theme.toolDone}>
          {redrawChar(redrawNonce)}
          {statusGlyph} {running ? 'running' : 'idle'}
        </Text>
        {cols >= 60 && (
          <Text color={theme.muted}>
            {'  '}
            {provider}:{model}
          </Text>
        )}
        {thinkingLevel !== 'off' && cols >= 72 && (
          <Text color={theme.accent}>  think:{thinkingLevel}</Text>
        )}
      </Box>

      <Box flexDirection="row">
        {scrolledLines > 0 && (
          <Text color={theme.noticeWarn}>
            {glyphs.arrowUp}
            {scrolledLines}
            {'  '}
          </Text>
        )}
        {cols >= 60 && (
          <Text>
            <Text color={theme.muted}>[</Text>
            <Text color={gauge.fillColor}>{gauge.filled}</Text>
            <Text color={gauge.trackColor}>{gauge.empty}</Text>
            <Text color={theme.muted}>] </Text>
          </Text>
        )}
        <Text color={theme.muted}>{pctLabel}</Text>
        {cols >= 72 && <Text color={theme.muted}>  {tokens}</Text>}
        <Text color={theme.muted}>  {formatCost(usageTotal.costUsd)}</Text>
        {running && (
          <Text color={theme.muted}>
            {tokPerSec > 0 && cols >= 72 ? `  ${tokPerSec} tok/s` : ''}  {formatDuration(elapsedMs)}
          </Text>
        )}
        {/*
          The keybinding hint cluster that used to live here is GONE (§4.6). It
          duplicated the composer's hint row — on a 110x24 terminal both were on
          screen at once — and its 31 columns are what forced the odd `cols >=
          110` breakpoint and pushed the bar into the character-dropping regime
          described above. The status bar now shows state; the composer shows
          keys. `redrawChar` above is unrelated to the hint and must stay (I-5).
        */}
      </Box>
    </Box>
  );
}
