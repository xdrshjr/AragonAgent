/**
 * The acceptance-criteria model (todo-acceptance-criteria §6.2 / §6.3 / §6.6.2).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * PURE: no I/O, no timers, no `Date.now()`. The clock is injected where a
 * timestamp is needed, exactly as `TodoStore`'s constructor does (P2-4).
 *
 * ONE PRINCIPLE RUNS THROUGH THE WHOLE FILE, and it is the reason this module
 * exists: **a verdict is evidence, a plan is a belief**. A verdict is never
 * destroyed by omission - not by re-sending the criterion as `pending`, and not
 * by leaving it out of the list altogether - because a full replacement means the
 * model re-sends the whole table on every turn and one lapse would silently erase
 * a conclusion the user was shown. An unchecked criterion, by contrast, IS a
 * plan, so a re-plan is free to drop it.
 *
 * NEVER THROWS, NEVER REJECTS, ONLY REPAIRS (I-9): the same discipline
 * `normalize.ts` records for the todo list itself.
 */

import { ACCEPT_LIMITS, VERIFY_MESSAGE_LIMITS } from './limits.js';
import type {
  AcceptanceItem,
  AcceptanceSnapshot,
  AcceptanceStatus,
  PlanPhase,
  TodoItem,
  TodoSnapshot,
} from './types.js';

export interface NormalizeAcceptanceResult {
  items: AcceptanceItem[];
  /** How many entries the payload contained BEFORE dropping and capping. */
  requested: number;
  /** Human-readable repair notes, already bounded. Empty when nothing was wrong. */
  repairs: string[];
}

export interface NormalizeAcceptanceOptions {
  /** `todo.acceptance`, read LIVE (D-11). False short-circuits everything below. */
  enabled: boolean;
  /**
   * Per-lineage dedupe of the restoration note (§6.2.1 step 9 / P2-4).
   *
   * OWNED BY `TodoStore`, not by this module: the note would otherwise be
   * re-printed on every turn, because the model has no way to know the server
   * restored a verdict and would keep sending the same `pending` row. Passing the
   * set in keeps this function pure and keeps the dedupe state in the one object
   * that already owns the plan's lifetime.
   */
  restoredNotes?: Set<string>;
}

/**
 * Collapse whitespace and clamp.
 *
 * LOCAL RATHER THAN SHARED WITH `normalize.ts`: that module is not in this
 * feature's change plan (§7.2), and the whole helper is four lines. Sanitizing at
 * the store is the argument `normalize.ts::clean` records - a newline inside a
 * rail row breaks the layout - and doing it here means the transcript card, the
 * headless writer and `/todo status` all inherit the guarantee for free.
 */
function clean(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? collapsed.slice(0, maxChars) : collapsed;
}

/** The three states the MODEL may name. `in_progress` is store-owned (P0-1). */
const MODEL_STATUSES: ReadonlySet<string> = new Set<AcceptanceStatus>([
  'pending',
  'passed',
  'failed',
]);

const EMPTY: NormalizeAcceptanceResult = { items: [], requested: 0, repairs: [] };

/**
 * Repair whatever arrived in the `acceptance` field of a `todo_write` call.
 *
 * ORDER IS SEMANTICS, and one step of that order is load-bearing enough to be a
 * review condition (C-2): `enabled` short-circuits FIRST, then `undefined`, then
 * `Array.isArray`. `undefined` (the key is absent) and `[]` (the model sent an
 * empty array) are NOT the same thing: absent means "I am only updating steps,
 * keep the table", empty means "this plan needs no criteria". This is the one
 * place in the feature where the two differ (§9).
 */
export function normalizeAcceptance(
  raw: unknown,
  previous: readonly AcceptanceItem[],
  options: NormalizeAcceptanceOptions,
): NormalizeAcceptanceResult {
  // 1. The capability is off. STRONGEST SHORT-CIRCUIT: no data may survive it, or
  //    `/todo acceptance off` would look like it did nothing while the rail kept
  //    drawing an ACCEPT section (P0-2). No repair note either - the model
  //    sending an extra field it learned elsewhere is not its mistake, and a note
  //    would turn a harmless extra key into a wasted turn.
  if (!options.enabled) return { ...EMPTY, items: [] };

  // 2. The key is ABSENT: this turn is about the steps. Keep the table.
  if (raw === undefined) {
    return { items: [...previous], requested: previous.length, repairs: [] };
  }

  // 3. Not an array at all: nothing usable. Same disposition as `normalizeTodos`.
  if (!Array.isArray(raw)) return { ...EMPTY, items: [] };

  const requested = raw.length;
  const repairs: string[] = [];
  const kept: AcceptanceItem[] = [];

  for (const entry of raw) {
    const item = readItem(entry);
    if (!item) continue;
    kept.push(item);
  }

  const dropped = requested - kept.length;
  if (dropped > 0) {
    repairs.push(
      `${dropped} ${dropped === 1 ? 'criterion was' : 'criteria were'} dropped: each needs a non-empty content string.`,
    );
  }

  const verdicts = applyVerdictRules(kept, previous, options.restoredNotes, repairs);
  // AN EXPLICIT EMPTY ARRAY IS A STATEMENT, NOT AN OMISSION (§9): the model is saying
  // "this plan needs no criteria", so nothing is restored from the previous table.
  // Only a NON-empty replacement can be missing a row it did not mean to drop.
  const restored = requested === 0
    ? verdicts
    : restoreOmitted(verdicts, previous, options.restoredNotes, repairs);
  // STEP 11: `reopen` is CONSUMED, not stored. A table carrying it would put an input
  // flag into the snapshot, the session file and the transcript card, where nothing
  // reads it and everything would have to learn to ignore it.
  return { items: cap(restored, requested, repairs).map(withoutReopen), requested, repairs };
}

function withoutReopen(item: AcceptanceItem): AcceptanceItem {
  if (item.reopen === undefined) return item;
  const { reopen: _reopen, ...rest } = item;
  return rest;
}

/**
 * One payload entry, repaired. `null` means it is not a criterion at all.
 *
 * `in_progress` IS DOWNGRADED SILENTLY (P0-1): the store owns that state
 * (`TodoStore.write` re-derives it after every commit), the schema never offers
 * it, and a note would be re-printed on every turn for a model that keeps echoing
 * it. Downgrading produces exactly the same result as sending `pending`, which is
 * the idempotence we want.
 */
function readItem(entry: unknown): AcceptanceItem | null {
  if (!entry || typeof entry !== 'object') return null;
  const src = entry as Record<string, unknown>;
  const content = clean(src.content, ACCEPT_LIMITS.contentChars);
  // The one field with no repair: a criterion with nothing to say is not a
  // criterion.
  if (content.length === 0) return null;
  const status = (
    typeof src.status === 'string' && MODEL_STATUSES.has(src.status) ? src.status : 'pending'
  ) as AcceptanceStatus;
  const item: AcceptanceItem = {
    content,
    check: clean(src.check, ACCEPT_LIMITS.checkChars),
    status,
    evidence: clean(src.evidence, ACCEPT_LIMITS.evidenceChars),
  };
  // Carried just far enough for the verdict rules to see it; stripped again before
  // the table is returned (§6.2.1 step 11: the flag is input, never storage).
  if (src.reopen === true) item.reopen = true;
  return item;
}

/**
 * A verdict without evidence is not a verdict (D-3), and a verdict is not undone
 * by re-sending the same criterion as `pending` (D-4, first half).
 *
 * `reopen` is the only door back to `pending`, and it also clears the evidence:
 * re-opening a criterion means giving up what it claimed before.
 */
function applyVerdictRules(
  items: AcceptanceItem[],
  previous: readonly AcceptanceItem[],
  restoredNotes: Set<string> | undefined,
  repairs: string[],
): AcceptanceItem[] {
  const byContent = new Map<string, AcceptanceItem>();
  for (const prior of previous) {
    if (!byContent.has(prior.content)) byContent.set(prior.content, prior);
  }

  return items.map((item, index) => {
    if (item.status !== 'pending') {
      if (item.evidence.length > 0) return item;
      repairs.push(
        `criterion ${index + 1} had a verdict but no evidence; it is back to unchecked.`,
      );
      return { ...item, status: 'pending', evidence: '' };
    }

    // RE-OPENING IS THE ONE DELIBERATE WAY BACK TO UNCHECKED (D-4), and it also
    // forfeits the old evidence: a criterion being checked again has no verdict yet.
    if (item.reopen === true) return { ...item, evidence: '' };

    const prior = byContent.get(item.content);
    if (!prior || prior.status === 'pending') return item;
    noteOnce(
      restoredNotes,
      item.content,
      repairs,
      `criterion ${index + 1} kept its earlier verdict (a verdict is not undone by ` +
        'omission; send reopen: true to re-check it).',
    );
    return { ...item, status: prior.status, evidence: prior.evidence };
  });
}

/**
 * Record a restoration note AT MOST ONCE PER CRITERION (P2-4).
 *
 * The model does not know the server restored anything, so it sends the same row
 * again on the next turn. Without this the identical `Note:` is billed every turn,
 * for as long as the plan lives.
 */
function noteOnce(
  restoredNotes: Set<string> | undefined,
  content: string,
  repairs: string[],
  text: string,
): void {
  if (!restoredNotes) {
    repairs.push(text);
    return;
  }
  if (restoredNotes.has(content)) return;
  restoredNotes.add(content);
  repairs.push(text);
}

/**
 * D-4's OTHER HALF (P0-4): a criterion that is MISSING from a full replacement
 * keeps its verdict too.
 *
 * The commonest shape of "omission" is not a re-sent `pending` row, it is a
 * table that is one row shorter - and without this the criterion, its verdict and
 * its evidence all disappear while `total` silently shrinks (`4/5` becomes
 * `3/4` and nothing says so).
 *
 * Restored rows go to the TAIL, which is also where `cap` starts cutting, so a
 * re-plan that grows past the ceiling loses restored rows rather than the model's
 * newest intent. An UNCHECKED omitted criterion is dropped on purpose: that is a
 * plan, not a verdict.
 */
function restoreOmitted(
  items: AcceptanceItem[],
  previous: readonly AcceptanceItem[],
  restoredNotes: Set<string> | undefined,
  repairs: string[],
): AcceptanceItem[] {
  if (previous.length === 0) return items;
  const present = new Set(items.map((item) => item.content));
  const restored = [...items];

  for (const prior of previous) {
    if (present.has(prior.content) || prior.status === 'pending') continue;
    present.add(prior.content);
    restored.push({
      content: prior.content,
      check: prior.check,
      status: prior.status,
      evidence: prior.evidence,
    });
    // ALWAYS RESTORED; the NOTE is what is deduped, never the restoration itself.
    noteOnce(
      restoredNotes,
      prior.content,
      repairs,
      `criterion ${restored.length} was missing from the list but had a verdict; it was kept ` +
        'with its evidence (send reopen: true to re-check it).',
    );
  }

  return restored;
}

/**
 * DROP FIRST AND CAP SECOND would be wrong here, and the ORDER is reversed on
 * purpose: restored rows sit at the tail exactly so that this `slice` takes them
 * before it takes anything the model just sent.
 */
function cap(items: AcceptanceItem[], requested: number, repairs: string[]): AcceptanceItem[] {
  const ceiling = ACCEPT_LIMITS.maxItems;
  if (items.length <= ceiling) return items;
  const dropped = items.length - ceiling;
  repairs.push(
    `${requested} criteria were sent; the last ${dropped} were dropped (maximum ${ceiling}).`,
  );
  return items.slice(0, ceiling);
}

/**
 * The immutable projection of one committed table (§6.2.2).
 *
 * CALLED FROM EXACTLY ONE PLACE PER COMMIT - `TodoStore`'s `write` / `restore` /
 * `clear` / `reopenAll` - and stored, never recomputed on read. `snapshot()` runs
 * on every event; recomputing here would stamp a new `now()` and a new object
 * each frame, invalidating `TodoCard`'s `React.memo` and the transcript's height
 * cache (P1-3).
 */
export function acceptanceSummary(
  items: readonly AcceptanceItem[],
  now: () => number,
): AcceptanceSnapshot {
  let passedCount = 0;
  let failedCount = 0;
  for (const item of items) {
    if (item.status === 'passed') passedCount += 1;
    else if (item.status === 'failed') failedCount += 1;
  }
  return {
    items: [...items],
    total: items.length,
    checkedCount: passedCount + failedCount,
    passedCount,
    failedCount,
    updatedAt: now(),
  };
}

/**
 * The ONE judge of "which phase is this plan in" (I-3 / D-5).
 *
 * Derived rather than stored, so the model, the rail, the transcript card and the
 * machine event stream cannot disagree: a stored field would be a second writer
 * of a fact that two lists already determine. Callers must not invoke this for a
 * `null` plan.
 */
export function derivePlanPhase(
  items: readonly TodoItem[],
  acceptance: readonly AcceptanceItem[] | null,
): PlanPhase {
  const allStepsDone = items.length > 0 && items.every((item) => item.status === 'completed');
  if (!allStepsDone) return 'work';
  if (!acceptance || acceptance.length === 0) return 'done';
  // "Unresolved" is `pending` and `in_progress`; the other two states of the
  // four-state model are already verdicts.
  const unresolved = acceptance.some(
    (item) => item.status === 'pending' || item.status === 'in_progress',
  );
  return unresolved ? 'verify' : 'done';
}

/**
 * "Is there nothing left to do in this plan" - THE single judge (G-4 / I-3).
 *
 * Referenced by follow-through, by `App`'s grace-window re-check and by
 * `TodoStore.beginUserTurn`, because "every step is completed" stopped being the
 * same claim as "the work is done" the moment acceptance criteria existed. Three
 * copies of the old equation is exactly how a plan gets cleared while its last
 * criterion is still unchecked.
 */
export function planIsResolved(
  items: readonly TodoItem[],
  acceptance: readonly AcceptanceItem[] | null,
): boolean {
  return items.length > 0 && derivePlanPhase(items, acceptance) === 'done';
}

export function countUnfinishedSteps(items: readonly TodoItem[]): number {
  let count = 0;
  for (const item of items) if (item.status !== 'completed') count += 1;
  return count;
}

export function countUncheckedCriteria(acceptance: readonly AcceptanceItem[] | null): number {
  if (!acceptance) return 0;
  let count = 0;
  for (const item of acceptance) {
    if (item.status === 'pending' || item.status === 'in_progress') count += 1;
  }
  return count;
}

/** What is left in a plan, as the two numbers the notices are written from. */
export interface Outstanding {
  steps: number;
  checks: number;
}

/**
 * The six follow-through exits all need "how much is left", and after this
 * feature that quantity has two halves (§6.6.1.1). One function decides it, so no
 * exit can print `0 steps left` on a plan whose steps are all done but whose
 * criteria are not - which is what `total - doneCount` would say on every verify
 * turn.
 */
export function outstandingOf(snapshot: TodoSnapshot): Outstanding {
  return {
    steps: countUnfinishedSteps(snapshot.items),
    checks: countUncheckedCriteria(snapshot.acceptance?.items ?? null),
  };
}

/**
 * Singular and plural decided in ONE place (§6.6.1.1): six call sites must not
 * each spell their own.
 */
export function criteriaPhrase(count: number): string {
  return count === 1 ? '1 acceptance criterion' : `${count} acceptance criteria`;
}

/**
 * A bounded enumeration of what a plan still owes, for the tool result text
 * (§6.3). Ordered `todoFirst` because the tool result is read top-down and the
 * step being worked on is the more urgent of the two when both exist.
 *
 * BOUNDED BY CONSTRUCTION at `VERIFY_MESSAGE_LIMITS.uncheckedItems` rows: this
 * string is paid for on every call (I-11).
 */
export function planOutstanding(
  items: readonly TodoItem[],
  acceptance: readonly AcceptanceItem[] | null,
  todoFirst: boolean,
): string[] {
  const steps = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== 'completed')
    .map(({ item, index }) => `${index + 1}. ${item.content}`);
  const checks = (acceptance ?? [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status === 'pending' || item.status === 'in_progress')
    .map(({ item, index }) => `${index + 1}. ${item.content}`);
  const limit = VERIFY_MESSAGE_LIMITS.uncheckedItems;
  return (todoFirst ? [...steps, ...checks] : [...checks, ...steps]).slice(0, limit);
}

/**
 * The continuation text for the verification phase (§6.6.2).
 *
 * CONSTRUCTIVELY BOUNDED, which is what AC-22 asserts: the unchecked list stops
 * at 5 rows, the failed list at 2, `check` is clipped to 100 characters and
 * `evidence` to 60. Both truncations are deliberate - the full text is already in
 * the model's own previous payload, so re-sending it is paying twice for the same
 * bytes; what the model needs is a reminder of WHICH rows are open.
 */
export function buildVerifyMessage(snapshot: TodoSnapshot): string {
  const criteria = snapshot.acceptance?.items ?? [];
  const unchecked = selectRows(
    criteria,
    (item) => item.status === 'pending' || item.status === 'in_progress',
    VERIFY_MESSAGE_LIMITS.uncheckedItems,
  );
  const failed = selectRows(
    criteria,
    (item) => item.status === 'failed',
    VERIFY_MESSAGE_LIMITS.failedItems,
  );

  const lines = ['Every step is complete. Verify the acceptance criteria one at a time.'];
  if (unchecked.rows.length > 0) {
    lines.push('Unchecked:');
    for (const { item, index } of unchecked.rows) {
      lines.push(`${index + 1}. ${item.content}`);
      const hint = clip(item.check, VERIFY_MESSAGE_LIMITS.checkChars);
      if (hint.length > 0) lines.push(`   check: ${hint}`);
    }
    if (unchecked.hidden > 0) lines.push(`   ... and ${unchecked.hidden} more`);
  }
  if (failed.rows.length > 0) {
    lines.push(`${failed.total} failed so far - fix those before claiming the work is done:`);
    for (const { item, index } of failed.rows) {
      lines.push(`${index + 1}. ${item.content}`);
      const seen = clip(item.evidence, VERIFY_MESSAGE_LIMITS.evidenceChars);
      if (seen.length > 0) lines.push(`   evidence: ${seen}`);
    }
  }
  lines.push('Check ONE, then call todo_write with that verdict and its evidence.');
  return lines.join('\n');
}

/**
 * The first `limit` matches, each carrying its 1-BASED position in the WHOLE
 * table: "step 5" must mean the same thing here as it does in the rail, which is
 * why the position is read from the full walk rather than from the filtered list.
 */
function selectRows(
  all: readonly AcceptanceItem[],
  keep: (item: AcceptanceItem) => boolean,
  limit: number,
): { rows: { item: AcceptanceItem; index: number }[]; total: number; hidden: number } {
  const rows: { item: AcceptanceItem; index: number }[] = [];
  let total = 0;
  for (let index = 0; index < all.length; index += 1) {
    const item = all[index]!;
    if (!keep(item)) continue;
    total += 1;
    if (rows.length < limit) rows.push({ item, index });
  }
  return { rows, total, hidden: Math.max(0, total - rows.length) };
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
