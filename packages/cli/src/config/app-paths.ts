/**
 * The user-state root, in one place.
 *
 * `config/store.ts` and `skills/paths.ts` each used to carry their own copy of
 * the path arithmetic. Two copies of a name is exactly the shape that lets a
 * rename land in one of them and not the other, and the failure is silent: the
 * config file and the skills directory simply stop agreeing about where the
 * user's data lives. Everything below derives from `homeRoot`.
 *
 * LAYOUT (aragon-home-config-and-logging §4.1):
 *
 *   ~/.aragon-agent/
 *   ├── config.json            persisted config (0600 on POSIX)
 *   ├── config.json.bak        `aragon config edit` pre-edit backup
 *   ├── prompt-history.jsonl   submitted prompts, append-only (0600 on POSIX)
 *   ├── state.json             UI bookkeeping scalars (0600 on POSIX)
 *   ├── update-state.json      auto-update coordination (0600 on POSIX)
 *   ├── update-install.lock    held by the running `npm i -g` child
 *   ├── update-install.log     that child's stdout+stderr; unlinked on exit
 *   ├── logs/                  JSONL logs (0700 on POSIX)
 *   ├── sessions/              /save · /resume
 *   ├── skills/                `aragon skills install` target
 *   └── skill-usage.json
 *
 * The two files added by config-state-separation are DIRECT CHILDREN of the
 * root, siblings of `skill-usage.json` rather than children of any directory
 * here: `logs/`, `sessions/` and `skills/` are all scan roots, and every extra
 * file inside one is another thing each walk has to recognise and skip.
 *
 * The same path on all three platforms, deliberately. Claude Code, git and npm
 * all put their dot-directory in the user's home; one path means documentation,
 * support scripts and community answers have exactly one thing to say. A user
 * who wants XDG has `ARAGON_HOME=$XDG_CONFIG_HOME/aragon-agent`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TEST-ISOLATION CONTRACT — read before editing anything here or in the tests.
 *
 * `getHomeRoot()` returns the WHOLE user root, not just a config directory.
 * Under the old `env-paths` layout the config directory held one file; here it
 * holds the API key, every saved session and every installed skill. That makes
 * a careless `rmSync(<root>, { recursive: true })` in a test an unrecoverable
 * data loss on the developer's own machine, at a moment when nobody expects the
 * filesystem to be touched at all. Four rules keep that impossible:
 *
 *   1. There is NO `getConfigDir()`. A function whose name says "config dir"
 *      must never hand back the user root. Code that needs the root calls
 *      `getHomeRoot()`, where the size of what you are holding is obvious.
 *   2. `config.test.ts::clearEnv()` must EXEMPT `ARAGON_HOME` — deleting it
 *      would send any later, non-module-level resolution at the developer's
 *      real home.
 *   3. Tests never recursively delete a path a function returned. Delete a
 *      single file (`rmSync(getConfigPath(), { force: true })`), or delete a
 *      directory the test itself built under `os.tmpdir()`.
 *   4. The VITEST branch below. In a test process with no explicit
 *      `ARAGON_HOME`, the root is redirected into `os.tmpdir()`. Redirecting
 *      rather than throwing is deliberate: throwing would turn every unrelated
 *      test that merely imports this module red, and that cost is what tempts
 *      someone to delete the guard.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import envPaths from 'env-paths';

export const APP_NAME = 'aragon-agent';
export const HOME_DIR_NAME = '.aragon-agent';

/**
 * The pre-0.6.0 `env-paths` roots.
 *
 * ONLY the two migration modules may read this. Any other reference is a bug:
 * it would point new code at the directory the migration exists to empty.
 */
export const legacyEnvPaths = envPaths(APP_NAME);

interface HomeResolution {
  root: string;
  /** Whether `ARAGON_HOME` actually took effect (captured, never re-read). */
  overridden: boolean;
  /** Why an override was ignored, if it was. Surfaced once the logger exists. */
  warning?: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where to land when `ARAGON_HOME` is absent or unusable.
 *
 * Inside vitest this is a per-pid temp root, never the developer's real home —
 * rule 4 of the contract above, and it has to apply to the FALLBACK too, or a
 * test that sets `ARAGON_HOME` to something bogus quietly gets the real one.
 */
function fallbackRoot(): string {
  if (process.env.VITEST) return join(tmpdir(), `aragon-agent-vitest-${process.pid}`);
  return join(homedir(), HOME_DIR_NAME);
}

function resolveHomeRoot(): HomeResolution {
  const raw = process.env.ARAGON_HOME?.trim();
  if (raw && raw.length > 0) {
    const candidate = resolve(raw);
    if (existsSync(candidate) && !isDirectory(candidate)) {
      return {
        root: fallbackRoot(),
        overridden: false,
        warning: `ARAGON_HOME=${candidate} is not a directory; using ${fallbackRoot()}`,
      };
    }
    return { root: candidate, overridden: true };
  }
  return { root: fallbackRoot(), overridden: false };
}

/**
 * Resolved ONCE at module load, matching what `envPaths()` did here before.
 *
 * The existing tests set their environment and then `await import(...)`; keeping
 * the same model means test isolation stays "set the env first", not a new mock
 * framework. It also means `isHomeOverridden()` must report the value captured
 * here rather than re-reading `process.env` — `config.test.ts::clearEnv()` wipes
 * `ARAGON_*` before every test, and a live read would answer `false` for a run
 * that really is overridden.
 */
const resolution = resolveHomeRoot();

/** `~/.aragon-agent` (or `$ARAGON_HOME`). The root of everything below. */
export function getHomeRoot(): string {
  return resolution.root;
}

export function getConfigPath(): string {
  return join(resolution.root, 'config.json');
}

/** Written by `aragon config edit` before spawning the editor. */
export function getConfigBackupPath(): string {
  return join(resolution.root, 'config.json.bak');
}

/**
 * `<home>/prompt-history.jsonl` — the prompts the user submitted, one JSON
 * object per line. Deliberately NOT under `logs/`: that directory is governed
 * by `log.toFile`, `log.maxFiles` and `aragon logs clear`, and turning
 * diagnostics off or reclaiming disk must not also delete the user's `↑`
 * recall (config-state-separation D-1).
 */
export function getPromptHistoryPath(): string {
  return join(resolution.root, 'prompt-history.jsonl');
}

/** `<home>/state.json` — UI bookkeeping scalars only; see `ui-state.ts`. */
export function getUiStatePath(): string {
  return join(resolution.root, 'state.json');
}

/**
 * `<home>/update-state.json` — cross-process auto-update coordination
 * (cli-auto-update §5.2).
 *
 * Deliberately NOT inside `state.json`: that file is documented as UI
 * bookkeeping scalars only (C-6), and this is coordination state that a SECOND
 * aragon process reads to decide whether anyone has already asked the registry.
 * Different lifetime, different failure policy, different reader.
 */
export function getUpdateStatePath(): string {
  return join(resolution.root, 'update-state.json');
}

/**
 * `<home>/update-install.lock` — the `wx` lock the running installer child holds
 * (cli-auto-update §3.7).
 *
 * A FILE, and a direct child of the root, for the reason the two files above
 * are: `logs/`, `sessions/` and `skills/` are all scan roots, and every extra
 * file inside one is another thing each walk has to recognise and skip.
 */
export function getUpdateLockPath(): string {
  return join(resolution.root, 'update-install.lock');
}

/**
 * `<home>/update-install.log` — the installer child's stdout+stderr
 * (cli-auto-update §3.5 / U-5).
 *
 * A REAL FILE and not a pipe: the child is detached and outlives the parent
 * (D-10), and a pipe whose parent has exited takes EPIPE on the next write. The
 * parent tails it on the child's exit, redacts, logs, and unlinks.
 */
export function getUpdateInstallLogPath(): string {
  return join(resolution.root, 'update-install.log');
}

export function getLogsDir(): string {
  return join(resolution.root, 'logs');
}

export function getSessionsDir(): string {
  return join(resolution.root, 'sessions');
}

/**
 * `<home>/compaction` — the compaction archive
 * (context-auto-compaction-hardening §3.5 / W4).
 *
 * ITS OWN ROOT, AND EXPLICITLY NOT INSIDE `sessions/`. `logs/`, `sessions/` and
 * `skills/` are all SCAN roots — the note above `getUpdateStatePath` says it in
 * as many words: every extra file inside one is another thing each walk has to
 * recognise and skip. An archive dropped into `sessions/` would be offered to the
 * user by `/resume` as a session it cannot load.
 *
 * SHARED BY EVERY `aragon` ON THE MACHINE, which is why the files inside it carry
 * a per-process run id and why retention is two-tier (§3.5.2 / RV-6).
 */
export function getCompactionArchiveDir(): string {
  return join(resolution.root, 'compaction');
}

/** `<home>` — parent of `skills/`, and where sidecar state such as usage lives. */
export function getUserDataDir(): string {
  return resolution.root;
}

export function getUserSkillsDir(): string {
  return join(resolution.root, 'skills');
}

/** Whether `ARAGON_HOME` was honoured. Captured at load — see `resolution`. */
export function isHomeOverridden(): boolean {
  return resolution.overridden;
}

/**
 * Why an `ARAGON_HOME` override was ignored, if it was.
 *
 * Path resolution happens before the logger exists, so the reason is parked
 * here and written out by `installLogging()` once there is somewhere to put it.
 */
export function getHomeResolutionWarning(): string | undefined {
  return resolution.warning;
}
