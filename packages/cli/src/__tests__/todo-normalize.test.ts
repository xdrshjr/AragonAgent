/**
 * `normalizeTodos` — the repair table of todo-plan-execution §3.4 (AC-1..AC-8).
 *
 * The last two rules are what make "exactly one item at a time" (R-b / I-3) a
 * PROPERTY OF THE STORED STATE rather than a request in a prompt, which is the
 * whole reason this can be a unit test instead of an operator reading a
 * transcript.
 */

import { describe, expect, it } from 'vitest';
import { normalizeTodos } from '../todo/normalize.js';
import { TODO_LIMITS } from '../todo/limits.js';

function items(n: number, status = 'pending'): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    content: `step ${i + 1}`,
    activeForm: `doing step ${i + 1}`,
    status,
  }));
}

describe('normalizeTodos', () => {
  it('AC-1: a well-formed payload is committed verbatim, with no repairs', () => {
    const result = normalizeTodos(items(7), TODO_LIMITS.maxItems);
    expect(result.items).toHaveLength(7);
    expect(result.requested).toBe(7);
    expect(result.repairs).toEqual([]);
    // Item 0 is promoted, which is the SAME rule as AC-4 and is not a repair
    // note: a model that writes its plan and then starts step 1 is doing the
    // right thing, and the panel should say so on the first frame.
    expect(result.items[0]!.status).toBe('in_progress');
  });

  it('AC-2: 23 items commit 20, and the note names how many were dropped', () => {
    const result = normalizeTodos(items(23), TODO_LIMITS.maxItems);
    expect(result.items).toHaveLength(20);
    expect(result.requested).toBe(23);
    expect(result.repairs.join('\n')).toContain('the last 3 were dropped (maximum 20)');
  });

  it('AC-3: two in_progress items commit with exactly one, and say so', () => {
    const raw = [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ];
    const result = normalizeTodos(raw, TODO_LIMITS.maxItems);
    expect(result.items.map((i) => i.status)).toEqual(['in_progress', 'pending', 'pending']);
    expect(result.repairs.join('\n')).toContain('only the first was kept');
  });

  it('AC-4: an all-pending list promotes item 0', () => {
    const result = normalizeTodos(items(3), TODO_LIMITS.maxItems);
    expect(result.items.map((i) => i.status)).toEqual(['in_progress', 'pending', 'pending']);
  });

  it('AC-5: an all-completed list promotes nothing', () => {
    const result = normalizeTodos(items(3, 'completed'), TODO_LIMITS.maxItems);
    expect(result.items.every((i) => i.status === 'completed')).toBe(true);
    expect(result.items.findIndex((i) => i.status === 'in_progress')).toBe(-1);
  });

  it('AC-6: an unknown status is REPAIRED to pending, never rejected', () => {
    // `blocked` is the status a model reaches for when it hits a wall. The
    // schema deliberately carries no `enum` (C-8), so this is where it lands —
    // and dropping the item would lose the step entirely.
    const result = normalizeTodos(
      [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'blocked' },
      ],
      TODO_LIMITS.maxItems,
    );
    expect(result.items.map((i) => i.status)).toEqual(['completed', 'in_progress']);
  });

  it('AC-7: blank content drops, long content clamps, newlines collapse', () => {
    const result = normalizeTodos(
      [
        { content: '   ', status: 'pending' },
        { content: 'x'.repeat(200), status: 'pending' },
        { content: 'two\nlines\there', status: 'pending' },
      ],
      TODO_LIMITS.maxItems,
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.content).toHaveLength(TODO_LIMITS.contentChars);
    // Sanitized at STORE rather than at render, so the rail, the transcript card
    // and `/todo status` all inherit the guarantee for free.
    expect(result.items[1]!.content).toBe('two lines here');
    expect(result.repairs.join('\n')).toContain('non-empty content string');
  });

  it('AC-8: a missing activeForm falls back to content', () => {
    const result = normalizeTodos([{ content: 'Add the rail', status: 'pending' }], 20);
    expect(result.items[0]!.activeForm).toBe('Add the rail');
  });

  it('a non-array yields zero items rather than throwing (the one hard failure)', () => {
    for (const junk of [undefined, null, 'nope', 42, {}]) {
      const result = normalizeTodos(junk, TODO_LIMITS.maxItems);
      expect(result.items).toEqual([]);
      expect(result.requested).toBe(0);
    }
  });

  it('DROPS FIRST AND CAPS SECOND, so a blank entry cannot consume a real slot', () => {
    // Capping first would let junk eat a slot the model meant for work, and the
    // list would silently be one shorter than the model believed — the ordering
    // `normalizeSubagentSpecs` records for the same reason.
    const raw = [{ content: '' }, ...items(20)];
    const result = normalizeTodos(raw, TODO_LIMITS.maxItems);
    expect(result.items).toHaveLength(20);
    expect(result.items[19]!.content).toBe('step 20');
  });
});
