/**
 * Cursor Position Report parsing (tui-bottom-anchored-live-region §4.5).
 *
 * The bottom anchor needs one number the writer cannot compute: how many rows are
 * left below the cursor. `ESC[6n` is the only way to ask, and the terminal answers
 * with `ESC[<row>;<col>R` (DECXCPR adds a `?`: `ESC[?<row>;<col>R`) on STDIN —
 * the same stream the user types on. Two things follow, and both live here:
 *
 *  1. THE ANSWER MUST BE STRIPPED BEFORE INK SEES IT. A report that reaches Ink
 *     travels the keystroke path: `[` is 0x5B, so `PromptInput`'s control-sequence
 *     guard passes it through and the user's draft gets `[12;1R` typed into it (the
 *     same class of accident the mouse filter exists to prevent).
 *  2. THE ANSWER CAN ARRIVE IN TWO CHUNKS. ConPTY, tmux and a loaded SSH session
 *     all split reads at arbitrary points, and a half report (`ESC[12`) is worse
 *     than a whole one: `parse-keypress` has no branch for it.
 *
 * Pure functions only, mirroring `mouse-events.ts`: the filter owns the buffering
 * and the timers, this module owns the shapes.
 */

/** The query for a Cursor Position Report (DSR 6). ASCII by construction. */
export const CURSOR_REPORT_QUERY = '\x1b[6n';

/** One parsed report. `row`/`col` are 1-based, exactly as the terminal sent them. */
export interface CursorReport {
  row: number;
  col: number;
}

export interface CursorReportSplit {
  /** Text that survives stripping — everything that is not a report. */
  text: string;
  /** Reports found in this chunk, in order. */
  reports: CursorReport[];
  /** Trailing bytes that could still become a report; hand them to the next chunk. */
  pending: string;
}

/**
 * `ESC[<row>;<col>R`, with the DECXCPR `?` accepted. Anchored on `ESC[` plus digits
 * and one `;`, which is what keeps it from matching a private-mode write such as
 * `ESC[?25l` (that one ends in a letter this pattern cannot accept).
 *
 * Built per call rather than shared: a module-level `/g` regex carries `lastIndex`
 * between calls, which turns a pure function into a stateful one.
 */
const reportPattern = (): RegExp => /\x1b\[\??(\d+);(\d+)R/g;

/**
 * A PROPER prefix of a report: `ESC`, `ESC[`, then an optional `?`, then digits, at
 * most one `;`, then more digits. Nothing a keyboard produces matches past `ESC[`
 * (arrow keys end in a letter), so the filter's 12 ms hold stays a rare path.
 */
const PREFIX = /^\x1b(\[(\?(\d*(;\d*)?)?|\d*(;\d*)?)?)?$/;

/** True when `s` is a non-empty proper prefix of a possible report. */
export function isCursorReportPrefix(s: string): boolean {
  return s.length > 0 && s.length < 24 && PREFIX.test(s);
}

/**
 * Split the reports out of one chunk.
 *
 * `pending` carries the tail that might still complete into a report. It is only
 * ever the LAST fragment: the scan is left to right, so anything before a complete
 * report is settled text.
 */
export function splitCursorReports(text: string): CursorReportSplit {
  const reports: CursorReport[] = [];
  const pattern = reportPattern();
  let out = '';
  let index = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    out += text.slice(index, match.index);
    reports.push({ row: Number(match[1]), col: Number(match[2]) });
    index = match.index + match[0].length;
  }
  out += text.slice(index);
  const pendingLength = trailingCprPrefixLength(out);
  if (pendingLength === 0) return { text: out, reports, pending: '' };
  return {
    text: out.slice(0, out.length - pendingLength),
    reports,
    pending: out.slice(out.length - pendingLength),
  };
}

/**
 * Length of the trailing run of `text` that is a proper prefix of a report, or 0.
 *
 * LONGEST MATCH WINS, unlike the mouse family's shortest-wins rule. The families are
 * combined with `max()`, so only the longest answer ever survives, and a longer hold
 * is never wrong here: `ESC[1` can still become `ESC[12;1R`, while the shorter
 * answer `ESC` could not describe it. The bound is the longest report the terminals
 * we target emit (DECXCPR with a `?` and three-digit coordinates).
 */
export function trailingCprPrefixLength(text: string): number {
  const max = Math.min(text.length, 24);
  for (let k = max; k >= 1; k -= 1) {
    if (isCursorReportPrefix(text.slice(text.length - k))) return k;
  }
  return 0;
}

/** The query bytes, as a function so call sites read as an action rather than a literal. */
export function formatCursorReportQuery(): string {
  return CURSOR_REPORT_QUERY;
}

/**
 * Rows left below a reported cursor row on a terminal of `rows` rows.
 * `0` means the cursor is already on the last row; `null` when the height is unknown.
 */
export function spaceBelowFromReport(
  report: CursorReport,
  rows: number | undefined,
): number | null {
  if (rows === undefined || !Number.isFinite(rows) || rows < 1) return null;
  return Math.max(0, Math.floor(rows) - 1 - (report.row - 1));
}
