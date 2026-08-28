#!/usr/bin/env node
/**
 * Post-build: prepend a Node shebang to each build entry point and mark it
 * executable so the `aragon` bin runs directly. Idempotent — safe to run
 * repeatedly.
 *
 * TWO TARGETS, AND BOTH ARE REQUIRED (cli-auto-update-hardening C-18 / AC-50).
 * `dist/launcher.js` is what `bin.aragon` points at from this version on;
 * `dist/cli.js` keeps its shebang and its exec bit because `npm start` runs
 * `node dist/cli.js` and user scripts may invoke it directly — only the `bin`
 * MAPPING moved (R-17).
 *
 * A MISSING TARGET IS A BUILD FAILURE, per target. Silently skipping one would
 * ship a `bin` the shell cannot execute, which presents as "command not found"
 * on a package that installed cleanly.
 */

import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TARGETS = ['launcher.js', 'cli.js'];
const shebang = '#!/usr/bin/env node\n';

for (const name of TARGETS) {
  const target = join(here, '..', 'dist', name);

  if (!existsSync(target)) {
    console.error(`[prepend-shebang] build output not found: ${target}`);
    process.exit(1);
  }

  const content = readFileSync(target, 'utf-8');

  if (!content.startsWith('#!')) {
    writeFileSync(target, shebang + content, 'utf-8');
  }

  try {
    chmodSync(target, 0o755);
  } catch {
    // chmod is a no-op / may fail on Windows — ignore.
  }
}

console.log(
  `[prepend-shebang] ${TARGETS.map((t) => `dist/${t}`).join(' and ')} are executable with a Node shebang.`,
);
