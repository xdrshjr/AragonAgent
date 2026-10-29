/**
 * The prompt picker's view model (quick-prompt-library §4.5).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * THE ROWS ARE COMPUTED OUTSIDE THE COMPONENT for the reason `kit-picker-state.ts`
 * records one surface over: the same library is rendered by two overlays and by
 * `/prompts list`, and three independent row builders is how "the manager says four
 * entries and the picker says five" becomes possible without a single failing test.
 */

import { PROMPT_PICKER_LIMITS } from '../../model/prompts/limits.js';
import { searchPrompts, viewOrder } from '../../model/prompts/search.js';
import type { PromptLibrary, PromptSortView } from '../../model/prompts/types.js';
import { formatAgo, formatCount } from './prompt-library-state.js';

export interface PromptPickerRow {
  id: string;
  /** 1-based position in the CURRENT view, i.e. the number `1`-`9` addresses. */
  index: number;
  title: string;
  tags: string[];
  favorite: boolean;
}

export interface PromptPickerInput {
  library: PromptLibrary;
  query: string;
  view: PromptSortView;
}

/**
 * Filter the library and number the result.
 *
 * THE VIEW IS APPLIED FIRST, THEN THE FILTER: searching inside `recent` must return
 * the recent order, not the manual one. Reversing the two would make `Ctrl+S` appear
 * to do nothing whenever a query is active - which is exactly when the user is
 * looking at the footer to see whether it worked.
 */
export function pickerRows(input: PromptPickerInput): PromptPickerRow[] {
  const ordered = viewOrder(input.library.prompts, input.view);
  return searchPrompts(ordered, input.query).map(({ prompt }, at) => ({
    id: prompt.id,
    index: at + 1,
    title: prompt.title,
    tags: prompt.tags ?? [],
    favorite: prompt.favorite === true,
  }));
}

/**
 * The block under the list: at most four rows, and never the whole body.
 *
 * The picker exists to CHOOSE. The full text belongs to the editor, and printing it
 * here would push the chosen row off the frame that has to show it.
 */
export function pickerDetail(
  row: PromptPickerRow | undefined,
  library: PromptLibrary,
  now: number = Date.now(),
): string[] {
  if (!row) return [];
  const prompt = library.prompts.find((entry) => entry.id === row.id);
  if (!prompt) return [];
  const lines = [
    `${formatCount([...prompt.content].length)} chars, `
      + `${prompt.content.split('\n').length} lines, ${formatAgo(prompt.lastUsedAt, now)}`,
  ];
  if ((prompt.tags ?? []).length > 0) lines.push((prompt.tags ?? []).map((t) => `#${t}`).join(' '));
  const firstLine = prompt.content.split('\n')[0] ?? '';
  if (firstLine.length > 0) lines.push(firstLine);
  if (prompt.description !== undefined) lines.push(prompt.description);
  return lines.slice(0, PROMPT_PICKER_LIMITS.detailMaxLines);
}

/**
 * The empty-library guidance (AC-23).
 *
 * IT NAMES TWO WAYS OUT, because the picker is reachable from two directions: the
 * user who typed `/prompts` on an empty library can press `a` here, and the user who
 * does not want to type can press `Ctrl+P` later. Naming only one of them leaves the
 * other audience pressing a key that does nothing.
 */
export const NO_PROMPTS_HINT =
  'No prompts yet. Press Ctrl+P to create one, or a to add one here.';

/**
 * The footer, ordered by WHICH PATH SURVIVES ON THE WORST TERMINAL (§9.11).
 *
 * `Enter fill` comes before `^Enter fill & send` because a terminal without keyboard
 * enhancement delivers `Ctrl+Enter` as a plain `Enter`: the reader who works left to
 * right must meet the path that always works first. `tab manage` sits after the two
 * fill actions for the same reason - it is navigation, not the point of the screen.
 */
export function pickerHint(input: {
  count: number;
  query: string;
  view: PromptSortView;
}): string {
  if (input.count === 0) {
    return input.query.length > 0
      ? 'No match | Backspace to widen | Esc close'
      : `${NO_PROMPTS_HINT} Esc close`;
  }
  return 'Enter fill | ^Enter fill & send | 1-9 pick | '
    + `^S sort: ${input.view} | tab manage | Esc close`;
}

/**
 * The `1`-`9` shortcut, or `null`.
 *
 * A DIGIT IS ONLY A SHORTCUT WHILE THE QUERY IS EMPTY. Otherwise `3` is the third
 * character of what the user is searching for, and stealing it would make numeric
 * queries impossible to type - so the guard is the emptiness of the query, not the
 * shape of the key.
 */
export function pickerDigitTarget(rows: readonly PromptPickerRow[], input: string): string | null {
  if (input.length !== 1) return null;
  const digit = input.charCodeAt(0) - 48;
  if (digit < 1 || digit > PROMPT_PICKER_LIMITS.quickDigits) return null;
  return rows[digit - 1]?.id ?? null;
}
