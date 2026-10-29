/**
 * The right rail's two sections (todo-acceptance-criteria AC-13, AC-14, AC-33..AC-37,
 * AC-46).
 *
 * TWO KINDS OF ASSERTION, deliberately separated:
 *  - the ROW ALGEBRA, over a cartesian product, because an overflow here is clipped
 *    silently by Ink and reads to the user as "the list is shorter than it is";
 *  - the RENDERED output, because a correct budget with a wrong renderer is still a
 *    wrong panel.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { acceptanceChip, acceptanceRung } from '../ui/layout/todo-layout.js';
import { TodoPanel } from '../ui/TodoPanel.js';
import { buildPlanSections } from '../model/todo/plan-sections.js';
import {
  acceptanceAnchorIndex,
  selectAcceptanceRows,
  selectCompactAcceptanceRows,
  selectCompactTodoRows,
  selectTodoRows,
  todoAnchorIndex,
} from '../model/todo/panel-rows.js';
import { derivePlanPhase } from '../model/todo/acceptance.js';
import { TODO_LIMITS } from '../model/todo/limits.js';
import { getTheme } from '../ui/theme.js';
import type { AcceptanceItem, AcceptanceStatus, TodoItem, TodoSnapshot } from '../model/todo/types.js';

const CAPS = { colorLevel: 0 as const, unicode: false };
const THEME = getTheme('auto', CAPS);

function steps(done: number, total: number): TodoItem[] {
  return Array.from({ length: total }, (_, i) => ({
    content: `step ${i + 1}`,
    activeForm: `doing ${i + 1}`,
    status: i < done ? 'completed' as const : 'pending' as const,
  }));
}

function criteria(statuses: AcceptanceStatus[]): AcceptanceItem[] {
  return statuses.map((status, i) => ({
    content: `criterion ${i + 1}`,
    check: `check ${i + 1}`,
    status,
    evidence: status === 'failed' ? `evidence ${i + 1}` : '',
  }));
}

function snapshot(items: TodoItem[], acceptance: AcceptanceItem[] | null): TodoSnapshot {
  const table = acceptance
    ? {
      items: acceptance,
      total: acceptance.length,
      checkedCount: acceptance.filter((a) => a.status === 'passed' || a.status === 'failed').length,
      passedCount: acceptance.filter((a) => a.status === 'passed').length,
      failedCount: acceptance.filter((a) => a.status === 'failed').length,
      updatedAt: 0,
    }
    : null;
  return {
    items,
    total: items.length,
    doneCount: items.filter((item) => item.status === 'completed').length,
    activeIndex: items.findIndex((item) => item.status === 'in_progress'),
    updatedAt: 0,
    acceptance: table,
  };
}

describe('buildPlanSections: the row identity (AC-14)', () => {
  const PHASES = ['work', 'verify', 'done'] as const;

  it('never exceeds the row budget, over the whole cartesian product', () => {
    for (let rows = TODO_LIMITS.panelMinRows; rows <= 30; rows += 1) {
      for (const phase of PHASES) {
        for (const todoCount of [0, 1, 5, 20]) {
          for (const acceptanceCount of [0, 1, 3, 12]) {
            const showGauge = rows >= 8;
            const sections = buildPlanSections({
              rows, width: 30, phase, todoCount, acceptanceCount, showGauge,
            });
            const compact = rows < TODO_LIMITS.panelFullRows;
            const sum = Number(showGauge) + 1 + (compact ? 0 : 1) + sections.todoItemRows
              + Number(sections.todoFooter)
              + (sections.acceptance
                ? sections.acceptance.headerRows + sections.acceptance.itemRows
                : 0);
            expect(sum, `rows=${rows} phase=${phase} todo=${todoCount} acc=${acceptanceCount}`)
              .toBeLessThanOrEqual(rows);
          }
        }
      }
    }
  });

  it('AC-14: the twelve-row table, cell by cell', () => {
    const table = [
      { rows: 3, phase: 'work', todoCount: 5, acc: 3, footer: 1, todoItemRows: 1, reason: 'absent', header: 0, items: 0 },
      { rows: 4, phase: 'work', todoCount: 5, acc: 3, footer: 1, todoItemRows: 1, reason: 'summary', header: 0, items: 1 },
      { rows: 5, phase: 'work', todoCount: 2, acc: 3, footer: 0, todoItemRows: 3, reason: 'summary', header: 0, items: 1 },
      { rows: 5, phase: 'verify', todoCount: 7, acc: 4, footer: 1, todoItemRows: 2, reason: 'summary', header: 0, items: 1 },
      { rows: 6, phase: 'work', todoCount: 5, acc: 3, footer: 0, todoItemRows: 2, reason: 'visible', header: 1, items: 1 },
      { rows: 6, phase: 'verify', todoCount: 5, acc: 3, footer: 0, todoItemRows: 1, reason: 'visible', header: 1, items: 2 },
      { rows: 8, phase: 'work', todoCount: 9, acc: 12, footer: 0, todoItemRows: 3, reason: 'visible', header: 1, items: 1 },
      { rows: 8, phase: 'verify', todoCount: 9, acc: 12, footer: 0, todoItemRows: 1, reason: 'visible', header: 1, items: 3 },
      { rows: 20, phase: 'work', todoCount: 9, acc: 5, footer: 0, todoItemRows: 11, reason: 'visible', header: 1, items: 5 },
      { rows: 20, phase: 'verify', todoCount: 9, acc: 12, footer: 0, todoItemRows: 1, reason: 'visible', header: 1, items: 12 },
      { rows: 30, phase: 'work', todoCount: 9, acc: 12, footer: 0, todoItemRows: 18, reason: 'visible', header: 1, items: 8 },
    ] as const;

    for (const row of table) {
      const sections = buildPlanSections({
        rows: row.rows,
        width: 30,
        phase: row.phase,
        todoCount: row.todoCount,
        acceptanceCount: row.acc,
        showGauge: row.rows >= 8,
      });
      expect(sections.todoItemRows, `rows=${row.rows} phase=${row.phase}`).toBe(row.todoItemRows);
      expect(sections.todoFooter).toBe(row.footer === 1);
      expect(sections.acceptance?.reason).toBe(row.reason);
      expect(sections.acceptance?.headerRows).toBe(row.header);
      expect(sections.acceptance?.itemRows).toBe(row.items);
    }
  });

  it('AC-14 (last row): with no criteria the arithmetic is the pre-feature one', () => {
    for (let rows = TODO_LIMITS.panelMinRows; rows <= 30; rows += 1) {
      const showGauge = rows >= 8;
      const compact = rows < TODO_LIMITS.panelFullRows;
      const todoCount = 9;
      const sections = buildPlanSections({
        rows, width: 30, phase: 'work', todoCount, acceptanceCount: 0, showGauge,
      });
      const footer = compact && todoCount > rows - 1 ? 1 : 0;
      expect(sections.todoItemRows).toBe(
        compact ? rows - 1 - footer : rows - 2 - Number(showGauge),
      );
      expect(sections.todoFooter).toBe(footer === 1);
      expect(sections.acceptance).toBeNull();
    }
  });

  it('AC-34: `absent` happens ONLY at rows === 3 with a footer', () => {
    expect(buildPlanSections({ rows: 3, width: 30, phase: 'work', todoCount: 5, acceptanceCount: 3, showGauge: false }).acceptance?.reason)
      .toBe('absent');
    expect(buildPlanSections({ rows: 3, width: 30, phase: 'work', todoCount: 1, acceptanceCount: 3, showGauge: false }).acceptance?.reason)
      .toBe('summary');
    expect(buildPlanSections({ rows: 4, width: 30, phase: 'work', todoCount: 5, acceptanceCount: 3, showGauge: false }).acceptance?.reason)
      .toBe('summary');
  });
});

describe('the acceptance window (AC-13)', () => {
  it('anchors on in_progress, then the first unchecked, then the last row', () => {
    expect(acceptanceAnchorIndex(criteria(['passed', 'in_progress', 'pending']))).toBe(1);
    expect(acceptanceAnchorIndex(criteria(['passed', 'pending', 'failed']))).toBe(1);
    expect(acceptanceAnchorIndex(criteria(['passed', 'failed']))).toBe(1);
    expect(acceptanceAnchorIndex([])).toBe(0);
  });

  it('always shows the anchored row, even when the window is tiny', () => {
    const items = criteria(Array.from({ length: 12 }, () => 'pending' as const));
    items[7]!.status = 'in_progress';
    const window = selectAcceptanceRows(items, 3);
    expect(window.visible.some((row) => row.index === 7)).toBe(true);
    expect(window.hiddenAbove + window.hiddenBelow + window.visible.length).toBe(items.length);
  });

  it('the compact window reserves no marker rows', () => {
    const items = criteria(Array.from({ length: 6 }, () => 'pending' as const));
    expect(selectCompactAcceptanceRows(items, 2).visible).toHaveLength(2);
    expect(selectCompactAcceptanceRows(items, 0).visible).toEqual([]);
  });

  it('the todo window is unchanged by the generalisation (AC-13)', () => {
    const items = steps(9, 20);
    items[9] = { ...items[9]!, status: 'in_progress' };
    const rows = selectTodoRows(items, 8);
    expect(rows.visible.map((row) => row.index)).toContain(9);
    expect(todoAnchorIndex(items)).toBe(9);
    expect(selectCompactTodoRows(items, 4).visible).toHaveLength(4);
  });
});

describe('rendering (AC-33, AC-34, AC-35)', () => {
  function renderPanel(snap: TodoSnapshot, rows: number, width = 30): string {
    const frame = render(
      <TodoPanel
        snapshot={snap}
        width={width}
        rows={rows}
        running={false}
        reducedMotion
        theme={THEME}
        caps={CAPS}
      />,
    );
    const out = frame.lastFrame() ?? '';
    frame.unmount();
    return out;
  }

  it('AC-33: verify folds the steps to ONE row and titles the section VERIFY', () => {
    const snap = snapshot(steps(7, 7), criteria(['passed', 'failed', 'pending', 'pending']));
    expect(derivePlanPhase(snap.items, snap.acceptance!.items)).toBe('verify');
    const frame = renderPanel(snap, 20);
    const lines = frame.split('\n');
    expect(lines.filter((line) => line.includes('step ')).length).toBe(0);
    expect(frame).toContain('all steps complete');
    expect(frame).toContain('VERIFY');
    expect(frame).not.toContain('ACCEPT');
  });

  it('AC-35: the count reads `done` when everything passed and `!n` when something failed', () => {
    const passed = renderPanel(snapshot(steps(2, 2), criteria(['passed', 'passed'])), 20);
    expect(passed).toContain('2/2 done');
    const failed = renderPanel(snapshot(steps(2, 2), criteria(['passed', 'failed'])), 20);
    expect(failed).toContain('2/2 !1');
  });

  it('AC-33 (compact rung): the collapsed list drops its `-N +M` footer too', () => {
    // rows === 5 with 7 steps is the compact rung WITH a footer. `verify` collapses
    // the step window to one row, so the footer would be the only line still talking
    // about hidden steps - `-0 +5` directly under "all steps complete". The rows it
    // would have used stay blank inside the fixed-height box, which is what the box
    // is for.
    const frame = renderPanel(snapshot(steps(7, 7), criteria(['pending', 'pending'])), 5);
    expect(frame).toContain('all steps complete');
    expect(frame).not.toContain('-0 +');
    expect(frame).not.toMatch(/[-+]\d+ ?/);
  });

  it('AC-34: a summary rung draws ONE line and no header', () => {
    const frame = renderPanel(snapshot(steps(0, 5), criteria(['pending', 'pending', 'pending'])), 4);
    expect(frame).toContain('AC 0/3');
    expect(frame).not.toContain('ACCEPT');
  });

  it('AC-35 (work phase): the section is titled ACCEPT and every criterion is UNCHECKED', () => {
    const frame = renderPanel(snapshot(steps(1, 3), criteria(['pending', 'pending'])), 20);
    expect(frame).toContain('ACCEPT');
    // The marker cell is one column wider than the TODO one, so the text never
    // touches the glyph at either tier.
    expect(frame).toContain('[ ] criterion 1');
    expect(frame).not.toContain('[x] criterion');
  });

  it('a rail with no criteria is exactly the pre-feature panel', () => {
    const frame = renderPanel(snapshot(steps(1, 3), null), 20);
    expect(frame).not.toContain('ACCEPT');
    expect(frame).not.toContain('VERIFY');
    expect(frame).not.toContain('AC ');
  });
});

describe('the status chip (AC-38, AC-46)', () => {
  it('is needed when no rail was drawn, and when the section could not be fitted', () => {
    const snap = snapshot(steps(0, 5), criteria(['pending', 'pending']));
    expect(acceptanceChip({ snapshot: snap, railRows: 0, width: 30 }))
      .toEqual({ checked: 0, total: 2, failed: 0 });
    // rows === 3 with a footer is the ONE combination that draws no section.
    expect(acceptanceChip({ snapshot: snap, railRows: 3, width: 30 })).not.toBeNull();
  });

  it('is NOT needed while the rail already reports the count', () => {
    const snap = snapshot(steps(0, 5), criteria(['pending', 'pending']));
    expect(acceptanceChip({ snapshot: snap, railRows: 20, width: 30 })).toBeNull();
    expect(acceptanceChip({ snapshot: snap, railRows: 4, width: 30 })).toBeNull();
  });

  it('is never shown without a table', () => {
    expect(acceptanceChip({ snapshot: null, railRows: 0, width: 30 })).toBeNull();
    expect(acceptanceChip({ snapshot: snapshot(steps(1, 3), null), railRows: 0, width: 30 }))
      .toBeNull();
  });

  it('AC-46: with the capability off there is no section and no chip, in both directions', () => {
    const off = snapshot(steps(0, 5), null);
    expect(buildPlanSections({
      rows: 20, width: 30, phase: 'work', todoCount: 5, acceptanceCount: 0, showGauge: true,
    }).acceptance).toBeNull();
    expect(acceptanceChip({ snapshot: off, railRows: 0, width: 30 })).toBeNull();
    expect(acceptanceRung({ snapshot: off, railRows: 20, width: 30 })).toBe('n/a');

    const on = snapshot(steps(0, 5), criteria(['pending']));
    expect(acceptanceRung({ snapshot: on, railRows: 20, width: 30 })).toBe('visible');
  });

  it('AC-38 (/perf): the rung comes from the same function the rail drew with', () => {
    const snap = snapshot(steps(0, 5), criteria(['pending', 'pending']));
    expect(acceptanceRung({ snapshot: snap, railRows: 4, width: 30 })).toBe('summary');
    expect(acceptanceRung({ snapshot: snap, railRows: 3, width: 30 })).toBe('absent');
    expect(acceptanceRung({ snapshot: snap, railRows: 0, width: 30 })).toBe('absent');
  });
});

describe('glyphs (AC-37)', () => {
  it('`todoFail` exists in BOTH tiers, and its ASCII form is three columns', async () => {
    const { pickGlyphs } = await import('../ui/glyphs.js');
    const ascii = pickGlyphs({ colorLevel: 0, unicode: false });
    expect(ascii.todoFail).toBe('[!]');
    expect(ascii.todoFail.length).toBe(3);
    expect(ascii.todoFail).toMatch(/^[\x00-\x7f]+$/);
    const unicode = pickGlyphs({ colorLevel: 3, unicode: true });
    expect(unicode.todoFail).toBe('\u2717');
    // The settled positive reuses the done glyph (D-9): one meaning, one shape.
    expect(unicode.todoDone).toBe('\u2713');
  });
});
