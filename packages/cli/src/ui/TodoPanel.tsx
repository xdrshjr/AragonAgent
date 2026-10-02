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
 * WIDTH IS MEASURED IN COLUMNS, NEVER IN CODE UNITS (P2-3). This rail is 14-36
 * columns wide and the system prompt's last line is "Respond in the language the
 * user writes in", so CJK item text in an 18-column rail is the NORMAL case
 * rather than the edge case. Every text cell is `wrap="truncate"` and Ink's
 * truncation is display-width aware, so nothing can overflow the box — and NO
 * ARITHMETIC HERE MAY BUDGET USER TEXT BY `.length`. The count string and
 * `padStart(2)` cells below are ASCII counts and indices, which is why they are
 * safe; a "characters that fit" calculation over `content` would not be. That is
 * the whole of the lesson `TeamPanel`'s `WIDE_CHAR_ALLOWANCE` records at length,
 * and the mitigation here is to have no such budget at all.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs, type Glyphs } from './glyphs.js';
import { buildGauge } from './gauge.js';
import { railBorderProps } from './layout/Gutter.js';
import { TODO_RAIL_INDEX_MIN_COLS } from './layout/rail.js';
import { TODO_LIMITS } from '../todo/limits.js';
import { selectCompactTodoRows, selectTodoRows } from '../todo/panel-rows.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

export interface TodoPanelProps {
  snapshot: TodoSnapshot;
  /** From `todoRailWidth(cols)`. The rail's whole column budget, separator included. */
  width: number;
  /**
   * From `buildTodoRailLayout` after actual team/menu rows are subtracted.
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
  // Ink's tokenizer otherwise treats the bare emoji-capable check as one cell,
  // while string-width counts two, adding an extra visible space to each row.
  if (item.status === 'completed') {
    return glyphs.todoDone.length === 1 ? `${glyphs.todoDone}\uFE0F` : glyphs.todoDone;
  }
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
}: TodoPanelProps): React.ReactElement | null {
  const glyphs = pickGlyphs(caps);
  // Ink reapplies all four Yoga borders when the borderStyle object changes,
  // but unchanged borderTop/Bottom=false props are not reapplied on that update.
  const border = useMemo(() => railBorderProps(glyphs.railVertical), [glyphs.railVertical]);
  if (snapshot.items.length === 0 || rows < TODO_LIMITS.panelMinRows) return null;
  const compact = rows < TODO_LIMITS.panelFullRows;
  const showGauge = width >= GAUGE_MIN_COLS && rows >= GAUGE_MIN_ROWS;
  const showIndex = !compact && width >= TODO_RAIL_INDEX_MIN_COLS;
  const compactFooter = compact && snapshot.items.length > rows - 1;
  const itemRows = compact ? rows - 1 - Number(compactFooter)
    : rows - FIXED_ROWS - Number(showGauge);
  const { visible, hiddenAbove, hiddenBelow } = compact
    ? selectCompactTodoRows(snapshot.items, itemRows)
    : selectTodoRows(snapshot.items, itemRows);

  const pct =
    snapshot.total > 0 ? Math.round((snapshot.doneCount / snapshot.total) * 100) : 0;
  const gauge = buildGauge(pct, Math.max(4, width - CHROME_COLS - 2), theme, caps);
  const complete = snapshot.doneCount === snapshot.total;
  const countText = `${snapshot.doneCount}/${snapshot.total}`;
  const showDone = complete
    && width - CHROME_COLS >= 'TODO '.length + countText.length + ' done'.length;
  const count = `${countText}${showDone ? ' done' : ''}`;

  return (
    // `flexShrink={0}` IS LOAD-BEARING (P1-4). Ink's `Box.defaultProps` is
    // `{ flexWrap:'nowrap', flexDirection:'row', flexGrow:0, flexShrink:1 }`, so
    // a `width={n}` box inside a shrinking row is SQUEEZED under pressure — and
    // every piece of arithmetic in `rail.ts` silently becomes a suggestion at
    // exactly the narrow widths where the guarantee matters. `ScrollIndicator`
    // spells the same pair one level down. Height uses the same row budget as
    // selection, so content cannot silently enlarge the middle band.
    <Box
      key={glyphs.railVertical}
      flexDirection="column"
      flexShrink={0}
      width={width}
      height={rows}
      overflow="hidden"
      paddingLeft={1}
      {...border}
      borderColor={theme.border}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate" color={theme.accent} bold>TODO</Text>
        </Box>
        <Box width={count.length} flexShrink={0}>
          <Text wrap="truncate" color={complete ? theme.toolDone : theme.muted}>{count}</Text>
        </Box>
      </Box>

      {showGauge && (
        <Text wrap="truncate">
          <Text color={gauge.fillColor}>{gauge.filled}</Text>
          <Text color={gauge.trackColor}>{gauge.empty}</Text>
        </Text>
      )}

      {!compact && <Text> </Text>}

      {!compact && hiddenAbove > 0 && (
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
              Every item occupies one row so the anchor and overflow markers
              fit the shared budget. The transcript card retains full text.
              No `strikethrough` on completed items: `chalk` emits SGR 9, which
              legacy `conhost` does not implement and can leak as raw bytes —
              muted colour carries the same meaning with none of the risk (D-17).
            */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text
                wrap="truncate"
                color={rowColor(item, theme)}
                bold={active}
              >
                {active ? item.activeForm : item.content}
              </Text>
            </Box>
          </Box>
        );
      })}

      {compactFooter && (
        <Text wrap="truncate" color={theme.muted}>-{hiddenAbove} +{hiddenBelow}</Text>
      )}
      {!compact && hiddenBelow > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'   '}+{hiddenBelow} more
        </Text>
      )}
    </Box>
  );
}
