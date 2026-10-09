/** Bounded syntax, schema and evidence checks for untrusted memory input. */
import type {
  CompactionMemory,
  MemoryDelta,
  MemoryItem,
  MemorySource,
  SourceRef,
} from './memory.js';
import { COMPACTION_LIMITS as LIMITS } from './limits.js';

/** Stable failure reason and short field path; never includes protected content. */
export class MemoryError extends Error {
  constructor(public readonly reason: string, public readonly path = '$') {
    super(`${reason}: ${path}`);
    this.name = 'MemoryError';
  }
}

function invalid(path: string): never {
  throw new MemoryError('invalid_memory_delta', path);
}

/** Parse bounded JSON, rejecting duplicate decoded keys before JSON.parse. */
export function parseStrictJson(text: string): unknown {
  if (text.length > LIMITS.memoryJsonChars) invalid('$.length');
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index += 1;
        index += 1;
      }
      if (index >= text.length) invalid('$.string');
      let after = index + 1;
      while (/\s/.test(text[after] ?? '') && after < text.length) after += 1;
      if (text[after] === ':') checkKey(text.slice(start, index + 1), stack.at(-1));
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? new Set() : null);
      if (stack.length > LIMITS.jsonDepth) invalid('$.depth');
    } else if (char === '}' || char === ']') {
      if (!stack.length) invalid('$.nesting');
      stack.pop();
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalid('$.json');
  }
}

function checkKey(token: string, keys: Set<string> | null | undefined): void {
  let key: string;
  try {
    key = JSON.parse(token) as string;
  } catch {
    return invalid('$.key');
  }
  if (!keys || keys.has(key)) invalid('$.duplicate_key');
  keys.add(key);
}

function object(
  value: unknown,
  required: string[],
  optional: string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const record = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(record, key))) invalid(path);
  if (Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) {
    invalid(path);
  }
  return record;
}

function array(value: unknown, max: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(path);
  return value;
}

function string(value: unknown, max: number, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(path);
}

function integer(value: unknown, positive: boolean, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) invalid(path);
}

function id(value: unknown, kind: 'm' | 'i', path: string): void {
  string(value, 64, path);
  const match = new RegExp(`^g([1-9][0-9]*):${kind}([0-9]+)$`).exec(value);
  if (!match) invalid(path);
  integer(Number(match[1]), true, path);
  integer(Number(match[2]), false, path);
}

function source(value: unknown, path: string): void {
  const record = object(value, ['messageId', 'role', 'excerpt'], [], path);
  id(record.messageId, 'm', `${path}.messageId`);
  if (!['user', 'assistant', 'tool_result'].includes(record.role as string)) {
    invalid(`${path}.role`);
  }
  string(record.excerpt, LIMITS.sourceExcerptChars, `${path}.excerpt`);
}

const SECTIONS = [
  'global', 'decisions', 'files', 'facts', 'tasks', 'verification', 'pitfalls', 'next',
];
const STATUSES = ['pending', 'in_progress', 'blocked', 'done', 'cancelled'];

function item(value: unknown, stored: boolean, path: string): void {
  const record = object(
    value,
    ['section', 'text', 'sources', ...(stored ? ['id'] : [])],
    ['status', 'supersedes'],
    path,
  );
  if (stored) id(record.id, 'i', `${path}.id`);
  if (!SECTIONS.includes(record.section as string)) invalid(`${path}.section`);
  string(record.text, LIMITS.itemTextChars, `${path}.text`);
  const sources = array(record.sources, LIMITS.itemSources, `${path}.sources`);
  if (!sources.length) invalid(`${path}.sources`);
  sources.forEach((entry, index) => source(entry, `${path}.sources[${index}]`));
  if (record.section === 'tasks') {
    if (!STATUSES.includes(record.status as string)) invalid(`${path}.status`);
  } else if (Object.hasOwn(record, 'status')) invalid(`${path}.status`);
  if (Object.hasOwn(record, 'supersedes')) id(record.supersedes, 'i', `${path}.supersedes`);
}

/** Validate the model-owned schema only; throws MemoryError on invalid fields. */
export function validateDeltaSchema(value: unknown): asserts value is MemoryDelta {
  const record = object(value, ['schemaVersion', 'additions'], [], '$');
  if (record.schemaVersion !== 2) invalid('$.schemaVersion');
  array(record.additions, LIMITS.memoryAdditions, '$.additions').forEach((entry, index) =>
    item(entry, false, `$.additions[${index}]`));
}

function protectedUser(value: unknown, path: string): void {
  const entry = object(value, ['id', 'message'], [], path);
  id(entry.id, 'm', `${path}.id`);
  const message = object(entry.message, ['role', 'content'], ['timestamp'], `${path}.message`);
  if (message.role !== 'user') invalid(`${path}.message.role`);
  if (typeof message.content !== 'string') {
    // Images must remain in the top-level anchor/tail, never in this ledger.
    array(message.content, LIMITS.memoryJsonChars, `${path}.content`).forEach((part) => {
      const record = object(part, ['type', 'text'], [], `${path}.content`);
      if (record.type !== 'text' || typeof record.text !== 'string') invalid(`${path}.content`);
    });
  }
  if (Object.hasOwn(message, 'timestamp') && !Number.isFinite(message.timestamp)) {
    invalid(`${path}.timestamp`);
  }
}

function validateCoverage(value: unknown): void {
  const coverage = object(
    value,
    ['summarizedMessages', 'clippedToolResults', 'legacyIncomplete'],
    [],
    '$.coverage',
  );
  integer(coverage.summarizedMessages, false, '$.coverage.summarizedMessages');
  if (typeof coverage.legacyIncomplete !== 'boolean') invalid('$.coverage.legacyIncomplete');
  const seen = new Set<string>();
  const clips = array(
    coverage.clippedToolResults, LIMITS.coverageClips, '$.coverage.clippedToolResults',
  );
  clips.forEach((value) => {
    const clip = object(value, ['messageId', 'omittedChars'], [], '$.coverage.clip');
    id(clip.messageId, 'm', '$.coverage.clip.messageId');
    integer(clip.omittedChars, true, '$.coverage.clip.omittedChars');
    if (seen.has(clip.messageId as string)) invalid('$.coverage.clip.duplicate');
    seen.add(clip.messageId as string);
  });
}

function validateStoredChains(memory: CompactionMemory): void {
  const entries = new Map<string, MemoryItem>();
  const replaced = new Set<string>();
  for (const entry of memory.items) {
    if (entries.has(entry.id) || Number(entry.id.slice(1).split(':')[0]) > memory.generation) {
      invalid('$.items.id');
    }
    if (entry.supersedes) {
      const previous = entries.get(entry.supersedes);
      if (!previous || previous.section !== entry.section || replaced.has(previous.id)) {
        invalid('$.items.supersedes');
      }
      replaced.add(previous.id);
    }
    entries.set(entry.id, entry);
  }
  const users = memory.userMessages.map((entry) => entry.id);
  if (new Set(users).size !== users.length || users.includes(memory.originalTask.sourceId)) {
    invalid('$.userMessages.id');
  }
  const references = [
    memory.originalTask.sourceId,
    ...users,
    ...memory.items.flatMap((entry) => entry.sources.map((source) => source.messageId)),
    ...memory.coverage.clippedToolResults.map((clip) => clip.messageId),
  ];
  if (references.some((reference) =>
    Number(reference.slice(1).split(':')[0]) > memory.generation)) {
    invalid('$.sources.generation');
  }
}

/** Validate a persisted v2 body, including unique IDs and acyclic state chains. */
export function validateMemorySchema(value: unknown): asserts value is CompactionMemory {
  const record = object(
    value,
    ['schemaVersion', 'generation', 'originalTask', 'userMessages', 'items', 'coverage'],
    ['legacySummary'],
    '$',
  );
  if (record.schemaVersion !== 2) invalid('$.schemaVersion');
  integer(record.generation, true, '$.generation');
  const original = object(record.originalTask, ['sourceId', 'location'], [], '$.originalTask');
  id(original.sourceId, 'm', '$.originalTask.sourceId');
  if (original.location !== 'anchor') invalid('$.originalTask.location');
  array(record.userMessages, LIMITS.protectedUserMessages, '$.userMessages')
    .forEach((entry, index) => protectedUser(entry, `$.userMessages[${index}]`));
  array(record.items, LIMITS.memoryItems, '$.items')
    .forEach((entry, index) => item(entry, true, `$.items[${index}]`));
  if (Object.hasOwn(record, 'legacySummary')) {
    string(record.legacySummary, LIMITS.memoryJsonChars, '$.legacySummary');
  }
  validateCoverage(record.coverage);
  validateStoredChains(value as CompactionMemory);
}

function validateSource(
  reference: SourceRef,
  sourceMap: ReadonlyMap<string, MemorySource>,
  path: string,
): MemorySource {
  const original = sourceMap.get(reference.messageId);
  if (!original || original.role !== reference.role) invalid(`${path}.role`);
  if (!original.visibleText.some((text) => text.includes(reference.excerpt))) {
    invalid(`${path}.excerpt`);
  }
  return original;
}

function validateEvidence(
  entry: Omit<MemoryItem, 'id'>,
  originals: MemorySource[],
  path: string,
): void {
  const hasUser = originals.some((source) => source.role === 'user' && !source.isLegacyReference);
  const hasToolResult = originals.some((source) =>
    source.role === 'tool_result' && !!source.toolName);
  const hasTool = originals.some((source) =>
    source.role === 'tool_result' && source.isError !== true && !!source.toolName);
  if (entry.status === 'done' && !hasUser && !hasTool) invalid(`${path}.done_evidence`);
  if (entry.status === 'cancelled' && !hasUser) invalid(`${path}.cancelled_evidence`);
  if (entry.section === 'verification' && !hasToolResult) invalid(`${path}.verification_evidence`);
  if (entry.supersedes && entry.section === 'global' && !hasUser) invalid(`${path}.user_evidence`);
  if (entry.status === 'done' && originals.some((source) => source.isError === true)) {
    invalid(`${path}.failed_evidence`);
  }
}

export interface DeltaValidationContext {
  sourceMap: ReadonlyMap<string, MemorySource>;
  prior?: CompactionMemory;
  hasSummarizableMessages: boolean;
}

/** Check current-source excerpts, completion evidence and append-only supersession. */
export function validateMemoryDelta(delta: MemoryDelta, context: DeltaValidationContext): void {
  validateDeltaSchema(delta);
  if (!delta.additions.length && context.hasSummarizableMessages) {
    throw new MemoryError('empty_memory_delta', '$.additions');
  }
  const prior = new Map(context.prior?.items.map((entry) => [entry.id, entry]) ?? []);
  const replaced = new Set(
    context.prior?.items.flatMap((entry) => entry.supersedes ? [entry.supersedes] : []) ?? [],
  );
  delta.additions.forEach((entry, index) => {
    const path = `$.additions[${index}]`;
    const originals = entry.sources.map((reference) =>
      validateSource(reference, context.sourceMap, `${path}.sources`));
    validateEvidence(entry, originals, path);
    if (!entry.supersedes) return;
    const previous = prior.get(entry.supersedes);
    if (!previous || previous.section !== entry.section || replaced.has(previous.id)) {
      invalid(`${path}.supersedes`);
    }
    replaced.add(previous.id);
  });
}
