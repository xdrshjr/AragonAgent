import { describe, expect, it } from 'vitest';
import type { Message } from '@aragon-agent/core';
import {
  buildBatchSections,
  normalizeOverseerDecision,
  parseOverseerBatchText,
  TeamOverseer,
  type OverseerProvider,
} from '../team/overseer.js';
import { TEAM_LIMITS } from '../team/limits.js';
import type { OverseerDecision, SubagentRun } from '../team/types.js';

/**
 * The batch protocol (subagent-overseer-v2 D-3 / §7.1-2): digest shape,
 * array parsing, truncation fallback and the tighter per-entry clamps
 * (R-P0-1), all asserted without a network and without the runtime.
 */

function run(label: string, over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label,
    description: `job ${label}`,
    phase: 'tool',
    startedAt: Date.now() - 60_000,
    turns: 3,
    toolCalls: 7,
    lastTool: 'bash',
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

function input(label: string, messages: readonly Message[] = []) {
  return {
    run: run(label),
    childAlive: true,
    trigger: 'clock' as const,
    messages,
    memory: [],
    elapsedSec: 90,
  };
}

const NO_USAGE = { inputTokens: 0, outputTokens: 0 };

function provider(answer: () => unknown, digests: string[] = []): OverseerProvider {
  return {
    active: () => true,
    inspect: async () => ({ action: 'wait', reason: 'unused' }),
    inspectBatch: async (req) => {
      for (const r of req) digests.push(r.digest);
      return answer();
    },
    usage: () => ({ ...NO_USAGE }),
  };
}

describe('buildBatchSections (D-3 digest shape)', () => {
  it('is label-sorted, so the same roster is byte-identical', () => {
    const a = buildBatchSections([input('c'), input('a'), input('b')]);
    const b = buildBatchSections([input('b'), input('c'), input('a')]);
    expect(a.map((s) => s.label)).toEqual(['a', 'b', 'c']);
    expect(a).toEqual(b);
  });

  it('clamps every child to overseerPerChildDigestBytes', () => {
    const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(1000),
      timestamp: i,
    }));
    const sections = buildBatchSections(
      Array.from({ length: TEAM_LIMITS.hardMaxSubagents }, (_, i) => input(`a${i}`, messages)),
    );
    expect(sections).toHaveLength(TEAM_LIMITS.hardMaxSubagents);
    for (const section of sections) {
      expect(Buffer.byteLength(section.digest, 'utf8')).toBeLessThanOrEqual(
        TEAM_LIMITS.overseerPerChildDigestBytes,
      );
    }
  });

  it('keeps the facts and drops the history tail first (R-P2-5)', () => {
    const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(1000),
      timestamp: i,
    }));
    const [section] = buildBatchSections([input('a1', messages)]);
    // Facts survive the per-child clamp...
    expect(section!.digest).toContain('child: a1');
    expect(section!.digest).toContain('phase: tool');
    // ...and the long tail is what gave way.
    expect(Buffer.byteLength(section!.digest, 'utf8')).toBeLessThanOrEqual(
      TEAM_LIMITS.overseerPerChildDigestBytes,
    );
  });
});

describe('parseOverseerBatchText (D-3 parsing)', () => {
  it('parses an array wrapped in prose and fences', () => {
    const text = 'Sure!\n```json\n[{"label":"a1","action":"nudge","reason":"looping"}]\n```';
    const entries = parseOverseerBatchText(text);
    expect(entries).toHaveLength(1);
    expect((entries[0] as { label: string }).label).toBe('a1');
  });

  it('a truncated reply with no closing bracket parses to NOTHING (R-P0-1)', () => {
    const truncated =
      '[{"label":"a1","action":"wait","reason":"healthy, just slow, the task is a long one and"},{"label":"a2","action":"nu';
    expect(parseOverseerBatchText(truncated)).toEqual([]);
  });

  it('prose without an array parses to nothing', () => {
    expect(parseOverseerBatchText('I cannot answer that.')).toEqual([]);
    // A single OBJECT is not an array either - the batch protocol requires
    // the array, and treating one object as the whole answer would apply the
    // same decision to every child.
    expect(parseOverseerBatchText('{"label":"a1","action":"abandon","reason":"x"}')).toEqual([]);
  });
});

describe('TeamOverseer.inspectBatch (D-3 / R-P0-1)', () => {
  it('returns per-label decisions; a garbage entry degrades only itself', async () => {
    const overseer = new TeamOverseer(
      provider(() => [
        { label: 'a1', action: 'nudge', reason: 'circling', guidance: 'skip tests' },
        'garbage',
        { label: 'a3', action: 'wait', reason: 'fine' },
      ]),
      { startedAt: Date.now() },
    );
    const decisions = await overseer.inspectBatch([input('a1'), input('a2'), input('a3')]);
    expect(decisions.get('a1')!.action).toBe('nudge');
    // The garbage ENTRY was for a2 - wait, never a throw (repair-never-reject).
    expect(decisions.get('a2')!.action).toBe('wait');
    expect(decisions.get('a3')!.action).toBe('wait');
  });

  it('a wholly unparseable reply is ALL wait with zero action side effects (AC-13)', async () => {
    const overseer = new TeamOverseer(provider(() => 'no json at all'), { startedAt: Date.now() });
    const decisions = await overseer.inspectBatch([input('a1'), input('a2')]);
    for (const decision of decisions.values()) {
      expect(decision.action).toBe('wait');
      expect(decision.guidance).toBeUndefined();
      expect(decision.nextCheckMs).toBeUndefined();
    }
    expect(decisions.size).toBe(2);
  });

  it('a dead-child entry normalizes to abandon (the existing childAlive rule, per batch)', async () => {
    const overseer = new TeamOverseer(
      provider(() => [{ label: 'dead', action: 'wait', reason: 'looks fine' }]),
      { startedAt: Date.now() },
    );
    const decisions = await overseer.inspectBatch([
      { ...input('dead'), childAlive: false },
    ]);
    expect(decisions.get('dead')!.action).toBe('abandon');
    expect(decisions.get('dead')!.reason).toContain('looks fine');
  });

  it('skips labels whose single inspection is in flight, charging no look (R-P1-4)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const overseer = new TeamOverseer(
      {
        active: () => true,
        inspect: async () => {
          await gate;
          return { action: 'wait', reason: 'single' };
        },
        inspectBatch: async (req) => {
          calls.push(req.map((r) => r.label));
          return req.map((r) => ({ label: r.label, action: 'wait', reason: 'batch' }));
        },
        usage: () => ({ ...NO_USAGE }),
      },
      { startedAt: Date.now() },
    );
    const single = overseer.inspect({ ...input('a1'), trigger: 'silence' });
    const batch = await overseer.inspectBatch([input('a1'), input('a2')]);
    // a1 was in flight: the batch carried only a2, and a1 got NO decision.
    expect(calls).toEqual([['a2']]);
    expect(batch.has('a1')).toBe(false);
    expect(batch.get('a2')!.reason).toBe('batch');
    release();
    expect((await single)!.reason).toBe('single');
    // a1 spent exactly one look (the single), a2 one (the batch).
    expect(overseer.calls()).toBe(2);
  });

  it('clamps batch reason/guidance to 80/400 while the single path keeps 200/1200 (2c)', async () => {
    const longReason = 'r'.repeat(500);
    const longGuidance = 'g'.repeat(2000);
    const overseer = new TeamOverseer(
      provider(() => [{ label: 'a1', action: 'nudge', reason: longReason, guidance: longGuidance }]),
      { startedAt: Date.now() },
    );
    const [decision] = await overseer.inspectBatch([input('a1')]).then((m) => [...m.values()]);
    expect(decision!.reason.length).toBe(TEAM_LIMITS.overseerBatchReasonChars);
    expect(decision!.guidance!.length).toBe(TEAM_LIMITS.overseerBatchGuidanceChars);

    const single = normalizeOverseerDecision(
      { action: 'nudge', reason: longReason, guidance: longGuidance },
      true,
    );
    expect(single.reason.length).toBe(TEAM_LIMITS.overseerReasonChars);
    expect(single.guidance!.length).toBe(TEAM_LIMITS.overseerGuidanceChars);
  });

  it('AC-4/AC-13 sizing: a full ten-child batch is ONE call carrying every child', async () => {
    const digests: string[] = [];
    const overseer = new TeamOverseer(
      provider(
        () =>
          Array.from({ length: TEAM_LIMITS.hardMaxSubagents }, (_, i) => ({
            label: `a${i}`,
            action: 'wait',
            reason: 'ok',
          })),
        digests,
      ),
      { startedAt: Date.now() },
    );
    const labels = Array.from({ length: TEAM_LIMITS.hardMaxSubagents }, (_, i) => `a${i}`);
    const decisions = await overseer.inspectBatch(labels.map((l) => input(l)));
    expect(overseer.calls()).toBe(1);
    expect(decisions.size).toBe(TEAM_LIMITS.hardMaxSubagents);
    expect(digests).toHaveLength(TEAM_LIMITS.hardMaxSubagents);
  });
});
