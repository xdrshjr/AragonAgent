/** Pair a hunk's rows for the side-by-side diff view. Pure. */

import type { PatchLine } from '@aragon-agent/tui/model/tools/patch';

export interface SideBySideRow {
  left: PatchLine | null;
  right: PatchLine | null;
}

/**
 * Context rows appear on both sides; a run of deletions is paired row-for-row with the run of
 * additions that follows it, and the longer run's tail has an empty opposite cell.
 */
export function pairHunkRows(lines: readonly PatchLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'ctx') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: PatchLine[] = [];
    const added: PatchLine[] = [];
    while (index < lines.length && lines[index]!.kind === 'del') removed.push(lines[index++]!);
    while (index < lines.length && lines[index]!.kind === 'add') added.push(lines[index++]!);
    const height = Math.max(removed.length, added.length);
    for (let row = 0; row < height; row += 1) {
      rows.push({ left: removed[row] ?? null, right: added[row] ?? null });
    }
  }
  return rows;
}
