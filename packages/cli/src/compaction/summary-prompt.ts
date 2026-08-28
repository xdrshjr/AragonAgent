/**
 * The summarizer's system prompt and the `<compacted_context>` splice
 * (context-auto-compaction §3.6.4 / §3.6.5).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * PURE. Every input arrives as an argument, so the block a session produced can
 * be reconstructed from a bug report with one call.
 */

import type { ContentPart, Message, UserMessage } from '@aragon-agent/core';
import {
  ANCHOR_TAG_CLOSE,
  ANCHOR_TAG_OPEN,
  ANCHOR_TRUNCATION_MARK,
  BLOCK_TAG_CLOSE,
  BLOCK_TAG_OPEN,
  COMPACTION_BLOCK_VERSION,
  COMPACTION_LIMITS,
} from './limits.js';
import { isPriorSummaryBlock } from './digest.js';

/**
 * The section skeleton the summary must fill.
 *
 * THE HEADINGS ARE PART OF THE CONTRACT, because the next model to read them is
 * an LLM: a summary with predictable sections can be scanned for "what is still
 * open" without re-reading the whole thing.
 */
export function buildSummarySystemPrompt(opts: {
  maxChars: number;
  /** Free text from `/compact <instructions>`, appended as `## Focus`. */
  instructions?: string;
  /** True when the digest opens with a `PRIOR SUMMARY` section. */
  hasPriorSummary: boolean;
}): string {
  const lines = [
    'You are compacting a software-engineering conversation so the agent can keep working',
    'after older messages are dropped from its context window.',
    '',
    'Write a record of the conversation below using EXACTLY these sections, in this order:',
    '',
    '## Task',
    "The user's original goal, and any revision to it.",
    '## Decisions',
    'What was decided and why. One line each.',
    '## Files',
    'path -> what changed in it, or what is in it that matters.',
    '## Facts',
    'Commands, paths, APIs, identifiers and values discovered. Verbatim where exactness matters.',
    '## Open',
    'What remains to be done, in the order it should be done.',
    '## Pitfalls',
    'What was tried and did not work, so it is not tried again.',
    '',
    'Rules:',
    `- Stay under ${opts.maxChars} characters in total.`,
    '- Prefer verbatim identifiers, paths and commands over prose describing them.',
    '- NEVER invent a fact the transcript does not contain. An empty section is correct',
    '  when the transcript says nothing about it; write "(none)" under it.',
    '- Write in the language of the conversation.',
    '- Output the sections and nothing else. No preamble, no sign-off.',
  ];

  if (opts.hasPriorSummary) {
    // WITHOUT THIS CLAUSE the second compaction is a model deciding, with no
    // instruction either way, how much of a summary a summary needs - which is
    // the mechanism by which flattened summaries decay into nothing over a long
    // run (D-22 / R-14).
    lines.push(
      '',
      'The transcript below OPENS WITH A `PRIOR SUMMARY` SECTION. That section is an',
      'authoritative record of everything that came before it, produced by an earlier',
      'compaction of this same conversation. MERGE IT AND CARRY IT FORWARD - do not',
      're-condense it. Facts, file paths and pitfalls already recorded there are to be',
      'reproduced, not paraphrased away, and anything it marks as incomplete stays marked.',
    );
  }

  if (opts.instructions && opts.instructions.trim().length > 0) {
    lines.push(
      '',
      '## Focus',
      'The user asked you to pay particular attention to the following. Keep everything',
      'the sections above require, and be more detailed where it is relevant:',
      opts.instructions.trim(),
    );
  }

  return lines.join('\n');
}

/** The user message the summarization call sends: the digest, and nothing else. */
export function buildSummaryUserMessage(digest: string, now: number): UserMessage {
  return { role: 'user', content: digest, timestamp: now };
}

// ---------------------------------------------------------------------------
// The splice (§3.6.5)
// ---------------------------------------------------------------------------

export type AnchorShape = 'tagged' | 'verbatim';

export interface AnchorInfo {
  /** The message to place first, verbatim in the history. */
  message: Message;
  shape: AnchorShape;
}

function contentIsParts(content: unknown): content is ContentPart[] {
  return Array.isArray(content);
}

function firstText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
}

/**
 * Recognize an anchor this feature produced on a previous pass.
 *
 * STRUCTURAL, NOT LENGTH-DEPENDENT (D-21 / P1-9). v1 of the design identified
 * the anchor as "the first `user` message of the conversation" and chose between
 * two shapes by length. Neither rule composes across repeated compactions,
 * because after the first pass the first user message IS the compacted block:
 * the merged shape promotes a SUMMARY to "the user's original task", and the
 * standalone shape keeps the block as an anchor AND re-digests it. Neither
 * failure raises anything, and both get worse every pass.
 */
export function isTaggedAnchor(message: Message): boolean {
  if (message.role !== 'user') return false;
  return firstText(message.content).trimStart().startsWith(ANCHOR_TAG_OPEN);
}

/**
 * Build (or carry through) the leading anchor.
 *
 * ALWAYS ITS OWN LEADING MESSAGE, AND ALWAYS STRUCTURALLY IDENTIFIABLE. A
 * summarizer that is 90 % faithful is fine for the middle of a conversation and
 * catastrophic for the sentence that says what the user wanted (D-6).
 */
export function buildAnchor(messages: readonly Message[]): AnchorInfo | null {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return null;

  // Already ours: carry it through byte-for-byte. This is what makes the rule
  // idempotent across an unbounded number of compactions.
  if (isTaggedAnchor(first)) return { message: first, shape: 'tagged' };

  // A message carrying `ContentPart[]` may depend on an IMAGE, which no tag can
  // wrap and no clip can preserve. It is kept byte-for-byte verbatim, and the
  // block records `anchor="verbatim"` so the next pass recognizes it by position
  // rather than by a tag it cannot carry.
  if (contentIsParts(first.content)) {
    return { message: first, shape: 'verbatim' };
  }

  const raw = first.content;
  const clipped =
    raw.length > COMPACTION_LIMITS.anchorChars
      ? `${raw.slice(0, COMPACTION_LIMITS.anchorChars)}${ANCHOR_TRUNCATION_MARK}`
      : raw;
  const message: UserMessage = {
    role: 'user',
    content: `${ANCHOR_TAG_OPEN}\n${clipped}\n${ANCHOR_TAG_CLOSE}`,
    ...(first.timestamp !== undefined ? { timestamp: first.timestamp } : {}),
  };
  return { message, shape: 'tagged' };
}

/**
 * How many leading messages are ALREADY structurally preserved, and must be
 * carried through untouched rather than digested.
 *
 * This is `planCompaction`'s `protectedPrefix` (§3.6.2). The HOST computes it
 * because it is the host that knows what an `<original_task>` message is; core
 * stays free of any knowledge of the block format.
 */
export function countProtectedPrefix(messages: readonly Message[]): number {
  const first = messages[0];
  if (!first) return 0;

  // Case 1 — a TAGGED anchor identifies itself. The block, if any, is next.
  if (isTaggedAnchor(first)) {
    return messages[1] && isPriorSummaryBlock(messages[1]!) ? 2 : 1;
  }

  // Case 2 — a VERBATIM anchor is not self-identifying (no tag can wrap the image
  // it exists to preserve), so it is recognized BY POSITION: a `user` message at
  // index 0 followed IMMEDIATELY by our block. `messages[1]`, never `messages[n]`
  // — reading the slot the anchor itself occupies is an off-by-one whose only
  // symptom is that a verbatim-anchor session re-digests its own anchor and block
  // on every subsequent compaction, which is the exact P1-9 decay this function
  // exists to prevent, arriving through the back door.
  if (first.role === 'user' && messages[1] && isPriorSummaryBlock(messages[1]!)) return 2;

  // Case 3 — no anchor of ours, but a block at the head anyway (a history hand-
  // edited, or restored from a file this feature did not write).
  if (isPriorSummaryBlock(first)) return 1;

  return 0;
}

/** Read `generation="N"` off a prior block, so the next one can say `N + 1`. */
export function readGeneration(messages: readonly Message[]): number {
  for (const message of messages) {
    if (!isPriorSummaryBlock(message)) continue;
    const text = firstText(message.content as string | ContentPart[]);
    const match = /generation="(\d+)"/.exec(text);
    if (match) return Number.parseInt(match[1]!, 10);
    return 1;
  }
  return 0;
}

export interface BlockInput {
  summary: string;
  replaced: number;
  turns: number;
  anchor: AnchorShape;
  generation: number;
  /** True for a `mode: 'truncated'` splice — the model is entitled to know. */
  truncated: boolean;
}

/** The body used when the ladder ran out and there is no summary (§3.7 rung 3). */
export function truncationBody(replaced: number): string {
  return (
    `${replaced} earlier ${replaced === 1 ? 'message was' : 'messages were'} dropped to free ` +
    'context. Their content is not available. Do not assume anything about what they ' +
    'contained; ask the user if you need it.'
  );
}

/**
 * The spliced block.
 *
 * A `user` MESSAGE, NEVER A FABRICATED ASSISTANT ONE (D-5). An assistant message
 * claiming the model said something it did not is a lie the model will then act
 * on, and it corrupts every subsequent turn. The XML tag is the same disclosure
 * device `<fast_review>` and `<skill>` already use in this codebase, and the
 * instruction line is what stops the model reading the block as the user ASKING
 * for a summary.
 */
export function buildCompactedBlock(input: BlockInput): UserMessage {
  const body = input.summary.slice(0, COMPACTION_LIMITS.summaryMaxChars);
  const header =
    `${BLOCK_TAG_OPEN} version="${COMPACTION_BLOCK_VERSION}" replaced="${input.replaced}" ` +
    `turns="${input.turns}" anchor="${input.anchor}" generation="${input.generation}">`;
  const intro = [
    'The conversation above this point was compacted to free context. The following',
    'is an accurate record of it. Continue the work from here; do not re-derive this',
    'history, do not ask the user to repeat it, and do not apologise for the gap.',
  ];
  if (input.truncated) {
    intro.push(
      '',
      'THE RECORD IS INCOMPLETE: summarization failed, so the dropped messages were not',
      'summarized at all. Treat anything not stated below as unknown rather than absent.',
    );
  }
  return {
    role: 'user',
    content: `${header}\n${intro.join('\n')}\n\n${body}\n${BLOCK_TAG_CLOSE}`,
    timestamp: Date.now(),
  };
}
