/**
 * TodoCard — the transcript checklist entry (todo-plan-execution §6.2;
 * todo-acceptance-criteria §6.10).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`.
 *
 * ONE CARD PER USER TURN, REWRITTEN IN PLACE. The rail is EPHEMERAL and this is the
 * HISTORY, exactly as `TeamPanel` and `TeamCard` divide the same work. It renders
 * through the shared `EntryFrame` supplied by `EntryView`, so a plan reads as one
 * more step in the transcript rather than a second kind of object.
 *
 * THE FULL LIST, NO WINDOWING (the transcript scrolls; the rail does not), and
 * NEVER ANIMATED even while `live` — a resumed session would otherwise spin forever
 * on a card whose run ended days ago.
 *
 * THE ACCEPTANCE BLOCK ADDS ROWS, NOT A CARD (§6.10): same frame, same marker
 * column, one block underneath. Only a FAILED criterion gets an evidence line
 * (D-14), which is what keeps the height exactly `1 + items.length + failedCount`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs, type Glyphs } from '../glyphs.js';
import { railBorderProps } from '../layout/Gutter.js';
import { derivePlanPhase } from '../../model/todo/acceptance.js';
import type { AcceptanceItem, AcceptanceSnapshot, TodoItem } from '../../model/todo/types.js';

export interface TodoCardProps {
  items: TodoItem[];
  doneCount: number;
  total: number;
  /**
   * The acceptance projection (todo-acceptance-criteria §6.10).
   *
   * OPTIONAL, unlike `TodoSnapshot.acceptance` (P1-4): a `TodoSnapshot` has exactly
   * one writer and can fail closed, while this entry's sources include transcript
   * entries read back from a session file written before the feature existed. A
   * required field there would be typed "present" and be `undefined` at runtime.
   */
  acceptance?: AcceptanceSnapshot | null;
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

/** `passed` reuses the done glyph; `failed` is the one new meaning (D-9). */
function acceptanceMarker(item: AcceptanceItem, glyphs: Glyphs): string {
  if (item.status === 'passed') return glyphs.todoDone;
  if (item.status === 'failed') return glyphs.todoFail;
  if (item.status === 'in_progress') return glyphs.todoActive;
  return glyphs.todoPending;
}

function acceptanceRowColor(item: AcceptanceItem, theme: Theme): string | undefined {
  if (item.status === 'failed') return theme.toolError;
  if (item.status === 'passed') return theme.muted;
  if (item.status === 'in_progress') return theme.primary;
  return theme.hintFg ?? theme.muted;
}

/**
 * All passed reads as done, any failure as an error, otherwise muted; while the run
 * is live and the plan is in VERIFY it reads as running - the same expression family
 * `todoCardColor` uses one level up.
 */
function acceptanceTitleColor(
  acceptance: AcceptanceSnapshot,
  items: TodoItem[],
  live: boolean,
  theme: Theme,
): string | undefined {
  if (acceptance.failedCount > 0) return theme.toolError;
  if (live && derivePlanPhase(items, acceptance.items) === 'verify') return theme.toolRunning;
  if (acceptance.total > 0 && acceptance.checkedCount === acceptance.total) return theme.toolDone;
  return theme.muted;
}

function TodoCardImpl(props: TodoCardProps): React.ReactElement {
  const { items, doneCount, total, acceptance, live, interrupted, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const criteria = acceptance && acceptance.total > 0 ? acceptance : null;

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
          // A resumed `2/7` would otherwise read as a run still in flight (P2-6).
          // Saying so plainly is the same fix `TeamCard` makes for a dispatch that
          // never got a duration.
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

      {criteria && (
        <Box flexDirection="column">
          {/*
            ONE `Text` FOR THE WHOLE HEADER, and `wrap="truncate"` on it (P2-8): the
            card's height is an equality - `1 + items.length + failedCount` - and a
            header that folded into two rows in a narrow transcript would move every row
            beneath it without any error. Nested `Text` keeps the two colours.
          */}
          <Text wrap="truncate">
            <Text color={theme.accent} bold>Acceptance</Text>
            <Text color={acceptanceTitleColor(criteria, items, live, theme)}>
              {'  '}
              {criteria.checkedCount}/{criteria.total} checked
              {criteria.failedCount > 0 ? `  !${criteria.failedCount} failed` : ''}
            </Text>
          </Text>
          <Box
            flexDirection="column"
            flexShrink={0}
            paddingLeft={1}
            {...railBorderProps(glyphs.railVertical, theme.border)}
          >
            {criteria.items.map((item, index) => (
              <React.Fragment key={`acc-${index}-${item.content}`}>
                {/*
                  `wrap="truncate"` ON EVERY LINE, including the evidence line below
                  (P2-8). Without it a 100-character criterion folds into two or three
                  rows in a narrow transcript, and the exact-height budget
                  (`1 + items.length + failedCount`) silently becomes an upper bound -
                  the symptom is scroll drift, and nothing reports it.
                */}
                <Text wrap="truncate" color={acceptanceRowColor(item, theme)}>
                  {acceptanceMarker(item, glyphs).padEnd(3)}
                  {item.content}
                </Text>
                {item.status === 'failed' && item.evidence.length > 0 && (
                  <Text wrap="truncate" color={theme.muted}>
                    {'      '}
                    {item.evidence}
                  </Text>
                )}
              </React.Fragment>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` already preserves object identity for untouched entries, so the array
 * props below are stable references on a settled card, and `theme` / `caps` are
 * `useMemo`d in `App.tsx` (I-L2-1). `acceptance` is a NEW object whenever a verdict
 * lands and the SAME reference otherwise, which is exactly what the comparator wants.
 */
export const TodoCard = React.memo(TodoCardImpl);
