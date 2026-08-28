/**
 * TodoStrip — the inline-mode plan surface (todo-plan-followthrough §3.7 / W2).
 *
 * ASCII ONLY: every glyph comes from `pickGlyphs`; a literal here bypasses the
 * capability probe and shows mojibake on a legacy console. This file is inside
 * the glyph scanner's scope because it is under `ui/`, NOT because of the
 * `todo/` clause (C-4) — moving it would not move the guard rail with it.
 *
 * WHY A STRIP AND NOT THE RAIL. `decideRenderMode` picks inline for every pipe,
 * every `CI=1`, every `TERM=dumb` and every terminal under 12 rows, and inline
 * has no fixed frame to hang a column off (round 1's non-goal 4). Before this,
 * such a session had the tool and a `todo 3/7` counter in the status bar, and no
 * way at all to see WHICH step was running (OQ-1).
 *
 * WHY NOT IN THE STATUS BAR. The bar's left cluster is `flexShrink={0}` and its
 * own comment records what happens when the row over-subscribes: Ink drops a
 * character from EACH cluster and it renders `idl` / `? hel`. A variable-length
 * step title cannot go there (C-7), which is what forces this into its own row.
 *
 * EXACTLY ONE RENDERED ROW, ALWAYS (AC-29). A strip that wrapped would push the
 * composer down by an unpredictable number of rows on every keystroke, which is
 * the worst possible behaviour for the mode with no frame to absorb it — hence
 * `wrap="truncate"` inside a `flexGrow`/`flexShrink` box and no exceptions.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { TODO_LIMITS } from '../todo/limits.js';
import { todoAnchorIndex } from '../todo/panel-rows.js';
import type { TodoSnapshot } from '../todo/types.js';

export interface TodoStripProps {
  snapshot: TodoSnapshot;
  /** Full terminal width; the strip spans the row in inline mode. */
  cols: number;
  theme: Theme;
  caps: TermCapabilities;
}

export function TodoStrip({ snapshot, cols, theme, caps }: TodoStripProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);

  // THE SAME FUNCTION THE RAIL USES (R-9 / AC-30). Two surfaces that each decide
  // for themselves which step is "current" is two surfaces that disagree, and
  // this one is on screen in exactly the mode where the rail is not, so the
  // disagreement would never be seen side by side and never be reported.
  const anchor = todoAnchorIndex(snapshot.items);
  const item = snapshot.items[anchor];
  const active = item?.status === 'in_progress';
  // `activeForm` while in progress, `content` otherwise — `TodoPanel`'s rule.
  const label = item ? (active ? item.activeForm : item.content) : '';

  // The same degradation the status bar already applies, so the two counters can
  // never disagree about how much room they need.
  const counter =
    cols >= TODO_LIMITS.statusCompactCols
      ? `todo ${snapshot.doneCount}/${snapshot.total}`
      : `[${snapshot.doneCount}/${snapshot.total}]`;

  const showDone = snapshot.doneCount > 0 && cols >= TODO_LIMITS.stripDoneCols;

  return (
    // `width` IS LOAD-BEARING, exactly as it is on `TodoPanel` and for a related
    // reason. Inline mode has no fixed frame, so nothing upstream constrains
    // this row: without an explicit width the flexible middle cell is sized by
    // whatever the parent offers, and a long item overflows the terminal and
    // WRAPS — the one thing this component exists not to do. Pinning it here
    // makes the truncation deterministic and self-contained rather than a
    // property of the tree above.
    <Box flexDirection="row" width={cols} overflow="hidden">
      <Box flexShrink={0}>
        <Text wrap="truncate" color={theme.accent}>
          {counter}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate" color={theme.muted}>
          {' '}
          {glyphs.arrowRight}{' '}
        </Text>
      </Box>
      {/*
        THE ONLY GROWING CELL, and the only one that may be cut. `overflow`
        hidden plus `wrap="truncate"` is what pins the whole component at one
        row whatever the item text is — including CJK, whose display width Ink
        measures and this file deliberately never budgets by `.length`.
      */}
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate" color={active ? theme.primary : theme.muted} bold={active}>
          {label}
        </Text>
      </Box>
      {showDone && (
        <Box flexShrink={0}>
          <Text wrap="truncate" color={theme.muted}>
            {' '}
            +{snapshot.doneCount} done
          </Text>
        </Box>
      )}
    </Box>
  );
}
