/**
 * A `FilePatch` as a diff (agent-activity-presentation §3.4): a `+6 -5` summary,
 * then hunk-separated rows with a right-aligned line-number gutter, a `+`/`-`/
 * space sign column and `theme.diff` colors.
 *
 * `wrap="truncate"` ON EVERY ROW IS A CORRECTNESS REQUIREMENT, NOT A TASTE ONE.
 * `estimateEntryRows` computes a diff card's height by COUNTING rows, so a
 * wrapped patch line would occupy two rows while the estimate charged one — an
 * under-estimate, which `virtual-window.ts` names as the unsafe direction. One
 * patch line is one terminal row, always.
 *
 * No new keybinding and no new state: collapse rides on `expandedToolIds` and
 * the existing `Ctrl+O` handler, which targets the MOST RECENT tool card (P2-4).
 *
 * `caps` is deliberately NOT a prop. Every character this component emits is
 * ASCII — `+`, `-`, `@@`, digits — because `+` and `-` are the diff's own
 * vocabulary and `renderUnifiedDiff` already spells them literally. A glyph
 * lookup here would buy nothing and add a memo dependency.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { FilePatch, PatchLine } from '../../tools/patch.js';

/**
 * Diff rows shown before collapse.
 *
 * Higher than the generic preview's 8 (D-11): a diff's rows are half as tall in
 * information terms, and 8 rows of a 3-context hunk is barely one change.
 * DUPLICATED AS A NUMBER in `virtual-window.ts`, matching what
 * `TOOL_COLLAPSED_LINES` already does and the comment that justifies it.
 */
export const DIFF_COLLAPSED_LINES = 12;

/** Gutter width bounds; three digits is the floor so narrow files still align. */
const GUTTER_MIN = 3;
const GUTTER_MAX = 6;

export interface DiffViewProps {
  patch: FilePatch;
  expanded?: boolean;

  theme: Theme;
}

/** One rendered row: a patch line, or the `@@` separator between two hunks. */
interface DiffRow {
  kind: PatchLine['kind'] | 'meta';
  /** The gutter number, or `undefined` for a separator and the newline note. */
  num?: number;
  text: string;
}

/**
 * Flatten the hunks into rows, inserting one `@@` separator BETWEEN hunks and
 * none before the first.
 *
 * Exported for `diff-view.test.tsx`, and because the row count it produces is
 * the number `estimateEntryRows` reproduces arithmetically — the two must not
 * disagree.
 */
export function diffRows(patch: FilePatch): DiffRow[] {
  const rows: DiffRow[] = [];
  patch.hunks.forEach((hunk, index) => {
    if (index > 0) {
      rows.push({
        kind: 'meta',
        text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      });
    }
    for (const line of hunk.lines) {
      rows.push({
        kind: line.kind,
        // An `add` shows its new number, a `del` its old, a `ctx` its new.
        ...(pickNumber(line) !== undefined ? { num: pickNumber(line) } : {}),
        text: line.text,
      });
    }
  });
  return rows;
}

function pickNumber(line: PatchLine): number | undefined {
  return line.kind === 'del' ? line.oldLine : line.newLine ?? line.oldLine;
}

function signOf(kind: DiffRow['kind']): string {
  if (kind === 'add') return '+';
  if (kind === 'del') return '-';
  return ' ';
}

function colorOf(kind: DiffRow['kind'], theme: Theme): string | undefined {
  if (kind === 'add') return theme.diff.add;
  if (kind === 'del') return theme.diff.remove;
  if (kind === 'meta') return theme.diff.meta;
  return theme.diff.context;
}

function gutterWidth(rows: DiffRow[]): number {
  let max = 0;
  for (const row of rows) if (row.num !== undefined && row.num > max) max = row.num;
  return Math.min(GUTTER_MAX, Math.max(GUTTER_MIN, String(max).length));
}

function DiffViewImpl({
  patch,
  expanded,
  theme,
}: DiffViewProps): React.ReactElement {
  const rows = diffRows(patch);
  const ceiling = expanded ? rows.length : DIFF_COLLAPSED_LINES;
  const visible = ceiling >= rows.length ? rows : rows.slice(0, Math.max(0, ceiling));
  const hidden = rows.length - visible.length;
  const width = gutterWidth(rows);

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={theme.diff.add}>+{patch.added}</Text>
        <Text color={theme.muted}> </Text>
        <Text color={theme.diff.remove}>-{patch.removed}</Text>
        {patch.truncated && <Text color={theme.muted}> (truncated)</Text>}
        {patch.degraded && (
          <Text color={theme.muted}> old side not read: {patch.degraded}</Text>
        )}
      </Text>
      {visible.map((row, i) => (
        <Text key={i} wrap="truncate">
          <Text color={theme.muted}>{String(row.num ?? '').padStart(width)}</Text>
          <Text color={colorOf(row.kind, theme)}>
            {' '}
            {signOf(row.kind)} {row.text}
          </Text>
        </Text>
      ))}
      {/*
        EXACTLY ONE FOOTER ROW, EVER. `estimateEntryRows` charges the diff card
        `summary + shown + 1`; a second footer would make that an under-estimate
        for every expanded diff, which is the direction the layout cannot absorb.
      */}
      {hidden > 0 ? (
        <Text color={theme.muted}>
          +{hidden} {hidden === 1 ? 'line' : 'lines'} (Ctrl+O)
        </Text>
      ) : (
        rows.length > DIFF_COLLAPSED_LINES && <Text color={theme.muted}>(Ctrl+O to collapse)</Text>
      )}
    </Box>
  );
}

/**
 * `React.memo` with the DEFAULT comparator, matching `ToolCard`'s boundary.
 * `patch` qualifies as a prop only because the reducer writes it ONCE at
 * `toolExecEnd` and never rebuilds it (P2-9); `theme` is `useMemo`d in `App.tsx`
 * (I-L2-1).
 */
export const DiffView = React.memo(DiffViewImpl);
