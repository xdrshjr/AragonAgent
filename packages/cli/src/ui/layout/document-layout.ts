import { frameHeight } from './frame.js';

export interface DocumentLayoutInput {
  rows: number;
  bodyRows: number;
  footerRows: number;
}

export interface DocumentLayout {
  viewportRows: number;
  paddingRows: number;
  contentRows: number;
  trailingContentRows: number;
}

/** Allocate the shared document, filling short sessions before the editor. */
export function buildDocumentLayout(input: DocumentLayoutInput): DocumentLayout {
  const count = (n: number): number => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const viewportRows = count(input.rows) > 0 ? Math.max(0, frameHeight(count(input.rows)) - 3) : 0;
  const body = count(input.bodyRows);
  const footer = count(input.footerRows);
  const paddingRows = Math.max(0, viewportRows - body - footer);
  return { viewportRows, paddingRows, contentRows: body + paddingRows + footer,
    trailingContentRows: paddingRows + footer };
}
