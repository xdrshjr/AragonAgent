/**
 * The non-interactive tool policy (cli-integration-surface section 4.2 /
 * AC-11 / AC-13 / AC-15 / AC-28).
 *
 * TWO OF THESE CASES ASSERT A MECHANISM RATHER THAN AN OUTCOME, deliberately:
 * AC-28 asserts OBJECT IDENTITY, because "the existing paths are unchanged" is
 * worth exactly as much as the test that proves it; and AC-15 compares
 * `--permission-mode plan` against `-p --plan` NAME BY NAME, because a stub can
 * produce the right-looking tool list from a design that cannot work.
 */

import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@aragon-agent/core';
import {
  createBuiltinTools,
  HOST_TOOL_NAMES,
  PLAN_MODE_BLOCKED_TOOLS,
  type BuiltinToolsOptions,
} from '../tools/index.js';
import { resolvePermission, resolveToolAllowList } from '../exec/permission.js';
import { runExec } from '../exec/index.js';
import type { AgentController } from '../agent/controller.js';
import type { CliFlags } from '../config/load.js';
import { TEAM_SUBAGENT_TOOL_NAMES } from '../team/limits.js';

const REGISTERED = [...HOST_TOOL_NAMES];

function names(options: BuiltinToolsOptions): string[] {
  return createBuiltinTools(options).map((t) => t.name);
}

const BASE: BuiltinToolsOptions = { getCwd: () => process.cwd() };

describe('AC-11: the three baselines', () => {
  it('auto leaves everything registered', () => {
    expect(resolvePermission({ mode: 'auto', allow: [], deny: [] })).toBeUndefined();
    expect([...resolveToolAllowList(REGISTERED, 'auto', [], [])]).toEqual(REGISTERED);
  });

  it('strict registers nothing without an allow list', () => {
    const permission = resolvePermission({ mode: 'strict', allow: [], deny: [] });
    expect(permission).toBeDefined();
    // `strict` ALWAYS produces an object, even with empty lists: "no tools at
    // all" is a real posture, not the absence of one.
    expect([...resolveToolAllowList(REGISTERED, 'strict', [], [])]).toEqual([]);
  });

  it('strict + allow registers exactly the named tools', () => {
    const allowed = resolveToolAllowList(REGISTERED, 'strict', ['read_file', 'grep'], []);
    expect([...allowed].sort()).toEqual(['grep', 'read_file']);
    expect(allowed.has('write_file')).toBe(false);
  });

  it('the filter reaches the real factory: write_file is absent from the array', () => {
    const permission = resolvePermission({ mode: 'strict', allow: ['read_file'], deny: [] });
    const list = names({ ...BASE, ...(permission ? { permission } : {}) });
    expect(list).toEqual(['read_file']);
  });
});

describe('AC-13: deny wins over allow', () => {
  it('removes a tool named in both lists', () => {
    const allowed = resolveToolAllowList(REGISTERED, 'strict', ['bash'], ['bash']);
    expect(allowed.has('bash')).toBe(false);
  });

  it('--deny-tool bash alone leaves everything else', () => {
    const permission = resolvePermission({ mode: 'auto', allow: [], deny: ['bash'] });
    expect(permission).toBeDefined();
    const list = names({ ...BASE, ...(permission ? { permission } : {}) });
    expect(list).not.toContain('bash');
    expect(list).toContain('read_file');
    expect(list).toContain('write_file');
  });
});

describe('P1-3: the comm tools are exempt through the constant that already exists', () => {
  it('team_send / team_wait survive --permission-mode strict', () => {
    // Filtering them out of a strict run breaks subagent messaging in a way that
    // reads as a hang: a child waiting for mail that can never arrive.
    const permission = resolvePermission({ mode: 'strict', allow: [], deny: [] });
    for (const name of TEAM_SUBAGENT_TOOL_NAMES) {
      expect(permission?.isAllowed(name)).toBe(true);
    }
  });

  it('they survive an explicit deny as well', () => {
    const permission = resolvePermission({
      mode: 'auto',
      allow: [],
      deny: ['team_send', 'team_wait'],
    });
    for (const name of TEAM_SUBAGENT_TOOL_NAMES) {
      expect(permission?.isAllowed(name)).toBe(true);
    }
  });
});

describe('P0-2 / AC-15: `plan` is a MODE, not a filter', () => {
  it('resolves to no filter at all, so nothing is unregistered', () => {
    expect(resolvePermission({ mode: 'plan', allow: [], deny: [] })).toBeUndefined();
    expect([...resolveToolAllowList(REGISTERED, 'plan', [], [])]).toEqual(REGISTERED);
  });

  it('produces the same registered tool set as `-p --plan`, name by name', () => {
    // ASSERTED ON THE MECHANISM. `withPlanModeGate` wraps ALL tools and refuses
    // the blocked five AT CALL TIME, so they stay in `listTools()`. An
    // implementation that unregistered them instead would satisfy any prose
    // description of "plan mode" and fail here.
    const planFlag = names({ ...BASE, agentMode: () => 'plan' });
    const permission = resolvePermission({ mode: 'plan', allow: [], deny: [] });
    const execPlan = names({
      ...BASE,
      agentMode: () => 'plan',
      ...(permission ? { permission } : {}),
    });
    expect(execPlan).toEqual(planFlag);
    // The claim P0-2 is about, stated positively: every blocked tool THIS
    // factory registers is still in the list under plan mode. (`skill_install` /
    // `skill_create` reach the array through `skillTools`, so a bare factory
    // call has neither and the intersection is the honest set to assert on.)
    const registeredAndBlocked = [...PLAN_MODE_BLOCKED_TOOLS].filter((n) => planFlag.includes(n));
    expect(registeredAndBlocked.sort()).toEqual(['bash', 'edit_file', 'write_file']);
    for (const blocked of registeredAndBlocked) expect(execPlan).toContain(blocked);
  });

  it('still honours a deny list layered on top of plan mode', () => {
    const permission = resolvePermission({ mode: 'plan', allow: [], deny: ['bash'] });
    expect(permission).toBeDefined();
    expect(permission?.isAllowed('bash')).toBe(false);
    expect(permission?.isAllowed('write_file')).toBe(true);
  });
});

describe('AC-28: omitting `permission` leaves the tool objects UNTOUCHED', () => {
  // The `AC-G17` proof, re-asserted for the new option and using the same
  // sentinel technique `plan-gate.test.ts` uses: the seven built-ins are
  // constructed fresh on every call, so a CALLER-SUPPLIED tool is the only thing
  // whose identity can carry the claim.
  function sentinel(name: string): AgentTool {
    return {
      name,
      label: name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }),
    };
  }

  it('is provable by object identity', () => {
    // An unconditional `tools.filter(...)` would type-check, behave identically,
    // and quietly allocate a new array on every existing path - forfeiting the
    // ability to PROVE that `-p`, the TUI and every subagent are unchanged.
    const probe = sentinel('probe');
    const tools = createBuiltinTools({ ...BASE, skillTools: [probe] });
    expect(tools[tools.length - 1]).toBe(probe);
  });

  it('and a permission that keeps the tool still hands back the same object', () => {
    // The filter REMOVES elements; it must not wrap the survivors. If it ever
    // starts to, the wrappers below it stop being the only thing between a tool
    // and the engine.
    const probe = sentinel('read_file');
    const permission = resolvePermission({ mode: 'strict', allow: ['read_file'], deny: [] });
    const tools = createBuiltinTools({
      ...BASE,
      skillTools: [probe],
      ...(permission ? { permission } : {}),
    });
    expect(tools[tools.length - 1]).toBe(probe);
  });
});

/**
 * IF-6 - the wiring that ARMS plan mode, asserted end to end through `runExec`.
 *
 * The name-by-name case above cannot catch this and neither can any test that
 * hands `agentMode` to both sides itself: the plan gate WRAPS rather than
 * removes, so `listTools()` is identical whether the mode is armed or not. The
 * only observable difference is `flags.plan`, which is what `loadConfig` turns
 * into `startInPlanMode` and `AgentController` turns into `effectiveMode`.
 * Asserting on the flags handed to the controller factory is therefore the
 * mechanism, not a proxy for it.
 */
describe('IF-6: --permission-mode plan actually arms plan mode', () => {
  function captureFlags(mode: 'auto' | 'plan' | 'strict'): CliFlags {
    let seen: CliFlags | null = null;
    const stub = {
      preflight: () => ({ ok: true }),
      subscribe: () => () => {},
      getModelInfo: () => ({ cost: { input: 0, output: 0 } }),
      getTodoSnapshot: () => null,
      getTodoConfig: () => ({ followThrough: 'notify' as const }),
      getConfig: () => ({ provider: 'anthropic', model: 'm', baseUrl: undefined }),
      getCwd: () => process.cwd(),
      getMessages: () => [],
      replaceMessages: () => {},
      restoreTodos: () => {},
      listTools: () => [],
      isPricedModel: () => false,
      abort: () => {},
      dispose: () => {},
      prompt: async () => {},
    };
    const discard = { write: () => true } as unknown as NodeJS.WritableStream;
    void runExec(
      {},
      { outputFormat: 'json', permissionMode: mode, saveSession: false },
      'x',
      {
        version: '0.6.0',
        makeController: (flags) => {
          seen = flags;
          return stub as unknown as AgentController;
        },
        stdout: discard,
        stderr: discard,
      },
    );
    // `makeController` is called synchronously inside `execute`, before the
    // first `await` that could reach the model.
    expect(seen).not.toBeNull();
    return seen as unknown as CliFlags;
  }

  it('sets flags.plan, which is the ONLY carrier the controller reads', () => {
    // Without it `system/init` reports `permissionMode: "plan"` while the gate
    // is not armed - the README's "read-only research and a written plan"
    // example would edit files, and nothing would report it.
    expect(captureFlags('plan').plan).toBe(true);
  });

  it('leaves the flags untouched for auto and strict', () => {
    // `--permission-mode` selects a BASELINE SET; it is not a switch for plan
    // mode in the other direction. Forcing `plan: false` here would override a
    // user's `planModeDefault: true` config that `aragon -p` honours, and would
    // break text mode's byte-equality with `-p` (AC-1).
    expect(captureFlags('auto').plan).toBeUndefined();
    expect(captureFlags('strict').plan).toBeUndefined();
  });
});
