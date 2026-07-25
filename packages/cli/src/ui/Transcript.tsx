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
 */

import React, { useRef } from 'react';
import { Box, Static, Text } from 'ink';
import { type Theme } from './theme.js';
import type { Entry, NoticeLevel } from '../agent/reducer.js';
import { UserEntry } from './entries/UserEntry.js';
import { AssistantEntry } from './entries/AssistantEntry.js';
import { ToolCard } from './entries/ToolCard.js';

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
  theme: Theme;
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
  expanded: boolean;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  theme: Theme;
}

function EntryView({
  entry,
  expanded,
  thinkingVisible,
  reducedMotion,
  theme,
}: EntryViewProps): React.ReactElement | null {
  switch (entry.kind) {
    case 'user':
      return <UserEntry text={entry.text} theme={theme} />;
    case 'assistant':
      return (
        <AssistantEntry
          text={entry.text}
          thinking={entry.thinking}
          thinkingOpen={entry.thinkingOpen}
          thinkingVisible={thinkingVisible}
          streaming={entry.streaming}
          aborted={entry.aborted}
          theme={theme}
        />
      );
    case 'tool':
      return (
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
        />
      );
    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color={noticeColor(entry.level, theme)}>
            {noticeSymbol(entry.level, theme)} {entry.text}
          </Text>
        </Box>
      );
    default:
      return null;
  }
}

export function Transcript({
  entries,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  theme,
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
      <Static items={settledEntries}>
        {(entry) => (
          <EntryView
            key={entry.id}
            entry={entry}
            expanded={!!expandedToolIds[entry.id]}
            thinkingVisible={thinkingVisible}
            reducedMotion={reducedMotion}
            theme={theme}
          />
        )}
      </Static>
      <Box flexDirection="column">
        {liveEntries.map((entry) => (
          <EntryView
            key={entry.id}
            entry={entry}
            expanded={!!expandedToolIds[entry.id]}
            thinkingVisible={thinkingVisible}
            reducedMotion={reducedMotion}
            theme={theme}
          />
        ))}
      </Box>
    </Box>
  );
}
