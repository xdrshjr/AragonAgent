/** Validate untrusted files before a resume can mutate the active conversation. */
import type { Entry } from '../agent/reducer.js';
import { isAdapterProvider } from '../config/schema.js';
import { normalizeTodos } from '../todo/normalize.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { SavedSession } from './persist.js';
import { validateCompactionIdentity } from '../compaction/memory-identity.js';
import { MemoryError } from '../compaction/memory.js';

type Validator = (value: unknown, path: string) => void;
type Fields = Record<string, Validator>;

function fail(path: string, expected: string): never {
  throw new Error(`Invalid session file: ${path} must be ${expected}.`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'an object');
  }
  return value as Record<string, unknown>;
}

const string: Validator = (value, path) => {
  if (typeof value !== 'string') fail(path, 'a string');
};
const nonempty: Validator = (value, path) => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'a non-empty string');
};
const number: Validator = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
};
const boolean: Validator = (value, path) => {
  if (typeof value !== 'boolean') fail(path, 'a boolean');
};
const nonnegative: Validator = (value, path) => {
  number(value, path);
  if ((value as number) < 0) fail(path, 'non-negative');
};
const positive: Validator = (value, path) => {
  number(value, path);
  if ((value as number) <= 0) fail(path, 'positive');
};
const threshold: Validator = (value, path) => {
  number(value, path);
  if ((value as number) < 0.5 || (value as number) > 0.95) fail(path, 'between 0.5 and 0.95');
};
const memoryVersion: Validator = (value, path) => {
  if (value !== 2) fail(path, '2');
};
const object: Validator = (value, path) => { record(value, path); };

function optional(check: Validator): Validator {
  return (value, path) => { if (value !== undefined) check(value, path); };
}

function enumeration(...values: string[]): Validator {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) fail(path, values.join(' | '));
  };
}

function array(check: Validator): Validator {
  return (value, path) => {
    if (!Array.isArray(value)) fail(path, 'an array');
    value.forEach((item, index) => check(item, `${path}[${index}]`));
  };
}

function shape(fields: Fields): Validator {
  return (value, path) => {
    const source = record(value, path);
    for (const [key, check] of Object.entries(fields)) check(source[key], `${path}.${key}`);
  };
}

const usage = shape({
  inputTokens: number, outputTokens: number, cacheReadTokens: optional(number),
  cacheWriteTokens: optional(number), cost: optional(number),
});

function contentPart(value: unknown, path: string): void {
  const part = record(value, path);
  enumeration('text', 'image')(part.type, `${path}.type`);
  if (part.type === 'text') string(part.text, `${path}.text`);
  else shape({ mediaType: string, data: string })(part, path);
}

function contentBlock(value: unknown, path: string): void {
  const block = record(value, path);
  enumeration('text', 'thinking', 'tool_call')(block.type, `${path}.type`);
  if (block.type === 'tool_call') {
    shape({ toolCallId: string, toolName: string, args: object })(block, path);
    return;
  }
  string(block.text, `${path}.text`);
  if (block.type === 'thinking') optional(string)(block.signature, `${path}.signature`);
}

function message(value: unknown, path: string): void {
  const source = record(value, path);
  enumeration('user', 'assistant', 'tool_result')(source.role, `${path}.role`);
  if (source.role === 'assistant') {
    shape({ content: array(contentBlock), usage: optional(usage),
      stopReason: optional(enumeration('end_turn', 'tool_use', 'max_tokens', 'stop_sequence')),
    })(source, path);
    return;
  }
  if (source.role === 'tool_result') {
    shape({ toolCallId: string, isError: optional(boolean) })(source, path);
  } else optional(number)(source.timestamp, `${path}.timestamp`);
  if (typeof source.content !== 'string') array(contentPart)(source.content, `${path}.content`);
}

const patchLine = shape({
  kind: enumeration('ctx', 'add', 'del'), text: string,
  oldLine: optional(number), newLine: optional(number),
});
const patch = shape({
  path: string, kind: enumeration('create', 'update'), added: number, removed: number,
  truncated: boolean, lineCount: number,
  degraded: optional(enumeration('binary', 'too-large', 'unreadable')),
  hunks: array(shape({ oldStart: number, oldCount: number, newStart: number, newCount: number,
    lines: array(patchLine) })),
});
const todo = shape({
  content: string, activeForm: string, status: enumeration('pending', 'in_progress', 'completed'),
});
const subagent = shape({
  label: string, description: string,
  // Old team archives predate tier; renderers already treat absence as main.
  tier: optional(enumeration('main', 'fast')),
  phase: enumeration('queued', 'starting', 'thinking', 'tool', 'waiting', 'done', 'failed', 'aborted'),
  startedAt: optional(number), endedAt: optional(number), turns: number, toolCalls: number,
  lastTool: optional(string), usage, filesTouched: array(string), messagesSent: number,
  summary: optional(string), error: optional(string), truncated: optional(boolean),
  compactions: optional(number), activity: optional(string),
  activityArgs: optional(shape({ path: optional(string), pattern: optional(string),
    command: optional(string), to: optional(string), from: optional(string) })),
  blockedWaits: optional(number), retries: optional(number), retryable: optional(boolean),
  retry: optional(shape({ attempt: number, maxRetries: number })),
});

const ENTRY_FIELDS: Record<Entry['kind'], Fields> = {
  user: { text: string },
  queued: { text: string, queueId: optional(nonempty) },
  notice: { text: string, level: enumeration('info', 'warn', 'error') },
  assistant: {
    text: string, thinking: optional(string), thinkingOpen: boolean, streaming: boolean,
    aborted: optional(boolean), usage: optional(usage),
    thinkingStartedAt: optional(number), thinkingMs: optional(number),
  },
  tool: {
    toolCallId: string, name: string, label: string, argsRaw: string, args: optional(object),
    status: enumeration('pending', 'running', 'done', 'error'), preview: optional(string),
    durationMs: optional(number), isError: optional(boolean), patch: optional(patch),
    live: optional(array(string)), liveSeq: optional(number), lastOutputAt: optional(number),
  },
  team: { dispatchId: string, requested: number, runs: array(subagent), aborted: boolean,
    durationMs: optional(number), active: boolean },
  todo: { items: array(todo), doneCount: number, total: number, live: boolean,
    interrupted: optional(boolean) },
  retry: {
    attempt: number, maxRetries: number, errorType: string, message: string, delayMs: number,
    resumeAt: optional(number), startedAt: number, totalRetries: optional(number),
    elapsedMs: optional(number),
    phase: enumeration('waiting', 'retrying', 'recovered', 'exhausted', 'interrupted'),
  },
  fast: { reviewIndex: number, model: string,
    status: enumeration('running', 'ok', 'advice', 'empty', 'failed', 'dropped'),
    text: optional(string), detail: optional(string), turn: number,
    durationMs: optional(number), live: boolean },
  compaction: {
    decision: optional(shape({ occupied: nonnegative, contextWindow: positive,
      threshold, source: enumeration('usage', 'estimate'), deltaTokens: nonnegative })),
    memoryVersion: optional(memoryVersion),
    index: number, trigger: enumeration('pressure', 'overflow', 'manual'),
    mode: enumeration('summarized', 'truncated', 'relieved', 'none'), applied: boolean,
    reason: optional(string), messagesBefore: number, messagesAfter: number,
    tokensBefore: number, tokensAfter: number, summary: optional(string), model: string,
    durationMs: optional(number), startedAt: optional(number), live: boolean,
    tailRelief: optional(shape({ messages: number, charsRemoved: number })),
  },
  service: {
    serviceId: string, command: string,
    status: enumeration('starting', 'ready', 'running', 'exited', 'failed', 'stopped'),
    url: optional(string), port: optional(number),
    exitCode: (value, path) => { if (value !== null) number(value, path); },
    startedAt: number, readyAt: optional(number), endedAt: optional(number), rows: array(string),
    rowsSeen: number, terminal: optional(boolean), killIncomplete: optional(boolean),
  },
};

function validateEntries(value: unknown): void {
  const ids = new Set<string>();
  const queues = new Set<string>();
  array((item, path) => {
    const entry = record(item, path);
    nonempty(entry.id, `${path}.id`);
    if (ids.has(entry.id as string)) fail(`${path}.id`, 'unique');
    ids.add(entry.id as string);
    enumeration(...Object.keys(ENTRY_FIELDS))(entry.kind, `${path}.kind`);
    shape(ENTRY_FIELDS[entry.kind as Entry['kind']])(entry, path);
    if (entry.kind !== 'queued' || entry.queueId === undefined) return;
    if (queues.has(entry.queueId as string)) fail(`${path}.queueId`, 'unique');
    queues.add(entry.queueId as string);
  })(value, 'entries');
}

function validateModel(value: unknown): void {
  const model = record(value, 'model');
  shape({ providerId: nonempty, modelId: nonempty, baseUrl: optional(string) })(model, 'model');
  if (typeof model.providerId !== 'string' || !isAdapterProvider(model.providerId)) {
    fail('model.providerId', 'a supported adapter');
  }
}

/** Return a prepared copy, preserving extensions; throw with the corrupt field path. */
export function validateSession(value: unknown): SavedSession {
  const source = record(value, 'session');
  array(message)(source.messages, 'messages');
  validateEntries(source.entries);
  if (source.model !== undefined) validateModel(source.model);
  if (source.compactionIdentity !== undefined) {
    try {
      validateCompactionIdentity(source.compactionIdentity);
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      fail('compactionIdentity', 'a valid adopted-memory identity');
    }
  }
  // Missing fields remain missing in old files, including exec metadata.
  const prepared = { ...source };
  if (source.todos !== undefined) {
    prepared.todos = normalizeTodos(source.todos, TODO_LIMITS.maxItems).items;
  }
  return prepared as unknown as SavedSession;
}
