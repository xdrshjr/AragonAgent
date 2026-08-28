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
  'agent/headless.ts', // explicit non-goal: `aragon -p` does no capability probe
]);
/** `Logo.tsx`'s wordmark art, already gated behind `caps.unicode`. */
const EXEMPT_RANGES: Record<string, [number, number][]> = { 'ui/Logo.tsx': [[13, 20]] };

/**
 * Which source files the scan covers.
 *
 * A NAMED FUNCTION RATHER THAN AN INLINE EXPRESSION so AC-52 can assert on it
 * DIRECTLY. "The suite passes" is not evidence that a tree is scanned — a
 * scanner that silently stops scanning is worse than no scanner, and that is
 * exactly the failure a new directory produces.
 *
 * `team/` is in scope from the team-subagents feature onward (I-6 / P1-1 /
 * R-20). It is a NEW tree, so without this word nothing scanned it at all
 * and AC-13 would assert a property no test checks — the vacuous-guard
 * failure mode the scanner's own self-test below exists to prevent, one
 * level up at the directory rather than the line.
 * `todo/` joins for exactly the reason `team/` did (C-4 / I-8): it is a NEW
 * tree, so without this word nothing scanned it at all and the "no
 * hardcoded non-ASCII" claim would be VACUOUS for the newest code in the
 * package — a guard rail that silently stops guarding.
 * `fast/` joins on the same terms (C-4 / AC-27), and ships in the same
 * commit as the tree for the reason above.
 * `update/` is the fourth, and ships in the same commit as the tree for the
 * fourth time (cli-auto-update C-2 / R-11 / AC-18). Without this word the
 * newest tree in the package is scanned by nothing at all, and the "no
 * hardcoded non-ASCII" claim goes VACUOUS exactly where a background feature
 * renders into a legacy console the author never sees.
 * `boot/` is the FIFTH, and `launcher.ts` joins `cli.tsx` as the second
 * top-level entry file, both in the same commit as the tree they cover
 * (cli-auto-update-hardening C-19 / AC-52). This package has now paid for this
 * class of edit five times; `boot/rollback.ts` writes a line to the user's
 * terminal, so an unscanned `boot/` is the same hole in the same place.
 * `exec/`, `diagnostics/` AND `session/` are the SIXTH, SEVENTH and EIGHTH,
 * and they ship in the same commit as the trees they cover
 * (cli-integration-surface R-3 / P1-7 / AC-25). `session/` is the one worth
 * pausing on: it was ALREADY outside this predicate before that feature existed,
 * so naming only `exec/` — as the first draft of that design did — would have
 * left two of three new trees unscanned. This is not a case of extending a guard
 * to new code; it is a case of the guard already having a hole that the feature
 * widens.
 */
export function inScope(rel: string): boolean {
  return (
    rel.startsWith('ui/') ||
    // `compaction` is the NINTH tree, and it ships in the same commit as the code
    // it covers (context-auto-compaction C-7). This regex is a hardcoded
    // directory list, so a new tree is INVISIBLE to the scanner until it is named
    // here — and a scanner that silently stops scanning is worse than no scanner.
    // Adding the tree and adding the word are the same change; `fast` recorded
    // this trap one feature earlier and paid for it.
    // `input` is the TENTH tree, and it ships in the same commit as the code it
    // covers (tui-paste-handling D-16). It has NEVER been in this list, so
    // nothing scanned it at all -- and this feature puts user-visible decisions
    // there (the paste markers, the framing, every refusal string). A scanner
    // that silently stops scanning is worse than no scanner, and this package
    // has now paid for that exact edit ten times.
    // `proc` is the ELEVENTH tree, and it ships in the same commit as the code it
    // covers (background-service-supervision R-8 / AC-34). Every word above was
    // added late, after the tree it names had already shipped unscanned; this one
    // is not, and the reason is the sentence this list has now carried ten times:
    // a scanner that silently stops scanning is worse than no scanner. `proc/`
    // writes strings that reach a model AND strings that reach a legacy console
    // (`[background] service s1 started`), so an unscanned tree is the same hole
    // in the same place.
    /^(agent|boot|commands|compaction|config|diagnostics|exec|fast|input|proc|session|team|todo|tools|update)\//.test(
      rel,
    ) ||
    rel === 'cli.tsx' ||
    rel === 'launcher.ts'
  );
}

describe('inScope (the hardcoded directory list)', () => {
  it('AC-34: proc/ is scanned - same commit as the tree (R-8)', () => {
    // A scanner that silently stops scanning is worse than no scanner, and this
    // package has now paid for that edit eleven times. `proc/` writes strings
    // that reach a MODEL and strings that reach a legacy console, so an
    // unscanned tree is the same hole in the same place.
    expect(inScope('proc/limits.ts')).toBe(true);
    expect(inScope('proc/supervisor.ts')).toBe(true);
  });
});

function scan(): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    if (rel.startsWith('__tests__/')) continue;
    if (!inScope(rel) || EXEMPT_FILES.has(rel)) continue;
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

  it('AC-52: the scan actually COVERS boot/ and launcher.ts', () => {
    // ASSERTED ON THE PREDICATE, not implied by the suite passing. The whole
    // failure mode this guards is a new tree that nothing looks at: `scan()`
    // returns `[]` for an unscanned directory exactly as it does for a clean
    // one, so a green suite is not evidence either way (C-19).
    expect(inScope('boot/guard.ts')).toBe(true);
    expect(inScope('boot/rollback.ts')).toBe(true);
    expect(inScope('launcher.ts')).toBe(true);
    // And the predicate is still narrow: a top-level file that is not an entry
    // point stays out, or the exemption list stops meaning anything.
    expect(inScope('index.ts')).toBe(false);
  });

  it('AC-10: the scan COVERS input/', () => {
    // Asserted on the PREDICATE for the reason AC-52 states above: `scan()`
    // returns `[]` for an unscanned directory exactly as it does for a clean
    // one, so a green suite is not evidence either way (D-16).
    expect(inScope('input/paste-parse.ts')).toBe(true);
    expect(inScope('input/stdin-filter.ts')).toBe(true);
    expect(inScope('input/limits.ts')).toBe(true);
  });

  it('AC-25: the scan COVERS exec/, session/ and diagnostics/', () => {
    // Asserted on the PREDICATE for the reason AC-52 states one line up, and
    // all three are named rather than one representative: `session/` was
    // outside the predicate BEFORE this feature, so a mitigation that named
    // only the newest tree would have left it and `diagnostics/` unscanned
    // while the suite stayed green (cli-integration-surface P1-7).
    expect(inScope('exec/runner.ts')).toBe(true);
    expect(inScope('exec/events.ts')).toBe(true);
    expect(inScope('session/store.ts')).toBe(true);
    expect(inScope('session/persist.ts')).toBe(true);
    expect(inScope('diagnostics/doctor.ts')).toBe(true);
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
