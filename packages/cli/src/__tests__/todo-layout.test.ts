import { describe, expect, it } from 'vitest';
import { buildTodoRailLayout } from '../ui/layout/todo-layout.js';
import { buildTeamPanelLayout } from '../ui/layout/team-panel.js';
import type { TeamSnapshot } from '../team/types.js';

const input = {
   cols: 100, panelEnabled: true, overlayOpen: false,
  itemCount: 20, viewportBudget: 12, teamRows: 8, popupRows: 0,
};

function teamSnapshot(count: number, mail = false): TeamSnapshot {
  return {
    dispatchId: 'd', active: true, requested: count, startedAt: 1000, messageCount: mail ? 1 : 0,
    runs: Array.from({ length: count }, (_, i) => ({
      label: `agent${i}`, description: 'working', tier: 'main', phase: 'thinking',
      startedAt: 1000, turns: 0, toolCalls: 0, filesTouched: [], messagesSent: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    })),
    ...(mail ? { lastMessage: { from: 'a', to: 'b', subject: 'mail', body: '', at: 1 } } : {}),
  };
}

describe('TODO 共享行预算', () => {
  it('团队八行时右栏仍占完整预算，正文保留其余列', () => {
    expect(buildTodoRailLayout(input)).toMatchObject({
      visible: true, reason: 'visible', width: 15, rows: 12, contentCols: 85, popupMaxHeight: 3,
    });
  });
  it('菜单为正文保留三行，空间不足时菜单不占行', () => {
    expect(buildTodoRailLayout({ ...input, popupRows: 9 }).rows).toBe(12);
    expect(buildTodoRailLayout({ ...input, teamRows: 0, popupRows: 99 }).rows).toBe(12);
  });
  it('按顺序应用隐藏条件', () => {
    for (const [over, reason] of [
      [{ panelEnabled: false }, 'disabled'],
      [{ overlayOpen: true }, 'overlay'], [{ itemCount: 0 }, 'empty'],
      [{ cols: 75 }, 'narrow'], [{ viewportBudget: 2 }, 'short'],
    ] as const) {
      const result = buildTodoRailLayout({ ...input, ...over });
      expect(result).toMatchObject({ visible: false, reason, contentCols: over.cols ?? 100 });
    }
  });
  it('非法几何和超额团队行数不会产生非有限或负数', () => {
    for (const n of [NaN, Infinity, -Infinity, -2, 0, 1.9, 20]) {
      const result = buildTodoRailLayout({ ...input, cols: n, viewportBudget: n, popupRows: n });
      for (const key of ['width', 'rows', 'contentCols', 'popupMaxHeight'] as const) {
        expect(Number.isInteger(result[key])).toBe(true);
        expect(result[key]).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('团队按实际内容展开，短屏及长输入折叠', () => {
    for (const count of [0, 1, 5, 8]) {
      for (const mail of [false, true]) {
        const snapshot = teamSnapshot(count, mail);
        const natural = 1 + Math.min(count, 5) + Number(count > 5) + Number(mail);
        expect(buildTeamPanelLayout({ snapshot, terminalRows: 20, availableRows: 12 }).rowCount)
          .toBe(natural);
        expect(buildTeamPanelLayout({ snapshot, terminalRows: 19, availableRows: 12 }).rowCount)
          .toBe(1);
        expect(buildTeamPanelLayout({ snapshot, terminalRows: 20, availableRows: Infinity }).rowCount)
          .toBe(natural);
      }
    }
    expect(buildTeamPanelLayout({ snapshot: teamSnapshot(8, true), terminalRows: 20, availableRows: 8 }).rowCount).toBe(1);
    for (const availableRows of [NaN, -Infinity, -1, 0]) {
      expect(buildTeamPanelLayout({ snapshot: teamSnapshot(1), terminalRows: 20, availableRows }).rowCount).toBe(0);
    }
    expect(buildTeamPanelLayout({ snapshot: null, terminalRows: 20, availableRows: 12 }).rowCount).toBe(0);
  });
});
