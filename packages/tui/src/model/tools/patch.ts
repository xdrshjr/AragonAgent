/**
 * Structured file patches (agent-activity-presentation §3.3).
 *
 * PURE, NO I/O, NO REACT, ASCII-ONLY MARKERS. `glyphs.test.ts`'s static scan
 * walks ALL of `src/` (skipping only `__tests__/` and two exempt files), so this
 * module sits inside that guard rail directly rather than by analogy. The
 * substantive reason is the one `reducer.ts` gives for `PREVIEW_TRUNCATION_MARK`:
 * a string produced outside `src/ui/**` has no `TermCapabilities` in scope and
 * must be safe on a legacy `cmd.exe`.
 *
 * The ladder is ANCHORED SPLIT -> BOUNDED LCS -> BLOCK REPLACE, and every
 * recursion path terminates in one of three leaf returns. `blockReplace` is
 * exactly what `renderUnifiedDiff` produced before this round — every old row as
 * `del`, then every new row as `add` — kept as the explicit, bounded fallback so
 * a pathological input degrades to today's behaviour rather than hanging.
 *
 * `buildPatch` is TOTAL: it never throws, for any pair of strings.
 */

export type PatchLineKind = 'ctx' | 'add' | 'del';

export interface PatchLine {
  kind: PatchLineKind;
  /** 1-based line number in the OLD file; absent on an `add`. */
  oldLine?: number;
  /** 1-based line number in the NEW file; absent on a `del`. */
  newLine?: number;
  /** Rendered text. A trailing CR is stripped; long lines are truncated. */
  text: string;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface FilePatch {
  /** As the model wrote it — relative when the call was relative. */
  path: string;
  kind: 'create' | 'update';
  added: number;
  removed: number;
  hunks: PatchHunk[];
  /** Budget was hit; the tail of the change is not in `hunks`. */
  truncated: boolean;
  /**
   * Total rendered rows across every hunk (summary and separators excluded).
   *
   * PRECOMPUTED so `entryRevision` stays O(1) (I-L3-1 forbids hashing, and
   * summing `hunks[].lines.length` per entry per frame is exactly the cost the
   * height cache exists to remove).
   */
  lineCount: number;
  /** Set when the old side could not be read: too large, binary, or unreadable. */
  degraded?: 'binary' | 'too-large' | 'unreadable';
}

export const PATCH_LIMITS = {
  /**
   * Context rows kept either side of a change, FOR THE UI.
   *
   * The text renderer does NOT use this (D-20): `renderUnifiedDiff` keeps its
   * own `CONTEXT_LINES = 2` default so the model-facing diff does not silently
   * widen by two rows on every single-region edit. One algorithm, two widths,
   * chosen by the caller.
   */
  context: 3,
  /**
   * Hunks separated by this many context rows or fewer are merged into one.
   *
   * MUST STAY `>= 2 * context` FOR EVERY CALLER'S CONTEXT WIDTH, or two adjacent
   * hunks expanded by `context` would overlap and the same row would be rendered
   * twice with two different line numbers. 6 covers both widths in use (3 and 2).
   */
  mergeGap: 6,
  /** Rendered rows a patch may carry, across all hunks. */
  maxLines: 200,
  /** Total characters across all `PatchLine.text`. Mirrors STORED_PREVIEW_CHARS. */
  maxChars: 8_000,
  /** A single row is truncated past this, with `TRUNCATION_MARK`. */
  maxLineChars: 500,
  /** Above this cell count the LCS leaf is refused; the segment becomes a block replace. */
  lcsCellBudget: 160_000, // 400 x 400
  /** Recursion depth ceiling for the anchor split. */
  maxDepth: 32,
  /** Old-side bytes above which `write_file` does not read for a diff. */
  readMaxBytes: 2 * 1024 * 1024,
  /** Model-facing diff text ceiling — a bound `edit_file` does not have today. */
  modelDiffMaxChars: 4_000,
} as const;

/**
 * Appended to a row clipped at `maxLineChars`.
 *
 * SPELLED HERE RATHER THAN IMPORTED from `agent/reducer.ts`, so that `tools/`
 * does not take a runtime dependency on the view model for one three-character
 * string. `patch.test.ts` asserts the two spellings are equal, so the pair
 * cannot drift silently — which is the property the import would have bought.
 */
export const TRUNCATION_MARK = '...';

/** The note emitted when exactly one side ends with a newline. */
export const NO_NEWLINE_NOTE = '(no newline at end of file)';

export interface BuildPatchOptions {
  /** As the model wrote it; carried onto the patch verbatim. */
  path: string;
  /** Context rows either side of a change. Defaults to `PATCH_LIMITS.context`. */
  context?: number;
  /**
   * Why the old side is `null`.
   *
   * It also decides `kind`: a missing old side with no reason is a CREATE, and a
   * missing old side WITH one is an UPDATE whose old half could not be read. The
   * distinction matters because "created a file" and "overwrote a 5 MB file we
   * declined to read" are different events and the card names them differently.
   */
  degraded?: FilePatch['degraded'];
}

/** One row of the diff, before line numbers and text are attached. */
interface Row {
  kind: PatchLineKind;
  /** Index into the OLD line array; absent on an `add` and on the note row. */
  a?: number;
  /** Index into the NEW line array; absent on a `del` and on the note row. */
  b?: number;
  /** The `(no newline at end of file)` note: numbered by neither side. */
  note?: true;
}

interface Range {
  aLo: number;
  aHi: number;
  bLo: number;
  bHi: number;
}

interface Anchor {
  a: number;
  b: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildPatch(
  oldText: string | null,
  newText: string,
  options: BuildPatchOptions,
): FilePatch {
  const context = clampContext(options.context);
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);

  const rows: Row[] =
    oldText === null
      ? newLines.map((_, i): Row => ({ kind: 'add', b: i }))
      : collectRows(oldLines, newLines, context);
  if (oldText !== null && endsWithNewline(oldText) !== endsWithNewline(newText)) {
    rows.push({ kind: 'ctx', note: true });
  }

  // Counted BEFORE truncation, so the `+6 -5` summary always describes the real
  // change even when the body is clipped.
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'del') removed += 1;
  }

  const budgeted = applyBudgets(assembleHunks(rows, oldLines, newLines, context));
  return {
    path: options.path,
    kind: oldText === null && !options.degraded ? 'create' : 'update',
    added,
    removed,
    hunks: budgeted.hunks,
    truncated: budgeted.truncated,
    lineCount: budgeted.lineCount,
    ...(options.degraded ? { degraded: options.degraded } : {}),
  };
}

// ---------------------------------------------------------------------------
// Step 0 — split and normalize
// ---------------------------------------------------------------------------

/**
 * Split on `\n`, dropping the phantom trailing element a file-final newline
 * produces. An empty string is ZERO lines, not one empty line.
 *
 * The RAW string is what later comparisons see, `\r` included: a CRLF-to-LF
 * conversion is a change and must be reported as one. Only `PatchLine.text` has
 * the CR stripped, and only for rendering.
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function endsWithNewline(text: string): boolean {
  return text.endsWith('\n');
}

function renderText(raw: string): string {
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

/**
 * The context width, clamped to HALF the merge gap.
 *
 * The ceiling is structural, not taste: two groups survive as separate hunks
 * only when more than `mergeGap` context rows separate them, and each is then
 * expanded by `context` rows from its own side. At `context > mergeGap / 2` the
 * two expansions overlap and the same source row is rendered twice, under two
 * different line numbers, with nothing reporting it. Both callers pass 3 or 2.
 */
function clampContext(requested: number | undefined): number {
  const ceiling = Math.floor(PATCH_LIMITS.mergeGap / 2);
  if (requested === undefined || !Number.isFinite(requested)) {
    return Math.min(PATCH_LIMITS.context, ceiling);
  }
  return Math.max(0, Math.min(ceiling, Math.floor(requested)));
}

// ---------------------------------------------------------------------------
// Steps 2-3 — trim, then the anchored split
// ---------------------------------------------------------------------------

/**
 * Trim the common prefix and suffix, diff the middle, and emit at most `context`
 * unchanged rows on either side.
 *
 * Emitting only the fringe rather than the whole file is what keeps this O(change)
 * in allocations: a one-line edit in a 50 000-line file builds a handful of rows,
 * not fifty thousand.
 */
function collectRows(oldLines: string[], newLines: string[], context: number): Row[] {
  let start = 0;
  const maxStart = Math.min(oldLines.length, newLines.length);
  while (start < maxStart && oldLines[start] === newLines[start]) start += 1;

  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld -= 1;
    endNew -= 1;
  }

  // Identical files: no hunks at all, rather than today's stray context rows.
  if (start > endOld && start > endNew) return [];

  const rows: Row[] = [];
  const lead = Math.min(context, start);
  for (let i = start - lead; i < start; i += 1) rows.push({ kind: 'ctx', a: i, b: i });

  const middle = { aLo: start, aHi: endOld, bLo: start, bHi: endNew };
  for (const row of diffRange(oldLines, newLines, middle, 0)) rows.push(row);

  const tail = Math.min(context, oldLines.length - 1 - endOld);
  for (let k = 1; k <= tail; k += 1) rows.push({ kind: 'ctx', a: endOld + k, b: endNew + k });
  return rows;
}

/**
 * Patience-style recursive split.
 *
 * TERMINATION: the three degenerate cases and the depth cap return leaves
 * outright; the recursive branch only runs when at least one anchor was kept,
 * and every sub-range it builds excludes that anchor's rows on both sides — so
 * each call is on a strictly smaller range.
 */
function diffRange(a: string[], b: string[], r: Range, depth: number): Row[] {
  if (r.aLo > r.aHi && r.bLo > r.bHi) return [];
  if (r.aLo > r.aHi) return addRows(r.bLo, r.bHi);
  if (r.bLo > r.bHi) return delRows(r.aLo, r.aHi);
  if (depth >= PATCH_LIMITS.maxDepth) return blockReplace(r);

  const anchors = pickAnchors(a, b, r);
  if (anchors.length === 0) {
    const cells = (r.aHi - r.aLo + 1) * (r.bHi - r.bLo + 1);
    return cells <= PATCH_LIMITS.lcsCellBudget ? lcsDiff(a, b, r) : blockReplace(r);
  }

  const out: Row[] = [];
  let ai = r.aLo;
  let bi = r.bLo;
  for (const anchor of anchors) {
    const gap = { aLo: ai, aHi: anchor.a - 1, bLo: bi, bHi: anchor.b - 1 };
    for (const row of diffRange(a, b, gap, depth + 1)) out.push(row);
    out.push({ kind: 'ctx', a: anchor.a, b: anchor.b });
    ai = anchor.a + 1;
    bi = anchor.b + 1;
  }
  const rest = { aLo: ai, aHi: r.aHi, bLo: bi, bHi: r.bHi };
  for (const row of diffRange(a, b, rest, depth + 1)) out.push(row);
  return out;
}

function addRows(lo: number, hi: number): Row[] {
  const out: Row[] = [];
  for (let i = lo; i <= hi; i += 1) out.push({ kind: 'add', b: i });
  return out;
}

function delRows(lo: number, hi: number): Row[] {
  const out: Row[] = [];
  for (let i = lo; i <= hi; i += 1) out.push({ kind: 'del', a: i });
  return out;
}

/** Today's behaviour, kept as the bounded fallback: every del, then every add. */
function blockReplace(r: Range): Row[] {
  return [...delRows(r.aLo, r.aHi), ...addRows(r.bLo, r.bHi)];
}

/** Lines occurring EXACTLY ONCE on both sides, kept in a common increasing order. */
function pickAnchors(a: string[], b: string[], r: Range): Anchor[] {
  const aSeen = new Map<string, number>();
  const aAt = new Map<string, number>();
  for (let i = r.aLo; i <= r.aHi; i += 1) {
    const line = a[i]!;
    aSeen.set(line, (aSeen.get(line) ?? 0) + 1);
    aAt.set(line, i);
  }
  const bSeen = new Map<string, number>();
  const bAt = new Map<string, number>();
  for (let i = r.bLo; i <= r.bHi; i += 1) {
    const line = b[i]!;
    bSeen.set(line, (bSeen.get(line) ?? 0) + 1);
    bAt.set(line, i);
  }

  const pairs: Anchor[] = [];
  for (const [line, count] of aSeen) {
    if (count !== 1 || bSeen.get(line) !== 1) continue;
    pairs.push({ a: aAt.get(line)!, b: bAt.get(line)! });
  }
  pairs.sort((x, y) => x.a - y.a);
  return longestIncreasingByB(pairs);
}

/** Longest strictly-increasing subsequence by `b`, via binary-searched piles. */
function longestIncreasingByB(pairs: Anchor[]): Anchor[] {
  const tails: number[] = [];
  const prev: number[] = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]!.b < pairs[i]!.b) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: Anchor[] = [];
  let k = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    out.push(pairs[k]!);
    k = prev[k]!;
  }
  return out.reverse();
}

/** Textbook LCS over a leaf small enough to afford it (`lcsCellBudget`). */
function lcsDiff(a: string[], b: string[], r: Range): Row[] {
  const n = r.aHi - r.aLo + 1;
  const m = r.bHi - r.bLo + 1;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[r.aLo + i] === b[r.bLo + j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }

  const out: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[r.aLo + i] === b[r.bLo + j]) {
      out.push({ kind: 'ctx', a: r.aLo + i, b: r.bLo + j });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      out.push({ kind: 'del', a: r.aLo + i });
      i += 1;
    } else {
      out.push({ kind: 'add', b: r.bLo + j });
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push({ kind: 'del', a: r.aLo + i });
  for (; j < m; j += 1) out.push({ kind: 'add', b: r.bLo + j });
  return out;
}

// ---------------------------------------------------------------------------
// Step 4 — hunks
// ---------------------------------------------------------------------------

/**
 * Group changed rows into hunks, expanding each group by `context` rows.
 *
 * THE NOTE ROW COUNTS AS A CHANGE for grouping purposes even though it renders
 * as context: a file whose ONLY difference is its final newline has no `add` and
 * no `del` row at all, and grouping on kind alone would produce zero hunks and
 * report the change as nothing.
 */
function assembleHunks(
  rows: Row[],
  oldLines: string[],
  newLines: string[],
  context: number,
): PatchHunk[] {
  const changed: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.kind !== 'ctx' || row.note) changed.push(i);
  }
  if (changed.length === 0) return [];

  const groups: [number, number][] = [];
  let from = changed[0]!;
  let to = changed[0]!;
  for (let k = 1; k < changed.length; k += 1) {
    const idx = changed[k]!;
    if (idx - to - 1 <= PATCH_LIMITS.mergeGap) {
      to = idx;
      continue;
    }
    groups.push([from, to]);
    from = idx;
    to = idx;
  }
  groups.push([from, to]);

  return groups.map(([lo, hi]) => {
    const slice = rows.slice(
      Math.max(0, lo - context),
      Math.min(rows.length, hi + context + 1),
    );
    return makeHunk(slice.map((row) => toPatchLine(row, oldLines, newLines)));
  });
}

function toPatchLine(row: Row, oldLines: string[], newLines: string[]): PatchLine {
  if (row.note) return { kind: 'ctx', text: NO_NEWLINE_NOTE };
  const line: PatchLine = { kind: row.kind, text: '' };
  if (row.a !== undefined) {
    line.oldLine = row.a + 1;
    line.text = renderText(oldLines[row.a]!);
  }
  if (row.b !== undefined) {
    line.newLine = row.b + 1;
    line.text = renderText(newLines[row.b]!);
  }
  return line;
}

/** Derive the `@@` header numbers from the rows the hunk actually carries. */
function makeHunk(lines: PatchLine[]): PatchHunk {
  let oldStart = 0;
  let oldCount = 0;
  let newStart = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.oldLine !== undefined) {
      if (oldCount === 0) oldStart = line.oldLine;
      oldCount += 1;
    }
    if (line.newLine !== undefined) {
      if (newCount === 0) newStart = line.newLine;
      newCount += 1;
    }
  }
  return { oldStart, oldCount, newStart, newCount, lines };
}

// ---------------------------------------------------------------------------
// Step 5 — budgets
// ---------------------------------------------------------------------------

interface BudgetResult {
  hunks: PatchHunk[];
  truncated: boolean;
  lineCount: number;
}

/**
 * Clip long rows, then drop whole hunks from the TAIL until the row and
 * character budgets hold. Tail-first, because the top of a change is where a
 * reader starts.
 *
 * THE FIRST HUNK IS KEPT EVEN WHEN IT ALONE EXCEEDS THE BUDGET, and its rows are
 * clipped from the tail instead. A 300-line `write_file` is one hunk of 300 add
 * rows against a 200-row ceiling: dropping whole hunks only would leave ZERO,
 * and the card would render a `+300 -0` summary over nothing — precisely the
 * "reported as a byte count" failure this feature exists to fix (see the Issues
 * Found section of the design).
 */
function applyBudgets(input: PatchHunk[]): BudgetResult {
  const hunks = input.map(clipHunkText);
  let rows = 0;
  let chars = 0;
  let keep = 0;
  for (const hunk of hunks) {
    const hunkRows = hunk.lines.length;
    const hunkChars = hunk.lines.reduce((n, line) => n + line.text.length, 0);
    const fits =
      rows + hunkRows <= PATCH_LIMITS.maxLines && chars + hunkChars <= PATCH_LIMITS.maxChars;
    // The FIRST hunk is accepted whether or not it fits; see the note above.
    if (keep > 0 && !fits) break;
    rows += hunkRows;
    chars += hunkChars;
    keep += 1;
  }

  const kept = hunks.slice(0, Math.max(1, Math.min(keep, hunks.length)));
  let truncated = kept.length < hunks.length;
  if (rows > PATCH_LIMITS.maxLines || chars > PATCH_LIMITS.maxChars) {
    kept[0] = clipHunkRows(kept[0]!);
    truncated = true;
  }

  return {
    hunks: kept,
    truncated,
    lineCount: kept.reduce((n, hunk) => n + hunk.lines.length, 0),
  };
}

function clipHunkText(hunk: PatchHunk): PatchHunk {
  return {
    ...hunk,
    lines: hunk.lines.map((line) =>
      line.text.length <= PATCH_LIMITS.maxLineChars
        ? line
        : { ...line, text: `${line.text.slice(0, PATCH_LIMITS.maxLineChars)}${TRUNCATION_MARK}` },
    ),
  };
}

/** Keep the head of one hunk's rows, and re-derive its header numbers from it. */
function clipHunkRows(hunk: PatchHunk): PatchHunk {
  const lines: PatchLine[] = [];
  let chars = 0;
  for (const line of hunk.lines) {
    if (lines.length >= PATCH_LIMITS.maxLines) break;
    if (lines.length > 0 && chars + line.text.length > PATCH_LIMITS.maxChars) break;
    lines.push(line);
    chars += line.text.length;
  }
  return makeHunk(lines);
}
