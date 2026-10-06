/**
 * Frame differ — F1 of tui-input-flicker-fix (§3.2).
 *
 * Ink 5.2.1 has exactly one repaint strategy: on every commit it serialises the
 * WHOLE frame and hands it to `log-update`, which writes
 * `eraseLines(previousLineCount) + frame` in a single `stdout.write`
 * (`ink/build/log-update.js:17`). `ansiEscapes.eraseLines` walks BOTTOM-UP, so
 * the composer — the last row of the frame — is erased near the start of every
 * repaint and rewritten at the very end of it. During a run that happens 15–30
 * times a second with the composer's bytes unchanged, and the user sees the
 * bottom of their screen flicker while they type (§2 R1/R2).
 *
 * This module recognises that write shape, diffs the new frame against the
 * previous one line by line, and emits only the rows that actually changed, each
 * addressed absolutely. It is PURE: no I/O, no Node globals, no event emitter —
 * `stdout-frame-writer.ts` is what binds it to a real stream. That is what keeps
 * it unit-testable with plain string literals and no TTY.
 *
 * THREE INVARIANTS LIVE HERE AND EACH ONE FAILS SILENTLY IF DROPPED:
 *
 *  - I-4 · An emitted line is `CUP · SGR0 · text · SGR0 · CSI K`, IN THAT ORDER,
 *    and it never contains `CSI 2K`. Erasing first would blank the row and refill
 *    it, which is R1's defect at 1/H the scale but on the one row the user is
 *    watching. Overwriting in place means no cell is ever presentably empty; the
 *    trailing `CSI K` removes only the residue a longer previous line left, and
 *    the trailing SGR reset before it stops a BCE terminal painting that residue
 *    in whatever background colour the line ended inside.
 *    `CSI K` IS EMITTED ONLY WHEN THE LINE IS NARROWER THAN THE TERMINAL. A row
 *    that already fills every column (the unified scrollbar paints the last one)
 *    has no residue to clear, and on terminals that keep the cursor ON the last
 *    column after writing it (a pending-wrap flag rather than a virtual column
 *    N+1) the EL would erase the cell that was just written. `cols` unknown keeps
 *    the old always-EL behaviour (`paintLine`).
 *  - I-5 · Every emitted batch ends parked on row `H+1`. Ink's own
 *    `previousLineCount` is computed from the string IT produced and is
 *    unaffected by what we actually wrote, so a later pass-through's
 *    `eraseLines(H+1)` must find the cursor exactly where log-update left it last
 *    time. Drop this and one fallback shifts the frame up a row for the rest of
 *    the session.
 *  - I-6 · Any unrecognised write invalidates the cache. Absolute addressing is
 *    valid only while nothing else writes to stdout. Full-screen mode already
 *    forbids that, but "forbidden" is not "impossible", and the failure mode of
 *    the guard being absent is a permanently misaligned screen while the failure
 *    mode of it firing spuriously is one extra full repaint.
 */

import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { MIN_FULLSCREEN_ROWS } from './layout/frame.js';
import { matchInkErasePrefix } from './frame-parser.js';

// ---------------------------------------------------------------------------
// Constants — exact, so no call site ever re-derives an escape sequence.
// ---------------------------------------------------------------------------

/** Control Sequence Introducer. Spelled out once; nothing below re-escapes it. */
const CSI = '\x1b[';
/** Erase the WHOLE line. Ink uses it on every repaint; this module never emits it (I-4). */
const ERASE_LINE = `${CSI}2K`;
/** Erase cursor → end of line. This is what an emitted line ends with. */
const ERASE_TO_EOL = `${CSI}K`;
const CURSOR_UP_1 = `${CSI}1A`;
const CURSOR_LEFT = `${CSI}G`;
const SGR_RESET = `${CSI}0m`;
/** Erase cursor → end of screen. One sequence instead of H+1 line erases. */
const ERASE_DOWN = `${CSI}J`;
/** DEC private mode 2026 — begin/end synchronized update (F2, §3.3). */
const SYNC_BEGIN = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

function cursorTo(row: number): string {
  return `${CSI}${row};1H`;
}

/**
 * One addressed row: `CUP · SGR0 · line · SGR0 [· CSI K]` (I-4).
 *
 * The trailing `CSI K` clears residue a longer previous line left behind, so it is
 * only meaningful when the line is narrower than the terminal. A line that already
 * fills `cols` columns ends with the cursor in the pending-wrap state, where some
 * terminals run EL from the LAST column and erase the cell just written; those
 * rows get no EL. Width is measured exactly as Ink measures it (`string-width` over
 * the ANSI-stripped text) and only for rows that changed, so it costs at most one
 * measurement per changed viewport row. `cols` unknown => the original always-EL.
 */
function paintLine(row: number, line: string, cols: number | undefined): string {
  const head = cursorTo(row) + SGR_RESET + line + SGR_RESET;
  if (cols !== undefined && stringWidth(stripAnsi(line)) >= cols) return head;
  return head + ERASE_TO_EOL;
}

/**
 * Rebuild `ansiEscapes.eraseLines(count)` byte for byte.
 *
 * Exported for the upgrade tripwire (`frame-differ-ink-shape.test.ts`), which
 * drives the real `ink/build/log-update.js` and asserts this reconstruction is
 * byte-equal to what it produced. If a future Ink changes the shape, that test
 * fails loudly instead of this module silently degrading to pass-through for the
 * rest of the package's life (K-2).
 */
export function eraseLinesPrefix(count: number): string {
  if (count <= 0) return '';
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += ERASE_LINE + (i < count - 1 ? CURSOR_UP_1 : '');
  }
  return out + CURSOR_LEFT;
}

// ---------------------------------------------------------------------------
// Public contracts (§5.5)
// ---------------------------------------------------------------------------

export interface FrameDifferOptions {
  /** Emit the DEC 2026 envelope around each batch. */
  sync: boolean;
  /**
   * Live terminal height. Read on every `transform`, NEVER cached: it is the
   * only input to the I-9 geometry guard and it changes under the differ's feet
   * on resize. `undefined` ⇒ stand down and pass through.
   */
  rows: () => number | undefined;
  /**
   * Live terminal width, read on every paint and never cached (like `rows`).
   * Absent or non-finite => every changed row ends in `CSI K` (the original
   * behaviour); finite => rows whose display width is >= `cols` skip the EL so
   * the last column (the scrollbar) is never erased (I-4).
   */
  cols?: () => number | undefined;
  /** Raised once, on the 0→1 edge of `fallbacks` (§5.6). */
  onFirstFallback?: () => void;
  /**
   * Raw frame lines in, lines to PAINT out. Identity when absent, and absent is
   * the default — a session without drag-select never allocates a second array.
   *
   * Called AFTER the geometry stand-down and BEFORE the cache comparison, so a
   * frame this module refuses to address never reaches the selection layer, and
   * the diff below still compares what is actually on the screen (I-2).
   *
   * It MUST return the same number of lines it was given; a decorator that
   * changes the count would desynchronise absolute addressing, so the result is
   * discarded if it does.
   */
  decorate?: (lines: string[]) => string[];
  /**
   * Raised whenever the cache is dropped — a foreign write, a resize, a geometry
   * stand-down, an explicit `invalidate()`.
   *
   * P1-7: on every one of those paths the RAW Ink frame reaches the screen
   * verbatim, so any highlight is wiped off the terminal while the selection
   * controller still believes it is painted and its mirror still holds the rows
   * of the last DECORATED frame. A release would then copy text that is not on
   * screen. I-4's "by construction" argument has exactly this hole, and one
   * callback closes it: the controller clears the selection.
   */
  onInvalidate?: () => void;
}

export interface FrameWriterStats {
  /** Frames the differ EMITTED — `framesDiffed + framesFull`, never pass-throughs. */
  framesTotal: number;
  framesDiffed: number;
  framesFull: number;
  linesWritten: number;
  bytesWritten: number;
  /**
   * Pass-throughs caused by a write the differ did not understand.
   *
   * NOT INVALIDATIONS (AC-11 / K-14). A resize legitimately invalidates and shows
   * up as `framesFull`; counting invalidations here would put AC-7 and AC-11 in
   * direct contradiction and one of them would end up quietly relaxed. It also
   * excludes the two pass-throughs this module inflicts on ITSELF and already
   * knows are benign — the session's seed write and the degenerate-geometry
   * stand-down — because `fallbacks > 0` is documented to mean "something wrote
   * to stdout behind Ink's back" and is what raises the §5.6 notice.
   */
  fallbacks: number;
  /**
   * Self-initiated repaints — `repaint()` calls that emitted at least one row.
   *
   * A COUNTER OF ITS OWN, deliberately kept out of `framesTotal` /
   * `framesDiffed` (P2-6). Those count frames INK PRODUCED, and folding a drag's
   * highlight repaints into them would make `/perf`'s frame rate a function of
   * how much the user moved the mouse.
   */
  repaints: number;
}

export interface FrameDiffer {
  /**
   * Bytes to write instead of `chunk`; `''` = write nothing; `null` = write
   * `chunk`. The parameter is `string` and only `string` (P1-4): decoding, and
   * the decision about what is even diffable, belong to the writer — the only
   * place untyped input arrives.
   */
  transform(chunk: string): string | null;
  /** Force the next frame to be a full repaint. */
  invalidate(): void;
  /** Single owner of the counters (P2-2); the writer re-exports this. */
  stats(): FrameWriterStats;
  /**
   * Re-run `decorate` over the LAST RAW FRAME and emit only the rows whose paint
   * changed; `''` when there is nothing safe to do.
   *
   * This is what makes a drag cost 1-3 addressed rows instead of a React commit
   * and a whole-tree Yoga layout (D-6). `''` is a REAL state rather than an error
   * — after an `invalidate()` there is no cache to diff against and no origin to
   * address from — and the caller's fallback is `App`'s existing `redrawNonce`:
   * ask for a React redraw, the next commit runs `decorate`, and the highlight
   * appears one frame later instead of never.
   */
  repaint(): string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ErasePrefix {
  prefix: string;
  erased: number;
}

export function createFrameDiffer(options: FrameDifferOptions): FrameDiffer {
  /**
   * Last frame AS PAINTED — what is actually on the screen.
   *
   * `null` = no cache, next frame is a full repaint. THE DIFF COMPARES PAINTED
   * LINES (I-2): diffing raw against a painted screen would leave the highlight
   * burned into rows the next frame never repaints, because those rows' RAW text
   * did not change.
   */
  let prev: string[] | null = null;
  /**
   * The same frame UNDECORATED — `repaint()`'s input.
   *
   * Two caches rather than one, because a repaint has to re-run `decorate` over
   * the ORIGINAL rows: painting an already-painted row would nest the selection
   * escapes and the highlight would never come off.
   */
  let rawPrev: string[] | null = null;
  /**
   * Whether any chunk has been seen at all.
   *
   * The session's FIRST write has `previousLineCount === 0`, so `eraseLines(0)`
   * is the empty string and the chunk carries no erase prefix (§3.2.1). That is
   * expected, not a desync, so it must not raise the §5.6 notice on every launch.
   * After it, every chunk Ink produces carries a prefix, so a prefix-less chunk
   * from then on really is foreign.
   */
  let seenAnyChunk = false;

  const counters: FrameWriterStats = {
    framesTotal: 0,
    framesDiffed: 0,
    framesFull: 0,
    linesWritten: 0,
    bytesWritten: 0,
    fallbacks: 0,
    repaints: 0,
  };

  /**
   * Re-entrancy guard for `onInvalidate`. The listener clears the selection,
   * which asks for a repaint, which can reach `invalidate()` again; one flag is
   * cheaper than reasoning about how deep that can go.
   */
  let notifying = false;

  const invalidate = (): void => {
    prev = null;
    rawPrev = null;
    if (notifying || !options.onInvalidate) return;
    notifying = true;
    try {
      options.onInvalidate();
    } finally {
      notifying = false;
    }
  };

  /**
   * `decorate`, with the line-count contract enforced. A decorator that returned
   * a different number of rows would shift every absolute address below it for
   * the rest of the session, so its answer is discarded rather than trusted.
   */
  const applyDecorate = (lines: string[]): string[] => {
    if (!options.decorate) return lines;
    const painted = options.decorate(lines);
    return painted.length === lines.length ? painted : lines;
  };

  /**
   * Write `chunk` verbatim — today's behaviour, and the only failure mode.
   *
   * `counted` is false for the two cases the differ inflicts on itself and knows
   * are harmless (the seed write, degenerate geometry); true means a foreign
   * write desynced absolute addressing, which is what `fallbacks` reports.
   */
  const passThrough = (counted: boolean): null => {
    invalidate();
    if (counted) {
      counters.fallbacks += 1;
      if (counters.fallbacks === 1) options.onFirstFallback?.();
    }
    return null;
  };

  const wrapSync = (payload: string): string =>
    options.sync ? SYNC_BEGIN + payload + SYNC_END : payload;

  const emit = (
    payload: string,
    lines: string[],
    raw: string[],
    addressed: number,
    full: boolean,
  ): string => {
    prev = lines;
    rawPrev = raw;
    counters.framesTotal += 1;
    if (full) counters.framesFull += 1;
    else counters.framesDiffed += 1;
    counters.linesWritten += addressed;
    counters.bytesWritten += payload.length;
    return payload;
  };

  /** `undefined` ⇒ the I-9 stand-down: a viewport too small to address safely. */
  const usableRows = (): number | undefined => {
    const rows = options.rows();
    if (rows === undefined || !Number.isFinite(rows)) return undefined;
    return rows < MIN_FULLSCREEN_ROWS ? undefined : rows;
  };

  const matchErasePrefix = (chunk: string): ErasePrefix | null => {
    if (prev !== null) {
      const expected = eraseLinesPrefix(prev.length + 1);
      if (chunk.startsWith(expected)) return { prefix: expected, erased: prev.length + 1 };
    }
    return matchInkErasePrefix(chunk);
  };

  /**
   * Full repaint — the first diffable frame of a session, every invalidation
   * (including the resize invalidation of I-8), and any line-count change.
   *
   * `CSI J` replaces the H+1 individual line erases with one sequence, and the
   * alternate screen is exactly the region being erased. `\r\n` rather than `\n`
   * is deliberate: Ink relies on the tty's `ONLCR` post-processing to turn `\n`
   * into CRLF, and that dependency is invisible until it is not there.
   *
   * P0-1's blank-then-paint objection does not apply here and the asymmetry with
   * the per-line path is deliberate: a full repaint rewrites every row, so there
   * is no unchanged content that has to survive, and full repaints are rare by
   * construction — one per session, one per resize, one per invalidation.
   */
  const fullRepaint = (lines: string[], raw: string[]): string => {
    const payload =
      cursorTo(1) +
      SGR_RESET +
      ERASE_DOWN +
      lines.join('\r\n') +
      '\r\n' +
      cursorTo(lines.length + 1);
    return emit(wrapSync(payload), lines, raw, lines.length, true);
  };

  /** Terminal width for this paint, or `undefined` when unknown (I-4: always EL). */
  const liveCols = (): number | undefined => {
    const cols = options.cols?.();
    return cols !== undefined && Number.isFinite(cols) ? cols : undefined;
  };

  const diffRepaint = (lines: string[], raw: string[], previous: string[]): string => {
    const out: string[] = [];
    const cols = liveCols();
    for (let i = 0; i < lines.length; i += 1) {
      // I-4: paint, THEN clear the tail. Never `ERASE_LINE` first.
      if (lines[i] !== previous[i]) out.push(paintLine(i + 1, lines[i]!, cols));
    }
    // DEFENSIVE ONLY, not a live path (P2-4). `log-update.js:13-15` returns early
    // on an identical frame, so a chunk that reaches here differs by at least one
    // line; the only way to observe zero is a cache that disagrees with the
    // screen, which is the state `invalidate()` exists to prevent.
    //
    // With a `decorate` hook it stops being unreachable in one direction and
    // stays correct: a frame whose RAW rows changed only where the highlight
    // already covers them paints identically, and writing nothing is right.
    if (out.length === 0) return emit('', lines, raw, 0, false);
    out.push(cursorTo(lines.length + 1)); // I-5
    return emit(wrapSync(out.join('')), lines, raw, out.length - 1, false);
  };

  /**
   * Re-paint the last frame's rows through `decorate` again, emitting only what
   * changed. Called when the SELECTION moved rather than when Ink produced a
   * frame — hence its own counter and no touch of the frame ones (P2-6).
   *
   * It carries the same DEC 2026 sync envelope and parks on row `H + 1` as every
   * other batch, because it is addressed exactly like a diff frame and a
   * half-applied highlight tears the same way a half-applied frame does.
   */
  const repaint = (): string => {
    if (prev === null || rawPrev === null) return '';
    const rows = usableRows();
    if (rows === undefined) return ''; // I-9 — geometry we cannot address safely
    if (rawPrev.length + 1 > rows) return '';

    const painted = applyDecorate(rawPrev);
    const out: string[] = [];
    const cols = liveCols();
    for (let i = 0; i < painted.length; i += 1) {
      if (painted[i] !== prev[i]) out.push(paintLine(i + 1, painted[i]!, cols));
    }
    prev = painted;
    if (out.length === 0) return '';
    out.push(cursorTo(painted.length + 1)); // I-5
    counters.repaints += 1;
    return wrapSync(out.join(''));
  };

  const transform = (chunk: string): string | null => {
    const firstChunk = !seenAnyChunk;
    seenAnyChunk = true;

    const rows = usableRows();
    if (rows === undefined) return passThrough(false); // I-9

    const matched = matchErasePrefix(chunk);
    // A prefix-less chunk is the session's seed write (P1-1) or a foreign one.
    if (matched === null) return passThrough(!firstChunk);

    const body = chunk.slice(matched.prefix.length);
    if (!body.endsWith('\n')) return passThrough(true); // `log.clear()` and friends

    const lines = body.slice(0, -1).split('\n');
    if (lines.length + 1 > rows) return passThrough(false); // I-9

    // AFTER the geometry stand-down, BEFORE the cache comparison: a frame this
    // module refuses to address never reaches the selection layer, and what is
    // compared below is what the screen will hold.
    const painted = applyDecorate(lines);

    if (prev === null || prev.length !== painted.length || matched.erased !== prev.length + 1) {
      return fullRepaint(painted, lines);
    }
    return diffRepaint(painted, lines, prev);
  };

  return {
    transform,
    invalidate,
    repaint,
    stats: () => ({ ...counters }),
  };
}
