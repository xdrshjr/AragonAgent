import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../frontmatter.js';
import {
  checkStagedPath,
  normalizeFrontmatter,
  validateSkillFrontmatter,
  validateStagedSkill,
} from '../validate.js';
import { SKILL_DESC_MAX, STAGED_MAX_FILES } from '../constants.js';
import type { StagedFile } from '../types.js';

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

describe('validateSkillFrontmatter (§4.4 error-code matrix)', () => {
  it('SKILL_NAME_MISSING when name is absent', () => {
    expect(codes(validateSkillFrontmatter({ description: 'd' }, 'x'))).toContain('SKILL_NAME_MISSING');
  });

  it('SKILL_NAME_INVALID for non-kebab-case and for over-long names', () => {
    expect(codes(validateSkillFrontmatter({ name: 'Pdf_Forms', description: 'd' }, 'x'))).toContain(
      'SKILL_NAME_INVALID',
    );
    expect(codes(validateSkillFrontmatter({ name: '-lead', description: 'd' }, 'x'))).toContain(
      'SKILL_NAME_INVALID',
    );
    expect(codes(validateSkillFrontmatter({ name: 'a--b', description: 'd' }, 'x'))).toContain(
      'SKILL_NAME_INVALID',
    );
    const long = 'a'.repeat(65);
    expect(codes(validateSkillFrontmatter({ name: long, description: 'd' }, long))).toContain(
      'SKILL_NAME_INVALID',
    );
  });

  it('SKILL_DESC_MISSING / SKILL_DESC_TOO_LONG', () => {
    expect(codes(validateSkillFrontmatter({ name: 'x' }, 'x'))).toContain('SKILL_DESC_MISSING');
    const desc = 'd'.repeat(SKILL_DESC_MAX + 1);
    expect(codes(validateSkillFrontmatter({ name: 'x', description: desc }, 'x'))).toContain(
      'SKILL_DESC_TOO_LONG',
    );
  });

  it('SKILL_DESC_UNSAFE_CHARS is a WARN, never an error (interop with .claude/skills)', () => {
    const issues = validateSkillFrontmatter(
      { name: 'x', description: 'Renders a <div> wrapper.' },
      'x',
    );
    const unsafe = issues.find((i) => i.code === 'SKILL_DESC_UNSAFE_CHARS');
    expect(unsafe?.level).toBe('warn');
    expect(issues.some((i) => i.level === 'error')).toBe(false);
  });

  it('SKILL_VERSION_INVALID and SKILL_ACTIVATION_INVALID are warns with documented fallbacks', () => {
    const issues = validateSkillFrontmatter(
      { name: 'x', description: 'd', version: 'v1', activation: 'sometimes' },
      'x',
    );
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(codes(issues)).toEqual(
      expect.arrayContaining(['SKILL_VERSION_INVALID', 'SKILL_ACTIVATION_INVALID']),
    );
    const fm = normalizeFrontmatter(
      { name: 'x', description: 'd', version: 'v1', activation: 'sometimes' },
      'x',
    );
    expect(fm.version).toBe('0.0.0');
    expect(fm.activation).toBe('auto');
  });

  it('SKILL_NAME_DIR_MISMATCH is a warn, not an error (§4.1 does not block loading)', () => {
    const issues = validateSkillFrontmatter({ name: 'pdf-forms', description: 'd' }, 'pdf');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'SKILL_NAME_DIR_MISMATCH', level: 'warn' });
  });

  it('SKILL_ALLOWED_TOOLS_INVALID for an over-long list', () => {
    const tools = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(
      codes(validateSkillFrontmatter({ name: 'x', description: 'd', 'allowed-tools': tools }, 'x')),
    ).toContain('SKILL_ALLOWED_TOOLS_INVALID');
  });

  it('a fully valid frontmatter produces no issues at all', () => {
    expect(
      validateSkillFrontmatter(
        { name: 'pdf-forms', description: 'Fill PDFs. Use when asked about forms.', version: '1.2.0' },
        'pdf-forms',
      ),
    ).toEqual([]);
  });
});

describe('checkStagedPath (zip-slip and friends)', () => {
  it('rejects traversal, absolute paths, drive letters and reserved names', () => {
    expect(checkStagedPath('../evil')?.code).toBe('SKILL_PATH_TRAVERSAL');
    expect(checkStagedPath('a/../../evil')?.code).toBe('SKILL_PATH_TRAVERSAL');
    expect(checkStagedPath('/etc/passwd')?.code).toBe('SKILL_PATH_ABSOLUTE');
    expect(checkStagedPath('C:/Windows/system32')?.code).toBe('SKILL_PATH_ABSOLUTE');
    expect(checkStagedPath('..\\evil')?.code).toBe('SKILL_PATH_TRAVERSAL');
    expect(checkStagedPath('scripts/NUL.py')?.code).toBe('SKILL_PATH_RESERVED_NAME');
    expect(checkStagedPath('a/b/c/d/e/f/g.md')?.code).toBe('SKILL_PATH_TOO_DEEP');
  });

  it('rejects control characters in a path', () => {
    expect(checkStagedPath(`a${String.fromCharCode(10)}b.md`)?.code).toBe('SKILL_PATH_CONTROL_CHARS');
  });

  it('accepts ordinary relative paths', () => {
    expect(checkStagedPath('SKILL.md')).toBeNull();
    expect(checkStagedPath('reference/acroform.md')).toBeNull();
  });
});

describe('validateStagedSkill (§8.3 step 2)', () => {
  const good = '---\nname: hello\ndescription: Say hello. Use when greeting.\n---\n\n# Hello\n';
  const file = (path: string, bytes = 10, isSymlink = false): StagedFile => ({
    path,
    bytes,
    ...(isSymlink ? { isSymlink } : {}),
  });

  it('accepts a well-formed staged skill', () => {
    const result = validateStagedSkill(good, [file('SKILL.md', 80)], 'hello', parseFrontmatter);
    expect(result.ok).toBe(true);
    expect(result.frontmatter?.name).toBe('hello');
    expect(result.totalBytes).toBe(80);
  });

  it('rejects a missing SKILL.md', () => {
    const result = validateStagedSkill(null, [file('reference/a.md')], 'hello', parseFrontmatter);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('SKILL_MD_MISSING');
  });

  it('rejects symlinks outright', () => {
    const result = validateStagedSkill(
      good,
      [file('SKILL.md', 80), file('link', 0, true)],
      'hello',
      parseFrontmatter,
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('SKILL_SYMLINK_REJECTED');
  });

  it('rejects a zip-slip entry', () => {
    const result = validateStagedSkill(
      good,
      [file('SKILL.md', 80), file('../../etc/passwd')],
      'hello',
      parseFrontmatter,
    );
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('SKILL_PATH_TRAVERSAL');
  });

  it('enforces the file-count and per-file size limits', () => {
    const many = Array.from({ length: STAGED_MAX_FILES + 1 }, (_, i) => file(`f${i}.md`));
    expect(validateStagedSkill(good, many, 'hello', parseFrontmatter).ok).toBe(false);

    const huge = validateStagedSkill(
      good,
      [file('SKILL.md', 80), file('big.bin', 6 * 1024 * 1024)],
      'hello',
      parseFrontmatter,
    );
    expect(codes(huge.issues)).toContain('SKILL_FILE_TOO_LARGE');
  });

  it('rejects a SKILL.md without frontmatter', () => {
    const result = validateStagedSkill('# no frontmatter', [file('SKILL.md')], 'hello', parseFrontmatter);
    expect(result.ok).toBe(false);
    expect(codes(result.issues)).toContain('SKILL_FRONTMATTER_MISSING');
  });
});
