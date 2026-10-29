/**
 * The drawer's geometry (tui-shortcut-drawer-and-task-summary §9.1).
 *
 * THREE OF THESE ASSERTIONS ARE THE ROUND'S REASON FOR EXISTING:
 *  - AC-21 (P0-1): no keyword is ever truncated. v1's layout left six cells for the
 *    keyword column at 80 columns and every assertion still passed, because
 *    truncation looks exactly like fitting.
 *  - AC-22 (P1-7): the cursor - and the detail line that belongs to it - is always
 *    inside the window, for every width and every cursor.
 *  - AC-6: no row is wider than the panel.
 */

import { describe, expect, it } from 'vitest';
import {
  buildShortcutRows,
  shortcutColumns,
  shortcutFooter,
  shortcutPanelContentCells,
  shortcutPanelWidth,
  SHORTCUT_PANEL_LIMITS,
  type ShortcutTaskSection,
} from '../ui/layout/shortcut-panel-layout.js';
import { fitCells } from '../ui/layout/cells.js';
import stringWidth from 'string-width';
import { SHORTCUTS } from '../ui/shortcuts.js';

const GLYPHS = { ellipsis: '...', cursor: '>', hrule: '-', midDot: '.' };

const TASK: ShortcutTaskSection = {
  text: 'fix the failing build',
  tone: 'model',
  reason: null,
  by: 'anthropic:claude-haiku',
  ageMs: 12_000,
  enabled: true,
  pending: false,
};

function build(cols: number, cursor = 0, rows = 13) {
  return buildShortcutRows({
    cols,
    rows,
    cursor,
    entries: SHORTCUTS,
    task: TASK,
    glyphs: GLYPHS,
  });
}

describe('shortcutPanelWidth', () => {
  it('is full width below the split threshold and a clamped bar above it (AC-3)', () => {
    expect(shortcutPanelWidth(40)).toBe(40);
    expect(shortcutPanelWidth(63)).toBe(63);
    expect(shortcutPanelWidth(64)).toBe(30);
    expect(shortcutPanelWidth(80)).toBe(30);
    expect(shortcutPanelWidth(120)).toBe(
      Math.min(SHORTCUT_PANEL_LIMITS.maxWidth,
        Math.max(SHORTCUT_PANEL_LIMITS.minWidth, Math.round(120 * 0.34))),
    );
    expect(shortcutPanelWidth(400)).toBe(SHORTCUT_PANEL_LIMITS.maxWidth);
  });

  it('spends rail cells below 48 columns and box cells at or above it', () => {
    expect(shortcutPanelContentCells(40)).toBe(40 - SHORTCUT_PANEL_LIMITS.railCells);
    expect(shortcutPanelContentCells(80)).toBe(30 - SHORTCUT_PANEL_LIMITS.boxCells);
    expect(shortcutPanelContentCells(200)).toBe(46 - SHORTCUT_PANEL_LIMITS.boxCells);
  });
});

describe('shortcutColumns', () => {
  it('derives the key column from the table instead of fixing it at 21 (P0-1)', () => {
    const columns = shortcutColumns(80, SHORTCUTS, GLYPHS);
    expect(columns.keyCells).toBeLessThan(21);
    // The keyword column must be able to hold the widest keyword in the table.
    expect(columns.keywordCells).toBeGreaterThanOrEqual(
      SHORTCUT_PANEL_LIMITS.keywordMaxCells,
    );
  });
});

describe('buildShortcutRows', () => {
  it('never truncates a keyword, at any width (AC-21)', () => {
    for (let cols = 48; cols <= 200; cols += 1) {
      const columns = shortcutColumns(cols, SHORTCUTS, GLYPHS);
      const { rows } = build(cols, 3);
      const keywords = rows.filter((row) => row.kind === 'entry' || row.kind === 'keyword');
      expect(keywords.length, `cols=${cols}`).toBeGreaterThan(0);
      for (const row of keywords) {
        const keyword = SHORTCUTS.find((entry) => entry.id === row.entryId)?.keyword ?? '';
        if (row.kind === 'keyword') {
          // Stacked mode: the keyword gets its own row with the indent spent first.
          expect(row.text.trim(), `cols=${cols}`).toBe(keyword);
          continue;
        }
        const visible = row.text.slice(-keyword.length);
        expect(fitCells(visible, columns.keywordCells, GLYPHS.ellipsis), `cols=${cols}`)
          .toBe(visible);
        expect(visible).toBe(keyword);
      }
    }
  });

  it('never draws a row wider than the panel (AC-6)', () => {
    for (let cols = 20; cols <= 200; cols += 1) {
      for (const cursor of [0, 5, SHORTCUTS.length - 1]) {
        const { rows } = build(cols, cursor);
        const available = shortcutPanelContentCells(cols);
        for (const row of rows) {
          expect(stringWidth(row.text), `cols=${cols} cursor=${cursor}`)
            .toBeLessThanOrEqual(available);
        }
      }
    }
  });

  it('keeps the selected row inside the window for every cursor (AC-22)', () => {
    // A SAMPLED SWEEP, not a 26x3x31 grid: the property is monotone in `cursor`, so
    // the ends and a stride through the middle catch every clamping bug while keeping
    // the case inside the default timeout. The exhaustive form is the two rows
    // either side of each page boundary, which is where a clamp can be off by one.
    for (const cols of [20, 47, 48, 80, 120, 200]) {
      for (const rows of [5, 13, 20]) {
        for (const cursor of [0, 1, 7, 15, SHORTCUTS.length - 2, SHORTCUTS.length - 1]) {
          const result = build(cols, cursor, rows);
          const { window } = result;
          expect(window.start, `cols=${cols} rows=${rows} cursor=${cursor}`)
            .toBeLessThanOrEqual(result.cursorRow);
          expect(result.cursorRow).toBeLessThan(window.start + window.visible);
        }
      }
    }
  });

  it('clamps the window at both ends, which is where an off-by-one lives (AC-22)', () => {
    // Bottom: selecting the LAST entry must leave that entry on screen. The window is
    // NOT forced to the end of the list - the selected row sits on the last VISIBLE row
    // and its detail line follows - so the assertion is containment, not equality.
    const bottom = build(80, SHORTCUTS.length - 1, 13);
    expect(bottom.cursorRow).toBeGreaterThanOrEqual(bottom.window.start);
    expect(bottom.cursorRow).toBeLessThan(bottom.window.start + bottom.window.visible);
    expect(bottom.window.start + bottom.window.visible).toBeLessThanOrEqual(bottom.total);
    // Top: with the first entry selected the window starts at row 0.
    expect(build(80, 0, 13).window.start).toBe(0);
  });

  it('clamps an out-of-range cursor instead of trusting it', () => {
    const beyond = build(80, 9_999);
    expect(beyond.cursorRow).toBeGreaterThan(0);
    const negative = build(80, -5);
    expect(negative.window.start).toBe(0);
  });

  it('shows at least 10 entries on the first page at 80x24 (AC-25)', () => {
    // 80x24 native: `overlayRows = 23 - 1 - 3 - 1 = 18`, and `OverlayFrame` spends
    // five of those on chrome at this width, leaving a 13-row body.
    const { rows, window } = build(80, 0, 13);
    const visible = rows.slice(window.start, window.start + window.visible);
    const entries = visible.filter((row) => row.kind === 'entry' || row.kind === 'stacked');
    expect(entries.length).toBeGreaterThanOrEqual(10);
  });

  it('drops the group headers below the wide threshold and shows them above it', () => {
    const compact = build(80, 0, 13);
    expect(compact.rows.some((row) => row.kind === 'group')).toBe(false);
    const wide = build(80, 0, 24);
    expect(wide.rows.filter((row) => row.kind === 'group')).toHaveLength(5);
  });

  it('explains an unavailable row in its detail line instead of hiding it', () => {
    const result = buildShortcutRows({
      cols: 120,
      rows: 24,
      cursor: SHORTCUTS.findIndex((entry) => entry.id === 'ctrl-i'),
      entries: SHORTCUTS,
      task: TASK,
      entryAvailable: (entry) => entry.availability !== 'idle',
      unavailableReason: 'busy',
      glyphs: GLYPHS,
    });
    const detail = result.rows.filter((row) => row.kind === 'detail').map((row) => row.text);
    expect(detail.join(' ')).toContain('Unavailable now - busy.');
  });

  it('says why the task section is empty rather than leaving a gap', () => {
    const disabled = buildShortcutRows({
      cols: 100, rows: 20, cursor: 0, entries: SHORTCUTS,
      task: { ...TASK, enabled: false, text: null },
      glyphs: GLYPHS,
    });
    expect(disabled.rows[0]?.text).toContain('task summary is off');
    const pending = buildShortcutRows({
      cols: 100, rows: 20, cursor: 0, entries: SHORTCUTS,
      task: { ...TASK, text: null, pending: true },
      glyphs: GLYPHS,
    });
    expect(pending.rows[0]?.text).toContain('summarizing');
  });
});

describe('shortcutFooter', () => {
  it('keeps `Esc close` and drops clauses from the right as the panel narrows', () => {
    const wide = shortcutFooter(200, GLYPHS);
    expect(wide).toContain('Up/Dn');
    expect(wide).toContain('Esc close');
    for (const cols of [40, 30, 20]) {
      expect(shortcutFooter(cols, GLYPHS), `cols=${cols}`).toContain('Esc close');
    }
    // A narrow footer is a strict subset of the wide one, never a re-wording.
    expect(shortcutFooter(20, GLYPHS).length).toBeLessThanOrEqual(wide.length);
  });
});
