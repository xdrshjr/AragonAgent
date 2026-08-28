/**
 * Shared tmpdir fixture for the CLI skill suites.
 *
 * `paths.ts` reads `envPaths('aragon-agent')` at module load, so the user root
 * cannot be redirected with an env var after the fact. Suites that need to
 * exercise the real user root therefore mock `../paths.js`; suites that only
 * need directories on disk use these helpers directly.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SkillsConfig, SkillsRuntimeOptions } from '../../config/schema.js';
import { DEFAULT_SKILLS_CONFIG, DEFAULT_SKILLS_RUNTIME } from '../../config/schema.js';
import type { ApprovalGate } from '../service.js';

export function makeTmpDir(prefix = 'aragon-skills-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface SkillFixture {
  name?: string;
  description?: string;
  version?: string;
  activation?: string;
  body?: string;
  /** Extra bundled files, relative path → content. */
  files?: Record<string, string>;
  /** Emit a SKILL.md with no frontmatter at all. */
  broken?: boolean;
}

/** Write a skill directory under `root` and return its absolute path. */
export function writeSkill(root: string, dirName: string, fixture: SkillFixture = {}): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  if (fixture.broken) {
    writeFileSync(join(dir, 'SKILL.md'), '# no frontmatter here\n', 'utf-8');
  } else {
    const front = [
      '---',
      `name: ${fixture.name ?? dirName}`,
      `description: ${fixture.description ?? `Does ${dirName}. Use when the task mentions ${dirName}.`}`,
      `version: ${fixture.version ?? '1.0.0'}`,
      ...(fixture.activation ? [`activation: ${fixture.activation}`] : []),
      '---',
      '',
      fixture.body ?? `# ${dirName}\n\nSteps.`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'SKILL.md'), front, 'utf-8');
  }
  for (const [rel, content] of Object.entries(fixture.files ?? {})) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  return dir;
}

export function skillsConfig(overrides: Partial<SkillsConfig> = {}): SkillsConfig {
  return { ...DEFAULT_SKILLS_CONFIG, ...overrides };
}

export function runtimeOptions(overrides: Partial<SkillsRuntimeOptions> = {}): SkillsRuntimeOptions {
  return { ...DEFAULT_SKILLS_RUNTIME, ...overrides };
}

/** An approval gate that records how it was used — the core of the AC-13 test. */
export function recordingGate(behaviour: { canPrompt: boolean; approve: boolean }): ApprovalGate & {
  canPromptCalls: number;
  requestCalls: number;
} {
  const gate = {
    canPromptCalls: 0,
    requestCalls: 0,
    canPrompt(): boolean {
      gate.canPromptCalls += 1;
      return behaviour.canPrompt;
    },
    async request(): Promise<boolean> {
      gate.requestCalls += 1;
      return behaviour.approve;
    },
  };
  return gate;
}
