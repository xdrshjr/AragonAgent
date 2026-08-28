/**
 * Tool-call card (spec §3.5): a per-tool glyph, the tool name, a compact args
 * summary, a colored status badge, and a duration, over a collapsible rich
 * preview delegated to `<ToolPreview>`. Collapsed to the first 8 lines with a
 * `+M lines (Ctrl+O)` footer; `Ctrl+O` / `/expand` toggle the full preview.
 *
 * Two v0.4.0 changes (§4.1 / §4.3):
 *  - capabilities arrive as a prop. This used to infer Unicode support by
 *    comparing `theme.symbols.gaugeFull` against a literal block character, so
 *    editing an unrelated gauge glyph would have silently sent every tool icon
 *    back to ASCII;
 *  - the preview's round border is gone. It cost 2 rows and 4 columns per card,
 *    and nested visibly inside markdown code blocks. A left rail carries the
 *    same grouping in 1 column and 0 rows.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs, toolGlyph } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { splitLinesCached } from '../render-cache.js';
import { formatDuration } from '../../agent/usage.js';
import type { ToolStatus } from '../../agent/reducer.js';
import type { FilePatch } from '../../tools/patch.js';
import { ToolPreview, bashBadge } from './ToolPreview.js';
import { DiffView } from './DiffView.js';
import { STALL_AFTER_MS } from '../../tools/tool-output-store.js';

/** Number of preview lines shown before collapse. */
const COLLAPSED_LINES = 8;

/** Shared empty slice, so an argument-less card allocates nothing per frame. */
const EMPTY_LINES: readonly string[] = [];

interface ToolCardProps {
  name: string;
  label: string;
  argsRaw: string;
  args?: Record<string, unknown>;
  status: ToolStatus;
  preview?: string;
  /**
   * The structured file diff, when the tool produced one (§3.4). Present it and
   * `DiffView` draws INSTEAD of `ToolPreview`; absent — a session saved by an
   * older build, an entry the store's 64-write ring evicted, or a toolset built
   * without a recorder — and the text preview renders exactly what it does
   * today. Nothing ever renders blank.
   */
  patch?: FilePatch;
  durationMs?: number;
  isError?: boolean;
  expanded?: boolean;
  reducedMotion?: boolean;
  /**
   * Inline mode only (L5): ceiling on the rows a LIVE card contributes to the
   * non-`<Static>` region. `undefined` — what the full-screen branch passes —
   * means no clamp and byte-identical output.
   */
  liveClampRows?: number;
  /**
   * The sanitised live tail while the tool runs
   * (agent-activity-presentation-live §3.3.4).
   *
   * PASSED AS `live={entry.live}` AND NEVER `live={entry.live ?? []}` (P2-4).
   * This component is `React.memo` with the DEFAULT comparator, so a fresh `[]`
   * per render is a changed prop and defeats the boundary for every settled card
   * in the transcript — which is exactly why `EMPTY_LINES` above exists.
   */
  live?: readonly string[];
  /** Epoch ms of the last output row; with `nowSec`, the stall row's clock. */
  lastOutputAt?: number;
  /**
   * Wall-clock SECONDS, passed ONLY to running entries (D-29 / D-36).
   *
   * Seconds and not milliseconds, and `undefined` on every other card, for the
   * same reason: a prop that changed five times a second on every entry would
   * defeat this memo boundary transcript-wide. The value is wall-clock rather
   * than the ticker's `elapsedMs` because the stall is `now - lastOutputAt` and
   * `lastOutputAt` is epoch ms; the ticker's job is to cause the render.
   */
  nowSec?: number;
  theme: Theme;
  caps: TermCapabilities;
}

export function statusColor(status: ToolStatus, theme: Theme): string | undefined {
  switch (status) {
    case 'pending':
      return theme.toolPending;
    case 'running':
      return theme.toolRunning;
    case 'done':
      return theme.toolDone;
    case 'error':
      return theme.toolError;
  }
}

/** One-line summary of the tool arguments for the card header. */
function summarizeArgs(
  name: string,
  ellipsis: string,
  args?: Record<string, unknown>,
  argsRaw?: string,
): string {
  if (args) {
    if (name === 'bash' && typeof args.command === 'string') return args.command;
    if (typeof args.path === 'string') return args.path;
    if (typeof args.pattern === 'string') return args.pattern;
    const keys = Object.keys(args);
    if (keys.length > 0) return keys.map((k) => `${k}=${short(args[k], ellipsis)}`).join(' ');
  }
  return (argsRaw ?? '').slice(0, 60);
}

function short(v: unknown, ellipsis: string): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}${ellipsis}` : s;
}

/** The badge label shown to the right of the tool name. */
function badgeLabel(name: string, status: ToolStatus, preview: string): string {
  if (name === 'bash' && (status === 'done' || status === 'error')) {
    return bashBadge(status, preview).text;
  }
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
  }
}

/** The tool's own glyph, used by `EntryView` as the entry's rail marker. */
export function toolEntryGlyph(name: string, caps: TermCapabilities): string {
  return toolGlyph(pickGlyphs(caps), name);
}

function ToolCardImpl(props: ToolCardProps): React.ReactElement {
  const {
    name,
    argsRaw,
    args,
    status,
    preview,
    patch,
    durationMs,
    isError,
    expanded,
    reducedMotion,
    liveClampRows,
    live,
    lastOutputAt,
    nowSec,
    theme,
    caps,
  } = props;
  const glyphs = pickGlyphs(caps);
  const color = statusColor(status, theme);
  const previewText = preview ?? '';
  // `splitLinesCached` rather than `previewText.split('\n')`: a stored preview
  // is immutable once written, and this used to reallocate up to 200 strings per
  // card per frame (R3).
  const previewLines = previewText.length > 0 ? splitLinesCached(previewText) : EMPTY_LINES;
  // Head-first, exactly as before: the collapsed card shows the FIRST 8 lines.
  // The inline clamp only lowers the ceiling — it never changes which end is
  // kept, because `Ctrl+O` on a 5 000-line bash result is precisely how an
  // inline session reaches `ink.js:121` (I-L5-1) and the fix must not also
  // reshuffle what a full-screen user has been reading for four releases.
  const ceiling = Math.min(
    expanded ? previewLines.length : COLLAPSED_LINES,
    liveClampRows ?? Number.POSITIVE_INFINITY,
  );
  const visibleLines =
    ceiling >= previewLines.length ? previewLines : previewLines.slice(0, ceiling);
  const hidden = previewLines.length - visibleLines.length;
  const settled = status === 'done' || status === 'error';
  const showPatch = !!patch && settled;
  // The live tail (agent-activity-presentation-live §3.3.4). `expanded` is
  // deliberately ABSENT from this arithmetic: `Ctrl+O` is inert on a live card
  // (D-26), because expansion is a promise about STORED content and the store
  // deliberately holds eight rows. A key that silently does nothing is better
  // than a key that promises the rest of a 400 MB stream.
  //
  // THE TAIL IS THE **LAST** ROWS, and the settled preview above keeps its
  // head-first slice (E-21). Two different ends because they answer two
  // different questions — "what did this command do" versus "what is it doing
  // NOW" (D-25). Head-first while live would freeze on the first eight lines a
  // build ever printed and then never change again.
  const liveRows = live ?? EMPTY_LINES;
  const liveCeiling = Math.min(
    COLLAPSED_LINES,
    // Inline only: `liveClampRows` already subtracts one row per live entry to
    // pay for a marker (`Transcript.tsx:534-538`), which is what this card's
    // unconditional footer spends (AC-36 / P2-7).
    liveClampRows ?? Number.POSITIVE_INFINITY,
  );
  const visibleLive =
    liveRows.length > liveCeiling ? liveRows.slice(-Math.max(1, liveCeiling)) : liveRows;
  const showLive = !settled && visibleLive.length > 0;
  // THE OUTER GUARD WIDENS WITH THE BRANCH (P2-2). It was `previewLines.length >
  // 0 && ...`, and the reducer now truncates the stored preview to ONE LINE when
  // a patch is attached (D-19) — so a card whose preview were ever empty would
  // render its header and swallow the diff, silently. It widens a second time
  // here, for the third branch: without `|| showLive` the tail would be computed
  // and never drawn.
  const showBody = ((previewLines.length > 0 || showPatch) && settled) || showLive;
  // ONE FOOTER ROW, ALWAYS, matching `estimateEntryRows`'s arithmetic exactly: a
  // CONSTANT row count is what lets the estimate be exact rather than an upper
  // bound. `nowSec` is absent until the first tick, which reads as "not stalled".
  const stalledFor =
    nowSec !== undefined && lastOutputAt !== undefined
      ? nowSec * 1000 - lastOutputAt
      : 0;
  const liveFooter =
    stalledFor >= STALL_AFTER_MS
      ? `no output for ${Math.floor(stalledFor / 1000)}s`
      : '(running)';

  const badge =
    status === 'running' && !reducedMotion && caps.unicode ? (
      <Text color={color}>
        <Spinner type="dots" /> running
      </Text>
    ) : (
      <Text color={color}>
        {status === 'running' ? `${glyphs.spinnerStill} ` : ''}
        {badgeLabel(name, status, previewText)}
      </Text>
    );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.accent} bold>
          {name}
        </Text>
        <Text color={theme.muted}> {summarizeArgs(name, glyphs.ellipsis, args, argsRaw)}  </Text>
        {badge}
        {durationMs !== undefined && (
          <Text color={theme.muted}> ({formatDuration(durationMs)})</Text>
        )}
      </Box>
      {showBody && (
        <Box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={1}
          {...railBorderProps(glyphs.railVertical, isError ? theme.toolError : theme.border)}
        >
          {/*
            The preview footers move behind the same branch as the preview
            itself: they are computed from `previewLines`, which is one line when
            a patch is present, so leaving them outside would report `+0 lines`
            under a 12-row diff. `DiffView` owns its own footer arithmetic.
          */}
          {showLive ? (
            <>
              {visibleLive.map((row, i) => (
                // The row is already terminal-safe and clipped at
                // `LIVE_ROW_MAX_CHARS` by `sanitizeChunk`, so `wrap="truncate"`
                // is an exact height rather than a hope — which is the coupling
                // `estimateEntryRows`'s live branch relies on.
                //
                // The index IS the key: these rows are positional slots in a
                // ring, not identities, and the whole array is replaced on every
                // chunk anyway.
                //
                // AN EMPTY ROW RENDERS AS A SPACE, and that is not cosmetic:
                // Ink measures a `<Text>` with an empty child as ZERO rows, so a
                // blank separator line — which `npm test`, `cargo` and every
                // build tool print — would make the card shorter than
                // `estimateEntryRows` charged for it. That is an over-estimate,
                // the safe direction, but it would quietly cost §3.3.4's
                // "constant row count" the exactness its arithmetic claims. A
                // space is also what the terminal itself shows for a blank line.
                // eslint-disable-next-line react/no-array-index-key
                <Text key={i} wrap="truncate" color={theme.muted}>
                  {row.length > 0 ? row : ' '}
                </Text>
              ))}
              <Text color={theme.muted}>{liveFooter}</Text>
            </>
          ) : showPatch ? (
            <DiffView
              patch={patch!}
              expanded={expanded}
              liveClampRows={liveClampRows}
              theme={theme}
            />
          ) : (
            <>
              <ToolPreview name={name} lines={visibleLines} theme={theme} isError={isError} />
              {!expanded && hidden > 0 && (
                <Text color={theme.muted}>
                  +{hidden} {hidden === 1 ? 'line' : 'lines'} (Ctrl+O)
                </Text>
              )}
              {expanded && hidden > 0 && (
                <Text color={theme.muted}>
                  +{hidden} {hidden === 1 ? 'line' : 'lines'} {glyphs.midDot} shown in full when
                  this entry finishes
                </Text>
              )}
              {expanded && previewLines.length > COLLAPSED_LINES && (
                <Text color={theme.muted}>(Ctrl+O to collapse)</Text>
              )}
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * Every prop is a scalar except `args` (a stable reference on a settled entry),
 * `patch` and `theme` / `caps` (both `useMemo`d in `App.tsx` — I-L2-1).
 *
 * `patch` QUALIFIES ONLY BECAUSE THE REDUCER WRITES IT ONCE, at `toolExecEnd`,
 * and never rebuilds it — `mapEntry` preserves object identity for untouched
 * entries. A future action that recomputed or normalized a patch would turn this
 * boundary into a no-op WITH NOTHING FAILING, which is the same trap I-L2-1
 * exists to catch for `theme` and `caps` (P2-9).
 */
export const ToolCard = React.memo(ToolCardImpl);
