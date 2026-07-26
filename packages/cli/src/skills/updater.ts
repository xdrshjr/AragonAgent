/**
 * `skills update` (spec §6) — re-fetch an installed skill from its recorded
 * source.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE STEP ORDER IS THE DESIGN. Do not reorder it for readability.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every cheap, local, refusable check runs BEFORE anything that touches the
 * network or the disk (§6.2). Two of those orderings are load-bearing:
 *
 *   · LOCAL MODIFICATIONS (step 5) are detected before the download, so a user
 *     whose edits would be discarded is told so without having paid for a clone
 *     first — and the refusal ends with "nothing was downloaded", which is what
 *     makes retrying obviously safe.
 *
 *   · THE HOST ALLOWLIST IS RE-CHECKED (step 6, D-A7). The URL in the manifest
 *     passed policy at INSTALL time. If the user has since narrowed
 *     `skills.allowedHosts`, honouring the stored URL would make that setting
 *     silently inert on the one path that re-downloads code. Iteration 1 shipped
 *     the same class of bug via the `github:` shorthand; this is the same
 *     mistake wearing a different hat.
 *
 * NOT AVAILABLE TO THE MODEL (D-A5). Installing is "the user pointed at a source
 * and I did the work"; updating is "the thing that was working is now different
 * code". Its failure mode is regression, not refusal, and an agent that can swap
 * out its own behavioural rules mid-task while nobody is watching is not a
 * capability anyone asked for.
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  parseFrontmatter,
  validateStagedSkill,
  type SkillManifestSource,
} from '@argon-agent/core/skills';
import {
  checkUrlAllowed,
  fetchSource,
  gitLsRemote,
  type FetchDeps,
  type SourceSpec,
} from './fetch-source.js';
import {
  absoluteFiles,
  approve,
  commitDirectory,
  listStagedFiles,
  type Initiator,
} from './installer.js';
import { acquireRootLock } from './lock.js';
import { buildManifest, checkManifest, writeManifest } from './manifest.js';
import { getStagingDir } from './paths.js';
import type { SkillService } from './service.js';

export type UpdateReason =
  | 'not_found'
  | 'immutable_scope'
  | 'no_manifest'
  | 'no_upstream'
  | 'source_unavailable'
  | 'host_not_allowed'
  | 'locally_modified'
  | 'cancelled'
  | 'locked'
  | 'validation_failed'
  | 'io_error';

export interface UpdateResult {
  ok: boolean;
  name: string;
  changed: boolean;
  fromVersion?: string;
  toVersion?: string;
  reason?: UpdateReason;
  error?: string;
  /** Under `--dry-run`: the paths that would be added, removed or rewritten. */
  changedFiles?: string[];
}

export interface UpdateOptions {
  cwd: string;
  installer: string;
  dryRun?: boolean;
  force?: boolean;
  initiator?: Initiator;
  /** Injected in tests to assert that a refusal reached NO network at all. */
  fetchDeps?: Partial<FetchDeps>;
}

/** `skipped` outcomes are normal for `--all`; only these two are real failures. */
const HARD_FAILURES = new Set<UpdateReason>(['validation_failed', 'io_error']);

export function isHardFailure(result: UpdateResult): boolean {
  return !result.ok && result.reason !== undefined && HARD_FAILURES.has(result.reason);
}

// ---------------------------------------------------------------------------
// Manifest source -> fetchable spec
// ---------------------------------------------------------------------------

/**
 * Rebuild an install spec from what the manifest recorded, re-applying today's
 * host policy (D-A7).
 *
 * Pure — spawns nothing, opens no socket. That is what lets `AC-A6` assert a
 * zero-call `runProcess` on the refusal path rather than merely asserting that
 * an error came back.
 */
export function specFromManifestSource(
  src: SkillManifestSource,
  allowedHosts: string[],
): { ok: true; spec: SourceSpec } | { ok: false; reason: UpdateReason; error: string } {
  switch (src.kind) {
    case 'inline':
      return {
        ok: false,
        reason: 'no_upstream',
        error: 'this skill was authored locally and has no upstream to update from',
      };

    case 'local-dir':
      if (!existsSync(src.url)) {
        return { ok: false, reason: 'source_unavailable', error: `${src.url} no longer exists` };
      }
      return { ok: true, spec: { kind: 'local-dir', path: src.url } };

    case 'local-file':
      if (!existsSync(src.url)) {
        return { ok: false, reason: 'source_unavailable', error: `${src.url} no longer exists` };
      }
      return { ok: true, spec: { kind: 'local-file', path: src.url } };

    case 'git':
    case 'https-md':
    case 'https-zip': {
      const checked = checkUrlAllowed(src.url, allowedHosts);
      if (!checked.ok) return { ok: false, reason: 'host_not_allowed', error: checked.error };
      if (src.kind === 'git') {
        return {
          ok: true,
          spec: { kind: 'git', url: src.url, ref: src.ref, subdir: src.subdir },
        };
      }
      return { ok: true, spec: { kind: src.kind, url: src.url } };
    }
  }
}

// ---------------------------------------------------------------------------
// updateSkill
// ---------------------------------------------------------------------------

interface FileDigest {
  path: string;
  sha256: string;
}

/** Paths that differ between two manifest file lists (added, removed, rewritten). */
function diffFiles(before: FileDigest[], after: FileDigest[]): string[] {
  const oldMap = new Map(before.map((f) => [f.path, f.sha256]));
  const newMap = new Map(after.map((f) => [f.path, f.sha256]));
  const changed = new Set<string>();
  for (const [path, sha] of newMap) if (oldMap.get(path) !== sha) changed.add(path);
  for (const path of oldMap.keys()) if (!newMap.has(path)) changed.add(path);
  return [...changed].sort((a, b) => a.localeCompare(b, 'en'));
}

export async function updateSkill(
  service: SkillService,
  name: string,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  const fail = (reason: UpdateReason, error: string): UpdateResult => ({
    ok: false,
    name,
    changed: false,
    reason,
    error,
  });

  // 1-4 — pure, in-memory refusals. Nothing below this point should be reached
  // by a skill that simply has no upstream.
  const record = service.get(name);
  if (!record) return fail('not_found', `No skill named "${name}".`);
  if (!record.writable) {
    return fail('immutable_scope', `Cannot update a ${record.scope} skill.`);
  }
  const manifest = record.manifest;
  if (!manifest) {
    return fail(
      'no_manifest',
      `"${name}" has no install manifest, so there is nothing to update it from. ` +
        'Overwriting it would delete files nobody recorded.',
    );
  }
  if (manifest.source.kind === 'inline') {
    return fail('no_upstream', `"${name}" was created locally and has no upstream.`);
  }

  // 5 — local modifications, BEFORE any download (§6.2).
  //
  // Computed even under `--force`, because step 10 needs it: "upstream matches
  // the manifest" does NOT imply "the disk matches upstream" once the working
  // copy has diverged, and restoring a diverged copy is exactly what someone
  // typing `--force` is asking for.
  const tamper = checkManifest(record.dir, manifest);
  const locallyModified = [...tamper.modified, ...tamper.missing].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  if (!opts.force && locallyModified.length > 0) {
    return fail(
      'locally_modified',
      `${name} has local changes that update would discard: ${locallyModified.join(', ')}\n` +
        'Re-run with --force to overwrite, or copy your edits out first.\n' +
        '(nothing was downloaded)',
    );
  }

  // 6 — today's host policy, still before the network.
  const config = service.getConfig();
  const resolved = specFromManifestSource(manifest.source, config.allowedHosts);
  if (!resolved.ok) return fail(resolved.reason, resolved.error);

  // 7 — the same fail-closed gate an install goes through (D17).
  const decision = await approve(
    service,
    `Update skill "${name}" (v${manifest.version}) from ${manifest.source.url}.`,
    'skills update',
  );
  if (!decision.ok) return fail('cancelled', decision.error);

  // 8 — the lock. Taken after approval so it is never held across a human
  // decision, which would let LOCK_TTL_MS expire and the lock be preempted.
  const root = resolve(record.dir, '..');
  let lock;
  try {
    lock = acquireRootLock(root);
  } catch (err) {
    return fail('locked', err instanceof Error ? err.message : String(err));
  }

  const stagingDir = join(getStagingDir(), randomUUID());
  try {
    // 9 — fetch and validate through EXACTLY the install path. A second,
    // weaker validator here would be a hole that only opens on the update route.
    const fetched = await fetchSource(resolved.spec, stagingDir, {
      allowedHosts: config.allowedHosts,
      userAgent: `argon-agent-cli/${opts.installer}`,
      ...(opts.fetchDeps ?? {}),
    });

    const contentDir = join(stagingDir, 'content');
    if (fetched.dir !== contentDir) {
      mkdirSync(contentDir, { recursive: true });
      cpSync(fetched.dir, contentDir, { recursive: true, dereference: false, errorOnExist: false });
    }

    const staged = listStagedFiles(contentDir);
    const entryPath = join(contentDir, 'SKILL.md');
    const entryText = existsSync(entryPath) ? readFileSync(entryPath, 'utf-8') : null;
    const validation = validateStagedSkill(entryText, staged, name, parseFrontmatter);
    if (!validation.ok) {
      const first = validation.issues.find((i) => i.level === 'error');
      return fail('validation_failed', `Rejected: ${first?.code} - ${first?.message}`);
    }
    const frontmatter = validation.frontmatter!;

    // 10 — content comparison. Identical upstream ⇒ touch NOTHING: rewriting an
    // unchanged directory would bump every mtime and make the next discovery
    // pass look like a change that never happened.
    const next = buildManifest({
      dir: contentDir,
      files: absoluteFiles(contentDir, staged),
      name,
      version: frontmatter.version,
      installer: opts.installer,
      source: fetched.source as SkillManifestSource,
      installedAt: manifest.installedAt,
    });
    // Under `--force`, a file the user edited will be rewritten even though
    // upstream itself did not move, so it belongs in the "will change" set.
    const changedFiles = [
      ...new Set([...diffFiles(manifest.files, next.files), ...(opts.force ? locallyModified : [])]),
    ].sort((a, b) => a.localeCompare(b, 'en'));

    if (changedFiles.length === 0) {
      return {
        ok: true,
        name,
        changed: false,
        fromVersion: manifest.version,
        toVersion: frontmatter.version,
      };
    }

    // 11 — dry run stops here, having written nothing outside staging.
    if (opts.dryRun) {
      return {
        ok: true,
        name,
        changed: true,
        fromVersion: manifest.version,
        toVersion: frontmatter.version,
        changedFiles,
      };
    }

    // 12/13 — atomic replace plus the new manifest.
    //
    // NOT wrapped in `withRootLock`: step 8 already acquired the lock for this
    // root, and `acquireRootLock` is NOT reentrant — a second acquire would sit
    // out the full `LOCK_MAX_WAIT_MS` waiting for a lock this very call stack
    // holds, then fail every update with a spurious "another argon process is
    // installing skills".
    //
    // `installedAt` is carried forward; `updatedAt` / `previousVersion` record
    // this event.
    commitDirectory(contentDir, record.dir);
    writeManifest(
      record.dir,
      buildManifest({
        dir: record.dir,
        files: absoluteFiles(record.dir, listStagedFiles(record.dir)),
        name,
        version: frontmatter.version,
        installer: opts.installer,
        source: fetched.source as SkillManifestSource,
        installedAt: manifest.installedAt,
        updatedAt: Date.now(),
        previousVersion: manifest.version,
      }),
    );

    // 15 — make the catalog and the slash commands reflect the new version now,
    // not on the next launch.
    //
    // Reporting the outcome is the CALLER's job, exactly as it is for
    // `installSkill()`. Announcing it from here as well printed the same line
    // twice on both surfaces, and under `--all` it interleaved N per-skill
    // notices through the summary table that exists to replace them.
    service.reload();

    return {
      ok: true,
      name,
      changed: true,
      fromVersion: manifest.version,
      toVersion: frontmatter.version,
      changedFiles,
    };
  } catch (err) {
    return fail('io_error', err instanceof Error ? err.message : String(err));
  } finally {
    // 14 — always, in this order.
    lock.release();
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// updateAllSkills
// ---------------------------------------------------------------------------

/**
 * Update every skill that has an upstream, serially.
 *
 * ONE FAILURE NEVER STOPS THE REST. In a set of thirty skills, a single dead
 * repository is an ordinary Tuesday; aborting the run there would leave the
 * other twenty-nine stale for a reason the user did not choose.
 *
 * Skills that cannot have an upstream (bundled, hand-authored, `skill_create`
 * output) are filtered out rather than reported as errors — they are not
 * failures, they are simply not candidates.
 */
export async function updateAllSkills(
  service: SkillService,
  opts: UpdateOptions,
): Promise<UpdateResult[]> {
  const candidates = service
    .list()
    .filter((r) => r.writable && r.manifest !== null && r.manifest.source.kind !== 'inline');

  const results: UpdateResult[] = [];
  for (const record of candidates) {
    results.push(await updateSkill(service, record.name, opts));
  }
  return results;
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  name: string;
  status: 'up-to-date' | 'outdated' | 'unknown';
  /** What the manifest recorded at install time. */
  currentRef?: string;
  remoteRef?: string;
  detail?: string;
}

/**
 * Ask whether an update exists, WITHOUT downloading one.
 *
 * `unknown` is a first-class, frequently-correct answer (§6.4): a manifest
 * written before `resolvedRef` existed, an https zip with no version handle, or
 * a repo git cannot reach all genuinely leave us unable to tell. Reporting
 * "up to date" in those cases would be a guess presented as a fact.
 */
export async function checkSkillUpdate(
  service: SkillService,
  name: string,
  deps: Partial<FetchDeps> = {},
): Promise<UpdateCheckResult> {
  const record = service.get(name);
  if (!record) return { name, status: 'unknown', detail: 'not installed' };
  const manifest = record.manifest;
  if (!manifest) return { name, status: 'unknown', detail: 'no install manifest' };
  if (manifest.source.kind !== 'git') {
    return { name, status: 'unknown', detail: `${manifest.source.kind} sources cannot be checked` };
  }
  const pinned = manifest.source.resolvedRef ?? null;
  if (!pinned) {
    return { name, status: 'unknown', detail: 'installed before commit pinning was recorded' };
  }

  // Same allowlist re-validation as a real update — a `--check` is still an
  // outbound request to whatever the manifest names.
  const config = service.getConfig();
  const allowed = checkUrlAllowed(manifest.source.url, config.allowedHosts);
  if (!allowed.ok) return { name, status: 'unknown', detail: allowed.error };

  const remote = await gitLsRemote(manifest.source.url, manifest.source.ref, {
    allowedHosts: config.allowedHosts,
    ...deps,
  });
  if (!remote) return { name, status: 'unknown', currentRef: pinned, detail: 'remote did not answer' };
  return {
    name,
    status: remote === pinned ? 'up-to-date' : 'outdated',
    currentRef: pinned,
    remoteRef: remote,
  };
}
