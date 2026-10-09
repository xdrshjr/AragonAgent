/**
 * CompactionCard — one context compaction in the transcript
 * (context-auto-compaction §6.3).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`, INCLUDING THE ARROW. The mock
 * in the design shows `112 -> 9 messages`; that arrow is `glyphs.arrowRight`, the
 * one `StatusBar` already uses, not a literal — `ui/` is inside
 * `glyphs.test.ts::inScope`, so a literal here fails the scan (P2-7).
 *
 * EXPANDABLE, UNLIKE `FastCard`. A critique is already clamped to
 * `fast.reviewMaxChars` before it reaches its card, so there is nothing hidden
 * for Ctrl+O to reveal; a summary is up to `summaryMaxChars` and there genuinely
 * is more to see. That is why `App`'s Ctrl+O predicate had to learn about this
 * kind — without it the card renders a hint that does nothing and expands an
 * older tool card instead (C-15 / P1-8 / AC-21).
 *
 * EVERY STRING DESCRIBES THE HISTORY, NEVER THE SCREEN (§6.4 / P2-9). `/clear`
 * empties the transcript view but not `messages`, so this card can legitimately
 * report "112 -> 9 messages" with nine visible rows above it. Nothing here says
 * "above" or "earlier in this transcript".
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { formatDuration, formatTokens } from '../../agent/usage.js';
import { COMPACTION_LIMITS } from '../../compaction/limits.js';
import type { CompactionDecision, CompactionMode, CompactionUiTrigger } from '../../compaction/types.js';

export interface CompactionCardProps {
  decision?: CompactionDecision;
  memoryVersion?: 2;
  index: number;
  trigger: CompactionUiTrigger;
  mode: CompactionMode;
  applied: boolean;
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  model: string;
  durationMs?: number;
  /**
   * Wall-clock since the card opened, LIVE ONLY
   * (context-auto-compaction-hardening §3.6 / W5).
   *
   * Rendered in the position `durationMs` occupies once settled, so the number
   * does not move when the card settles. Only the single live card receives it,
   * so exactly one memoized card re-renders per second.
   */
  elapsedMs?: number;
  /** Set when tail relief clipped the retained turns (W2). */
  tailRelief?: { messages: number; charsRemoved: number };
  live: boolean;
  expanded?: boolean;
  reducedMotion?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * The card's colour.
 *
 * `truncated` is a WARNING rather than the accent, because it is a real and
 * bounded data loss the user is entitled to notice; `applied: false` is an error
 * because the run is still at the occupancy that triggered it.
 */
export function compactionCardColor(
  props: Pick<CompactionCardProps, 'live' | 'applied' | 'mode'>,
  theme: Theme,
): string | undefined {
  if (props.live) return theme.toolRunning;
  if (!props.applied) return theme.toolError;
  if (props.mode === 'truncated' || props.mode === 'relieved') return theme.noticeWarn;
  return theme.accent;
}

/** The one-line summary of what the compaction did, or why it did not. */
function headline(props: CompactionCardProps, arrow: string, dot: string): string {
  const { index, live } = props;
  // The model is `''` when no summarizer resolves (no key for the provider), and
  // the separator has to go with it — a headline ending in a dangling `  -  `
  // reads as a rendering fault rather than as the missing model it is.
  if (live) {
    // ELAPSED IN THE SAME POSITION `durationMs` TAKES ONCE SETTLED, so the number
    // does not jump across the line when the card settles. Between second 0 and
    // second 45 this was the only changing information on the card, and there was
    // none.
    const elapsed = props.elapsedMs === undefined ? '' : `${dot}${formatDuration(props.elapsedMs)}`;
    return props.model
      ? `compacting context #${index}${dot}${props.model}${elapsed}`
      : `compacting context #${index}${elapsed}`;
  }

  if (!props.applied || props.tokensAfter >= props.tokensBefore) {
    const why = props.reason ? `: ${props.reason}` : '';
    return `context not compacted #${index}${why}`;
  }

  const messages = `${props.messagesBefore} ${arrow} ${props.messagesAfter} messages`;
  const tokens = `${formatTokens(props.tokensBefore)} ${arrow} ${formatTokens(props.tokensAfter)} tokens`;
  const duration = props.durationMs === undefined ? '' : `${dot}${formatDuration(props.durationMs)}`;
  return `context compacted${dot}${messages}${dot}${tokens}${duration}`;
}

/**
 * The muted second line: how it was done, and with what.
 *
 * THE LIVE BRANCH NAMES THE ESCAPE (§3.6 / E-10). `AgentController.abort()` has
 * always called `this.compaction?.abort()` before `agent.abort()`, so Esc has
 * always cancelled an in-flight summarization - and no surface has ever said so
 * during the forty-five seconds it matters. The hint goes with the model for the
 * same reason the separator does: with no summarizer resolved there is no call to
 * cancel.
 *
 * THE `relieved` BRANCH COMES BEFORE `truncated`, AND IT EXISTS BECAUSE THE
 * `summarized` LINE WOULD OTHERWISE LIE. Relief drops no messages, so the
 * fall-through would render "summarized 0 messages with <model>" for a
 * compaction in which no model was called - in the rare, alarming case the user
 * most needs to read correctly.
 */
function detailLine(props: CompactionCardProps): string {
  if (props.live) {
    if (!props.model) return '';
    return `summarizing with ${props.model} - esc to cancel`;
  }
  if (!props.applied || props.tokensAfter >= props.tokensBefore) return 'History preserved.';
  const dropped = Math.max(0, props.messagesBefore - props.messagesAfter);
  if (props.mode === 'relieved') {
    const n = props.tailRelief?.messages ?? 0;
    return `clipped ${n} tool ${n === 1 ? 'result' : 'results'} in the retained turns - nothing could be dropped`;
  }
  if (props.mode === 'truncated') {
    return `dropped ${dropped} messages WITHOUT a summary - summarization failed`;
  }
  const via = props.trigger === 'overflow' ? ' after a context overflow' : '';
  return `summarized ${dropped} messages with ${props.model}${via}`;
}

/**
 * The relief disclosure, on a settled card that ALSO summarized.
 *
 * A BOUNDED, ANNOUNCED DATA LOSS THE USER IS ENTITLED TO NOTICE, in the same
 * voice §6.4's honesty rules use for `truncated`. Suppressed on the `relieved`
 * card, where `detailLine` has already said it and a second line would be the
 * same sentence twice.
 */
function reliefLine(props: CompactionCardProps): string {
  if (props.live || !props.applied || !props.tailRelief || props.mode === 'relieved') return '';
  const n = props.tailRelief.messages;
  return (
    `clipped ${n} tool ${n === 1 ? 'result' : 'results'} in the retained turns ` +
    `(${formatTokens(props.tailRelief.charsRemoved)} characters) - ` +
    'the recent turns alone exceeded the window'
  );
}

/**
 * Split the summary into rows.
 *
 * A ROW budget, not a character one: `summaryMaxChars` already bounded the text,
 * and this only decides how much of it the COLLAPSED card shows. Ink wraps the
 * rest.
 */
function summaryRows(text: string, expanded: boolean): string[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return expanded ? lines : lines.slice(0, COMPACTION_LIMITS.cardTextRows);
}

function CompactionCardImpl(props: CompactionCardProps): React.ReactElement {
  const { live, summary, expanded, reducedMotion, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const color = compactionCardColor(props, theme);
  const dot = `  ${glyphs.midDot}  `;
  const head = headline(props, glyphs.arrowRight, dot);
  const detail = detailLine(props);
  const relief = reliefLine(props);

  const showMemory = props.memoryVersion !== 2 || expanded === true;
  const rows = summary && showMemory ? summaryRows(summary, expanded === true) : [];
  const totalRows = summary ? summary.split('\n').filter((l) => l.trim().length > 0).length : 0;
  const hidden = Math.max(0, totalRows - rows.length);

  // COLOUR TRACKS `live`, MOTION TRACKS `animate` — one headline, two separate
  // decisions, and the split is the one `FastCard` records at length: `App`
  // widens `reducedMotion` to "this frame does not animate here" for the whole of
  // every run, and folding the two together would grey out every live card for
  // the whole run, losing the status colour along with the motion.
  const animate = live && reducedMotion !== true && caps.unicode;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text color={theme.accent} bold>
          {props.trigger === 'manual' ? 'Manual compaction' : props.trigger === 'overflow'
            ? 'Overflow: threshold reached' : 'Automatic: threshold reached'}
        </Text>
        <Text color={live ? color : theme.muted} wrap={caps.unicode ? 'truncate' : 'wrap'}>
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

      {props.memoryVersion === 2 && (
        <Text color={theme.muted}>
          Task memory v2{expanded ? '' : ' (ctrl+o to expand)'}
        </Text>
      )}

      {detail.length > 0 && (
        <Box flexDirection="column" flexShrink={0} paddingLeft={1}>
          <Text color={color} wrap={caps.unicode ? 'truncate' : 'wrap'}>
            {detail}
          </Text>
        </Box>
      )}

      {relief.length > 0 && (
        <Box flexDirection="column" flexShrink={0} paddingLeft={1}>
          <Text color={theme.noticeWarn}>{relief}</Text>
        </Box>
      )}

      {rows.length > 0 && (
        <Box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={1}
          {...railBorderProps(glyphs.railVertical, theme.border)}
        >
          {rows.map((line, index) => (
            <Text key={index} color={theme.primary}>
              {line}
            </Text>
          ))}
          {hidden > 0 && (
            <Text color={theme.muted}>
              {glyphs.railEnd} +{hidden} more lines (ctrl+o to expand)
            </Text>
          )}
          {hidden === 0 && expanded === true && totalRows > COMPACTION_LIMITS.cardTextRows && (
            <Text color={theme.muted}>{glyphs.railEnd} ctrl+o to collapse</Text>
          )}
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
export const CompactionCard = React.memo(CompactionCardImpl);
