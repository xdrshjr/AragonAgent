/**
 * `normalizeTodos` — pure repair of whatever arrived in a `todo_write` call, or
 * of whatever a session file happened to contain (todo-plan-execution §3.4).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * MODELLED ON `team/normalize.ts`, INCLUDING THE REASON IT EXISTS. The JSON
 * Schema declares SHAPE, not POLICY (C-8): `ajv` is an OPTIONAL dependency of
 * `@aragon-agent/core`, so a schema-level `maxItems` / `enum` would REJECT a
 * payload where it is installed and let the identical payload through to here
 * where it is not. One design, two behaviours, selected by whether an optional
 * install step succeeded. Every bound therefore lives in the tool's
 * `description` (which is what the model reads) and is enforced here (which is
 * deterministic and unit-tested).
 *
 * REPAIR, NEVER REJECT. Zero survivors is the caller's single hard failure.
 * NEVER THROWS.
 *
 * THE LAST TWO RULES ARE THE FEATURE, not defensive tidying. "Exactly one item
 * at a time" (R-b) is made a property of the STORED STATE rather than a request
 * in a prompt, which is what lets the panel render an unconditional "current
 * step" with no null branch and lets a unit test prove the property instead of
 * an operator inferring it from a transcript.
 */

import { TODO_LIMITS } from './limits.js';
import type { TodoItem, TodoStatus } from './types.js';

export interface NormalizeResult {
  items: TodoItem[];
  /** How many entries the payload contained BEFORE dropping and capping. */
  requested: number;
  /** Human-readable repair notes, already bounded. Empty when nothing was wrong. */
  repairs: string[];
}

const STATUSES: ReadonlySet<string> = new Set<TodoStatus>([
  'pending',
  'in_progress',
  'completed',
]);

/**
 * Collapse whitespace and clamp.
 *
 * SANITIZED AT STORE RATHER THAN AT RENDER, which is the argument
 * `sanitizeActivity` records one subsystem over: a newline inside a rail row
 * would break the layout, and doing it here means the transcript card, the
 * headless writer and `/todo status` all inherit the guarantee for free.
 */
function clean(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

export function normalizeTodos(raw: unknown, max: number): NormalizeResult {
  if (!Array.isArray(raw)) return { items: [], requested: 0, repairs: [] };

  const requested = raw.length;
  const repairs: string[] = [];
  const kept: TodoItem[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      dropped += 1;
      continue;
    }
    const src = entry as Record<string, unknown>;
    const content = clean(src.content, TODO_LIMITS.contentChars);
    // The one field with no repair: an item with nothing to say is not an item.
    if (content.length === 0) {
      dropped += 1;
      continue;
    }
    const activeForm = clean(src.activeForm, TODO_LIMITS.activeFormChars) || content;
    const status = (
      typeof src.status === 'string' && STATUSES.has(src.status) ? src.status : 'pending'
    ) as TodoStatus;
    kept.push({ content, activeForm, status });
  }

  if (dropped > 0) {
    repairs.push(
      `${dropped} ${dropped === 1 ? 'item was' : 'items were'} dropped: each needs a non-empty content string.`,
    );
  }

  // DROP FIRST, CAP SECOND — the ordering `normalizeSubagentSpecs` records:
  // capping first would let a blank entry consume a slot the model meant for
  // real work, and nothing would say so.
  const ceiling = Math.max(1, Math.min(Math.floor(max) || 1, TODO_LIMITS.maxItems));
  const items = kept.slice(0, ceiling);
  if (kept.length > ceiling) {
    // COUNTED OFF `kept`, NOT `requested`, because the two differ exactly when
    // the payload ALSO had unusable entries — and those were already reported
    // by the note above. `requested - ceiling` would charge the cap for them a
    // second time and, worse, name a number that is not true of any suffix:
    // "the last 5 were dropped" when the cap took 3 from the end and two blanks
    // came from the middle. The model reads these notes to correct itself, so
    // the arithmetic has to describe what actually happened.
    repairs.push(
      `${requested} items were sent; the last ${kept.length - ceiling} were dropped (maximum ${ceiling}).`,
    );
  }

  repairExactlyOneActive(items, repairs);
  return { items, requested, repairs };
}

/**
 * Enforce invariant I-3: exactly one item is `in_progress` whenever at least one
 * item is not `completed`.
 *
 * The promotion half deliberately fires on the INITIAL all-pending write. A
 * model that writes its plan and then starts step 1 is doing the right thing,
 * and the panel should say so on the first frame rather than one tool call
 * later.
 */
function repairExactlyOneActive(items: TodoItem[], repairs: string[]): void {
  const active: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.status === 'in_progress') active.push(i);
  }

  if (active.length > 1) {
    for (const index of active.slice(1)) {
      items[index] = { ...items[index]!, status: 'pending' };
    }
    repairs.push(
      `${active.length} items were marked in_progress; only the first was kept.`,
    );
    return;
  }

  if (active.length === 1) return;

  const firstUnfinished = items.findIndex((item) => item.status !== 'completed');
  if (firstUnfinished >= 0) {
    items[firstUnfinished] = { ...items[firstUnfinished]!, status: 'in_progress' };
  }
}
