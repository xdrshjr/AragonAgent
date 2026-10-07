/**
 * Enter-frame splitting and the I-12 analogue for this frame family
 * (tui-shift-enter-copy-queue §3.5 / §9).
 *
 * The failures this file guards are invisible on screen: a NUL stored in an
 * overlay field renders as nothing and breaks authentication later, and a
 * newline that lands in the wrong ORDER turns a pasted block into interleaved
 * garbage. Both are asserted on exact strings.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTER_NEWLINE_FRAME, PASTE_CLOSE, PASTE_OPEN } from '../input/limits.js';
import {
  hasEnterFrame,
  mergeWithPasteRuns,
  splitEnterFrames,
  stripEnterFrames,
} from '../ui/enter-frames.js';
import { stripPasteFrames } from '../ui/paste-frames.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NL = '\n';

describe('hasEnterFrame (the branch guard)', () => {
  it('is true only for the frame', () => {
    expect(hasEnterFrame(ENTER_NEWLINE_FRAME)).toBe(true);
    expect(hasEnterFrame(`a${ENTER_NEWLINE_FRAME}b`)).toBe(true);
    expect(hasEnterFrame('ab')).toBe(false);
    expect(hasEnterFrame('\n')).toBe(false);
    // A paste frame is NOT an enter frame; the composer branch handles those
    // first, and this guard must not reach for them.
    expect(hasEnterFrame(`${PASTE_OPEN}x${PASTE_CLOSE}`)).toBe(false);
  });
});

describe('splitEnterFrames', () => {
  it('turns one frame into one newline segment', () => {
    expect(splitEnterFrames(`a${ENTER_NEWLINE_FRAME}b`)).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'newline' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('turns a bare LF (Ctrl+J) into the same segment', () => {
    expect(splitEnterFrames('a\nb')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'newline' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('keeps both sources in byte order when they share one chunk', () => {
    // Ink drains its buffer in ONE read: the filter's two writes for a
    // Shift+Enter and a following Ctrl+J arrive as one `input`.
    expect(splitEnterFrames(`${ENTER_NEWLINE_FRAME}x\n`)).toEqual([
      { kind: 'newline' },
      { kind: 'text', text: 'x' },
      { kind: 'newline' },
    ]);
  });

  it('保留换行帧后合并到达的提交意图', () => {
    // A user who presses Enter inside the same event-loop turn as the
    // Shift+Enter delivers `frame + "\r"`; splicing the CR verbatim puts a raw
    // control byte back into the draft.
    expect(splitEnterFrames(`${ENTER_NEWLINE_FRAME}\r`)).toEqual([
      { kind: 'newline' },
      { kind: 'submit' },
    ]);
  });

  it('drops a stray unmatched NUL instead of storing it', () => {
    expect(splitEnterFrames('a\u0000b')).toEqual([{ kind: 'text', text: 'ab' }]);
  });
});

describe('mergeWithPasteRuns (one chunk, both frame families)', () => {
  it('interleaves newline segments and paste frames in byte order', () => {
    const input = `a${ENTER_NEWLINE_FRAME}${PASTE_OPEN}P${PASTE_CLOSE}b`;
    expect(mergeWithPasteRuns(input, splitEnterFrames(input))).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'newline' },
      { kind: 'paste', text: 'P' },
      { kind: 'text', text: 'b' },
    ]);
  });

  it('keeps a newline that arrives AFTER a paste frame in the same chunk', () => {
    const input = `${PASTE_OPEN}P${PASTE_CLOSE}${ENTER_NEWLINE_FRAME}`;
    expect(mergeWithPasteRuns(input, splitEnterFrames(input))).toEqual([
      { kind: 'paste', text: 'P' },
      { kind: 'newline' },
    ]);
  });

  it('returns the runs untouched when there is no paste frame (the common key)', () => {
    const runs = splitEnterFrames(`a${ENTER_NEWLINE_FRAME}`);
    expect(mergeWithPasteRuns(`a${ENTER_NEWLINE_FRAME}`, runs)).toBe(runs);
  });

  it('never allocates a paste id (P1-5: the caller does, at dispatch build time)', () => {
    const input = `${PASTE_OPEN}P${PASTE_CLOSE}`;
    const merged = mergeWithPasteRuns(input, splitEnterFrames(input));
    expect(Object.keys(merged[0]!)).not.toContain('id');
  });
});

describe('stripEnterFrames (the overlay guard, I-12 analogue)', () => {
  it('replaces each frame with a newline', () => {
    expect(stripEnterFrames(`a${ENTER_NEWLINE_FRAME}b${ENTER_NEWLINE_FRAME}`)).toBe('a\nb\n');
  });

  it('returns the input untouched when there is no frame', () => {
    expect(stripEnterFrames('plain')).toBe('plain');
    expect(stripEnterFrames('\n')).toBe('\n');
  });

  it('composes with stripPasteFrames leaving no NUL in the stored value', () => {
    // The composition ORDER the overlays use: enter strip INSIDE the paste
    // strip. Reversed, the paste strip's NUL removal would expose the frame's
    // letter as visible text; this order the outer sanitiser simply drops the
    // newline for a single-line field, exactly as it drops a bare Ctrl+J.
    const key = `sk-ant-${'a1b2c3d4'.repeat(11)}`;
    const composite = stripPasteFrames(
      stripEnterFrames(`${ENTER_NEWLINE_FRAME}${PASTE_OPEN}${key}${PASTE_CLOSE}`),
    );
    expect(composite).toBe(key);
    expect(composite).not.toContain('\u0000');
  });
});

// ---------------------------------------------------------------------------
// The overlay scan: a useInput consumer that appends `input` to a string must
// route it through BOTH strips -- same reasoning as `paste-frames.test.ts`'s
// I-12 scan, one frame family later.
// ---------------------------------------------------------------------------

describe('I-12 analogue: the three text-accumulating overlays strip enter frames', () => {
  it('all three compose the strips in the enter-first order', () => {
    for (const rel of [
      'ui/overlays/SettingsScreen.tsx',
      'ui/overlays/QuestionOverlay.tsx',
      'ui/overlays/PlanReviewOverlay.tsx',
    ]) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, rel).toContain('stripPasteFrames(stripEnterFrames(input))');
    }
  });
});
