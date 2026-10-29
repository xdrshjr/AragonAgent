/**
 * Key-intent frames that must never land in a text field.
 *
 * WHY THIS EXISTS. `App` and every text-entry surface are SEPARATE `useInput`
 * listeners, and each receives the same `input`. `App` handling a frame (and
 * returning) does not stop a Settings text field, the prompt editor or the
 * question overlay from also seeing it, and none of those is NUL-aware -- so a
 * mistyped Ctrl+Shift+P used to be able to write `\0d` into a model name that is
 * then persisted. Every surface that writes `input` into string state calls
 * `stripKeyFrames` first and returns when nothing is left.
 *
 * `ENTER_NEWLINE_FRAME` is deliberately NOT stripped here: it has its own
 * meaning in the composer (a newline) and its own splitter.
 */

import { DEV_MODE_KEY_FRAME, INDEX_KEY_FRAME } from './limits.js';

/** Remove the INDEX and DEV_MODE key frames from `input`. Total; never throws. */
export function stripKeyFrames(input: string): string {
  if (input.length === 0 || !input.includes('\u0000')) return input;
  return input.split(INDEX_KEY_FRAME).join('').split(DEV_MODE_KEY_FRAME).join('');
}

/** True when `input` carries a frame `stripKeyFrames` would remove. */
export function hasKeyFrame(input: string): boolean {
  return input.includes(INDEX_KEY_FRAME) || input.includes(DEV_MODE_KEY_FRAME);
}
