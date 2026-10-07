/**
 * Frame splitting and the two P0 guards (tui-paste-handling section 5.4 /
 * 5.4.1, T-5 / T-30 / T-31).
 *
 * BOTH FAILURES THIS FILE GUARDS ARE INVISIBLE ON SCREEN. A surviving `\r`
 * overwrites the row it lands on, so the evidence is destroyed by the defect
 * itself; a surviving NUL renders as nothing at all, and then travels into the
 * config file. Neither is reachable by looking at a frame.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASTE_CLOSE, PASTE_OPEN } from '../input/limits.js';
import { stripComments } from './glyphs.test.js';
import {
  hasPasteFrame,
  sanitiseTyped,
  splitPasteFrames,
  stripPasteFrames,
} from '../ui/paste-frames.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('splitPasteFrames (T-5)', () => {
  it('preserves ORDER across a mixed chunk — the guarantee D-3 buys', () => {
    // A side-channel emit would apply the paste BEFORE the text that preceded it
    // in the same chunk. Framing makes the order a property of the bytes.
    expect(splitPasteFrames(`abc${PASTE_OPEN}X\nY${PASTE_CLOSE}def`)).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'paste', text: 'X\nY' },
      { kind: 'text', text: 'def' },
    ]);
  });

  it('reads two frames in one chunk', () => {
    expect(
      splitPasteFrames(`${PASTE_OPEN}one${PASTE_CLOSE}${PASTE_OPEN}two${PASTE_CLOSE}`),
    ).toEqual([
      { kind: 'paste', text: 'one' },
      { kind: 'paste', text: 'two' },
    ]);
  });

  it('survives an unmatched open marker rather than leaking NULs', () => {
    expect(splitPasteFrames(`${PASTE_OPEN}tail`)).toEqual([{ kind: 'paste', text: 'tail' }]);
  });

  it('returns plain text unchanged and reports no frame', () => {
    expect(hasPasteFrame('hello')).toBe(false);
    expect(splitPasteFrames('hello')).toEqual([{ kind: 'text', text: 'hello' }]);
  });
});

describe('sanitiseTyped — the coalescing guard (T-31 / I-14 / P1-1)', () => {
  it('drops a CR that rode in beside a frame, and never turns it into a newline', () => {
    // Ink drains its whole buffer in ONE `read()`, so a user who pastes and
    // presses Enter inside the 15 ms burst window delivers `frame + "\r"` as a
    // single `input`. Splicing that run in verbatim puts a raw CR back into the
    // draft — defect B, returning through the branch added to close it.
    const segments = splitPasteFrames(`${PASTE_OPEN}a\nb${PASTE_CLOSE}\r`);
    expect(segments).toEqual([{ kind: 'paste', text: 'a\nb' }]);
    expect(sanitiseTyped('\r')).toBe('');
  });

  it('drops a coalesced arrow key the same way', () => {
    const segments = splitPasteFrames(`${PASTE_OPEN}a\nb${PASTE_CLOSE}\x1b[A`);
    expect(segments.filter((s) => s.kind === 'text')).toEqual([{ kind: 'text', text: '[A' }]);
    expect(sanitiseTyped('\x1b')).toBe('');
  });

  it('keeps every printable character, so typing beside a paste still works', () => {
    expect(sanitiseTyped('abc')).toBe('abc');
    expect(sanitiseTyped('CJK 中文 \u{1F600}')).toBe('CJK 中文 \u{1F600}');
  });

  it('removes DEL and C1 bytes as well as C0', () => {
    expect(sanitiseTyped('a\x7fb\u009bc')).toBe('abc');
  });
});

describe('stripPasteFrames (T-30 / I-12 / P0-2)', () => {
  it('stores a framed ~100-character API key EXACTLY, with no NUL', () => {
    // An API key has no line break, so it trips the filter's Tier 2 burst rule
    // and arrives framed. Nothing downstream would remove the NULs: `trim()`
    // does not treat U+0000 as whitespace, the field is rendered through
    // `maskDot`, and the value goes to `registerSecret()` and `setApiKey()`.
    const key = `sk-ant-${'a1b2c3d4'.repeat(11)}`;
    expect(key.length).toBeGreaterThan(90);
    const stored = stripPasteFrames(`${PASTE_OPEN}${key}${PASTE_CLOSE}`);
    expect(stored).toBe(key);
    expect(stored).not.toContain('\u0000');
  });

  it('cleans a key that carried a stray CR or an ANSI sequence — better than v0.6.3', () => {
    expect(stripPasteFrames(`${PASTE_OPEN}sk-a\rbc${PASTE_CLOSE}`)).toBe('sk-abc');
    expect(stripPasteFrames('\x1b[0msk-abc')).toBe('[0msk-abc');
  });

  it('is a plain sanitise when there is no frame at all', () => {
    expect(stripPasteFrames('plain')).toBe('plain');
  });
});

// ---------------------------------------------------------------------------
// T-30, the part that matters: a SCAN, not two hand-written cases
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every `useInput` consumer that APPENDS `input` to a string must route it
 * through `stripPasteFrames` (I-12).
 *
 * WRITTEN AS A SCAN because the failure is invisible and because a seventh
 * consumer will be added by someone who never read the design document. Two
 * hand-written cases would keep passing while the new consumer corrupted a
 * credential.
 */
describe('I-12: no useInput consumer appends a raw `input` to a string', () => {
  it('finds zero violations across src/', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('__tests__/')) continue;
      // COMMENTS ARE BLANKED FIRST, using the lexer `glyphs.test.ts` already
      // pays for: without it the prose `(shared by render + input handler)`
      // reads as a violation, and a scanner that reports a false positive in a
      // file this feature never touched blocks the build for no reason.
      stripComments(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          // `<something> + input` / `input + <something>` inside a setter — the
          // shape both `SettingsScreen` and `QuestionOverlay` had.
          if (/[)\]}\w]\s\+\sinput\b/.test(line) || /\binput\s\+\s[A-Za-z_'"`]/.test(line)) {
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('all THREE known consumers really do call it (guarding against a vacuous scan)', () => {
    // A scan that matched nothing would pass the assertion above forever, so the
    // positive half is asserted directly.
    //
    // `PlanReviewOverlay` is here because the SCAN found it, not because the
    // design listed it: section 5.4.1's table calls it "key-driven only; inert",
    // which stopped being true when its revision-feedback field was added. That
    // is the whole argument for writing this as a scan.
    // The call is now the COMPOSITION with `stripEnterFrames`
    // (tui-shift-enter-copy-queue 3.5): the same broadcast carries the newline
    // frame a Shift+Enter produces, and this order is the one that leaves no
    // NUL in the stored value. `enter-frames.test.ts` pins that second half
    // with its own scan.
    for (const rel of [
      'ui/overlays/SettingsScreen.tsx',
      'ui/overlays/QuestionOverlay.tsx',
      'ui/overlays/PlanReviewOverlay.tsx',
    ]) {
      const source = readFileSync(join(SRC, rel), 'utf8');
      expect(source, rel).toContain('stripPasteFrames(stripEnterFrames(input))');
    }
  });

  it('the scan detects a violation when one is present', () => {
    const bad = 'setDraft(draft + input);';
    expect(/[)\]}\w]\s\+\sinput\b/.test(bad)).toBe(true);
  });
});
