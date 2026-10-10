/**
 * The policy reaches children (cli-integration-surface section 4.2 invariant 3
 * / AC-12 / R-4).
 *
 * THIS IS THE CASE THAT DECIDES WHETHER `--deny-tool bash` IS A SECURITY
 * CONTROL OR A SUGGESTION. Without the thread from `ControllerDeps` through
 * `TeamRuntimeDeps` to `SubagentDeps`, one `task` call bypasses the whole
 * policy - and NOTHING ANYWHERE REPORTS IT. Plan mode's "reaches one level down"
 * guarantee is the precedent; this is the same guarantee for the same reason.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@aragon-agent/core';
import { buildSubagentTools, type SubagentDeps } from '../team/subagent.js';
import { resolvePermission } from '../exec/permission.js';
import { TEAM_SUBAGENT_TOOL_NAMES } from '../team/limits.js';
import { TeamBus } from '../team/bus.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import type { CliConfig } from '../config/schema.js';
import type { SubagentSpec } from '../team/types.js';

const dir = mkdtempSync(join(tmpdir(), 'aragon-child-perm-'));

const SPEC: SubagentSpec = {
  label: 'A',
  description: 'do a thing',
  prompt: 'go',
  readOnly: false,
};

function config(): CliConfig {
  return { ...(DEFAULT_CONFIG as unknown as CliConfig), cwd: dir };
}

function childTools(permission?: ReturnType<typeof resolvePermission>): AgentTool[] {
  const deps: SubagentDeps = {
    bus: new TeamBus([SPEC.label]),
    config: config(),
    providerRegistry: {} as SubagentDeps['providerRegistry'],
    getCwd: () => dir,
    getMode: () => 'build',
    getApiKey: () => 'k',
    confirmTools: false,
    agentFactory: (() => ({})) as unknown as SubagentDeps['agentFactory'],
    ...(permission ? { permission } : {}),
  };
  return buildSubagentTools(SPEC, deps, () => null);
}

describe('AC-12: --deny-tool is honoured INSIDE a task subagent', () => {
  it('the child array contains no bash', () => {
    const permission = resolvePermission({ mode: 'auto', allow: [], deny: ['bash'] });
    const names = childTools(permission).map((t) => t.name);
    expect(names).not.toContain('bash');
    // And the rest of the child is untouched, so this is a policy rather than a
    // blanket downgrade.
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
  });

  it('without a policy the child keeps bash, so the case is not vacuous', () => {
    expect(childTools().map((t) => t.name)).toContain('bash');
  });
});

describe('invariant 4: the comm tools survive --permission-mode strict', () => {
  it('team_send and team_wait are still registered on the child', () => {
    // They are registered only on CHILDREN and are the mechanism children use to
    // coordinate; filtering them out breaks subagent messaging in a way that
    // reads as a hang.
    const permission = resolvePermission({ mode: 'strict', allow: [], deny: [] });
    const names = childTools(permission).map((t) => t.name);
    for (const comm of TEAM_SUBAGENT_TOOL_NAMES) expect(names).toContain(comm);
    // And strict really did apply: nothing else survived.
    expect(names.filter((n) => !TEAM_SUBAGENT_TOOL_NAMES.has(n))).toEqual([]);
  });

  it('a strict child with an allow list gets exactly that plus the comm tools', () => {
    const permission = resolvePermission({
      mode: 'strict',
      allow: ['read_file', 'grep'],
      deny: [],
    });
    const names = childTools(permission).map((t) => t.name).sort();
    expect(names).toEqual(['grep', 'read_file', 'team_send', 'team_wait']);
  });
});

describe('AC-28 at the child layer: no policy means no change', () => {
  it('a child built without a policy has the same tool names as before', () => {
    const names = childTools().map((t) => t.name);
    // The pre-feature child: seven built-ins plus the two comm tools (no skill
    // registry, no plan tools, no todo tool - see `buildSubagentTools`).
    expect(names.sort()).toEqual([
      'bash',
      'edit_file',
      'glob',
      'grep',
      'list_dir',
      'read_file',
      'team_send',
      'team_wait',
      'write_file',
    ]);
  });
});
