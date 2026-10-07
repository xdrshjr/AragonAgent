/** Shared UTF-16 grapheme boundaries and terminal-cell layout for the editor. */
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface EditorGrapheme {
  readonly text: string;
  readonly index: number;
  readonly end: number;
}

/** Segment text without changing its UTF-16 offsets or stored whitespace. */
export function graphemes(text: string): EditorGrapheme[] {
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({
    text: segment, index, end: index + segment.length,
  }));
}

/** Snap an arbitrary UTF-16 offset to a complete grapheme boundary. */
export function snapGrapheme(text: string, cursor: number, right = false): number {
  const clamped = Math.max(0, Math.min(text.length, cursor));
  for (const part of segmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (clamped > part.index && clamped < end) return right ? end : part.index;
    if (part.index >= clamped) break;
  }
  return clamped;
}

/** Move one complete grapheme, leaving the two buffer edges unchanged. */
export function stepGrapheme(text: string, cursor: number, direction: 'left' | 'right'): number {
  if (direction === 'left') return snapGrapheme(text, Math.max(0, cursor - 1));
  return snapGrapheme(text, Math.min(text.length, cursor + 1), true);
}

/** Width of one grapheme (ASCII avoids the Unicode width-table lookup). */
export function graphemeWidth(text: string): number {
  if (text.length === 1 && text >= ' ' && text <= '~') return 1;
  return stringWidth(text);
}

export interface VisualCell extends EditorGrapheme {
  readonly column: number;
  readonly width: number;
}

export interface VisualPosition {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

export interface EditorVisualMap {
  readonly rows: VisualCell[][];
  readonly positions: VisualPosition[];
  readonly cursor: VisualPosition;
}

/** Map graphemes to hard-wrapped rows, sharing tab stops and caret reservation. */
export function buildEditorVisualMap(input: {
  buffer: string; cols: number; cursor: number; active?: boolean;
}): EditorVisualMap {
  const cols = Math.max(1, Math.floor(input.cols));
  const cursor = snapGrapheme(input.buffer, input.cursor);
  const rows: VisualCell[][] = [[]];
  const positions: VisualPosition[] = [];
  let column = 0;
  const breakRow = (): void => { rows.push([]); column = 0; };
  const locate = (index: number): void => {
    positions.push({ index, row: rows.length - 1, column });
  };
  for (const part of graphemes(input.buffer)) {
    if (part.text === '\n') {
      if (input.active !== false && part.index === cursor && column >= cols) breakRow();
      locate(part.index);
      breakRow();
      continue;
    }
    let width = part.text === '\t' ? Math.min(cols, 4 - column % 4)
      : graphemeWidth(part.text);
    if (column > 0 && column + width > cols) {
      breakRow();
      if (part.text === '\t') width = Math.min(cols, 4);
    }
    locate(part.index);
    rows[rows.length - 1]!.push({ ...part,
      text: part.text === '\t' ? ' '.repeat(width) : part.text, column, width });
    column += width;
  }
  if (input.active !== false && cursor === input.buffer.length && column >= cols) breakRow();
  locate(input.buffer.length);
  const caret = positions.find((position) => position.index === cursor)!;
  return { rows, positions, cursor: caret };
}

/** Move to the closest boundary at or left of the preferred display column. */
export function moveVisualCursor(input: {
  buffer: string; cursor: number; cols: number; direction: 'up' | 'down';
  preferredVisualColumn?: number;
}): { cursor: number; preferredVisualColumn: number } | null {
  const map = buildEditorVisualMap(input);
  const row = map.cursor.row + (input.direction === 'up' ? -1 : 1);
  if (row < 0 || row >= map.rows.length) return null;
  const preferredVisualColumn = input.preferredVisualColumn ?? map.cursor.column;
  const candidates = map.positions.filter((position) => position.row === row);
  let target = candidates[0];
  for (const position of candidates) {
    if (position.column <= preferredVisualColumn) target = position;
  }
  return target ? { cursor: target.index, preferredVisualColumn } : null;
}
