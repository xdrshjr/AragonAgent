/**
 * The `fast_tier` exec event
 * (web-use-tier-cooperation-and-control-closure W2 / §4.2.1, cases 13-18).
 *
 * WHY THIS FILE EXISTS. Before this round `subscribeFast` forwarded exactly one
 * thing: a `review_end` that happened to carry TEXT. Everything else about the
 * fast tier — a review that failed, a tier the CLI switched off by itself after
 * three failures, a budget that ran out, whether delegation ever happened — never
 * left the process. A wrapper could only show what it had been CONFIGURED to do,
 * which is the most misleading thing an interface can show for a feature whose
 * whole failure mode is "it runs and nothing happens".
 *
 * The two assertions that carry the round:
 *
 *  · a `review_end` with NO text still produces a `fast_tier` (case 15) — that
 *    is the failure path, and it was the invisible one;
 *  · `controller.fastSnapshot?.()` returning `null` produces NOTHING (case 17) —
 *    a session with no tier has no business on this channel.
 */

import { describe, expect, it } from 'vitest';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';
import { ExecRunner, singlePrompt, type ExecRunnerController } from '../exec/runner.js';
import { StreamJsonEmitter } from '../exec/emitter.js';
import { EXEC_CAPABILITIES, EXEC_SCHEMA_VERSION, type ExecEvent } from '../exec/events.js';
import type { FastEvent, FastEventListener, FastReview, FastSnapshot } from '../fast/types.js';

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

function snapshot(over: Partial<FastSnapshot> = {}): FastSnapshot {
  return {
    live: true,
    selfDisabled: false,
    model: 'claude-haiku-4-5',
    sameAsMain: false,
    reviews: 2,
    reviewBudget: 10,
    budgetReached: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    pricingUnknown: false,
    inFlight: false,
    ...over,
  };
}

function review(over: Partial<FastReview> = {}): FastReview {
  return {
    index: 1,
    runId: 1,
    turn: 3,
    model: 'claude-haiku-4-5',
    kind: 'advice',
    text: 'you edited the same file three times',
    durationMs: 120,
    injected: true,
    ...over,
  };
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

/**
 * A controller that plays a scripted list of `FastEvent`s during its one turn.
 *
 * `fastSnapshot` is a function rather than a value so a case can make it return
 * `null` (case 17) or a different snapshot per emission.
 */
function makeStub(
  fastEvents: FastEvent[],
  fastSnapshot: () => FastSnapshot | null = () => snapshot(),
): ExecRunnerController {
  const listeners: ((e: AgentEvent) => void)[] = [];
  const fastListeners: FastEventListener[] = [];
  return {
    preflight: () => ({ ok: true }),
    subscribe: (l) => {
      listeners.push(l);
      return () => {};
    },
    subscribeFast: (l) => {
      fastListeners.push(l);
      return () => {};
    },
    fastSnapshot,
    getModelInfo: () => MODEL,
    abort: () => {},
    prompt: async () => {
      const emit = (e: AgentEvent): void => {
        for (const l of listeners) l(e);
      };
      emit({ type: 'agent_start' } as AgentEvent);
      emit({ type: 'turn_start' } as AgentEvent);
      for (const event of fastEvents) for (const l of fastListeners) l(event);
      emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      } as AgentEvent);
      emit({ type: 'agent_end', messages: [] } as AgentEvent);
    },
  };
}

async function run(
  fastEvents: FastEvent[],
  fastSnapshot?: () => FastSnapshot | null,
): Promise<ExecEvent[]> {
  const out = sink();
  const runner = new ExecRunner({
    emitter: new StreamJsonEmitter(out.stream),
    sessionId: 's1',
    quiet: true,
    signals: { setTerminator: () => {}, exit: () => {} },
  });
  runner.attach(makeStub(fastEvents, fastSnapshot));
  await runner.run(singlePrompt('hi'));
  runner.detach();
  return out.lines();
}

type TierLine = Extract<ExecEvent, { type: 'fast_tier' }>;

function tiers(lines: ExecEvent[]): TierLine[] {
  return lines.filter((e): e is TierLine => e.type === 'fast_tier');
}

describe('case 13 - tier_changed', () => {
  it('emits ONE fast_tier and no review sub-object', async () => {
    const lines = await run([{ type: 'tier_changed', snapshot: snapshot() }]);
    const t = tiers(lines);
    expect(t).toHaveLength(1);
    expect(t[0]!.review).toBeUndefined();
    expect(t[0]!.sessionId).toBe('s1');
    // Deprecated in schema v1 and pinned at 0: fast-tier children were
    // removed (every task child runs the lead's model), and the field
    // survives only so schema-v1 consumers keep parsing.
    expect(t[0]!.delegated).toBe(0);
    expect(lines.some((e) => e.type === 'fast_review')).toBe(false);
  });

  it('carries selfDisabled straight through, and it is INDEPENDENT of live', async () => {
    // The shape reality actually produces: the reviewer switched itself off, and
    // `live` — `registered && enabled && tier.ok` — did not move.
    //
    // THE SNAPSHOT COMES FROM THE FORWARDER, NOT FROM `event.snapshot`. That is
    // deliberate and both branches depend on it: `review_end` carries no
    // snapshot at all, so a second source would mean two code paths — and case
    // 17 ("a null snapshot emits nothing") is only expressible against the
    // forwarder. Upstream they are the same object anyway: the reviewer builds
    // its `tier_changed` from `deps.snapshot()`, which IS `wiring.snapshot()`.
    const live = snapshot({ live: true, selfDisabled: true, reviews: 3 });
    const lines = await run([{ type: 'tier_changed', snapshot: live }], () => live);
    const t = tiers(lines)[0]!;
    expect(t.selfDisabled).toBe(true);
    expect(t.live).toBe(true);
  });
});

describe('cases 14 / 15 - review_end', () => {
  it('case 14: a review WITH text produces BOTH fast_review and fast_tier', async () => {
    const lines = await run([{ type: 'review_end', review: review() }]);
    expect(lines.filter((e) => e.type === 'fast_review')).toHaveLength(1);
    const t = tiers(lines);
    expect(t).toHaveLength(1);
    expect(t[0]!.review).toEqual({
      index: 1,
      kind: 'advice',
      durationMs: 120,
      injected: true,
    });
  });

  it('case 15: a FAILED review produces ONLY fast_tier - the path that was invisible', async () => {
    const lines = await run([
      {
        type: 'review_end',
        review: review({ kind: 'failed', text: undefined, detail: 'no such model', injected: false }),
      },
    ]);
    expect(lines.some((e) => e.type === 'fast_review')).toBe(false);
    const t = tiers(lines);
    expect(t).toHaveLength(1);
    expect(t[0]!.review).toEqual({
      index: 1,
      kind: 'failed',
      detail: 'no such model',
      durationMs: 120,
      injected: false,
    });
  });
});

describe('cases 16 / 17 - what must NOT be emitted', () => {
  it('case 16: review_start emits nothing (inFlight already says it)', async () => {
    const lines = await run([{ type: 'review_start', index: 1, turn: 3 }]);
    expect(tiers(lines)).toHaveLength(0);
  });

  it('case 17: a null snapshot emits nothing, on either branch', async () => {
    const lines = await run(
      [
        { type: 'tier_changed', snapshot: snapshot() },
        { type: 'review_end', review: review() },
      ],
      () => null,
    );
    expect(tiers(lines)).toHaveLength(0);
    // …but the EXISTING `fast_review` still goes out: it does not depend on the
    // snapshot, and this round promised the old path stays byte-identical.
    expect(lines.filter((e) => e.type === 'fast_review')).toHaveLength(1);
  });

  it('a controller with no fastSnapshot at all (an older stub) emits nothing', async () => {
    const out = sink();
    const runner = new ExecRunner({
      emitter: new StreamJsonEmitter(out.stream),
      sessionId: 's1',
      quiet: true,
      signals: { setTerminator: () => {}, exit: () => {} },
    });
    const stub = makeStub([{ type: 'tier_changed', snapshot: snapshot() }]);
    delete (stub as { fastSnapshot?: unknown }).fastSnapshot;
    runner.attach(stub);
    await runner.run(singlePrompt('hi'));
    expect(tiers(out.lines())).toHaveLength(0);
  });
});

describe('the additive contract', () => {
  it('EXEC_SCHEMA_VERSION does not move for a new event type', () => {
    expect(EXEC_SCHEMA_VERSION).toBe(1);
  });

  it('EXEC_CAPABILITIES only APPENDS - `interrupt` stays first', () => {
    expect(EXEC_CAPABILITIES[0]).toBe('interrupt');
    expect(EXEC_CAPABILITIES).toContain('fast-policy');
    expect(EXEC_CAPABILITIES).toContain('fast-tier-events');
  });
});
