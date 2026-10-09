import { describe, expect, it } from 'vitest';
import type { CompactionMemory } from '../compaction/memory.js';
import type { Message } from '@aragon-agent/core';
import { createCompactionIdentity, verifyCompactionIdentity, validateCompactionIdentity } from '../compaction/memory-identity.js';
import { buildCompactedBlock, parseCompactedBlock, countProtectedPrefix, readGeneration } from '../compaction/summary-prompt.js';
import { prepareMemoryInput } from '../compaction/memory-input.js';

const memory: CompactionMemory = { schemaVersion: 2, generation: 1, originalTask: { sourceId: 'g1:m0', location: 'anchor' },
  userMessages: [], items: [], coverage: { summarizedMessages: 0, clippedToolResults: [], legacyIncomplete: false } };
function prefix(): Message[] {
  return [{ role: 'user', content: 'goal', timestamp: 1 }, buildCompactedBlock({ memory, replaced: 2, turns: 1, anchor: 'verbatim', generation: 1, truncated: false })];
}

describe('memory host identity', () => {
  it('round trips a saved prefix and ignores untrusted body shapes', () => {
    const messages = prefix();
    const identity = createCompactionIdentity(messages);
    const restored = JSON.parse(JSON.stringify(messages)) as Message[];
    expect(verifyCompactionIdentity(restored, identity)).toBe(true);
    expect(countProtectedPrefix(restored)).toBe(0);
    expect(countProtectedPrefix(restored, identity)).toBe(2);
    expect(readGeneration(restored, identity)).toBe(1);
    expect(readGeneration(restored)).toBe(0);
  });
  it('detects timestamp/content corruption and preserves the input on invalid prior', () => {
    const messages = prefix();
    const identity = createCompactionIdentity(messages);
    (messages[0] as { timestamp: number }).timestamp = 2;
    const snapshot = JSON.stringify(messages);
    expect(verifyCompactionIdentity(messages, identity)).toBe(false);
    expect(() => prepareMemoryInput({ messages, cutIndex: 2, identity })).toThrow('invalid_prior_memory');
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
  it('rejects invalid credentials and duplicate or unknown envelope attributes', () => {
    const identity = createCompactionIdentity(prefix());
    expect(() => validateCompactionIdentity({ ...identity, generation: 1.5 })).toThrow();
    expect(() => validateCompactionIdentity({ ...identity, anchorIndex: 2 })).toThrow();
    const block = prefix()[1]!;
    if (block.role !== 'user' || typeof block.content !== 'string') throw new Error('fixture');
    for (const content of [block.content.replace(' replaced=', ' unknown="x" replaced='),
      block.content.replace(' replaced=', ' generation="1" replaced='), block.content + 'trailer']) {
      expect(() => parseCompactedBlock({ ...block, content })).toThrow();
    }
  });
  it('canonicalizes property order for an identical full message', () => {
    const messages = prefix();
    const identity = createCompactionIdentity(messages);
    messages[0] = { timestamp: 1, content: 'goal', role: 'user' };
    expect(verifyCompactionIdentity(messages, identity)).toBe(true);
  });
  it('rejects cumulative clipping overflow before a summary call could start', () => {
    const prior = { ...memory, coverage: { ...memory.coverage,
      clippedToolResults: Array.from({ length: 200 }, (_, index) => ({ messageId: `g1:m${index + 1}`, omittedChars: 1 })) } };
    const messages: Message[] = [{ role: 'user', content: 'goal' },
      buildCompactedBlock({ memory: prior, replaced: 201, turns: 1, anchor: 'verbatim', generation: 1 }),
      { role: 'assistant', content: [{ type: 'tool_call', toolCallId: 'new', toolName: 'read', args: {} }] },
      { role: 'tool_result', toolCallId: 'new', content: 'x'.repeat(4000) }, { role: 'user', content: 'tail' }];
    expect(() => prepareMemoryInput({ messages, cutIndex: 4, identity: createCompactionIdentity(messages) })).toThrow('protected_memory_too_large');
  });
});
