/**
 * Zero-coupling + brand-consistency guard (D4).
 *
 * Mechanically asserts two regression red lines over the package source, turning
 * the currently-verified-clean state into a permanent invariant:
 *
 *   1. COUPLING: no file under `src/` may reach back into the HOST repo via host
 *      path aliases (`@server/`, `@shared/`, `@/...`) or via out-of-package
 *      parent traversal (`../../../`). The package is a standalone, publishable
 *      unit — any such import would break `npm install` reuse.
 *
 *   2. BRAND: the PUBLIC surface (`src/index.ts`) must not leak the legacy brand
 *      (`aragon`, `JRAgent`, `jr_agent`, `jr-agent`). The published component is
 *      `ArgonAgent`. Only the public surface is scanned (not every internal
 *      comment) to avoid false positives — and the regex is checked NOT to trip
 *      on `ArgonAgent` itself ("argon" ≠ "aragon").
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

// Legacy brand on the public surface. `i` flag; "argon" is intentionally allowed
// (ArgonAgent) — only "aragon" / "jragent" / "jr_agent" / "jr-agent" are banned.
const BRAND_PATTERN = /aragon|jragent|jr[_-]agent/i;

describe('@argon-agent/core no-host-coupling guard', () => {
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

  it('public surface (index.ts) leaks no legacy brand', () => {
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

  it('the brand regex does not false-positive on ArgonAgent', () => {
    // Sanity check on the guard itself: ArgonAgent must pass, the legacy names fail.
    expect(BRAND_PATTERN.test('ArgonAgent')).toBe(false);
    expect(BRAND_PATTERN.test('@argon-agent/core')).toBe(false);
    expect(BRAND_PATTERN.test('AragonMesh')).toBe(true);
    expect(BRAND_PATTERN.test('jr_agent')).toBe(true);
    expect(BRAND_PATTERN.test('jr-agent')).toBe(true);
    expect(BRAND_PATTERN.test('JRAgent')).toBe(true);
  });
});
