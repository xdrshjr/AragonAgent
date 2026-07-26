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

export interface TableBlock {
  kind: 'table';
  /** Already column-aligned; render as plain monospace rows. */
  rows: string[][];
  align: ('left' | 'right' | 'center')[];
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
