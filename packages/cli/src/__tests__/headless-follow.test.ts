/**
 * The headless continuation loop (todo-plan-followthrough §3.6 / AC-23..AC-27,
 * AC-37).
 *
 * `-p` IS THE ENVIRONMENT WITH NO HUMAN TO PRESS ESC, which is why the counters
 * rather than the grace window are the protection here — and why AC-37 exists
 * at all. v1 put the `used` increment only in the TUI's timer, which left `-p`
 * uncapped while every sentence in the design said otherwise (P1-2).
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';
import { runHeadless, type HeadlessController } from '../agent/headless.js';
import { TODO_FOLLOW_LIMITS } from '../todo/limits.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

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

function sink(): { write: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    write: {
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

function snapshot(total: number, doneCount: number): TodoSnapshot {
  const items: TodoItem[] = Array.from({ length: total }, (_, i) => ({
    content: `step ${i + 1}`,
    activeForm: `doing ${i + 1}`,
    status: i < doneCount ? 'completed' : i === doneCount ? 'in_progress' : 'pending',
  }));
  return {
    items,
    total,
    doneCount,
    activeIndex: doneCount < total ? doneCount : -1,
    updatedAt: 0,
  };
}

interface StubOptions {
  /** Called per iteration; return the snapshot the run left behind. */
  onRun?: (call: number, emit: (e: AgentEvent) => void) => TodoSnapshot | null;
  /** Omit `getTodoSnapshot` entirely (AC-23). */
  noSnapshotMember?: boolean;
}

function makeStub(options: StubOptions = {}): {
  controller: HeadlessController;
  prompts: string[];
} {
  const listeners: ((e: AgentEvent) => void)[] = [];
  const emit = (e: AgentEvent): void => {
    for (const l of listeners) l(e);
  };
  const prompts: string[] = [];
  let current: TodoSnapshot | null = null;

  const base = {
    preflight: () => ({ ok: true as const }),
    subscribe: (l: (e: AgentEvent) => void) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getModelInfo: () => MODEL,
    prompt: async (text: string) => {
      prompts.push(text);
      const call = prompts.length;
      if (options.onRun) {
        current = options.onRun(call, emit);
      } else {
        emit({ type: 'agent_start' } as AgentEvent);
        emit({
          type: 'turn_end',
          message: { role: 'assistant', content: [] },
          usage: { inputTokens: 1, outputTokens: 1 },
        } as AgentEvent);
        emit({ type: 'agent_end', messages: [] } as AgentEvent);
      }
    },
  };

  const controller: HeadlessController = options.noSnapshotMember
    ? base
    : { ...base, getTodoSnapshot: () => current };
  return { controller, prompts };
}

/** The default healthy run: one turn_end, one agent_end, no error. */
function healthyRun(emit: (e: AgentEvent) => void): void {
  emit({ type: 'agent_start' } as AgentEvent);
  emit({
    type: 'turn_end',
    message: { role: 'assistant', content: [] },
    usage: { inputTokens: 1, outputTokens: 1 },
  } as AgentEvent);
  emit({ type: 'agent_end', messages: [] } as AgentEvent);
}

describe('AC-23: an absent `getTodoSnapshot` keeps `-p` byte-identical to today', () => {
  it('prompts exactly once and writes no [todo] line', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({ noSnapshotMember: true });
    const code = await runHeadless(controller, 'hi', {
      stderr: err.write,
      followThrough: 'auto',
    });
    expect(code).toBe(0);
    expect(prompts).toEqual(['hi']);
    expect(err.text()).not.toContain('[todo]');
  });

  it('is equally inert when the member exists but the list is null', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (_call, emit) => {
        healthyRun(emit);
        return null;
      },
    });
    await runHeadless(controller, 'hi', { stderr: err.write, followThrough: 'auto' });
    expect(prompts).toHaveLength(1);
    expect(err.text()).not.toContain('[todo]');
  });
});

describe('AC-24: `auto` re-prompts with the enumerated message', () => {
  it('continues until the plan is finished, then stops', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (call, emit) => {
        healthyRun(emit);
        // One step completed per run: 0 -> 1 -> 2 -> 3 of 3.
        return snapshot(3, Math.min(call, 3));
      },
    });
    const code = await runHeadless(controller, 'go', {
      stderr: err.write,
      followThrough: 'auto',
    });
    expect(code).toBe(0);
    expect(prompts).toHaveLength(3);
    // The continuation ENUMERATES rather than referring (D-11).
    expect(prompts[1]).toContain('These steps are not done yet:');
    expect(prompts[1]).toContain('2. step 2');
    expect(prompts[1]).not.toBe('Continue with the remaining todo items.');
    expect(err.text()).toContain('[todo] continuing (2 steps left)');
  });

  it('`notify` writes one line and does NOT re-prompt', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (_call, emit) => {
        healthyRun(emit);
        return snapshot(4, 1);
      },
    });
    await runHeadless(controller, 'go', { stderr: err.write, followThrough: 'notify' });
    expect(prompts).toHaveLength(1);
    expect(err.text()).toContain('[todo] 3 steps unfinished');
  });

  it('`off` writes nothing and does not re-prompt', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (_call, emit) => {
        healthyRun(emit);
        return snapshot(4, 1);
      },
    });
    await runHeadless(controller, 'go', { stderr: err.write, followThrough: 'off' });
    expect(prompts).toHaveLength(1);
    expect(err.text()).not.toContain('[todo]');
  });

  it('defaults to `notify` when the option is omitted', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (_call, emit) => {
        healthyRun(emit);
        return snapshot(4, 1);
      },
    });
    await runHeadless(controller, 'go', { stderr: err.write });
    expect(prompts).toHaveLength(1);
  });
});

describe('AC-37: the total cap binds in `-p` (P1-2)', () => {
  it('stops at maxAutoContinuesPerList prompts and names the cap on stderr', async () => {
    const err = sink();
    // A model that never finishes the plan AND re-scopes it every turn, which
    // is the scenario that defeated v1's economy in both modes.
    const { controller, prompts } = makeStub({
      onRun: (call, emit) => {
        healthyRun(emit);
        return snapshot(call % 2 === 0 ? 5 : 6, 0);
      },
    });
    const code = await runHeadless(controller, 'go', {
      stderr: err.write,
      followThrough: 'auto',
    });
    // The first prompt is the user's; the cap counts CONTINUATIONS.
    expect(prompts).toHaveLength(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList + 1);
    expect(err.text()).toContain(String(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList));
    // AC-27: an unfinished plan alone never changes the exit code.
    expect(code).toBe(0);
  });

  it('hands back after `maxNoProgressContinues` fruitless attempts', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (_call, emit) => {
        healthyRun(emit);
        return snapshot(4, 1); // never moves, and never re-plans
      },
    });
    await runHeadless(controller, 'go', { stderr: err.write, followThrough: 'auto' });
    expect(prompts).toHaveLength(TODO_FOLLOW_LIMITS.maxNoProgressContinues + 1);
    expect(err.text()).toContain('completed none of them');
  });
});

describe('AC-25: the per-iteration `sawTurnEnd` reset', () => {
  it('a swallowed throw on iteration 2 still sets exit code 1', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (call, emit) => {
        if (call === 1) {
          healthyRun(emit);
          return snapshot(3, 0);
        }
        // Iteration 2 produces NO turn_end — a swallowed throw. Left sticky,
        // iteration 1's flag would hide it and this run would exit 0.
        emit({ type: 'agent_start' } as AgentEvent);
        emit({ type: 'agent_end', messages: [] } as AgentEvent);
        return snapshot(3, 0);
      },
    });
    const code = await runHeadless(controller, 'go', {
      stderr: err.write,
      followThrough: 'auto',
    });
    expect(prompts).toHaveLength(2);
    expect(code).toBe(1);
  });

  it('an errored run ends the loop with a warn line, never a continuation (D-6)', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (_call, emit) => {
        emit({ type: 'agent_start' } as AgentEvent);
        emit({
          type: 'message_update',
          streamEvent: { type: 'error', error: new Error('401 unauthorized') },
        } as AgentEvent);
        emit({ type: 'agent_end', messages: [] } as AgentEvent);
        return snapshot(3, 0);
      },
    });
    const code = await runHeadless(controller, 'go', {
      stderr: err.write,
      followThrough: 'auto',
    });
    expect(prompts).toHaveLength(1);
    expect(code).toBe(1);
    expect(err.text()).toContain('ended with an error');
  });
});

describe('AC-26: --quiet suppresses every [todo] line, including the new ones', () => {
  it('writes nothing to stderr while still continuing', async () => {
    const err = sink();
    const { controller, prompts } = makeStub({
      onRun: (call, emit) => {
        healthyRun(emit);
        return snapshot(3, Math.min(call, 3));
      },
    });
    await runHeadless(controller, 'go', {
      stderr: err.write,
      quiet: true,
      followThrough: 'auto',
    });
    expect(prompts).toHaveLength(3);
    expect(err.text()).not.toContain('[todo]');
  });
});

describe('§3.6 rule 4: the unsubscribes stay OUTSIDE the loop', () => {
  it('iteration 2 still reaches the subscriber that computes `errored`', async () => {
    // Unsubscribing per iteration would silently cost iteration 2 onwards its
    // progress lines, its usage accounting and — worst — the `agent_end` handler
    // that computes `errored`, so a failing second iteration would exit 0. The
    // AC-25 case above is the proof; this one pins the usage side of it.
    const err = sink();
    const { controller } = makeStub({
      onRun: (call, emit) => {
        healthyRun(emit);
        return snapshot(3, Math.min(call, 3));
      },
    });
    await runHeadless(controller, 'go', { stderr: err.write, followThrough: 'auto' });
    // Three runs at 1 in / 1 out each; a per-iteration unsubscribe would report 1.
    expect(err.text()).toContain('in 3');
  });
});
