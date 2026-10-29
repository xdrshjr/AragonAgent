/**
 * THE ONLY DOOR from the Electron main process to the aragon engine.
 *
 * WHY THIS FILE EXISTS (RV-P0-1). The main process is `app.asar` code. The engine
 * (`@aragon-agent/{core,tui,cli}` and their dependencies) ships beside it in
 * `resources/engine/node_modules`, which is NOT on any resolution path that starts inside the
 * asar. A static `import '@aragon-agent/cli/...'` therefore resolves in development (the
 * workspace symlink) and throws `ERR_MODULE_NOT_FOUND` on the first launch of the installed
 * app - "CI green, installed app dead". So the main process never imports the engine
 * statically (layering rule L7); it asks this module, which builds an absolute `file://` URL
 * for whichever root applies and imports that.
 *
 * Type-only imports below are erased at compile time and so create no run-time dependency.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as SettingsFacade from '@aragon-agent/cli/dist/host/settings.js';
import type * as SessionsFacade from '@aragon-agent/cli/dist/host/sessions.js';
import type * as PromptsFacade from '@aragon-agent/cli/dist/host/prompts.js';
import type * as AppPathsModule from '@aragon-agent/cli/dist/config/app-paths.js';

export interface Engine {
  settings: typeof SettingsFacade;
  sessions: typeof SessionsFacade;
  prompts: typeof PromptsFacade;
  paths: typeof AppPathsModule;
  /** Where the engine was loaded from, for diagnostics and the About page. */
  root: string;
  versions: { cli: string; core: string; tui: string };
}

export class EngineUnavailableError extends Error {
  constructor(message: string, readonly attempted: string[]) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

export interface EngineRootInput {
  /** `process.resourcesPath` when packaged, else undefined. */
  resourcesPath?: string | undefined;
  /** The desktop package directory (`packages/desktop`). */
  appRoot: string;
  isPackaged: boolean;
}

/** The directory that holds `@aragon-agent/cli/dist`, or the candidates that were tried. */
export function resolveEngineRoot(input: EngineRootInput): { root: string | null; attempted: string[] } {
  const candidates: string[] = [];
  if (input.isPackaged && input.resourcesPath) {
    candidates.push(join(input.resourcesPath, 'engine', 'node_modules', '@aragon-agent', 'cli'));
  } else {
    candidates.push(resolve(input.appRoot, '..', 'cli'));
    candidates.push(join(input.appRoot, 'node_modules', '@aragon-agent', 'cli'));
  }
  const root = candidates.find((candidate) => existsSync(join(candidate, 'dist', 'host', 'settings.js'))) ?? null;
  return { root, attempted: candidates };
}

/** The desktop package directory, derived from this module's own location (dist/main). */
export function defaultAppRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

async function importFrom<T>(root: string, relative: string): Promise<T> {
  return (await import(pathToFileURL(join(root, 'dist', relative)).href)) as T;
}

function readVersion(root: string, pkgDirs: string[]): string {
  for (const dir of pkgDirs) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (raw.version) return raw.version;
    } catch {
      /* try the next candidate */
    }
  }
  return 'unknown';
}

let cached: Promise<Engine> | null = null;

/**
 * Load (once) the pure-filesystem facades the main process needs. `ARAGON_HOME` MUST already
 * be settled: `app-paths` resolves the home root when it is first evaluated, which is exactly
 * what happens here.
 */
export function loadEngine(input: EngineRootInput): Promise<Engine> {
  if (cached) return cached;
  cached = (async () => {
    const { root, attempted } = resolveEngineRoot(input);
    if (!root) {
      throw new EngineUnavailableError(
        `The aragon engine was not found. Looked in: ${attempted.join(', ')}`, attempted,
      );
    }
    try {
      const paths = await importFrom<typeof AppPathsModule>(root, 'config/app-paths.js');
      const settings = await importFrom<typeof SettingsFacade>(root, 'host/settings.js');
      const sessions = await importFrom<typeof SessionsFacade>(root, 'host/sessions.js');
      const prompts = await importFrom<typeof PromptsFacade>(root, 'host/prompts.js');
      const siblings = (name: string): string[] => [
        join(root, '..', name), join(root, '..', '..', name), join(root, 'node_modules', '@aragon-agent', name),
      ];
      return {
        settings, sessions, prompts, paths, root,
        versions: {
          cli: readVersion(root, [root]),
          core: readVersion(root, siblings('core')),
          tui: readVersion(root, siblings('tui')),
        },
      };
    } catch (error) {
      cached = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new EngineUnavailableError(`The aragon engine failed to load from ${root}: ${message}`, attempted);
    }
  })();
  cached.catch(() => { cached = null; });
  return cached;
}

/** Test seam: forget the cached engine. */
export function resetEngineForTests(): void {
  cached = null;
}
