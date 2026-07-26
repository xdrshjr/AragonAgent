import { afterEach, describe, expect, it } from 'vitest';
import { delimiter, isAbsolute, sep } from 'node:path';
import process from 'node:process';
import {
  getBundledSkillsDir,
  getStagingDir,
  getTrashDir,
  getUserSkillsDir,
  isDirectory,
  normalizeTrustPath,
  resolveEnvSkillDirs,
  resolveProjectSkillDirs,
  resolveSkillRoots,
} from '../paths.js';

const ORIGINAL_ENV = process.env.ARGON_SKILLS_PATH;
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ARGON_SKILLS_PATH;
  else process.env.ARGON_SKILLS_PATH = ORIGINAL_ENV;
});

describe('skill root resolution (§6.1)', () => {
  it('returns the four scopes in ascending precedence', () => {
    const roots = resolveSkillRoots('/work');
    expect(roots.map((r) => r.scope)).toEqual(['bundled', 'user', 'project', 'project']);
    // A later root must win, so bundled has to come first.
    expect(roots[0]!.scope).toBe('bundled');
  });

  it('marks .argon/skills writable and .claude/skills read-only (D8)', () => {
    const project = resolveProjectSkillDirs('/work');
    expect(project).toHaveLength(2);
    expect(project[0]!.dir.endsWith(`.argon${sep}skills`)).toBe(true);
    expect(project[0]!.writable).toBe(true);
    expect(project[1]!.dir.endsWith(`.claude${sep}skills`)).toBe(true);
    expect(project[1]!.writable).toBe(false);
  });

  it('bundled and env roots are never writable', () => {
    process.env.ARGON_SKILLS_PATH = '/a';
    const roots = resolveSkillRoots('/work');
    expect(roots.find((r) => r.scope === 'bundled')!.writable).toBe(false);
    expect(roots.find((r) => r.scope === 'env')!.writable).toBe(false);
  });

  it('splits ARGON_SKILLS_PATH on the platform delimiter and resolves each entry', () => {
    const dirs = resolveEnvSkillDirs(['/a', '/b'].join(delimiter));
    expect(dirs).toHaveLength(2);
    expect(dirs.every((d) => d.scope === 'env')).toBe(true);
    expect(dirs.every((d) => isAbsolute(d.dir))).toBe(true);
  });

  it('treats an empty or whitespace ARGON_SKILLS_PATH as unset', () => {
    expect(resolveEnvSkillDirs(undefined)).toEqual([]);
    expect(resolveEnvSkillDirs('   ')).toEqual([]);
    expect(resolveEnvSkillDirs(`${delimiter}${delimiter}`)).toEqual([]);
  });

  it('puts staging and its trash under the user root, both dot-prefixed', () => {
    // Dot-prefixed matters: the scanner skips `.`-directories, which is the
    // structural reason a crashed install cannot leave a phantom skill (P1-6).
    expect(getStagingDir().startsWith(getUserSkillsDir())).toBe(true);
    expect(getStagingDir()).toContain('.staging');
    expect(getTrashDir()).toContain('.trash');
  });

  it('resolves the bundled DATA dir to <pkg>/skills, not <pkg>/dist/skills', () => {
    const dir = getBundledSkillsDir().replace(/\\/g, '/');
    expect(dir.endsWith('/skills')).toBe(true);
    // The same `'..','..'` hop from src/skills/paths.ts and dist/skills/paths.js
    // must land on the package root either way (P2-5).
    expect(dir.endsWith('/dist/skills')).toBe(false);
  });
});

describe('normalizeTrustPath (P2-7)', () => {
  it('returns null for a path that cannot be resolved', () => {
    expect(normalizeTrustPath('/definitely/not/here/at/all')).toBeNull();
  });

  it('is stable across a trailing separator and (on Windows) case', () => {
    const base = process.cwd();
    const a = normalizeTrustPath(base);
    const b = normalizeTrustPath(`${base}${sep}`);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    if (process.platform === 'win32') {
      expect(normalizeTrustPath(base.toUpperCase())).toBe(a);
      expect(a).toBe(a!.toLowerCase());
    }
  });
});

describe('isDirectory', () => {
  it('never throws and answers correctly', () => {
    expect(isDirectory(process.cwd())).toBe(true);
    expect(isDirectory('/nope/nope/nope')).toBe(false);
  });
});
