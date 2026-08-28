/**
 * W2 — an abort is always answerable (§7.3 / AC-21..AC-23).
 *
 * THE INVARIANT BEING PROTECTED IS "AN ABORT IS ALWAYS ANSWERABLE", AND AN
 * INVARIANT THAT DEPENDS ON EVERY TOOL AUTHOR REMEMBERING IS NOT AN INVARIANT
 * (D-7). The shipped `bash` is well-behaved after W1; this suite is about the
 * NEXT long-running tool, which nobody has written yet.
 */

import { describe, expect, it } from 'vitest';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { textResult } from '../tools/helpers.js';
import type { AgentTool, ToolExecutionContext } from '../tools/types.js';

function registryWith(tool: AgentTool): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool);
  return registry;
}

const schema = { type: 'object', properties: {} } as const;

/**
 * A latch a tool opens from inside `execute`.
 *
 * WAITED ON RATHER THAN A FIXED SLEEP, and that matters: the executor
 * short-circuits a signal that is ALREADY aborted at step 4
 * (`Execution aborted before start`), which is a different, pre-existing path
 * from the race being asserted here. A timed `tick` picks the wrong path
 * whenever the machine is loaded enough that parameter validation has not
 * finished yet - a flake that appears only under a full parallel suite and never
 * when the file is run alone.
 */
function latch(): { started: Promise<void>; open: () => void } {
  let open = (): void => {};
  const started = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { started, open };
}

describe('ToolExecutor abort race', () => {
  it('AC-21: a tool whose promise NEVER settles is abandoned within the grace', async () => {
    const gate = latch();
    // Before this race, `execute` was a bare `await tool.execute(...)`: the
    // signal was delivered, the tool was free to ignore it, and the loop waited
    // forever - so "press Esc to stop" did nothing at all in exactly the
    // situation where a user most needs it.
    const hung: AgentTool = {
      name: 'hang',
      label: 'hang',
      description: 'never settles',
      parameters: schema,
      execute: () => {
        gate.open();
        return new Promise<never>(() => {});
      },
    };
    const executor = new ToolExecutor(registryWith(hung), { abortGraceMs: 120 });
    const controller = new AbortController();
    const started = Date.now();
    const promise = executor.execute('1', 'hang', {}, controller.signal);
    await gate.started;
    controller.abort();
    const outcome = await promise;
    expect(outcome.isError).toBe(true);
    expect(outcome.result.content[0]).toMatchObject({
      text: expect.stringContaining('did not stop within 120ms of abort'),
    });
    // The grace is a CEILING, not a delay to sit through on every abort.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('AC-22: a tool that settles DURING the grace returns its own result', async () => {
    const gate = latch();
    // R-5: `abortGraceMs` is 2.5x `bash`'s own kill grace precisely so a
    // slow-but-correct unwind is not mistaken for a hang.
    const polite: AgentTool = {
      name: 'polite',
      label: 'polite',
      description: 'settles on abort',
      parameters: schema,
      execute: (_id, _params, ctx: ToolExecutionContext) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            setTimeout(() => resolve(textResult('cleaned up')), 20);
          });
          gate.open();
        }),
    };
    const executor = new ToolExecutor(registryWith(polite), { abortGraceMs: 500 });
    const controller = new AbortController();
    const promise = executor.execute('2', 'polite', {}, controller.signal);
    await gate.started;
    controller.abort();
    const outcome = await promise;
    expect(outcome.isError).toBe(false);
    expect(outcome.result.content[0]).toMatchObject({ text: 'cleaned up' });
  });

  it('publishes the abort CAUSE on the context, before the tool reacts', async () => {
    // P1-5. The executor already distinguishes a timeout from an external abort
    // - `TIMEOUT_REASON` is its own private symbol - but a tool could not read
    // it, because the symbol is not exported and must not be. Publishing the
    // cause keeps the frozen export surface intact while letting `bash` write
    // an honest footer.
    const seen: Array<string | undefined> = [];
    let gate: ReturnType<typeof latch> | undefined;
    const observer: AgentTool = {
      name: 'observe',
      label: 'observe',
      description: 'records the cause',
      parameters: schema,
      execute: (_id, _params, ctx: ToolExecutionContext) =>
        new Promise((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            seen.push(ctx.abortCause);
            resolve(textResult('done'));
          });
          gate?.open();
        }),
    };

    const external = new ToolExecutor(registryWith(observer), { abortGraceMs: 500 });
    const controller = new AbortController();
    gate = latch();
    const promise = external.execute('3', 'observe', {}, controller.signal);
    await gate.started;
    controller.abort();
    await promise;
    expect(seen).toEqual(['external']);

    seen.length = 0;
    gate = undefined;
    const ceiling = new ToolExecutor(registryWith(observer), {
      abortGraceMs: 500,
      defaultTimeout: 30,
    });
    await ceiling.execute('4', 'observe', {}, undefined);
    expect(seen).toEqual(['timeout']);
  });

  it('a tool that settles NORMALLY is untouched by the race', async () => {
    // The byte-identity claim for every existing path: with no abort, the race
    // has one branch that never resolves and one that returns the tool's own
    // result.
    const plain: AgentTool = {
      name: 'plain',
      label: 'plain',
      description: 'ordinary',
      parameters: schema,
      execute: async () => textResult('ok'),
    };
    const executor = new ToolExecutor(registryWith(plain));
    const outcome = await executor.execute('5', 'plain', {});
    expect(outcome.isError).toBe(false);
    expect(outcome.result.content[0]).toMatchObject({ text: 'ok' });
  });

  it('a REJECTING tool still reports its own error, not an abandonment', async () => {
    // The race maps both settlements to values so a rejection cannot reject the
    // race itself and skip the cleanup `finally`; this pins that the mapping
    // does not swallow the error on the way.
    const thrower: AgentTool = {
      name: 'throws',
      label: 'throws',
      description: 'rejects',
      parameters: schema,
      execute: async () => {
        throw new Error('boom');
      },
    };
    const executor = new ToolExecutor(registryWith(thrower));
    const outcome = await executor.execute('6', 'throws', {});
    expect(outcome.isError).toBe(true);
    expect(outcome.result.content[0]).toMatchObject({
      text: expect.stringContaining('boom'),
    });
  });

  it('an abandoned tool that later REJECTS does not become an unhandled rejection', async () => {
    // In a host that routes `unhandledRejection` to a fatal handler - which this
    // CLI does - a successfully-abandoned tool would otherwise become a process
    // exit some seconds after the user's abort appeared to work.
    const gate = latch();
    let rejectLater: ((err: Error) => void) | undefined;
    const late: AgentTool = {
      name: 'late',
      label: 'late',
      description: 'rejects after abandonment',
      parameters: schema,
      execute: () =>
        new Promise((_resolve, reject) => {
          rejectLater = reject;
          gate.open();
        }),
    };
    const executor = new ToolExecutor(registryWith(late), { abortGraceMs: 50 });
    const controller = new AbortController();
    const promise = executor.execute('7', 'late', {}, controller.signal);
    await gate.started;
    controller.abort();
    const outcome = await promise;
    expect(outcome.isError).toBe(true);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    rejectLater?.(new Error('too late'));
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });
});
