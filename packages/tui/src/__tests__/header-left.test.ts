/**
 * The header's LEFT half: the clause budget and the task label cell
 * (tui-shortcut-drawer-and-task-summary §4.3 / AC-2b / AC-16).
 *
 * THE INVARIANT IS THE POINT. `planHeaderLeftCells(plan) <= leftCells` for every
 * width and every summary state, combined with `leftCells + separatorCells +
 * hintCells === columns`, is the mechanical form of "the two halves of the header can
 * never squeeze each other". It replaces the ladder suite's `T-41`, which asserted a
 * similar property for a header shape that no longer exists.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  HEADER_LEFT_BASELINE,
  HEADER_LEFT_LIMITS,
  planHeaderLeft,
  planHeaderLeftCells,
  type HeaderLeftPlan,
} from '../ui/layout/header-left.js';
import { HEADER_HINT_LIMITS, planHeaderHints } from '../ui/layout/header-hints.js';
import { TASK_SUMMARY_LIMITS } from '../model/fast/limits.js';

const BASE = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  cwd: 'example-workspace',
  hasKey: true,
  summaryEnabled: true,
  ellipsis: '...',
} as const;

const CJK = { text: '修复构建失败', tone: 'model' as const };

function plan(leftCells: number, over: Partial<Parameters<typeof planHeaderLeft>[0]> = {}) {
  return planHeaderLeft({ ...BASE, leftCells, summary: null, ...over });
}

/** Every left clause rendered, in the order `Header` renders them. */
function renderedCells(result: HeaderLeftPlan): number {
  let cells = HEADER_LEFT_LIMITS.brandCells + HEADER_LEFT_LIMITS.keyCells;
  if (result.text.model) cells += stringWidth(result.text.model) + HEADER_LEFT_LIMITS.gapCells;
  if (result.text.cwd) cells += stringWidth(result.text.cwd) + HEADER_LEFT_LIMITS.gapCells;
  if (result.text.summary) {
    cells += stringWidth(result.text.summary) + HEADER_LEFT_LIMITS.summaryGapCells;
  }
  return cells;
}

describe('planHeaderLeft', () => {
  it('keeps the summary when there is room, right after the directory', () => {
    const result = plan(80, { summary: CJK });
    expect(result.summaryReason).toBe('ok');
    expect(result.text.summary.length).toBeGreaterThan(0);
    // CJK is never cut in half: `fitCells` drops whole characters only.
    expect(stringWidth(result.text.summary)).toBeLessThanOrEqual(result.cells.summary);
    expect(result.cells.summary).toBeLessThanOrEqual(TASK_SUMMARY_LIMITS.maxCells);
  });

  it('reports each reason for an empty cell honestly', () => {
    expect(plan(80, { summary: null }).summaryReason).toBe('empty');
    expect(plan(80, { summary: CJK, summaryEnabled: false }).summaryReason).toBe('disabled');
    expect(plan(6, { summary: CJK }).summaryReason).toBe('narrow');
    // A narrow header drops the label rather than rendering `...`, which would be a
    // claim to have one.
    expect(plan(6, { summary: CJK }).text.summary).toBe('');
  });

  it('gives up the label before the directory, and the directory before the model', () => {
    // WIDE: everything, at its desired width.
    const wide = plan(90, { summary: CJK });
    expect(wide.cells.summary).toBeGreaterThan(0);
    expect(wide.cells.cwd).toBeGreaterThan(0);
    expect(wide.cells.model).toBeGreaterThan(0);
    // TIGHT: the label goes first - it is the only clause allowed to disappear - and
    // the directory and the model name stay.
    const tight = plan(45, { summary: CJK });
    expect(tight.cells.summary).toBe(0);
    expect(tight.summaryReason).toBe('narrow');
    expect(tight.cells.cwd).toBeGreaterThan(0);
    expect(tight.cells.model).toBeGreaterThan(0);
    // TIGHTER: the directory goes next, and the model name survives alone.
    const tighter = plan(30, { summary: CJK });
    expect(tighter.cells.cwd).toBe(0);
    expect(tighter.cells.model).toBeGreaterThan(0);
    // TIGHTER STILL: nothing fits beside the word mark and the key symbol.
    expect(plan(18, { summary: CJK }).cells.model).toBe(0);
  });

  it('never spends more than the cells it was given, at any width (AC-2b)', () => {
    for (let leftCells = 0; leftCells <= 220; leftCells += 1) {
      for (const summary of [null, CJK, { text: 'fix the failing build', tone: 'fallback' as const }]) {
        const result = plan(leftCells, { summary });
        // BELOW THE FIXED BASELINE (word mark + key) no plan can be inside the budget
        // at all, and the renderer truncates instead - so the strong form of the
        // invariant is stated where it can hold: at and above the baseline.
        expect(planHeaderLeftCells(result), `left=${leftCells}`)
          .toBeLessThanOrEqual(Math.max(leftCells, HEADER_LEFT_BASELINE));
        if (leftCells >= HEADER_LEFT_BASELINE) {
          expect(planHeaderLeftCells(result), `left=${leftCells}`).toBeLessThanOrEqual(leftCells);
        }
        // `renderedCells` may be SHORTER than the plan: a clause that already fits its
        // allocation spends fewer cells than it reserved (a 6-cell CJK label in an
        // 8-cell slot). It may never be longer - that would mean the plan promised
        // cells the renderer does not have.
        expect(renderedCells(result), `left=${leftCells}`)
          .toBeLessThanOrEqual(planHeaderLeftCells(result));
        // A returned clause always MEASURES what it reports.
        expect(stringWidth(result.text.model)).toBeLessThanOrEqual(result.cells.model);
        expect(stringWidth(result.text.cwd)).toBeLessThanOrEqual(result.cells.cwd);
        expect(stringWidth(result.text.summary)).toBeLessThanOrEqual(result.cells.summary);
      }
    }
  });

  it('adds up with the hint column to exactly the terminal width (AC-2b)', () => {
    for (let columns = 20; columns <= 200; columns += 1) {
      for (const panel of ['none', 'shortcuts', 'other'] as const) {
        const hint = planHeaderHints({ columns, panel, scrolledLines: 0 });
        const leftCells = Math.max(0, columns - hint.cells - HEADER_HINT_LIMITS.separatorCells);
        expect(leftCells + HEADER_HINT_LIMITS.separatorCells + hint.cells, `cols=${columns}`)
          .toBe(columns);
        expect(leftCells).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
