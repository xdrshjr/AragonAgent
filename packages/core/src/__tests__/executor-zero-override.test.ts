/**
 * `timeoutOverrides: 0` — no ceiling for that tool (team-subagent parity).
 *
 * A `0` override previously reached `setTimeout(fn, 0)` and aborted the tool
 * immediately. It now arms NO timer: the tool runs until it settles or an
 * external abort arrives. The CLI's `task` fan-out is the caller this exists
 * for - its duration is the max of its subagents, which the host may
 * deliberately leave unbounded (`team.dispatchTimeoutMs: 0`).
 *
 * THE EXECUTOR'S TIMEOUT IS COOPERATIVE (see API.md, "Blocking on a human"):
 * the ceiling aborts the context signal and keeps awaiting, so only a
 * signal-aware tool can be timed out at all. Both "bites" tests below
 * therefore listen to `ctx.signal`, exactly as `task` does.
 */

import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { textResult } from '../tools/helpers.js';
import type { AgentTool } from '../tools/types.js';

const schema = { type: 'object', properties: {} } as const;

/** A latch a tool opens from inside `execute`, so an abort is never "before start". */
function latch(): { started: Promise<void>; open: () => void } {
  let open = (): void => {};
  const started = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { started, open };
}

/** A signal-aware tool that resolves 'aborted' the moment the ceiling fires. */
function signalAwareTool(): { tool: AgentTool; started: Promise<void> } {
  const gate = latch();
  const tool: AgentTool = {
    name: 'slow',
    label: 'slow',
    description: 'honours the abort signal',
    parameters: schema,
    execute: (_id, _params, ctx) =>
      new Promise((resolve) => {
        gate.open();
        ctx.signal?.addEventListener(
          'abort',
          () => resolve(textResult('aborted')),
          { once: true },
        );
      }),
  };
  return { tool, started: gate.started };
}

describe('ToolExecutor zero override', () => {
  it('a `0` override arms no timer: a tool outlasting defaultTimeout succeeds', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow',
      label: 'slow',
      description: 'sleeps past the default ceiling',
      parameters: schema,
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return textResult('finished');
      },
    });
    const executor = new ToolExecutor(registry, {
      defaultTimeout: 60,
      timeoutOverrides: { slow: 0 },
    });
    const outcome = await executor.execute('1', 'slow', {});
    expect(outcome.isError).toBe(false);
    expect(outcome.result.content[0]).toMatchObject({ type: 'text', text: 'finished' });
  });

  it('control: without the override the same ceiling aborts a signal-aware tool', async () => {
    const { tool, started } = signalAwareTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, { defaultTimeout: 60 });
    const began = Date.now();
    const outcome = await executor.execute('1', 'slow', {});
    await started;
    // The tool observed the ceiling's abort well before its own 250 ms+ would
    // have elapsed - the only way a cooperative ceiling is observable.
    expect(Date.now() - began).toBeLessThan(240);
    expect(outcome.result.content[0]).toMatchObject({ type: 'text', text: 'aborted' });
  });

  it('a `0` override still honours an EXTERNAL abort', async () => {
    const { tool, started } = signalAwareTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, {
      defaultTimeout: 60,
      timeoutOverrides: { slow: 0 },
      abortGraceMs: 100,
    });
    const controller = new AbortController();
    const promise = executor.execute('1', 'slow', {}, controller.signal);
    await started;
    controller.abort();
    const outcome = await promise;
    expect(outcome.result.content[0]).toMatchObject({ type: 'text', text: 'aborted' });
  });
});
