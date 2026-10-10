import { describe, expect, it } from 'vitest';
import { TeamOverseer, type OverseerProvider } from '../team/overseer.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { OverseerDecision, SubagentRun } from '../team/types.js';

/**
 * LOOKS VS ACTIONS (subagent-overseer-v2 D-5 / §7.1-3): cost and mutation
 * are separate ledgers. A look is spent by every inspection, including one
 * that failed softly; an action is spent only when the runtime APPLIES it
 * through the `note*` methods; a skipped label spends nothing.
 */

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

function run(label: string): SubagentRun {
  return {
    label,
    description: 'job',
    phase: 'thinking',
    turns: 0,
    toolCalls: 0,
    usage: { ...NO_USAGE },
    filesTouched: [],
    messagesSent: 0,
  };
}

function req(label: string) {
  return { run: run(label), messages: [], trigger: 'clock' as const, childAlive: true };
}

function countingProvider(script: {
  inspectResult?: () => OverseerDecision | Promise<OverseerDecision>;
  batchResult?: () => unknown;
}): { provider: OverseerProvider; state: { inspectCalls: number; batchCalls: number } } {
  const state = { inspectCalls: 0, batchCalls: 0 };
  return {
    state,
    provider: {
      active: () => true,
      inspect: async () => {
        state.inspectCalls += 1;
        return script.inspectResult?.() ?? { action: 'wait', reason: 'fine' };
      },
      inspectBatch: async (batch) => {
        state.batchCalls += 1;
        return (
          script.batchResult?.() ??
          batch.map((r) => ({ label: r.label, action: 'wait', reason: 'fine' }))
        );
      },
      usage: () => ({ ...NO_USAGE }),
    },
  };
}

describe('the look ledger (cost)', () => {
  it('a transport failure spends a LOOK but no ACTION budget (G-6)', async () => {
    const overseer = new TeamOverseer(
      {
        active: () => true,
        inspect: async () => {
          throw new Error('flaky transport');
        },
        inspectBatch: async () => {
          throw new Error('flaky transport');
        },
        usage: () => ({ ...NO_USAGE }),
      },
      { startedAt: Date.now() },
    );
    for (let i = 0; i < TEAM_LIMITS.overseerMaxLooksPerChild; i += 1) {
      const decision = await overseer.inspect(req('a1'));
      expect(decision?.action).toBe('wait');
    }
    // All looks spent on failures...
    expect(overseer.looksExhausted('a1')).toBe(true);
    // ...and not one action budget moved: every mutation is still available.
    expect(overseer.nudgesLeft('a1')).toBe(true);
    expect(overseer.replacementsLeft('a1')).toBe(true);
    expect(overseer.abandonsLeft('a1')).toBe(true);
    expect(overseer.calls()).toBe(TEAM_LIMITS.overseerMaxLooksPerChild);
  });

  it('per-child exhaustion is per-CHILD: other children keep their looks', async () => {
    const stub = countingProvider({});
    const overseer = new TeamOverseer(stub.provider, { startedAt: Date.now() });
    for (let i = 0; i < TEAM_LIMITS.overseerMaxLooksPerChild; i += 1) {
      await overseer.inspect(req('a1'));
    }
    expect(overseer.looksExhausted('a1')).toBe(true);
    expect(overseer.looksExhausted('a2')).toBe(false);
    const decision = await overseer.inspect(req('a2'));
    expect(decision?.action).toBe('wait');
  });

  it('the dispatch-wide total is the fool-proof product bound (R-P1-6)', () => {
    expect(TEAM_LIMITS.overseerMaxLooksPerDispatch).toBe(
      TEAM_LIMITS.hardMaxSubagents * TEAM_LIMITS.overseerMaxLooksPerChild,
    );
    expect(TEAM_LIMITS.overseerMaxLooksPerDispatch).toBe(120);
    expect(TEAM_LIMITS.overseerMaxLooksPerChild).toBe(12);
  });

  it('the dispatch-wide total exhausts the batch even when no child is exhausted', async () => {
    const stub = countingProvider({});
    const overseer = new TeamOverseer(stub.provider, { startedAt: Date.now() });
    const labels = Array.from({ length: TEAM_LIMITS.hardMaxSubagents }, (_, i) => `a${i}`);
    // One batch per "round": 12 rounds x 10 children = the 120 total.
    for (let round = 0; round < TEAM_LIMITS.overseerMaxLooksPerChild; round += 1) {
      await overseer.inspectBatch(labels.map(req));
    }
    expect(overseer.dispatchLooksExhausted()).toBe(true);
    // A fresh 11th child still cannot be looked at: the total binds.
    expect(overseer.looksExhausted('a-fresh')).toBe(true);
    const empty = await overseer.inspectBatch([req('a-fresh')]);
    expect(empty.size).toBe(0);
  });
});

describe('the action ledger (mutations)', () => {
  it('nudges are capped per child and counted only at application', async () => {
    const stub = countingProvider({
      inspectResult: () => ({ action: 'nudge', reason: 'again', guidance: 'g' }),
    });
    const overseer = new TeamOverseer(stub.provider, { startedAt: Date.now() });
    expect(overseer.nudgesLeft('a1')).toBe(true);
    // The DECISIONS arrive unbounded; the runtime applies and notes.
    for (let i = 0; i < TEAM_LIMITS.overseerMaxNudgesPerChild; i += 1) {
      await overseer.inspect(req('a1'));
    }
    expect(overseer.nudgesLeft('a1')).toBe(true); // inspected, not yet applied
    for (let i = 0; i < TEAM_LIMITS.overseerMaxNudgesPerChild; i += 1) {
      overseer.noteNudge('a1');
    }
    expect(overseer.nudgesLeft('a1')).toBe(false);
  });

  it('abandon is capped at one per child (D-5)', () => {
    const stub = countingProvider({});
    const overseer = new TeamOverseer(stub.provider, { startedAt: Date.now() });
    expect(overseer.abandonsLeft('a1')).toBe(true);
    overseer.noteAbandon('a1');
    expect(overseer.abandonsLeft('a1')).toBe(false);
  });

  it('replace keeps its single-slot budget from round 1', () => {
    const stub = countingProvider({});
    const overseer = new TeamOverseer(stub.provider, { startedAt: Date.now() });
    expect(overseer.replacementsLeft('a1')).toBe(true);
    overseer.noteReplacement('a1');
    expect(overseer.replacementsLeft('a1')).toBe(false);
  });
});

describe('usage and calls (D-7)', () => {
  it('exposes the provider accounting verbatim', async () => {
    const provider: OverseerProvider = {
      active: () => true,
      inspect: async () => ({ action: 'wait', reason: 'fine' }),
      inspectBatch: async () => [],
      usage: () => ({ inputTokens: 11, outputTokens: 7 }),
    };
    const overseer = new TeamOverseer(provider, { startedAt: Date.now() });
    expect(overseer.usage()).toEqual({ inputTokens: 11, outputTokens: 7 });
    await overseer.inspect(req('a1'));
    await overseer.inspectBatch([req('a1')]);
    expect(overseer.calls()).toBe(2);
  });

  it('a provider whose usage() throws reads as zero, never throws', () => {
    const provider: OverseerProvider = {
      active: () => true,
      inspect: async () => ({ action: 'wait', reason: 'fine' }),
      inspectBatch: async () => [],
      usage: () => {
        throw new Error('usage exploded');
      },
    };
    const overseer = new TeamOverseer(provider, { startedAt: Date.now() });
    expect(overseer.usage()).toEqual(NO_USAGE);
  });
});
