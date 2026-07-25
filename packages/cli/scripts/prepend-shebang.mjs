#!/usr/bin/env node
/**
 * Post-build: prepend a Node shebang to dist/cli.js and mark it executable so
 * the `argon` bin runs directly. Idempotent — safe to run repeatedly.
 */

import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'dist', 'cli.js');

if (!existsSync(target)) {
  console.error(`[prepend-shebang] build output not found: ${target}`);
  process.exit(1);
}

const shebang = '#!/usr/bin/env node\n';
const content = readFileSync(target, 'utf-8');

if (!content.startsWith('#!')) {
  writeFileSync(target, shebang + content, 'utf-8');
}

try {
  chmodSync(target, 0o755);
} catch {
  // chmod is a no-op / may fail on Windows — ignore.
}

console.log('[prepend-shebang] dist/cli.js is executable with a Node shebang.');
