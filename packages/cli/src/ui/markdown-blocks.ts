/**
 * Markdown parsing layer (spec §4.7). Pure and React-free so the grammar can be
 * unit-tested without rendering anything. `string-width` is the only import and
 * it is a pure function of its argument, so the module stays side-effect free.
 *
 * Scope is deliberately small — this is not CommonMark. It covers what a coding
 * agent's answers actually contain: fenced code, headings, lists, quotes, rules,
 * tables, and inline emphasis / code / strikethrough.
 */

import stringWidth from 'string-width';

/** Heading levels are rendered with three distinct weights, not one (§4.7). */
export interface HeadingBlock {
  kind: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface RuleBlock {
  kind: 'rule';
}

/** Column alignment carried by a table's `|---|:--:|` divider row. */
export type Align = 'left' | 'right' | 'center';

export interface TableBlock {
  kind: 'table';
  /** Already column-aligned; render as plain monospace rows. */
  rows: string[][];
  align: Align[];
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** `---`, `***` or `___`, three or more, nothing else on the line. */
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER_CELL_RE = /^:?-{1,}:?$/;

export function parseHeading(line: string): HeadingBlock | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  return { kind: 'heading', level: m[1]!.length as HeadingBlock['level'], text: m[2] ?? '' };
}

export function isRule(line: string): boolean {
  return RULE_RE.test(line.trim());
}

/** Split one `| a | b |` row into trimmed cells. Returns null if not a row. */
export function parseTableRow(line: string): string[] | null {
  const m = TABLE_ROW_RE.exec(line);
  if (!m) return null;
  return m[1]!.split('|').map((c) => c.trim());
}

/** Is this the `|---|:--:|` divider that makes the preceding row a header? */
export function isTableDivider(line: string): boolean {
  const cells = parseTableRow(line);
  if (!cells || cells.length === 0) return false;
  return cells.every((c) => TABLE_DIVIDER_CELL_RE.test(c));
}

export function tableAlignments(dividerLine: string): TableBlock['align'] {
  const cells = parseTableRow(dividerLine) ?? [];
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

/** Default column separator: pure ASCII, so this module holds no glyph literal. */
const DEFAULT_TABLE_SEPARATOR = '|';
/** Default header rule: pure ASCII for the same reason. */
const DEFAULT_TABLE_RULE = '-';
/** One space either side of the separator, so a boundary is unmistakable. */
const TABLE_CELL_GAP = ' ';

/**
 * How the table is drawn. Both characters are injected by the renderer from
 * `pickGlyphs(caps)` because this file is inside the ASCII-only scan
 * (`glyphs.test.ts::inScope`): a Unicode box-drawing literal here would fail
 * that guard.
 */
export interface TableFormatOptions {
  /** Drawn between cells; `Markdown.tsx` passes `glyphs.railVertical`. */
  separator?: string;
  /** Repeated to a column's padded width; `Markdown.tsx` passes `glyphs.hrule`. */
  rule?: string;
}

/**
 * Pad a parsed table into fixed-width columns and draw the header rule.
 *
 * Returns `[header, divider, ...bodyRows]`, one string per rendered row, so
 * index 0 is always the header and index 1 always the divider. The divider is
 * rendered rather than swallowed because the parser consumes the source
 * `|---|` row to read alignment: without it, a `--no-color` terminal showed a
 * table as unseparated prose (bold is dropped at colour level 0, and the old
 * two-space join gave no column boundary either).
 *
 * Padding is by DISPLAY columns, not `String.length`: a CJK cell is one code
 * unit but two terminal columns, so `.length` misaligned every such table.
 */
export function formatTable(
  rows: string[][],
  align: TableBlock['align'],
  options: TableFormatOptions = {},
): string[] {
  const separator = options.separator ?? DEFAULT_TABLE_SEPARATOR;
  const rule = options.rule ?? DEFAULT_TABLE_RULE;
  const colCount = Math.max(...rows.map((r) => r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < colCount; c += 1) {
    widths[c] = Math.max(...rows.map((r) => displayColumns(r[c] ?? '')), 0);
  }
  const gap = `${TABLE_CELL_GAP}${separator}${TABLE_CELL_GAP}`;
  const body = rows.map((row) => padRow(row, widths, align).join(gap).trimEnd());
  if (body.length === 0) return [];
  const divider = widths.map((w) => rule.repeat(w)).join(gap).trimEnd();
  return [body[0]!, divider, ...body.slice(1)];
}

function padRow(row: string[], widths: number[], align: TableBlock['align']): string[] {
  return row.map((cell, c) => padCell(cell, widths[c] ?? 0, align[c] ?? 'left'));
}

function padCell(cell: string, width: number, align: Align): string {
  const pad = width - displayColumns(cell);
  if (pad <= 0) return cell;
  const filler = ' '.repeat(pad);
  if (align === 'right') return filler + cell;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return `${' '.repeat(left)}${cell}${' '.repeat(pad - left)}`;
  }
  return cell + filler;
}

/**
 * Printable ASCII with no TAB: one code unit is one cell, so the width table is
 * not consulted at all.
 *
 * The same load-bearing fast path `virtual-window.displayColumns` carries, and for
 * the same reason: `stringWidth` strips ANSI and walks the East-Asian width table
 * per code point, while this runs once per CELL of every table row on every frame.
 * Table cells are overwhelmingly ASCII, so the branch is taken almost always -
 * and when it is not, the table is CJK and the table is exactly what must be used.
 */
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

/** Terminal columns occupied by `text` (wide glyphs count two). */
function displayColumns(text: string): number {
  return PLAIN_ASCII.test(text) ? text.length : stringWidth(text);
}

// ---------------------------------------------------------------------------
// Block grammar (tui-render-performance L2 / R2)
//
// This used to live inside `Markdown.tsx`, which meant the whole document was
// re-split, re-regexed and re-allocated into one React element per line on EVERY
// render — for every markdown entry mounted, thirty times a second. The file
// header there already claimed "the grammar lives in markdown-blocks.ts"; now it
// does, and `parseMarkdownCached` memoises the result keyed on the text.
// ---------------------------------------------------------------------------

/**
 * One parsed top-level block.
 *
 * `line` is deliberately UNPARSED: heading / rule / quote / bullet detection is
 * a handful of regexes over one short string and is done at render time, where
 * the theme and the glyph set live. Caching a themed element instead would make
 * `/theme` a no-op until the cache evicted (K-5).
 */
export type MdBlock =
  | { kind: 'code'; code: string; lang: string }
  | { kind: 'table'; rows: string[][]; align: Align[] }
  | { kind: 'line'; text: string };

/** One opening fence: how many backticks it carries and its language token. */
interface FenceOpen {
  count: number;
  lang: string;
}

/**
 * An opening fence is three or more backticks plus an optional info string.
 *
 * The old `(\w*)` info group was too narrow for real answers: ```c++ and
 * ```objective-c did not open a block at all, so the body degraded to prose and
 * the closing fence was then swallowed as a new empty code block. A backtick is
 * the one character CommonMark forbids in an info string; everything else is
 * accepted here and the language is simply the FIRST token.
 */
const FENCE_OPEN_RE = /^(`{3,})[ \t]*([^`]*)$/;
/** A closing fence carries backticks only — no info string. */
const FENCE_CLOSE_RE = /^(`{3,})[ \t]*$/;

function parseFenceOpen(line: string): FenceOpen | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const info = (m[2] ?? '').trim();
  return { count: m[1]!.length, lang: info.split(/\s+/)[0] ?? '' };
}

/** Backtick count of a line that could close a fence; 0 when it could not. */
function closingFenceLength(line: string): number {
  const m = FENCE_CLOSE_RE.exec(line);
  return m ? m[1]!.length : 0;
}

/**
 * Collect a fence body starting after the opening fence.
 *
 * A closer must carry AT LEAST as many backticks as its opener, so a
 * four-backtick block may contain ``` lines — that is how a nested markdown
 * example survives. A shorter run is content, not the end of the block.
 */
function readFenceBody(
  lines: string[],
  openIndex: number,
  openCount: number,
): { code: string; next: number } {
  const body: string[] = [];
  let i = openIndex + 1;
  while (i < lines.length) {
    if (closingFenceLength((lines[i] ?? '').trim()) >= openCount) {
      return { code: body.join('\n'), next: i + 1 };
    }
    body.push(lines[i] ?? '');
    i += 1;
  }
  return { code: body.join('\n'), next: i };
}

/** Split a document into fenced code, pipe tables, and everything else. */
export function parseMarkdownBlocks(text: string): MdBlock[] {
  // CRLF-safe: a bare `split('\n')` left a '\r' on every code line, which then
  // reached the highlighter and the display-width maths.
  const lines = text.split(/\r?\n/);
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = parseFenceOpen(line.trim());
    if (fence) {
      const { code, next } = readFenceBody(lines, i, fence.count);
      blocks.push({ kind: 'code', code, lang: fence.lang });
      i = next;
      continue;
    }

    // A pipe row followed by a divider row starts a table; consume the run.
    const headerCells = parseTableRow(line);
    if (headerCells && i + 1 < lines.length && isTableDivider(lines[i + 1] ?? '')) {
      const align = tableAlignments(lines[i + 1] ?? '');
      const rows: string[][] = [headerCells];
      i += 2;
      while (i < lines.length) {
        const cells = parseTableRow(lines[i] ?? '');
        if (!cells) break;
        rows.push(cells);
        i += 1;
      }
      blocks.push({ kind: 'table', rows, align });
      continue;
    }

    blocks.push({ kind: 'line', text: line });
    i += 1;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline spans
// ---------------------------------------------------------------------------

export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'strike'; text: string };

const CODE_RE = /`[^`]+`/g;
const EMPHASIS_RE = /(\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g;

/**
 * Two passes, and that ordering is the fix (§4.7).
 *
 * The old single regex alternated `code | bold | italic` at the same level, so
 * `**bold with `code` inside**` matched neither branch cleanly and rendered as
 * literal asterisks. Splitting code out FIRST — and never looking for emphasis
 * inside a code span — resolves both cases: emphasis around code now works, and
 * asterisks inside code stay literal, which is what a shell snippet needs.
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(text)) !== null) {
    if (m.index > last) pushEmphasis(spans, text.slice(last, m.index));
    spans.push({ kind: 'code', text: m[0].slice(1, -1) });
    last = m.index + m[0].length;
  }
  if (last < text.length) pushEmphasis(spans, text.slice(last));
  return spans;
}

function pushEmphasis(out: InlineSpan[], text: string): void {
  let last = 0;
  let m: RegExpExecArray | null;
  EMPHASIS_RE.lastIndex = 0;
  while ((m = EMPHASIS_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('**')) out.push({ kind: 'bold', text: token.slice(2, -2) });
    else if (token.startsWith('~~')) out.push({ kind: 'strike', text: token.slice(2, -2) });
    else out.push({ kind: 'italic', text: token.slice(1, -1) });
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
}
