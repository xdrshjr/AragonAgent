/**
 * The status bar's kit chip: pure width planning, no JSX
 * (agent-model-kits §4.8 / D-12).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY A PLANNER, AND WHY IT IS THE SAME SHAPE AS `session-chip.ts`: the status
 * row is measured cell by cell, and anything appended "just to the right" eats
 * `phase` - the one field a user needs while a run is in flight. The chip
 * therefore competes for the SAME budget as every other field, and the rung that
 * survives is computed rather than hand-tuned.
 *
 * ONE COMPARISON, NOT A THRESHOLD TABLE: `columns - (cells + gap) >=
 * minStatusCells`. The width table in the spec is what that comparison WORKS
 * OUT TO. `minStatusCells` is deliberately the same 34 as the session chip's -
 * both answer "how much room must the left half keep", and two numbers for one
 * question is how a "fit" and a "don't fit" end up disagreeing.
 */

import stringWidth from 'string-width';

export const KIT_CHIP_LIMITS = {
  /** Blank cells between the chip and the field run. */
  gapCells: 2,
  /** The floor the left half must keep; asserted equal to the session chip's. */
  minStatusCells: 34,
  /** Below this the `kit` label is dropped before the name is shortened. */
  labelMinCols: 72,
  /** The shortest unique prefix worth showing; below it the chip hides. */
  minNameChars: 4,
} as const;

export interface KitChipPlan {
  visible: boolean;
  text: string;
  cells: number;
  gap: number;
}

export interface KitChipInput {
  columns: number;
  /**
   * The kit in effect, or absent/null when there is none.
   *
   * ABSENT IS NOT EMPTY: with no kit the plan is hidden and the row's output is
   * byte-identical to the pre-feature build (I-9).
   */
  kit?: { name: string; modified: boolean; otherNames: readonly string[] } | null | undefined;
}

const HIDDEN: KitChipPlan = { visible: false, text: '', cells: 0, gap: 0 };

/** The shortest prefix of `name` that no sibling name also starts with. */
function uniqueLength(name: string, others: readonly string[]): number {
  const points = [...name];
  const start = Math.min(KIT_CHIP_LIMITS.minNameChars, points.length);
  const shared = (length: number): boolean => {
    const prefix = points.slice(0, length).join('');
    return others.some((other) => [...other].slice(0, length).join('') === prefix);
  };
  let length = start;
  while (length < points.length && shared(length)) length += 1;
  return Math.max(length, start);
}

/** Plan the chip for `columns` and this session's kit. */
export function planKitChip(input: KitChipInput): KitChipPlan {
  const kit = input.kit;
  if (!kit) return HIDDEN;
  const name = kit.name.trim();
  if (!name) return HIDDEN;
  const columns = Number.isFinite(input.columns) ? Math.floor(input.columns) : 80;
  const gap = KIT_CHIP_LIMITS.gapCells;
  const fits = (text: string): boolean =>
    columns - (stringWidth(text) + gap) >= KIT_CHIP_LIMITS.minStatusCells;
  const mark = kit.modified ? '~' : '';
  const plan = (text: string): KitChipPlan =>
    ({ visible: true, text, cells: stringWidth(text), gap });
  // Widest rung first, then drop the label, then shorten the name, then hide.
  // THE ORDER IS THE DECISION: a reader cares WHICH kit is in effect before they
  // care that it is a kit, so the name is the last thing to go.
  //
  // `KIT_CHIP_LIMITS.labelMinCols` NEEDS NO BRANCH: a labelled rung is 45 cells
  // for a 40-character name, so `fits` already rejects it below ~81 columns. The
  // constant is the documented intent (labels belong to wide rows), measured
  // rather than hard-coded into the ladder.
  const points = [...name];
  const shortest = uniqueLength(name, kit.otherNames);
  const rungs: string[] = [];
  if (kit.modified) rungs.push(`kit ${name}~`);
  rungs.push(`kit ${name}`);
  if (kit.modified) rungs.push(`${name}~`);
  rungs.push(name);
  for (let length = points.length - 1; length >= shortest; length -= 1) {
    rungs.push(`${points.slice(0, length).join('')}${mark}`);
  }
  for (const text of rungs) if (fits(text)) return plan(text);
  return HIDDEN;
}
