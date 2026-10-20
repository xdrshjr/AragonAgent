/**
 * Progress extraction for a long-running job (long-task-jobs §4.5).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * PURE: no IO, no clock, no process. That is what lets `progress.test.ts`
 * enumerate the whole table, and it is why the cost of a progress line is one
 * function call inside an already-coalesced output tick rather than a second
 * subscription to the child's stdio.
 *
 * THE POINT IS EXTRACTION, NOT TRANSPORT. The alternative - handing the model
 * the last 200 rows so it can notice the `47%` itself - costs 4k-8k tokens per
 * check and buries the one number that matters. Here the ring keeps the rows and
 * the model gets `47%`.
 *
 * NOTHING DECIDES ANYTHING FROM THIS (R-4). Progress is a REPORT. `status`,
 * `exitCode` and `signal` are the only things a job's outcome is ever read from,
 * so a false `100%` in `[100%] built target foo` costs one confusing word rather
 * than a wrong conclusion.
 */

import { PROC_LIMITS } from './limits.js';

export type ProgressKind = 'percent' | 'ratio' | 'epoch' | 'bytes' | 'text';

export interface JobProgress {
  /** Already clipped to `PROC_LIMITS.waitProgressChars`. */
  text: string;
  kind: ProgressKind;
  /** `carry` = the not-yet-newline-terminated line, where every progress bar lives. */
  source: 'row' | 'carry';
  /** Index into the scanned window; `-1` for the carry line. Diagnostics and tests only. */
  rowIndex: number;
}

/**
 * The ordered table (first match wins PER ROW, newest row scanned first).
 *
 * BYTES SITS ABOVE THE GENERIC RATIO, and that rewrites the order the design
 * document lists. `1.2/3.4 GiB` satisfies the generic ratio pattern as `2/3`
 * (the digits either side of the slash, with `.` a word boundary), so a table
 * that tried `\d+/\d+` first would report every download as `2/3`. The document's
 * constraint - ordered, anchored, single-line, no backtracking blowup - is kept;
 * only the relative order of those two rows changed. Recorded in
 * `docs/plans/long-task-jobs/spec.md` under `## 实施过程发现的方案缺陷` (I-1).
 */
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/;
const EPOCH_STEP = /\b(epoch|step)\s+(\d{1,7})\s*\/\s*(\d{1,7})/i;
const BYTES =
  /(\d+(?:\.\d+)?)\s*(GiB|MiB|KiB|GB|MB|KB|gb|mb|kb|gib|mib)?\s*\/\s*(\d+(?:\.\d+)?)\s*(GiB|MiB|KiB|GB|MB|KB|gb|mb|kb|gib|mib)/;
const RATIO = /[\[(]?\b(\d{1,7})\s*\/\s*(\d{1,7})\b[\])]?/;
const ETA = /ETA[^0-9]{0,4}([0-9:]+[a-z]*)/i;

/** A row that is decoration, not information: `...`, `|`, `-`, `===`, a bare path separator. */
const NOISE = /^[\s.\-_=|\\/+*#>~]+$/;

/** Clip to the one-line budget, ASCII ellipsis, never mid-surrogate. */
function clip(text: string, limit: number = PROC_LIMITS.waitProgressChars): string {
  // VERTICAL whitespace only is collapsed: a stray `\r` or `\n` would break the
  // one-row contract, while the DOUBLE SPACE before `ETA` is how the row is meant
  // to read (`47%  ETA 13m`) and collapsing it would make the table's rendering
  // depend on which function ran last.
  const flat = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

interface Signal {
  text: string;
  kind: ProgressKind;
}

/**
 * The structured signals for one line, in table order.
 *
 * ORDER WITHIN A LINE IS THE TABLE'S ORDER; the caller decides which LINE wins
 * (newest first), because a live `47%` must beat a stale `100%` from the phase
 * above it.
 */
function signalsOf(line: string): Signal | undefined {
  const percent = PERCENT.exec(line);
  if (percent?.[1]) return { text: `${percent[1]}%`, kind: 'percent' };

  const epoch = EPOCH_STEP.exec(line);
  if (epoch?.[1] && epoch[2] !== undefined && epoch[3] !== undefined) {
    return { text: `${epoch[1].toLowerCase()} ${epoch[2]}/${epoch[3]}`, kind: 'epoch' };
  }

  const bytes = BYTES.exec(line);
  if (bytes?.[1] && bytes[3]) {
    // Normalised to the TOTAL's unit, which is the one the user's own command
    // printed: `1.2/3.4 GiB` reads, `1.2 GiB/3.4 GiB` is noise. The numerator's
    // unit is optional because the common form writes it once, at the end.
    return { text: `${bytes[1]}/${bytes[3]} ${bytes[4]}`, kind: 'bytes' };
  }

  const ratio = RATIO.exec(line);
  if (ratio?.[1] && ratio[2] !== undefined) {
    return { text: `${ratio[1]}/${ratio[2]}`, kind: 'ratio' };
  }
  return undefined;
}

/** Append the ETA once, when the window names one. */
function withEta(signal: Signal, window: readonly string[]): Signal {
  if (signal.text.includes('ETA')) return signal;
  for (const line of window) {
    const eta = ETA.exec(line);
    if (eta?.[1]) return { text: `${signal.text}  ETA ${eta[1]}`, kind: signal.kind };
  }
  return signal;
}

/**
 * Extract one line of progress from the tail of a job's output.
 *
 * `rows` is the scan window (the caller passes at most
 * `PROC_LIMITS.progressScanRows`); `carry` is the not-yet-terminated line, which
 * is where a `\r`-rewritten bar keeps its whole life. Returns `undefined` when
 * nothing but decoration has been printed - an honest "there is no progress to
 * show", which the callers render as absence rather than as a fake `0%`.
 */
export function extractProgress(
  rows: readonly string[],
  carry: string,
): JobProgress | undefined {
  const displayCarry = carry.trim();
  // NEWEST FIRST, INSIDE ONE WINDOW. The carry line is the newest of all by
  // definition, so it is tested before every completed row.
  const candidates: Array<{ line: string; source: 'row' | 'carry'; rowIndex: number }> = [];
  if (displayCarry.length > 0 && !NOISE.test(displayCarry)) {
    candidates.push({ line: displayCarry, source: 'carry', rowIndex: -1 });
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = rows[i] ?? '';
    if (line.trim().length === 0 || NOISE.test(line)) continue;
    candidates.push({ line, source: 'row', rowIndex: i });
  }

  const window = candidates.map((c) => c.line);
  for (const candidate of candidates) {
    const signal = signalsOf(candidate.line);
    if (!signal) continue;
    return {
      text: clip(withEta(signal, window).text),
      kind: signal.kind,
      source: candidate.source,
      rowIndex: candidate.rowIndex,
    };
  }

  // Fallback: the newest line that at least says something.
  const last = candidates[0];
  if (!last) return undefined;
  return {
    text: clip(last.line),
    kind: 'text',
    source: last.source,
    rowIndex: last.rowIndex,
  };
}
