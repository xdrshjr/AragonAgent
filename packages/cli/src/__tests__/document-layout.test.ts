import { describe, expect, it } from 'vitest';
import { buildDocumentLayout } from '../ui/layout/document-layout.js';
import { reduceFollow } from '../ui/layout/follow-state.js';
import { thumbRange } from '../ui/layout/scroll-indicator.js';

describe('unified document', () => {
  it('reserves only three fixed rows and fills before the footer', () => {
    expect(buildDocumentLayout({ rows: 24, bodyRows: 12, footerRows: 6 })).toEqual({
      viewportRows: 20, paddingRows: 2, contentRows: 20, trailingContentRows: 8,
    });
    expect(buildDocumentLayout({ rows: 12, bodyRows: 100, footerRows: 4 }))
      .toMatchObject({ viewportRows: 8, paddingRows: 0, contentRows: 104 });
  });
  it('normalizes invalid row counts', () => {
    expect(buildDocumentLayout({ rows: NaN, bodyRows: Infinity, footerRows: -4 }))
      .toEqual({ viewportRows: 0, paddingRows: 0, contentRows: 0, trailingContentRows: 0 });
  });
  it('combines shrinking footer and output before clamping', () => {
    expect(reduceFollow({ offset: 60, overflowLines: 55, tailDelta: 5,
      layoutTailDelta: -10, hold: false, newLinesWhilePaused: 0 }))
      .toEqual({ offset: 55, newLinesWhilePaused: 5 });
  });
  it('reserves travel even for one overflowing row', () => {
    expect(thumbRange(20, 21, 0, true)).toEqual({ size: 19, start: 1 });
    expect(thumbRange(20, 21, 0)).toEqual({ size: 19, start: 1 });
  });
});
