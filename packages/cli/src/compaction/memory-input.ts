/** Prepare protected host input and move multimodal messages behind safe cuts. */
import { findSafeCutIndices, type Message, type UserMessage } from '@aragon-agent/core';
import {
  assertProtectedMemoryBudget,
  isLegacyMemoryText,
  MemoryError,
  type CompactionMemory,
  type ProtectedUserMessage,
} from './memory.js';
import { parseCompactedBlock, type AnchorShape } from './summary-prompt.js';
import { verifyCompactionIdentity, type CompactionIdentity } from './memory-identity.js';
import { COMPACTION_LIMITS as LIMITS } from './limits.js';
import { buildDigest } from './digest.js';

export interface PreparedMemoryInput {
  anchor: UserMessage;
  anchorShape: AnchorShape;
  prior?: CompactionMemory;
  generation: number;
  originalTaskSourceId: string;
  userMessages: ProtectedUserMessage[];
  head: Message[];
  headStartIndex: number;
  tail: Message[];
  cutIndex: number;
  legacySummary?: string;
}
export interface PrepareMemoryOptions {
  messages: readonly Message[];
  cutIndex: number;
  identity?: CompactionIdentity;
}

function hasImage(message: Message): boolean {
  return message.role !== 'assistant' && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'image');
}

function protectImages(
  messages: readonly Message[],
  cutIndex: number,
  anchorIndex: number,
): number {
  const imageIndex = messages.findIndex((message, index) =>
    index < cutIndex && index !== anchorIndex && hasImage(message));
  if (imageIndex < 0) return cutIndex;
  return findSafeCutIndices(messages).filter((index) => index <= imageIndex).at(-1) ?? 0;
}

function legacyReference(messages: readonly Message[]): string | undefined {
  // This copy is read-only evidence of lost provenance; all originals stay protected.
  const blocks = messages.filter(isLegacyMemoryText);
  return blocks.length
    ? blocks.map((message) => message.content as string).join('\n\n')
    : undefined;
}

function preflightBudget(input: PreparedMemoryInput): void {
  if (input.userMessages.length > LIMITS.protectedUserMessages) {
    throw new MemoryError('protected_memory_too_large', '$.userMessages');
  }
  const { coverage } = buildDigest({
    head: input.head,
    generation: input.generation,
    startIndex: input.headStartIndex,
  });
  const clips = [
    ...(input.prior?.coverage.clippedToolResults ?? []),
    ...coverage.clippedToolResults,
  ];
  if (clips.length > LIMITS.coverageClips) {
    throw new MemoryError('protected_memory_too_large', '$.coverage');
  }
  const minimum: CompactionMemory = {
    schemaVersion: 2,
    generation: input.generation,
    originalTask: { sourceId: input.originalTaskSourceId, location: 'anchor' },
    userMessages: input.userMessages,
    items: input.prior?.items ?? [],
    ...(input.legacySummary !== undefined ? { legacySummary: input.legacySummary } : {}),
    coverage: {
      summarizedMessages:
        (input.prior?.coverage.summarizedMessages ?? 0) + coverage.summarizedMessages,
      clippedToolResults: clips,
      legacyIncomplete:
        !!input.prior?.coverage.legacyIncomplete || input.legacySummary !== undefined,
    },
  };
  assertProtectedMemoryBudget(input.anchor, minimum);
}

/** Prepare a snapshot without mutation; throws before payment when protection cannot fit. */
export function prepareMemoryInput(options: PrepareMemoryOptions): PreparedMemoryInput {
  const { messages, identity } = options;
  if (identity && !verifyCompactionIdentity(messages, identity)) {
    throw new MemoryError('invalid_prior_memory', '$.identity');
  }
  const parsed = identity ? parseCompactedBlock(messages[1]!) : undefined;
  const prior = parsed?.memory;
  const anchorIndex = identity ? 0 : messages.findIndex((message) => message.role === 'user');
  const anchor = messages[anchorIndex];
  if (anchor?.role !== 'user') throw new MemoryError('nothing_to_drop', '$.anchor');
  if (
    !Number.isSafeInteger(options.cutIndex) ||
    !findSafeCutIndices(messages).includes(options.cutIndex)
  ) {
    throw new MemoryError('invalid_history', '$.cutIndex');
  }
  const generation = (prior?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(generation)) {
    throw new MemoryError('invalid_prior_memory', '$.generation');
  }
  const cutIndex = protectImages(messages, options.cutIndex, anchorIndex);
  const headStartIndex = identity ? 2 : anchorIndex + 1;
  // Core histories normally start with a user; never silently discard a preceding message.
  if (anchorIndex !== 0) throw new MemoryError('invalid_history', '$.anchorIndex');
  if (cutIndex <= headStartIndex) {
    throw new MemoryError(
      cutIndex < options.cutIndex ? 'protected_multimodal_tail' : 'nothing_to_drop',
      '$.cutIndex',
    );
  }
  const userMessages = [...(prior?.userMessages ?? [])];
  for (let index = headStartIndex; index < cutIndex; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') userMessages.push({ id: `g${generation}:m${index}`, message });
  }
  const input: PreparedMemoryInput = {
    anchor,
    anchorShape: parsed?.anchor ?? 'verbatim',
    ...(prior ? { prior } : {}),
    generation,
    originalTaskSourceId: prior?.originalTask.sourceId ?? `g${generation}:m${anchorIndex}`,
    userMessages,
    head: messages.slice(headStartIndex, cutIndex),
    headStartIndex,
    tail: messages.slice(cutIndex),
    cutIndex,
    legacySummary: prior?.legacySummary
      ?? (!identity ? legacyReference(messages.slice(0, cutIndex)) : undefined),
  };
  preflightBudget(input);
  return input;
}
