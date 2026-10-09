/** Real Agent + Registry + host compaction with offline, schema-valid responses. */
import { describe, expect, it, vi } from 'vitest';
import { Agent, ProviderRegistry, type AgentEvent, type Message, type ModelInfo, type ModelRef } from '@aragon-agent/core';
import { CompactionWiring } from '../compaction/wiring.js';
import { parseCompactedBlock } from '../compaction/summary-prompt.js';
import type { CompactionEvent } from '../compaction/types.js';
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_FAST_CONFIG, type CliConfig } from '../config/schema.js';
import { scriptedProvider, type ScriptStep } from './helpers/scripted-provider.js';

const REF: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' };
const user = (content: string): Message => ({ role: 'user', content, timestamp: 0 });
function history(turns = 8, toolChars = 22000): Message[] {
  return Array.from({ length: turns }, (_, index): Message[] => [user(`requirement ${index}`),
    { role: 'assistant', content: [{ type: 'tool_call', toolCallId: `call${index}`, toolName: 'read', args: {} }] },
    { role: 'tool_result', toolCallId: `call${index}`, content: `RESULT FACT\n${'x'.repeat(toolChars)}` }]).flat();
}
function delta(generation = 1, role: 'assistant' | 'tool_result' = 'tool_result'): string {
  return JSON.stringify({ schemaVersion: 2, additions: [{ section: 'facts', text: `fact generation ${generation}`,
    sources: [{ messageId: `g${generation}:m${role === 'tool_result' ? 2 : 3}`, role, excerpt: role === 'tool_result' ? 'RESULT FACT' : '{}' }] }] });
}
function harness(seed: Message[], script: ScriptStep[], contextWindow = 32000, onFailure: 'stop' | 'truncate' = 'stop') {
  const info: ModelInfo = { id: REF.modelId, name: 'Sonnet', provider: REF.providerId, contextWindow, maxOutputTokens: 8192,
    supportsThinking: true, supportsTools: true, supportsImages: true, cost: { input: 3, output: 15 } };
  const config = { provider: REF.providerId, model: REF.modelId, maxTokens: 4096, fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, keepRecentTurns: 2, archive: false, onFailure } } as CliConfig;
  const provider = scriptedProvider(REF.providerId, script);
  const registry = new ProviderRegistry({ retryPolicy: null }); registry.register(provider);
  const events: CompactionEvent[] = []; const agentEvents: AgentEvent[] = []; const notices: string[] = [];
  let agent: Agent;
  const wiring = new CompactionWiring({ getConfig: () => config, hasKey: () => true, getApiKey: () => 'k',
    getModelInfoFor: () => info, isPricedModel: () => true, getMessages: () => agent?.state.messages ?? [],
    getSystemPrompt: () => 'sys', notify: (_level, text) => notices.push(text), createRegistry: () => registry });
  wiring.subscribe((event) => events.push(event));
  agent = new Agent({ systemPrompt: 'sys', model: REF, tools: [], providerRegistry: registry, getApiKey: () => 'k',
    maxTokens: 4096, contextManager: wiring.manager(), timeouts: { idleTimeout: 30000 } });
  agent.subscribe((event) => agentEvents.push(event)); wiring.attach((listener) => agent.subscribe(listener));
  agent.replaceMessages(seed);
  const ends = () => events.filter((event): event is Extract<CompactionEvent, { type: 'compaction_end' }> => event.type === 'compaction_end').map((event) => event.record);
  const manual = () => wiring.compactNow({ messages: agent.state.messages, systemPrompt: 'sys', model: REF,
    signal: new AbortController().signal, adopt: (messages) => agent.replaceMessages(messages), isCurrent: () => true });
  return { agent, wiring, provider, events, agentEvents, notices, ends, manual };
}

describe('strict trigger and full-stack memory integration', () => {
  it('does not let output headroom authorize a below-threshold summary', async () => {
    const h = harness(history(6, 12000), [{ kind: 'assistant', text: 'answered' }]);
    await h.agent.prompt('go');
    expect(h.provider.summarizerRequests).toHaveLength(0);
    expect(h.ends()).toHaveLength(0);
    expect(h.provider.agentRequests).toHaveLength(1);
  });
  it('compacts a resumed high-pressure history and sends the validated v2 memory', async () => {
    const h = harness(history(), [{ kind: 'summary', text: delta() }, { kind: 'assistant', text: 'answered' }]);
    await h.agent.prompt('continue');
    expect(h.ends()[0]?.applied).toBe(true);
    expect(h.provider.summarizerRequests).toHaveLength(1);
    const sent = h.provider.agentRequests[0]!.messages;
    const memory = parseCompactedBlock(sent[1]!).memory;
    expect(memory.generation).toBe(1);
    expect(memory.items[0]!.text).toBe('fact generation 1');
    expect(memory.userMessages.some((entry) => entry.message.content === 'requirement 1')).toBe(true);
    expect(sent[0]!.content).toBe('requirement 0');
  });
  it('leaves a low-ratio overflow as the provider error with no automatic request', async () => {
    const h = harness(history(6, 3000), [{ kind: 'overflow' }]);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { await h.agent.prompt('go'); } finally { diagnostic.mockRestore(); }
    expect(h.provider.summarizerRequests).toHaveLength(0);
    expect(h.provider.agentRequests).toHaveLength(1);
    expect(h.agentEvents.some((event) => event.type === 'message_update' && event.streamEvent.type === 'error')).toBe(true);
    expect(h.notices.join(' ')).toContain('/compact');
  });
  it('preserves history on two malformed summaries even under legacy truncate config', async () => {
    const seed = history();
    const h = harness(seed, [{ kind: 'summary', text: 'not JSON' }, { kind: 'summary', text: 'still not JSON' },
      { kind: 'assistant', text: 'answered anyway' }], 32000, 'truncate');
    await h.agent.prompt('go');
    expect(h.provider.summarizerRequests).toHaveLength(2);
    expect(h.ends()[0]?.applied).toBe(false);
    expect(h.agent.state.messages.slice(0, seed.length)).toEqual(seed);
    expect(h.wiring.snapshot().generation).toBe(0);
    expect(h.notices.join(' ')).toContain('preserving history');
  });
  it('retries a schema failure once with an intact source map', async () => {
    const h = harness(history(), [{ kind: 'summary', text: '{"schemaVersion":2,"additions":[]}' },
      { kind: 'summary', text: delta() }, { kind: 'assistant', text: 'ok' }]);
    await h.agent.prompt('go');
    expect(h.provider.summarizerRequests).toHaveLength(2);
    expect(h.ends()[0]?.applied).toBe(true);
    expect(h.provider.summarizerRequests[1]!.systemPrompt).toContain('empty_memory_delta');
  });
  it('carries original requirements and item IDs through three adopted generations', async () => {
    const h = harness(history(), [{ kind: 'summary', text: delta() },
      { kind: 'summary', text: delta(2, 'assistant') }, { kind: 'summary', text: delta(3, 'assistant') }], 200000);
    expect((await h.manual()).ok).toBe(true);
    const original = parseCompactedBlock(h.agent.state.messages[1]!).memory;
    for (let generation = 2; generation <= 3; generation += 1) {
      for (const message of history(4, 12000)) h.agent.appendMessage(message);
      expect((await h.manual()).ok).toBe(true);
    }
    const memory = parseCompactedBlock(h.agent.state.messages[1]!).memory;
    expect(memory.generation).toBe(3);
    expect(memory.items[0]).toEqual(original.items[0]);
    expect(memory.userMessages.slice(0, original.userMessages.length)).toEqual(original.userMessages);
    expect(h.provider.summarizerRequests[2]!.messages[0]!.content).toContain('fact generation 1');
    expect(h.wiring.getIdentity()?.generation).toBe(3);
  });
  it('keeps the core watchdog event pair for a silent no-head decline', async () => {
    const h = harness([user('q'.repeat(150000))], [{ kind: 'assistant', text: 'answered anyway' }]);
    await h.agent.prompt('go');
    expect(h.agentEvents.filter((event) => event.type === 'compaction_start')).toHaveLength(1);
    expect(h.agentEvents.filter((event) => event.type === 'compaction_end')[0]).toMatchObject({ applied: false, reason: 'nothing_to_drop' });
    expect(h.events.filter((event) => event.type === 'compaction_start')).toHaveLength(0);
    expect(h.provider.summarizerRequests).toHaveLength(0);
  });
  it('disabled compaction adds no summary calls or compaction events', async () => {
    const h = harness(history(), [{ kind: 'assistant', text: 'hi' }]);
    h.wiring.setEnabled(false);
    await h.agent.prompt('go');
    expect(h.provider.agentRequests).toHaveLength(1);
    expect(h.provider.summarizerRequests).toHaveLength(0);
    expect(h.agentEvents.some((event) => event.type === 'compaction_start')).toBe(false);
  });
});
