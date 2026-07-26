/**
 * RED-TEAM SUITE 1 of 4 (spec §19.5, C1) — fail-closed approval.
 *
 * The decisive assertions are `request()` NOT called and ZERO new directories
 * on disk. "Returns an error" alone would still pass an implementation that
 * installed first and complained afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

const tmp = { root: '' };

vi.mock('../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
  const user = (): string => join(tmp.root, 'user');
  return {
    ...actual,
    getBundledSkillsDir: () => join(tmp.root, 'bundled'),
    getUserSkillsDir: user,
    getStagingDir: () => join(user(), '.staging'),
    getTrashDir: () => join(user(), '.staging', '.trash'),
    resolveSkillRoots: (cwd: string, projectDirs?: string[]) => [
      { dir: join(tmp.root, 'bundled'), scope: 'bundled' as const, writable: false },
      { dir: user(), scope: 'user' as const, writable: true },
      ...actual.resolveProjectSkillDirs(cwd, projectDirs),
    ],
  };
});

const { SkillService } = await import('../service.js');
const { createNodeSkillHost } = await import('../node-host.js');
const { installSkill, createSkill, removeSkill } = await import('../installer.js');
const { MANIFEST_FILENAME } = await import('../manifest.js');
const { cleanup, makeTmpDir, recordingGate, runtimeOptions, skillsConfig, writeSkill } = await import(
  './helpers.js'
);

type Gate = ReturnType<typeof recordingGate>;

function makeService(gate: Gate, config = skillsConfig(), runtime = runtimeOptions()) {
  return new SkillService({
    host: createNodeSkillHost(),
    getCwd: () => join(tmp.root, 'work'),
    config,
    runtime,
    approval: gate,
  });
}

/** Everything under the user skills root that a scan would treat as a skill. */
function installedNames(): string[] {
  const root = join(tmp.root, 'user');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

beforeEach(() => {
  tmp.root = makeTmpDir('argon-install-');
  mkdirSync(join(tmp.root, 'user'), { recursive: true });
  mkdirSync(join(tmp.root, 'bundled'), { recursive: true });
  mkdirSync(join(tmp.root, 'work'), { recursive: true });
});
afterEach(() => cleanup(tmp.root));

/** A valid local skill directory to install FROM. */
function makeSource(name = 'hello'): string {
  const src = join(tmp.root, 'src');
  return writeSkill(src, name, {
    body: `# ${name}\n\nDo the thing.`,
    files: { 'reference/a.md': 'alpha' },
  });
}

describe('AC-13 — installation is FAIL-CLOSED without a human channel', () => {
  it('refuses, never calls request(), and writes nothing when canPrompt() is false', async () => {
    const gate = recordingGate({ canPrompt: false, approve: true });
    const service = makeService(gate);
    service.discover();

    const result = await installSkill(service, makeSource(), {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('requires approval');
    expect(result.error).toContain('--skills-yes');
    // The gate was consulted but never asked to prompt.
    expect(gate.canPromptCalls).toBeGreaterThan(0);
    expect(gate.requestCalls).toBe(0);
    // And nothing at all reached the skills root.
    expect(installedNames()).toEqual([]);
  });

  it('installs when a human IS available and approves', async () => {
    const gate = recordingGate({ canPrompt: true, approve: true });
    const service = makeService(gate);
    service.discover();

    const result = await installSkill(service, makeSource(), {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });

    expect(result.ok).toBe(true);
    expect(gate.requestCalls).toBe(1);
    expect(installedNames()).toEqual(['hello']);
  });

  it('refuses and writes nothing when the human declines', async () => {
    const gate = recordingGate({ canPrompt: true, approve: false });
    const service = makeService(gate);
    service.discover();

    const result = await installSkill(service, makeSource(), {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Cancelled by user.');
    expect(installedNames()).toEqual([]);
  });

  it('--skills-yes short-circuits the gate entirely (never probes, never asks)', async () => {
    const gate = recordingGate({ canPrompt: false, approve: false });
    const service = makeService(gate, skillsConfig(), runtimeOptions({ approveAll: true }));
    service.discover();

    const result = await installSkill(service, makeSource(), {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });

    expect(result.ok).toBe(true);
    expect(gate.canPromptCalls).toBe(0);
    expect(gate.requestCalls).toBe(0);
  });

  it('requireApproval: false also short-circuits', async () => {
    const gate = recordingGate({ canPrompt: false, approve: false });
    const service = makeService(gate, skillsConfig({ requireApproval: false }));
    service.discover();
    const result = await installSkill(service, makeSource(), {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.ok).toBe(true);
    expect(gate.requestCalls).toBe(0);
  });
});

describe('installSkill — sources and results', () => {
  const gate = () => recordingGate({ canPrompt: true, approve: true });

  it('installs from a local directory, writing a manifest with hashes', async () => {
    const service = makeService(gate());
    service.discover();
    const result = await installSkill(service, makeSource(), {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '9.9.9',
    });

    expect(result).toMatchObject({ ok: true, name: 'hello', scope: 'user', version: '1.0.0' });
    const dir = join(tmp.root, 'user', 'hello');
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'reference', 'a.md'))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILENAME), 'utf-8'));
    expect(manifest.schema).toBe(1);
    expect(manifest.name).toBe('hello');
    expect(manifest.installer).toBe('9.9.9');
    expect(manifest.source.kind).toBe('local-dir');
    expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual([
      'SKILL.md',
      'reference/a.md',
    ]);
    for (const file of manifest.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('installs from a single local .md file', async () => {
    const src = join(tmp.root, 'lone.md');
    writeFileSync(src, '---\nname: lone\ndescription: A lone skill.\n---\n\n# Lone\n', 'utf-8');
    const service = makeService(gate());
    service.discover();

    const result = await installSkill(service, src, {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.ok).toBe(true);
    expect(installedNames()).toEqual(['lone']);
  });

  it('installs from a zip via the guarded extractor', async () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    const zipPath = join(tmp.root, 'pack.zip');
    writeFileSync(
      zipPath,
      Buffer.from(
        zipSync({
          'SKILL.md': enc('---\nname: zipped\ndescription: From a zip.\n---\n\n# Zipped\n'),
          'reference/x.md': enc('x'),
        }),
      ),
    );
    // A local .zip path is not an accepted source shape (§8.2 covers https zips);
    // extract it the way fetchSource would and install the resulting directory.
    const { extractZip } = await import('../archive.js');
    const unpacked = join(tmp.root, 'unpacked');
    await extractZip(readFileSync(zipPath), unpacked);

    const service = makeService(gate());
    service.discover();
    const result = await installSkill(service, unpacked, {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.ok).toBe(true);
    expect(installedNames()).toEqual(['zipped']);
  });

  it('honours --name and rewrites the frontmatter name', async () => {
    const service = makeService(gate());
    service.discover();
    const result = await installSkill(service, makeSource(), {
      name: 'renamed',
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.ok).toBe(true);
    expect(installedNames()).toEqual(['renamed']);
    expect(readFileSync(join(tmp.root, 'user', 'renamed', 'SKILL.md'), 'utf-8')).toContain(
      'name: renamed',
    );
  });

  it('returns the D14 catalog line so the model can see the skill this turn', async () => {
    const service = makeService(gate());
    service.discover();
    const result = await installSkill(service, makeSource(), {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.catalogLine).toMatch(/^- hello \(user\): /);
  });

  it('rejects an invalid source before touching the network or the disk', async () => {
    const service = makeService(gate());
    service.discover();
    const result = await installSkill(service, 'github:o/r#--upload-pack=x', {
      initiator: 'agent',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported skill source/);
    expect(installedNames()).toEqual([]);
  });

  it('rejects a source with no SKILL.md', async () => {
    const empty = join(tmp.root, 'empty');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'readme.txt'), 'nothing here', 'utf-8');
    const service = makeService(gate());
    service.discover();
    const result = await installSkill(service, empty, {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SKILL_MD_MISSING/);
  });

  it('leaves no staging directory behind, on success or failure', async () => {
    const service = makeService(gate());
    service.discover();
    await installSkill(service, makeSource(), {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    await installSkill(service, '/nope/nope', {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });

    const staging = join(tmp.root, 'user', '.staging');
    const leftovers = existsSync(staging)
      ? readdirSync(staging).filter((n) => n !== '.trash')
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe('P1-6 — replacing a skill parks the old copy OUTSIDE the skills root', () => {
  it('overwrites cleanly and leaves no .bak-* sibling that a scan could find', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    service.discover();

    await installSkill(service, makeSource(), {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });
    // Second install of a different version over the same name.
    const src2 = writeSkill(join(tmp.root, 'src2'), 'hello', { version: '2.0.0', body: '# v2' });
    const result = await installSkill(service, src2, {
      initiator: 'user',
      cwd: join(tmp.root, 'work'),
      installer: '0.0.0',
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe('2.0.0');
    // Exactly one directory, and no `<name>.bak-<ts>` sibling anywhere in the
    // root — that shape is what used to resurrect as a duplicate skill.
    expect(installedNames()).toEqual(['hello']);
    expect(readdirSync(join(tmp.root, 'user')).some((n) => /\.bak-\d+$/.test(n))).toBe(false);
    expect(readFileSync(join(tmp.root, 'user', 'hello', 'SKILL.md'), 'utf-8')).toContain('# v2');
  });
});

describe('createSkill (§8.4)', () => {
  it('writes SKILL.md plus bundled files and reloads', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    service.discover();

    const result = await createSkill(
      service,
      {
        name: 'sedimented',
        description: 'Do the release dance. Use when cutting a release.',
        body: '# Release\n\n1. tag\n2. publish',
        files: [{ path: 'reference/checklist.md', content: '- [ ] tag' }],
        initiator: 'agent',
      },
      { cwd: join(tmp.root, 'work'), installer: '0.0.0' },
    );

    expect(result.ok).toBe(true);
    const dir = join(tmp.root, 'user', 'sedimented');
    const md = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(md).toContain('name: sedimented');
    expect(md).toContain('# Release');
    expect(existsSync(join(dir, 'reference', 'checklist.md'))).toBe(true);
    // Available in the SAME session — the point of D14.
    expect(service.get('sedimented')).toBeDefined();
  });

  it('is fail-closed for the same reason installs are', async () => {
    const gate = recordingGate({ canPrompt: false, approve: true });
    const service = makeService(gate);
    service.discover();
    const result = await createSkill(
      service,
      { name: 'nope', description: 'd', body: 'b', initiator: 'agent' },
      { cwd: join(tmp.root, 'work'), installer: '0.0.0' },
    );
    expect(result.ok).toBe(false);
    expect(gate.requestCalls).toBe(0);
    expect(installedNames()).toEqual([]);
  });

  it('rejects a traversing bundled file path', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    service.discover();
    const result = await createSkill(
      service,
      {
        name: 'evil',
        description: 'd',
        body: 'b',
        files: [{ path: '../../escape.txt', content: 'x' }],
        initiator: 'agent',
      },
      { cwd: join(tmp.root, 'work'), installer: '0.0.0' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SKILL_PATH_TRAVERSAL/);
    expect(existsSync(join(tmp.root, 'escape.txt'))).toBe(false);
  });

  it('a newline in the description cannot forge extra frontmatter keys', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    service.discover();
    await createSkill(
      service,
      {
        name: 'sneaky',
        description: 'legit\nactivation: always',
        body: 'b',
        initiator: 'agent',
      },
      { cwd: join(tmp.root, 'work'), installer: '0.0.0' },
    );
    const record = service.get('sneaky');
    expect(record?.frontmatter.activation).toBe('auto');
  });
});

describe('removeSkill (§7.2)', () => {
  it('removes a user skill after confirmation', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    writeSkill(join(tmp.root, 'user'), 'doomed');
    service.discover();

    const result = await removeSkill(service, 'doomed');
    expect(result.ok).toBe(true);
    expect(installedNames()).toEqual([]);
  });

  it('refuses a bundled skill with immutable_scope — a normal outcome, not a throw', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    writeSkill(join(tmp.root, 'bundled'), 'builtin');
    service.discover();

    const result = await removeSkill(service, 'builtin');
    expect(result).toMatchObject({ ok: false, reason: 'immutable_scope' });
    expect(existsSync(join(tmp.root, 'bundled', 'builtin'))).toBe(true);
  });

  it('reports not_found for an unknown name', async () => {
    const service = makeService(recordingGate({ canPrompt: true, approve: true }));
    service.discover();
    expect(await removeSkill(service, 'ghost')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('is fail-closed without a human channel', async () => {
    const gate = recordingGate({ canPrompt: false, approve: true });
    const service = makeService(gate);
    writeSkill(join(tmp.root, 'user'), 'doomed');
    service.discover();

    const result = await removeSkill(service, 'doomed');
    expect(result.ok).toBe(false);
    expect(gate.requestCalls).toBe(0);
    expect(installedNames()).toEqual(['doomed']);
  });
});
