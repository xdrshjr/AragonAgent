import { describe, expect, it } from 'vitest';
import { buildPatch } from '@aragon-agent/tui/model/tools/patch';
import { pairHunkRows } from '../chat-diff.js';

describe('side-by-side pairing', () => {
  it('pairs a replaced line across the two columns and keeps context on both', () => {
    const patch = buildPatch('a\nb\nc\n', 'a\nB\nc\n', { path: 'x.txt' });
    const rows = patch.hunks.flatMap((hunk) => pairHunkRows(hunk.lines));
    const changed = rows.find((row) => row.left?.kind === 'del');
    expect(changed?.left?.text).toBe('b');
    expect(changed?.right?.text).toBe('B');
    const context = rows.find((row) => row.left?.kind === 'ctx');
    expect(context?.left).toBe(context?.right);
  });

  it('leaves the opposite cell empty for a pure addition', () => {
    const added = buildPatch('a\n', 'a\nnew\n', { path: 'x.txt' });
    const rows = added.hunks.flatMap((hunk) => pairHunkRows(hunk.lines));
    expect(rows.some((row) => row.left === null && row.right?.kind === 'add')).toBe(true);
  });

  it('keeps every changed row exactly once', () => {
    const patch = buildPatch('1\n2\n3\n4\n', 'one\n2\n3\nfour\nfive\n', { path: 'x.txt' });
    const changed = patch.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== 'ctx').length;
    const rows = patch.hunks.flatMap((hunk) => pairHunkRows(hunk.lines));
    const cells = rows.reduce(
      (sum, row) => sum + (row.left && row.left.kind !== 'ctx' ? 1 : 0) + (row.right && row.right.kind !== 'ctx' ? 1 : 0),
      0,
    );
    expect(cells).toBe(changed);
  });
});
