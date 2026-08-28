/**
 * TodoCard — the transcript checklist entry (todo-plan-execution §6.2).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`.
 *
 * ONE CARD PER USER TURN, REWRITTEN IN PLACE. The rail is EPHEMERAL and this is
 * the HISTORY, exactly as `TeamPanel` and `TeamCard` divide the same work. It
 * renders through the shared `EntryFrame` supplied by `EntryView`, so a plan
 * reads as one more step in the transcript rather than a second kind of object.
 *
 * THE FULL LIST, NO WINDOWING (the transcript scrolls; the rail does not), and
 * NEVER ANIMATED even while `live` — a resumed session would otherwise spin
 * forever on a card whose run ended days ago.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs, type Glyphs } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import type { TodoItem } from '../../todo/types.js';

export interface TodoCardProps {
  items: TodoItem[];
  doneCount: number;
  total: number;
  live: boolean;
  /** Saved mid-run and resumed: the run behind this card died with the process. */
  interrupted?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/** The card's aggregate colour: complete is done, anything else is in flight. */
export function todoCardColor(
  doneCount: number,
  total: number,
  live: boolean,
  theme: Theme,
): string | undefined {
  if (live) return theme.toolRunning;
  if (total > 0 && doneCount === total) return theme.toolDone;
  return theme.muted;
}

function marker(item: TodoItem, glyphs: Glyphs): string {
  if (item.status === 'completed') return glyphs.todoDone;
  if (item.status === 'in_progress') return glyphs.todoActive;
  return glyphs.todoPending;
}

function rowColor(item: TodoItem, theme: Theme): string | undefined {
  if (item.status === 'completed') return theme.muted;
  if (item.status === 'in_progress') return theme.primary;
  return theme.hintFg ?? theme.muted;
}

function TodoCardImpl(props: TodoCardProps): React.ReactElement {
  const { items, doneCount, total, live, interrupted, theme, caps } = props;
  const glyphs = pickGlyphs(caps);

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={theme.accent} bold>
          Todos
        </Text>
        <Text color={todoCardColor(doneCount, total, live, theme)}>
          {'  '}
          {doneCount}/{total}
        </Text>
        {interrupted && (
          // A resumed `2/7` would otherwise read as a run still in flight
          // (P2-6). Saying so plainly is the same fix `TeamCard` makes for a
          // dispatch that never got a duration.
          <Text color={theme.muted}>{'  '}interrupted (session resumed)</Text>
        )}
      </Box>

      <Box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        {...railBorderProps(glyphs.railVertical, theme.border)}
      >
        {items.map((item, index) => (
          <Text key={`${index}-${item.content}`} wrap="truncate" color={rowColor(item, theme)}>
            {marker(item, glyphs).padEnd(3)}
            {item.status === 'in_progress' ? item.activeForm : item.content}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` already preserves object identity for untouched entries, so the
 * array props below are stable references on a settled card, and `theme` /
 * `caps` are `useMemo`d in `App.tsx` (I-L2-1).
 */
export const TodoCard = React.memo(TodoCardImpl);
