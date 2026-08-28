/**
 * One-shot migration of the user's on-disk state from the `env-paths`
 * directories into `~/.aragon-agent/`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: up to 0.5.0 the config lived in
 * `%APPDATA%\aragon-agent-nodejs\Config` and the sessions and skills in
 * `%LOCALAPPDATA%\aragon-agent-nodejs\Data`. Moving the root without moving the
 * contents would present to every existing user as a first run: no API key, no
 * saved sessions, no installed skills — with all of it still on disk somewhere
 * nobody thinks to look.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ORDER MATTERS AND IS NOT INTERCHANGEABLE. `migrateLegacyState()` (chain step
 * ①, pre-rename tree -> current tree) MUST run first. Run this one first and it
 * finds the `aragon-agent` env-paths tree empty and does nothing; ① then moves
 * the 0.4.x data into a location no code reads any more. Because the idempotence
 * keys below are per-artifact, `sessions` and `skills` would still be picked up
 * on the NEXT launch — but `config.json` would not: by then the user has re-
 * entered their key, the target file exists, and the original is stranded.
 *
 * THIS FUNCTION NEVER THROWS, for the reason spelled out in
 * `migrate-legacy-state.ts`: a user who has to re-enter an API key is
 * inconvenienced; a user whose CLI will not start is blocked.
 *
 * THE IDEMPOTENCE KEY IS PER-ARTIFACT — "does this target already exist" — and
 * deliberately NOT "does the home root exist". The logger creates `<home>/logs`
 * and `skills/usage.ts` creates `<home>` itself, both of them possibly in this
 * same process; keying on the root would let a half-finished migration be
 * skipped forever on the next launch.
 */

import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getHomeRoot, legacyEnvPaths } from './app-paths.js';
import { LEGACY_MIGRATION_BREADCRUMB_FILENAME } from './migrate-legacy-state.js';

/** Filesystem surface, so tests never touch a real user directory. */
export interface HomeMigrationFsPort {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  renameSync(from: string, to: string): void;
  cpSync(from: string, to: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: string): void;
}

export const nodeHomeFsPort: HomeMigrationFsPort = {
  existsSync,
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  renameSync,
  cpSync,
  writeFileSync: (path, data) => writeFileSync(path, data, 'utf-8'),
};

export interface HomeMigrationResult {
  mode: 'none' | 'renamed' | 'copied' | 'mixed';
  /** Artifact names that actually moved (`config.json`, `sessions`, …). */
  moved: string[];
  /** Populated instead of throwing. */
  error?: string;
}

const BREADCRUMB_FILENAME = '.migrated-from-env-paths';

interface Artifact {
  name: string;
  from: string;
  to: string;
  /**
   * Copy instead of rename.
   *
   * True for `config.json` only: it is the one artifact a user might want to
   * keep using with an older build, it costs kilobytes, and leaving the original
   * in place makes "reinstall 0.5.0" a lossless action. Sessions and skills are
   * large, so those move.
   */
  copy: boolean;
}

function artifacts(homeRoot: string): Artifact[] {
  const config = legacyEnvPaths.config;
  const data = legacyEnvPaths.data;
  return [
    {
      name: 'config.json',
      from: join(config, 'config.json'),
      to: join(homeRoot, 'config.json'),
      copy: true,
    },
    { name: 'sessions', from: join(data, 'sessions'), to: join(homeRoot, 'sessions'), copy: false },
    { name: 'skills', from: join(data, 'skills'), to: join(homeRoot, 'skills'), copy: false },
    {
      name: 'skill-usage.json',
      from: join(data, 'skill-usage.json'),
      to: join(homeRoot, 'skill-usage.json'),
      copy: false,
    },
    {
      name: LEGACY_MIGRATION_BREADCRUMB_FILENAME,
      from: join(config, LEGACY_MIGRATION_BREADCRUMB_FILENAME),
      to: join(homeRoot, LEGACY_MIGRATION_BREADCRUMB_FILENAME),
      copy: false,
    },
  ];
}

export function migrateToHome(fs: HomeMigrationFsPort = nodeHomeFsPort): HomeMigrationResult {
  const result: HomeMigrationResult = { mode: 'none', moved: [] };

  try {
    const homeRoot = getHomeRoot();
    let renamed = false;
    let copied = false;

    for (const artifact of artifacts(homeRoot)) {
      // Already migrated, or built by hand. Either way: never overwrite.
      if (fs.existsSync(artifact.to)) continue;
      if (!fs.existsSync(artifact.from)) continue;

      fs.mkdirSync(dirname(artifact.to), { recursive: true });

      if (artifact.copy) {
        fs.cpSync(artifact.from, artifact.to, { recursive: true });
        copied = true;
      } else if (moveOrCopy(fs, artifact)) {
        renamed = true;
      } else {
        copied = true;
      }

      result.moved.push(artifact.name);
    }

    if (result.moved.length === 0) return result;
    result.mode = renamed && copied ? 'mixed' : renamed ? 'renamed' : 'copied';
    writeBreadcrumb(fs, homeRoot, result);
    return result;
  } catch (err) {
    return { mode: 'none', moved: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Rename, falling back to a copy that KEEPS the source. Returns whether the
 * rename succeeded.
 *
 * On Windows `%APPDATA%` and `%LOCALAPPDATA%` can sit on different volumes, so
 * `EXDEV` here is ordinary rather than exceptional; antivirus contributes
 * `EPERM`. A half-written copy next to a deleted original is the only outcome
 * worse than not migrating at all, which is why the source stays.
 */
function moveOrCopy(fs: HomeMigrationFsPort, artifact: Artifact): boolean {
  try {
    fs.renameSync(artifact.from, artifact.to);
    return true;
  } catch {
    fs.cpSync(artifact.from, artifact.to, { recursive: true });
    return false;
  }
}

/**
 * Support-diagnosis breadcrumb, and deliberately NOT the idempotence key.
 *
 * It swallows its own failures for the same reason the brand migration's does:
 * letting an ENOENT here reach the caller's outer catch would report
 * `mode: 'none'` for a migration that actually moved the user's data — telling
 * support the exact opposite of what happened.
 */
function writeBreadcrumb(
  fs: HomeMigrationFsPort,
  homeRoot: string,
  result: HomeMigrationResult,
): void {
  const payload = {
    migratedAt: new Date().toISOString(),
    mode: result.mode,
    from: { config: legacyEnvPaths.config, data: legacyEnvPaths.data },
    moved: result.moved,
  };
  try {
    fs.mkdirSync(homeRoot, { recursive: true });
    fs.writeFileSync(join(homeRoot, BREADCRUMB_FILENAME), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // Intentionally ignored — see the note above.
  }
}

/** Path of the breadcrumb, for `aragon config home`'s "previous location" line. */
export function getHomeMigrationBreadcrumbPath(): string {
  return join(getHomeRoot(), BREADCRUMB_FILENAME);
}

/**
 * The one-line notice for a migration that did something.
 *
 * Callers MUST write this to stderr: `aragon -p "..." > out.txt` yields model
 * output and nothing else, and one stray line here breaks every scripted use.
 * ASCII-only with `->` rather than an arrow glyph — this prints before any
 * terminal capability probe has run.
 */
export function formatHomeMigrationNotice(result: HomeMigrationResult): string | null {
  if (result.mode === 'none') return null;
  return `moved settings to ${getHomeRoot()} (${result.moved.join(', ')})`;
}
