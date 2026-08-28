/**
 * Reading paste frames back out of an Ink `input` string
 * (tui-paste-handling section 5.4) -- pure.
 *
 * The stdin filter writes `PASTE_OPEN + payload + PASTE_CLOSE` inline, in stream
 * order (I-5). This module is the only place that takes those markers apart.
 */

import { PASTE_CLOSE, PASTE_OPEN } from '../input/limits.js';
import { sanitisePaste } from '../input/paste-parse.js';

export interface FrameTextSegment {
  readonly kind: 'text';
  readonly text: string;
}

export interface FramePasteSegment {
  readonly kind: 'paste';
  readonly text: string;
}

/**
 * A run of one `input` string.
 *
 * NO `id` HERE. The paste id is allocated by `PromptInput` while it builds the
 * reducer's action, never by this function and never by the reducer (P1-5), so
 * the split stays a pure function of its argument and `paste-frames.test.ts` can
 * assert on its output.
 */
export type FrameSegment = FrameTextSegment | FramePasteSegment;

/**
 * Remove every C0 byte, DEL and C1 byte from text that arrived OUTSIDE a frame
 * (I-14). NO CR -> LF conversion, and that omission is the point.
 *
 * WHY THIS IS NOT OPTIONAL. Ink drains its whole buffer in one size-less
 * `read()` (`App.js:135`), so the `input` string carrying a frame can also carry
 * the keystroke bytes that arrived beside it -- most often the `\r` of a user who
 * pastes and immediately presses Enter, since Ink's 32 ms render throttle and a
 * large transcript's Yoga pass both outlast the filter's 15 ms burst window.
 * Splicing that run in verbatim puts a raw CR back into the draft and re-opens
 * the corruption this whole feature exists to remove.
 *
 * Note what it does NOT do. It does not turn a coalesced `\r` into a newline and
 * it does not submit: a keystroke that merged with a frame has already lost its
 * identity as a key (`parseKeypress` saw the concatenation, not the key), so the
 * only two honest options are "insert something wrong" and "drop it". Dropping is
 * recoverable and benign -- the user presses Enter again -- while inserting a
 * control byte is not. Printable characters survive untouched.
 */
export function sanitiseTyped(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

/**
 * Split an `input` string into ordered text runs and paste runs.
 *
 * Text runs are returned already through `sanitiseTyped` (I-14); paste runs are
 * returned through `sanitisePaste`, which keeps TAB and `\n` because they are
 * content inside a payload.
 *
 * RE-SANITISING THE PAYLOAD IS DEFENCE IN DEPTH, NOT A SECOND OPINION. The
 * filter already ran `sanitisePaste` and it is idempotent, so the normal path is
 * byte-identical. What it buys is that G2 ("no pasted byte is ever executed as a
 * terminal control") becomes a property of the COMPOSER rather than a property
 * of whoever produced the frame -- which matters for the branch below, where an
 * unmatched `PASTE_OPEN` turns arbitrary trailing bytes into a paste segment.
 *
 * An unmatched `PASTE_OPEN` -- impossible from our own filter, but cheap to
 * survive -- yields its remainder as a paste segment rather than leaking NULs.
 */
export function splitPasteFrames(input: string): FrameSegment[] {
  const segments: FrameSegment[] = [];
  const pushText = (raw: string): void => {
    const text = sanitiseTyped(raw);
    if (text.length > 0) segments.push({ kind: 'text', text });
  };
  const pushPaste = (raw: string): void => {
    const text = sanitisePaste(raw);
    if (text.length > 0) segments.push({ kind: 'paste', text });
  };

  let i = 0;
  while (i < input.length) {
    const open = input.indexOf(PASTE_OPEN, i);
    if (open === -1) {
      pushText(input.slice(i));
      break;
    }
    pushText(input.slice(i, open));
    const bodyStart = open + PASTE_OPEN.length;
    const close = input.indexOf(PASTE_CLOSE, bodyStart);
    if (close === -1) {
      pushPaste(input.slice(bodyStart));
      break;
    }
    pushPaste(input.slice(bodyStart, close));
    i = close + PASTE_CLOSE.length;
  }
  return segments;
}

/** True when this `input` carries at least one frame -- the branch guard. */
export function hasPasteFrame(input: string): boolean {
  return input.includes(PASTE_OPEN);
}

/**
 * Turn a possibly-framed `input` into plain text for a consumer that has no
 * paste model of its own: unwrap the frames, keep the payload, drop the markers,
 * and run BOTH halves through `sanitiseTyped`.
 *
 * ANY `useInput` CONSUMER THAT APPENDS `input` TO A STRING MUST CALL THIS (I-12),
 * and the list is pinned by a source scan rather than by review discipline
 * because the failure is invisible: NUL renders as nothing.
 *
 * `useInput` is a BROADCAST -- `use-input.js` re-emits every chunk to every
 * mounted handler -- so `SettingsScreen` and `QuestionOverlay` see the frame the
 * composer was sent. An API key is ~100 characters with no line break, which trips
 * Tier 2's burst rule and gets framed; nothing downstream removes the NULs
 * (`String.prototype.trim()` does not treat U+0000 as whitespace), the field is
 * rendered through `maskDot` so the damage is invisible, and the value is handed
 * to `registerSecret()` and `controller.setApiKey()`. The user is told the
 * settings were saved and every request afterwards fails to authenticate with
 * nothing on screen to explain it.
 *
 * This is strictly better than v0.6.3 for both consumers: a pasted key carrying a
 * stray CR or an ANSI sequence is now cleaned rather than stored raw.
 */
export function stripPasteFrames(input: string): string {
  if (!hasPasteFrame(input)) return sanitiseTyped(input);
  return splitPasteFrames(input)
    .map((segment) => (segment.kind === 'paste' ? sanitiseTyped(segment.text) : segment.text))
    .join('');
}
