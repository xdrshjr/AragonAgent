/**
 * A minimal VT screen model — just the subset the frame differ and Ink emit.
 *
 * It exists to turn one belief about real terminals into a regression guard
 * (tui-scrollbar-edge-and-run-row §3.1.4). Writing the LAST column leaves the
 * cursor in a "pending wrap" state, and terminals disagree on what a following
 * `CSI K` (erase cursor → end of line) does there:
 *
 *  - `virtual-column`: the cursor is logically at column N+1, so EL erases an
 *    empty range (xterm.js and friends);
 *  - `at-last-column`: the cursor still sits on column N with a wrap flag, so EL
 *    erases the cell that was JUST written (Windows console hosts).
 *
 * The differ must leave the last column intact under BOTH.
 */

import stringWidth from 'string-width';

export type PendingWrapModel = 'at-last-column' | 'virtual-column';

export interface VtScreen {
  /** The visible text of row `row` (0-based), cells joined, wide-char tails dropped. */
  line(row: number): string;
  /** The cell at (`row`, `col`), 0-based; `' '` when blank. */
  cell(row: number, col: number): string;
  /** 0-based cursor row. */
  cursorRow(): number;
  write(data: string): void;
}

export function createVtScreen(rows: number, cols: number, model: PendingWrapModel): VtScreen {
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  let r = 0;
  let c = 0;
  let pending = false;

  const scrollUp = (): void => {
    grid.shift();
    grid.push(new Array<string>(cols).fill(' '));
  };
  const lineFeed = (): void => {
    if (r === rows - 1) scrollUp();
    else r += 1;
  };
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(max, value));

  const print = (glyph: string): void => {
    const width = Math.max(1, stringWidth(glyph));
    if (pending) {
      c = 0;
      pending = false;
      lineFeed();
    }
    if (c + width > cols) {
      c = 0;
      lineFeed();
    }
    grid[r]![c] = glyph;
    for (let k = 1; k < width; k += 1) grid[r]![c + k] = '';
    c += width;
    if (c >= cols) {
      pending = true;
      // The two models differ ONLY here and in `eraseToEol`.
      c = model === 'at-last-column' ? cols - 1 : cols;
    }
  };

  const eraseToEol = (): void => {
    const from = model === 'virtual-column' && pending ? cols : c;
    for (let k = from; k < cols; k += 1) grid[r]![k] = ' ';
  };

  const csi = (params: string, final: string): void => {
    if (params.startsWith('?')) return; // DEC private modes (2026, 25, ...) — no visible effect
    const nums = params.split(';').map((part) => (part === '' ? NaN : Number(part)));
    const first = Number.isNaN(nums[0]!) ? undefined : nums[0];
    switch (final) {
      case 'H':
      case 'f':
        r = clamp((first ?? 1) - 1, rows - 1);
        c = clamp((Number.isNaN(nums[1] ?? NaN) ? 1 : nums[1]!) - 1, cols - 1);
        pending = false;
        break;
      case 'G':
        c = clamp((first ?? 1) - 1, cols - 1);
        pending = false;
        break;
      case 'A':
        r = clamp(r - (first ?? 1), rows - 1);
        break;
      case 'K':
        if (first === 2) grid[r]!.fill(' ');
        else eraseToEol();
        break;
      case 'J':
        eraseToEol();
        for (let row = r + 1; row < rows; row += 1) grid[row]!.fill(' ');
        break;
      default:
        break; // SGR ('m') and anything else: no cell effect
    }
  };

  const write = (data: string): void => {
    const chars = Array.from(data);
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      if (ch === '\x1b' && chars[i + 1] === '[') {
        let j = i + 2;
        let params = '';
        while (j < chars.length && /[0-?]/.test(chars[j]!)) params += chars[j++];
        const final = chars[j] ?? '';
        csi(params, final);
        i = j;
      } else if (ch === '\r') {
        c = 0;
        pending = false;
      } else if (ch === '\n') {
        lineFeed();
        pending = false;
      } else if (ch >= ' ') {
        print(ch);
      }
    }
  };

  return {
    line: (row) => grid[row]!.join(''),
    cell: (row, col) => grid[row]![col] ?? ' ',
    cursorRow: () => r,
    write,
  };
}
