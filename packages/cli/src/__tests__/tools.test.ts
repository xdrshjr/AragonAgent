import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolResult } from '@aragon-agent/core';
import {
  createBuiltinTools,
  HOST_TOOL_NAMES,
  PLAN_MODE_BLOCKED_TOOLS,
  SKILL_TOOL_FLOOR,
} from '../tools/index.js';

let dir: string;
let tools: Record<string, AgentTool>;
const ctx: ToolExecutionContext = {};

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-tools-'));
  const list = createBuiltinTools({ getCwd: () => dir });
  tools = Object.fromEntries(list.map((t) => [t.name, t]));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort cleanup — a lingering child on Windows can briefly lock the dir.
  }
});

describe('write_file + read_file', () => {
  it('round-trips content', async () => {
    const w = await tools.write_file!.execute('1', { path: 'a.txt', content: 'hello\nworld' }, ctx);
    expect(w.isError).toBeFalsy();
    const r = await tools.read_file!.execute('2', { path: 'a.txt' }, ctx);
    expect(text(r)).toContain('hello');
    expect(text(r)).toContain('world');
  });

  it('read_file errors on a missing file', async () => {
    const r = await tools.read_file!.execute('3', { path: 'nope.txt' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('edit_file', () => {
  it('replaces a unique string and returns a diff preview', async () => {
    await tools.write_file!.execute('4', { path: 'edit.txt', content: 'alpha beta gamma' }, ctx);
    const e = await tools.edit_file!.execute(
      '5',
      { path: 'edit.txt', old_string: 'beta', new_string: 'BETA' },
      ctx,
    );
    expect(e.isError).toBeFalsy();
    const preview = text(e);
    expect(preview).toContain('- alpha beta gamma');
    expect(preview).toContain('+ alpha BETA gamma');
  });

  it('errors when old_string is not found', async () => {
    const e = await tools.edit_file!.execute(
      '6',
      { path: 'edit.txt', old_string: 'missing', new_string: 'x' },
      ctx,
    );
    expect(e.isError).toBe(true);
  });

  it('replace_all replaces every occurrence', async () => {
    await tools.write_file!.execute('7', { path: 'multi.txt', content: 'a a a' }, ctx);
    const e = await tools.edit_file!.execute(
      '8',
      { path: 'multi.txt', old_string: 'a', new_string: 'b', replace_all: true },
      ctx,
    );
    expect(e.isError).toBeFalsy();
    const r = await tools.read_file!.execute('9', { path: 'multi.txt' }, ctx);
    expect(text(r)).toContain('b b b');
  });

  it('inserts $-patterns in new_string literally (no String.replace substitution)', async () => {
    await tools.write_file!.execute('20', { path: 'dollar.txt', content: 'PLACEHOLDER end' }, ctx);
    const e = await tools.edit_file!.execute(
      '21',
      { path: 'dollar.txt', old_string: 'PLACEHOLDER', new_string: 'cost is $$5 and $& $1' },
      ctx,
    );
    expect(e.isError).toBeFalsy();
    const r = await tools.read_file!.execute('22', { path: 'dollar.txt' }, ctx);
    expect(text(r)).toContain('cost is $$5 and $& $1');
  });
});

describe('list_dir + glob + grep', () => {
  it('lists directory entries', async () => {
    const r = await tools.list_dir!.execute('10', {}, ctx);
    expect(text(r)).toContain('a.txt');
  });

  it('glob finds seeded files', async () => {
    const r = await tools.glob!.execute('11', { pattern: '*.txt' }, ctx);
    expect(text(r)).toContain('a.txt');
  });

  it('grep finds a seeded pattern', async () => {
    writeFileSync(join(dir, 'search.txt'), 'find the needle here\nnot this line', 'utf-8');
    const r = await tools.grep!.execute('12', { pattern: 'needle' }, ctx);
    expect(text(r)).toContain('needle');
  });

  it('grep searches a single-file path (not just a directory)', async () => {
    writeFileSync(join(dir, 'single.txt'), 'unique_token_zzz on this line\nother', 'utf-8');
    const r = await tools.grep!.execute('23', { pattern: 'unique_token_zzz', path: 'single.txt' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('unique_token_zzz');
  });
});

describe('bash', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await tools.bash!.execute('13', { command: 'node -e "console.log(\'ping\')"' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('ping');
    expect(text(r)).toContain('exit code 0');
  });

  it('reports a non-zero exit code as an error', async () => {
    const r = await tools.bash!.execute('14', { command: 'node -e "process.exit(3)"' }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('exit code 3');
  });

  it('honors the timeout param', async () => {
    const r = await tools.bash!.execute(
      '15',
      { command: 'node -e "setTimeout(()=>{},4000)"', timeout: 500 },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('timed out');
  }, 8000);
});

// ---------------------------------------------------------------------------
// The tool ceiling wrapper (§5.4b)
// ---------------------------------------------------------------------------

describe('SKILL_TOOL_FLOOR / HOST_TOOL_NAMES (D-G6 / D-G7 / P1-8)', () => {
  it('the floor is read-only work, the two skill lookups, and the two human-input tools - everything that cannot write to disk', () => {
    // Anything that writes to DISK must stay outside the floor, or the ceiling
    // controls nothing worth controlling.
    //
    // The wording moved from "read-only work plus the two skill lookups, and
    // nothing else" when plan mode landed, because `submit_plan` DOES mutate
    // something: the session mode. It cannot touch the filesystem, which is the
    // property the ceiling is about, so it belongs in the floor — but leaving
    // the old sentence in place would have made the prose false while the test
    // stayed green (P2-5).
    //
    // `task` joins the floor for the same shape of reason `submit_plan` did: it
    // cannot itself touch the filesystem. Every child mutation it leads to
    // passes through this same wrapper stack ONE LEVEL DOWN, with the child
    // inheriting `agentMode` through the same closure — so plan mode's
    // read-only guarantee holds by construction rather than by blocking
    // delegation, which would forfeit parallel research (D-5 / R-13).
    expect([...SKILL_TOOL_FLOOR]).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'skill',
      'skill_find',
      'ask_user',
      'submit_plan',
      'task',
      // `todo_write` joins the floor rather than the blocked set (D-12): it is a
      // display, it writes no file and runs no shell, and a skill's
      // `allowed-tools` omitting it would make the planning UI unreachable
      // inside that skill's frame.
      'todo_write',
      // `bash_output` joins the floor rather than the blocked set (D-12): it
      // reads a buffer, it cannot write to disk or run a shell, and blocking it
      // in plan mode would let the agent start a service it then could not read.
      'bash_output',
    ]);
    for (const mutating of [
      'write_file',
      'edit_file',
      'bash',
      'skill_install',
      'skill_create',
      // `bash_kill` terminates a process, which is a mutation of the world.
      'bash_kill',
    ]) {
      expect(SKILL_TOOL_FLOOR).not.toContain(mutating);
    }
  });

  it('C7: HOST_TOOL_NAMES matches what createBuiltinTools actually produces', () => {
    // Two lists of tool names is one more than the system can keep honest by
    // itself. Drift here means doctor silently reports a valid declaration as
    // NOT ENFORCEABLE, or misses one that really is broken.
    const stub = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [] }),
    });
    const skillTools = ['skill', 'skill_find', 'skill_install', 'skill_create'].map(stub);
    const planTools = ['ask_user', 'submit_plan'].map(stub);
    // THIS INVOCATION IS WHY `task` HAS TO ARRIVE THROUGH A FACTORY OPTION
    // (D-15 / P0-1). This assertion compares `HOST_TOOL_NAMES` against what the
    // factory PRODUCES, so appending `task` in `AgentController` after the
    // factory returned would turn this red with a message about two lists of
    // names that says nothing about team mode.
    const teamTools = [stub('task')];
    // Same argument, one feature later (todo-plan-execution C-2): `todo_write`
    // reaches the array through a factory option precisely because THIS
    // assertion compares `HOST_TOOL_NAMES` against what the factory produces.
    const todoTools = [stub('todo_write')];
    // Same argument, one feature later again (background-service-supervision
    // P0-2): `bash_output` / `bash_kill` reach the array through a factory
    // option precisely because THIS assertion compares `HOST_TOOL_NAMES` against
    // what the factory produces.
    const procTools = ['bash_output', 'bash_kill'].map(stub);
    const produced = createBuiltinTools({
      getCwd: () => dir,
      skillTools,
      planTools,
      todoTools,
      procTools,
      teamTools,
    }).map((t) => t.name);
    expect([...HOST_TOOL_NAMES].sort()).toEqual(produced.sort());
  });

  it('team_send / team_wait are deliberately NOT host tool names (P2-5)', () => {
    // `HOST_TOOL_NAMES` answers "can a skill's `allowed-tools` declaration ever
    // take effect?". These two are never registered on a lead, so a skill naming
    // them genuinely IS unenforceable and `skills doctor` reporting it as such
    // is correct. They reach children through `policyExempt`, which is a
    // different mechanism answering a different question.
    expect(HOST_TOOL_NAMES).not.toContain('team_send');
    expect(HOST_TOOL_NAMES).not.toContain('team_wait');
  });

  it('policyExempt skips the ceiling wrapper only, and only for the named tools', async () => {
    const probe: AgentTool = {
      name: 'team_send',
      label: 'probe',
      description: 'probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'sent' }] }),
    };
    const decision = {
      mode: 'enforce' as const,
      // A ceiling that permits NOTHING the child declared: without the
      // exemption the comm tools would be refused and the channel would dead-end
      // (§3.11), which is the same dead end `SKILL_TOOL_FLOOR` exists to
      // prevent one level up.
      allowed: new Set(['read_file']),
      sources: [{ name: 's', declared: ['read_file'], granted: ['read_file'] }],
      sourceNames: ['s'],
      ignored: [],
    };
    const built = Object.fromEntries(
      createBuiltinTools({
        getCwd: () => dir,
        teamTools: [probe],
        toolPolicy: () => decision,
        policyExempt: new Set(['team_send']),
      }).map((t) => [t.name, t]),
    );
    expect(text(await built.team_send!.execute('1', {}, ctx))).toContain('sent');
    // ...and everything else is still under the ceiling.
    expect((await built.bash!.execute('2', { command: 'echo hi' }, ctx)).isError).toBe(true);
  });

  it('every floor entry is a real host tool', () => {
    for (const name of SKILL_TOOL_FLOOR) expect(HOST_TOOL_NAMES).toContain(name);
  });

  it('I-P6: the floor and the blocked set PARTITION the host tool names', () => {
    // The two constants live in one file precisely so this can be asserted. A
    // tool that fell out of both would be silently unreachable in plan mode
    // while a skill ceiling was active; one that fell into both is a
    // contradiction nobody would notice from either definition alone.
    const floor = new Set<string>(SKILL_TOOL_FLOOR);
    const overlap = [...PLAN_MODE_BLOCKED_TOOLS].filter((n) => floor.has(n));
    expect(overlap).toEqual([]);
    expect([...HOST_TOOL_NAMES].sort()).toEqual(
      [...floor, ...PLAN_MODE_BLOCKED_TOOLS].sort(),
    );
  });
});

describe('AC-G17 — the --no-skills path is untouched', () => {
  it('yields exactly seven tools', () => {
    expect(createBuiltinTools({ getCwd: () => dir })).toHaveLength(7);
  });

  it('leaves the tool objects UNTOUCHED, proven by identity', () => {
    // A ceiling that always allowed would behave the same, so this assertion
    // buys nothing at run time — it buys the ability to PROVE "this path is
    // unchanged from iteration 2" instead of asking anyone to take it on trust.
    //
    // A sentinel passed through `skillTools` is what makes identity checkable at
    // all: the built-ins are freshly constructed on every call, so only an object
    // supplied by the caller can be compared with `toBe`.
    const sentinel: AgentTool = {
      name: 'sentinel',
      label: 'Sentinel',
      description: 'identity probe',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [] }),
    };

    const bare = createBuiltinTools({ getCwd: () => dir, skillTools: [sentinel] });
    expect(bare[bare.length - 1]).toBe(sentinel);

    const wrapped = createBuiltinTools({
      getCwd: () => dir,
      skillTools: [sentinel],
      toolPolicy: () => ({ mode: 'off', allowed: null, sources: [], sourceNames: [], ignored: [] }),
    });
    // With a decision provider every tool is a copy — including the sentinel.
    expect(wrapped[wrapped.length - 1]).not.toBe(sentinel);
    expect(wrapped[wrapped.length - 1]!.name).toBe('sentinel');
  });

  it('a decision provider is what switches wrapping on', async () => {
    const decision = {
      mode: 'enforce' as const,
      allowed: new Set(['read_file']),
      sources: [{ name: 's', declared: ['read_file'], granted: ['read_file'] }],
      sourceNames: ['s'],
      ignored: [],
    };
    const wrapped = Object.fromEntries(
      createBuiltinTools({ getCwd: () => dir, toolPolicy: () => decision }).map((t) => [t.name, t]),
    );
    const refused = await wrapped.bash!.execute('1', { command: 'echo hi' }, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('not permitted');
  });
});
