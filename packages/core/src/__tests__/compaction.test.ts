/**
 * Pure compaction mechanics (context-auto-compaction §8.1, core half).
 *
 * The three functions here are the whole of the engine's contribution, and the
 * third one — `validateHistory` — is the only thing standing between a host bug
 * and a permanently un-sendable conversation (R-2). It gets a property test.
 */

import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from '../llm/types.js';
import {
  findSafeCutIndices,
  planCompaction,
  validateHistory,
} from '../engine/compaction.js';

function user(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantText(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantCalls(...ids: string[]): AssistantMessage {
  return {
    role: 'assistant',
    content: ids.map((id) => ({ type: 'tool_call' as const, toolCallId: id, toolName: 'bash', args: {} })),
  };
}

function toolResult(id: string): ToolResultMessage {
  return { role: 'tool_result', toolCallId: id, content: 'ok' };
}

describe('findSafeCutIndices', () => {
  it('returns [0, len] for a single user message', () => {
    expect(findSafeCutIndices([user('hi')])).toEqual([0, 1]);
  });

  it('never offers a tool_result index', () => {
    const messages: Message[] = [user('go'), assistantCalls('a'), toolResult('a'), assistantText('done')];
    const safe = findSafeCutIndices(messages);
    expect(safe).not.toContain(2);
    expect(safe).toEqual([0, 1, 3, 4]);
  });

  it('excludes an assistant index while a call is still open', () => {
    // The assistant at index 1 opens `a`; index 2 is the result. Nothing between
    // them is safe, and neither is index 1 itself once we are past it.
    const messages: Message[] = [user('go'), assistantCalls('a', 'b'), toolResult('a'), toolResult('b')];
    expect(findSafeCutIndices(messages)).toEqual([0, 1, 4]);
  });

  it('handles the steering-interrupt shape (3 calls, 3 synthesized results, a user message)', () => {
    const messages: Message[] = [
      user('go'),
      assistantCalls('a', 'b', 'c'),
      toolResult('a'),
      toolResult('b'),
      toolResult('c'),
      user('actually, stop'),
    ];
    const safe = findSafeCutIndices(messages);
    expect(safe).toEqual([0, 1, 5, 6]);
    // The three results are never offered as a cut.
    for (const i of [2, 3, 4]) expect(safe).not.toContain(i);
  });

  it('handles the CodeAct shape (a bare user message after an assistant text turn)', () => {
    const messages: Message[] = [
      user('go'),
      assistantText('```execute-js\n1\n```'),
      user('[Code Execution Result]\nOutput: 1'),
    ];
    expect(findSafeCutIndices(messages)).toEqual([0, 1, 2, 3]);
  });

  it('omits the end index when a call is left open', () => {
    const messages: Message[] = [user('go'), assistantCalls('a')];
    expect(findSafeCutIndices(messages)).toEqual([0, 1]);
  });
});

describe('planCompaction', () => {
  const conversation: Message[] = [
    user('t1'),
    assistantCalls('a'),
    toolResult('a'),
    assistantText('r1'),
    user('t2'),
    assistantText('r2'),
    user('t3'),
    assistantText('r3'),
    user('t4'),
    assistantText('r4'),
  ];

  it('returns the largest safe index leaving >= keepRecentTurns turns', () => {
    const plan = planCompaction(conversation, { keepRecentTurns: 2 });
    expect(plan).not.toBeNull();
    // Turns at indices 0, 4, 6, 8. Keeping 2 means the tail must start at 6.
    expect(plan!.cutIndex).toBe(6);
    expect(plan!.retainedTurns).toBe(2);
    expect(plan!.droppedMessages).toBe(6);
  });

  it('never returns an index that is not in findSafeCutIndices', () => {
    const safe = new Set(findSafeCutIndices(conversation));
    for (const keep of [1, 2, 3, 4]) {
      const plan = planCompaction(conversation, { keepRecentTurns: keep });
      if (plan) expect(safe.has(plan.cutIndex)).toBe(true);
    }
  });

  it('returns null when keepRecentTurns covers the whole conversation', () => {
    expect(planCompaction(conversation, { keepRecentTurns: 4 })).toBeNull();
    expect(planCompaction(conversation, { keepRecentTurns: 99 })).toBeNull();
  });

  it('returns null when the cut would be at or inside protectedPrefix', () => {
    // With keepRecentTurns 3 the cut lands at 4, which is past every prefix
    // below 4 and inside every prefix at or above it.
    expect(planCompaction(conversation, { keepRecentTurns: 3, protectedPrefix: 0 })!.cutIndex).toBe(4);
    expect(planCompaction(conversation, { keepRecentTurns: 3, protectedPrefix: 1 })!.cutIndex).toBe(4);
    expect(planCompaction(conversation, { keepRecentTurns: 3, protectedPrefix: 2 })!.cutIndex).toBe(4);
    expect(planCompaction(conversation, { keepRecentTurns: 3, protectedPrefix: 4 })).toBeNull();
  });

  it('discounts the protected prefix from droppedMessages', () => {
    const plan = planCompaction(conversation, { keepRecentTurns: 2, protectedPrefix: 2 });
    expect(plan!.droppedMessages).toBe(4); // cut 6, minus the 2 carried through
  });

  it('is the idempotence guard: a compacted history with nothing new returns null', () => {
    // The shape §3.6.5 assembles: anchor, block, then the verbatim tail.
    const compacted: Message[] = [
      user('<original_task>t1</original_task>'),
      user('<compacted_context version="v1">summary</compacted_context>'),
      user('t4'),
      assistantText('r4'),
    ];
    expect(planCompaction(compacted, { keepRecentTurns: 1, protectedPrefix: 2 })).toBeNull();
  });
});

describe('validateHistory', () => {
  it('rejects an empty history', () => {
    expect(validateHistory([])).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects an orphan tool_result', () => {
    expect(validateHistory([user('go'), toolResult('a')])).toEqual({
      ok: false,
      reason: 'orphan_tool_result',
    });
  });

  it('rejects an unclosed tool_call', () => {
    expect(validateHistory([user('go'), assistantCalls('a')])).toEqual({
      ok: false,
      reason: 'unclosed_tool_call',
    });
  });

  it('rejects a history that grew', () => {
    const messages: Message[] = [user('a'), user('b'), user('c')];
    expect(validateHistory(messages, { previousLength: 2 })).toEqual({ ok: false, reason: 'grew' });
    expect(validateHistory(messages, { previousLength: 3 })).toEqual({ ok: true });
  });

  it('accepts consecutive user messages (the anchor + block shape)', () => {
    const messages: Message[] = [user('<original_task>x</original_task>'), user('<compacted_context/>'), user('t')];
    expect(validateHistory(messages)).toEqual({ ok: true });
  });

  it('accepts every history planCompaction can produce, over generated histories', () => {
    // AC-8, scaled down for wall clock but with the same generator shape: every
    // cut this module offers must survive its own validator.
    let checked = 0;
    for (let seed = 0; seed < 400; seed += 1) {
      const messages: Message[] = [];
      let rnd = seed * 2654435761;
      const next = (): number => {
        rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
        return rnd;
      };
      let callSeq = 0;
      const length = 4 + (next() % 20);
      for (let i = 0; i < length; i += 1) {
        const roll = next() % 3;
        if (roll === 0) {
          messages.push(user(`u${i}`));
        } else if (roll === 1) {
          messages.push(assistantText(`a${i}`));
        } else {
          const n = 1 + (next() % 3);
          const ids = Array.from({ length: n }, () => `c${(callSeq += 1)}`);
          messages.push(assistantCalls(...ids));
          for (const id of ids) messages.push(toolResult(id));
        }
      }
      // The generator always closes its calls, so the input is valid.
      expect(validateHistory(messages)).toEqual({ ok: true });

      for (const keep of [1, 2, 3]) {
        const plan = planCompaction(messages, { keepRecentTurns: keep });
        if (!plan) continue;
        // The splice §3.6.5 performs: one synthetic anchor + the verbatim tail.
        const spliced: Message[] = [user('<original_task>x</original_task>'), ...messages.slice(plan.cutIndex)];
        expect(validateHistory(spliced, { previousLength: messages.length })).toEqual({ ok: true });
        checked += 1;
      }
    }
    // The loop must actually have exercised something.
    expect(checked).toBeGreaterThan(100);
  });
});
