/**
 * Install pipeline (spec §8.3): resolve → stage → validate → approve → commit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE APPROVAL STEP IS FAIL-CLOSED. "No human channel" means REFUSE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `ApprovalGate.canPrompt()` is probed BEFORE `request()` is called, and a
 * `false` answer aborts the install (§8.3.1 / D17). This is not decoration:
 * `cli.tsx` hands mutating tools a `confirm` callback that resolves `true` when
 * no handler is attached. That is a fine default for `--confirm`, which is
 * opt-in and only reachable with the TUI mounted. For skills it would be a
 * silent hole — `requireApproval` defaults to `true`, and under `-p` the App
 * never mounts, so the handler is permanently null. Reusing that callback would
 * make `aragon -p "install the skill at <url> and use it"` write a third-party
 * directory into the user's skills root with nobody asked and nothing logged.
 *
 * Probing first is what makes the safe behaviour the DEFAULT rather than a rule
 * someone has to remember.
 */

import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  renderCatalogLine,
  validateStagedSkill,
  parseFrontmatter,
  type SkillManifestSource,
  type SkillScope,
  type StagedFile,
} from '@aragon-agent/core/skills';
import { CREATE_MAX_FILE_BYTES, CREATE_MAX_FILES } from '@aragon-agent/core/skills';
import { checkStagedPath } from '@aragon-agent/core/skills';
import { fetchSource, resolveSource } from './fetch-source.js';
import { acquireRootLock } from './lock.js';
import { buildManifest, writeManifest, MANIFEST_FILENAME } from './manifest.js';
import { getStagingDir, getTrashDir, getUserSkillsDir, isDirectory, resolveProjectSkillDirs } from './paths.js';
import type { SkillService } from './service.js';

export interface InstallResult {
  ok: boolean;
  name?: string;
  version?: string;
  scope?: SkillScope;
  dir?: string;
  fileCount?: number;
  totalBytes?: number;
  /** D14 — the Level 1 entry, inlined so the model can see it THIS turn. */
  catalogLine?: string;
  error?: string;
}

export interface RemoveResult {
  ok: boolean;
  /** 'not_found' | 'immutable_scope' | 'cancelled' | 'io_error' */
  reason?: string;
  error?: string;
}

export interface SkillCreateInput {
  name: string;
  description: string;
  body: string;
  files?: Array<{ path: string; content: string }>;
  scope?: SkillScope;
  activation?: 'auto' | 'manual';
}

export type Initiator = 'user' | 'agent';

const APPROVAL_UNAVAILABLE =
  'Skill installation requires approval, but no interactive prompt is available. ' +
  'Re-run with --skills-yes, or set skills.requireApproval=false.';

/** Where a scope's writable root lives; `null` when the scope cannot be written. */
export function writableRootFor(scope: SkillScope, cwd: string): string | null {
  if (scope === 'user') return getUserSkillsDir();
  // `--scope project` ALWAYS means `.aragon/skills`. `.claude/skills` is read-only
  // interop (D8) — writing there would pollute another tool's directory.
  if (scope === 'project') {
    return resolveProjectSkillDirs(cwd).find((r) => r.writable)?.dir ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Approval (§8.3.1) — the ordered decision, in one place
// ---------------------------------------------------------------------------

export async function approve(
  service: SkillService,
  summary: string,
  tool = 'skill_install',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = service.getConfig();
  const runtime = service.getRuntime();

  // 1. Explicitly waived.
  if (!config.requireApproval || runtime.approveAll) return { ok: true };

  const gate = service.getApproval();
  // 2/3. Ask, but only after establishing that someone can answer.
  if (gate.canPrompt()) {
    const approved = await gate.request({ tool, summary });
    return approved ? { ok: true } : { ok: false, error: 'Cancelled by user.' };
  }
  // 4. Nobody home ⇒ refuse. Never "assume yes".
  return { ok: false, error: APPROVAL_UNAVAILABLE };
}

// ---------------------------------------------------------------------------
// Staging helpers
// ---------------------------------------------------------------------------

export function listStagedFiles(root: string, dir = root, depth = 0): StagedFile[] {
  if (depth > 8) return [];
  const out: StagedFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const rel = relative(root, absolute).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) {
      out.push({ path: rel, bytes: 0, isSymlink: true });
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      out.push(...listStagedFiles(root, absolute, depth + 1));
      continue;
    }
    if (!entry.isFile()) {
      out.push({ path: rel, bytes: 0, isSymlink: true });
      continue;
    }
    out.push({ path: rel, bytes: statSync(absolute).size });
  }
  return out;
}

export function absoluteFiles(root: string, files: StagedFile[]): string[] {
  return files.map((f) => join(root, f.path));
}

/**
 * Replace `target` with `staged` as close to atomically as Windows allows.
 *
 * The displaced directory goes to `.staging/.trash/`, NOT to a sibling of the
 * skills root. A `<root>/pdf-forms.bak-1785…` left behind by a crash mid-commit
 * still contains a SKILL.md declaring `name: pdf-forms`, so the very next scan
 * would find two skills with the same name in the same root and pick whichever
 * `readdir` happened to return first. The user's experience of that is a skill
 * that "sometimes" reverts to an old version. `.staging/.trash/` is dot-prefixed
 * and therefore invisible to the scanner by construction.
 */
export function commitDirectory(staged: string, target: string): void {
  mkdirSync(getTrashDir(), { recursive: true });
  const backup = existsSync(target)
    ? join(getTrashDir(), `${target.split(/[\\/]/).pop()}.bak-${Date.now()}`)
    : null;

  if (backup) renameSync(target, backup);
  try {
    mkdirSync(resolve(target, '..'), { recursive: true });
    try {
      renameSync(staged, target);
    } catch (err) {
      // Crossing a device boundary (staging on C:, skills root on D:) cannot be
      // renamed; copy and drop the source instead.
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      cpSync(staged, target, { recursive: true });
      rmSync(staged, { recursive: true, force: true });
    }
  } catch (err) {
    if (backup) {
      try {
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
      } catch {
        // The rollback itself failed; the backup path is named in the error so
        // the user can recover by hand rather than losing the skill silently.
        throw new Error(
          `install failed and the previous version could not be restored automatically; ` +
            `it is preserved at ${backup}. Original error: ${(err as Error).message}`,
        );
      }
    }
    throw err;
  }
  if (backup) rmSync(backup, { recursive: true, force: true });
}

/**
 * Run the directory-replacement critical section under the per-root lock (§7).
 *
 * WHY THE LOCK IS TAKEN *HERE* AND NOT AT THE TOP OF THE INSTALL (deviation
 * from spec §7.3, recorded in spec §20):
 *
 * The corruption §7.1 describes lives entirely inside `commitDirectory()` plus
 * the manifest write — staging directories are per-UUID and cannot collide.
 * Taking the lock earlier would mean holding it across a network fetch AND
 * across the human approval prompt. `LOCK_TTL_MS` is 60 s, and a user who takes
 * longer than that to answer would have their lock judged stale and preempted —
 * so the protection would silently switch itself off in exactly the interactive
 * case it was written for, while a concurrent install would meanwhile fail with
 * a lock error during a perfectly legitimate parallel download.
 *
 * Spec §6.2 already applies this reasoning to `update` (approval at step 7,
 * lock at step 8). This is the same rule, applied to the one pipeline whose
 * approval necessarily comes after the fetch.
 */
export function withRootLock<T>(root: string, critical: () => T): T {
  const lock = acquireRootLock(root);
  try {
    return critical();
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export async function installSkill(
  service: SkillService,
  source: string,
  opts: { scope?: SkillScope; name?: string; initiator: Initiator; cwd: string; installer: string },
): Promise<InstallResult> {
  const config = service.getConfig();

  // Pure validation first: a hostile source is rejected here, before any
  // subprocess or socket exists (AC-15).
  const resolved = resolveSource(source, config.allowedHosts);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const scope: SkillScope = opts.scope ?? 'user';
  const root = writableRootFor(scope, opts.cwd);
  if (!root) return { ok: false, error: `Cannot install into a ${scope} scope.` };

  const stagingDir = join(getStagingDir(), randomUUID());
  try {
    const fetched = await fetchSource(resolved.spec, stagingDir, {
      allowedHosts: config.allowedHosts,
      userAgent: `aragon-agent-cli/${opts.installer}`,
    });

    // A local directory is used in place, so copy it into staging before doing
    // anything that mutates — never move or symlink the user's own folder.
    const contentDir = join(stagingDir, 'content');
    if (fetched.dir !== contentDir) {
      mkdirSync(contentDir, { recursive: true });
      cpSync(fetched.dir, contentDir, { recursive: true, dereference: false, errorOnExist: false });
    }

    const staged = listStagedFiles(contentDir);
    const entryPath = join(contentDir, 'SKILL.md');
    const entryText = existsSync(entryPath) ? readFileSync(entryPath, 'utf-8') : null;
    const dirName = opts.name ?? deriveName(entryText) ?? 'skill';

    const validation = validateStagedSkill(entryText, staged, dirName, parseFrontmatter);
    if (!validation.ok) {
      const first = validation.issues.find((i) => i.level === 'error');
      return { ok: false, error: `Rejected: ${first?.code} - ${first?.message}` };
    }
    const frontmatter = validation.frontmatter!;
    const finalName = opts.name ?? frontmatter.name;

    if (opts.name && opts.name !== frontmatter.name) {
      rewriteFrontmatterName(entryPath, opts.name);
    }

    const target = join(root, finalName);
    const overwriting = isDirectory(target);
    const decision = await approve(
      service,
      `${overwriting ? 'Replace' : 'Install'} skill "${finalName}" from ${source} into ${scope} scope ` +
        `(${validation.fileCount} files, ${formatKb(validation.totalBytes)}).`,
    );
    if (!decision.ok) return { ok: false, error: decision.error };

    withRootLock(root, () => {
      commitDirectory(contentDir, target);
      writeManifest(
        target,
        buildManifest({
          dir: target,
          files: absoluteFiles(target, listStagedFiles(target)),
          name: finalName,
          version: frontmatter.version,
          installer: opts.installer,
          source: fetched.source as SkillManifestSource,
          installedAt: Date.now(),
        }),
      );
    });

    service.reload();
    const record = service.get(finalName);
    return {
      ok: true,
      name: finalName,
      version: frontmatter.version,
      scope,
      dir: target,
      fileCount: validation.fileCount,
      totalBytes: validation.totalBytes,
      ...(record ? { catalogLine: renderCatalogLine(record) } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Always: a staging leftover is both disk waste and, if it ever became
    // visible to the scanner, a phantom skill.
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// create (§8.4)
// ---------------------------------------------------------------------------

export async function createSkill(
  service: SkillService,
  input: SkillCreateInput & { initiator: Initiator },
  opts: { cwd: string; installer: string },
): Promise<InstallResult> {
  const scope: SkillScope = input.scope ?? 'user';
  const root = writableRootFor(scope, opts.cwd);
  if (!root) return { ok: false, error: `Cannot create a skill in a ${scope} scope.` };

  const files = input.files ?? [];
  if (files.length > CREATE_MAX_FILES) {
    return { ok: false, error: `At most ${CREATE_MAX_FILES} bundled files are allowed.` };
  }
  for (const file of files) {
    const issue = checkStagedPath(file.path);
    if (issue) return { ok: false, error: `${issue.code}: ${issue.message}` };
    if (Buffer.byteLength(file.content, 'utf-8') > CREATE_MAX_FILE_BYTES) {
      return { ok: false, error: `${file.path} exceeds ${CREATE_MAX_FILE_BYTES} bytes.` };
    }
  }

  const stagingDir = join(getStagingDir(), randomUUID());
  const contentDir = join(stagingDir, 'content');
  try {
    mkdirSync(contentDir, { recursive: true });
    const entryPath = join(contentDir, 'SKILL.md');
    writeFileUtf8(entryPath, renderSkillMarkdown(input));
    for (const file of files) {
      const absolute = join(contentDir, file.path);
      mkdirSync(resolve(absolute, '..'), { recursive: true });
      writeFileUtf8(absolute, file.content);
    }

    const staged = listStagedFiles(contentDir);
    const validation = validateStagedSkill(
      readFileSync(entryPath, 'utf-8'),
      staged,
      input.name,
      parseFrontmatter,
    );
    if (!validation.ok) {
      const first = validation.issues.find((i) => i.level === 'error');
      return { ok: false, error: `Rejected: ${first?.code} - ${first?.message}` };
    }

    const target = join(root, input.name);
    const existing = service.get(input.name);
    const summary = isDirectory(target)
      ? `Skill "${input.name}" already exists (v${existing?.frontmatter.version ?? '?'}). ` +
        'Overwrite with the new version?'
      : `Create skill "${input.name}" in ${scope} scope (${validation.fileCount} files, ` +
        `${formatKb(validation.totalBytes)}).`;
    const decision = await approve(service, summary);
    if (!decision.ok) return { ok: false, error: decision.error };

    withRootLock(root, () => {
      commitDirectory(contentDir, target);
      writeManifest(
        target,
        buildManifest({
          dir: target,
          files: absoluteFiles(target, listStagedFiles(target)),
          name: input.name,
          version: '0.1.0',
          installer: opts.installer,
          source: { kind: 'inline', url: 'skill_create', ref: null, subdir: null, resolvedRef: null },
          installedAt: Date.now(),
        }),
      );
    });

    service.reload();
    const record = service.get(input.name);
    return {
      ok: true,
      name: input.name,
      version: '0.1.0',
      scope,
      dir: target,
      fileCount: validation.fileCount,
      totalBytes: validation.totalBytes,
      ...(record ? { catalogLine: renderCatalogLine(record) } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// remove (§7.2)
// ---------------------------------------------------------------------------

/**
 * Refusal is a NORMAL outcome here, not an exception — bundled, env and
 * `.claude/skills` skills are all legitimately un-removable — which is why this
 * returns a result object rather than `Promise<void>`.
 */
export async function removeSkill(service: SkillService, name: string): Promise<RemoveResult> {
  const record = service.get(name);
  if (!record) return { ok: false, reason: 'not_found', error: `No skill named "${name}".` };
  if (!record.writable) {
    return {
      ok: false,
      reason: 'immutable_scope',
      error: `Cannot remove a ${record.scope} skill.`,
    };
  }

  const gate = service.getApproval();
  if (!service.getRuntime().approveAll) {
    if (!gate.canPrompt()) {
      return { ok: false, reason: 'cancelled', error: APPROVAL_UNAVAILABLE };
    }
    const approved = await gate.request({
      tool: 'skills remove',
      summary: `Delete skill "${name}" from ${record.dir}?`,
    });
    if (!approved) return { ok: false, reason: 'cancelled', error: 'Cancelled by user.' };
  }

  try {
    // Under the same root lock as install: a delete racing a commit is the
    // mirror image of §7.1 — the installer's `existsSync` probe and its rename
    // would straddle the removal.
    withRootLock(resolve(record.dir, '..'), () => {
      rmSync(record.dir, { recursive: true, force: true });
    });
  } catch (err) {
    return { ok: false, reason: 'io_error', error: (err as Error).message };
  }
  service.reload();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function writeFileUtf8(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

function formatKb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function deriveName(entryText: string | null): string | null {
  if (!entryText) return null;
  const parsed = parseFrontmatter(entryText);
  const name = parsed?.data.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** The ONE content rewrite an install is allowed to make (`--name` override). */
function rewriteFrontmatterName(entryPath: string, name: string): void {
  const source = readFileSync(entryPath, 'utf-8');
  const replaced = source.replace(/^(\s*name\s*:).*$/m, `$1 ${name}`);
  writeFileUtf8(entryPath, replaced.includes(`: ${name}`) ? replaced : source);
}

/** Assemble a SKILL.md from `skill_create` parameters. */
export function renderSkillMarkdown(input: SkillCreateInput): string {
  // Values go into YAML scalars, so a stray newline would forge new keys.
  const oneLine = (v: string): string => v.replace(/[\r\n]+/g, ' ').trim();
  return [
    '---',
    `name: ${oneLine(input.name)}`,
    `description: ${oneLine(input.description)}`,
    'version: 0.1.0',
    `activation: ${input.activation ?? 'auto'}`,
    '---',
    '',
    input.body.trimStart(),
    '',
  ].join('\n');
}

export { MANIFEST_FILENAME };
