/** Host-owned append-only conversation memory; no I/O or model state. */
import type { Message, UserMessage } from '@aragon-agent/core';
import type { PreparedMemoryInput } from './memory-input.js';
import { COMPACTION_LIMITS as LIMITS } from './limits.js';
import {
  MemoryError,
  parseStrictJson,
  validateDeltaSchema,
  validateMemoryDelta,
  validateMemorySchema,
} from './memory-validation.js';

export { MemoryError } from './memory-validation.js';

export interface SourceRef {
  messageId: string;
  role: 'user' | 'assistant' | 'tool_result';
  excerpt: string;
}
export interface MemoryItem {
  id: string;
  section: 'global' | 'decisions' | 'files' | 'facts'
    | 'tasks' | 'verification' | 'pitfalls' | 'next';
  text: string;
  sources: SourceRef[];
  status?: 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  supersedes?: string;
}
export interface ProtectedUserMessage {
  id: string;
  message: UserMessage;
}
export interface CompactionMemory {
  schemaVersion: 2;
  generation: number;
  originalTask: { sourceId: string; location: 'anchor' };
  userMessages: ProtectedUserMessage[];
  items: MemoryItem[];
  legacySummary?: string;
  coverage: {
    summarizedMessages: number;
    clippedToolResults: Array<{ messageId: string; omittedChars: number }>;
    legacyIncomplete: boolean;
  };
}
export interface MemoryDelta {
  schemaVersion: 2;
  additions: Array<Omit<MemoryItem, 'id'>>;
}
export interface MemorySource {
  role: Message['role'];
  visibleText: string[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  isLegacyReference?: boolean;
}
export interface MemoryCoverage {
  summarizedMessages: number;
  clippedToolResults: Array<{ messageId: string; omittedChars: number }>;
}

/** Recognize a legacy reference without excluding it from protected user content. */
export function isLegacyMemoryText(message: Message): boolean {
  const legacyPattern = new RegExp(
    '^<compacted_context version="v1-2026-08"(?: [a-z]+="[^"]*")*>'
      + '\\n[\\s\\S]*\\n</compacted_context>$',
  );
  return message.role === 'user' && typeof message.content === 'string'
    && legacyPattern.test(message.content);
}

/** Parse the sole permitted model response; throws MemoryError on invalid input. */
export function parseMemoryDelta(text: string): MemoryDelta {
  const value = parseStrictJson(text);
  validateDeltaSchema(value);
  return value;
}

/** Parse a complete persisted body without inferring host identity from its shape. */
export function parseMemory(text: string): CompactionMemory {
  const value = parseStrictJson(text);
  validateMemorySchema(value);
  return value;
}

/** Canonical UserMessage field order for protected budgets and prefix hashes. */
export function canonicalUserMessage(message: UserMessage): UserMessage {
  return {
    role: 'user',
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'image' as const, mediaType: part.mediaType, data: part.data }),
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

/** Serialize fixed schema order and escaped delimiters; throws on final text budget. */
export function serializeMemory(memory: CompactionMemory): string {
  validateMemorySchema(memory);
  const ordered: CompactionMemory = {
    schemaVersion: 2,
    generation: memory.generation,
    originalTask: { sourceId: memory.originalTask.sourceId, location: 'anchor' },
    userMessages: memory.userMessages.map((entry) => ({
      id: entry.id,
      message: canonicalUserMessage(entry.message),
    })),
    items: memory.items.map((entry) => ({
      id: entry.id,
      section: entry.section,
      text: entry.text,
      sources: entry.sources.map((source) => ({
        messageId: source.messageId,
        role: source.role,
        excerpt: source.excerpt,
      })),
      ...(entry.status !== undefined ? { status: entry.status } : {}),
      ...(entry.supersedes !== undefined ? { supersedes: entry.supersedes } : {}),
    })),
    ...(memory.legacySummary !== undefined ? { legacySummary: memory.legacySummary } : {}),
    coverage: {
      summarizedMessages: memory.coverage.summarizedMessages,
      clippedToolResults: memory.coverage.clippedToolResults.map((clip) => ({
        messageId: clip.messageId,
        omittedChars: clip.omittedChars,
      })),
      legacyIncomplete: memory.coverage.legacyIncomplete,
    },
  };
  const text = JSON.stringify(ordered, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (text.length > LIMITS.memoryJsonChars) {
    throw new MemoryError('protected_memory_too_large', '$.serialized');
  }
  return text;
}

/** Enforce the combined protected budget using complete serialized content. */
export function assertProtectedMemoryBudget(anchor: UserMessage, memory: CompactionMemory): void {
  const length = JSON.stringify(canonicalUserMessage(anchor)).length
    + serializeMemory(memory).length;
  if (length > LIMITS.protectedMemoryChars) {
    throw new MemoryError('protected_memory_too_large', '$.anchor');
  }
}

export interface MergeMemoryInput {
  input: PreparedMemoryInput;
  delta: MemoryDelta;
  sourceMap: ReadonlyMap<string, MemorySource>;
  coverage: MemoryCoverage;
}

/** Create a staged ledger; prior items and users are retained without rewriting. */
export function mergeMemory(options: MergeMemoryInput): CompactionMemory {
  const { input, delta, sourceMap, coverage } = options;
  validateMemoryDelta(delta, {
    sourceMap,
    prior: input.prior,
    hasSummarizableMessages: coverage.summarizedMessages > 0,
  });
  const items = [
    ...(input.prior?.items ?? []),
    ...delta.additions.map((entry, index) => ({ id: `g${input.generation}:i${index}`, ...entry })),
  ];
  const clips = [
    ...(input.prior?.coverage.clippedToolResults ?? []),
    ...coverage.clippedToolResults,
  ];
  if (
    items.length > LIMITS.memoryItems ||
    input.userMessages.length > LIMITS.protectedUserMessages ||
    clips.length > LIMITS.coverageClips
  ) {
    throw new MemoryError('protected_memory_too_large', '$.counts');
  }
  const memory: CompactionMemory = {
    schemaVersion: 2,
    generation: input.generation,
    originalTask: { sourceId: input.originalTaskSourceId, location: 'anchor' },
    userMessages: [...input.userMessages],
    items,
    ...(input.legacySummary !== undefined ? { legacySummary: input.legacySummary } : {}),
    coverage: {
      summarizedMessages:
        (input.prior?.coverage.summarizedMessages ?? 0) + coverage.summarizedMessages,
      clippedToolResults: clips,
      legacyIncomplete:
        !!input.prior?.coverage.legacyIncomplete || input.legacySummary !== undefined,
    },
  };
  assertProtectedMemoryBudget(input.anchor, memory);
  return memory;
}
