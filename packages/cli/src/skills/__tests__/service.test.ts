import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tmp = { root: '' };

// `paths.ts` snapshots `envPaths()` at import time, so the roots are mocked
// rather than steered with an env var.
//
// `resolveSkillRoots` MUST be overridden too, not inherited from `...actual`:
// it calls `getBundledSkillsDir()` / `getUserSkillsDir()` as module-internal
// references, which never go through the mock. Spreading the real one produces
// a service that quietly scans the developer's actual skills directory.
vi.mock('../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
  const bundled = (): string => join(tmp.root, 'bundled');
  const user = (): string => join(tmp.root, 'user');
  return {
    ...actual,
    getBundledSkillsDir: bundled,
    getUserSkillsDir: user,
    getStagingDir: () => join(tmp.root, 'user', '.staging'),
    getTrashDir: () => join(tmp.root, 'user', '.staging', '.trash'),
    resolveSkillRoots: (cwd: string, projectDirs?: string[]) => [
      { dir: bundled(), scope: 'bundled' as const, writable: false },
      { dir: user(), scope: 'user' as const, writable: true },
      ...actual.resolveProjectSkillDirs(cwd, projectDirs),
      ...actual.resolveEnvSkillDirs(),
    ],
  };
});

const { SkillService } = await import('../service.js');
const { createNodeSkillHost } = await import('../node-host.js');
const { cleanup, makeTmpDir, recordingGate, runtimeOptions, skillsConfig, writeSkill } = await import(
  './helpers.js'
);

function makeService(cwd: string, config = skillsConfig(), runtime = runtimeOptions()) {
  return new SkillService({
    host: createNodeSkillHost(),
    getCwd: () => cwd,
    config,
    runtime,
    approval: recordingGate({ canPrompt: false, approve: false }),
  });
}

beforeEach(() => {
  tmp.root = makeTmpDir();
  mkdirSync(join(tmp.root, 'user'), { recursive: true });
  mkdirSync(join(tmp.root, 'bundled'), { recursive: true });
});
afterEach(() => cleanup(tmp.root));

describe('SkillService.discover (§6.2)', () => {
  it('finds skills across roots and applies precedence, recording the shadow', () => {
    const cwd = join(tmp.root, 'work');
    writeSkill(join(tmp.root, 'bundled'), 'shared', { description: 'bundled copy' });
    writeSkill(join(tmp.root, 'user'), 'shared', { description: 'user copy' });
    writeSkill(join(cwd, '.argon', 'skills'), 'shared', { description: 'project copy' });
    writeSkill(join(tmp.root, 'user'), 'solo');

    const service = makeService(cwd, skillsConfig({ trustedProjectDirs: [join(cwd, '.argon', 'skills')] }));
    service.discover();

    const shared = service.get('shared')!;
    expect(shared.scope).toBe('project');
    expect(shared.description).toBe('project copy');
    expect(shared.shadowed.map((s) => s.scope)).toEqual(['user', 'bundled']);
    expect(service.get('solo')?.scope).toBe('user');
  });

  it('reads .claude/skills for interop and marks it read-only (D8)', () => {
    const cwd = join(tmp.root, 'work');
    writeSkill(join(cwd, '.claude', 'skills'), 'community');
    const service = makeService(
      cwd,
      skillsConfig({ trustedProjectDirs: [join(cwd, '.claude', 'skills')] }),
    );
    service.discover();
    const record = service.get('community')!;
    expect(record.scope).toBe('project');
    expect(record.writable).toBe(false);
  });

  it('holds untrusted project roots back instead of loading them (D13)', () => {
    const cwd = join(tmp.root, 'work');
    writeSkill(join(cwd, '.argon', 'skills'), 'sneaky');
    const service = makeService(cwd);
    const result = service.discover();
    expect(service.get('sneaky')).toBeUndefined();
    expect(result.pendingTrust).toHaveLength(1);
    expect(result.pendingTrust[0]).toContain('.argon');
  });

  it('loads a project root once it is trusted', () => {
    const cwd = join(tmp.root, 'work');
    writeSkill(join(cwd, '.argon', 'skills'), 'blessed');
    const service = makeService(cwd);
    service.discover();
    expect(service.get('blessed')).toBeUndefined();
    service.trustDir(join(cwd, '.argon', 'skills'));
    service.discover();
    expect(service.get('blessed')).toBeDefined();
  });

  it('a malformed SKILL.md becomes an INVALID record, not a missing one', () => {
    writeSkill(join(tmp.root, 'user'), 'broken', { broken: true });
    writeSkill(join(tmp.root, 'user'), 'fine');
    const service = makeService(tmp.root);
    service.discover();

    const broken = service.get('broken')!;
    expect(broken.invalid).toBe(true);
    // Still listed — "installed but broken" must be visible, not silent.
    expect(service.list().map((r) => r.name)).toContain('broken');
    expect(service.catalogBlock()).not.toContain('broken');
    expect(service.catalogBlock()).toContain('fine');
  });

  it('one bad directory does not sink the whole pass', () => {
    writeSkill(join(tmp.root, 'user'), 'good');
    // A directory whose SKILL.md is actually a directory: readFileSync throws EISDIR.
    mkdirSync(join(tmp.root, 'user', 'weird', 'SKILL.md'), { recursive: true });
    const service = makeService(tmp.root);
    const result = service.discover();
    expect(service.get('good')).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('skips dot-directories and legacy .bak-<ts> leftovers (P1-6)', () => {
    writeSkill(join(tmp.root, 'user'), 'pdf-forms');
    // Exactly the shape a v1 crash-mid-commit used to leave behind: same
    // frontmatter name, same root. Two records with one name would make the
    // winner depend on readdir order.
    writeSkill(join(tmp.root, 'user'), 'pdf-forms.bak-1700000000', { name: 'pdf-forms' });
    writeSkill(join(tmp.root, 'user'), '.hidden');

    const service = makeService(tmp.root);
    service.discover();
    expect(service.list().map((r) => r.name)).toEqual(['pdf-forms']);
    expect(service.get('pdf-forms')!.dir.endsWith('pdf-forms')).toBe(true);
  });

  it('resolves a same-name collision inside ONE root by lexical directory order', () => {
    writeSkill(join(tmp.root, 'user'), 'zzz-dir', { name: 'dupe', description: 'second' });
    writeSkill(join(tmp.root, 'user'), 'aaa-dir', { name: 'dupe', description: 'first' });

    const first = makeService(tmp.root);
    const firstResult = first.discover();
    const second = makeService(tmp.root);
    second.discover();

    expect(first.get('dupe')!.description).toBe('first');
    // Deterministic across runs — never a readdir coin flip (§5.1).
    expect(second.get('dupe')!.description).toBe('first');
    expect(firstResult.errors.join(' ')).toMatch(/duplicate skill name "dupe"/);
  });

  it('a cwd change swaps the project root', () => {
    const cwdA = join(tmp.root, 'a');
    const cwdB = join(tmp.root, 'b');
    writeSkill(join(cwdA, '.argon', 'skills'), 'only-a');
    writeSkill(join(cwdB, '.argon', 'skills'), 'only-b');

    let cwd = cwdA;
    const service = new SkillService({
      host: createNodeSkillHost(),
      getCwd: () => cwd,
      config: skillsConfig({
        trustedProjectDirs: [join(cwdA, '.argon', 'skills'), join(cwdB, '.argon', 'skills')],
      }),
      runtime: runtimeOptions(),
      approval: recordingGate({ canPrompt: false, approve: false }),
    });
    service.discover();
    expect(service.get('only-a')).toBeDefined();
    expect(service.get('only-b')).toBeUndefined();

    cwd = cwdB;
    service.discover();
    expect(service.get('only-a')).toBeUndefined();
    expect(service.get('only-b')).toBeDefined();
  });
});

describe('SkillService prompt blocks', () => {
  it('catalogBlock is empty with no skills and populated with them', () => {
    const empty = makeService(tmp.root);
    empty.discover();
    expect(empty.catalogBlock()).toBe('');

    writeSkill(join(tmp.root, 'user'), 'alpha');
    const service = makeService(tmp.root);
    service.discover();
    expect(service.catalogBlock()).toContain('<available_skills>');
    expect(service.catalogBlock()).toContain('- alpha (user):');
  });

  it('catalogBlock and alwaysBlock are both empty when skills are disabled', () => {
    writeSkill(join(tmp.root, 'user'), 'alpha', { activation: 'always' });
    const service = makeService(tmp.root, skillsConfig({ enabled: false }));
    service.discover();
    expect(service.catalogBlock()).toBe('');
    expect(service.alwaysBlock()).toBe('');
  });

  it('alwaysBlock injects activation: always bodies', () => {
    writeSkill(join(tmp.root, 'user'), 'rules', { activation: 'always', body: '# House rules' });
    writeSkill(join(tmp.root, 'user'), 'plain');
    const service = makeService(tmp.root);
    service.discover();
    const block = service.alwaysBlock();
    expect(block).toContain('# House rules');
    expect(block).not.toContain('<skill name="plain"');
  });

  it('--skill forces a Level 2 injection for an ordinary skill', () => {
    writeSkill(join(tmp.root, 'user'), 'plain', { body: '# Forced in' });
    const service = makeService(tmp.root, skillsConfig(), runtimeOptions({ forcedSkills: ['plain'] }));
    service.discover();
    expect(service.alwaysBlock()).toContain('# Forced in');
  });

  it('warns about an unknown --skill name without failing', () => {
    const notices: string[] = [];
    const service = new SkillService({
      host: createNodeSkillHost(),
      getCwd: () => tmp.root,
      config: skillsConfig(),
      runtime: runtimeOptions({ forcedSkills: ['nope'] }),
      approval: recordingGate({ canPrompt: false, approve: false }),
      notify: (_l, text) => notices.push(text),
    });
    service.discover();
    service.reportUnknownForcedSkills();
    expect(notices.join(' ')).toContain('--skill "nope" does not match');
  });

  it('activation: manual stays out of the catalog but remains loadable', () => {
    writeSkill(join(tmp.root, 'user'), 'hidden', { activation: 'manual' });
    const service = makeService(tmp.root);
    service.discover();
    expect(service.catalogBlock()).toBe('');
    expect(service.get('hidden')).toBeDefined();
  });
});

describe('SkillService.loadBody (Level 2)', () => {
  it('returns the body without frontmatter and lists bundled files', () => {
    writeSkill(join(tmp.root, 'user'), 'pdf', {
      body: '# PDF\n\nDo it.',
      files: { 'reference/a.md': 'hello', 'scripts/run.py': 'print(1)' },
    });
    const service = makeService(tmp.root);
    service.discover();

    const loaded = service.loadBody('pdf');
    expect(loaded.body.startsWith('# PDF')).toBe(true);
    expect(loaded.body).not.toContain('name: pdf');
    expect(loaded.files.map((f) => f.path).sort()).toEqual(['reference/a.md', 'scripts/run.py']);
    expect(loaded.files.every((f) => f.bytes > 0)).toBe(true);
  });

  it('throws for an unknown skill — the tool layer converts that to errorResult', () => {
    const service = makeService(tmp.root);
    service.discover();
    expect(() => service.loadBody('nope')).toThrow(/unknown skill/);
  });

  it('excludes SKILL.md itself and dotfiles from the bundled list', () => {
    const dir = writeSkill(join(tmp.root, 'user'), 'x', { files: { 'reference/a.md': 'a' } });
    writeFileSync(join(dir, '.argon-skill.json'), '{}', 'utf-8');
    const service = makeService(tmp.root);
    service.discover();
    expect(service.loadBody('x').files.map((f) => f.path)).toEqual(['reference/a.md']);
  });
});

describe('SkillService disable / trust round-trips', () => {
  it('setDisabled persists through the patch callback and leaves the catalog', () => {
    writeSkill(join(tmp.root, 'user'), 'alpha');
    const patches: unknown[] = [];
    const service = new SkillService({
      host: createNodeSkillHost(),
      getCwd: () => tmp.root,
      config: skillsConfig(),
      runtime: runtimeOptions(),
      approval: recordingGate({ canPrompt: false, approve: false }),
      persist: (patch) => patches.push(patch),
    });
    service.discover();
    service.setDisabled('alpha', true);

    expect(service.get('alpha')!.disabled).toBe(true);
    expect(service.catalogBlock()).toBe('');
    expect(patches).toEqual([{ disabled: ['alpha'] }]);
  });

  it('a disabled name in the config survives a rescan', () => {
    writeSkill(join(tmp.root, 'user'), 'alpha');
    const service = makeService(tmp.root, skillsConfig({ disabled: ['alpha'] }));
    service.discover();
    expect(service.get('alpha')!.disabled).toBe(true);
  });

  it('trustDir normalizes before persisting, and untrustDir reverses it', () => {
    const patches: Array<Record<string, unknown>> = [];
    const dir = join(tmp.root, 'user');
    const service = new SkillService({
      host: createNodeSkillHost(),
      getCwd: () => tmp.root,
      config: skillsConfig(),
      runtime: runtimeOptions(),
      approval: recordingGate({ canPrompt: false, approve: false }),
      persist: (patch) => patches.push(patch as Record<string, unknown>),
    });

    expect(service.trustDir(`${dir}/`)).toBe(true);
    expect(service.isTrusted(dir)).toBe(true);
    // A trailing separator (and case on Windows) must not create a second entry.
    expect(service.trustDir(dir)).toBe(true);
    expect((patches[0]!.trustedProjectDirs as string[]).length).toBe(1);

    expect(service.untrustDir(dir)).toBe(true);
    expect(service.isTrusted(dir)).toBe(false);
  });

  it('trustDir refuses a path that does not exist', () => {
    const service = makeService(tmp.root);
    expect(service.trustDir(join(tmp.root, 'ghost'))).toBe(false);
  });
});

describe('SkillService housekeeping', () => {
  it('reclaims staging directories older than the TTL and keeps fresh ones', () => {
    const staging = join(tmp.root, 'user', '.staging');
    mkdirSync(join(staging, 'stale'), { recursive: true });
    mkdirSync(join(staging, 'fresh'), { recursive: true });
    const old = Date.now() - 48 * 60 * 60 * 1000;
    utimesSync(join(staging, 'stale'), new Date(old), new Date(old));

    makeService(tmp.root).discover();
    expect(existsSync(join(staging, 'stale'))).toBe(false);
    expect(existsSync(join(staging, 'fresh'))).toBe(true);
  });
});
