import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../engine/agent.js';
import { MessageQueueManager } from '../engine/steering.js';
import { validateHistory } from '../engine/compaction.js';
import type { ProviderRegistry } from '../llm/providers/index.js';
import type { Message, StreamEvent, ToolCallBlock } from '../llm/types.js';
import type { AgentEvent } from '../types.js';

const calls: ToolCallBlock[] = ['one', 'two', 'three'].map((toolCallId) => ({
  type: 'tool_call', toolCallId, toolName: 'work', args: {},
}));

function done(toolCalls: ToolCallBlock[] = []): StreamEvent {
  const usage = { inputTokens: 1, outputTokens: 1 };
  return {
    type: 'done', usage,
    message: {
      role: 'assistant', content: toolCalls.length ? toolCalls : [{ type: 'text', text: 'ok' }],
      usage, stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
    },
  };
}

function setup(firstCalls: ToolCallBlock[] = []) {
  const requests: Message[][] = [];
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'worked' }] }));
  const providerRegistry = {
    stream: (_: string, request: { messages: Message[] }) => (async function* () {
      requests.push([...request.messages]);
      yield { type: 'text_delta', delta: 'ok' } as StreamEvent;
      yield done(requests.length === 1 ? firstCalls : []);
    })(),
  } as unknown as ProviderRegistry;
  const agent = new Agent({
    systemPrompt: 'test', model: { providerId: 'test', modelId: 'test' },
    providerRegistry, getApiKey: () => 'key',
    tools: [{ name: 'work', label: 'work', description: 'work',
      parameters: { type: 'object' }, execute }],
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, events, requests, execute };
}

function users(messages: readonly Message[]): unknown[] {
  return messages.filter((message) => message.role === 'user').map((message) => message.content);
}

function accepted(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => event.type === 'steering_accepted');
}

describe('steering queue compatibility', () => {
  it('drains text and envelopes from the same FIFO without deduplicating text', () => {
    const queue = new MessageQueueManager();
    queue.pushSteering('same', 'a');
    queue.pushSteering('same', 'b');
    queue.pushSteering('legacy');
    expect(queue.drainSteeringItems()).toEqual([
      { text: 'same', id: 'a' }, { text: 'same', id: 'b' }, { text: 'legacy' },
    ]);
    expect(queue.drainSteering()).toEqual([]);
    queue.pushSteering('text', 'c');
    expect(queue.drainSteering()).toEqual(['text']);
    expect(queue.drainSteeringItems()).toEqual([]);
  });
});

describe('steering acceptance through the real Agent', () => {
  it('accepts a whole FIFO batch before its single receipt and before turn_start', async () => {
    const { agent, events, requests } = setup();
    let receiptHistory: unknown[] = [];
    agent.subscribe((event) => {
      if (event.type === 'steering_accepted') receiptHistory = users(agent.state.messages);
    });
    agent.steer('same', 'a');
    agent.steer('legacy');
    agent.steer('same', 'b');
    await agent.prompt('initial');
    expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a', 'b'] }]);
    expect(receiptHistory).toEqual(['initial', 'same', 'legacy', 'same']);
    expect(users(requests[0]!)).toEqual(receiptHistory);
    expect(requests[0]!.filter((m) => m.role === 'user').every((m) => !('id' in m))).toBe(true);
    expect(events.findIndex((e) => e.type === 'steering_accepted'))
      .toBeLessThan(events.findIndex((e) => e.type === 'turn_start'));
  });

  it('keeps legacy steering functional without an empty receipt', async () => {
    const { agent, events } = setup();
    agent.steer('legacy');
    await agent.prompt('initial');
    expect(users(agent.state.messages)).toEqual(['initial', 'legacy']);
    expect(accepted(events)).toEqual([]);
  });

  it.each(['stream', 'turn_end'] as const)(
    'accepts steering queued at %s before follow-up and normal completion', async (checkpoint) => {
      const { agent, events, requests } = setup();
      let injected = false;
      agent.followUp('follow');
      agent.subscribe((event) => {
        const reached = checkpoint === 'stream'
          ? event.type === 'message_update' : event.type === 'turn_end';
        if (!injected && reached) {
          injected = true;
          agent.steer('steering', 'a');
        }
      });
      await agent.prompt('initial');
      expect(requests.map(users)).toEqual([
        ['initial'], ['initial', 'steering'], ['initial', 'steering', 'follow'],
      ]);
      expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a'] }]);
    },
  );

  it.each(['stream', 'turn_end'] as const)(
    'does not strand %s steering when no follow-up is queued', async (checkpoint) => {
      const { agent, events, requests } = setup();
      let injected = false;
      agent.subscribe((event) => {
        const reached = checkpoint === 'stream'
          ? event.type === 'message_update' : event.type === 'turn_end';
        if (!injected && reached) {
          injected = true;
          agent.steer('steering', 'a');
        }
      });
      await agent.prompt('initial');
      expect(requests.map(users)).toEqual([['initial'], ['initial', 'steering']]);
      expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a'] }]);
    },
  );

  it.each(['before-tools', 'between-tools'] as const)(
    'pairs every tool result before accepting at %s', async (checkpoint) => {
      const { agent, events, requests, execute } = setup(calls);
      let receiptHistory: readonly Message[] = [];
      let injected = false;
      agent.subscribe((event) => {
        const reached = checkpoint === 'before-tools'
          ? event.type === 'turn_end' : event.type === 'tool_execution_end';
        if (!injected && reached) {
          injected = true;
          agent.steer('redirect', 'a');
        }
        if (event.type === 'steering_accepted') receiptHistory = [...agent.state.messages];
      });
      await agent.prompt('initial');
      const results = receiptHistory.filter((m) => m.role === 'tool_result');
      expect(results.map((m) => m.toolCallId)).toEqual(['one', 'two', 'three']);
      expect(results.filter((m) => m.isError)).toHaveLength(checkpoint === 'before-tools' ? 3 : 2);
      expect(execute).toHaveBeenCalledTimes(checkpoint === 'before-tools' ? 0 : 1);
      expect(receiptHistory.at(-1)).toMatchObject({ role: 'user', content: 'redirect' });
      expect(validateHistory([...receiptHistory]).ok).toBe(true);
      expect(validateHistory(requests[1]!).ok).toBe(true);
      expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a'] }]);
    },
  );

  it.each(['agent_start', 'turn_end', 'tool_execution_end'] as const)(
    'preserves pending steering when aborted at %s', async (checkpoint) => {
      const { agent, events } = setup(checkpoint === 'agent_start' ? [] : calls);
      let interrupted = false;
      agent.subscribe((event) => {
        if (!interrupted && event.type === checkpoint) {
          interrupted = true;
          agent.steer('pending', 'a');
          agent.abort();
        }
      });
      await agent.prompt('initial');
      expect(accepted(events)).toEqual([]);
      expect(users(agent.state.messages)).toEqual(['initial']);
      expect(agent.state.messages.filter((m) => m.role === 'tool_result' && m.isError)).toEqual([]);
      await agent.continue();
      expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a'] }]);
    },
  );

  it.each(['turn_end', 'tool_execution_end'] as const)(
    'retains all paired results when the receipt after %s synchronously aborts', async (checkpoint) => {
      const { agent, events, requests } = setup(calls);
      let injected = false;
      agent.subscribe((event) => {
        if (!injected && event.type === checkpoint) {
          injected = true;
          agent.steer('accepted', 'a');
        }
        if (event.type === 'steering_accepted') agent.abort();
      });
      await agent.prompt('initial');
      expect(users(agent.state.messages)).toEqual(['initial', 'accepted']);
      expect(agent.state.messages.filter((m) => m.role === 'tool_result')
        .map((m) => m.toolCallId)).toEqual(['one', 'two', 'three']);
      expect(validateHistory([...agent.state.messages]).ok).toBe(true);
      expect(requests).toHaveLength(1);
      await agent.continue();
      expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a'] }]);
      expect(requests).toHaveLength(2);
    },
  );

  it('retains accepted history when the receipt listener aborts and never accepts it twice', async () => {
    const { agent, events, requests } = setup();
    agent.subscribe((event) => {
      if (event.type === 'steering_accepted') agent.abort();
    });
    agent.steer('accepted', 'a');
    await agent.prompt('initial');
    expect(users(agent.state.messages)).toEqual(['initial', 'accepted']);
    expect(requests).toHaveLength(0);
    await agent.continue();
    expect(accepted(events)).toEqual([{ type: 'steering_accepted', ids: ['a'] }]);
    expect(requests).toHaveLength(1);
  });
});
