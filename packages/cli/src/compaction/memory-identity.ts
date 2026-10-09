/** Adopted-prefix credentials for process-local and saved-session continuity. */
import { createHash } from 'node:crypto';
import type { Message, UserMessage } from '@aragon-agent/core';
import { canonicalUserMessage, MemoryError } from './memory.js';
import { parseCompactedBlock } from './summary-prompt.js';

export interface CompactionIdentity {
  version: 1;
  anchorIndex: 0;
  blockIndex: 1;
  generation: number;
  prefixSha256: string;
}

/** Validate the optional session credential shape; throws on unknown or bad fields. */
export function validateCompactionIdentity(value: unknown): asserts value is CompactionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryError('invalid_prior_memory', '$.identity');
  }
  const record = value as Record<string, unknown>;
  const keys = ['version', 'anchorIndex', 'blockIndex', 'generation', 'prefixSha256'];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new MemoryError('invalid_prior_memory', '$.identity.keys');
  }
  if (record.version !== 1 || record.anchorIndex !== 0 || record.blockIndex !== 1) {
    throw new MemoryError('invalid_prior_memory', '$.identity.prefix');
  }
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1) {
    throw new MemoryError('invalid_prior_memory', '$.identity.generation');
  }
  if (typeof record.prefixSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.prefixSha256)) {
    throw new MemoryError('invalid_prior_memory', '$.identity.hash');
  }
}

function prefix(messages: readonly Message[]): [UserMessage, UserMessage] {
  const anchor = messages[0];
  const block = messages[1];
  if (anchor?.role !== 'user' || block?.role !== 'user') {
    throw new MemoryError('invalid_prior_memory', '$.prefix.roles');
  }
  return [anchor, block];
}

/** Serialize the complete prefix, including content parts and timestamps, in fixed order. */
export function serializeCompactionPrefix(messages: readonly Message[]): string {
  return JSON.stringify(prefix(messages).map(canonicalUserMessage));
}

/** Create credentials only at the host's successful adoption boundary. */
export function createCompactionIdentity(messages: readonly Message[]): CompactionIdentity {
  const [, block] = prefix(messages);
  const { memory } = parseCompactedBlock(block);
  return {
    version: 1,
    anchorIndex: 0,
    blockIndex: 1,
    generation: memory.generation,
    prefixSha256: createHash('sha256').update(serializeCompactionPrefix(messages)).digest('hex'),
  };
}

/** Verify persisted credentials without mutating history or repairing missing identity. */
export function verifyCompactionIdentity(
  messages: readonly Message[],
  identity: unknown,
): identity is CompactionIdentity {
  try {
    validateCompactionIdentity(identity);
    const current = createCompactionIdentity(messages);
    return current.generation === identity.generation
      && current.prefixSha256 === identity.prefixSha256;
  } catch (error) {
    if (error instanceof MemoryError) return false;
    throw error;
  }
}
