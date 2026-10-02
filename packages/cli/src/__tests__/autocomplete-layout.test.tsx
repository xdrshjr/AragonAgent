import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { buildAutocompleteLayout } from '../ui/layout/autocomplete.js';
import { AutocompletePopup } from '../ui/AutocompletePopup.js';
import { getTheme } from '../ui/theme.js';

describe('补全菜单总高度', () => {
  it('包含边框和更多提示，始终保留选中项', () => {
    for (let itemCount = 1; itemCount <= 20; itemCount++) {
      for (let selected = 0; selected < itemCount; selected++) {
        for (let maxHeight = 0; maxHeight <= 12; maxHeight++) {
          const layout = buildAutocompleteLayout({ itemCount, selected, maxHeight });
          expect(layout.rowCount).toBeLessThanOrEqual(maxHeight);
          if (maxHeight < 3) expect(layout.rowCount).toBe(0);
          else {
            expect(selected).toBeGreaterThanOrEqual(layout.start);
            expect(selected).toBeLessThan(layout.start + layout.count);
            expect(layout.rowCount).toBe(2 + layout.count + Number(layout.showMore));
          }
        }
      }
    }
  });
  it('显式非法上限隐藏菜单，省略高度则保留兼容行为', () => {
    for (const value of [NaN, Infinity, -Infinity, -1, 0]) {
      expect(buildAutocompleteLayout({ itemCount: 20, selected: 0, maxHeight: value }).rowCount).toBe(0);
      expect(buildAutocompleteLayout({ itemCount: 20, selected: 0, maxRows: value }).rowCount).toBe(0);
    }
    expect(buildAutocompleteLayout({ itemCount: 20, selected: 0 }).rowCount).toBe(9);
  });
  it('换行和制表符只在显示副本中折叠', () => {
    const items = [{ label: 'a\nb', hint: 'c\r\nd\t中文😀' }];
    const caps = { unicode: false, colorLevel: 0 as const };
    const layout = buildAutocompleteLayout({ itemCount: 1, selected: 0, maxHeight: 3 });
    const view = render(<AutocompletePopup items={items} selected={0} layout={layout}
      theme={getTheme('auto', caps)} caps={caps} />);
    expect(view.lastFrame()?.split('\n')).toHaveLength(3);
    expect(view.lastFrame()).toContain('a b');
    expect(items[0]!.label).toBe('a\nb');
    view.unmount();
  });
});
