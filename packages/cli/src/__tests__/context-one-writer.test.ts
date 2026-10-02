/**
 * I-1, guarded by a source scan (context-usage-gauge-accuracy §7.1, T10 / T11).
 *
 * WHY A SCANNER RATHER THAN A BEHAVIOURAL TEST. "One writer" is not a property
 * of any single call - it is a property of the FILE, and the failure it prevents
 * is someone adding a perfectly reasonable second `context:` assignment two
 * years from now. A behavioural test can only catch the second writer if it
 * happens to exercise the exact interleaving in which the loser wins, which is
 * precisely what made P0-1 survive a full round of review: both writes were
 * individually correct, in the same synchronous fan-out, and the stale one was
 * simply last.
 *
 * The tree already uses this shape for `config.test.ts`'s `liveToolOutput:
 * opts.liveToolOutput` source assertion and for `compaction-pressure.test.ts`'s
 * adapter scan, both for the same reason: some invariants live in the shape of
 * the code, not in its output.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

/**
 * Remove block and line comments.
 *
 * DELIBERATELY CRUDE: it does not understand strings or regex literals, so a
 * `//` inside a URL takes the rest of that line with it. That is acceptable
 * because this is a NEGATIVE scan - over-stripping can only ever hide a
 * violation on a line that also contains a URL, and the identifiers being looked
 * for never appear in one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, '');
}

/** Every `.ts` / `.tsx` under `src/`, excluding the test tree itself. */
function sourceFiles(dir = SRC, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

describe('T10 - `ViewState.context` has exactly one writing branch', () => {
  it('every `context:` assignment in the reducer is inside `case \'contextUsage\'`', () => {
    const source = read('agent/reducer.ts');
    // `context:` as an OBJECT-LITERAL KEY. The interface declaration
    // (`context: ContextUsageSnapshot;`) is excluded by requiring a value that
    // is not a bare type name followed by `;`.
    const writes = [...source.matchAll(/^\s*context: (?!ContextUsageSnapshot;)(.+)$/gm)];
    expect(writes.length).toBeGreaterThan(0);

    const branch = source.indexOf("case 'contextUsage': {");
    expect(branch).toBeGreaterThan(-1);
    const branchEnd = source.indexOf("case '", branch + 20);

    for (const match of writes) {
      const at = match.index!;
      const inInitialState = source.slice(0, at).includes('export function initialViewState');
      const isSeed = match[1]!.includes('emptyContextUsage()');
      // `initialViewState` seeds the field once at construction; that is not a
      // reducer branch and cannot race anything.
      if (inInitialState && isSeed) continue;
      expect(
        at > branch && (branchEnd === -1 || at < branchEnd),
        `\`context:\` written outside the contextUsage branch: ${match[0].trim()}`,
      ).toBe(true);
    }
  });

  it('the identifiers this feature replaced are gone from the whole tree', () => {
    // `contextTokens` / `contextTokensEstimated` were the two fields with three
    // writing branches between them. A leftover CODE reference anywhere is
    // either dead code or a second projection of the same number.
    //
    // COMMENTS ARE STRIPPED FIRST, AND THAT IS DELIBERATE RATHER THAN LAX. The
    // several places that explain what those two fields were and why they went
    // are the record of this change; a scanner that forbids naming a removed
    // thing forces the next reader to reconstruct the argument from a diff.
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, file).not.toMatch(/\bcontextTokensEstimated\b/);
      expect(code, file).not.toMatch(/\bcontextTokens\b/);
    }
  });
});

describe('T11 - exactly one dispatcher', () => {
  it("`dispatch({ type: 'contextUsage'` appears once in `src/`", () => {
    let total = 0;
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      total += [...source.matchAll(/dispatch\(\{\s*type: 'contextUsage'/g)].length;
    }
    // TWO CALLS IN ONE EFFECT, ONE SITE. `App` seeds on mount and then
    // dispatches from the subscription callback; both are inside the single
    // `subscribeContextUsage` effect, which is what "one dispatcher" means here.
    expect(total).toBe(2);
  });

  it('only `App.tsx` dispatches it', () => {
    const dispatchers = sourceFiles().filter((f) =>
      /dispatch\(\{\s*type: 'contextUsage'/.test(readFileSync(f, 'utf8')),
    );
    expect(dispatchers.map((f) => f.replace(SRC, '').replace(/\\/g, '/'))).toEqual([
      '/ui/App.tsx',
    ]);
  });
});
