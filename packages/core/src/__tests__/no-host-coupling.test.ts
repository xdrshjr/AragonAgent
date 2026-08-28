/**
 * Zero-coupling + brand-consistency guard (D4).
 *
 * Mechanically asserts four regression red lines over the package source,
 * turning the currently-verified-clean state into a permanent invariant:
 *
 *   1. COUPLING: no file under `src/` may reach back into the HOST repo via host
 *      path aliases (`@server/`, `@shared/`, `@/...`) or via out-of-package
 *      parent traversal (`../../../`). The package is a standalone, publishable
 *      unit — any such import would break `npm install` reuse.
 *
 *   2. NODE BUILTINS: no file under `src/` may `import … from 'node:*'`. The
 *      engine is host-agnostic by design — every filesystem / process capability
 *      arrives through an injected port (e.g. the skills subsystem's
 *      `SkillHost`). Exactly ONE exception is grandfathered in:
 *      `llm/providers/google.ts` needs `node:crypto`.
 *
 *      This assertion did NOT exist before the skills work landed. Anything
 *      that cited "no-host-coupling is green" as proof of "core has zero
 *      `node:*`" was citing a guarantee nobody was checking (spec P1-8 / C2).
 *
 *   3. BRAND: the PUBLIC surface (`src/index.ts`) must not leak the HOST brand
 *      (`AragonMesh`, `JRAgent`, `jr_agent`, `jr-agent`). What is banned is the
 *      host product name, not the `aragon` word stem — the engine itself is now
 *      published as `AragonAgent`, so banning the stem would ban the public
 *      surface's own name. Only the public surface is scanned (not every
 *      internal comment) to avoid false positives, and the regex is checked NOT
 *      to trip on `AragonAgent` itself.
 *
 *   4. LEGACY BRAND: no file under `src/` may carry the pre-rename spelling
 *      (`@argon-agent`, `ArgonAgent`, `ARGON_`). This is the reverse guard for
 *      the aragon-agent-core-rename work — it stops the missing `a` from
 *      drifting back in.
 *
 * Uses only `node:fs` / `node:path` — zero new dependencies.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '..'); // packages/core/src

/** Recursively collect `.ts` files under `dir`, skipping tests and node_modules. */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Host coupling: import specifiers that would not resolve outside this repo.
const COUPLING_PATTERNS: RegExp[] = [
  /from\s+['"]@server\//,
  /from\s+['"]@shared\//,
  /from\s+['"]@\//,
  /from\s+['"](?:\.\.\/){3,}/,
];

// Any `node:` builtin import. Matches both `from 'node:fs'` and the dynamic
// `import('node:fs')` form.
const NODE_IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*)['"]node:/;

/**
 * Files allowed to import a Node builtin, path suffix → reason.
 * Adding an entry here is an architectural decision, not a formality.
 */
const NODE_IMPORT_ALLOWLIST: Array<{ suffix: string; builtin: string }> = [
  { suffix: 'llm/providers/google.ts', builtin: 'node:crypto' },
];

function isAllowedNodeImport(file: string, line: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return NODE_IMPORT_ALLOWLIST.some(
    (entry) => normalized.endsWith(entry.suffix) && line.includes(entry.builtin),
  );
}

// Host brand on the public surface: AragonMesh (the product) and JRAgent (its
// internal name for this engine). NOT the bare `aragon` stem — the engine is
// itself called AragonAgent now, so using the stem as the ban list would ban the
// public surface's own name (rename C1).
const BRAND_PATTERN = /aragonmesh|jragent|jr[_-]agent/i;

// Reverse guard: the pre-rename spelling must never come back. This constant is
// the one place in the package that is *supposed* to spell the old brand.
const LEGACY_BRAND_PATTERN = /@argon-agent|ArgonAgent|ARGON_/;

describe('@aragon-agent/core no-host-coupling guard', () => {
  const files = listTsFiles(SRC_DIR);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('has no host-alias coupling or out-of-package parent traversal', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (COUPLING_PATTERNS.some((re) => re.test(line))) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('imports no node: builtin outside the documented allowlist', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!NODE_IMPORT_PATTERN.test(line)) return;
        if (isAllowedNodeImport(file, line)) return;
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the node: guard actually fires (self-check)', () => {
    // Without this, an over-narrow regex would make the assertion above pass
    // vacuously — the exact failure mode P1-8 caught in the previous version.
    expect(NODE_IMPORT_PATTERN.test("import { readFileSync } from 'node:fs';")).toBe(true);
    expect(NODE_IMPORT_PATTERN.test('const fs = await import("node:fs");')).toBe(true);
    expect(NODE_IMPORT_PATTERN.test("import { z } from './local.js';")).toBe(false);
    // The allowlist is file-scoped AND builtin-scoped: google.ts may take
    // node:crypto and nothing else.
    expect(isAllowedNodeImport('src/llm/providers/google.ts', "from 'node:crypto'")).toBe(true);
    expect(isAllowedNodeImport('src/llm/providers/google.ts', "from 'node:fs'")).toBe(false);
    expect(isAllowedNodeImport('src/skills/disclosure.ts', "from 'node:crypto'")).toBe(false);
  });

  // "host brand", not "legacy brand": since the rename there are two distinct
  // ban lists, and naming this one after the other is how a future edit ends up
  // pointing it at the wrong pattern.
  it('public surface (index.ts) leaks no host brand', () => {
    const indexPath = join(SRC_DIR, 'index.ts');
    const lines = readFileSync(indexPath, 'utf8').split(/\r?\n/);
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (BRAND_PATTERN.test(line)) {
        offenders.push(`index.ts:${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('the brand regex does not false-positive on AragonAgent', () => {
    // Sanity check on the guard itself: AragonAgent must pass, the host names fail.
    expect(BRAND_PATTERN.test('AragonAgent')).toBe(false);
    expect(BRAND_PATTERN.test('@aragon-agent/core')).toBe(false);
    expect(BRAND_PATTERN.test('AragonMesh')).toBe(true);
    expect(BRAND_PATTERN.test('jr_agent')).toBe(true);
    expect(BRAND_PATTERN.test('jr-agent')).toBe(true);
    expect(BRAND_PATTERN.test('JRAgent')).toBe(true);
  });

  it('no source file leaks the legacy pre-rename brand', () => {
    // Scans every `src/` file, not just the public surface: the old spelling in
    // an internal comment is still the old spelling, and this guard is what
    // keeps the rename from eroding.
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (LEGACY_BRAND_PATTERN.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the legacy brand regex actually fires (self-check)', () => {
    // Case-sensitive by design: `Aragon`/`aragon` must not be caught, only the
    // three concrete legacy spellings.
    expect(LEGACY_BRAND_PATTERN.test("from '@argon-agent/core'")).toBe(true);
    expect(LEGACY_BRAND_PATTERN.test('export { Agent as ArgonAgent }')).toBe(true);
    expect(LEGACY_BRAND_PATTERN.test('process.env.ARGON_MODEL')).toBe(true);
    expect(LEGACY_BRAND_PATTERN.test("from '@aragon-agent/core'")).toBe(false);
    expect(LEGACY_BRAND_PATTERN.test('export { Agent as AragonAgent }')).toBe(false);
    expect(LEGACY_BRAND_PATTERN.test('process.env.ARAGON_MODEL')).toBe(false);
  });
});
