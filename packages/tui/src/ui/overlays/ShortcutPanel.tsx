/**
 * The keyboard drawer (tui-shortcut-drawer-and-task-summary §4.5).
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * IT OWNS NO CHROME AND NO ARITHMETIC. `OverlayFrame` draws the frame, the
 * window and the position indicator; `shortcut-panel-layout.ts` decides the
 * columns, the rows and which window contains the cursor. This component adds two
 * things and nothing else: its own key handling and the text-run colours. v1
 * planned 260 lines that re-implemented the frame's windowing and clamping - a
 * second source of truth for the one thing overlays have already been rewritten
 * once to unify.
 *
 * IT DOES NOT REGISTER `Esc` AND DOES NOT TOUCH ANY `ctrl`/`meta` COMBINATION:
 * `Esc` belongs to `App` (it closes every overlay and cancels the pending
 * question/plan), and `Ctrl+G` is handled there too. Two listeners both acting on
 * one byte is how a panel closes twice.
 */

import React, { useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame, overlayBodyRows, overlayPageSize } from '../layout/OverlayFrame.js';
import {
  buildShortcutRows,
  shortcutPanelWidth,
  type ShortcutRow,
  type ShortcutTaskSection,
} from '../layout/shortcut-panel-layout.js';
import { filterShortcuts, isAvailable, SHORTCUTS } from '../shortcuts.js';

export interface ShortcutPanelProps {
  /** The terminal width, which is what `OverlayFrame` needs to pick its form. */
  cols: number;
  maxRows: number;
  theme: Theme;
  caps: TermCapabilities;
  isActive: boolean;
  native: boolean;
  running: boolean;
  /** `/keys <query>` pre-filter. */
  query?: string;
  task: ShortcutTaskSection;
  detailsExpanded: boolean;
  onToggleDetails(): void;
  onRefresh(): void;
}

/** Colour per tone. `dim` is `muted` plus the dim attribute, never a second colour. */
function toneOf(row: ShortcutRow, theme: Theme): { color: Theme['primary']; dimColor?: boolean } {
  if (row.tone === 'accent') return { color: theme.accent };
  if (row.tone === 'primary') return { color: theme.primary };
  if (row.tone === 'dim') return { color: theme.muted, dimColor: true };
  return { color: theme.muted };
}

export function ShortcutPanel(props: ShortcutPanelProps): React.ReactElement {
  const { cols, maxRows, theme, caps, isActive, native, running } = props;
  const glyphs = pickGlyphs(caps);
  const [cursor, setCursor] = useState(0);
  const entries = useMemo(() => filterShortcuts(SHORTCUTS, props.query ?? ''), [props.query]);
  const bodyRows = overlayBodyRows(maxRows, cols);
  const page = overlayPageSize(maxRows, cols);

  const result = useMemo(() => buildShortcutRows({
    cols,
    rows: bodyRows,
    cursor,
    entries,
    task: props.task,
    entryAvailable: (entry) => isAvailable(entry, { native, running }),
    unavailableReason: native ? 'this mode leaves it to the terminal' : 'a run is in flight',
    glyphs: {
      ellipsis: glyphs.ellipsis,
      cursor: glyphs.cursor,
      hrule: glyphs.hrule,
      midDot: glyphs.midDot,
    },
  }), [cols, bodyRows, cursor, entries, props.task, native, running,
    glyphs.ellipsis, glyphs.cursor, glyphs.hrule, glyphs.midDot]);

  const last = Math.max(0, entries.length - 1);
  useInput((input, key) => {
    // `ctrl`/`meta` ARE NOT OURS: `Ctrl+G` closes this panel and `Ctrl+C` owns the
    // exit ladder, both in `App`. Consuming them here would double-handle a byte.
    if (key.ctrl || key.meta) return;
    if (key.upArrow || input === 'k') {
      setCursor((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((value) => Math.min(last, value + 1));
      return;
    }
    // PAGING MOVES THE CURSOR, one page minus one row of overlap - the same rule
    // `overlayPageSize` uses for every other overlay, so a page turn keeps a row of
    // context. An independent offset would let the selected row - and the detail
    // line that explains it - slide off screen (P1-7).
    if (key.pageUp) {
      setCursor((value) => Math.max(0, value - Math.max(1, page - 1)));
      return;
    }
    if (key.pageDown) {
      setCursor((value) => Math.min(last, value + Math.max(1, page - 1)));
      return;
    }
    if (input === 'd') {
      props.onToggleDetails();
      return;
    }
    if (input === 'r') {
      props.onRefresh();
    }
  }, { isActive });

  const rows = result.rows.map((row, index) => (
    <Text
      key={`${row.kind}-${row.entryId ?? 'x'}-${index}`}
      wrap="truncate"
      {...toneOf(row, theme)}
    >
      {row.text}
    </Text>
  ));

  // THE `d` MARKER LIVES ON THE FRAME'S OWN TITLE LINE (D-6), which is chrome that is
  // already paid for. It is spelled `d:on` / `d:off` rather than `details on|off`
  // because the title row also carries the frame's position indicator (`v 1-13/37`,
  // 13 cells) and the drawer's content is only 26 cells wide at 80 columns: the long
  // form is truncated to `details...`, which is a marker that says nothing. The
  // footer's `d details` clause names the key, so the pair reads as one sentence.
  const title = `Keys  d:${props.detailsExpanded ? 'on' : 'off'}`;
  return (
    <OverlayFrame
      title={title}
      hint={result.hint}
      maxRows={maxRows}
      cols={cols}
      width={shortcutPanelWidth(cols)}
      align="right"
      rows={rows}
      // THE WINDOW IS DERIVED FROM THE CURSOR, so the offset handed to the frame is
      // a conclusion rather than state. `onScrollClamp` is deliberately not passed:
      // there is nothing here that could drift out of step with it.
      scrollOffset={result.window.start}
      theme={theme}
      caps={caps}
    />
  );
}
