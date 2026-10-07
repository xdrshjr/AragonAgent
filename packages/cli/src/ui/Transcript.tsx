/** Virtualized full-screen transcript and entry cards. */
/** Virtualized full-screen transcript and shared entry cards. */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { type Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import Spinner from 'ink-spinner';
import { pickGlyphs, toolGlyph } from './glyphs.js';
import { separationRows, type DensityMode } from './density.js';
import type { Entry, NoticeLevel } from '../agent/reducer.js';
import { EntryFrame } from './entries/EntryFrame.js';
import { UserEntry } from './entries/UserEntry.js';
import { QueuedEntry } from './entries/QueuedEntry.js';
import { AssistantEntry } from './entries/AssistantEntry.js';
import { ToolCard, statusColor, toolEntryGlyph } from './entries/ToolCard.js';
import { TeamCard, teamCardColor } from './entries/TeamCard.js';
import { TodoCard, todoCardColor } from './entries/TodoCard.js';
import { RetryCard, retryCardColor } from './entries/RetryCard.js';
import { FastCard, fastCardColor } from './entries/FastCard.js';
import { CompactionCard, compactionCardColor } from './entries/CompactionCard.js';
import { ServiceCard, serviceCardColor, serviceGlyph } from './entries/ServiceCard.js';
import { MeasuredEntry } from './layout/MeasuredEntry.js';
import { useViewportGeometry } from './layout/viewport-geometry.js';
import {
  estimateEntryRows,
  heightKey,
  selectWindow,
  VIRTUAL_LIMITS,
} from './layout/virtual-window.js';
import { advanceTailRows, type TailSink } from './layout/follow-state.js';
import type { HeightStore } from './use-height-store.js';

interface TranscriptProps {
  entries: Entry[];
  expandedToolIds: Record<string, true>;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  density: DensityMode;

  /**
   * Wall-clock seconds, threaded from `App`'s existing 200 ms ticker, for the
   * live tool card's stall row (agent-activity-presentation-live §3.3.4 / D-36).
   *
   * The entry map decides per entry whether to pass it on, and it
   * may pass it unconditionally: `ToolCard` is `React.memo` with the default
   * comparator, so a prop that changes every second on every card would defeat
   * that boundary for the whole transcript.
   */
  nowSec?: number;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * The value `EntryView` should receive for `nowSec` on THIS entry.
 *
 * `undefined` for everything that is not a running tool, which is what keeps
 * every other card's memo boundary intact — `undefined === undefined` in the
 * comparator, on every frame, forever.
 */
function nowSecFor(entry: Entry, nowSec: number | undefined): number | undefined {
  if (entry.kind === 'tool' && entry.status === 'running') return nowSec;
  // THE LIVE COMPACTION CARD IS THE SECOND CONSUMER (hardening W5). It is at most
  // ONE entry in the whole transcript, and it settles - so the memo boundary this
  // function protects is unchanged for every other card, forever.
  if (entry.kind === 'compaction' && entry.live) return nowSec;
  return undefined;
}

function noticeColor(level: NoticeLevel, theme: Theme): string | undefined {
  if (level === 'error') return theme.noticeError;
  if (level === 'warn') return theme.noticeWarn;
  return theme.noticeInfo;
}

function noticeSymbol(level: NoticeLevel, theme: Theme): string {
  if (level === 'error') return theme.symbols.error;
  if (level === 'warn') return theme.symbols.warn;
  return theme.symbols.info;
}

export interface EntryViewProps {
  entry: Entry;
  /** Previous entry in the list; `undefined` for the first item. */
  prev: Entry | undefined;
  expanded: boolean;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  density: DensityMode;
  theme: Theme;
  caps: TermCapabilities;

  /** Wall-clock seconds; set ONLY on a running tool entry (§3.3.4 / P1-3). */
  nowSec?: number;
}

function EntryViewImpl({
  entry,
  prev,
  expanded,
  thinkingVisible,
  reducedMotion,
  density,
  theme,
  caps,
  nowSec,
}: EntryViewProps): React.ReactElement | null {
  const glyphs = pickGlyphs(caps);
  const separation = separationRows(prev, entry, density);

  const frame = (
    glyph: React.ReactNode,
    color: string | undefined,
    children: React.ReactNode,
  ): React.ReactElement => (
    <EntryFrame
      glyph={glyph}
      color={color}
      continuation={glyphs.railVertical}
      separation={separation}
      spacerColor={theme.border}
    >
      {children}
    </EntryFrame>
  );

  switch (entry.kind) {
    case 'user':
      return frame(glyphs.user, theme.user, <UserEntry text={entry.text} theme={theme} caps={caps} />);
    case 'queued':
      // `theme.muted`: quieter than a user message, louder than a notice --
      // the row exists to be noticed UNTIL it is accepted, then rewritten in
      // place by `turnStart` (5.2.3).
      return frame(
        glyphs.queued,
        theme.muted,
        <QueuedEntry text={entry.text} theme={theme} caps={caps} />,
      );
    case 'assistant': {
      const animate = entry.streaming && !reducedMotion && caps.unicode;
      return frame(
        animate ? <Spinner type="dots" /> : glyphs.assistant,
        theme.primary,
        <AssistantEntry
          text={entry.text}
          thinking={entry.thinking}
          thinkingOpen={entry.thinkingOpen}
          thinkingVisible={thinkingVisible}
          streaming={entry.streaming}
          aborted={entry.aborted}
          // `EntryViewImpl` hands each renderer EXPLICIT SCALAR PROPS, so
          // nothing on the entry reaches a component by itself (P1-6b).
          thinkingMs={entry.thinkingMs}
          theme={theme}
          caps={caps}
        />,
      );
    }
    case 'tool':
      return frame(
        toolEntryGlyph(entry.name, caps),
        statusColor(entry.status, theme),
        <ToolCard
          name={entry.name}
          label={entry.label}
          argsRaw={entry.argsRaw}
          args={entry.args}
          status={entry.status}
          preview={entry.preview}
          patch={entry.patch}
          durationMs={entry.durationMs}
          isError={entry.isError}
          expanded={expanded}
          reducedMotion={reducedMotion}
          // `entry.live` AND NOT `entry.live ?? []` (P2-4): `ToolCard`'s default
          // comparator sees a fresh `[]` as a changed prop, which is why that
          // file already keeps a shared `EMPTY_LINES`.
          live={entry.live}
          lastOutputAt={entry.lastOutputAt}
          nowSec={nowSec}
          theme={theme}
          caps={caps}
        />,
      );
    case 'team':
      return frame(
        glyphs.teamAgent,
        teamCardColor(entry.runs, entry.active, entry.aborted, theme),
        <TeamCard
          requested={entry.requested}
          runs={entry.runs}
          aborted={entry.aborted}
          durationMs={entry.durationMs}
          active={entry.active}
          expanded={expanded}
          reducedMotion={reducedMotion}
          theme={theme}
          caps={caps}
        />,
      );
    case 'todo':
      return frame(
        toolGlyph(glyphs, 'todo_write'),
        todoCardColor(entry.doneCount, entry.total, entry.live, theme),
        <TodoCard
          items={entry.items}
          doneCount={entry.doneCount}
          total={entry.total}
          live={entry.live}
          interrupted={entry.interrupted}
          theme={theme}
          caps={caps}
        />,
      );
    case 'retry':
      return frame(
        entry.phase === 'exhausted' ? glyphs.error : glyphs.retry,
        retryCardColor(entry.phase, theme),
        <RetryCard
          attempt={entry.attempt}
          maxRetries={entry.maxRetries}
          errorType={entry.errorType}
          phase={entry.phase}
          resumeAt={entry.resumeAt}
          totalRetries={entry.totalRetries}
          elapsedMs={entry.elapsedMs}
          // READ HERE, not threaded from `App`, and that is what keeps the memo
          // boundary intact: a `now` prop on every `EntryView` would change on
          // every frame and re-render the whole transcript. The `retryTick` action
          // refreshes THIS entry's identity once a second, which re-renders this
          // one card and gives it a fresh clock; nothing else moves.
          now={Date.now()}
          // NOT THREADED FROM `App`: reaching this renderer means a TUI is
          // mounted, and the TUI always binds Esc to abort. Headless mode writes
          // its retry lines to stderr and never mounts an entry component, and the
          // exit replay goes through `transcript-text.ts`. `RetryCard` keeps the
          // prop so the render tests can assert the suppressed form.
          reducedMotion={reducedMotion}
          theme={theme}
          caps={caps}
        />,
      );
    case 'fast':
      return frame(
        entry.status === 'failed' ? glyphs.toolError : glyphs.teamAgent,
        fastCardColor(entry.status, theme),
        <FastCard
          reviewIndex={entry.reviewIndex}
          model={entry.model}
          status={entry.status}
          text={entry.text}
          detail={entry.detail}
          turn={entry.turn}
          durationMs={entry.durationMs}
          live={entry.live}
          reducedMotion={reducedMotion}
          theme={theme}
          caps={caps}
        />,
      );
    case 'compaction':
      return frame(
        entry.applied || entry.live ? glyphs.compaction : glyphs.toolError,
        compactionCardColor(entry, theme),
        <CompactionCard
          index={entry.index}
          trigger={entry.trigger}
          mode={entry.mode}
          applied={entry.applied}
          reason={entry.reason}
          messagesBefore={entry.messagesBefore}
          messagesAfter={entry.messagesAfter}
          tokensBefore={entry.tokensBefore}
          tokensAfter={entry.tokensAfter}
          summary={entry.summary}
          model={entry.model}
          durationMs={entry.durationMs}
          tailRelief={entry.tailRelief}
          // ONLY WHILE LIVE, and only when the clock has ticked at least once:
          // `nowSec` is `undefined` until then, and a settled card must keep
          // rendering `durationMs` rather than a figure that would drift.
          elapsedMs={
            entry.live && nowSec !== undefined && entry.startedAt !== undefined
              ? Math.max(0, nowSec * 1000 - entry.startedAt)
              : undefined
          }
          live={entry.live}
          expanded={expanded}
          reducedMotion={reducedMotion}
          theme={theme}
          caps={caps}
        />,
      );
    case 'service':
      return frame(
        serviceGlyph(entry, glyphs),
        serviceCardColor(entry, theme),
        <ServiceCard
          serviceId={entry.serviceId}
          command={entry.command}
          status={entry.status}
          url={entry.url}
          port={entry.port}
          exitCode={entry.exitCode}
          startedAt={entry.startedAt}
          readyAt={entry.readyAt}
          endedAt={entry.endedAt}
          rows={entry.rows}
          terminal={entry.terminal}
          killIncomplete={entry.killIncomplete}
          expanded={expanded}
          reducedMotion={reducedMotion}
          theme={theme}
          caps={caps}
        />,
      );
    case 'notice':
      return frame(
        noticeSymbol(entry.level, theme),
        noticeColor(entry.level, theme),
        <Text color={noticeColor(entry.level, theme)}>{entry.text}</Text>,
      );
    default:
      return null;
  }
}

/**
 * THE memo boundary that makes a long transcript cheap (L2 / R3).
 *
 * The comparator is written out rather than defaulted because `prev` is the one
 * prop whose identity matters for a reason the type does not show: it feeds
 * `separationRows`, so an entry whose PREDECESSOR changed kind must re-render
 * even though the entry itself did not.
 *
 * I-L2-1 — `theme` and `caps` are `useMemo`d in `App.tsx` and are therefore
 * referentially stable across frames. If a future change makes either a fresh
 * object per render, EVERY boundary below becomes a no-op AND NOTHING FAILS;
 * `render-memo.test.tsx` asserts that stability directly so the trap is a red
 * test rather than a silent regression.
 */
export const EntryView = React.memo(EntryViewImpl, (a, b) => {
  return (
    a.entry === b.entry &&
    a.prev === b.prev &&
    a.expanded === b.expanded &&
    a.thinkingVisible === b.thinkingVisible &&
    a.reducedMotion === b.reducedMotion &&
    a.density === b.density &&
    a.theme === b.theme &&
    a.caps === b.caps &&
    /*
     * ELEVENTH TERM, AND OMITTING IT IS THE TRAP I-L2-1 DESCRIBES ONE COMMENT UP
     * (P1-3). This comparator is a CLOSED LIST: a prop absent from it changes
     * without invalidating the boundary, so `ToolCard` is never re-rendered and
     * the stall row freezes at whatever second it first drew — AC-26's "and the
     * seconds advance" failing with nothing reporting it.
     *
     * It is free: `nowSecFor` returns `undefined` for every entry that is not a
     * running tool, and `undefined === undefined` on every frame.
     */
    a.nowSec === b.nowSec
  );
});

export function TranscriptList({
  entries,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  density,
  nowSec,
  theme,
  caps,
  windowSize,
  cols,
  heights,
  mountedSink,
  tailSink,
}: TranscriptProps & {
  windowSize: number;
  /** The viewport's own width — narrower than the terminal when the rail is up. */
  cols: number;
  heights: HeightStore;
  /**
   * Written during render with the number of entries actually mounted, for
   * `/perf` (AC-9). A ref rather than a callback: a `setState` here would make
   * observing the render budget cost a render.
   */
  mountedSink?: { current: number };
  /**
   * Rows appended AT THE TAIL, published for `ScrollViewport`'s Rule A
   * (tui-selection-and-scroll-follow §4.3.1a). THIS IS P0-1's FIX.
   *
   * It lives here because this is the only place that holds the per-entry height
   * table, and therefore the only place that can tell "the agent produced output"
   * apart from "an entry above changed height" or "the horizon dropped an entry
   * off the front". Reacting to `measureElement(inner).height` instead conflates
   * all three, breaks `virtual-window.ts`'s invariant V-4, and closes an
   * offset → mounted-set → measured-height → offset loop.
   *
   * A REF WRITTEN DURING RENDER, exactly as `mountedSink` above is and for the
   * same reason: a `setState` here would make observing the tail cost a render.
   * If this sink ever needs more than that — a `setState`, or the geometry
   * context — STOP AND RE-REVIEW: the loop above is open again, and the correct
   * response is full entry anchoring (D-13's rejected alternative), not a larger
   * sink.
   */
  tailSink?: TailSink;
}): React.ReactElement {
  const size = Math.max(1, Math.floor(windowSize));
  const visible = entries.length > size ? entries.slice(-size) : entries;
  const collapsed = entries.length - visible.length;
  const glyphs = pickGlyphs(caps);
  const geometry = useViewportGeometry();

  // Ctrl+T changes every assistant entry's height without changing any entry,
  // so it has to reach the cache key or the spacers freeze at the wrong size.
  const flags = thinkingVisible ? 't' : '';
  // ONE key builder, shared by the lookup below and by `MeasuredEntry`'s report.
  // Two spellings of the same key is a SILENT failure and not a compile error:
  // the measurement lands under a key `resolve` never asks for, every entry
  // falls back to its estimate for the rest of the session, and the spacers
  // quietly encode heights nothing will ever correct.
  const keyOf = (entry: Entry): string =>
    heightKey(entry, cols, !!expandedToolIds[entry.id], density, flags);

  const { resolve, report } = heights;
  const heightOf = useCallback(
    (index: number): number => {
      const entry = visible[index]!;
      // `thinkingVisible` IS PASSED, not left to the parameter's conservative
      // default (P1-6a / condition 5). With thinking hidden the default would
      // inflate every assistant entry that thought by its whole wrapped length,
      // and an entry estimated at 400 rows against a real height of 1 is exactly
      // the one `selectWindow` then never mounts and never re-measures.
      return resolve(keyOf(entry), () =>
        estimateEntryRows(entry, cols, density, !!expandedToolIds[entry.id], thinkingVisible),
      );
    },
    // Memoised only incidentally: `visible` IS `entries` while the session is
    // shorter than the horizon and a fresh slice once it is past it, so this
    // rebuilds on some frames and not others. Either is correct — `selectWindow`
    // consumes it synchronously below and it is never handed to a child — and
    // `keyOf` is omitted from the list because every input it closes over is
    // already in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, expandedToolIds, cols, density, flags, resolve, thinkingVisible],
  );

  const selection = selectWindow({
    entries: visible,
    heightOf,
    viewportRows: geometry.viewportRows,
    trailingContentRows: geometry.trailingContentRows,
    offset: geometry.offset,
    overscan: VIRTUAL_LIMITS.overscan,
  });

  const slice = visible.slice(selection.startIndex, selection.endIndex);
  if (mountedSink) mountedSink.current = slice.length;
  // One more pass over the array `selectWindow` has already walked, reading the
  // SAME height table and never the geometry context (§4.3.1a). `visible` is
  // what is drawn, so its last entry is the tail; entries the horizon dropped are
  // not "removed rows" and must not register as one.
  if (tailSink) {
    tailSink.current = advanceTailRows(
      tailSink.current,
      visible.map((entry) => entry.id),
      heightOf,
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {collapsed > 0 && (
        <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
          {glyphs.ellipsis} {collapsed} earlier {collapsed === 1 ? 'entry' : 'entries'} collapsed
          (/save exports the full session)
        </Text>
      )}
      {/*
        V-1 — a spacer is EXACTLY one `ink-box` with a height and no children. A
        child re-introduces the per-frame cost the spacer exists to remove, and
        it does so invisibly: the frame still looks right.
      */}
      {selection.leadingRows > 0 && (
        <Box flexShrink={0} height={selection.leadingRows} />
      )}
      {slice.map((entry, i) => {
        const index = selection.startIndex + i;
        return (
          <MeasuredEntry key={entry.id} heightKey={keyOf(entry)} onMeasure={report}>
            <EntryView
              entry={entry}
              prev={index > 0 ? visible[index - 1] : undefined}
              expanded={!!expandedToolIds[entry.id]}
              thinkingVisible={thinkingVisible}
              reducedMotion={reducedMotion}
              density={density}
              nowSec={nowSecFor(entry, nowSec)}
              theme={theme}
              caps={caps}
            />
          </MeasuredEntry>
        );
      })}
      {selection.trailingRows > 0 && (
        <Box flexShrink={0} height={selection.trailingRows} />
      )}
    </Box>
  );
}
