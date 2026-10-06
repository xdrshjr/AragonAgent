/**
 * Last-column safety of the frame differ (tui-scrollbar-edge-and-run-row §3.1).
 *
 * The unified scrollbar paints the LAST terminal column of every viewport row.
 * Terminals whose cursor stays on column N after writing it (a pending-wrap flag
 * instead of a virtual column N+1) erase that cell when the differ appends
 * `CSI K`. The fix is to omit the EL for rows that already fill the line; these
 * cases drive the REAL differ into a VT model of both terminal families.
 */

import { describe, expect, it } from 'vitest';
import { createFrameDiffer, eraseLinesPrefix } from '../ui/frame-differ.js';
import { createVtScreen, type PendingWrapModel } from './helpers/vt-screen.js';

const CSI = '\x1b[';
const ROWS = 12;
const COLS = 24;
const HEIGHT = ROWS - 1;
const TRACK = '│';
const THUMB = '█';
const MODELS: PendingWrapModel[] = ['at-last-column', 'virtual-column'];

/** A viewport row exactly `COLS` wide ending in the scrollbar cell. */
function viewportRow(text: string, edge: string): string {
  return `${text.padEnd(COLS - 1, ' ').slice(0, COLS - 1)}${CSI}2m${edge}${CSI}0m`;
}

function frame(step: number): string[] {
  return Array.from({ length: HEIGHT }, (_, row) => {
    if (row === 0) return 'header'; // chrome rows are not full width
    const thumb = row - 1 >= step % 8 && row - 1 < (step % 8) + 3;
    return viewportRow(`line ${row} step ${step} ${'x'.repeat(step % 5)}`, thumb ? THUMB : TRACK);
  });
}

function chunk(lines: string[], previousCount: number): string {
  return eraseLinesPrefix(previousCount === 0 ? 0 : previousCount + 1) + `${lines.join('\n')}\n`;
}

function run(model: PendingWrapModel, withCols: boolean): string[][] {
  const screen = createVtScreen(ROWS, COLS, model);
  const differ = createFrameDiffer({
    sync: false,
    rows: () => ROWS,
    ...(withCols ? { cols: () => COLS } : {}),
  });
  const snapshots: string[][] = [];
  const first = frame(0);
  differ.transform(`${first.join('\n')}\n`); // seed write: passed through, not repainted
  const steps = [0, 1, 2, 3, 4, 5, 6];
  for (const step of steps) {
    const lines = frame(step);
    const out = differ.transform(chunk(lines, step === 0 ? HEIGHT : HEIGHT));
    if (out !== null) screen.write(out);
    snapshots.push(Array.from({ length: HEIGHT }, (_, row) => screen.cell(row, COLS - 1)));
  }
  return snapshots;
}

describe('frame differ - last column survives incremental repaints (T1/T2)', () => {
  for (const model of MODELS) {
    it(`keeps the scrollbar cell on every viewport row (${model})`, () => {
      const snapshots = run(model, true);
      snapshots.forEach((cells, index) => {
        for (let row = 1; row < HEIGHT; row += 1) {
          expect(cells[row], `step ${index} row ${row}`).toMatch(/[│█]/);
        }
      });
    });
  }

  it('erases the last column without the fix on an at-last-column terminal (baseline)', () => {
    // Without `cols` the differ keeps the old behaviour and appends CSI K to every
    // row, which this model turns into a blank last cell. This is what proves the
    // two tests above can fail.
    const snapshots = run('at-last-column', false);
    const blanked = snapshots.some((cells) => cells.slice(1).some((cell) => cell === ' '));
    expect(blanked).toBe(true);
  });

  it('parks the cursor on row H+1 after every batch', () => {
    const screen = createVtScreen(ROWS, COLS, 'at-last-column');
    const differ = createFrameDiffer({ sync: false, rows: () => ROWS, cols: () => COLS });
    differ.transform(`${frame(0).join('\n')}\n`);
    screen.write(differ.transform(chunk(frame(0), HEIGHT))!);
    screen.write(differ.transform(chunk(frame(1), HEIGHT))!);
    expect(screen.cursorRow()).toBe(HEIGHT);
  });
});
