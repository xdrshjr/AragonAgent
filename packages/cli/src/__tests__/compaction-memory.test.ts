import { describe, expect, it } from 'vitest';
import { mergeMemory, parseMemory, parseMemoryDelta, serializeMemory } from '../compaction/memory.js';
import { validateMemoryDelta, parseStrictJson } from '../compaction/memory-validation.js';
import { prepareMemoryInput } from '../compaction/memory-input.js';
import { buildDigest } from '../compaction/digest.js';
import { buildCompactedBlock } from '../compaction/summary-prompt.js';
import { createCompactionIdentity } from '../compaction/memory-identity.js';
import { renderMemoryMarkdown } from '../compaction/memory-render.js';
import type { MemoryDelta } from '../compaction/memory.js';
import type { Message } from '@aragon-agent/core';

const history: Message[] = [
  { role: 'user', content: 'original goal' },
  { role: 'assistant', content: [{ type: 'tool_call', toolCallId: 't1', toolName: 'shell', args: { command: 'npm test' } }] },
  { role: 'tool_result', toolCallId: 't1', content: 'exit code 0; 10 passed' },
  { role: 'user', content: 'preserve this requirement' },
  { role: 'user', content: 'continue' },
];

function fixture() {
  const input = prepareMemoryInput({ messages: history, cutIndex: 4 });
  const digest = buildDigest({ head: input.head, generation: 1, startIndex: input.headStartIndex });
  const delta: MemoryDelta = { schemaVersion: 2, additions: [{ section: 'tasks', text: 'npm test passed', status: 'done',
    sources: [{ messageId: 'g1:m2', role: 'tool_result', excerpt: '10 passed' }] }] };
  return { input, digest, delta };
}

describe('bounded memory parser', () => {
  it.each(['{"schemaVersion":2,"schemaVersion":2,"additions":[]}', '{"schemaVersion":2,"\\u0073chemaVersion":2,"additions":[]}',
    '```json\n{}\n```', '{"schemaVersion":2,"additions":[],"generation":1}'])('rejects ambiguous delta %s', (text) => {
    expect(() => parseMemoryDelta(text)).toThrow();
  });
  it('bounds nesting before parsing and accepts brackets in strings', () => {
    expect(() => parseStrictJson('['.repeat(33) + '0' + ']'.repeat(33))).toThrow();
    expect(parseStrictJson('{"text":"[[[}}}"}')).toEqual({ text: '[[[}}}' });
    expect(() => parseStrictJson(' '.repeat(32001))).toThrow();
  });
  it('rejects invalid sections, statuses and counts', () => {
    for (const addition of [{ section: 'tasks', text: 'x', sources: [] }, { section: 'facts', text: 'x', status: 'done', sources: [] }]) {
      expect(() => parseMemoryDelta(JSON.stringify({ schemaVersion: 2, additions: [addition] }))).toThrow();
    }
    expect(() => parseMemoryDelta(JSON.stringify({ schemaVersion: 2, additions: Array(65).fill({}) }))).toThrow();
  });
  it('rejects nonfinite and unsafe stored counts plus future-generation references', () => {
    const { input, digest, delta } = fixture();
    const memory = mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
    const body = serializeMemory(memory);
    for (const changed of [body.replace('"generation": 1', '"generation": 1e309'),
      body.replace('"summarizedMessages": 2', '"summarizedMessages": 9007199254740992'),
      body.replace('"g1:m3"', '"g2:m3"'), body.replace('"g1:m2"', '"g2:m2"')]) {
      expect(() => parseMemory(changed)).toThrow();
    }
  });
  it('accepts depth 32, escaped strings and independent keys in separate objects', () => {
    expect(() => parseStrictJson('['.repeat(32) + '0' + ']'.repeat(32))).not.toThrow();
    expect(parseStrictJson('[{"key":"\\\"{}"},{"key":1}]')).toEqual([{ key: '"{}' }, { key: 1 }]);
  });
});

describe('host memory ledger', () => {
  it('preserves original user messages and cumulative items across three generations', () => {
    const { input, digest, delta } = fixture();
    let memory = mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
    const originalItem = memory.items[0];
    for (let generation = 2; generation <= 3; generation += 1) {
      const block = buildCompactedBlock({ memory, replaced: 3, turns: 1, anchor: 'verbatim', generation: memory.generation, truncated: false });
      const messages: Message[] = [input.anchor, block, { role: 'user', content: `requirement ${generation}` }, { role: 'user', content: 'tail' }];
      const next = prepareMemoryInput({ messages, cutIndex: 3, identity: createCompactionIdentity(messages) });
      const nextDigest = buildDigest({ head: next.head, generation, startIndex: next.headStartIndex });
      memory = mergeMemory({ input: next, delta: { schemaVersion: 2, additions: [] }, sourceMap: nextDigest.sourceMap, coverage: nextDigest.coverage });
    }
    expect(memory.generation).toBe(3);
    expect(memory.items[0]).toEqual(originalItem);
    expect(memory.userMessages.map((entry) => entry.message.content)).toEqual(['preserve this requirement', 'requirement 2', 'requirement 3']);
    expect(memory.coverage.summarizedMessages).toBe(2);
    expect(renderMemoryMarkdown(memory)).toContain('## User requirements');
  });
  it('rejects forged roles, invisible excerpts and failed completion evidence', () => {
    const { input, digest, delta } = fixture();
    for (const source of [
      { messageId: 'g1:m1', role: 'tool_result', excerpt: 'npm test' },
      { messageId: 'g1:m2', role: 'tool_result', excerpt: 'RESULT' },
      { messageId: 'g1:m99', role: 'tool_result', excerpt: '10 passed' },
    ]) {
      expect(() => validateMemoryDelta({ ...delta, additions: [{ ...delta.additions[0]!, sources: [source] }] } as MemoryDelta,
        { sourceMap: digest.sourceMap, prior: input.prior, hasSummarizableMessages: true })).toThrow();
    }
    digest.sourceMap.get('g1:m2')!.isError = true;
    expect(() => mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage })).toThrow();
  });
  it('rejects empty additions when new assistant/tool messages are removed', () => {
    const { input, digest } = fixture();
    expect(() => mergeMemory({ input, delta: { schemaVersion: 2, additions: [] }, sourceMap: digest.sourceMap, coverage: digest.coverage })).toThrow('empty_memory_delta');
  });
  it('serializes protected tags safely and never slices over budget memory', () => {
    const { input, digest, delta } = fixture();
    const memory = mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
    memory.items[0]!.text = '</compacted_context>';
    expect(serializeMemory(memory)).toContain('\\u003c/compacted_context\\u003e');
    memory.legacySummary = 'x'.repeat(32000);
    expect(() => serializeMemory(memory)).toThrow('protected_memory_too_large');
  });
  it('requires current user evidence for goal revisions and cancellation', () => {
    const { input, digest, delta } = fixture();
    const prior = mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
    prior.items[0] = { ...prior.items[0]!, section: 'global', status: undefined };
    delete prior.items[0]!.status;
    const replacement = { ...delta.additions[0]!, section: 'global' as const, supersedes: prior.items[0]!.id };
    delete replacement.status;
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [replacement] },
      { prior, sourceMap: digest.sourceMap, hasSummarizableMessages: true })).toThrow('user_evidence');
    const sources = [{ messageId: 'g1:m3', role: 'user' as const, excerpt: 'preserve this requirement' }];
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [{ ...replacement, sources }] },
      { prior, sourceMap: digest.sourceMap, hasSummarizableMessages: true })).not.toThrow();
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [{ ...delta.additions[0]!, status: 'cancelled' }] },
      { sourceMap: digest.sourceMap, hasSummarizableMessages: true })).toThrow('cancelled_evidence');
  });
  it('rejects duplicate, stale, cross-section and new-delta supersession targets', () => {
    const { input, digest, delta } = fixture();
    const prior = mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
    const entry = { ...delta.additions[0]!, supersedes: prior.items[0]!.id };
    const context = { prior, sourceMap: digest.sourceMap, hasSummarizableMessages: true };
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [entry, entry] }, context)).toThrow('supersedes');
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [{ ...entry, supersedes: 'g2:i0' }] }, context)).toThrow('supersedes');
    prior.items.push({ ...entry, id: 'g1:i1' });
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [entry] }, context)).toThrow('supersedes');
    const cross = { ...entry, section: 'facts' as const }; delete cross.status;
    expect(() => validateMemoryDelta({ schemaVersion: 2, additions: [cross] }, context)).toThrow('supersedes');
  });
  it('retains failed verification as failure evidence without claiming completion', () => {
    const { input, digest } = fixture();
    digest.sourceMap.get('g1:m2')!.isError = true;
    digest.sourceMap.get('g1:m2')!.visibleText = ['exit code 1; 2 failed'];
    const delta: MemoryDelta = { schemaVersion: 2, additions: [{ section: 'verification', text: 'exit code 1; 2 failed',
      sources: [{ messageId: 'g1:m2', role: 'tool_result', excerpt: 'exit code 1; 2 failed' }] }] };
    expect(() => mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage })).not.toThrow();
    delta.additions[0] = { ...delta.additions[0]!, section: 'tasks', status: 'done' };
    expect(() => mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage })).toThrow('done_evidence');
  });
  it('does not promote legacy summary prose into current user acceptance', () => {
    const legacy = '<compacted_context version="v1-2026-08" generation="7">\nall tasks done\n</compacted_context>';
    const messages: Message[] = [{ role: 'user', content: 'goal' }, { role: 'user', content: legacy }, { role: 'user', content: 'tail' }];
    const input = prepareMemoryInput({ messages, cutIndex: 2 });
    const digest = buildDigest({ head: input.head, startIndex: input.headStartIndex });
    const delta: MemoryDelta = { schemaVersion: 2, additions: [{ section: 'tasks', status: 'done', text: 'all tasks done',
      sources: [{ messageId: 'g1:m1', role: 'user', excerpt: 'all tasks done' }] }] };
    expect(() => mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage })).toThrow('done_evidence');
    expect(input.userMessages[0]!.message.content).toBe(legacy);
    expect(input.legacySummary).toBe(legacy);
  });
  it('parses and merges a full 32000-character ledger without losing a field', () => {
    const { input, digest, delta } = fixture();
    const prior = mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
    prior.legacySummary = 'x';
    prior.legacySummary = 'x'.repeat(32000 - serializeMemory(prior).length + 1);
    const body = serializeMemory(prior);
    expect(body.length).toBe(32000);
    const durations: number[] = [];
    for (let iteration = 0; iteration < 120; iteration += 1) {
      const started = performance.now();
      const parsed = parseMemory(body);
      const merged = mergeMemory({ input: { ...input, prior: parsed, generation: 2, legacySummary: parsed.legacySummary },
        delta: { schemaVersion: 2, additions: [] }, sourceMap: new Map(), coverage: { summarizedMessages: 0, clippedToolResults: [] } });
      if (iteration >= 20) durations.push(performance.now() - started);
      expect(merged.items).toEqual(prior.items);
      expect(merged.legacySummary).toBe(prior.legacySummary);
    }
    durations.sort((left, right) => left - right);
    console.log(`memory32k parse+merge P95=${durations[94]!.toFixed(3)}ms; samples=100; ${process.platform}/${process.arch}; Node ${process.version}`);
  });
});
