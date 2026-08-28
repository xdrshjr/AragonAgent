/**
 * TodoPanel — the right rail (todo-plan-execution §6.1).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`; a literal here bypasses the
 * capability probe and shows mojibake on a legacy console (`glyphs.ts` header).
 *
 * MOUNTED ONLY WHEN A LIST EXISTS. `App` passes `null` the rest of the time and
 * this component is not rendered at all, so a session that never plans has zero
 * columns and zero layout shift (R-g's "no furniture when idle" / AC-24).
 *
 * IT MUST BE MOUNTED IN `AppShell`'s MIDDLE BAND, NEVER IN THE BOTTOM CHROME
 * (C-6 / I-4). This is a COLUMN BESIDE the viewport, and the middle band is the
 * only row-wrapped region there is; moved down into the bottom chrome it would
 * stop being a rail and start eating viewport height, growing and shrinking the
 * transcript every time the list changed length.
 *
 * WIDTH IS MEASURED IN COLUMNS, NEVER IN CODE UNITS (P2-3). This rail is 18-36
 * columns wide and the system prompt's last line is "Respond in the language the
 * user writes in", so CJK item text in an 18-column rail is the NORMAL case
 * rather than the edge case. Every text cell is `wrap="truncate"` and Ink's
 * truncation is display-width aware, so nothing can overflow the box — and NO
 * ARITHMETIC HERE MAY BUDGET USER TEXT BY `.length`. The `padEnd(3)` /
 * `padStart(2)` cells below are ASCII markers and indices, which is why they are
 * safe; a "characters that fit" calculation over `content` would not be. That is
 * the whole of the lesson `TeamPanel`'s `WIDE_CHAR_ALLOWANCE` records at length,
 * and the mitigation here is to have no such budget at all.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs, type Glyphs } from './glyphs.js';
import { buildGauge } from './gauge.js';
import { railBorderProps } from './layout/Gutter.js';
import { TODO_RAIL_INDEX_MIN_COLS } from './layout/rail.js';
import { TODO_LIMITS } from '../todo/limits.js';
import { selectTodoRows } from '../todo/panel-rows.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

export interface TodoPanelProps {
  snapshot: TodoSnapshot;
  /** From `todoRailWidth(cols)`. The rail's whole column budget, separator included. */
  width: number;
  /**
   * From `todoRailRows(viewportBudget, teamActive)` — NOT `viewportBudget`
   * (I-10 / P1-3). The gate that mounts this component and the number it lays
   * out against are ONE value computed once in `App`: a panel that mounts on one
   * number and lays out against another renders nothing and reports nothing.
   */
  rows: number;
  /** Whether the agent is running; gates the spinner (never animate when idle). */
  running: boolean;
  reducedMotion: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/** Header row + the blank row under the gauge. */
const FIXED_ROWS = 2;
/** The gauge is the one purely decorative element, so it is the first to go. */
const GAUGE_MIN_ROWS = 8;
const GAUGE_MIN_COLS = 20;
/** Separator column + one space of padding, supplied by `railBorderProps`. */
const CHROME_COLS = 2;
/** Marker cell. Three, because the ASCII tier's `[x]` / `[ ]` are three wide. */
const MARKER_COLS = 3;
/** Index cell: two digits plus the space that separates it from the text. */
const INDEX_COLS = 3;

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

export function TodoPanel({
  snapshot,
  width,
  rows,
  running,
  reducedMotion,
  theme,
  caps,
}: TodoPanelProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const showGauge = width >= GAUGE_MIN_COLS && rows >= GAUGE_MIN_ROWS;
  const showIndex = width >= TODO_RAIL_INDEX_MIN_COLS;
  const itemRows = Math.max(1, rows - FIXED_ROWS - (showGauge ? 1 : 0));
  const { visible, hiddenAbove, hiddenBelow } = selectTodoRows(snapshot.items, itemRows);

  const pct =
    snapshot.total > 0 ? Math.round((snapshot.doneCount / snapshot.total) * 100) : 0;
  const gauge = buildGauge(pct, Math.max(4, width - CHROME_COLS - 2), theme, caps);
  const complete = snapshot.doneCount === snapshot.total;

  return (
    // `flexShrink={0}` IS LOAD-BEARING (P1-4). Ink's `Box.defaultProps` is
    // `{ flexWrap:'nowrap', flexDirection:'row', flexGrow:0, flexShrink:1 }`, so
    // a `width={n}` box inside a shrinking row is SQUEEZED under pressure — and
    // every piece of arithmetic in `rail.ts` silently becomes a suggestion at
    // exactly the narrow widths where the guarantee matters. `ScrollIndicator`
    // spells the same pair one level down. Cross-axis height needs no prop:
    // `alignItems` is unset in this tree and yoga's default is `stretch`.
    <Box
      flexDirection="column"
      flexShrink={0}
      width={width}
      overflow="hidden"
      paddingLeft={1}
      {...railBorderProps(glyphs.railVertical, theme.border)}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate" color={theme.accent} bold>
          TODO
        </Text>
        <Text wrap="truncate" color={complete ? theme.toolDone : theme.muted}>
          {snapshot.doneCount}/{snapshot.total}
          {complete ? ' done' : ''}
        </Text>
      </Box>

      {showGauge && (
        <Text wrap="truncate">
          <Text color={gauge.fillColor}>{gauge.filled}</Text>
          <Text color={gauge.trackColor}>{gauge.empty}</Text>
        </Text>
      )}

      <Text> </Text>

      {hiddenAbove > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'   '}+{hiddenAbove} above
        </Text>
      )}

      {visible.map(({ item, index }) => {
        const active = item.status === 'in_progress';
        // The spinner is gated on `running`: a spinner while the agent is idle
        // is a lie about the state of the world, and this panel outlives the run
        // that filled it. Reduced motion and a non-Unicode terminal fall back to
        // the same static marker, exactly as `AssistantEntry` and `TeamPanel` do.
        const animate = active && running && !reducedMotion && caps.unicode;
        return (
          <Box key={`${index}-${item.content}`} flexDirection="row">
            {/*
              FIXED-WIDTH CELLS, not `padEnd` inside a flexible `<Text>`. Ink
              lays a row out by MEASURED width, and the glyph tiers are not all
              one column: `[x]` is three, and Ink's measurement of `✔` is not
              guaranteed to be one either. A padded string in an auto-width child
              therefore starts the next column a cell late for SOME markers and
              not others, which reads as a ragged list — the one thing a
              checklist cannot afford. A `width` box pins the column whatever the
              glyph measures. `flexShrink={0}` because the row's text child grows.
            */}
            <Box flexShrink={0} width={MARKER_COLS}>
              <Text color={rowColor(item, theme)} bold={active}>
                {animate ? <Spinner type="dots" /> : marker(item, glyphs)}
              </Text>
            </Box>
            {showIndex && (
              <Box flexShrink={0} width={INDEX_COLS}>
                <Text color={theme.muted}>{String(index + 1).padStart(2)}</Text>
              </Box>
            )}
            {/*
              THE IN-PROGRESS ROW IS THE ONLY ONE ALLOWED TO WRAP, up to
              `activeWrapRows`. The wrapping budget of a narrow column is a
              scarce resource and it belongs to the step the user is watching.
              No `strikethrough` on completed items: `chalk` emits SGR 9, which
              legacy `conhost` does not implement and can leak as raw bytes —
              muted colour carries the same meaning with none of the risk (D-17).
            */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text
                wrap={active ? 'wrap' : 'truncate'}
                color={rowColor(item, theme)}
                bold={active}
              >
                {active ? clampWrapped(item.activeForm, width) : item.content}
              </Text>
            </Box>
          </Box>
        );
      })}

      {hiddenBelow > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'   '}+{hiddenBelow} more
        </Text>
      )}
    </Box>
  );
}

/**
 * Keep the wrapping row inside `TODO_LIMITS.activeWrapRows`.
 *
 * A CHARACTER BUDGET IS NOT A COLUMN BUDGET (P2-3), so this is deliberately
 * generous rather than exact: it exists to stop a maximum-length `activeForm`
 * from claiming five rows of an 18-column rail, and Ink's display-width-aware
 * truncation is what actually keeps the row inside the box. Erring long costs
 * nothing — the surrounding `overflow="hidden"` clips it.
 */
function clampWrapped(text: string, width: number): string {
  const budget = Math.max(1, width - CHROME_COLS) * TODO_LIMITS.activeWrapRows;
  return text.length > budget ? text.slice(0, budget) : text;
}
