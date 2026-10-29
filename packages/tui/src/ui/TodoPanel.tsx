/**
 * TodoPanel — the right rail (todo-plan-execution §6.1; two sections per
 * todo-acceptance-criteria §6.9).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`; a literal here bypasses the
 * capability probe and shows mojibake on a legacy console (`glyphs.ts` header).
 *
 * MOUNTED ONLY WHEN A LIST EXISTS. `App` passes `null` the rest of the time and
 * this component is not rendered at all, so a session that never plans has zero
 * columns and zero layout shift (R-g's "no furniture when idle" / AC-24).
 *
 * NO NEW PROP CARRIES THE ACCEPTANCE TABLE (§6.9.1): `snapshot.acceptance` is
 * already inside `snapshot`, and `null` IS the projection of "the capability is
 * off", because a disabled store commits an empty table. Keeping the props surface
 * narrow is what keeps `App`'s two mount points untouched.
 *
 * IT MUST BE MOUNTED IN `AppShell`'s MIDDLE BAND, NEVER IN THE BOTTOM CHROME
 * (C-6 / I-4). This is a COLUMN BESIDE the viewport, and the middle band is the
 * only row-wrapped region there is; moved down into the bottom chrome it would stop
 * being a rail and start eating viewport height, growing and shrinking the
 * transcript every time the list changed length.
 *
 * WIDTH IS MEASURED IN COLUMNS, NEVER IN CODE UNITS (P2-3). This rail is 14-36
 * columns wide and the system prompt's last line is "Respond in the language the
 * user writes in", so CJK text in an 18-column rail is the NORMAL case rather than
 * the edge case. Every text cell is `wrap="truncate"` and Ink's truncation is
 * display-width aware, so nothing can overflow the box - and NO ARITHMETIC HERE MAY
 * BUDGET USER TEXT BY `.length`. The count strings and `padStart(2)` cells below are
 * ASCII counts and indices, which is why they are safe.
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
import { TODO_LIMITS } from '../model/todo/limits.js';
import { derivePlanPhase } from '../model/todo/acceptance.js';
import { buildPlanSections } from '../model/todo/plan-sections.js';
import {
  selectAcceptanceRows,
  selectCompactAcceptanceRows,
  selectCompactTodoRows,
  selectTodoRows,
} from '../model/todo/panel-rows.js';
import type { AcceptanceItem, TodoItem, TodoSnapshot } from '../model/todo/types.js';

export interface TodoPanelProps {
  snapshot: TodoSnapshot;
  /** From `todoRailWidth(cols)`. The rail's whole column budget, separator included. */
  width: number;
  /**
   * From `buildTodoRailLayout` after actual team/menu rows are subtracted.
   * (I-10 / P1-3). The gate that mounts this component and the number it lays out
   * against are ONE value computed once in `App`: a panel that mounts on one number
   * and lays out against another renders nothing and reports nothing.
   */
  rows: number;
  /** Whether the agent is running; gates the spinner (never animate when idle). */
  running: boolean;
  reducedMotion: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

/** The gauge is the one purely decorative element, so it is the first to go. */
const GAUGE_MIN_ROWS = 8;
const GAUGE_MIN_COLS = 20;
/** Separator column + one space of padding, supplied by `railBorderProps`. */
const CHROME_COLS = 2;
/** Marker cell. Three, because the ASCII tier's `[x]` / `[ ]` / `[!]` are three wide. */
const MARKER_COLS = 3;
/** Index cell: two digits plus the space that separates it from the text. */
const INDEX_COLS = 3;
/** `ACCEPT` / `VERIFY` are both six columns, so switching phase shifts nothing (D-8). */
const ACCEPT_LABEL = 'ACCEPT';
const VERIFY_LABEL = 'VERIFY';

function marker(item: TodoItem, glyphs: Glyphs): string {
  // Ink's tokenizer otherwise treats the bare emoji-capable check as one cell,
  // while string-width counts two, adding an extra visible space to each row.
  if (item.status === 'completed') {
    return glyphs.todoDone.length === 1 ? `${glyphs.todoDone}\uFE0F` : glyphs.todoDone;
  }
  if (item.status === 'in_progress') return glyphs.todoActive;
  return glyphs.todoPending;
}

/**
 * `passed` REUSES THE DONE GLYPH ON PURPOSE (D-9): it is the same settled positive,
 * so two colour ramps and two shapes for one meaning would be learned twice for
 * nothing. `failed` is the only new meaning, and it gets the only new glyph.
 */
function acceptanceMarker(item: AcceptanceItem, glyphs: Glyphs): string {
  if (item.status === 'passed') {
    return glyphs.todoDone.length === 1 ? `${glyphs.todoDone}\uFE0F` : glyphs.todoDone;
  }
  if (item.status === 'failed') return glyphs.todoFail;
  if (item.status === 'in_progress') return glyphs.todoActive;
  return glyphs.todoPending;
}

function rowColor(item: TodoItem, theme: Theme): string | undefined {
  if (item.status === 'completed') return theme.muted;
  if (item.status === 'in_progress') return theme.primary;
  return theme.hintFg ?? theme.muted;
}

function acceptanceRowColor(item: AcceptanceItem, theme: Theme): string | undefined {
  if (item.status === 'failed') return theme.toolError;
  if (item.status === 'passed') return theme.muted;
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
  // Ink reapplies all four Yoga borders when the borderStyle object changes, but
  // unchanged borderTop/Bottom=false props are not reapplied on that update.
  const border = useMemo(() => railBorderProps(glyphs.railVertical), [glyphs.railVertical]);
  if (snapshot.items.length === 0 || rows < TODO_LIMITS.panelMinRows) return null;

  const compact = rows < TODO_LIMITS.panelFullRows;
  const showGauge = width >= GAUGE_MIN_COLS && rows >= GAUGE_MIN_ROWS;
  const showIndex = !compact && width >= TODO_RAIL_INDEX_MIN_COLS;
  const acceptance = snapshot.acceptance;
  const acceptanceItems = acceptance?.items ?? [];
  const phase = derivePlanPhase(snapshot.items, acceptanceItems);

  // EVERY ROW FIGURE COMES FROM ONE FUNCTION (§6.9.2). Not because arithmetic in a
  // component is hard, but because `/perf` and the status-bar chip have to report
  // the same answer, and a second copy is a second answer.
  const sections = buildPlanSections({
    rows,
    width,
    phase,
    todoCount: snapshot.items.length,
    acceptanceCount: acceptanceItems.length,
    showGauge,
  });
  const compactFooter = sections.todoFooter;

  const todoWindow = compact
    ? selectCompactTodoRows(snapshot.items, sections.todoItemRows)
    : selectTodoRows(snapshot.items, sections.todoItemRows);
  const acceptanceSection = sections.acceptance;
  const acceptanceWindow = acceptanceSection && acceptanceSection.itemRows > 0
    ? compact
      ? selectCompactAcceptanceRows(acceptanceItems, acceptanceSection.itemRows)
      : selectAcceptanceRows(acceptanceItems, acceptanceSection.itemRows)
    : { visible: [], hiddenAbove: 0, hiddenBelow: 0 };

  const pct =
    snapshot.total > 0 ? Math.round((snapshot.doneCount / snapshot.total) * 100) : 0;
  const gauge = buildGauge(pct, Math.max(4, width - CHROME_COLS - 2), theme, caps);
  const complete = snapshot.doneCount === snapshot.total;
  const countText = `${snapshot.doneCount}/${snapshot.total}`;
  const showDone = complete && fitsDone(width, countText, 'TODO');
  const count = `${countText}${showDone ? ' done' : ''}`;
  // ONE CALL EACH: the text is both the header's right-hand cell and the width that
  // cell is measured with, so computing it twice invites the two to drift.
  const acceptanceCountLabel = acceptanceCountText(acceptance, width);
  const acceptanceTone = acceptanceColor(acceptance, theme);
  // The `summary` rung has NO `done` rung (§6.9.3): one muted line, or the error
  // colour when something failed. Green is a verdict about a table the narrow rail is
  // not showing, and claiming it in one line would be the only place in this feature
  // where a colour says more than the text does.
  const hasFailed = (acceptance?.failedCount ?? 0) > 0;
  const acceptanceSummaryTone = hasFailed ? theme.toolError : theme.muted;

  // `verify` collapses the step list to ONE row: every step is done, so seven rows
  // of "completed" buy no information and cost the rows the eye needs (D-7). The
  // marker cell is still reserved so the two sections stay column-aligned.
  const showTodoItems = phase !== 'verify';
  // THE `-N +M` FOOTER DESCRIBES A WINDOW THAT IS ON SCREEN. In `verify` the list is
  // collapsed on purpose, so the marker would advertise rows the user cannot reach
  // (`-0 +5` under "all steps complete" is the exact opposite of the sentence above
  // it). The rows it would have occupied stay blank inside the fixed-height box.
  const showCompactFooter = compactFooter && showTodoItems;

  return (
    // `flexShrink={0}` IS LOAD-BEARING (P1-4). Ink's `Box.defaultProps` is
    // `{ flexWrap:'nowrap', flexDirection:'row', flexGrow:0, flexShrink:1 }`, so a
    // `width={n}` box inside a shrinking row is SQUEEZED under pressure - and every
    // piece of arithmetic in `rail.ts` silently becomes a suggestion at exactly the
    // narrow widths where the guarantee matters. `ScrollIndicator` spells the same
    // pair one level down. Height uses the same row budget as selection, so content
    // cannot silently enlarge the middle band.
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

      {/*
        THE BLANK ROW IS STILL `!compact` AND NOTHING ELSE (§6.9.3). It is the
        breathing space under the TODO header AND the separator between the two
        sections - one row doing two jobs, which is exactly why `overhead` is 3 and
        not 4. Conditioning it on `acceptance !== null` would add a row the row
        algebra does not know about, and Ink would silently clip the last one.
      */}
      {!compact && <Text> </Text>}

      {!compact && showTodoItems && todoWindow.hiddenAbove > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'   '}+{todoWindow.hiddenAbove} above
        </Text>
      )}

      {showTodoItems && todoWindow.visible.map(({ item, index }) => {
        const active = item.status === 'in_progress';
        // The spinner is gated on `running`: a spinner while the agent is idle is a
        // lie about the state of the world, and this panel outlives the run that
        // filled it. Reduced motion and a non-Unicode terminal fall back to the same
        // static marker, exactly as `AssistantEntry` and `TeamPanel` do.
        const animate = active && running && !reducedMotion && caps.unicode;
        return (
          <Box key={`${index}-${item.content}`} flexDirection="row">
            {/*
              FIXED-WIDTH CELLS, not `padEnd` inside a flexible `<Text>`. Ink lays a
              row out by MEASURED width, and the glyph tiers are not all one column:
              `[x]` is three, and Ink's measurement of `✔` is not guaranteed to be
              one either. A padded string in an auto-width child therefore starts the
              next column a cell late for SOME markers and not others, which reads as
              a ragged list - the one thing a checklist cannot afford. A `width` box
              pins the column whatever the glyph measures.
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
              Every item occupies one row so the anchor and overflow markers fit the
              shared budget. The transcript card retains full text. No
              `strikethrough` on completed items: `chalk` emits SGR 9, which legacy
              `conhost` does not implement and can leak as raw bytes - muted colour
              carries the same meaning with none of the risk (D-17).
            */}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={rowColor(item, theme)} bold={active}>
                {active ? item.activeForm : item.content}
              </Text>
            </Box>
          </Box>
        );
      })}

      {phase === 'verify' && (
        <Text wrap="truncate" color={theme.muted}>
          {'   '}all steps complete
        </Text>
      )}

      {showCompactFooter && (
        <Text wrap="truncate" color={theme.muted}>
          -{todoWindow.hiddenAbove} +{todoWindow.hiddenBelow}
        </Text>
      )}
      {!compact && showTodoItems && todoWindow.hiddenBelow > 0 && (
        <Text wrap="truncate" color={theme.muted}>
          {'   '}+{todoWindow.hiddenBelow} more
        </Text>
      )}

      {acceptanceSection && acceptanceSection.reason === 'summary' && (
        <Text wrap="truncate" color={acceptanceSummaryTone}>
          {'   '}AC {summaryCount(acceptance)}
        </Text>
      )}

      {acceptanceSection && acceptanceSection.reason === 'visible' && (
        <>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text wrap="truncate" color={theme.accent} bold>
                {phase === 'verify' ? VERIFY_LABEL : ACCEPT_LABEL}
              </Text>
            </Box>
            <Box width={acceptanceCountLabel.length} flexShrink={0}>
              <Text wrap="truncate" color={acceptanceTone}>
                {acceptanceCountLabel}
              </Text>
            </Box>
          </Box>
          {acceptanceWindow.visible.map(({ item, index }) => {
            const active = item.status === 'in_progress';
            const animate = active && running && !reducedMotion && caps.unicode;
            return (
              <Box key={`acc-${index}-${item.content}`} flexDirection="row">
                {/*
                  ONE COLUMN WIDER THAN THE TODO CELL (`MARKER_COLS + 1`): the ASCII
                  tier's marker is exactly three wide, so without the extra column the
                  criterion's text would touch it (`[ ]criterion`), while the unicode
                  tier's single-column glyph already leaves the padding. A fixed box
                  keeps both tiers aligned at the same text column.
                */}
                <Box flexShrink={0} width={MARKER_COLS + 1}>
                  <Text color={acceptanceRowColor(item, theme)} bold={active}>
                    {animate ? <Spinner type="dots" /> : acceptanceMarker(item, glyphs)}
                  </Text>
                </Box>
                {/*
                  The criterion's `content` ALWAYS, never a verb form: criteria have no
                  `activeForm`, and "being checked" is carried by the marker and the
                  spinner rather than by rewriting the sentence.
                */}
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Text wrap="truncate" color={acceptanceRowColor(item, theme)} bold={active}>
                    {item.content}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}

/**
 * Does the section's count fit beside its label? The same width guard the TODO
 * header uses for ` done`, so a narrow rail drops the suffix rather than the number.
 */
function fitsDone(width: number, countText: string, label: string): boolean {
  return width - CHROME_COLS >= label.length + 1 + countText.length + ' done'.length;
}

/** `<checked>/<total>`, ` !<failed>`, and ` done` when every criterion passed. */
function acceptanceCountText(
  acceptance: TodoSnapshot['acceptance'],
  width: number,
): string {
  if (!acceptance) return '';
  const base = `${acceptance.checkedCount}/${acceptance.total}`;
  const failed = acceptance.failedCount > 0 ? ` !${acceptance.failedCount}` : '';
  const allPassed = acceptance.checkedCount === acceptance.total && acceptance.failedCount === 0;
  const done = allPassed && fitsDone(width, base, VERIFY_LABEL) ? ' done' : '';
  return `${base}${failed}${done}`;
}

/** The `summary` rung's single line: `2/5`, plus ` !1` when something failed. */
function summaryCount(acceptance: TodoSnapshot['acceptance']): string {
  if (!acceptance) return '';
  return `${acceptance.checkedCount}/${acceptance.total}` +
    (acceptance.failedCount > 0 ? ` !${acceptance.failedCount}` : '');
}

/**
 * All passed reads as done, any failure reads as an error, everything else is
 * muted - the same three-rung colour ladder the TODO header uses.
 */
function acceptanceColor(
  acceptance: TodoSnapshot['acceptance'],
  theme: Theme,
): string | undefined {
  if (!acceptance) return theme.muted;
  if (acceptance.failedCount > 0) return theme.toolError;
  if (acceptance.total > 0 && acceptance.checkedCount === acceptance.total) {
    return theme.toolDone;
  }
  return theme.muted;
}
