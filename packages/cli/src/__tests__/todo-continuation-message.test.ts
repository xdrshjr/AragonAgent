/**
 * `buildContinuationMessage` — enumeration, not reference
 * (todo-plan-followthrough §3.3 / D-11).
 *
 * The message is the ONE artefact both continuation paths share, so its
 * properties are worth pinning separately from the decision table: the auto path
 * and `/todo continue` produce identical text by construction, and this file is
 * what keeps that construction honest.
 */

import { describe, expect, it } from 'vitest';
import { buildContinuationMessage } from '../todo/follow-through.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

function listOf(statuses: TodoItem['status'][]): TodoSnapshot {
  const items = statuses.map((status, i) => ({
    content: `write module ${i + 1}`,
    activeForm: `writing module ${i + 1}`,
    status,
  }));
  return {
    items,
    total: items.length,
    doneCount: items.filter((i) => i.status === 'completed').length,
    activeIndex: items.findIndex((i) => i.status === 'in_progress'),
    updatedAt: 0,
  };
}

describe('buildContinuationMessage', () => {
  it('opens with an instruction and closes with the todo_write discipline', () => {
    const text = buildContinuationMessage(listOf(['completed', 'in_progress', 'pending']));
    const lines = text.split('\n');
    expect(lines[0]).toBe('Continue the plan. These steps are not done yet:');
    expect(lines[lines.length - 1]).toBe(
      'Work the next one, then call todo_write to mark it completed and the following ' +
        'one in_progress before you move on.',
    );
  });

  it('omits completed items entirely', () => {
    const text = buildContinuationMessage(listOf(['completed', 'completed', 'in_progress']));
    expect(text).not.toContain('write module 1');
    expect(text).not.toContain('write module 2');
    expect(text).toContain('write module 3');
  });

  it('numbers by 1-based position in the WHOLE list, not by position among the remainder', () => {
    // "step 5" has to mean the same thing here as it does in the rail and in the
    // status counter; renumbering from 1 would silently make three surfaces
    // disagree about which step the model was asked to do.
    const text = buildContinuationMessage(
      listOf(['completed', 'completed', 'completed', 'in_progress', 'pending']),
    );
    expect(text).toContain('4. write module 4');
    expect(text).toContain('5. write module 5');
    expect(text).not.toContain('1. write module 4');
  });

  it('uses `content` and never `activeForm` — an instruction wants the imperative', () => {
    const text = buildContinuationMessage(listOf(['in_progress', 'pending']));
    expect(text).toContain('write module 1');
    expect(text).not.toContain('writing module 1');
  });

  it('handles a one-item remainder without a stray blank line', () => {
    const text = buildContinuationMessage(listOf(['completed', 'in_progress']));
    expect(text.split('\n')).toHaveLength(3);
    expect(text).not.toContain('\n\n');
  });

  it('stays under ~2 kB for the largest list the store can hold', () => {
    // `TODO_LIMITS.maxItems` items of `contentChars` each, plus two fixed lines.
    const items: TodoItem[] = Array.from({ length: TODO_LIMITS.maxItems }, () => ({
      content: 'x'.repeat(TODO_LIMITS.contentChars),
      activeForm: 'y'.repeat(TODO_LIMITS.activeFormChars),
      status: 'pending' as const,
    }));
    const text = buildContinuationMessage({
      items,
      total: items.length,
      doneCount: 0,
      activeIndex: 0,
      updatedAt: 0,
    });
    expect(text.length).toBeLessThan(2200);
  });

  it('is ASCII for an ASCII plan (C-4)', () => {
    const text = buildContinuationMessage(listOf(['pending', 'pending']));
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[^\x00-\x7f]/);
  });

  it('passes item text through verbatim, including non-ASCII', () => {
    // The C-4 obligation is on the strings THIS MODULE writes. Item text is the
    // model's, the prompt tells it to answer in the user's language, and
    // mangling it here would corrupt the instruction rather than protect a
    // terminal — this string goes to the model, not to the screen.
    const snap = listOf(['pending']);
    snap.items[0]!.content = '写一个解析器';
    expect(buildContinuationMessage(snap)).toContain('1. 写一个解析器');
  });
});
