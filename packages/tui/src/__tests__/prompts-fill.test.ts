/**
 * The fill rule table (quick-prompt-library D-6 / §4.6 / AC-17 / AC-18 / AC-19).
 *
 * EVERY CELL OF THE TABLE IS ASSERTED, because this function is where "the user's own
 * words survive" is decided. It also asserts the ABSENCE of a field: v1 of the design
 * returned `resultingBuffer`, which is a second authority over a draft only the reducer
 * can measure (I-7) - `Object.keys` is what keeps it from creeping back.
 */

import { describe, expect, it } from 'vitest';
import { planPromptFill, promptLineCount } from '../model/prompts/fill.js';

const BODY = 'line 1\nline 2';

describe('planPromptFill: replace vs insert', () => {
  it('replaces an empty draft even in insert mode, with the caret at the end', () => {
    const plan = planPromptFill({ draft: '', cursor: 0, content: BODY });
    expect(plan).toEqual({ mode: 'replace', text: BODY, cursor: BODY.length });
  });

  it('treats a whitespace-only draft as empty', () => {
    expect(planPromptFill({ draft: '  \n ', cursor: 3, content: BODY }).mode).toBe('replace');
  });

  it('honours insertMode=replace over a non-empty draft', () => {
    const plan = planPromptFill({ draft: 'mine', cursor: 4, content: BODY, mode: 'replace' });
    expect(plan).toEqual({ mode: 'replace', text: BODY, cursor: BODY.length });
  });

  it('inserts after the caret with one blank line when the caret is at the end', () => {
    const plan = planPromptFill({ draft: 'mine', cursor: 4, content: BODY });
    expect(plan).toEqual({ mode: 'insert', text: `\n\n${BODY}`, cursor: 6 });
  });

  it('inserts before the caret with one blank line when the caret is at the start', () => {
    const plan = planPromptFill({ draft: 'mine', cursor: 0, content: BODY });
    expect(plan.mode).toBe('insert');
    expect(plan.text).toBe(`${BODY}\n\n`);
    expect(plan.cursor).toBe(0);
  });

  it('inserts in the middle with separators on both sides', () => {
    const plan = planPromptFill({ draft: 'ab', cursor: 1, content: BODY });
    expect(plan.text).toBe(`\n\n${BODY}\n\n`);
    expect(plan.cursor).toBe(3);
  });

  it('does not add a third newline next to an existing blank line', () => {
    const plan = planPromptFill({ draft: 'mine\n\n', cursor: 6, content: BODY });
    expect(plan.text).toBe(BODY);
    expect(plan.text.startsWith('\n')).toBe(false);
  });

  it('never returns a resulting buffer (I-7: the reducer is the only authority)', () => {
    const plan = planPromptFill({ draft: 'x', cursor: 1, content: BODY });
    expect(Object.keys(plan).sort()).toEqual(['cursor', 'mode', 'text']);
    expect(plan).not.toHaveProperty('resultingBuffer');
  });
});

describe('promptLineCount', () => {
  it('counts an eight-line body as eight, for the acknowledgement', () => {
    expect(promptLineCount(Array.from({ length: 8 }, (_u, at) => `l${at}`).join('\n'))).toBe(8);
    expect(promptLineCount('one line')).toBe(1);
  });
});
