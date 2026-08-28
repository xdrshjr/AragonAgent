/**
 * `aragon info` - capability discovery (cli-integration-surface section 5.4).
 *
 * ASCII ONLY - `src/diagnostics/**` is inside the glyph scanner's scope.
 *
 * "INSTALL AND CALL" ACROSS VERSIONS IS ONLY ROBUST IF THE CALLER CAN ASK WHAT
 * IT JUST INSTALLED (G6). Everything a wrapper might branch on is here, and
 * `features` is a FLAT STRING LIST on purpose: a wrapper testing
 * `info.features.includes('sessions')` keeps working across versions that add
 * capabilities, which a nested shape with renamed keys would not.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { getConfigPath, getSessionsDir, getUserDataDir } from '../config/app-paths.js';
import { loadConfig, makeGetApiKey, type CliFlags } from '../config/load.js';
import { HOST_TOOL_NAMES } from '../tools/index.js';
import { EXEC_SCHEMA_VERSION } from '../exec/events.js';

export interface ExecInfo {
  cli: string;
  core: string;
  node: string;
  schemaVersion: number;
  home: string;
  configPath: string;
  sessionsDir: string;
  provider: string;
  model: string;
  hasApiKey: boolean;
  tools: string[];
  outputFormats: string[];
  inputFormats: string[];
  permissionModes: string[];
  features: string[];
}

/**
 * Everything this build can do, as names a wrapper can test for.
 *
 * ADD, NEVER RENAME. A removed name is a breaking change for every consumer that
 * guarded on it, and the whole value of the list is that guarding is cheap.
 */
const FEATURES = [
  'exec',
  'sessions',
  'permissions',
  'budgets',
  'team',
  'todo',
  'skills',
  'fast',
] as const;

export function buildInfo(flags: CliFlags, version: string): ExecInfo {
  const config = loadConfig(flags);
  const getKey = makeGetApiKey(config);
  return {
    cli: version,
    core: readCoreVersion(),
    node: process.version,
    schemaVersion: EXEC_SCHEMA_VERSION,
    home: getUserDataDir(),
    configPath: getConfigPath(),
    sessionsDir: getSessionsDir(),
    provider: config.provider,
    model: config.model,
    hasApiKey: Boolean(getKey(config.provider)),
    // THE SUPERSET, not "what a run would register right now". This answers
    // "which names can `--allow-tool` take?", which is exactly what
    // `HOST_TOOL_NAMES` means and exactly what `--allow-tool` validates against.
    tools: [...HOST_TOOL_NAMES],
    outputFormats: ['text', 'json', 'stream-json'],
    inputFormats: ['text', 'stream-json'],
    permissionModes: ['auto', 'plan', 'strict'],
    features: [...FEATURES],
  };
}

/**
 * The installed `@aragon-agent/core` version, or `'unknown'`.
 *
 * RESOLVED, NOT READ OFF THE DEPENDENCY RANGE. `"^0.2.12"` in this package's
 * own `package.json` is what was ASKED FOR; a consumer asking `aragon info`
 * wants what is actually loaded, and the two differ on every machine that
 * installed a patch release.
 *
 * A DIRECTORY WALK, AND NEITHER `createRequire().resolve()` NOR
 * `import.meta.resolve()` (implementation finding IF-2). Core's `exports` map
 * declares only an `import` condition, so `createRequire(...).resolve()` fails
 * with `ERR_PACKAGE_PATH_NOT_EXPORTED` - and it fails on the DEVELOPER's machine
 * as readily as on a user's, which is how this was caught. `import.meta.resolve`
 * is not synchronously available on Node 18, and `engines` says `>=18`.
 *
 * The walk covers all three real layouts: the monorepo (a symlink in the root
 * `node_modules`), a flat npm install (core beside cli under the project's
 * `node_modules`), and a nested one (core under the cli package's own
 * `node_modules`).
 */
function readCoreVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, 'node_modules', '@aragon-agent', 'core', 'package.json'), 'utf-8'),
      ) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Not this level. Keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A bundled or unusual layout. A missing version is worth reporting honestly;
  // it is not worth failing a discovery command over.
  return 'unknown';
}
