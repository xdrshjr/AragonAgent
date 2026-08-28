/**
 * Skill root resolution — the four scopes of spec §6.1, in ASCENDING precedence.
 *
 *   bundled  <pkg>/skills          shipped with the npm package, read-only
 *   user     <data>/skills         where `aragon skills install` writes
 *   project  <cwd>/.aragon/skills   + <cwd>/.claude/skills (read-only)
 *   env      ARAGON_SKILLS_PATH     debugging / CI override, read-only
 *
 * Same layering the config resolver already uses (defaults › file › env ›
 * flags), so there is no second mental model to learn.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { SkillScope } from '@aragon-agent/core';
import { getUserDataDir, getUserSkillsDir } from '../config/app-paths.js';

export interface SkillRoot {
  dir: string;
  scope: SkillScope;
  /** False for bundled / env / `.claude/skills` — install and remove refuse these. */
  writable: boolean;
}

// `<data>` is `~/.aragon-agent` and `<data>/skills` its `skills/` child. Both
// are defined in `config/app-paths.ts` and only re-exported here: the skill
// modules (and their test mocks) import them from this path, and two separate
// definitions of the same directory is the drift this module's header warns
// about.
export { getUserDataDir, getUserSkillsDir };

/** `<data>/skills/.staging` — scratch space for in-flight installs (§8.3). */
export function getStagingDir(): string {
  return join(getUserSkillsDir(), '.staging');
}

/** `<data>/skills/.staging/.trash` — where a replaced skill is parked (P1-6). */
export function getTrashDir(): string {
  return join(getStagingDir(), '.trash');
}

/**
 * `<pkg>/skills` — the DATA directory of bundled skills.
 *
 * Not to be confused with `<pkg>/dist/skills`, which is the compiled output of
 * `src/skills/*.ts`. This module lives at `src/skills/paths.ts` in dev and at
 * `dist/skills/paths.js` after a build, so `'..', '..'` resolves to `<pkg>` in
 * BOTH states — no `isPackaged`-style branch is needed or wanted.
 */
export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
}

/**
 * Project roots for a working directory. `.claude/skills` is included for
 * drop-in Claude Code interop (D8) and is marked read-only: `--scope project`
 * always writes to `.aragon/skills`, never into another tool's directory.
 */
export function resolveProjectSkillDirs(
  cwd: string,
  projectDirs: string[] = ['.aragon/skills', '.claude/skills'],
): SkillRoot[] {
  return projectDirs.map((rel) => ({
    dir: resolve(cwd, rel),
    scope: 'project' as const,
    writable: rel.replace(/\\/g, '/').startsWith('.aragon/'),
  }));
}

/** Roots listed in `ARAGON_SKILLS_PATH`, split on the platform delimiter. */
export function resolveEnvSkillDirs(value = process.env.ARAGON_SKILLS_PATH): SkillRoot[] {
  if (!value || value.trim().length === 0) return [];
  return value
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ dir: resolve(p), scope: 'env' as const, writable: false }));
}

/**
 * All roots in ascending precedence. Non-existent directories are kept in the
 * list — the scanner skips them — so callers can report "where would this go?"
 * without a second resolution pass.
 */
export function resolveSkillRoots(cwd: string, projectDirs?: string[]): SkillRoot[] {
  return [
    { dir: getBundledSkillsDir(), scope: 'bundled', writable: false },
    { dir: getUserSkillsDir(), scope: 'user', writable: true },
    ...resolveProjectSkillDirs(cwd, projectDirs),
    ...resolveEnvSkillDirs(),
  ];
}

/**
 * Canonical form of a directory for `trustedProjectDirs` comparison (P2-7).
 *
 * Without this, `C:\Repo\` and `c:\repo` are two different entries and the user
 * gets asked to trust the same folder over and over — which trains them to
 * click "yes" without reading, a strictly worse outcome than never asking.
 * Returns `null` when the path cannot be resolved (deleted directory), so the
 * caller skips it rather than persisting a stale entry.
 */
export function normalizeTrustPath(dir: string): string | null {
  try {
    let real = realpathSync.native(resolve(dir));
    while (real.length > 1 && real.endsWith(sep)) real = real.slice(0, -1);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

/** True when `dir` exists and is a directory (never throws). */
export function isDirectory(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
