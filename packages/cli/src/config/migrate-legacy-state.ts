/**
 * One-shot migration of the user's on-disk state from the pre-rename
 * `argon-agent` namespace to `aragon-agent`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: `envPaths()` derives the config and data directories from
 * the application name, so changing the name relocates them. Without this
 * module a user upgrading from 0.4.x would find their API key, their sessions
 * and every installed skill gone — not renamed, gone, with the old directory
 * still on disk where nobody thinks to look. That is data loss wearing a
 * rename's clothing.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The dividing line (spec §3.4): what the user cannot see, the code migrates
 * for them; what the user can see — the project-level `.argon/skills` directory
 * inside their own repository — the CHANGELOG tells them to `git mv`.
 *
 * THIS FUNCTION NEVER THROWS. It runs as the first statement of `main()`, and a
 * migration failure must never be the reason the CLI will not start: a user who
 * has to re-enter an API key is inconvenienced, a user whose CLI refuses to
 * launch is blocked. Every failure path degrades to `{ mode: 'none', error }`.
 *
 * CHAIN POSITION: this is step ① of two. `migrateToHome()` runs immediately
 * after it and moves the same data on to `~/.aragon-agent/`. The order is not
 * interchangeable — see the header of `migrate-home.ts` for what running them
 * the other way round strands, and why the damage is silent.
 *
 * The directories this module reads and writes are the `env-paths` roots, which
 * after `migrateToHome()` hold nothing the CLI reads. That is why they are
 * imported here as `legacyEnvPaths`: no other module may use them.
 *
 * IDEMPOTENCE KEY is "does the new directory already exist" — not the
 * breadcrumb file, which is written for support diagnosis only. Two cold starts
 * racing each other therefore both observe `existsSync(next) === false` and
 * both attempt the rename; the loser gets ENOENT (source already moved) or
 * EPERM (Windows, target now busy), which the outer catch absorbs. That is the
 * designed outcome, not an accident: the winner completed the whole migration,
 * and the loser's view of the world is identical to the already-migrated
 * branch. No lock file is introduced — a stale lock is precisely the class of
 * cross-version residue step 5 exists to delete.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import envPaths from 'env-paths';
import { legacyEnvPaths as envPathsRoots } from './app-paths.js';

/**
 * The pre-rename `env-paths` application name. Deliberately declared here and
 * not alongside `APP_NAME`: this module is the only consumer, and it is the
 * only file in the package that is *supposed* to spell the old brand.
 */
export const LEGACY_APP_NAME = 'argon-agent';
export const legacyAppPaths = envPaths(LEGACY_APP_NAME);

/** Filesystem surface this module needs, so tests never touch a real user directory. */
export interface MigrationFsPort {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  renameSync(from: string, to: string): void;
  cpSync(from: string, to: string, options: { recursive: true }): void;
  readdirSync(path: string): string[];
  rmSync(path: string, options: { force: true }): void;
  writeFileSync(path: string, data: string): void;
}

export const nodeFsPort: MigrationFsPort = {
  existsSync,
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  renameSync,
  cpSync,
  readdirSync: (path) => readdirSync(path),
  rmSync,
  writeFileSync: (path, data) => writeFileSync(path, data, 'utf-8'),
};

export interface MigrationResult {
  mode: 'none' | 'renamed' | 'copied';
  /** Which roots actually moved — `'config'` and/or `'data'`. */
  movedRoots: string[];
  /** How many `.argon-skill.json` files were renamed to `.aragon-skill.json`. */
  manifestsRenamed: number;
  /** Populated instead of throwing. */
  error?: string;
}

const LEGACY_MANIFEST_FILENAME = '.argon-skill.json';
const MANIFEST_FILENAME = '.aragon-skill.json';
const LEGACY_LOCK_FILENAME = '.argon-skills.lock';
export const LEGACY_MIGRATION_BREADCRUMB_FILENAME = '.migrated-from-argon-agent';

/**
 * The roots the CLI actually uses. `envPaths` also exposes `cache`, `log` and
 * `temp`; none of them hold anything the user would miss, and migrating a
 * directory nobody reads is a way to move a bug rather than fix one. A future
 * root must be added here explicitly.
 */
const ROOTS = ['config', 'data'] as const;
type Root = (typeof ROOTS)[number];

export function migrateLegacyState(fs: MigrationFsPort = nodeFsPort): MigrationResult {
  const result: MigrationResult = { mode: 'none', movedRoots: [], manifestsRenamed: 0 };

  try {
    let copied = false;
    const from: Partial<Record<Root, string>> = {};

    for (const root of ROOTS) {
      const legacy = legacyAppPaths[root];
      const next = envPathsRoots[root];

      // Already migrated, or the user built the new directory by hand. Either
      // way: do not migrate, and above all do not overwrite.
      if (fs.existsSync(next)) continue;
      if (!fs.existsSync(legacy)) continue;

      fs.mkdirSync(dirname(next), { recursive: true });

      try {
        fs.renameSync(legacy, next);
      } catch {
        // EXDEV (separate volumes) or EPERM. Copy instead, and KEEP the legacy
        // tree: a half-finished copy plus a deleted original is the one outcome
        // worse than not migrating at all.
        fs.cpSync(legacy, next, { recursive: true });
        copied = true;
      }

      result.movedRoots.push(root);
      from[root] = legacy;
    }

    if (result.movedRoots.length === 0) return result;
    result.mode = copied ? 'copied' : 'renamed';

    if (result.movedRoots.includes('data')) {
      result.manifestsRenamed = renameSkillManifests(fs, join(envPathsRoots.data, 'skills'));
    }

    writeBreadcrumb(fs, result, from);
    return result;
  } catch (err) {
    return {
      mode: 'none',
      movedRoots: [],
      manifestsRenamed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Rename each installed skill's manifest and drop the stale install lock.
 *
 * Without the rename an installed skill keeps a manifest the new version cannot
 * see, so `skills update` and `skills uninstall` stop recognising it and the
 * skill becomes an orphan directory that still loads. The lock is transient
 * state; carrying one across versions only lets the new build conclude that
 * some other process is mid-install.
 */
function renameSkillManifests(fs: MigrationFsPort, skillsDir: string): number {
  if (!fs.existsSync(skillsDir)) return 0;

  let renamed = 0;
  for (const entry of fs.readdirSync(skillsDir)) {
    const legacyManifest = join(skillsDir, entry, LEGACY_MANIFEST_FILENAME);
    if (!fs.existsSync(legacyManifest)) continue;
    fs.renameSync(legacyManifest, join(skillsDir, entry, MANIFEST_FILENAME));
    renamed += 1;
  }

  const staleLock = join(skillsDir, LEGACY_LOCK_FILENAME);
  if (fs.existsSync(staleLock)) fs.rmSync(staleLock, { force: true });

  return renamed;
}

/**
 * Support-diagnosis breadcrumb. Deliberately NOT the idempotence key.
 *
 * Swallows its own failures, and that is the whole point of it being a separate
 * function. It writes into the CONFIG root while the migration that just
 * succeeded may only have moved the DATA root — on Windows those are two
 * different trees (`%APPDATA%` vs `%LOCALAPPDATA%`), so the config directory can
 * legitimately not exist yet. Letting an ENOENT here reach the caller's outer
 * catch would report `mode: 'none'` for a migration that in fact moved the
 * user's data, suppressing the stderr notice and telling support the exact
 * opposite of what happened. A missing breadcrumb is a lost diagnostic; a
 * mislabelled result is a lost afternoon.
 */
function writeBreadcrumb(
  fs: MigrationFsPort,
  result: MigrationResult,
  from: Partial<Record<Root, string>>,
): void {
  const payload = {
    migratedAt: new Date().toISOString(),
    mode: result.mode,
    from,
    manifestsRenamed: result.manifestsRenamed,
  };
  try {
    fs.mkdirSync(envPathsRoots.config, { recursive: true });
    fs.writeFileSync(
      join(envPathsRoots.config, LEGACY_MIGRATION_BREADCRUMB_FILENAME),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  } catch {
    // Intentionally ignored — see the note above.
  }
}

/**
 * The one-line notice for a migration that did something.
 *
 * Callers MUST write this to stderr. `screen.ts` holds stdout to the invariant
 * that `aragon -p "..." > out.txt` yields model output and nothing else, and
 * one stray line here would break every scripted invocation.
 *
 * ASCII-only, and `->` rather than an arrow glyph: this prints before any
 * terminal capability probe runs, so a legacy console would render a nicer
 * character as mojibake. Same rule `glyphs.test.ts` enforces across the CLI.
 */
export function formatMigrationNotice(result: MigrationResult): string | null {
  if (result.mode === 'none') return null;
  const skills =
    result.manifestsRenamed > 0 ? ` (${result.manifestsRenamed} skills)` : '';
  return `migrated settings from argon-agent -> aragon-agent${skills}`;
}
