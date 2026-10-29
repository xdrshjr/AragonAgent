/** Keep the newest thinking lines visible while an assistant entry streams. */

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
