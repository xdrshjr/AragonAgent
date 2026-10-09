/** v2 rejects unsafe tail relief and preserves every retained message verbatim. */
import { describe, expect, it } from 'vitest';
import type { Message, ModelInfo } from '@aragon-agent/core';
import { Compactor } from '../compaction/compactor.js';
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_FAST_CONFIG, type CliConfig } from '../config/schema.js';

const MODEL: ModelInfo = { id: 'claude-sonnet-4-5', name: 'Sonnet', provider: 'anthropic', contextWindow: 32000,
  maxOutputTokens: 8192, supportsThinking: true, supportsTools: true, supportsImages: true, cost: { input: 3, output: 15 } };
const user = (content: string): Message => ({ role: 'user', content });
const call = (id: string): Message => ({ role: 'assistant', content: [{ type: 'tool_call', toolCallId: id, toolName: 'read', args: {} }] });
const result = (id: string, length: number): Message => ({ role: 'tool_result', toolCallId: id, content: 'r'.repeat(length) });

function harness(messages: Message[], contextWindow: number, onFailure: 'stop' | 'truncate' = 'stop') {
  let calls = 0;
  const config = { provider: 'anthropic', model: MODEL.id, maxTokens: 4096, contextWindow,
    fast: { ...DEFAULT_FAST_CONFIG }, compaction: { ...DEFAULT_COMPACTION_CONFIG, onFailure, archive: false } } as CliConfig;
  const compactor = new Compactor({ getConfig: () => config, hasKey: () => true, getApiKey: () => 'k',
    getModelInfoFor: () => MODEL, isPricedModel: () => true, getMessages: () => messages,
    getSystemPrompt: () => 'sys', emit: () => {}, notify: () => {},
    complete: async () => { calls += 1; return { role: 'assistant', content: [{ type: 'text', text: '{"schemaVersion":2,"additions":[]}' }] }; } });
  const compact = async () => {
    const outcome = await compactor.compact({ messages, messageCount: messages.length, turnIndex: 1,
      trigger: 'pressure', systemPrompt: 'sys', model: { providerId: 'anthropic', modelId: MODEL.id }, signal: new AbortController().signal });
    compactor.settleOperation({ applied: false, reason: outcome.action === 'keep' ? outcome.reason : 'test_rejected', tokensAfter: 0 });
    return outcome;
  };
  return { compact, compactor, calls: () => calls };
}

describe('v2 retained-tail preservation', () => {
  it.each([16000, 32000, 128000])('never clips an unsplittable history at configured window %i', async (window) => {
    const messages = [user('goal'), call('a'), result('a', 120000), call('b'), result('b', 120000)];
    const snapshot = JSON.stringify(messages);
    const h = harness(messages, window);
    expect(await h.compact()).toMatchObject({ action: 'keep', reason: 'nothing_to_drop' });
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(h.calls()).toBe(0);
  });
  it('legacy truncate cannot authorize tail deletion', async () => {
    const messages = [user('goal'), call('a'), result('a', 120000)];
    const snapshot = JSON.stringify(messages);
    const h = harness(messages, 16000, 'truncate');
    expect((await h.compact()).action).toBe('keep');
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(h.calls()).toBe(0);
  });
  it('rejects a candidate whose complete protected tail still exceeds capacity', async () => {
    const messages = [user('goal'), user('turn 1'), user('turn 2'), user('turn 3'), user('turn 4'),
      call('a'), result('a', 90000), user('turn 5'), call('b'), result('b', 90000)];
    const snapshot = JSON.stringify(messages);
    const h = harness(messages, 32000);
    expect((await h.compact()).action).toBe('keep');
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(messages.filter((message) => message.role === 'tool_result').map((message) => (message.content as string).length)).toEqual([90000, 90000]);
  });
  it('repeated deterministic declines count as no progress rather than a successful relief', async () => {
    const messages = [user('goal'), call('a'), result('a', 120000)];
    const h = harness(messages, 32000);
    await h.compact(); await h.compact();
    expect(h.compactor.isSelfDisabled()).toBe(true);
    expect(h.compactor.sessionTotals().generation).toBe(0);
    expect(h.calls()).toBe(0);
  });
});
