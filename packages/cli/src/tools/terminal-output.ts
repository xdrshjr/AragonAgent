/**
 * Raw child-process output to terminal-safe rows (agent-activity-presentation-live
 * L2 / §3.2).
 *
 * NOTHING ELSE IN THIS TREE STRIPS ANSI (E-13). `renderBash` hands each line to
 * `<Text>` unmodified (`ui/entries/ToolPreview.tsx:180`), and that survives only
 * because the settled preview is printed ONCE, after the command has stopped
 * writing. Redraw the same text every frame while the child is still emitting
 * `\r`-rewritten progress bars and `\x1b[A` cursor moves and it stops being
 * survivable: the terminal honours cursor motion Ink does not know it emitted,
 * and `wrappedRows` measures escape bytes as if they were columns.
 *
 * So this module is the boundary. It runs ONCE, inside the store's `append`
 * (§3.1.1), and every reader downstream is already safe.
 *
 * Pure, ASCII-only, React-free, Ink-free, and TOTAL: `sanitizeChunk` never
 * throws, for any input including lone surrogates, NUL bytes, a chunk consisting
 * solely of `\x1b`, and a 4 MB chunk containing no `\n` at all.
 *
 * D-27 — IT STRIPS, IT DOES NOT INTERPRET. Keeping colour would mean validating
 * it (an unterminated SGR leaks its attribute into the rest of the frame), and
 * interpreting cursor motion would mean owning a screen buffer. Neither is a
 * presentation round's job.
 */

/** Columns a live row may occupy before it is clipped. */
export const LIVE_ROW_MAX_CHARS = 200;

/** Tab stop width, matching every terminal's default. */
export const TAB_WIDTH = 8;

/**
 * The in-progress line's ceiling before it is flushed as a row (§3.2 step 7).
 *
 * AFTER STEP 4 THIS IS A RARE PATH RATHER THAN THE PROGRESS-BAR PATH (D-33). A
 * `\r`-rewritten bar collapses to one row however many times it is redrawn, so
 * reaching 400 characters with no `\n` requires a line that is genuinely that
 * long -- `cat` on a minified bundle. Without the bound the carry is an
 * unbounded accumulator.
 */
export const CARRY_MAX_CHARS = LIVE_ROW_MAX_CHARS * 2;

/**
 * Appended to a row clipped at `LIVE_ROW_MAX_CHARS`.
 *
 * SPELLED HERE RATHER THAN IMPORTED from `agent/reducer.ts`, the rule
 * `patch.ts:95-103` already states for the identical string: `tools/` keeps no
 * runtime dependency on the view model for three characters, and
 * `terminal-output.test.ts` asserts the spellings are equal so the pair cannot
 * drift silently.
 */
export const TRUNCATION_MARK = '...';

/**
 * How far back a trailing incomplete escape may start.
 *
 * A chunk can split mid-escape, and the next chunk completes it -- so the tail
 * of an unfinished sequence must survive in the carry rather than being stripped
 * down to its visible remainder (`\x1b[` would otherwise render as a bare `[`).
 * The lookback is bounded because an "escape" that has run for 64 characters
 * without a final byte is not an escape, it is a byte that happened to be 0x1b,
 * and holding it forever would pin the carry.
 */
const MAX_PARTIAL_ESCAPE = 64;

export interface SanitizeResult {
  /** Complete rows, terminal-safe, in order. Each at most `LIVE_ROW_MAX_CHARS` (+ mark). */
  rows: string[];
  /**
   * The in-progress line: stripped, `\r`-collapsed and tab-expanded, bounded by
   * `CARRY_MAX_CHARS`.
   *
   * THIS IS STATE, NOT A ROW, and the difference is load-bearing. It is threaded
   * back into the next `sanitizeChunk` call verbatim, so it is deliberately NOT
   * clipped (a `'...'` spliced into the middle of a line the command is still
   * writing would then be overwritten INTO the stream) and it may carry a
   * trailing incomplete escape awaiting its final byte. Render it with
   * `toDisplayRow`, never directly.
   */
  carry: string;
}

/** CSI: `\x1b[` params intermediates final. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** OSC: `\x1b]` ... terminated by BEL or ST. */
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
/** The two-byte forms: `\x1b` followed by one character. */
const ESC_PAIR = /\x1b[\s\S]/g;
/** C1, plus every C0 control except `\t` `\n` `\r`. */
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Remove every escape sequence and control byte except `\t` `\n` `\r`.
 *
 * Exported for the tests, and used by `toDisplayRow` as the second line of
 * defence over a carry that ends mid-escape.
 */
export function stripAnsi(text: string): string {
  return text.replace(CSI, '').replace(OSC, '').replace(ESC_PAIR, '').replace(CONTROLS, '');
}

/**
 * Index at which a trailing INCOMPLETE escape begins, or `-1`.
 *
 * Only the last `\x1b` can be incomplete: anything before it is either a
 * complete sequence (the regexes above consume it) or a stray byte the control
 * strip removes.
 */
function partialEscapeStart(text: string): number {
  const at = text.lastIndexOf('\x1b');
  if (at === -1 || text.length - at > MAX_PARTIAL_ESCAPE) return -1;
  const rest = text.slice(at);
  // A lone ESC at the very end: the next chunk decides what it is.
  if (rest.length === 1) return at;
  // An opened CSI/OSC is incomplete exactly when its own regex does not match
  // from here -- `\x1b[1;3` has no final byte yet, `\x1b]0;title` no terminator.
  if (rest[1] === '[') return /^\x1b\[[0-?]*[ -/]*[@-~]/.test(rest) ? -1 : at;
  if (rest[1] === ']') return /^\x1b\][\s\S]*?(?:\x07|\x1b\\)/.test(rest) ? -1 : at;
  // Any other two-byte form is already complete.
  return -1;
}

/**
 * Apply `\r` as the LINE REWRITE it is (§3.2 step 4 / D-33).
 *
 * A piece containing `\r` is a sequence of overwrites, so the later segment
 * replaces the earlier one's PREFIX and anything the earlier one had beyond it
 * survives -- which is what a real terminal shows, and what keeps R-6's classic
 * `\r`-only tooling from losing content. A thousand progress-bar rewrites
 * collapse to one row holding the final state.
 */
export function applyCarriageReturns(piece: string): string {
  if (piece.indexOf('\r') === -1) return piece;
  return piece.split('\r').reduce((acc, s) => s + acc.slice(s.length), '');
}

/** Expand tabs to the next multiple of `TAB_WIDTH`. */
export function expandTabs(row: string): string {
  if (row.indexOf('\t') === -1) return row;
  let out = '';
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === '\t') out += ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH));
    else out += ch;
  }
  return out;
}

/** Clip a row at `LIVE_ROW_MAX_CHARS`, marking the cut. */
export function clipRow(row: string): string {
  return row.length <= LIVE_ROW_MAX_CHARS
    ? row
    : `${row.slice(0, LIVE_ROW_MAX_CHARS)}${TRUNCATION_MARK}`;
}

/**
 * The carry as a RENDERED row: the held-back incomplete escape removed, then
 * stripped and clipped.
 *
 * THE PARTIAL MUST BE CUT OFF, NOT STRIPPED (AC-24). `stripAnsi` alone is not
 * enough and fails in the visible direction: its two-byte rule consumes the
 * `\x1b[` of an unfinished CSI and leaves the PARAMETERS behind, so a chunk that
 * split inside `\x1b[31m` renders as `red 3`. The bytes are held for the next
 * chunk to complete; until then they are not text.
 */
export function toDisplayRow(carry: string): string {
  const at = partialEscapeStart(carry);
  return clipRow(stripAnsi(at === -1 ? carry : carry.slice(0, at)));
}

/**
 * Tab expansion is column arithmetic, so it cannot be done after the clip -- but
 * it also need not run over four megabytes to decide the first 200 columns.
 * Every character occupies at least one column, so a `CARRY_MAX_CHARS` prefix
 * covers every column the clip can keep.
 */
function expandTabsForDisplay(piece: string): string {
  return piece.length <= CARRY_MAX_CHARS
    ? expandTabs(piece)
    : expandTabs(piece.slice(0, CARRY_MAX_CHARS));
}

/**
 * Turn a raw chunk into complete rows plus the in-progress line.
 *
 * The order of the steps IS the specification (§3.2), and step 4's "every piece,
 * THE INCOMPLETE TAIL INCLUDED" is the whole of P0-1: a progress bar emits no
 * `\n` for its entire run, so a rule that collapsed only completed lines would
 * never run for npm, pip, curl, docker or any other `\r` writer -- the tail
 * would stay empty, `showLive` false, and the card the single `running` row this
 * round exists to replace.
 */
export function sanitizeChunk(carry: string, chunk: string): SanitizeResult {
  const text = (typeof carry === 'string' ? carry : '') + (typeof chunk === 'string' ? chunk : '');
  if (text.length === 0) return { rows: [], carry: '' };

  // 1-2. Concatenate and strip, holding back an escape the next chunk finishes.
  const partialAt = partialEscapeStart(text);
  const held = partialAt === -1 ? '' : text.slice(partialAt);
  const clean = stripAnsi(partialAt === -1 ? text : text.slice(0, partialAt));

  // 3. Split: the first n-1 pieces are complete rows, the last is the tail.
  const pieces = clean.split('\n');
  const rows: string[] = [];
  for (let i = 0; i < pieces.length - 1; i += 1) {
    // 4-6. Collapse, expand, clip.
    rows.push(clipRow(expandTabsForDisplay(applyCarriageReturns(pieces[i]!))));
  }

  const rawTail = applyCarriageReturns(pieces[pieces.length - 1]!);
  const tail = expandTabsForDisplay(rawTail);

  // 7. Bound the carry. The held escape survives the flush: it belongs to the
  // NEXT row, and dropping it here would corrupt the sequence it opened.
  //
  // BOTH LENGTHS ARE TESTED, and testing only the expanded one is the bug:
  // `expandTabsForDisplay` truncates its input at `CARRY_MAX_CHARS`, so a
  // megabyte-long line would sit at exactly the bound forever and never flush.
  if (rawTail.length > CARRY_MAX_CHARS || tail.length > CARRY_MAX_CHARS) {
    rows.push(clipRow(tail));
    return { rows, carry: held };
  }
  return { rows, carry: tail + held };
}
