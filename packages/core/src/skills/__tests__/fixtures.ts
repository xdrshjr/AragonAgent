/**
 * Shared record builder for the skills test suite.
 *
 * Kept out of the individual test files so a change to `SkillRecord` costs one
 * edit rather than six, and so every suite exercises the same default shape.
 */

import { normalizeFrontmatter } from '../validate.js';
import type { SkillIntegrity, SkillRecord, SkillScope } from '../types.js';

export interface MakeRecordInput {
  name: string;
  description?: string;
  scope?: SkillScope;
  version?: string;
  activation?: string;
  allowedTools?: string[];
  body?: string | null;
  files?: Array<{ path: string; bytes: number }> | null;
  disabled?: boolean;
  invalid?: boolean;
  dir?: string;
  keywords?: string[];
  integrity?: SkillIntegrity;
}

export function makeRecord(input: MakeRecordInput): SkillRecord {
  const description = input.description ?? `Does ${input.name}. Use when the task mentions ${input.name}.`;
  const dir = input.dir ?? `/skills/${input.name}`;
  const frontmatter = normalizeFrontmatter(
    {
      name: input.name,
      description,
      ...(input.version ? { version: input.version } : { version: '1.0.0' }),
      ...(input.activation ? { activation: input.activation } : {}),
      ...(input.allowedTools ? { 'allowed-tools': input.allowedTools } : {}),
      ...(input.keywords ? { keywords: input.keywords } : {}),
    },
    input.name,
  );
  return {
    name: input.name,
    description,
    scope: input.scope ?? 'user',
    dir,
    entryPath: `${dir}/SKILL.md`,
    frontmatter,
    body: input.body === undefined ? `# ${input.name}\n\nSteps go here.` : input.body,
    files: input.files === undefined ? [] : input.files,
    bytes: 100,
    disabled: input.disabled ?? false,
    issues: [],
    invalid: input.invalid ?? false,
    shadowed: [],
    manifest: null,
    writable: true,
    integrity: input.integrity ?? 'unverified',
  };
}
