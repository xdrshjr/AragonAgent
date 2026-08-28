/**
 * AC-A4 .. AC-A7 — `skills update` (§6).
 *
 * TWO OF THESE ARE RED-TEAM TESTS, and they are written the way §14.3 demands:
 * they assert the injected `fetchImpl` / `runProcess` were called ZERO times,
 * not merely that an error came back. "Returned an error" is satisfied by an
 * implementation that downloads the whole repository first and then refuses —
 * which is precisely the behaviour the ordering in §6.2 exists to prevent, and
 * precisely what a weaker assertion would let through.
 *
 *   AC-A5  local modifications refuse BEFORE the network.
 *   AC-A6  a host removed from `allowedHosts` refuses BEFORE the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tmp = { root: '' };

vi.mock('../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
  const data = (): string => join(tmp.root, 'data');
  const user = (): string => join(data(), 'skills');
  return {
    ...actual,
    getUserDataDir: data,
    getBundledSkillsDir: () => join(tmp.root, 'bundled'),
    getUserSkillsDir: user,
    getStagingDir: () => join(user(), '.staging'),
    getTrashDir: () => join(user(), '.staging', '.trash'),
    resolveSkillRoots: (cwd: string, projectDirs?: string[]) => [
      { dir: user(), scope: 'user' as const, writable: true },
      ...actual.resolveProjectSkillDirs(cwd, projectDirs),
    ],
  };
});

const { SkillService } = await import('../service.js');
const { createNodeSkillHost } = await import('../node-host.js');
const { buildManifest, writeManifest } = await import('../manifest.js');
const { specFromManifestSource, updateAllSkills, updateSkill } = await import('../updater.js');
const { cleanup, makeTmpDir, runtimeOptions, skillsConfig, writeSkill } = await import('./helpers.js');
import type { SkillsConfig } from '../../config/schema.js';
import type { SkillManifestSource } from '@aragon-agent/core/skills';

const skillsRoot = (): string => join(tmp.root, 'data', 'skills');
const upstream = (): string => join(tmp.root, 'upstream');

/** Counts every outbound attempt, so a refusal path can be proven inert. */
function spyDeps() {
  const runProcess = vi.fn(async () => ({ stdout: '' }));
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
  return { runProcess, fetchImpl, calls: () => runProcess.mock.calls.length + fetchImpl.mock.calls.length };
}

function makeService(config: Partial<SkillsConfig> = {}, approve = true) {
  return new SkillService({
    host: createNodeSkillHost(),
    getCwd: () => join(tmp.root, 'cwd'),
    config: skillsConfig({ usageTracking: false, ...config }),
    runtime: runtimeOptions({ approveAll: approve }),
    approval: { canPrompt: () => approve, request: async () => approve },
  });
}

/**
 * Install `name` from a LOCAL DIRECTORY source, then rewrite the manifest's
 * recorded source so the test can pretend it came from anywhere it likes while
 * the actual fetch stays offline and deterministic.
 */
function installFrom(
  name: string,
  opts: { version?: string; body?: string; source?: SkillManifestSource; files?: Record<string, string> } = {},
): string {
  const dir = writeSkill(skillsRoot(), name, {
    version: opts.version ?? '1.0.0',
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.files ? { files: opts.files } : {}),
  });
  const files = [join(dir, 'SKILL.md'), ...Object.keys(opts.files ?? {}).map((f) => join(dir, f))];
  writeManifest(
    dir,
    buildManifest({
      dir,
      files,
      name,
      version: opts.version ?? '1.0.0',
      installer: 'test',
      source: opts.source ?? { kind: 'local-dir', url: upstream(), ref: null, subdir: null },
      installedAt: 1_700_000_000_000,
    }),
  );
  return dir;
}

/**
 * Write what the upstream directory should look like on the next fetch.
 *
 * The description is pinned explicitly: `writeSkill` derives its default from
 * the DIRECTORY name, which is `upstream` here and `<name>` for the installed
 * copy — leaving them implicit would make every fixture differ by one line and
 * quietly turn the "unchanged upstream" case into a changed one.
 */
function writeUpstream(name: string, opts: { version?: string; body?: string; files?: Record<string, string> } = {}): void {
  writeSkill(tmp.root, 'upstream', {
    name,
    description: `Does ${name}. Use when the task mentions ${name}.`,
    version: opts.version ?? '2.0.0',
    ...(opts.body ? { body: opts.body } : {}),
    ...(opts.files ? { files: opts.files } : {}),
  });
}

function readManifestOf(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(skillsRoot(), name, '.aragon-skill.json'), 'utf-8'));
}

beforeEach(() => {
  tmp.root = makeTmpDir('aragon-update-');
  mkdirSync(skillsRoot(), { recursive: true });
  mkdirSync(join(tmp.root, 'cwd'), { recursive: true });
});
afterEach(() => cleanup(tmp.root));

// ---------------------------------------------------------------------------

describe('updateSkill — refusals that must never reach the network', () => {
  it('AC-A5: local modifications refuse with ZERO outbound calls', async () => {
    const dir = installFrom('pdf-forms');
    writeUpstream('pdf-forms');
    appendFileSync(join(dir, 'SKILL.md'), '\nmy own note\n', 'utf-8');

    const deps = spyDeps();
    const service = makeService();
    service.discover();

    const result = await updateSkill(service, 'pdf-forms', {
      cwd: tmp.root,
      installer: 'test',
      fetchDeps: deps,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('locally_modified');
    expect(result.error).toContain('SKILL.md');
    // The message promises no side effects; the counter proves it.
    expect(result.error).toContain('(nothing was downloaded)');
    expect(deps.calls()).toBe(0);
  });

  it('AC-A6: a host dropped from allowedHosts refuses with ZERO outbound calls', async () => {
    installFrom('remote-skill', {
      source: {
        kind: 'git',
        url: 'https://github.com/acme/skills.git',
        ref: 'main',
        subdir: null,
      },
    });

    const deps = spyDeps();
    // The user has since narrowed the allowlist to an internal mirror.
    const service = makeService({ allowedHosts: ['git.internal.example'] });
    service.discover();

    const result = await updateSkill(service, 'remote-skill', {
      cwd: tmp.root,
      installer: 'test',
      fetchDeps: deps,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('host_not_allowed');
    expect(deps.calls()).toBe(0);
  });

  it('--force restores a locally edited file even when upstream has NOT moved', async () => {
    // The trap: `diffFiles(manifest, upstream)` is empty here, because upstream
    // still matches what the manifest recorded. Only the DISK diverged. Taking
    // the "nothing changed" shortcut would make `--force` a silent no-op in the
    // one case someone actually types it — restoring a file they edited.
    const dir = installFrom('pdf-forms', { version: '1.0.0', body: '# pristine' });
    writeUpstream('pdf-forms', { version: '1.0.0', body: '# pristine' });
    appendFileSync(join(dir, 'SKILL.md'), '\nlocal edit to be discarded\n', 'utf-8');

    const service = makeService();
    service.discover();

    const result = await updateSkill(service, 'pdf-forms', {
      cwd: tmp.root,
      installer: 'test',
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.changedFiles).toContain('SKILL.md');
    const restored = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(restored).not.toContain('local edit to be discarded');

    // …and it really is back in sync, not merely rewritten.
    service.discover();
    expect(service.get('pdf-forms')?.integrity).toBe('ok');
  });

  it('--force on a CLEAN copy with unchanged upstream is still a no-op (AC-A4)', async () => {
    const dir = installFrom('pdf-forms', { version: '1.0.0', body: '# same' });
    writeUpstream('pdf-forms', { version: '1.0.0', body: '# same' });

    const service = makeService();
    service.discover();
    const before = statSync(join(dir, 'SKILL.md')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const result = await updateSkill(service, 'pdf-forms', {
      cwd: tmp.root,
      installer: 'test',
      force: true,
    });

    expect(result.changed).toBe(false);
    expect(statSync(join(dir, 'SKILL.md')).mtimeMs).toBe(before);
  });

  it('--force skips the local-modification gate but still honours the allowlist', async () => {
    const dir = installFrom('remote-skill', {
      source: { kind: 'git', url: 'https://github.com/acme/s.git', ref: 'main', subdir: null },
    });
    appendFileSync(join(dir, 'SKILL.md'), '\nedited\n', 'utf-8');

    const deps = spyDeps();
    const service = makeService({ allowedHosts: ['git.internal.example'] });
    service.discover();

    const result = await updateSkill(service, 'remote-skill', {
      cwd: tmp.root,
      installer: 'test',
      force: true,
      fetchDeps: deps,
    });

    expect(result.reason).toBe('host_not_allowed');
    expect(deps.calls()).toBe(0);
  });

  it('a cancelled approval stops before the network too', async () => {
    installFrom('pdf-forms');
    writeUpstream('pdf-forms');

    const deps = spyDeps();
    const service = makeService({ requireApproval: true }, false);
    service.discover();

    const result = await updateSkill(service, 'pdf-forms', {
      cwd: tmp.root,
      installer: 'test',
      fetchDeps: deps,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('cancelled');
    expect(deps.calls()).toBe(0);
  });
});

describe('updateSkill — the in-memory refusals (steps 1-4)', () => {
  it('reports not_found for an unknown name', async () => {
    const service = makeService();
    service.discover();
    const result = await updateSkill(service, 'nope', { cwd: tmp.root, installer: 'test' });
    expect(result.reason).toBe('not_found');
  });

  it('refuses a hand-authored skill rather than deleting unrecorded files', async () => {
    writeSkill(skillsRoot(), 'hand-written');
    const service = makeService();
    service.discover();
    const result = await updateSkill(service, 'hand-written', { cwd: tmp.root, installer: 'test' });
    expect(result.reason).toBe('no_manifest');
  });

  it('refuses a skill_create product — the model is its own upstream', async () => {
    installFrom('invented', {
      source: { kind: 'inline', url: 'skill_create', ref: null, subdir: null },
    });
    const service = makeService();
    service.discover();
    const result = await updateSkill(service, 'invented', { cwd: tmp.root, installer: 'test' });
    expect(result.reason).toBe('no_upstream');
  });
});

describe('AC-A4 — an unchanged upstream touches nothing', () => {
  it('returns changed:false and leaves the directory mtime alone', async () => {
    const dir = installFrom('pdf-forms', { body: '# same\n\nSteps.' });
    // Upstream is byte-identical to what is installed.
    writeUpstream('pdf-forms', { version: '1.0.0', body: '# same\n\nSteps.' });

    const service = makeService();
    service.discover();

    const before = statSync(join(dir, 'SKILL.md')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));

    const result = await updateSkill(service, 'pdf-forms', { cwd: tmp.root, installer: 'test' });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    // Rewriting an identical directory would bump every mtime and make the next
    // scan look like a change that never happened.
    expect(statSync(join(dir, 'SKILL.md')).mtimeMs).toBe(before);
  });
});

describe('AC-A7 — a successful update rewrites the right manifest fields', () => {
  it('keeps installedAt, writes updatedAt and previousVersion', async () => {
    installFrom('pdf-forms', { version: '1.0.0', body: '# v1' });
    writeUpstream('pdf-forms', { version: '2.1.0', body: '# v2' });

    const service = makeService();
    service.discover();
    const before = readManifestOf('pdf-forms');

    const result = await updateSkill(service, 'pdf-forms', { cwd: tmp.root, installer: '9.9.9' });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.fromVersion).toBe('1.0.0');
    expect(result.toVersion).toBe('2.1.0');

    const after = readManifestOf('pdf-forms');
    // "When did I install this" and "when did it last change" are two different
    // questions; collapsing them loses the one asked during an incident.
    expect(after.installedAt).toBe(before.installedAt);
    expect(after.installedAt).toBe(1_700_000_000_000);
    expect(after.updatedAt).toBeTypeOf('number');
    expect(after.previousVersion).toBe('1.0.0');
    expect(after.version).toBe('2.1.0');
    expect(after.installer).toBe('9.9.9');

    // The content really landed, and the registry reflects it immediately.
    expect(readFileSync(join(skillsRoot(), 'pdf-forms', 'SKILL.md'), 'utf-8')).toContain('# v2');
    expect(service.get('pdf-forms')?.frontmatter.version).toBe('2.1.0');
  });

  it('a fresh install manifest carries NO updatedAt (fields stay additive)', () => {
    installFrom('pristine');
    const manifest = readManifestOf('pristine');
    expect(manifest.updatedAt).toBeUndefined();
    expect(manifest.previousVersion).toBeUndefined();
    expect(manifest.schema).toBe(1);
  });
});

describe('updateSkill — --dry-run', () => {
  it('lists what would change and writes nothing', async () => {
    const dir = installFrom('pdf-forms', { version: '1.0.0', body: '# v1' });
    writeUpstream('pdf-forms', { version: '2.0.0', body: '# v2' });

    const service = makeService();
    service.discover();
    const before = readFileSync(join(dir, 'SKILL.md'), 'utf-8');

    const result = await updateSkill(service, 'pdf-forms', {
      cwd: tmp.root,
      installer: 'test',
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.changedFiles).toContain('SKILL.md');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(before);
    expect(readManifestOf('pdf-forms').version).toBe('1.0.0');
  });

  it('reports a removed bundled file as changed', async () => {
    installFrom('bundle', { files: { 'scripts/fill.py': 'print(1)\n' } });
    writeUpstream('bundle', { version: '2.0.0' });

    const service = makeService();
    service.discover();
    const result = await updateSkill(service, 'bundle', {
      cwd: tmp.root,
      installer: 'test',
      dryRun: true,
    });
    expect(result.changedFiles).toContain('scripts/fill.py');
  });
});

describe('updateAllSkills', () => {
  it('never lets one failure stop the rest, and skips non-candidates', async () => {
    installFrom('good', { version: '1.0.0' });
    installFrom('bad-host', {
      source: { kind: 'git', url: 'https://github.com/x/y.git', ref: 'main', subdir: null },
    });
    installFrom('invented', {
      source: { kind: 'inline', url: 'skill_create', ref: null, subdir: null },
    });
    writeSkill(skillsRoot(), 'hand-written');
    writeUpstream('good', { version: '3.0.0' });

    const service = makeService({ allowedHosts: ['git.internal.example'] });
    service.discover();

    const results = await updateAllSkills(service, { cwd: tmp.root, installer: 'test' });
    const byName = new Map(results.map((r) => [r.name, r]));

    // `inline` and manifest-less skills are not candidates at all — they are
    // not failures, so they never enter the result table.
    expect([...byName.keys()].sort()).toEqual(['bad-host', 'good']);
    expect(byName.get('good')?.ok).toBe(true);
    expect(byName.get('good')?.changed).toBe(true);
    expect(byName.get('bad-host')?.reason).toBe('host_not_allowed');
  });
});

describe('specFromManifestSource (D-A7)', () => {
  const HOSTS = ['github.com'];

  it('re-applies the CURRENT allowlist, not the one from install time', () => {
    const src: SkillManifestSource = {
      kind: 'git',
      url: 'https://github.com/a/b.git',
      ref: 'main',
      subdir: null,
    };
    expect(specFromManifestSource(src, HOSTS).ok).toBe(true);
    const narrowed = specFromManifestSource(src, ['internal.example']);
    expect(narrowed.ok).toBe(false);
    if (!narrowed.ok) expect(narrowed.reason).toBe('host_not_allowed');
  });

  it('reports a vanished local source rather than pretending it is fine', () => {
    const result = specFromManifestSource(
      { kind: 'local-dir', url: join(tmp.root, 'gone'), ref: null, subdir: null },
      HOSTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('source_unavailable');
  });

  it('refuses an inline source', () => {
    const result = specFromManifestSource(
      { kind: 'inline', url: 'skill_create', ref: null, subdir: null },
      HOSTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_upstream');
  });

  it('carries ref and subdir through for a git source', () => {
    const result = specFromManifestSource(
      { kind: 'git', url: 'https://github.com/a/b.git', ref: 'v2', subdir: 'pkg/skill' },
      HOSTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.spec.kind === 'git') {
      expect(result.spec.ref).toBe('v2');
      expect(result.spec.subdir).toBe('pkg/skill');
    }
  });
});

describe('updateSkill — validation still uses the install path', () => {
  it('a broken upstream is rejected and the installed copy survives', async () => {
    const dir = installFrom('pdf-forms', { version: '1.0.0' });
    // Upstream is a SKILL.md with no frontmatter at all.
    mkdirSync(upstream(), { recursive: true });
    writeFileSync(join(upstream(), 'SKILL.md'), '# no frontmatter here\n', 'utf-8');

    const service = makeService();
    service.discover();
    const result = await updateSkill(service, 'pdf-forms', { cwd: tmp.root, installer: 'test' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('validation_failed');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('name: pdf-forms');
    expect(readManifestOf('pdf-forms').version).toBe('1.0.0');
  });
});
