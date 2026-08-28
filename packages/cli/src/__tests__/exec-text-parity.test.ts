/**
 * AC-1 - the load-bearing claim of the whole feature
 * (cli-integration-surface D-1 / R-1).
 *
 * "THE HUMAN CLI DOES NOT CHANGE" IS EITHER A FACT ANYONE CAN CHECK OR AN
 * ARGUMENT SOMEONE HAS TO TRUST, and this file is what makes it the first.
 * `--output-format text` DELEGATES to `runHeadless` verbatim rather than
 * reimplementing text rendering inside an emitter, so the two cannot drift the
 * first time a retry line changes - and BOTH streams are compared, because
 * stderr is where `-p` puts the tool trace, the `[todo]` lines, the retry
 * notices and the `[usage]` footer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';
import { runHeadless } from '../agent/headless.js';
import { runExec } from '../exec/index.js';
import type { AgentController } from '../agent/controller.js';
import { getSessionsDir } from '../config/app-paths.js';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'M',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  supportsThinking: false,
  supportsTools: true,
  supportsImages: false,
  cost: { input: 3, output: 15 },
};

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

/**
 * The SAME script on both sides.
 *
 * A text delta, a tool pair, a retry notice and a turn: between them they
 * exercise every writer `runHeadless` has, which is what makes byte equality a
 * meaningful claim rather than a comparison of two empty strings.
 */
function script(emit: (e: AgentEvent) => void): void {
  emit({ type: 'agent_start' } as AgentEvent);
  emit({
    type: 'message_update',
    streamEvent: {
      type: 'retry_scheduled',
      attempt: 1,
      maxRetries: 3,
      delayMs: 2000,
      resumeAt: 0,
      errorType: 'overloaded',
      message: 'busy',
    },
  } as AgentEvent);
  emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read_file', args: {} } as AgentEvent);
  emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'read_file',
    result: { content: [{ type: 'text', text: 'ok' }] },
    isError: false,
    duration: 11,
  } as AgentEvent);
  emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Hello ' } } as AgentEvent);
  emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'world' } } as AgentEvent);
  emit({
    type: 'turn_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    usage: { inputTokens: 120, outputTokens: 40 },
  } as AgentEvent);
  emit({ type: 'agent_end', messages: [] } as AgentEvent);
}

/** A stub broad enough for BOTH `runHeadless` and `runExec`'s wiring. */
function makeStub(): AgentController {
  const listeners: ((e: AgentEvent) => void)[] = [];
  const stub = {
    preflight: () => ({ ok: true }),
    subscribe: (l: (e: AgentEvent) => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getModelInfo: () => MODEL,
    getTodoSnapshot: () => null,
    getTodoConfig: () => ({ followThrough: 'notify' as const }),
    getConfig: () => ({ provider: 'anthropic', model: 'm', baseUrl: undefined }),
    getCwd: () => process.cwd(),
    getMessages: () => [],
    replaceMessages: () => {},
    restoreTodos: () => {},
    listTools: () => [{ name: 'read_file' }],
    isPricedModel: () => true,
    abort: () => {},
    dispose: () => {},
    prompt: async () => {
      for (const l of [...listeners]) script((e) => l(e));
    },
  };
  return stub as unknown as AgentController;
}

afterEach(() => {
  // Only the directory this process created under `os.tmpdir()`; the
  // test-isolation contract in `app-paths.ts` forbids deleting a returned path
  // that could be the developer's real home, and the VITEST branch guarantees
  // this one is not.
  rmSync(getSessionsDir(), { recursive: true, force: true });
});

describe('AC-1: --output-format text is byte-identical to runHeadless', () => {
  it('on stdout AND on stderr, for the same script', async () => {
    const headlessOut = sink();
    const headlessErr = sink();
    const headlessCode = await runHeadless(makeStub(), 'do the thing', {
      quiet: false,
      followThrough: 'notify',
      stdout: headlessOut.stream,
      stderr: headlessErr.stream,
    });

    const execOut = sink();
    const execErr = sink();
    const execCode = await runExec(
      {},
      { outputFormat: 'text', saveSession: false },
      'do the thing',
      {
        version: '0.6.0',
        makeController: () => makeStub(),
        stdout: execOut.stream,
        stderr: execErr.stream,
      },
    );

    expect(execOut.text()).toBe(headlessOut.text());
    expect(execErr.text()).toBe(headlessErr.text());
    expect(execCode).toBe(headlessCode);
    // And the comparison is not vacuous: both actually wrote something.
    expect(headlessOut.text()).toContain('Hello world');
    expect(headlessErr.text()).toContain('[usage]');
  });

  it('holds under --quiet as well', async () => {
    const headlessOut = sink();
    const headlessErr = sink();
    await runHeadless(makeStub(), 'x', {
      quiet: true,
      followThrough: 'notify',
      stdout: headlessOut.stream,
      stderr: headlessErr.stream,
    });

    const execOut = sink();
    const execErr = sink();
    await runExec({}, { outputFormat: 'text', saveSession: false, quiet: true }, 'x', {
      version: '0.6.0',
      makeController: () => makeStub(),
      stdout: execOut.stream,
      stderr: execErr.stream,
    });

    expect(execOut.text()).toBe(headlessOut.text());
    expect(execErr.text()).toBe(headlessErr.text());
    // `--quiet` suppresses the tool and usage lines but never the retry notice:
    // a three-minute pause with no explanation is not a compact run, it is a hang.
    expect(headlessErr.text()).toContain('[retry 1/3]');
    expect(headlessErr.text()).not.toContain('[usage]');
  });

  it('and the session is still written when saving is on', async () => {
    // Text mode does not forfeit continuity: save and resume happen OUTSIDE the
    // run, which is why the session flags are supported in every format.
    const out = sink();
    const err = sink();
    const code = await runExec({}, { outputFormat: 'text', sessionId: 'parity-1' }, 'x', {
      version: '0.6.0',
      makeController: () => makeStub(),
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    const { listSessions } = await import('../session/store.js');
    expect(listSessions().map((s) => s.id)).toContain('parity-1');
  });
});
