/**
 * Transcript (spec §3.8). Splits the entry list into a settled prefix rendered
 * once into Ink's `<Static>` (native terminal scrollback, never re-rendered)
 * and a live tail rendered normally. This kills per-token full re-renders and
 * flicker on long/fast sessions.
 *
 * `computeSettledCount` is pure and exported for `transcript-static.test.ts`.
 * The settled boundary is held MONOTONIC at render time: a previously-settled
 * entry never leaves `<Static>` (which cannot un-print it) even if it later
 * becomes expanded, so the live tail can never duplicate a scrolled-off entry.
 *
 * `EntryView` is shared by both render paths ON PURPOSE (§4.3 / §12). Forking it
 * to freeze inline's v0.2.0 output would mean writing every future entry-layer
 * change twice and watching the two drift; inline is a degradation path, not a
 * parallel product. What inline still guarantees is its GEOMETRY contract — no
 * fixed frame, `<Static>` keeps the settled history, no private ANSI — not its
 * pixel-for-pixel appearance.
 *
 * Two things changed with tui-render-performance:
 *   - `EntryView` is `React.memo`'d with an explicit comparator (L2 / R3), which
 *     is only worth anything because `mapEntry` already preserves object
 *     identity for untouched entries;
 *   - `TranscriptList` (the FULL-SCREEN body) mounts only the entries inside the
 *     viewport and replaces the rest with two spacer boxes (L3 / R1), and the
 *     inline `Transcript` clamps its live region so `ink.js:121` is unreachable
 *     (L5 / R6).
 */

import React, { useCallback, useRef } from 'react';
import { Box, Static, Text } from 'ink';
import { type Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import Spinner from 'ink-spinner';
import { pickGlyphs, toolGlyph } from './glyphs.js';
import { separationRows, type DensityMode } from './density.js';
import type { Entry, NoticeLevel } from '../agent/reducer.js';
import type { RenderMode } from './layout/frame.js';
import { EntryFrame } from './entries/EntryFrame.js';
import { UserEntry } from './entries/UserEntry.js';
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
import { useTerminalSize } from './layout/useTerminalSize.js';

/** Keep the last K entries in the live region so a mutating tail stays hot. */
const LIVE_TAIL = 1;

/**
 * Rows the inline live region leaves for the composer, the prompt echo and the
 * one-row margin Ink needs before `outputHeight >= stdout.rows` (I-L5-1).
 */
const INLINE_LIVE_MARGIN = 4;
/** Floor on the clamp, so a very short terminal still shows something useful. */
const INLINE_LIVE_MIN_ROWS = 4;

/**
 * Largest prefix length P such that `entries[0..P)` are all terminal, none is
 * within the last `LIVE_TAIL` entries, and none is currently expanded. Pure and
 * non-decreasing as entries terminalize (expanding a card can lower it — the
 * component clamps with a monotonic high-water mark to avoid Static duplication).
 */
export function computeSettledCount(
  entries: Entry[],
  expandedToolIds: Record<string, true>,
): number {
  const limit = entries.length - LIVE_TAIL;
  let count = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (i >= limit) break;
    const e = entries[i]!;
    if (expandedToolIds[e.id]) break;
    if (e.kind === 'assistant' && e.streaming) break;
    if (e.kind === 'tool' && e.status !== 'done' && e.status !== 'error') break;
    // A live dispatch is not settled: its `runs` are rewritten on every
    // `teamUpdate`, and `<Static>` cannot un-print what it has already drawn.
    // The boundary is held MONOTONIC above, which is also why a `team` entry
    // that never settles would be re-rendered on every frame for the rest of the
    // session — the failure `session/persist.ts` normalizes away on load (P1-5).
    if (e.kind === 'team' && e.active) break;
    // A live todo card is not settled either: it is rewritten on every
    // `todoUpdate` for the whole turn, and `<Static>` cannot un-print what it has
    // already drawn (C-5 / I-6). `session/persist.ts` forces `live: false` on
    // load, which is the other half — a card that never settles is re-rendered
    // on every frame for the rest of the session.
    if (e.kind === 'todo' && e.live) break;
    // Nor is a retry card that is still counting down or still in flight: it is
    // rewritten on every `retryScheduled` / `retryAttempt` and once a second by
    // `retryTick`, and `<Static>` cannot un-print what it has already drawn.
    // `session/persist.ts` forces a loaded card to `interrupted`, which is the
    // other half — a card that never settles is re-rendered on every frame for
    // the rest of the session (R-10).
    if (e.kind === 'retry' && (e.phase === 'waiting' || e.phase === 'retrying')) break;
    // A live review card is not settled either: it is rewritten once, when the
    // call comes back, and `<Static>` cannot un-print what it has already drawn
    // (C-5). `session/persist.ts` forces `live: false` on load, which is the
    // other half.
    if (e.kind === 'fast' && e.live) break;
    // Nor is a compaction card whose call is still open: it is rewritten once,
    // when the engine reports its verdict, and `<Static>` cannot un-print what it
    // has already drawn (C-8). `session/persist.ts` forces `live: false` on load,
    // which is the other half.
    if (e.kind === 'compaction' && e.live) break;
    /**
     * A SERVICE BLOCKS ONLY WHILE IT IS `starting` (D-11 / P0-4).
     *
     * Every clause above is bounded by an OPERATION — a dispatch, a turn, one
     * LLM call, one countdown — which is why each of them can safely pin this
     * prefix scan: the wait is short and it ends. A service is bounded by the
     * USER'S INTENT. A dev server left up for an hour is the normal case, not
     * the pathological one, so treating it like the other five would pin the
     * boundary at the card and re-render the whole transcript from there on
     * EVERY FRAME, FOREVER, on exactly the long sessions where it is least
     * likely to be noticed.
     *
     * `starting` is different, and it is different for the reason that makes
     * every other clause here legitimate: it is bounded by `readyTimeoutMs`,
     * after which the supervisor calls the service `running` whatever happened.
     *
     * The cost of the rest is that a printed card stops mirroring live state —
     * which is what a transcript IS. A terminal transition appends a NEW one-row
     * entry rather than rewriting a card `<Static>` has already drawn, and live
     * state lives in the status chip, `/bg` and `bash_output`. Weakening this to
     * "any non-terminal service blocks" is the change D-11 exists to prevent;
     * see condition 5 of the design's review verdict before making it.
     */
    if (e.kind === 'service' && e.status === 'starting') break;
    count = i + 1;
  }
  return count;
}

interface TranscriptProps {
  entries: Entry[];
  expandedToolIds: Record<string, true>;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  density: DensityMode;
  /**
   * The render mode, threaded from `App` as a plain scalar prop.
   *
   * It decides whether the collapsed thinking marker may offer `ctrl+t` (D-16):
   * inline prints settled entries into `<Static>`, which cannot re-print them.
   * NOT read from a module-level singleton — `render-memo.test.tsx` asserts prop
   * stability across frames, and a hidden read would be invisible to it.
   */
  mode: RenderMode;
  /**
   * Wall-clock seconds, threaded from `App`'s existing 200 ms ticker, for the
   * live tool card's stall row (agent-activity-presentation-live §3.3.4 / D-36).
   *
   * BOTH MAP CALLBACKS BELOW DECIDE PER ENTRY WHETHER TO PASS IT ON, and neither
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
  mode: RenderMode;
  theme: Theme;
  caps: TermCapabilities;
  /** Inline mode only (L5); `undefined` in full-screen, which means no clamp. */
  liveClampRows?: number;
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
  mode,
  theme,
  caps,
  liveClampRows,
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
    case 'assistant': {
      // While text streams, the spinner IS the role marker. Braille dots are
      // both an animation and a Unicode-only glyph, so reduced motion and an
      // ASCII terminal fall back to the same static marker (P2-11 / A-10).
      //
      // `reducedMotion` ARRIVES PRE-WIDENED FROM `App`: it is now
      // `cfg.reducedMotion || activityVisible`, so this marker is static for the
      // whole of every run and the activity row above the composer carries the
      // one animation (single-spinner-while-running D-2). Nothing here changes —
      // the expression already meant "do not animate here".
      //
      // THAT IS SAFE FOR `<Static>` BY CONSTRUCTION, not by luck: a settled
      // prefix is printed once and can never be re-printed, so a boolean that
      // changed how an already-printed entry renders would tear the history.
      // `computeSettledCount` below breaks on EVERY condition that makes an
      // entry animate (`:84` streaming, `:85` running tool, `:91` active team,
      // `:104` retry, `:109` live fast), so every animating entry is in the live
      // region and every entry in `<Static>` already has `animate === false` on
      // both sides of the flip. Weakening a break clause breaks that proof.
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
          revealable={mode === 'fullscreen'}
          liveClampRows={liveClampRows}
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
          liveClampRows={liveClampRows}
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
    a.mode === b.mode &&
    a.theme === b.theme &&
    a.caps === b.caps &&
    a.liveClampRows === b.liveClampRows &&
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

/**
 * Full-screen transcript body — the same entry renderers with NO `<Static>`.
 *
 * `<Static>` prints above the live frame; once the frame is `rows - 1` tall
 * there is exactly one visible line up there, so the mechanism stops being a
 * history view and starts being a leak. Full-screen therefore owns its history
 * inside `ScrollViewport` instead.
 *
 * `computeSettledCount` is deliberately NOT called here: its only job is to keep
 * an entry that already reached `<Static>` from flowing back into the live
 * region, and with no Static there is nothing to protect. The settled high-water
 * mark feeds nothing else — `/save` serializes `entries` in full — so leaving it
 * un-advanced has no side effect.
 *
 * VIRTUALISED (L3 / R1). `windowSize` is now the SCROLL HORIZON — how far back
 * the user can scroll — and no longer the rendering budget, because entries
 * outside the viewport are not mounted at all. What bounds the frame is
 * `selectWindow`, and the two spacers are what keep the scroll maths honest
 * while they are absent.
 */
export function TranscriptList({
  entries,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  density,
  mode,
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
              mode={mode}
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

export function Transcript({
  entries,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  density,
  mode,
  nowSec,
  theme,
  caps,
}: TranscriptProps): React.ReactElement {
  const highWater = useRef(0);
  const prevLen = useRef(0);
  const { rows } = useTerminalSize();

  const raw = computeSettledCount(entries, expandedToolIds);
  // The transcript shrank (clear / reset / restore) — drop the high-water mark.
  if (entries.length < prevLen.current) highWater.current = 0;
  prevLen.current = entries.length;
  const settled = Math.min(entries.length, Math.max(highWater.current, raw));
  highWater.current = settled;

  const settledEntries = entries.slice(0, settled);
  const liveEntries = entries.slice(settled);

  // I-L5-1 — the live region must stay strictly below `stdout.rows`, or Ink
  // takes the `ink.js:118-123` branch and writes `clearTerminal +
  // fullStaticOutput + output` on EVERY subsequent frame for the rest of the
  // session.
  //
  // `LIVE_TAIL` is 1, so the common case is the design's `rows - 4` less the one
  // row the clamp marker costs. THE DIVISION IS NOT DECORATION: the settled
  // boundary is held back by an expanded card, a running tool, a live dispatch
  // or a live todo list, and in every one of those cases the region holds
  // SEVERAL entries at once — a flat per-entry ceiling of `rows - 4` would then
  // overrun by a multiple of itself. `- 1` pays for each entry's marker row.
  //
  // The residual: an entry contributes at least its header row whatever the
  // clamp says, so the bound holds while the live region holds fewer than about
  // `rows / 2` entries. Bounding it unconditionally would mean refusing to draw
  // a live entry at all, which is worse than a tall frame.
  const liveBudget = Math.max(INLINE_LIVE_MIN_ROWS, rows - INLINE_LIVE_MARGIN);
  const liveClampRows = Math.max(
    1,
    Math.floor(liveBudget / Math.max(1, liveEntries.length)) - 1,
  );

  return (
    <Box flexDirection="column">
      {/*
        `separationRows` needs the preceding entry. `<Static>`'s child callback
        already supplies `(item, index)`, so it comes straight off `items` — no
        extra state, and the value is identical to the live branch's.

        NO `liveClampRows` HERE, and that is the whole of L5's "nothing is lost":
        an entry reaching `<Static>` is printed IN FULL, once, into the
        terminal's own scrollback. The clamp only defers.
      */}
      <Static items={settledEntries}>
        {(entry, index) => (
          <EntryView
            key={entry.id}
            entry={entry}
            prev={index > 0 ? settledEntries[index - 1] : undefined}
            expanded={!!expandedToolIds[entry.id]}
            thinkingVisible={thinkingVisible}
            reducedMotion={reducedMotion}
            density={density}
            mode={mode}
            theme={theme}
            caps={caps}
          />
        )}
      </Static>
      <Box flexDirection="column">
        {liveEntries.map((entry, i) => (
          <EntryView
            key={entry.id}
            entry={entry}
            prev={i > 0 ? liveEntries[i - 1] : entries[settled - 1]}
            expanded={!!expandedToolIds[entry.id]}
            thinkingVisible={thinkingVisible}
            reducedMotion={reducedMotion}
            density={density}
            mode={mode}
            theme={theme}
            caps={caps}
            liveClampRows={liveClampRows}
            nowSec={nowSecFor(entry, nowSec)}
          />
        ))}
      </Box>
    </Box>
  );
}
