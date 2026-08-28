/**
 * The plan-mode read-only gate (plan-mode §3.3).
 *
 * The invariant worth the most here is AC-P20 / P0-1: the gate has to be applied
 * on the `--no-skills` path too. Its failure mode is silent — a badge reading
 * PLAN over a session whose `write_file` is fully live — so it gets a test of
 * its own rather than riding on the happy path.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolResult } from '@aragon-agent/core';
import { createBuiltinTools, PLAN_MODE_BLOCKED_TOOLS } from '../tools/index.js';
import type { AgentMode } from '../agent/agent-mode.js';

let dir: string;
const ctx: ToolExecutionContext = {};

function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

/** A tool that records whether it was ever actually reached. */
function spyTool(name: string): { tool: AgentTool; calls: () => number } {
  const spy = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
  return {
    tool: {
      name,
      label: name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: spy,
    },
    calls: () => spy.mock.calls.length,
  };
}

function byName(tools: AgentTool[]): Record<string, AgentTool> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aragon-plan-gate-'));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort cleanup.
  }
});

describe('I-P3 - plan mode refuses the five mutating tools', () => {
  it('refuses each of them WITHOUT invoking the underlying execute', async () => {
    const spies = [...PLAN_MODE_BLOCKED_TOOLS].map((name) => spyTool(name));
    const tools = byName(
      createBuiltinTools({
        getCwd: () => dir,
        // Registered through `skillTools` so the same probe covers the built-ins
        // and the skill tools with one mechanism.
        skillTools: spies.map((s) => s.tool),
        agentMode: () => 'plan',
      }),
    );

    for (const [i, name] of [...PLAN_MODE_BLOCKED_TOOLS].entries()) {
      const result = await tools[name]!.execute('1', {}, ctx);
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toContain('Plan mode is active');
      // The refusal must happen at the boundary. A gate that runs the tool and
      // then reports a refusal is not a gate.
      expect(spies[i]!.calls(), name).toBe(0);
    }
  });

  it('AC-P20: refuses write_file with NO toolPolicy supplied (--no-skills)', async () => {
    // The regression this pins: `createBuiltinTools` used to end with a single
    // `if (!options.toolPolicy) return tools;`, which sits BEFORE the plan gate.
    // `--no-skills` / `ARAGON_SKILLS=0` supply no decision provider, so that
    // return fired and the session ran with write_file live under a PLAN badge.
    const tools = byName(
      createBuiltinTools({ getCwd: () => dir, agentMode: () => 'plan' }),
    );
    const result = await tools.write_file!.execute(
      '1',
      { path: 'should-not-exist.txt', content: 'x' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Plan mode is active');
  });

  it('names read-only alternatives so a refusal is actionable', async () => {
    const tools = byName(createBuiltinTools({ getCwd: () => dir, agentMode: () => 'plan' }));
    const result = await tools.bash!.execute('1', { command: 'git status' }, ctx);
    expect(text(result)).toContain('read_file');
    expect(text(result)).toContain('grep');
    // bash is refused WHOLESALE, git status included, and the message says so:
    // a gate that is right 95% of the time is worse than one that is always
    // right, because the user stops trusting the badge.
    expect(text(result)).toContain('git status');
  });

  it('lets the read-only tools through untouched', async () => {
    const spy = spyTool('read_file');
    const tools = byName(
      createBuiltinTools({
        getCwd: () => dir,
        skillTools: [spy.tool],
        agentMode: () => 'plan',
      }),
    );
    await tools.read_file!.execute('1', {}, ctx);
    expect(spy.calls()).toBe(1);
  });
});

describe('I-P4 - build mode blocks nothing but submit_plan', () => {
  it('runs all five mutating tools', async () => {
    const spies = [...PLAN_MODE_BLOCKED_TOOLS].map((name) => spyTool(name));
    const tools = byName(
      createBuiltinTools({
        getCwd: () => dir,
        skillTools: spies.map((s) => s.tool),
        agentMode: () => 'build',
      }),
    );
    for (const [i, name] of [...PLAN_MODE_BLOCKED_TOOLS].entries()) {
      await tools[name]!.execute('1', {}, ctx);
      expect(spies[i]!.calls(), name).toBe(1);
    }
  });

  it('refuses submit_plan, and does NOT refuse ask_user', async () => {
    // The asymmetry is intentional: a clarifying question is never harmful, and
    // refusing a tool the model can see just burns a turn. `submit_plan` mutates
    // the session mode and only means something while a plan is under review.
    const ask = spyTool('ask_user');
    const submit = spyTool('submit_plan');
    const tools = byName(
      createBuiltinTools({
        getCwd: () => dir,
        planTools: [ask.tool, submit.tool],
        agentMode: () => 'build',
      }),
    );

    await tools.ask_user!.execute('1', {}, ctx);
    expect(ask.calls()).toBe(1);

    const refused = await tools.submit_plan!.execute('2', {}, ctx);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('only available in Plan mode');
    expect(submit.calls()).toBe(0);
  });
});

describe('I-P2 - the gate reads the mode at CALL time', () => {
  it('follows a mid-run flip without rebuilding the tool array', async () => {
    // This is why the tools are registered ONCE per session: `submit_plan`
    // mutates the mode from inside a tool execution, and rebuilding the array
    // there would mutate the live registry mid-iteration.
    let mode: AgentMode = 'plan';
    const tools = byName(createBuiltinTools({ getCwd: () => dir, agentMode: () => mode }));

    const before = await tools.bash!.execute('1', { command: 'node -e ""' }, ctx);
    expect(before.isError).toBe(true);

    mode = 'build';
    const after = await tools.bash!.execute('2', { command: 'node -e "console.log(1)"' }, ctx);
    expect(after.isError).toBeFalsy();
  });

  it('adding agentMode alone keeps the seven names and their order', () => {
    const bare = createBuiltinTools({ getCwd: () => dir }).map((t) => t.name);
    const gated = createBuiltinTools({ getCwd: () => dir, agentMode: () => 'build' }).map(
      (t) => t.name,
    );
    expect(gated).toEqual(bare);
    expect(gated).toHaveLength(7);
  });

  it('omitting BOTH options leaves the caller-supplied tool untouched by identity', () => {
    // The AC-G17 proof, re-asserted for the new guard: it is now "two guards
    // both declined" rather than "one early return fired".
    const sentinel = spyTool('sentinel').tool;
    const tools = createBuiltinTools({ getCwd: () => dir, skillTools: [sentinel] });
    expect(tools[tools.length - 1]).toBe(sentinel);
  });
});
