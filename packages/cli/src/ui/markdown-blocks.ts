/**
 * Markdown parsing layer (spec §4.7). Pure and React-free so the grammar can be
 * unit-tested without rendering anything.
 *
 * Scope is deliberately small — this is not CommonMark. It covers what a coding
 * agent's answers actually contain: fenced code, headings, lists, quotes, rules,
 * tables, and inline emphasis / code / strikethrough.
 */

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

/**
 * Pad a parsed table into fixed-width columns. Returns one string per row —
 * no borders, because a bordered table inside an already-indented gutter wraps
 * on any realistic terminal.
 */
export function formatTable(rows: string[][], align: TableBlock['align']): string[] {
  const colCount = Math.max(...rows.map((r) => r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < colCount; c += 1) {
    widths[c] = Math.max(...rows.map((r) => (r[c] ?? '').length), 0);
  }
  return rows.map((row) =>
    row
      .map((cell, c) => {
        const w = widths[c] ?? 0;
        const a = align[c] ?? 'left';
        if (a === 'right') return cell.padStart(w);
        if (a === 'center') {
          const total = w - cell.length;
          const left = Math.floor(total / 2);
          return ' '.repeat(left) + cell + ' '.repeat(total - left);
        }
        return cell.padEnd(w);
      })
      .join('  ')
      .trimEnd(),
  );
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

/** A fence line: ```` ```lang ```` or a bare ```` ``` ````. */
const FENCE_RE = /^```(\w*)\s*$/;

/** Split a document into fenced code, pipe tables, and everything else. */
export function parseMarkdownBlocks(text: string): MdBlock[] {
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE_RE.exec(line.trim());
    if (fence) {
      const lang = fence[1] || '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test((lines[i] ?? '').trim())) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // skip the closing fence
      blocks.push({ kind: 'code', code: codeLines.join('\n'), lang });
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
