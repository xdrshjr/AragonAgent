/**
 * Interrupts (cli-integration-surface section 3.6 / AC-18 / P0-1 / D-15 /
 * R-15).
 *
 * BOTH HALVES ARE ASSERTED, AND THE FIRST ALONE IS NOT ENOUGH. A stubbed
 * controller will happily produce the right `result` from a design that cannot
 * work: the first draft of this feature had exec add its own
 * `process.on('SIGINT')`, which `logging/install.ts` beats to the punch on every
 * platform (its listener is registered first and its default terminator exits),
 * so the process would vanish with NO `result` line. That is exactly the failure
 * a wrapper cannot distinguish from a hang.
 *
 * So: the mechanism (zero new `process.on('SIGINT')` registrations, behaviour
 * installed through `setSignalTerminator`) is asserted alongside the outcome.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';
import process from 'node:process';
import {
  installLogging,
  resetProcessHooksForTest,
  setSignalTerminator,
  type ProcessHookPort,
} from '../logging/install.js';
import { resetLoggerForTest } from '../logging/logger.js';
import { ExecRunner, type ExecRunnerController } from '../exec/runner.js';
import { StreamJsonEmitter } from '../exec/emitter.js';
import type { ExecEvent } from '../exec/events.js';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'M',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  supportsThinking: false,
  supportsTools: true,
  supportsImages: false,
  cost: { input: 0, output: 0 },
};

interface StubPort extends ProcessHookPort {
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
}

function stubPort(): StubPort {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    listeners,
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    exit(): never {
      throw new Error('the stub port must not be the exit path in these cases');
    },
    stderr: { write: () => true },
  };
}

function fire(port: StubPort, signal: string): void {
  for (const listener of port.listeners.get(signal) ?? []) listener();
}

function sink(): { stream: NodeJS.WritableStream; lines: () => ExecEvent[] } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ExecEvent),
  };
}

/** A controller whose `prompt()` settles only once it has been aborted. */
function makeStub(): { controller: ExecRunnerController; aborts: () => number } {
  const listeners: ((e: AgentEvent) => void)[] = [];
  let aborted = 0;
  let settle: (() => void) | null = null;
  // An abort can legitimately arrive BEFORE `prompt()` is called - the runner
  // awaits its prompt source first - and a stub that only settled a live promise
  // would hang the case rather than reporting one.
  let abortedEarly = false;
  const controller: ExecRunnerController = {
    preflight: () => ({ ok: true }),
    subscribe: (l) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getModelInfo: () => MODEL,
    abort: () => {
      aborted += 1;
      // The engine settles normally after an abort, exactly as `Esc` does.
      for (const l of listeners) l({ type: 'agent_end', messages: [] } as AgentEvent);
      if (settle) settle();
      else abortedEarly = true;
    },
    prompt: () =>
      new Promise<void>((resolve) => {
        if (abortedEarly) resolve();
        else settle = resolve;
      }),
  };
  return { controller, aborts: () => aborted };
}

/** Let the runner reach `controller.prompt()` before the signal arrives. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

let exits: number[] = [];

beforeEach(() => {
  resetProcessHooksForTest();
  exits = [];
});

afterEach(() => {
  resetLoggerForTest();
  resetProcessHooksForTest();
});

describe('AC-18 / P0-1: the mechanism', () => {
  it('adds ZERO process.on(SIGINT) listeners of its own', () => {
    // THE HALF THAT THE BROKEN DESIGN WOULD HAVE FAILED. Counted on the REAL
    // process, because that is where a stray `process.on('SIGINT')` would land.
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const out = sink();
    const { controller } = makeStub();
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);
    expect(process.listenerCount('SIGINT')).toBe(before);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    runner.detach();
  });

  it('installs its behaviour through the replaceable terminator', () => {
    const port = stubPort();
    installLogging({ argv: ['--no-log-file'], processPort: port });
    const out = sink();
    const { controller, aborts } = makeStub();
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);

    // Fired through `installLogging`'s OWN listener, which is the only one that
    // exists. Without the terminator swap this would take the default path and
    // exit(130) before exec could settle anything.
    fire(port, 'SIGINT');
    expect(aborts()).toBe(1);
    expect(exits).toEqual([]);
    expect(runner.stats().stopReason).toBe('interrupted');
    runner.detach();
  });
});

describe('AC-18: the outcome', () => {
  it('settles, emits `result` with stopReason interrupted, and exits 130', async () => {
    const port = stubPort();
    installLogging({ argv: ['--no-log-file'], processPort: port });
    const out = sink();
    const { controller } = makeStub();
    const emitter = new StreamJsonEmitter(out.stream);
    const runner = new ExecRunner({
      emitter,
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);

    let served = 0;
    const promise = runner.run({ next: async () => (served++ === 0 ? 'go' : null) });
    await tick();
    fire(port, 'SIGINT');
    await promise;
    runner.detach();

    expect(runner.stats().stopReason).toBe('interrupted');
    expect(runner.exitCode()).toBe(130);
    // The guarantee wrappers care about most: a `result` reaches stdout, so a
    // parent reading NDJSON does not have to time out to learn the run ended.
    emitter.result({
      sessionId: 's1',
      isError: false,
      stopReason: runner.stats().stopReason,
      exitCode: runner.exitCode(),
      result: '',
      turns: 0,
      durationMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cost: { amount: 0, currency: 'USD', known: false },
      model: { provider: 'anthropic', id: 'm' },
      todos: null,
      error: null,
    });
    const last = out.lines().at(-1) as { type: string; stopReason: string; exitCode: number };
    expect(last.type).toBe('result');
    expect(last.stopReason).toBe('interrupted');
    expect(last.exitCode).toBe(130);
  });

  it('P1-11: SIGTERM takes the same path and exits 143, not 130', () => {
    // `logging/install.ts` holds `SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15,
    // SIGHUP: 1 }` and has always exited `128 + signo`. Reporting a flat 130
    // would be either a lie in the JSON or an unannounced change to a convention
    // every shell already understands.
    const port = stubPort();
    installLogging({ argv: ['--no-log-file'], processPort: port });
    const out = sink();
    const { controller } = makeStub();
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);
    fire(port, 'SIGTERM');
    expect(runner.stats().stopReason).toBe('interrupted');
    expect(runner.exitCode()).toBe(143);
    runner.detach();
  });

  it('SIGHUP exits 129', () => {
    const port = stubPort();
    installLogging({ argv: ['--no-log-file'], processPort: port });
    const out = sink();
    const { controller } = makeStub();
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);
    fire(port, 'SIGHUP');
    expect(runner.exitCode()).toBe(129);
    runner.detach();
  });
});

describe('the escapes that make "return without exiting" safe', () => {
  it('a second signal within 2s exits immediately', () => {
    const port = stubPort();
    installLogging({ argv: ['--no-log-file'], processPort: port });
    const out = sink();
    const { controller } = makeStub();
    let clock = 1000;
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      now: () => clock,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);
    fire(port, 'SIGINT');
    expect(exits).toEqual([]);
    clock += 500;
    fire(port, 'SIGINT');
    expect(exits).toEqual([130]);
    runner.detach();
  });

  it('a signal after detach() exits immediately, so Ctrl-C is never a no-op', () => {
    // A terminator that returns and then never exits turns Ctrl-C into "nothing
    // happens" - merely HAVING a signal listener stops Node terminating by
    // default. After `detach()` there is nothing left to settle.
    const port = stubPort();
    installLogging({ argv: ['--no-log-file'], processPort: port });
    const out = sink();
    const { controller } = makeStub();
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: setSignalTerminator, exit: (c) => exits.push(c) },
    });
    runner.attach(controller);
    runner.detach();
    fire(port, 'SIGINT');
    expect(exits).toEqual([130]);
  });
});
