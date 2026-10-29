/**
 * Chinese copy for the quick-prompt library (quick-prompt-library section 9.10).
 *
 * ASCII ONLY ON DISK. Every string below is written as `\uXXXX` escapes, the way
 * `ui/interaction-copy.ts` does it, because `src/prompts/**` and `src/ui/**` are
 * both inside `glyphs.test.ts::inScope` and that scanner rejects any raw non-ASCII
 * byte. The escapes are the point: the product speaks English in its chrome
 * (labels, footers, the overlays' own vocabulary) and the sentences that explain a
 * failure to THIS user are here, in one table, where a translator can find them
 * and where the API surfaces that build them cannot drift from each other.
 *
 * WHY ONE TABLE AND NOT STRINGS AT THE CALL SITES: the same failure is reported by
 * a toast, by a `/prompts` subcommand and by the editor's error row. Three copies
 * of one sentence is three wordings waiting to happen.
 */

import type { PromptSortKey, PromptWriteError } from './types.js';

/** `\u5df2\u586b\u5165\u300cx\u300d\uff088 \u884c\uff0c\u53ef\u7ee7\u7eed\u7f16\u8f91\uff09`. */
export function promptFilledCopy(title: string, lines: number): string {
  return `\u5df2\u586b\u5165\u300c${title}\u300d\uff08${lines} \u884c\uff0c\u53ef\u7ee7\u7eed\u7f16\u8f91\uff09`;
}

/** `\u5df2\u63d2\u5165\u5230\u5149\u6807\u5904\uff0c\u539f\u5185\u5bb9\u4fdd\u7559\u3002` */
export const PROMPT_INSERTED_COPY =
  '\u5df2\u63d2\u5165\u5230\u5149\u6807\u5904\uff0c\u539f\u5185\u5bb9\u4fdd\u7559\u3002';

/** `\u5df2\u4fdd\u5b58\u300cx\u300d` */
export function promptSavedCopy(title: string): string {
  return `\u5df2\u4fdd\u5b58\u300c${title}\u300d`;
}

/** `\u5df2\u5220\u9664\u300cx\u300d` */
export function promptDeletedCopy(title: string): string {
  return `\u5df2\u5220\u9664\u300c${title}\u300d`;
}

/** `\u5df2\u6536\u85cf\u300cx\u300d` / `\u5df2\u53d6\u6d88\u6536\u85cf\u300cx\u300d` */
export function promptFavoriteCopy(title: string, favorite: boolean): string {
  return favorite
    ? `\u5df2\u6536\u85cf\u300c${title}\u300d`
    : `\u5df2\u53d6\u6d88\u6536\u85cf\u300c${title}\u300d`;
}

/** `\u5df2\u628a\u300cx\u300d\u79fb\u52a8\u5230\u7b2c n \u4f4d\u3002` */
export function promptMovedCopy(title: string, to: number): string {
  return `\u5df2\u628a\u300c${title}\u300d\u79fb\u52a8\u5230\u7b2c ${to} \u4f4d\u3002`;
}

/** `\u5df2\u6309 name \u91cd\u6392\u5e76\u4fdd\u5b58\u3002` */
export function promptSortedCopy(key: PromptSortKey): string {
  return `\u5df2\u6309 ${key} \u91cd\u6392\u5e76\u4fdd\u5b58\u3002`;
}

/** The kill switch's honest answer (D-19 / AC-30). */
export const PROMPT_DISABLED_COPY =
  '\u63d0\u793a\u8bcd\u5e93\u5df2\u5173\u95ed\uff08prompts.enabled=false\uff09\u3002';

/** The port is absent - a test fixture or a build without the overlay. */
export const PROMPT_UNAVAILABLE_COPY =
  'Prompt library is not available in this build.';

/** `\u5e93\u6587\u4ef6\u635f\u574f\u2026\u4ee5\u7a7a\u5e93\u7ee7\u7eed` - the one-shot notice after a `.bak` repair (D-4). */
export const PROMPT_CORRUPT_COPY =
  '\u5e93\u6587\u4ef6\u635f\u574f\u6216\u683c\u5f0f\u4e0d\u7b26\uff0c\u5df2\u5907\u4efd\u4e3a quick-prompts.json.bak\uff0c\u672c\u6b21\u4ee5\u7a7a\u5e93\u7ee7\u7eed\u3002';

/** `\u5df2\u8df3\u8fc7 n \u6761\u65e0\u6cd5\u8bc6\u522b\u7684\u8bb0\u5f55\u3002` */
export function promptSkippedCopy(count: number): string {
  return `\u5df2\u8df3\u8fc7 ${count} \u6761\u65e0\u6cd5\u8bc6\u522b\u7684\u8bb0\u5f55\u3002`;
}

/**
 * `\u5df2\u5e94\u7528\uff0c\u4f46\u5199\u5165\u78c1\u76d8\u5931\u8d25\uff1b\u9000\u51fa\u540e\u53ef\u80fd\u4e22\u5931\u3002` (D-4: never roll back memory).
 *
 * ONE SENTENCE for `write_failed`, and it says BOTH halves: that the change is in effect
 * and that it may not survive the process. A shorter "write failed" would read as
 * "nothing happened", which is the one thing this path does not do.
 */
export const PROMPT_WRITE_FAILED_COPY =
  '\u5df2\u5e94\u7528\uff0c\u4f46\u5199\u5165\u78c1\u76d8\u5931\u8d25\uff1b\u9000\u51fa\u540e\u53ef\u80fd\u4e22\u5931\u3002';

/** `\u627e\u4e0d\u5230\u300cx\u300d\u5bf9\u5e94\u7684\u63d0\u793a\u8bcd\u3002` */
export function promptNotFoundCopy(ref: string): string {
  return `\u627e\u4e0d\u5230\u300c${ref}\u300d\u5bf9\u5e94\u7684\u63d0\u793a\u8bcd\u3002`;
}

/**
 * `\u300cx\u300d\u5339\u914d n \u6761\uff0c\u8bf7\u7528\u5e8f\u53f7\uff1a\u2026` (D-22).
 *
 * THE CANDIDATES ARE THE WHOLE POINT of this message: without them the user knows
 * only that their command failed, and the next thing they try is the same command.
 */
export function promptAmbiguousCopy(ref: string, candidates: readonly string[]): string {
  const list = candidates.join('\u3001');
  return `\u300c${ref}\u300d\u5339\u914d ${candidates.length} \u6761\uff0c\u8bf7\u7528\u5e8f\u53f7\uff1a${list}`;
}

/** Printed above a body that is about to enter the transcript (D-17). */
export const PROMPT_SHOW_WARNING_COPY =
  '\u4ee5\u4e0b\u6b63\u6587\u5c06\u8fdb\u5165\u4f1a\u8bdd\u8bb0\u5f55\uff08/save \u4f1a\u5bfc\u51fa\u5b83\uff09\u3002';

/** `\u5c06\u5220\u9664\u300cx\u300d\u2026\u786e\u8ba4\u8bf7\u518d\u6267\u884c\u4e00\u6b21\uff1a/prompts rm x --yes` (D-13). */
export function promptRmConfirmCopy(title: string, ref: string): string {
  return `\u5c06\u5220\u9664\u300c${title}\u300d\u3002\u6b64\u64cd\u4f5c\u4e0d\u53ef\u64a4\u9500\uff1b\u786e\u8ba4\u8bf7\u518d\u6267\u884c\u4e00\u6b21\uff1a/prompts rm ${ref} --yes`;
}

/** `\u76ee\u6807\u4f4d\u7f6e n \u8d85\u51fa\u8303\u56f4\uff081-m\uff09\u3002` */
export function promptMoveRangeCopy(to: number, max: number): string {
  return `\u76ee\u6807\u4f4d\u7f6e ${to} \u8d85\u51fa\u8303\u56f4\uff081-${max}\uff09\u3002`;
}

/** `\u65e0\u6548\u7684\u6392\u5e8f\u65b9\u5f0f\u300cx\u300d\uff0c\u53ef\u7528 name / recent / favorite\u3002` */
export function promptInvalidSortCopy(raw: string): string {
  return `\u65e0\u6548\u7684\u6392\u5e8f\u65b9\u5f0f\u300c${raw}\u300d\uff0c\u53ef\u7528 name / recent / favorite\u3002`;
}

/** `\u63d0\u793a\u8bcd\u5e93\u4e3a\u7a7a\uff0c\u7528 /prompts add \u65b0\u5efa\u4e00\u6761\u3002` */
export const PROMPT_LIST_EMPTY_COPY =
  '\u63d0\u793a\u8bcd\u5e93\u4e3a\u7a7a\uff0c\u7528 /prompts add \u65b0\u5efa\u4e00\u6761\u3002';

/** The reminder that a body typed on a command line lands in `prompt-history`. */
export const PROMPT_HISTORY_REMINDER_COPY =
  '\u63d0\u793a\uff1a\u5199\u5728\u547d\u4ee4\u884c\u91cc\u7684\u6b63\u6587\u4f1a\u8fdb\u5165 prompt-history\uff1b\u63a8\u8350\u7528 /prompts add \u540e\u5728\u7f16\u8f91\u5668\u91cc\u8f93\u5165\u3002';

/** `\u5df2\u5220\u9664\u300cx\u300d` is reused for the `--yes` path; this is the "nothing happened" half. */
export const PROMPT_UNKNOWN_SUBCOMMAND_COPY =
  '\u672a\u77e5\u5b50\u547d\u4ee4\u3002\u53ef\u7528\uff1alist / show / add / edit / rm / move / favorite / sort / manage\u3002';

/**
 * The one-shot key-migration notice (D-20 / AC-32).
 *
 * `Ctrl+N` IS SPELLED OUT IN FULL, never `^N` (P1-7): `^N` is already this
 * product's word for "transcript line offset" (the header's scroll chip and the
 * help overlay's `^N` row), so the abbreviation would be a second meaning for the
 * same glyph in the same product.
 */
export const PROMPT_KEY_NOTICE_COPY =
  'Ctrl+P \u73b0\u5728\u6253\u5f00\u63d0\u793a\u8bcd\u5e93\uff1b\u5207\u6362 BUILD/PLAN \u8bf7\u7528 Shift+Tab \u6216 Ctrl+N\uff08\u6216 /plan\uff09\u3002';

/** The library page's empty state (the list page draws this instead of nothing). */
export const PROMPT_EMPTY_TITLE_COPY = 'No prompts yet.';
export const PROMPT_EMPTY_BODY_COPY = 'Press a to create your first prompt.';

/** `\uff08\u5171 n \u6761\uff09` suffix for `/prompts list`. */
export function promptListFooterCopy(count: number): string {
  return `\uff08\u5171 ${count} \u6761\uff09`;
}

/**
 * One sentence per stable error code (D-12). THE CODE IS THE CONTRACT; this table is
 * the only place it becomes words, so the editor's title row, the list's toast and a
 * command's refusal cannot describe the same failure three different ways.
 */
export function promptErrorCopy(code: PromptWriteError): string {
  switch (code) {
    case 'title_required': return '\u6807\u9898\u4e0d\u80fd\u4e3a\u7a7a';
    case 'content_required': return '\u6b63\u6587\u4e0d\u80fd\u4e3a\u7a7a';
    case 'title_too_long': return '\u6807\u9898\u8d85\u8fc7 80 \u5b57';
    case 'content_too_long': return '\u6b63\u6587\u8d85\u8fc7 8000 \u5b57';
    case 'description_too_long': return '\u63cf\u8ff0\u8d85\u8fc7 200 \u5b57';
    case 'tag_too_long': return '\u6807\u7b7e\u8d85\u8fc7 24 \u5b57';
    case 'too_many_tags': return '\u6807\u7b7e\u6700\u591a 6 \u4e2a';
    case 'too_many_prompts': return '\u6700\u591a 200 \u6761\uff0c\u8bf7\u5148\u5220\u9664';
    case 'not_found': return '\u627e\u4e0d\u5230\u8be5\u63d0\u793a\u8bcd';
    case 'ambiguous': return '\u5339\u914d\u5230\u591a\u6761\uff0c\u8bf7\u7528\u5e8f\u53f7';
    case 'write_failed': return PROMPT_WRITE_FAILED_COPY;
  }
}
