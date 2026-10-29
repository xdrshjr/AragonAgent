#!/usr/bin/env node
// Make sure the terminal UI has been compiled before the desktop's TypeScript runs.
//
// Why this exists: the desktop imports `@aragon-agent/tui/model/*` (the host and the port protocol
// share the TUI's reducer types). That specifier goes through the TUI's export map, so `tsc`
// resolves it to `packages/tui/dist/model/*.d.ts` - not to the TUI sources. In this repository the
// TUI is a workspace sibling, and a clean clone has no `dist` yet, so `npm run build`, `typecheck`
// or `test` inside packages/desktop would fail with TS2307 before doing any work of its own.
//
// The guard runs as `prebuild`/`pretypecheck`/`pretest` so those three commands keep working on
// their own, which is what the README documents. It deliberately does NOT put a `-w packages/tui`
// or a `../../scripts/...` call in package.json: test/package-metadata.test.ts forbids the desktop
// from reaching for a workspace sibling or a monorepo-root script, and it stays true - this is a
// no-op whenever the TUI is already built, and whenever it is installed from the npm registry
// instead of linked from a workspace (the standalone/consumer shape).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tui = join(root, '..', 'tui');

// Published TUI (no sibling source next to us) or already compiled: nothing to do.
if (!existsSync(join(tui, 'tsconfig.json')) || existsSync(join(tui, 'dist', 'index.d.ts'))) process.exit(0);

console.log('ensure-tui-dist: packages/tui/dist is missing, building it first (the desktop imports its types)');
const result = spawnSync('npm', ['run', 'build'], {
  cwd: tui, stdio: 'inherit', shell: process.platform === 'win32',
});
if (result.status !== 0) {
  console.error(`ensure-tui-dist: "npm run build" in ${tui} failed (exit ${result.status ?? 1})`);
  process.exit(result.status ?? 1);
}
