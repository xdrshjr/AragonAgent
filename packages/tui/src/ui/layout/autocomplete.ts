export interface AutocompleteLayoutInput {
  itemCount: number;
  selected: number;
  maxRows?: number;
  maxHeight?: number;
}

export interface AutocompleteLayout {
  start: number;
  count: number;
  moreBelow: number;
  showMore: boolean;
  rowCount: number;
}

/** Window suggestions within a total row budget including borders and footer.
 * Only omitted maxHeight is unlimited. Explicit invalid numbers become zero.
 * Selection is clamped to the available items; no input is mutated or rejected.
 */
export function buildAutocompleteLayout(input: AutocompleteLayoutInput): AutocompleteLayout {
  const total = nonNegativeInt(input.itemCount);
  const maxRows = input.maxRows === undefined ? 6 : nonNegativeInt(input.maxRows);
  const height = input.maxHeight === undefined ? Infinity : nonNegativeInt(input.maxHeight);
  if (total === 0 || maxRows === 0 || height < 3) {
    return { start: 0, count: 0, moreBelow: 0, showMore: false, rowCount: 0 };
  }
  const selected = Math.min(total - 1, nonNegativeInt(input.selected));
  let count = Math.min(total, maxRows, height - 2);
  const windowStart = () => Math.max(0, Math.min(selected - count + 1, total - count));
  let start = windowStart();
  if (count >= 2 && start + count < total && count + 3 > height) {
    count--;
    start = windowStart();
  }
  const moreBelow = total - start - count;
  const showMore = moreBelow > 0 && count + 3 <= height;
  return { start, count, moreBelow, showMore, rowCount: 2 + count + Number(showMore) };
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
