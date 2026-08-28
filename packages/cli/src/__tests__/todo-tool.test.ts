/**
 * `todo_write`, the prompt block, and the controller surface
 * (AC-9..AC-13, AC-30, AC-34, AC-37, AC-42).
 */

import { describe, expect, it } from 'vitest';
import { createTodoTool, TODO_OFF_REFUSAL, TOO_SMALL_REFUSAL } from '../todo/todo-tool.js';
import { TodoStore } from '../todo/store.js';
import { buildTodoBlock } from '../todo/prompt.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { ToolResult } from '@aragon-agent/core';

const ctx = {} as never;

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function setup(enabled = true): { store: TodoStore; call: (todos: unknown) => Promise<ToolResult> } {
  const store = new TodoStore(() => 1);
  const tool = createTodoTool({ store, isEnabled: () => enabled });
  return { store, call: (todos: unknown) => tool.execute('1', { todos }, ctx) };
}

const THREE = [
  { content: 'Read the reducer', status: 'completed' },
  { content: 'Design the store', activeForm: 'Designing the store', status: 'in_progress' },
  { content: 'Add the panel-rows unit test', status: 'pending' },
];

describe('todo_write', () => {
  it('AC-9: a non-array payload is the one hard failure and changes nothing', async () => {
    const { store, call } = await setup();
    await call(THREE);
    const before = store.snapshot();
    const result = await call('nope');
    expect(result.isError).toBe(true);
    expect(store.snapshot()).toEqual(before);
  });

  it('AC-10: a fresh one-item list is REFUSED, without an error result', async () => {
    // Non-error on purpose: the model did nothing wrong, and an error invites a
    // retry of a call that will be refused identically.
    const { store, call } = setup();
    const result = await call([{ content: 'just do it', status: 'pending' }]);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe(TOO_SMALL_REFUSAL);
    expect(store.isEmpty()).toBe(true);
  });

  it('AC-11: the SAME one-item list commits against a non-empty store', async () => {
    // Shrinking an existing list to one item is legitimate — the model merged
    // two steps — so the guard is gated on `store.isEmpty()` and not on length
    // alone. This is the structural half of R-c, and its subtlety.
    const { store, call } = setup();
    await call(THREE);
    const result = await call([{ content: 'merged step', status: 'pending' }]);
    expect(text(result)).toContain('Todos updated');
    expect(store.snapshot()!.total).toBe(1);
  });

  it('AC-12: the result names the in-progress item and the next pending one', async () => {
    const { call } = setup();
    const result = await call(THREE);
    const out = text(result);
    expect(out).toContain('1/3 done');
    expect(out).toContain('In progress: Designing the store');
    expect(out).toContain('Next: Add the panel-rows unit test');
    // The single strongest lever on R-b, because unlike the system prompt it is
    // re-read on every call.
    expect(out).toContain('do not batch');
  });

  it('reports repairs as Note: lines so the model can correct itself', async () => {
    const { call } = setup();
    const many = Array.from({ length: 23 }, (_, i) => ({ content: `s${i}`, status: 'pending' }));
    expect(text(await call(many))).toContain('Note: 23 items were sent');
  });

  it('says so plainly when every item is complete', async () => {
    const { call } = setup();
    const out = text(await call([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ]));
    expect(out).toContain('2/2 done');
    expect(out).toContain('Every item is complete');
    expect(out).not.toContain('In progress:');
  });

  it('refuses with a non-error result when planning was turned off mid-session', async () => {
    const { store, call } = setup(false);
    const result = await call(THREE);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe(TODO_OFF_REFUSAL);
    expect(store.isEmpty()).toBe(true);
  });

  it('AC-13: never rejects, never throws, and reaches no I/O module', async () => {
    // The BEHAVIOURAL half: every shape a model can send resolves to a result.
    const { call } = setup();
    for (const payload of [undefined, null, 'x', 42, [], [null], [{}], THREE]) {
      await expect(call(payload)).resolves.toBeDefined();
    }

    // The STRUCTURAL half. The tool's only dependency is a store that itself has
    // no I/O and no timers (§3.5), so there is nothing for a throwing fake to be
    // injected INTO; the property is instead that nothing in `src/todo/**`
    // imports an I/O module at all. Asserted on import specifiers rather than on
    // a source scan, which would false-positive on the word `execute`.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = new URL('../todo/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(join(dir, file), 'utf-8');
      for (const forbidden of ['node:fs', 'node:child_process', 'node:net', 'node:https']) {
        expect(source, `${file} imports ${forbidden}`).not.toContain(`'${forbidden}'`);
      }
    }
  });

  it('C-8: the schema declares SHAPE only - no enum, maxItems or minItems', async () => {
    // `ajv` is an OPTIONAL dependency of core, so any of those would REJECT a
    // payload where it installed and REPAIR the identical payload where it did
    // not: one design, two behaviours, selected by an optional install step.
    const json = JSON.stringify(
      createTodoTool({ store: new TodoStore(() => 1), isEnabled: () => true }).parameters,
    );
    expect(json).not.toContain('enum');
    expect(json).not.toContain('maxItems');
    expect(json).not.toContain('minItems');
    // ...and `activeForm` is not required, because a missing one is repaired.
    expect(json).toContain('"required":["content","status"]');
  });

  it('quotes the item cap in the description, which is what the model reads', () => {
    const tool = createTodoTool({ store: new TodoStore(() => 1), isEnabled: () => true });
    expect(tool.description).toContain(`At most ${TODO_LIMITS.maxItems} items`);
  });
});

describe('buildTodoBlock (AC-42)', () => {
  const visible = buildTodoBlock({ panelVisible: true });
  const hidden = buildTodoBlock({ panelVisible: false });

  it('never claims a panel the session does not have', () => {
    expect(visible).toContain('panel');
    expect(visible).toContain('beside');
    expect(hidden.toLowerCase()).not.toContain('panel');
    expect(hidden.toLowerCase()).not.toContain('beside');
  });

  it('the two variants differ in EXACTLY ONE SENTENCE', () => {
    // The rest of the block was written to talk about "the list" rather than
    // "the panel" precisely so this is checkable instead of approximate.
    const sentences = (block: string): string[] =>
      block.replace(/\s+/g, ' ').split(/(?<=[.;])\s+/);
    const a = sentences(visible);
    const b = sentences(hidden);
    expect(a).toHaveLength(b.length);
    expect(a.filter((s, i) => s !== b[i])).toHaveLength(1);
  });

  it('states the 3-step threshold and the do-NOT-use list', () => {
    // The block's threshold is deliberately STRICTER than the structural guard
    // (`minFreshItems`, 2): a backstop looser than the guidance never argues
    // with a judgement call the model made on purpose.
    expect(visible).toContain('three or more distinct steps');
    expect(visible).toContain('Do NOT use it for:');
    expect(visible).toContain('one or two steps');
  });

  it('is ASCII only and stays within its per-turn budget', () => {
    // ASCII because it reaches a model that may be running in a `cmd.exe`
    // terminal, and because `src/todo/**` is inside the glyph scanner's scope.
    // eslint-disable-next-line no-control-regex
    expect(visible.match(/[^\x00-\x7f]/g)).toBeNull();
    // Bounded because it is paid for on EVERY turn of every todo-enabled
    // session. The number is the block as designed plus a little headroom, not
    // an aspiration: it exists so that adding a paragraph is a decision someone
    // has to make on purpose.
    expect(visible.length).toBeLessThan(1600);
  });
});
