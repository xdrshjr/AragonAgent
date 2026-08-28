/**
 * Live-region clamp for INLINE render mode (tui-render-performance L5 / R6).
 *
 * Inline mode has no fixed frame, so nothing kept its live (non-`<Static>`)
 * region shorter than the terminal. When one live entry grew taller than
 * `stdout.rows`, Ink took the branch at `ink.js:118-123`:
 *
 *     if (outputHeight >= this.options.stdout.rows) {
 *       stdout.write(clearTerminal + this.fullStaticOutput + output);
 *     }
 *
 * `fullStaticOutput` accumulates EVERY `<Static>` frame of the whole session and
 * is never trimmed, so once that branch is taken it is taken on every subsequent
 * frame — bypassing both the `output !== lastOutput` dedupe and `throttledLog` —
 * and the terminal receives the entire session history thirty times a second.
 * That is a genuine hard freeze, and it is reachable today by any inline user
 * (`--no-fullscreen`, `TERM=dumb`, CI, a short or narrow terminal) whose model
 * writes a long answer.
 *
 * I-L5-1 — keeping the live region strictly below `stdout.rows` makes that
 * branch UNREACHABLE, which is the inline analogue of `frame.ts`'s
 * `frameHeight(r) < r` and deserves the same standing. We cannot bound Ink's
 * `fullStaticOutput` growth (it is private and append-only); preventing the
 * branch that WRITES it is the entire mitigation, and nothing about the memory
 * it holds is fixed by this module.
 *
 * Nothing is lost, only deferred: when the entry settles it moves into
 * `<Static>` and is printed in full.
 */

export interface LiveClamp {
  text: string;
  /** Rows dropped off the FRONT. `0` means the text was returned untouched. */
  hiddenRows: number;
}

/**
 * Keep the LAST `maxRows` rows of `text`; report how many were dropped.
 *
 * Rows, not wrapped display lines: this runs per frame on a streaming entry, and
 * a wrap-aware count would need the column width and a second full scan of a
 * string this function exists to avoid scanning twice.
 */
export function clampLiveText(text: string, maxRows: number): LiveClamp {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return { text: '', hiddenRows: rowCount(text) };
  const keep = Math.floor(maxRows);

  // Cheap reject: a string with fewer than `keep` newlines cannot have more than
  // `keep` rows, and this is the path every ordinary entry takes.
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) newlines += 1;
  }
  if (newlines + 1 <= keep) return { text, hiddenRows: 0 };

  // Walk back from the end to the `keep`-th newline rather than splitting the
  // whole string: the point of the clamp is to stop touching the head at all.
  let cut = text.length;
  let seen = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text.charCodeAt(i) === 10) {
      seen += 1;
      if (seen === keep) {
        cut = i + 1;
        break;
      }
    }
  }
  return { text: text.slice(cut), hiddenRows: newlines + 1 - keep };
}

function rowCount(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}
