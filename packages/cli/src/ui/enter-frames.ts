import { ENTER_NEWLINE_FRAME, PASTE_CLOSE, PASTE_OPEN } from '../input/limits.js';
import { sanitisePaste } from '../input/paste-parse.js';
import { sanitiseTyped } from './paste-frames.js';

export type ComposerFrame =
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'newline' }
  | { kind: 'submit' };

/** True when this `input` carries at least one Enter frame -- the branch guard. */
export function hasEnterFrame(input: string): boolean {
  return input.includes(ENTER_NEWLINE_FRAME);
}

/**
 * Split one paste-free span into ordered text, newline and submit intents.
 *
 * Every newline source -- frame or bare `\n` -- yields ONE
 * `{ kind: 'newline' }` segment, so the editor's existing `input`
 * action inserts it through the same path typing uses and the draft's row
 * budget applies unchanged. Non-newline text is accumulated and passed through
 * `sanitiseTyped` (I-14): a chunk that carries a frame can also carry the
 * keystrokes that arrived beside it, and a coalesced CR must not be spliced
 * back into the draft raw.
 */
function splitEnterSpan(span: string): ComposerFrame[] {
  const segments: ComposerFrame[] = [];
  let text = '';
  const pushText = (): void => {
    const clean = sanitiseTyped(text);
    if (clean.length > 0) segments.push({ kind: 'text', text: clean });
    text = '';
  };
  let i = 0;
  while (i < span.length) {
    if (span.startsWith(ENTER_NEWLINE_FRAME, i)) {
      pushText();
      segments.push({ kind: 'newline' });
      i += ENTER_NEWLINE_FRAME.length;
      continue;
    }
    if (span[i] === '\r') {
      pushText();
      segments.push({ kind: 'submit' });
      i += 1;
      continue;
    }
    if (span[i] === '\n') {
      pushText();
      segments.push({ kind: 'newline' });
      i += 1;
      continue;
    }
    text += span[i];
    i += 1;
  }
  pushText();
  return segments;
}

/**
 * Decode paste regions before interpreting CR/LF or newline frames as keys.
 * Paste IDs remain the caller's responsibility.
 */
export function splitEnterFrames(input: string): ComposerFrame[] {
  return input.includes(PASTE_OPEN)
    ? mergeWithPasteRuns(input, []) : splitEnterSpan(input);
}

/**
 * Merge newline runs with the paste frames that share the same `input`.
 *
 * Ink drains its buffer in one size-less `read()`, so the filter's TWO writes
 * (one per frame family) can arrive as ONE chunk carrying both a paste frame
 * and an Enter frame. Neither splitter alone preserves that order --
 * `splitPasteFrames` sanitises `\n` out of its text runs, and this module's
 * spans treat a paste payload as ordinary text -- so the merge walks the
 * ORIGINAL string once: paste frames become paste segments (payload through
 * `sanitisePaste`, as `splitPasteFrames` does), and the spans between them are
 * segmented with the SAME walker `splitEnterFrames` uses, which is what keeps
 * the two views from disagreeing about where a newline sits.
 *
 * Paste segments carry NO id here (P1-5); the caller assigns one per segment
 * only when it builds the reducer's action.
 */
export function mergeWithPasteRuns(input: string, runs: ComposerFrame[]): ComposerFrame[] {
  if (!input.includes(PASTE_OPEN)) return runs;
  const merged: ComposerFrame[] = [];
  let i = 0;
  while (i < input.length) {
    const open = input.indexOf(PASTE_OPEN, i);
    if (open === -1) {
      merged.push(...splitEnterSpan(input.slice(i)));
      break;
    }
    merged.push(...splitEnterSpan(input.slice(i, open)));
    const bodyStart = open + PASTE_OPEN.length;
    const close = input.indexOf(PASTE_CLOSE, bodyStart);
    const body = close === -1 ? input.slice(bodyStart) : input.slice(bodyStart, close);
    const payload = sanitisePaste(body);
    if (payload.length > 0) merged.push({ kind: 'paste', text: payload });
    if (close === -1) break;
    i = close + PASTE_CLOSE.length;
  }
  return merged;
}

/**
 * Remove every Enter frame for a consumer that has no newline model of its
 * own, replacing each frame with `'\n'` (tui-shift-enter-copy-queue 3.5, the
 * I-12 analogue for this frame family).
 *
 * NO OTHER SANITISATION, unlike `stripPasteFrames`: the overlay call sites wrap
 * this INSIDE their existing `stripPasteFrames(...)` call, and the composite
 * keeps that function's byte-level guarantees. Composed the other way round a
 * lone NUL frame would survive as its payload letter; composed this way the
 * frame's newline lands exactly where a bare Ctrl+J lands today.
 */
export function stripEnterFrames(input: string): string {
  if (!hasEnterFrame(input)) return input;
  return input.split(ENTER_NEWLINE_FRAME).join('\n');
}
