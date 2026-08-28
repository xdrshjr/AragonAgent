/**
 * The `skills update --all` summary table (§6.3).
 *
 * A summary is the only thing a user reads after a bulk update, so a row that
 * describes the wrong action is worse than no row: it reports work as pending
 * that has already been written to disk, and it does so on the command whose
 * whole purpose is to tell you what happened across thirty skills at once.
 */

import { describe, expect, it } from 'vitest';
import { checkDeclaredTools, checkScriptPlatform, describeResult } from '../cli-commands.js';
import { currentPlatform } from '../node-host.js';
import { normalizeFrontmatter } from '@aragon-agent/core/skills';
import type { SkillRecord } from '@aragon-agent/core';
import type { UpdateResult } from '../updater.js';

const updated: UpdateResult = {
  ok: true,
  name: 'deploy-preview',
  changed: true,
  fromVersion: '1.2.0',
  toVersion: '1.3.1',
  // Present on a REAL update as well as a dry run — which is exactly why its
  // presence must never be used to tell the two apart.
  changedFiles: ['SKILL.md'],
};

describe('describeResult — the tense comes from the flag, not the payload', () => {
  it('a committed update reads as "updated"', () => {
    expect(describeResult(updated, false)).toBe('updated 1.2.0 -> 1.3.1');
  });

  it('the same result under --dry-run reads as "would update"', () => {
    expect(describeResult(updated, true)).toBe('would update 1.2.0 -> 1.3.1');
  });

  it('an unchanged skill is neither, in either mode', () => {
    const same: UpdateResult = { ok: true, name: 'x', changed: false, fromVersion: '1.0.0' };
    expect(describeResult(same, false)).toBe('up to date');
    expect(describeResult(same, true)).toBe('up to date');
  });

  it('a refusal reports its first line only, so one row stays one row', () => {
    const refused: UpdateResult = {
      ok: false,
      name: 'pdf-forms',
      changed: false,
      reason: 'locally_modified',
      error: 'pdf-forms has local changes that update would discard: SKILL.md\nRe-run with --force.',
    };
    expect(describeResult(refused, false)).toBe(
      'skipped: pdf-forms has local changes that update would discard: SKILL.md',
    );
  });
});

// ---------------------------------------------------------------------------
// doctor — the two checks this iteration added (§5.7 / §8.4)
// ---------------------------------------------------------------------------

function skill(input: {
  name: string;
  allowedTools?: string[];
  activation?: string;
}): SkillRecord {
  const description = `Does ${input.name}.`;
  return {
    name: input.name,
    description,
    scope: 'user',
    dir: `/skills/${input.name}`,
    entryPath: `/skills/${input.name}/SKILL.md`,
    frontmatter: normalizeFrontmatter(
      {
        name: input.name,
        description,
        version: '1.0.0',
        ...(input.allowedTools ? { 'allowed-tools': input.allowedTools } : {}),
        ...(input.activation ? { activation: input.activation } : {}),
      },
      input.name,
    ),
    body: null,
    files: null,
    bytes: 10,
    disabled: false,
    issues: [],
    invalid: false,
    shadowed: [],
    manifest: null,
    writable: true,
    integrity: 'unverified',
  };
}

describe('checkDeclaredTools — "will this declaration ever bite?" (§5.7 / P1-8)', () => {
  it('says nothing about a skill that declares nothing', () => {
    expect(checkDeclaredTools(skill({ name: 'plain' }))).toEqual([]);
  });

  it('reports a fully resolvable declaration as ok', () => {
    const [line] = checkDeclaredTools(skill({ name: 'a', allowedTools: ['read_file', 'Bash'] }));
    expect(line).toContain('tools: ok (read_file, bash)');
  });

  it('names the tools this host lacks without failing the skill', () => {
    const [line] = checkDeclaredTools(skill({ name: 'a', allowedTools: ['Read', 'WebFetch'] }));
    expect(line).toContain('tools: ok (read_file)');
    expect(line).toContain('ignored on this host: WebFetch');
  });

  it('flags an unresolvable name as NOT ENFORCEABLE and says how to fix it', () => {
    // This is the whole point of the check: the ceiling silently never applies,
    // and the cause is one mistyped word in a file the user can edit.
    const [line] = checkDeclaredTools(skill({ name: 'a', allowedTools: ['read_file', 'Reed'] }));
    expect(line).toContain('NOT ENFORCEABLE - unknown: Reed');
    expect(line).toContain('Fix the name');
  });

  it('tells an activation: always author that their declaration is ignored (D-G9)', () => {
    // A permission intent the system throws away wholesale. Nothing else in the
    // product would ever mention it.
    const [line] = checkDeclaredTools(
      skill({ name: 'ambient', allowedTools: ['read_file'], activation: 'always' }),
    );
    expect(line).toContain('activation: always');
    expect(line).toContain('never applies');
  });

  it('resolves against the host SUPERSET, not whatever is registered right now', () => {
    // doctor answers "can this work?", so `skill_create` must resolve even in a
    // process that has no agent and therefore no skill tools at all.
    const [line] = checkDeclaredTools(skill({ name: 'a', allowedTools: ['skill_create'] }));
    expect(line).toContain('tools: ok (skill_create)');
  });
});

describe('checkScriptPlatform (§8.4)', () => {
  it('stays quiet when a skill bundles nothing runnable', () => {
    expect(checkScriptPlatform(skill({ name: 'a' }), [{ path: 'references/a.md' }])).toEqual([]);
  });

  it('stays quiet when at least one script can run here', () => {
    const files = [{ path: 'scripts/fill.py' }, { path: 'scripts/legacy.sh' }];
    expect(checkScriptPlatform(skill({ name: 'a' }), files)).toEqual([]);
  });

  it('warns when every bundled script is for the other shell', () => {
    // A warning, never an error: the rest of the skill works fine, and the user
    // may not even need the scripts.
    const foreign = currentPlatform() === 'win32' ? 'scripts/run.sh' : 'scripts/run.ps1';
    const [line] = checkScriptPlatform(skill({ name: 'a' }), [{ path: foreign }]);
    expect(line).toContain('warn:');
    expect(line).toContain('bundles only');
  });
});
