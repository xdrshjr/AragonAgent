/**
 * The digest, the anchor and the splice block (context-auto-compaction §8.1,
 * CLI half — digest / prompt).
 *
 * The PRIOR SUMMARY assertions guard P1-9, which fails QUIETLY: a per-kind clip
 * would discard up to two thirds of the previous summary before re-summarizing
 * it, and every card would still say `summarized`. The loss compounds on every
 * subsequent compaction.
 */

import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, type AssistantMessage, type Message } from '@aragon-agent/core';
import { buildDigest, digestBudgetChars, isPriorSummaryBlock } from '../compaction/digest.js';
import {
  buildAnchor,
  buildCompactedBlock,
  buildSummarySystemPrompt,
  countProtectedPrefix,
  isTaggedAnchor,
  readGeneration,
  truncationBody,
} from '../compaction/summary-prompt.js';
import { COMPACTION_BLOCK_VERSION, COMPACTION_LIMITS } from '../compaction/limits.js';

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistant(...blocks: AssistantMessage['content']): Message {
  return { role: 'assistant', content: blocks };
}

function toolResult(id: string, content: string, isError = false): Message {
  return { role: 'tool_result', toolCallId: id, content, isError };
}

describe('digestBudgetChars (§3.6.3 / R-4)', () => {
  it('is the constant when the summarizer window is unknown', () => {
    expect(digestBudgetChars()).toBe(COMPACTION_LIMITS.digestMaxChars);
    expect(digestBudgetChars(0)).toBe(COMPACTION_LIMITS.digestMaxChars);
  });

  it('is the MIN of the constant and the window derivation', () => {
    // A 32 k summarizer: (32000 - 8000) * 4 = 96 000, under the 120 000 ceiling.
    expect(digestBudgetChars(32_000)).toBe(
      (32_000 - COMPACTION_LIMITS.summarizerReserveTokens) * CHARS_PER_TOKEN,
    );
    // A 200 k summarizer is bounded by the constant instead.
    expect(digestBudgetChars(200_000)).toBe(COMPACTION_LIMITS.digestMaxChars);
  });

  it('falls back to the constant when the reserve exceeds the window', () => {
    expect(digestBudgetChars(4000)).toBe(COMPACTION_LIMITS.digestMaxChars);
  });
});

describe('buildDigest — rendering by kind (§3.6.3)', () => {
  it('renders each kind with its own prefix', () => {
    const { text } = buildDigest({
      head: [
        user('do the thing'),
        assistant(
          { type: 'text', text: 'on it' },
          { type: 'tool_call', toolCallId: 'c1', toolName: 'bash', args: { cmd: 'ls' } },
        ),
        toolResult('c1', 'a.ts\nb.ts'),
        toolResult('c2', 'boom', true),
      ],
    });
    expect(text).toContain('USER: do the thing');
    expect(text).toContain('ASSISTANT: on it');
    expect(text).toContain('CALL bash({"cmd":"ls"})');
    expect(text).toContain('RESULT[ok] a.ts');
    expect(text).toContain('RESULT[error] boom');
  });

  it('drops thinking blocks entirely (D-8)', () => {
    const { text } = buildDigest({
      head: [
        assistant(
          { type: 'thinking', text: 'SECRET-SCRATCH-'.repeat(500) },
          { type: 'text', text: 'answer' },
        ),
      ],
    });
    expect(text).not.toContain('SECRET-SCRATCH');
    expect(text).toContain('ASSISTANT: answer');
  });

  it('clips each kind to its own bound', () => {
    const { text } = buildDigest({
      head: [
        user('u'.repeat(10_000)),
        assistant({ type: 'text', text: 'a'.repeat(10_000) }),
        toolResult('c1', 'r'.repeat(10_000)),
      ],
    });
    const userLine = text.split('\n').find((l) => l.startsWith('USER:'))!;
    const asstLine = text.split('\n').find((l) => l.startsWith('ASSISTANT:'))!;
    const resultLine = text.split('\n').find((l) => l.startsWith('RESULT'))!;
    // prefix + clip + the three-dot marker.
    expect(userLine.length).toBeLessThanOrEqual('USER: '.length + COMPACTION_LIMITS.userChars + 3);
    expect(asstLine.length).toBeLessThanOrEqual(
      'ASSISTANT: '.length + COMPACTION_LIMITS.assistantChars + 3,
    );
    expect(resultLine.length).toBeLessThanOrEqual(
      'RESULT[ok] '.length + COMPACTION_LIMITS.toolResultChars + 3,
    );
  });

  it('names an image part rather than dropping it', () => {
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ],
    };
    expect(buildDigest({ head: [withImage] }).text).toContain('[image]');
  });
});

describe('buildDigest — eviction (§3.6.3)', () => {
  it('drops OLDEST first and prepends the omission marker exactly when it did', () => {
    const clean = buildDigest({ head: [user('one'), user('two')] });
    expect(clean.omitted).toBe(0);
    expect(clean.text).not.toContain('omitted from this digest');

    // A window small enough that only the tail survives.
    const head = Array.from({ length: 40 }, (_, i) => user(`msg-${i}-${'x'.repeat(400)}`));
    const evicted = buildDigest({ head, summarizerWindow: 10_000 });
    expect(evicted.omitted).toBeGreaterThan(0);
    expect(evicted.text).toContain('omitted from this digest');
    // The OLDEST are gone and the NEWEST survive.
    expect(evicted.text).not.toContain('msg-0-');
    expect(evicted.text).toContain('msg-39-');
  });
});

describe('P1-9 / D-22 — a prior <compacted_context> block', () => {
  const priorBody = 'S'.repeat(5500);
  const priorBlock = buildCompactedBlock({
    summary: priorBody,
    replaced: 100,
    turns: 12,
    anchor: 'tagged',
    generation: 1,
    truncated: false,
  });

  it('is recognized as a block rather than an ordinary user message', () => {
    expect(isPriorSummaryBlock(priorBlock)).toBe(true);
    expect(isPriorSummaryBlock(user('just a message'))).toBe(false);
  });

  it('is carried WHOLE at up to summaryMaxChars, not clipped to userChars', () => {
    // The failing version clips this to 2 000 — discarding two thirds of the
    // previous summary BEFORE summarizing it, then reporting `summarized`.
    const { text } = buildDigest({ head: [priorBlock, user('new work')] });
    expect(text).toContain('PRIOR SUMMARY:');
    // All 5 500 characters of the body survive.
    expect(text).toContain(priorBody);
    expect(text).not.toContain('USER: <compacted_context');
  });

  it('is evicted LAST of all — it is the densest thing in the head', () => {
    const head: Message[] = [
      priorBlock,
      ...Array.from({ length: 60 }, (_, i) => user(`filler-${i}-${'y'.repeat(600)}`)),
    ];
    const { text, omitted } = buildDigest({ head, summarizerWindow: 12_000 });
    expect(omitted).toBeGreaterThan(0);
    expect(text).toContain('PRIOR SUMMARY:');
    expect(text).not.toContain('filler-0-');
  });

  it('makes the summarizer prompt say MERGE rather than condense', () => {
    const merging = buildSummarySystemPrompt({ maxChars: 6000, hasPriorSummary: true });
    expect(merging).toContain('PRIOR SUMMARY');
    expect(merging).toContain('MERGE IT AND CARRY IT FORWARD');
    const plain = buildSummarySystemPrompt({ maxChars: 6000, hasPriorSummary: false });
    expect(plain).not.toContain('MERGE IT AND CARRY IT FORWARD');
  });

  it('appends /compact instructions as a Focus directive', () => {
    const focused = buildSummarySystemPrompt({
      maxChars: 6000,
      hasPriorSummary: false,
      instructions: 'keep every SQL query verbatim',
    });
    expect(focused).toContain('## Focus');
    expect(focused).toContain('keep every SQL query verbatim');
  });
});

describe('D-21 / P1-9 — the goal anchor is idempotent', () => {
  it('tags a plain-text first message and keeps it recognizable', () => {
    const anchor = buildAnchor([user('build me a parser'), assistant({ type: 'text', text: 'ok' })])!;
    expect(anchor.shape).toBe('tagged');
    expect(isTaggedAnchor(anchor.message)).toBe(true);
    expect(anchor.message.content).toContain('build me a parser');
  });

  it('CARRIES THROUGH an anchor it already produced, byte for byte', () => {
    // This is the whole of idempotence: on pass 2 the first user message is the
    // anchor, and re-tagging it would nest `<original_task>` inside itself.
    const first = buildAnchor([user('build me a parser')])!;
    const second = buildAnchor([first.message, user('and now the tests')])!;
    expect(second.message).toBe(first.message);
    expect(second.shape).toBe('tagged');
    const text = second.message.content as string;
    expect(text.split('<original_task>').length - 1).toBe(1);
  });

  it('clips past anchorChars with a visible marker rather than switching shape', () => {
    const anchor = buildAnchor([user('T'.repeat(50_000))])!;
    expect(anchor.shape).toBe('tagged');
    const text = anchor.message.content as string;
    expect(text).toContain('[truncated]');
    expect(text.length).toBeLessThan(COMPACTION_LIMITS.anchorChars + 200);
    // AC-7 is mechanical: the first `anchorChars` of the original are present.
    expect(text).toContain('T'.repeat(COMPACTION_LIMITS.anchorChars));
  });

  it('keeps a ContentPart[] first message verbatim and marks it', () => {
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this screenshot' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      ],
    };
    const anchor = buildAnchor([withImage])!;
    expect(anchor.shape).toBe('verbatim');
    // BYTE-FOR-BYTE: no tag can wrap an image and no clip can preserve it.
    expect(anchor.message).toBe(withImage);
  });

  it('returns null for a history with no user message at all', () => {
    expect(buildAnchor([assistant({ type: 'text', text: 'orphan' })])).toBeNull();
  });
});

describe('countProtectedPrefix (§3.6.2 / §3.6.5)', () => {
  const anchor = buildAnchor([user('the task')])!.message;
  const block = buildCompactedBlock({
    summary: 'a summary',
    replaced: 10,
    turns: 3,
    anchor: 'tagged',
    generation: 1,
    truncated: false,
  });

  it('is 0 for a fresh conversation', () => {
    expect(countProtectedPrefix([user('hi'), assistant({ type: 'text', text: 'yo' })])).toBe(0);
  });

  it('is 2 after one compaction — the anchor and the block', () => {
    expect(countProtectedPrefix([anchor, block, user('next')])).toBe(2);
  });

  it('is 1 when the anchor is tagged but no block follows', () => {
    expect(countProtectedPrefix([anchor, user('next')])).toBe(1);
  });

  it('recognizes a VERBATIM anchor by position — message 0 followed by the block', () => {
    const image: Message = {
      role: 'user',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
    };
    expect(countProtectedPrefix([image, block, user('next')])).toBe(2);
  });
});

describe('the spliced block (§3.6.5 / D-5)', () => {
  it('is a USER message carrying the version, counts, anchor shape and generation', () => {
    const block = buildCompactedBlock({
      summary: '## Task\nship it',
      replaced: 112,
      turns: 17,
      anchor: 'tagged',
      generation: 2,
      truncated: false,
    });
    expect(block.role).toBe('user');
    const text = block.content as string;
    expect(text).toContain(`version="${COMPACTION_BLOCK_VERSION}"`);
    expect(text).toContain('replaced="112"');
    expect(text).toContain('turns="17"');
    expect(text).toContain('anchor="tagged"');
    expect(text).toContain('generation="2"');
    expect(text).toContain('## Task');
    // The instruction line is what stops the model reading this as the USER
    // asking for a summary.
    expect(text).toContain('Continue the work from here');
  });

  it('says so INSIDE the block when the record is truncated (§6.4)', () => {
    const block = buildCompactedBlock({
      summary: truncationBody(103),
      replaced: 103,
      turns: 9,
      anchor: 'tagged',
      generation: 1,
      truncated: true,
    });
    const text = block.content as string;
    // The model reading the block is entitled to know the record is incomplete.
    expect(text).toContain('THE RECORD IS INCOMPLETE');
    expect(text).toContain('103 earlier messages were dropped');
  });

  it('clips the summary to summaryMaxChars', () => {
    const block = buildCompactedBlock({
      summary: 'z'.repeat(50_000),
      replaced: 1,
      turns: 1,
      anchor: 'tagged',
      generation: 1,
      truncated: false,
    });
    const text = block.content as string;
    expect(text.length).toBeLessThan(COMPACTION_LIMITS.summaryMaxChars + 1000);
  });

  it('readGeneration reads its own output back, and is 0 on a fresh history', () => {
    const gen3 = buildCompactedBlock({
      summary: 's',
      replaced: 1,
      turns: 1,
      anchor: 'verbatim',
      generation: 3,
      truncated: false,
    });
    expect(readGeneration([user('a'), gen3, user('b')])).toBe(3);
    expect(readGeneration([user('a'), user('b')])).toBe(0);
  });
});
