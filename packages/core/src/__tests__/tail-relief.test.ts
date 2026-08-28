/**
 * `relieveTail` as a pure function
 * (context-auto-compaction-hardening §8.1 / W2).
 *
 * THE PROPERTY TEST IS THE POINT OF THIS FILE. Relief runs on a history the
 * engine is about to adopt, so the one thing it may never do is produce an
 * un-sendable conversation — R-2, the worst outcome this feature has. Case 5
 * asserts that over generated histories rather than over the four shapes a
 * hand-written example happens to cover.
 */

import { describe, expect, it } from 'vitest';
import type { ContentPart, Message, ToolCallBlock } from '../llm/types.js';
import { relieveTail, validateHistory } from '../engine/compaction.js';

const MARKER = (n: number): string => `\n[... ${n} characters removed ...]`;

function user(text: string): Message {
  return { role: 'user', content: text };
}

function call(id: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', toolCallId: id, toolName: 'read', args: {} }],
  };
}

function result(id: string, content: string | ContentPart[]): Message {
  return { role: 'tool_result', toolCallId: id, content };
}

/** Relief with a target of 0 clips everything eligible; the walk never stops early. */
function relieveAll(messages: Message[], clipChars = 100) {
  return relieveTail(messages, {
    from: 0,
    clipChars,
    targetTokens: 0,
    systemPrompt: '',
    marker: MARKER,
  });
}

describe('relieveTail (§3.3.2)', () => {
  it('clips a tool_result string body and appends the host marker', () => {
    const history = [user('go'), call('a'), result('a', 'x'.repeat(5_000))];
    const out = relieveAll(history);

    expect(out.clippedMessages).toBe(1);
    expect(out.charsRemoved).toBe(4_900);
    const clipped = out.messages[2] as { content: string };
    expect(clipped.content.startsWith('x'.repeat(100))).toBe(true);
    expect(clipped.content).toContain('4900 characters removed');
  });

  it('clips text parts of a part-array body, longest first, and leaves image parts', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'a'.repeat(300) },
      { type: 'image', mediaType: 'image/png', data: 'z'.repeat(4_000) },
      { type: 'text', text: 'b'.repeat(9_000) },
    ];
    const out = relieveAll([user('go'), call('a'), result('a', parts)], 100);

    const clipped = out.messages[2] as { content: ContentPart[] };
    // Both oversized text parts are clipped; the image is untouched BY IDENTITY.
    expect((clipped.content[2] as { text: string }).text.startsWith('b'.repeat(100))).toBe(true);
    expect((clipped.content[0] as { text: string }).text.startsWith('a'.repeat(100))).toBe(true);
    expect(clipped.content[1]).toBe(parts[1]);
    expect(out.charsRemoved).toBe(8_900 + 200);
  });

  it('never touches user or assistant messages, even when they are the largest', () => {
    const history: Message[] = [
      user('u'.repeat(50_000)),
      { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(50_000) }] },
    ];
    const out = relieveAll(history);

    expect(out.clippedMessages).toBe(0);
    expect(out.charsRemoved).toBe(0);
    expect(out.messages[0]).toBe(history[0]);
    expect(out.messages[1]).toBe(history[1]);
  });

  it('walks oldest-first and stops as soon as the target is met', () => {
    // Two fat results. Clipping the OLDER one alone brings the estimate under the
    // target, so the NEWER one - the one the next request is most likely to be
    // about - must survive intact.
    const history = [
      user('go'),
      call('a'),
      result('a', 'x'.repeat(40_000)),
      call('b'),
      result('b', 'y'.repeat(4_000)),
    ];
    const out = relieveTail(history, {
      from: 0,
      clipChars: 100,
      // ~1 100 tokens of body remain after the first clip, plus framing.
      targetTokens: 1_500,
      systemPrompt: '',
      marker: MARKER,
    });

    expect(out.clippedMessages).toBe(1);
    expect(out.messages[4]).toBe(history[4]);
  });

  it('preserves validateHistory over 200 generated histories', () => {
    // A DETERMINISTIC GENERATOR, so a failure is reproducible from the seed alone.
    let seed = 12_345;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };

    for (let i = 0; i < 200; i += 1) {
      const history: Message[] = [];
      const turns = 1 + Math.floor(rnd() * 4);
      let id = 0;
      for (let t = 0; t < turns; t += 1) {
        history.push(user('q'.repeat(1 + Math.floor(rnd() * 3_000))));
        const calls = Math.floor(rnd() * 3);
        if (calls > 0) {
          const ids: string[] = [];
          const blocks: ToolCallBlock[] = [];
          for (let c = 0; c < calls; c += 1) {
            const toolCallId = `t${(id += 1)}`;
            ids.push(toolCallId);
            blocks.push({ type: 'tool_call', toolCallId, toolName: 'read', args: {} });
          }
          history.push({ role: 'assistant', content: blocks });
          for (const toolCallId of ids) {
            history.push(
              rnd() < 0.5
                ? result(toolCallId, 'r'.repeat(1 + Math.floor(rnd() * 8_000)))
                : result(toolCallId, [
                    { type: 'text', text: 'p'.repeat(1 + Math.floor(rnd() * 5_000)) },
                  ]),
            );
          }
        } else {
          history.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
        }
      }

      expect(validateHistory(history).ok).toBe(true);
      const relieved = relieveTail(history, {
        from: Math.floor(rnd() * history.length),
        clipChars: 200,
        targetTokens: 0,
        systemPrompt: '',
        marker: MARKER,
      });
      // STRUCTURE IS INVARIANT UNDER RELIEF: same count, same roles, same ids.
      expect(relieved.messages.length).toBe(history.length);
      expect(validateHistory(relieved.messages).ok).toBe(true);
    }
  });

  it('respects `from`: nothing before it changes, by identity', () => {
    const history = [
      user('go'),
      call('a'),
      result('a', 'x'.repeat(9_000)),
      call('b'),
      result('b', 'y'.repeat(9_000)),
    ];
    const out = relieveTail(history, {
      from: 3,
      clipChars: 100,
      targetTokens: 0,
      systemPrompt: '',
      marker: MARKER,
    });

    expect(out.messages[2]).toBe(history[2]);
    expect(out.messages[4]).not.toBe(history[4]);
    expect(out.clippedMessages).toBe(1);
  });

  it('returns charsRemoved: 0 and the same contents when nothing is eligible', () => {
    const history = [user('go'), call('a'), result('a', 'short')];
    const out = relieveAll(history, 2_000);

    expect(out.clippedMessages).toBe(0);
    expect(out.charsRemoved).toBe(0);
    expect(out.messages).toEqual(history);
    expect(out.messages).not.toBe(history);
  });

  it('does nothing at all when the history already fits', () => {
    const history = [user('go'), call('a'), result('a', 'x'.repeat(9_000))];
    const out = relieveTail(history, {
      from: 0,
      clipChars: 100,
      targetTokens: 1_000_000,
      systemPrompt: '',
      marker: MARKER,
    });

    expect(out.clippedMessages).toBe(0);
    expect(out.messages[2]).toBe(history[2]);
  });
});
