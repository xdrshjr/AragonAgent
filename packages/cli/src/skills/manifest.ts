/**
 * `.argon-skill.json` — the install manifest (spec §10.2 / D15).
 *
 * Records provenance (where this skill came from) and a sha256 per file. That
 * pays for three things at once: `/skills info` can answer "where did this come
 * from", `skills doctor` can spot tampering, and an uninstall can remove
 * exactly what was installed instead of nuking a directory the user may have
 * added their own files to.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SkillManifest, SkillManifestFile, SkillManifestSource } from '@argon-agent/core/skills';

export const MANIFEST_FILENAME = '.argon-skill.json';
export const MANIFEST_SCHEMA = 1;

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Read a manifest, or `null` when it is absent, unreadable, or written by a
 * newer schema. An unknown schema is deliberately NOT an error: the skill still
 * works, we just cannot make provenance claims about it.
 */
export function readManifest(path: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SkillManifest;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schema !== MANIFEST_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeManifest(dir: string, manifest: SkillManifest): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf-8',
  });
}

/**
 * Build a manifest by hashing every file that was just installed.
 *
 * `updatedAt` / `previousVersion` are written only by `skills update`, which
 * also carries `installedAt` FORWARD from the old manifest: "when did I first
 * install this" and "when was it last changed" answer different questions, and
 * collapsing them loses the one the user actually asks during an incident.
 */
export function buildManifest(input: {
  dir: string;
  files: string[];
  name: string;
  version: string;
  installer: string;
  source: SkillManifestSource;
  installedAt: number;
  updatedAt?: number;
  previousVersion?: string;
}): SkillManifest {
  const files: SkillManifestFile[] = [];
  let totalBytes = 0;
  for (const absolute of input.files) {
    const rel = relative(input.dir, absolute).replace(/\\/g, '/');
    if (rel === MANIFEST_FILENAME) continue;
    const bytes = statSync(absolute).size;
    totalBytes += bytes;
    files.push({ path: rel, bytes, sha256: sha256File(absolute) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {
    schema: MANIFEST_SCHEMA,
    name: input.name,
    version: input.version,
    installedAt: input.installedAt,
    installer: input.installer,
    source: input.source,
    files,
    totalBytes,
    // Written only when present, so a fresh install's manifest is byte-identical
    // to what iteration 1 produced.
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
    ...(input.previousVersion !== undefined ? { previousVersion: input.previousVersion } : {}),
  };
}

/** sha256 of an in-memory buffer — the same digest `sha256File` produces. */
export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface TamperReport {
  missing: string[];
  modified: string[];
}

/** Compare a manifest against what is actually on disk (`skills doctor`). */
export function checkManifest(dir: string, manifest: SkillManifest): TamperReport {
  const missing: string[] = [];
  const modified: string[] = [];
  for (const file of manifest.files) {
    const absolute = join(dir, file.path);
    try {
      if (sha256File(absolute) !== file.sha256) modified.push(file.path);
    } catch {
      missing.push(file.path);
    }
  }
  return { missing, modified };
}
