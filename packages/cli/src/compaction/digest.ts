/** Complete transcript input with bounded tool-only clipping and trusted sources. */
import { CHARS_PER_TOKEN, type ContentPart, type Message, type UserMessage } from '@aragon-agent/core';
import { COMPACTION_LIMITS as LIMITS } from './limits.js';
import {
  isLegacyMemoryText,
  MemoryError,
  serializeMemory,
  type CompactionMemory,
  type MemoryCoverage,
  type MemorySource,
} from './memory.js';

export interface DigestInput {
  head: readonly Message[];
  /** Retained original task is context only, never current acceptance evidence. */
  anchor?: UserMessage;
  summarizerWindow?: number;
  generation?: number;
  startIndex?: number;
  priorMemory?: CompactionMemory;
  legacySummary?: string;
}
export interface DigestResult {
  text: string;
  omitted: number;
  budgetChars: number;
  sourceMap: Map<string, MemorySource>;
  coverage: MemoryCoverage;
}

/** Text alone cannot identify a host summary; use verified identity at the caller. */
export function isPriorSummaryBlock(_message: Message): boolean {
  return false;
}

/** Derive the digest ceiling; known windows below reserve have no input room. */
export function digestBudgetChars(summarizerWindow?: number): number {
  if (
    summarizerWindow === undefined ||
    !Number.isFinite(summarizerWindow) ||
    summarizerWindow <= 0
  ) {
    return LIMITS.digestMaxChars;
  }
  return Math.min(
    LIMITS.digestMaxChars,
    Math.max(0, (summarizerWindow - LIMITS.summarizerReserveTokens) * CHARS_PER_TOKEN),
  );
}

function contentText(content: string | ContentPart[]): { text: string; visible: string[] } {
  if (typeof content === 'string') return { text: content, visible: [content] };
  return {
    text: content
      .map((part) => part.type === 'text' ? part.text : '[image unavailable to summarizer]')
      .join('\n'),
    visible: content.flatMap((part) => part.type === 'text' ? [part.text] : []),
  };
}

function renderAssistant(
  message: Extract<Message, { role: 'assistant' }>,
  calls: Map<string, string>,
): { text: string; visible: string[] } {
  const text: string[] = [];
  const visible: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      text.push(block.text);
      visible.push(block.text);
    }
    if (block.type === 'tool_call') {
      const args = JSON.stringify(block.args);
      text.push(`CALL ${block.toolName} toolCallId=${block.toolCallId}\n${args}`);
      visible.push(args);
      calls.set(block.toolCallId, block.toolName);
    }
  }
  return { text: text.join('\n'), visible };
}

function renderEntry(
  message: Message,
  messageId: string,
  calls: Map<string, string>,
  result: DigestResult,
): string {
  const rendered = message.role === 'assistant'
    ? renderAssistant(message, calls)
    : contentText(message.content);
  const source: MemorySource = { role: message.role, visibleText: rendered.visible };
  let heading = `[${messageId}] ${message.role}`;
  if (isLegacyMemoryText(message)) {
    source.isLegacyReference = true;
    heading += ' (legacy read-only reference, not current user acceptance)';
  }
  if (message.role === 'tool_result') {
    source.toolCallId = message.toolCallId;
    source.toolName = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    source.isError = message.isError;
    heading += ` tool=${source.toolName ?? 'unknown'} toolCallId=${message.toolCallId}`
      + ` isError=${message.isError === true}`;
    const edge = LIMITS.toolResultEdgeChars;
    if (rendered.text.length > 2 * edge) {
      const omittedChars = rendered.text.length - 2 * edge;
      const first = rendered.text.slice(0, edge);
      const last = rendered.text.slice(-edge);
      source.visibleText = clippedVisibleSections(rendered.visible, rendered.text, edge);
      rendered.text = `${first}\n[clipped originalChars=${rendered.text.length}`
        + ` omittedChars=${omittedChars}]\n${last}`;
      result.coverage.clippedToolResults.push({ messageId, omittedChars });
    }
  }
  result.sourceMap.set(messageId, source);
  if (message.role !== 'user') result.coverage.summarizedMessages += 1;
  return `${heading}\n${rendered.text}`;
}

function clippedVisibleSections(parts: string[], rendered: string, edge: number): string[] {
  const visible: string[] = [];
  let from = 0;
  for (const part of parts) {
    const start = rendered.indexOf(part, from);
    const end = start + part.length;
    if (start < edge) visible.push(part.slice(0, Math.max(0, edge - start)));
    if (end > rendered.length - edge) {
      visible.push(part.slice(Math.max(0, rendered.length - edge - start)));
    }
    from = end;
  }
  return visible.filter(Boolean);
}

/** Build every head entry without mutating messages; rejects instead of omitting. */
export function buildDigest(input: DigestInput): DigestResult {
  const generation = input.generation ?? 1;
  const start = input.startIndex ?? 0;
  if (
    !Number.isSafeInteger(generation) || generation < 1 ||
    !Number.isSafeInteger(start) || start < 0
  ) {
    throw new MemoryError('invalid_memory_delta', '$.sourceIds');
  }
  const result: DigestResult = {
    text: '',
    omitted: 0,
    budgetChars: digestBudgetChars(input.summarizerWindow),
    sourceMap: new Map(),
    coverage: { summarizedMessages: 0, clippedToolResults: [] },
  };
  const parts: string[] = [];
  if (input.anchor) {
    parts.push('ORIGINAL TASK (read-only reference, not current evidence):\n'
      + contentText(input.anchor.content).text);
  }
  if (input.priorMemory) {
    parts.push(`PRIOR MEMORY (read-only):\n${serializeMemory(input.priorMemory)}`);
  }
  if (input.legacySummary && !input.priorMemory?.legacySummary) {
    parts.push(`LEGACY SUMMARY (read-only, incomplete provenance):\n${input.legacySummary}`);
  }
  const calls = new Map<string, string>();
  input.head.forEach((message, index) =>
    parts.push(renderEntry(message, `g${generation}:m${start + index}`, calls, result)));
  result.text = parts.join('\n\n');
  if (result.text.length > result.budgetChars) {
    throw new MemoryError('digest_budget_exceeded', '$.digest');
  }
  if (result.coverage.clippedToolResults.length > LIMITS.coverageClips) {
    throw new MemoryError('protected_memory_too_large', '$.coverage');
  }
  return result;
}
