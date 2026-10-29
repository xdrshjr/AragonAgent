import { describe, expect, it } from 'vitest';
import { KEY_MATRIX } from '../../../shared/parity-matrix.js';
import { catalogueKeys } from '../../i18n/index.js';
import { comboParts, DESKTOP_SHORTCUTS, TERMINAL_KEY_LABELS, terminalKeyRows } from '../settings-shortcuts.js';

describe('shortcut data', () => {
  it('labels every terminal key the parity matrix lists, so none is missing from the sheet', () => {
    for (const entry of KEY_MATRIX) expect(TERMINAL_KEY_LABELS[entry.id], entry.id).toBeDefined();
    expect(terminalKeyRows().every((row) => row.labelKey !== null)).toBe(true);
  });

  it('marks the keys the window handles itself as not applicable', () => {
    expect(terminalKeyRows().find((row) => row.id === 'scroll/selection/mouse')?.notApplicable).toBe(true);
    expect(terminalKeyRows().find((row) => row.id === 'Shift+Tab')?.notApplicable).toBe(false);
  });

  it('has a translation for every label in both languages', () => {
    const en = new Set(catalogueKeys('en'));
    const zh = new Set(catalogueKeys('zh-CN'));
    for (const key of [...DESKTOP_SHORTCUTS.map((item) => item.labelKey), ...Object.values(TERMINAL_KEY_LABELS)]) {
      expect(en.has(key), key).toBe(true);
      expect(zh.has(key), key).toBe(true);
    }
  });

  it('writes Ctrl on Windows and Linux and the command glyph on macOS', () => {
    expect(comboParts('mod+shift+b', false)).toEqual(['Ctrl', 'Shift', 'B']);
    expect(comboParts('mod+shift+b', true)).toEqual(['⌘', '⇧', 'B']);
    expect(comboParts('mod+,', false)).toEqual(['Ctrl', ',']);
    expect(comboParts('?', false)).toEqual(['?']);
  });
});
