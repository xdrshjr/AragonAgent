import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickGlyphs, toolGlyph, type Glyphs } from '../ui/glyphs.js';

const RICH = { colorLevel: 3, unicode: true } as const;
const ASCII = { colorLevel: 3, unicode: false } as const;

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('pickGlyphs', () => {
  it('returns a referentially stable set per capability tier', () => {
    expect(pickGlyphs(RICH)).toBe(pickGlyphs({ colorLevel: 1, unicode: true }));
    expect(pickGlyphs(ASCII)).toBe(pickGlyphs({ colorLevel: 0, unicode: false }));
    expect(pickGlyphs(RICH)).not.toBe(pickGlyphs(ASCII));
  });

  it('fills every field in BOTH tiers, with the ASCII tier pure ASCII', () => {
    // The point of the whole module: a terminal that reported "no Unicode" must
    // never receive a Unicode glyph. A missing field would render `undefined`.
    const uni = pickGlyphs(RICH);
    const ascii = pickGlyphs(ASCII);
    for (const key of Object.keys(uni) as (keyof Glyphs)[]) {
      if (key === 'tool') continue;
      expect(typeof uni[key], key).toBe('string');
      expect((uni[key] as string).length, key).toBeGreaterThan(0);
      expect(typeof ascii[key], key).toBe('string');
      expect((ascii[key] as string).length, key).toBeGreaterThan(0);
      expect(ascii[key] as string, key).not.toMatch(/[^\x00-\x7f]/);
    }
    for (const [name, glyph] of Object.entries(ascii.tool)) {
      expect(glyph, name).not.toMatch(/[^\x00-\x7f]/);
    }
  });

  it('picks an ASCII box style for a terminal without Unicode', () => {
    // Ink draws `round` borders from `cli-boxes`, and those are Unicode. This
    // is the one glyph we do not spell ourselves, so it survived every literal
    // being migrated: on a legacy console the composer, the completion popup
    // and every overlay were still framed in mojibake.
    expect(pickGlyphs(RICH).boxStyle).toBe('round');
    expect(pickGlyphs(ASCII).boxStyle).toBe('classic');
  });

  it('falls back to the default tool icon for an unknown tool', () => {
    expect(toolGlyph(pickGlyphs(RICH), 'read_file')).toBe(pickGlyphs(RICH).tool.read_file);
    expect(toolGlyph(pickGlyphs(RICH), 'nope')).toBe(pickGlyphs(RICH).toolDefault);
    expect(toolGlyph(pickGlyphs(ASCII), 'nope')).toBe(pickGlyphs(ASCII).toolDefault);
  });
});

// ---------------------------------------------------------------------------
// A-1 — the static guard rail
// ---------------------------------------------------------------------------

/**
 * Blank out comments, preserving line numbers, so only CODE is judged.
 *
 * Three cheaper rules were tried and each has a failure this codebase actually
 * triggers, so none of them is safe:
 *
 *  1. "skip lines starting with a comment marker" reports `capabilities.ts`'s
 *     trailing `// ... -> at least basic color` as a violation in a file this
 *     feature never touches — a FALSE POSITIVE that blocks the build.
 *  2. "regex out `/*...*\/` then `//...`" is fooled by `PromptInput.tsx:217`,
 *     where the glob string `'**​/*'` contains a `/*`. The stripper opens a
 *     comment there and swallows everything to the next `*\/` 250 lines later —
 *     including the real `'⇢' : '❯'` violation on line 401. That is a FALSE
 *     NEGATIVE, i.e. a guard rail that silently stops guarding.
 *  3. a lexer that tracks quotes but not regex literals is derailed by
 *     `markdown-blocks.ts`'s /`[^`]+`/ — the backtick inside the pattern reads
 *     as a template literal and comment stripping stops for the rest of the file.
 *
 * So the lexer below tracks strings, template literals AND regex literals.
 * Distinguishing a regex from division uses the standard heuristic: a `/` can
 * only begin a regex where an expression is expected, which the previous
 * non-space character tells us.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're' = 'code';
  let prev = '';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    const d = src[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        out.push('  ');
        i += 1;
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        out.push('  ');
        i += 1;
        continue;
      }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      else if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) state = 're';
      out.push(c);
      if (!/\s/.test(c)) prev = c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        prev = '';
        out.push(c);
      } else out.push(' ');
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        out.push('  ');
        i += 1;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      continue;
    }
    // Inside a string / template / regex: copy through, honour escapes.
    if (c === '\\') {
      out.push(c, d);
      i += 1;
      continue;
    }
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`') ||
      (state === 're' && c === '/') ||
      // A single-quoted string never spans a newline; recovering at the line
      // break keeps one unbalanced quote from poisoning the rest of the file.
      ((state === 'sq' || state === 'dq' || state === 're') && c === '\n')
    ) {
      state = 'code';
      prev = c === '\n' ? '' : c;
    }
    out.push(c);
  }
  return out.join('');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The exception list is EXHAUSTIVE and is the whole reason the scan has teeth.
 * Adding a fourth entry to make a build pass defeats the mechanism; add a field
 * to `glyphs.ts` instead (§4.1).
 */
const EXEMPT_FILES = new Set([
  'ui/glyphs.ts', // the two paired tables themselves
  'agent/headless.ts', // explicit non-goal: `argon -p` does no capability probe
]);
/** `Logo.tsx`'s wordmark art, already gated behind `caps.unicode`. */
const EXEMPT_RANGES: Record<string, [number, number][]> = { 'ui/Logo.tsx': [[13, 20]] };

function scan(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    if (rel.startsWith('__tests__/')) continue;
    const inScope =
      rel.startsWith('ui/') ||
      /^(agent|commands|config|tools)\//.test(rel) ||
      rel === 'cli.tsx';
    if (!inScope || EXEMPT_FILES.has(rel)) continue;
    const ranges = EXEMPT_RANGES[rel] ?? [];
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        const n = i + 1;
        if (ranges.some(([a, b]) => n >= a && n <= b)) return;
        const m = line.match(/[^\x00-\x7f]/g);
        if (m) hits.push(`${rel}:${n}  [${[...new Set(m)].join('')}]`);
      });
  }
  return hits;
}

describe('A-1: no hardcoded non-ASCII outside glyphs.ts', () => {
  it('finds zero violations across the renderer AND the non-UI modules', () => {
    // Baseline before this feature: 53 lines across 16 files under `src/ui/**`,
    // plus 20 more in agent/ commands/ config/ tools/ and cli.tsx. Every one of
    // them rendered into the same terminal, so the `ASCII_SYMBOLS` table the
    // theme carefully maintained was decorative -- a legacy `cmd.exe` showed
    // mojibake for the prompt caret, every list bullet and all four overlay
    // titles regardless. Scanning `src/ui/**` alone would still let 20 through.
    expect(scan()).toEqual([]);
  });

  it('leaves no component hardcoding a Unicode box style', () => {
    // The static character scan cannot see this one: `borderStyle="round"` is
    // pure ASCII in the source and Unicode only once Ink resolves it through
    // `cli-boxes`. Every boxed region must go through `glyphs.boxStyle`.
    const offenders = walk(SRC)
      .filter((f) => !relative(SRC, f).replace(/\\/g, '/').startsWith('__tests__/'))
      .filter((f) => /borderStyle=("|')(round|single|double|bold)\1/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('the scanner itself detects a violation (guarding against a no-op guard)', () => {
    // A scan that silently matches nothing passes the assertion above forever.
    // Each case below is a real failure mode of a simpler stripper (see the
    // comment on `stripComments`), so this is a regression test for the GUARD.
    const dash = '—';
    // Comments are exempt...
    expect(stripComments(`const a = 1; // dash ${dash}`)).not.toContain(dash);
    expect(stripComments(`/**\n * ${dash}\n */\nconst a = 1;`)).not.toContain(dash);
    // ...but code is not, in any of the three shapes that used to defeat it.
    expect(stripComments(`const a = '${dash}';`)).toContain(dash);
    // (2) a glob string containing `/*` must not open a comment.
    expect(stripComments(`glob('**/*');\nconst a = '${dash}';\n/* x */`)).toContain(dash);
    // (3) a backtick inside a regex literal must not open a template literal.
    expect(stripComments(`const RE = /\`[^\`]+\`/g;\nconst a = '${dash}';`)).toContain(dash);
    // ...and a comment after that regex is still stripped.
    expect(stripComments(`const RE = /\`[^\`]+\`/g;\n/** ${dash} */`)).not.toContain(dash);
  });
});
