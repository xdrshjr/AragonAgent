/**
 * Resolve the `aragon` CLI launcher this desktop build drives.
 *
 * Two sources:
 * - `dev`: the monorepo working copy at `<repo>/packages/cli/dist/launcher.js`,
 *   so a checkout runs against the developer's build (root `npm run build`).
 * - `packaged`: `process.resourcesPath/agent-runtime/` staged by
 *   `scripts/stage-agent-runtime.mjs`, a self-contained node_modules produced
 *   from `npm pack` of core + cli.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface ResolvedRuntime {
  source: 'dev' | 'packaged';
  launcherPath: string;
  /** True when the launcher file exists; surfaced early instead of as a spawn error. */
  exists: boolean;
}

export function resolveRuntime(): ResolvedRuntime {
  if (app.isPackaged) {
    const launcherPath = path.join(
      process.resourcesPath,
      'agent-runtime',
      'node_modules',
      '@aragon-agent',
      'cli',
      'dist',
      'launcher.js',
    );
    return { source: 'packaged', launcherPath, exists: fileExistsSync(launcherPath) };
  }
  // <desktop>/dist-electron/electron/agent/runtime.js -> <repo>/packages/cli/dist/launcher.js
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const launcherPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'launcher.js');
  return { source: 'dev', launcherPath, exists: fileExistsSync(launcherPath) };
}

export async function assertRuntime(): Promise<ResolvedRuntime> {
  const runtime = resolveRuntime();
  if (!runtime.exists) {
    throw new Error(
      runtime.source === 'dev'
        ? 'CLI runtime not built. Run `npm run build` at the repository root (or in packages/cli), then restart the desktop app.'
        : `Bundled agent runtime is missing: ${runtime.launcherPath}`,
    );
  }
  await fs.access(runtime.launcherPath);
  return runtime;
}

function fileExistsSync(file: string): boolean {
  try {
    require('node:fs').accessSync(file);
    return true;
  } catch {
    return false;
  }
}
