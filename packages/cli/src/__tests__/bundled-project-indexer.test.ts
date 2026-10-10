/**
 * Contract tests for the bundled `project-indexer` skill (the Ctrl+I feature).
 *
 * A bundled skill ships with the npm package, so NOTHING at runtime will ever
 * report it as broken the way `/skills doctor` does for an installed one -
 * a malformed bundled skill would surface as "Ctrl+I says the skill is not
 * available" on every machine at once. These tests are the doctor visit that
 * cannot be skipped: the file parses, the frontmatter validates, the body is
 * under the invocation budget, the templates it references actually ship,
 * and the declared tool ceiling resolves on this host.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '@aragon-agent/core';
import { normalizeFrontmatter } from '@aragon-agent/core/skills';
import { resolveDeclaredTool } from '@aragon-agent/core/skills';
import { getBundledSkillsDir } from '../skills/paths.js';
import { DEFAULT_SKILLS_CONFIG } from '../config/schema.js';
import { HOST_TOOL_NAMES } from '../tools/index.js';

const SKILL_DIR = join(getBundledSkillsDir(), 'project-indexer');
const ENTRY = join(SKILL_DIR, 'SKILL.md');

/** Parse the entry file once per call, failing loud rather than null-checking at each use. */
function parseEntry(): NonNullable<ReturnType<typeof parseFrontmatter>> {
  const parsed = parseFrontmatter(readFileSync(ENTRY, 'utf8'));
  if (!parsed) throw new Error('bundled SKILL.md failed to parse');
  return parsed;
}

describe('bundled project-indexer skill', () => {
  it('ships an entry file inside the bundled data directory', () => {
    // <pkg>/skills, NOT <pkg>/dist/skills - the distinction `getBundledSkillsDir`
    // exists to keep straight (see paths.ts), asserted here because a build
    // regression would move this directory out of the published files list.
    expect(getBundledSkillsDir().replace(/\\/g, '/')).toMatch(/\/skills$/);
    expect(existsSync(ENTRY)).toBe(true);
    expect(statSync(ENTRY).isFile()).toBe(true);
  });

  it('parses with the exact name the Ctrl+I dispatch expects', () => {
    const parsed = parseEntry();
    expect(parsed.errors).toEqual([]);
    const frontmatter = normalizeFrontmatter(parsed.data, 'project-indexer');
    expect(frontmatter.name).toBe('project-indexer');
    expect(frontmatter.activation).not.toBe('manual');
  });

  it('documents its triggers in the description the model ranks on', () => {
    const parsed = parseEntry();
    const frontmatter = normalizeFrontmatter(parsed.data, 'project-indexer');
    const description = frontmatter.description;
    // The Ctrl+I entry point only works if the model ALSO reaches for the
    // skill from words alone; both languages are load-bearing.
    expect(description.toLowerCase()).toContain('index');
    expect(description).toContain('regenerate index');
    expect(description).toContain('Ctrl+I');
  });

  it('keeps the body under the default invocation budget', () => {
    const parsed = parseEntry();
    const bytes = Buffer.byteLength(parsed.body, 'utf8');
    // `renderSkillInvocation` truncates at bodyMaxBytes; a bundled skill that
    // needs truncation ships visibly broken (instructions cut mid-sentence).
    expect(bytes).toBeLessThan(DEFAULT_SKILLS_CONFIG.bodyMaxBytes);
  });

  it('declares a tool ceiling that resolves on this host', () => {
    const parsed = parseEntry();
    const frontmatter = normalizeFrontmatter(parsed.data, 'project-indexer');
    const declared = frontmatter.allowedTools;
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      // `null` is the NOT ENFORCEABLE verdict `/skills info` warns about; a
      // bundled skill must never ship in that state.
      expect(resolveDeclaredTool(name, HOST_TOOL_NAMES)).not.toBeNull();
    }
    // The writers the generated files need; the readers are in the floor.
    expect(declared).toContain('write_file');
    expect(declared).toContain('edit_file');
  });

  it('bundles the four templates the body references', () => {
    for (const name of [
      'cleancode-template.md',
      'cleancode-overrides.md',
      'config-template.md',
      'index-template.md',
    ]) {
      expect(existsSync(join(SKILL_DIR, 'templates', name))).toBe(true);
    }
  });

  it('keeps every documented placeholder present in the cleancode template', () => {
    const template = readFileSync(join(SKILL_DIR, 'templates', 'cleancode-template.md'), 'utf8');
    for (const placeholder of [
      '{{MAX_FILE_LINES}}',
      '{{MAX_METHOD_LINES}}',
      '{{MAX_FUNCTION_PARAMS}}',
      '{{MAX_CYCLOMATIC}}',
      '{{MAX_LINE_LENGTH}}',
      '{{MAX_NESTING_DEPTH}}',
      '{{PRIMARY_LANGUAGES}}',
      '{{LANGUAGE_HINTS}}',
    ]) {
      expect(template).toContain(placeholder);
    }
  });
});
