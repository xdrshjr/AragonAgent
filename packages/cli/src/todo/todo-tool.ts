/**
 * `todo_write` — the ONLY writer of `TodoStore` (todo-plan-execution §3.3 /
 * §4.1).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * FULL-LIST REPLACEMENT, NO INCREMENTAL OPERATIONS (D-1). A delta protocol
 * (`todo_add` / `todo_complete`) lets the model's belief and the rendered panel
 * drift apart with nothing anywhere able to notice, and needs an id the model
 * must keep stable across calls - a field it will eventually get wrong. A full
 * replacement is idempotent, order-free and self-healing.
 *
 * THE SCHEMA DECLARES SHAPE, NOT POLICY (C-8): no `enum`, no `maxItems`, no
 * `minItems`, and `activeForm` is not `required`. `ajv` is an OPTIONAL
 * dependency of core, so any of those would reject a payload where it happens to
 * be installed and repair the identical payload where it is not.
 *
 * PURE STATE: no filesystem, no network, no child process, no human wait. It
 * therefore must NOT be routed through `withPausedWatchdog` (C-9) -
 * `IdleWatchdog.pause()` is a boolean rather than a counter, so a nested
 * pause/resume around an instant call would re-arm the watchdog inside an outer
 * human wait.
 */

import { errorResult, textResult, type AgentTool, type ToolResult } from '@aragon-agent/core';
import { TODO_LIMITS } from './limits.js';
import type { TodoStore } from './store.js';

export interface TodoToolDeps {
  store: TodoStore;
  /** Read LIVE, never cached: `/todo off` flips this; it cannot unregister (C-1). */
  isEnabled: () => boolean;
}

/**
 * Turned off mid-session. A NON-ERROR result on purpose: the user turned a
 * display off, the model did nothing wrong, and an error result invites a retry.
 */
export const TODO_OFF_REFUSAL =
  'Todo planning is off for this session. Just do the work and say what you did.';

/** The structural half of R-c: a one-step list is not a plan. */
export const TOO_SMALL_REFUSAL =
  'A one-step list is not a plan. Just do the work and summarize when you are done.';

/**
 * The model-facing description. Deliberately close to Claude Code's `TodoWrite`
 * (R-f): what a model already knows about that tool transfers directly, and a
 * model's priors are worth more than our naming taste - the same argument
 * `team/task-tool.ts` records for mirroring `Task`.
 */
const TODO_WRITE_DESCRIPTION =
  'Record and update the plan for a multi-step task. Send the complete list every time - ' +
  'this tool replaces the whole list. Use it for work with three or more distinct steps, ' +
  'and skip it entirely for anything you can finish in one or two. Exactly one item may be ' +
  '`in_progress`; mark an item `completed` and the next one `in_progress` in the same call, ' +
  `the moment the step is done. At most ${TODO_LIMITS.maxItems} items; extras are dropped, so ` +
  'keep within it. This list is how the user follows a long task, so keep it current.';

export function createTodoTool(deps: TodoToolDeps): AgentTool {
  return {
    name: 'todo_write',
    label: 'Update todos',
    description: TODO_WRITE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'The COMPLETE list, every time. This replaces the previous list; there is ' +
            'no add or update operation.',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description:
                  `Imperative, <= ${TODO_LIMITS.contentChars} chars. What the step is. ` +
                  'e.g. "Add the rail to AppShell".',
              },
              activeForm: {
                type: 'string',
                description:
                  `Present continuous, <= ${TODO_LIMITS.activeFormChars} chars, shown while ` +
                  'this step is in progress. e.g. "Adding the rail to AppShell".',
              },
              status: {
                type: 'string',
                description:
                  'pending | in_progress | completed. Exactly one item may be in_progress.',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },

    async execute(_id, params): Promise<ToolResult> {
      // 1. Turned off mid-session. The tool array is immutable for the life of
      //    the session (C-1), so `/todo off` cannot unregister - it flips this
      //    closure instead.
      if (!deps.isEnabled()) {
        deps.store.reject(TODO_OFF_REFUSAL);
        return textResult(TODO_OFF_REFUSAL);
      }

      const todos = (params as { todos?: unknown }).todos;

      // 2. GATED ON AN EMPTY STORE, and that gate is the whole subtlety.
      //    Shrinking an EXISTING list to one item is legitimate - the model
      //    merged two steps - so the guard must fire only on a fresh plan.
      if (
        deps.store.isEmpty() &&
        Array.isArray(todos) &&
        todos.length < TODO_LIMITS.minFreshItems
      ) {
        deps.store.reject(TOO_SMALL_REFUSAL);
        return textResult(TOO_SMALL_REFUSAL);
      }

      // 3. Repair, never reject. Zero survivors is the single hard failure, and
      //    it leaves the previous list untouched (AC-9).
      const result = deps.store.write(todos);
      if (result.items.length === 0) {
        return errorResult('No usable todo items: each needs a non-empty content string.');
      }

      return textResult(buildResultText(result.items, result.repairs));
    },
  };
}

/**
 * The tool result — THE SINGLE STRONGEST LEVER ON R-b ("one at a time"), because
 * unlike the system prompt it is re-read on every single call. There is
 * deliberately NO RATE LIMIT to compete with it: a cap would fire exactly when
 * the model is being most diligent and produce a refusal it cannot act on, and
 * the costs a cap would have contained are already gone (§3.8 collapses N calls
 * into ONE transcript entry, and the store is memory-only).
 */
function buildResultText(
  items: { content: string; activeForm: string; status: string }[],
  repairs: string[],
): string {
  const done = items.filter((item) => item.status === 'completed').length;
  const activeIndex = items.findIndex((item) => item.status === 'in_progress');
  const lines = [`Todos updated. ${done}/${items.length} done.`];

  if (activeIndex >= 0) {
    lines.push(`In progress: ${items[activeIndex]!.activeForm}`);
    const next = items.slice(activeIndex + 1).find((item) => item.status === 'pending');
    if (next) lines.push(`Next: ${next.content}`);
    lines.push(
      'Call todo_write again the moment that item is finished - exactly one item in',
      'progress at a time, and do not batch several completions into one call.',
    );
  } else {
    lines.push('Every item is complete. Tell the user what you did.');
  }

  for (const repair of repairs) lines.push(`Note: ${repair}`);
  return lines.join('\n');
}
