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
 */

import React, { useRef } from 'react';
import { Box, Static, Text } from 'ink';
import { type Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import Spinner from 'ink-spinner';
import { pickGlyphs } from './glyphs.js';
import { separationRows, type DensityMode } from './density.js';
import type { Entry, NoticeLevel } from '../agent/reducer.js';
import { EntryFrame } from './entries/EntryFrame.js';
import { UserEntry } from './entries/UserEntry.js';
import { AssistantEntry } from './entries/AssistantEntry.js';
import { ToolCard, statusColor, toolEntryGlyph } from './entries/ToolCard.js';

/** Keep the last K entries in the live region so a mutating tail stays hot. */
const LIVE_TAIL = 1;

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
  theme: Theme;
  caps: TermCapabilities;
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

interface EntryViewProps {
  entry: Entry;
  /** Previous entry in the list; `undefined` for the first item. */
  prev: Entry | undefined;
  expanded: boolean;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  density: DensityMode;
  theme: Theme;
  caps: TermCapabilities;
}

function EntryView({
  entry,
  prev,
  expanded,
  thinkingVisible,
  reducedMotion,
  density,
  theme,
  caps,
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
      return frame(glyphs.user, theme.user, <UserEntry text={entry.text} theme={theme} />);
    case 'assistant': {
      // While text streams, the spinner IS the role marker. Braille dots are
      // both an animation and a Unicode-only glyph, so reduced motion and an
      // ASCII terminal fall back to the same static marker (P2-11 / A-10).
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
          durationMs={entry.durationMs}
          isError={entry.isError}
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
 * Rendering budget (I-3): yoga lays out every child even when `overflow: hidden`
 * clips it, so cost grows linearly with the entry count. Only the last
 * `windowSize` entries are rendered; the reducer and `/save` keep everything.
 */
export function TranscriptList({
  entries,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  density,
  theme,
  caps,
  windowSize,
}: TranscriptProps & { windowSize: number }): React.ReactElement {
  const size = Math.max(1, Math.floor(windowSize));
  const visible = entries.length > size ? entries.slice(-size) : entries;
  const collapsed = entries.length - visible.length;
  const glyphs = pickGlyphs(caps);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {collapsed > 0 && (
        <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
          {glyphs.ellipsis} {collapsed} earlier {collapsed === 1 ? 'entry' : 'entries'} collapsed
          (/save exports the full session)
        </Text>
      )}
      {visible.map((entry, i) => (
        <EntryView
          key={entry.id}
          entry={entry}
          prev={i > 0 ? visible[i - 1] : undefined}
          expanded={!!expandedToolIds[entry.id]}
          thinkingVisible={thinkingVisible}
          reducedMotion={reducedMotion}
          density={density}
          theme={theme}
          caps={caps}
        />
      ))}
    </Box>
  );
}

export function Transcript({
  entries,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  density,
  theme,
  caps,
}: TranscriptProps): React.ReactElement {
  const highWater = useRef(0);
  const prevLen = useRef(0);

  const raw = computeSettledCount(entries, expandedToolIds);
  // The transcript shrank (clear / reset / restore) — drop the high-water mark.
  if (entries.length < prevLen.current) highWater.current = 0;
  prevLen.current = entries.length;
  const settled = Math.min(entries.length, Math.max(highWater.current, raw));
  highWater.current = settled;

  const settledEntries = entries.slice(0, settled);
  const liveEntries = entries.slice(settled);

  return (
    <Box flexDirection="column">
      {/*
        `separationRows` needs the preceding entry. `<Static>`'s child callback
        already supplies `(item, index)`, so it comes straight off `items` — no
        extra state, and the value is identical to the live branch's.
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
            theme={theme}
            caps={caps}
          />
        ))}
      </Box>
    </Box>
  );
}
