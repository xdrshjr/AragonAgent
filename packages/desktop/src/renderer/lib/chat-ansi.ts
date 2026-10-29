/**
 * A small ANSI SGR parser for bash output: text runs with a foreground colour index and a few
 * attributes. Everything that is not a colour/attribute escape (cursor movement, OSC titles,
 * bare control bytes) is DROPPED, never rendered: tool output is untrusted and a stray escape
 * must not reach the DOM as text or change the page.
 */

export interface AnsiRun {
  text: string;
  /** 0-15 into the theme's ANSI palette, or `null` for the default colour. */
  fg: number | null;
  bold: boolean;
  dim: boolean;
}

// CSI ... final byte (any), OSC ... BEL/ST, and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;:?]*)([\x20-\x2f]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// Control characters other than TAB / LF (CR handled by the caller's row split).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

interface Style { fg: number | null; bold: boolean; dim: boolean }

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(/[;:]/).map((part) => Number.parseInt(part || '0', 10));
  let next = style;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) next = { fg: null, bold: false, dim: false };
    else if (code === 1) next = { ...next, bold: true };
    else if (code === 2) next = { ...next, dim: true };
    else if (code === 22) next = { ...next, bold: false, dim: false };
    else if (code >= 30 && code <= 37) next = { ...next, fg: code - 30 };
    else if (code >= 90 && code <= 97) next = { ...next, fg: code - 90 + 8 };
    else if (code === 39) next = { ...next, fg: null };
    else if (code === 38 || code === 48) index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 0;
  }
  return next;
}

export function parseAnsi(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  let style: Style = { fg: null, bold: false, dim: false };
  let cursor = 0;
  const push = (text: string): void => {
    const clean = text.replace(CONTROL, '');
    if (clean) runs.push({ text: clean, ...style });
  };
  for (const match of input.matchAll(ESCAPE)) {
    const at = match.index ?? 0;
    push(input.slice(cursor, at));
    cursor = at + match[0].length;
    if (match[3] === 'm') style = applySgr(style, match[1] ?? '');
  }
  push(input.slice(cursor));
  return runs;
}

/** Plain text of a line with every escape removed (for copy and for tests). */
export function stripAnsi(input: string): string {
  return parseAnsi(input).map((run) => run.text).join('');
}
