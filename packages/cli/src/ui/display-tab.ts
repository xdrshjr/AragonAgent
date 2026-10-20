/**
 * TAB expansion that agrees with the TERMINAL, not with UTF-16 (fix A'-2 of
 * paste-control-sequence-residue).
 *
 * WHY THIS IS A MODULE OF ITS OWN. A TAB has no width; it advances the pen to
 * the next tab stop, so what it occupies depends on where the line currently
 * is. That makes "one TAB" a property of a CURSOR, and the same character was
 * being read three different ways in this package:
 *
 * - `ui/editor-navigation.ts` painted it at FOUR-column stops in the composer,
 * - `entries/UserEntry.tsx` handed the raw byte to `<Text>`, so the terminal
 *   painted it at EIGHT-column stops in the transcript,
 * - `tools/terminal-output.ts` expanded it by UTF-16 code-unit count, so a
 *   pasted `中文<TAB>X` table came out two columns short.
 *
 * A user who pastes a TAB-indented block or an Excel/Word table therefore saw
 * the draft and the sent message disagree about their own text. One function,
 * used by the composer AND by every renderer of stored text, is what makes the
 * "before send" and "after send" rows character-identical.
 *
 * `input/` is the wrong home for it: `cli/input` may depend on `node:stream`
 * and nothing else (`.claude-index/index.md`), and column arithmetic needs the
 * width table. `ui/` already owns that (`selection/selection.ts` uses
 * `string-width` for exactly this reason).
 *
 * Pure, React-free, Ink-free.
 */

import stringWidth from 'string-width';

/**
 * Tab stop width, matching every terminal's default.
 *
 * A COPY OF `tools/terminal-output.ts`'s number, on purpose and in the same
 * shape `composer-limits.ts` copies `budget.ts::HINT_MIN_ROWS`: importing the
 * tools module here would point an arrow from `ui/` into `tools/` for one
 * integer, and the two are asserted equal by a test instead. (`tools/` keeps
 * its own expander because its rows are clipped to 200 columns before anyone
 * looks at them, so a code-unit approximation there cannot reach a user.)
 */
export const TAB_WIDTH = 8;

/**
 * Expand every TAB in `text` to spaces up to the next `TAB_WIDTH` stop, given
 * the display column the first character will be painted at.
 *
 * `fromColumn` is a DISPLAY column, not an offset: a caller that has already
 * painted `中文` must pass 4. Lines are independent -- a `\n` resets the column
 * to zero, because the terminal's pen returns to column 0.
 *
 * Non-ASCII text is measured with `string-width`, which is the whole point: a
 * CJK glyph occupies two cells, and counting it as one space is what left
 * CJK-plus-TAB tables misaligned.
 */
export function expandTabs(text: string, fromColumn = 0): string {
  if (text.indexOf('\t') === -1) return text;
  let out = '';
  let column = Math.max(0, Math.floor(fromColumn));
  let run = '';
  for (const part of graphemesOf(text)) {
    if (part === '\t') {
      out += run;
      run = '';
      const width = TAB_WIDTH - (column % TAB_WIDTH);
      out += ' '.repeat(width);
      column += width;
      continue;
    }
    run += part;
    if (part === '\n') column = 0;
    else column += stringWidth(part);
  }
  return out + run;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Grapheme clusters rather than code units, so a combining mark or an emoji ZWJ
 * sequence advances the column once, exactly as the terminal draws it.
 */
function graphemesOf(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}
