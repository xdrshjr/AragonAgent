/**
 * A subagent's retry is visible on the team card (llm-api-retry-backoff §6.10,
 * AC-34).
 *
 * THE FAILURE THIS PINS is not a crash. Children inherit the lead's retry policy
 * for free — `TeamRuntime` reuses the lead's registry instance — but a child's
 * `retry_scheduled` is emitted to that CHILD's own `Agent` listeners and never
 * reaches the lead's `ViewState`. Without `SubagentRun.retry` a subagent spending
 * three minutes in backoff shows no card, no chip and no countdown anywhere: the
 * dispatch simply appears hung, which is the single worst reading of a mechanism
 * whose whole claim is that waiting is now legible.
 *
 * `loadConfig` builds the `CliConfig` rather than a hand-written literal, so this
 * file does not have to be edited every time another feature adds a config
 * section.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentEvent, ProviderRegistry } from '@aragon-agent/core';
import { TeamRuntime } from '../team/runtime.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { SubagentRun, SubagentSpec, TeamEvent } from '../team/types.js';
import { TeamCard } from '../ui/entries/TeamCard.js';
import { getTheme } from '../ui/theme.js';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-retry-team-'));
process.env.ARAGON_HOME = TMP;

const { loadConfig } = await import('../config/load.js');

const RICH = { colorLevel: 3 as const, unicode: true };
const ASCII = { colorLevel: 0 as const, unicode: false };
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A child that retries once and then answers
// ---------------------------------------------------------------------------

/** Emits the exact event sequence `withRetry` produces around one recovery. */
class RetryingAgent implements SubagentAgentLike {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  /** The narrow member `SubagentAgentLike` gained for child compaction (W3). */
  readonly state = { messages: [] };

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pauseIdleWatchdog(): void {}
  resumeIdleWatchdog(): void {}
  abort(): void {}
  steer(_text: string): void {}
  clearAllQueues(): void {}

  private emit(event: AgentEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  async prompt(): Promise<void> {
    this.emit({ type: 'turn_start' } as AgentEvent);
    // Three scheduled retries, as the wrapper would produce them.
    for (const attempt of [1, 2, 3]) {
      this.emit({
        type: 'message_update',
        streamEvent: {
          type: 'retry_scheduled',
          attempt,
          maxRetries: 10,
          delayMs: 1000,
          resumeAt: 1000,
          errorType: 'overloaded',
          message: 'anthropic API error 529',
        },
      } as AgentEvent);
      this.emit({
        type: 'message_update',
        streamEvent: { type: 'retry_attempt', attempt, maxRetries: 10 },
      } as AgentEvent);
    }
    this.emit({
      type: 'turn_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: { inputTokens: 1, outputTokens: 1 },
    } as AgentEvent);
    this.emit({ type: 'agent_end', messages: [] } as AgentEvent);
  }
}

function spec(): SubagentSpec {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    prompt: 'do it',
    readOnly: false,
    // Required by fast-model-tier; `'main'` is the ordinary case.
    tier: 'main',
  } as SubagentSpec;
}

describe('a child in backoff reports it through SubagentRun.retry (AC-34)', () => {
  it('sets the projection while waiting and clears it on the next turn_end', async () => {
    const cfg = loadConfig({ cwd: TMP });
    const events: TeamEvent[] = [];
    const runtime = new TeamRuntime({
      getConfig: () => cfg,
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => TMP,
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: () => new RetryingAgent(),
    });
    runtime.subscribe((event) => events.push(event));

    await runtime.dispatch([spec()], 1);

    const updates = events.filter(
      (e): e is Extract<TeamEvent, { type: 'agent_update' }> => e.type === 'agent_update',
    );
    const withRetry = updates.filter((e) => e.run.retry !== undefined);

    // THE THROTTLE MUST NOT SWALLOW A RETRY. A child entering backoff stays
    // `thinking`, so without the retry key in `emit()`'s coalescing guard the
    // whole sequence could collapse into a single frame that never mentions it.
    expect(withRetry.length).toBeGreaterThan(0);
    expect(withRetry[withRetry.length - 1]?.run.retry).toEqual({ attempt: 3, maxRetries: 10 });

    // Cleared once the turn produced an answer: whatever it retried, it recovered.
    const last = updates[updates.length - 1];
    expect(last?.run.retry).toBeUndefined();
    expect(last?.run.phase).toBe('done');
  });

  it('leaves the phase alone, so SubagentPhase never gains a retry member', () => {
    // The scheduler, the report and `canSend` all read `phase` for a different
    // question; a retry is an annotation on the row, not a phase.
    const cfg = loadConfig({ cwd: TMP });
    const runtime = new TeamRuntime({
      getConfig: () => cfg,
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => TMP,
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: () => new RetryingAgent(),
    });
    const seen: string[] = [];
    runtime.subscribe((e) => {
      if (e.type === 'agent_update' && e.run.retry) seen.push(e.run.phase);
    });
    return runtime.dispatch([spec()], 1).then(() => {
      expect(seen.length).toBeGreaterThan(0);
      for (const phase of seen) expect(['thinking', 'starting']).toContain(phase);
    });
  });
});

// ---------------------------------------------------------------------------
// The row itself
// ---------------------------------------------------------------------------

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    tier: 'main',
    phase: 'thinking',
    startedAt: 1000,
    turns: 1,
    toolCalls: 2,
    usage: { inputTokens: 10, outputTokens: 5 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  } as SubagentRun;
}

function cardText(runs: SubagentRun[], caps: typeof RICH | typeof ASCII): string {
  const { lastFrame, unmount } = render(
    <TeamCard
      requested={runs.length}
      runs={runs}
      aborted={false}
      active
      reducedMotion
      theme={getTheme('cool', caps)}
      caps={caps}
    />,
  );
  const out = stripAnsi(lastFrame() ?? '');
  unmount();
  return out;
}

describe('TeamCard renders the child retry (AC-34)', () => {
  it('shows `retry 3/10` on the row that is retrying', () => {
    const out = cardText([run({ retry: { attempt: 3, maxRetries: 10 } })], RICH);
    expect(out).toContain('retry 3/10');
  });

  it('shows nothing when the child is not retrying', () => {
    expect(cardText([run()], RICH)).not.toContain('retry');
  });

  it('annotates only the affected row', () => {
    const out = cardText(
      [
        run({ label: 'a1', retry: { attempt: 2, maxRetries: 10 } }),
        run({ label: 'a2', description: 'map the routes' }),
      ],
      RICH,
    );
    const lines = out.split('\n');
    const a1 = lines.find((l) => l.includes('a1'));
    const a2 = lines.find((l) => l.includes('a2'));
    expect(a1).toContain('retry 2/10');
    expect(a2).not.toContain('retry');
  });

  it('stays pure ASCII in the ASCII tier', () => {
    expect(cardText([run({ retry: { attempt: 3, maxRetries: 10 } })], ASCII))
      .not.toMatch(/[^\x00-\x7f]/);
  });
});
