/**
 * The status bar's kit chip (agent-model-kits AC-31 / D-12 / I-9).
 *
 * THE FLOOR ASSERTION IS THE INTERESTING ONE: `minStatusCells` must equal the
 * session chip's, because both answer "how much room must the left half keep".
 * Two numbers for one question is how a chip and its neighbour end up disagreeing
 * about whether the row fits.
 */

import { describe, expect, it } from 'vitest';
import { KIT_CHIP_LIMITS, planKitChip } from '../ui/layout/kit-chip.js';
import { SESSION_CHIP_LIMITS } from '../ui/layout/session-chip.js';

const NAME = 'D'.repeat(40);
const named = (over: { modified?: boolean; otherNames?: string[] } = {}) =>
  ({ name: NAME, modified: over.modified ?? false, otherNames: over.otherNames ?? [] });

describe('AC-31: the ladder is computed, and the spec table is what it works out to', () => {
  it('keeps the label while the row is wide', () => {
    const plan = planKitChip({ columns: 120, kit: named() });
    expect(plan).toMatchObject({ visible: true, text: `kit ${NAME}` });
    expect(plan.cells).toBe(44);
  });

  it('drops the label at 79 columns, keeping the whole name', () => {
    const plan = planKitChip({ columns: 79, kit: named() });
    expect(plan).toMatchObject({ visible: true, text: NAME });
    expect(plan.cells).toBe(40);
  });

  it('shortens the name to the longest prefix that still fits', () => {
    const plan = planKitChip({ columns: 60, kit: named() });
    expect(plan.visible).toBe(true);
    // 60 - (cells + gap) >= 34  =>  cells <= 24.
    expect(plan.cells).toBe(24);
    expect(NAME.startsWith(plan.text)).toBe(true);
  });

  it('hides entirely rather than eating the left half', () => {
    expect(planKitChip({ columns: 39, kit: named() })).toEqual({ visible: false, text: '',
      cells: 0, gap: 0 });
  });

  it('counts the `~` it appends, so a drifted chip is never one cell too wide', () => {
    const clean = planKitChip({ columns: 120, kit: named() });
    const drifted = planKitChip({ columns: 120, kit: named({ modified: true }) });
    expect(drifted.text.endsWith('~')).toBe(true);
    expect(drifted.cells).toBe(clean.cells + 1);
    expect(drifted.gap).toBe(KIT_CHIP_LIMITS.gapCells);
  });

  it('grows a prefix until two kits stop sharing it', () => {
    const plan = planKitChip({ columns: 60, kit: named({ otherNames: [`${'D'.repeat(30)}X`] }) });
    // 24 characters would still collide with the sibling, so the prefix grows to
    // 31 - and then it no longer fits, which means the chip hides instead of
    // showing a prefix that could mean either kit.
    expect(plan.visible).toBe(false);
  });
});

describe('I-9: no kit costs nothing', () => {
  it('plans nothing for an absent, null or empty kit', () => {
    expect(planKitChip({ columns: 120 }).visible).toBe(false);
    expect(planKitChip({ columns: 120, kit: null }).visible).toBe(false);
    expect(planKitChip({ columns: 120, kit: { name: '  ', modified: false,
      otherNames: [] } }).visible).toBe(false);
  });

  it('normalizes a garbage column count instead of dividing by nothing', () => {
    expect(planKitChip({ columns: Number.NaN, kit: named() }).visible).toBe(true);
  });
});

describe('one floor for both chips', () => {
  it('shares the 34-cell status floor with the session chip (R-6)', () => {
    expect(KIT_CHIP_LIMITS.minStatusCells).toBe(SESSION_CHIP_LIMITS.minStatusCells);
  });
});
