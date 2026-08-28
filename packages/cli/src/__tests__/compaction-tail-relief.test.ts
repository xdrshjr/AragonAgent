/**
 * Tail relief, host side (context-auto-compaction-hardening §8.1, tests 16-19).
 *
 * TEST 17 IS THE ONE THAT FAILS AGAINST `553827ca7`. "Nothing to drop" and "the
 * tail alone exceeds the window" are the SAME outcome in round 1, and both are
 * terminal: every rung of the ladder operates on the head, and in this shape
 * there is no head left. That is the case that kills a long run today.
 *
 * TEST 17a ASSERTS ON THE RENDERED STRING, deliberately. The defect it replaces
 * was invisible in the record and visible only on screen: `mode: 'summarized'`
 * with zero dropped messages renders "summarized 0 messages with
 * claude-haiku-4-5" for a compaction in which no model was ever called.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type {
  AssistantMessage,
  CompactionContext,
  LLMRequest,
  Message,
  ModelInfo,
  ModelRef,
} from '@aragon-agent/core';
import { Compactor, type CompactorDeps } from '../compaction/compactor.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
import type { CompactionEvent, CompactionRecord } from '../compaction/types.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  type CliConfig,
  type CompactionConfig,
} from '../config/schema.js';
import { CompactionCard } from '../ui/entries/CompactionCard.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';

/**
 * A SMALL WINDOW, so a tail of a few fat tool results genuinely does not fit.
 * The alternative is a 200 k window and a megabyte of fixture per case.
 */
const MODEL: ModelInfo = {
  id: 'claude-sonnet-4-5',
  name: 'Sonnet',
  provider: 'anthropic',
  contextWindow: 32_000,
  maxOutputTokens: 8_192,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: true,
  cost: { input: 3, output: 15 },
};

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function call(id: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', toolCallId: id, toolName: 'read_file', args: { path: 'x' } }],
  };
}

function result(id: string, chars: number): Message {
  return { role: 'tool_result', toolCallId: id, content: 'r'.repeat(chars) };
}

function harness(over: Partial<CompactionConfig> = {}) {
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 4_096,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...over },
  } as unknown as CliConfig;

  const events: CompactionEvent[] = [];
  const deps: CompactorDeps = {
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    getModelInfoFor: () => MODEL,
    isPricedModel: () => true,
    getMessages: () => [],
    getSystemPrompt: () => '',
    complete: async (_id: string, _request: LLMRequest): Promise<AssistantMessage> => ({
      role: 'assistant',
      content: [{ type: 'text', text: '## Task\nthe summary' }],
      usage: { inputTokens: 1_000, outputTokens: 200 },
    }),
    emit: (e) => events.push(e),
    notify: () => {},
  };
  return { compactor: new Compactor(deps), events };
}

function ctx(messages: Message[], over: Partial<CompactionContext> = {}): CompactionContext {
  return {
    messageCount: messages.length,
    turnIndex: 1,
    trigger: 'pressure',
    messages,
    systemPrompt: 'sys',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' } as ModelRef,
    signal: new AbortController().signal,
    ...over,
  };
}

function lastRecord(events: CompactionEvent[]): CompactionRecord {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.type === 'compaction_end') return e.record;
  }
  throw new Error('no compaction_end');
}

describe('relief after a splice (§3.3.3 / test 16)', () => {
  it('relieves a spliced history that is still over budget and reports it', async () => {
    // Enough turns to plan a cut, and a retained tail of huge tool results.
    const history: Message[] = [
      user('the original goal'),
      user('turn 1'),
      user('turn 2'),
      user('turn 3'),
      user('turn 4'),
      call('a'),
      result('a', 90_000),
      user('turn 5'),
      call('b'),
      result('b', 90_000),
    ];
    const { compactor, events } = harness();

    const outcome = await compactor.compact(ctx(history));

    expect(outcome.action).toBe('replace');
    const record = lastRecord(events);
    expect(record.tailRelief).toBeDefined();
    expect(record.tailRelief!.messages).toBeGreaterThan(0);
    expect(record.tailRelief!.charsRemoved).toBeGreaterThan(80_000);
    // The summary still happened, so the mode is still `summarized`.
    expect(record.mode).toBe('summarized');
  });
});

describe('the plan === null recovery (§3.3.3 / tests 17-18)', () => {
  /**
   * The shape that is TERMINAL in round 1: one user turn, so `planCompaction`
   * finds no cut above the protected prefix, and the tool results alone are
   * larger than the window.
   */
  function unsplittable(): Message[] {
    return [user('the only turn'), call('a'), result('a', 120_000), call('b'), result('b', 120_000)];
  }

  it('relieves instead of reporting nothing_to_drop', async () => {
    const { compactor, events } = harness();
    const outcome = await compactor.compact(ctx(unsplittable()));

    expect(outcome.action).toBe('replace');
    expect(outcome.action === 'replace' && outcome.reason).toBe('tail_relief_only');
    // NO MESSAGE WAS DROPPED - relief clips, it does not remove.
    const record = lastRecord(events);
    expect(record.messagesAfter).toBe(record.messagesBefore);
    expect(record.tailRelief!.messages).toBe(2);
  });

  it('AC-H8a: that record is `relieved`, and the card claims no summary', async () => {
    const { compactor, events } = harness();
    await compactor.compact(ctx(unsplittable()));
    const record = lastRecord(events);

    expect(record.mode).toBe('relieved');
    expect(record.model).toBe('');

    const { lastFrame, unmount } = render(
      React.createElement(CompactionCard, {
        ...record,
        live: false,
        theme: getTheme('cool', CAPS),
        caps: CAPS,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('clipped 2 tool results in the retained turns');
    expect(frame).toContain('nothing could be dropped');
    // THE TWO ASSERTIONS THE DEFECT WOULD HAVE FAILED.
    expect(frame).not.toContain('summarized');
    expect(frame).not.toContain('claude-haiku');
  });

  it('still reports nothing_to_drop when the history is UNDER budget', async () => {
    // No behaviour change for the common case: a short conversation with nothing
    // worth dropping is still a `keep`.
    const { compactor } = harness();
    const outcome = await compactor.compact(ctx([user('hello'), call('a'), result('a', 40)]));

    expect(outcome.action).toBe('keep');
    expect(outcome.action === 'keep' && outcome.reason).toBe('nothing_to_drop');
  });
});

describe('AC-H7: relief counts as progress (test 19)', () => {
  it('a relief that met the budget does not charge guard 3', async () => {
    // Guard 3 measures the FINAL history, which is the relieved one - so this
    // holds for free. It is asserted because "for free" is the kind of property a
    // refactor breaks silently: two no-progress PRESSURE compactions self-disable
    // the proactive trigger for the rest of the session.
    const unsplittable = (): Message[] => [
      user('the only turn'),
      call('a'),
      result('a', 120_000),
      call('b'),
      result('b', 120_000),
    ];
    const { compactor } = harness();

    await compactor.compact(ctx(unsplittable(), { turnIndex: 1 }));
    await compactor.compact(ctx(unsplittable(), { turnIndex: 20 }));

    expect(compactor.isSelfDisabled()).toBe(false);
  });
});

describe('the clip marker (§3.3.2 rule 4 / AC-H9)', () => {
  it('is announced in the text the model reads, at the place the data went', async () => {
    const { compactor } = harness();
    const outcome = await compactor.compact(
      ctx([user('the only turn'), call('a'), result('a', 120_000)]),
    );

    expect(outcome.action).toBe('replace');
    if (outcome.action !== 'replace') return;
    const clipped = outcome.messages.find((m) => m.role === 'tool_result')!;
    const body = clipped.content as string;
    expect(body.startsWith('r'.repeat(COMPACTION_LIMITS.tailToolResultChars))).toBe(true);
    expect(body).toContain('characters removed by context compaction');
  });
});
