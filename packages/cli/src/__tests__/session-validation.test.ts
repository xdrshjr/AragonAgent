import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadSession } from '../session/persist.js';

const directory = resolve('.agentmesh/session-validation-tests');
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let serial = 0;
function load(value: unknown) {
  const path = resolve(directory, `${serial++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return loadSession(path);
}
const usage = { inputTokens: 1, outputTokens: 2 };
const entries = [
  { kind: 'user', text: 'user' },
  { kind: 'queued', text: 'full\nqueued' },
  { kind: 'assistant', text: 'answer', thinkingOpen: false, streaming: false },
  { kind: 'tool', toolCallId: 'call', name: 'read', label: 'read', argsRaw: '{}', status: 'done' },
  { kind: 'notice', level: 'warn', text: 'notice' },
  { kind: 'team', dispatchId: 'team', requested: 1, runs: [], aborted: false, active: false },
  { kind: 'todo', items: [], doneCount: 0, total: 0, live: false },
  { kind: 'retry', attempt: 1, maxRetries: 2, errorType: 'timeout', message: 'retry',
    delayMs: 2, phase: 'waiting', startedAt: 1 },
  { kind: 'fast', reviewIndex: 1, model: 'custom', status: 'ok', turn: 1, live: false },
  { kind: 'compaction', index: 1, trigger: 'manual', mode: 'none', applied: false,
    messagesBefore: 1, messagesAfter: 1, tokensBefore: 2, tokensAfter: 2,
    model: 'custom', live: false },
  { kind: 'service', serviceId: 's1', command: 'run', status: 'stopped', exitCode: null,
    startedAt: 1, rows: [], rowsSeen: 0 },
].map((entry, index) => ({ ...entry, id: `e${index}` }));
const messages = [
  { role: 'user', content: [{ type: 'text', text: 'hello' },
    { type: 'image', mediaType: 'image/png', data: 'base64' }] },
  { role: 'assistant', content: [{ type: 'thinking', text: 'think', signature: 'sig' },
    { type: 'tool_call', toolCallId: 'call', toolName: 'read', args: {} }], usage },
  { role: 'tool_result', toolCallId: 'call', content: [], isError: false },
];
const fixture = () => ({ version: 1, savedAt: 1, entries, messages });

describe('session validation before restoration', () => {
  it('accepts every old entry and message kind, preserving meta and extension fields', () => {
    const loaded = load({ ...fixture(), meta: { id: 'exec' }, extension: { legacy: true } });
    expect(loaded.messages).toEqual(messages);
    expect(loaded.meta).toEqual({ id: 'exec' });
    expect(loaded).toHaveProperty('extension.legacy', true);
    expect(loaded.entries[1]).toEqual({ id: 'e1', kind: 'notice', level: 'warn',
      text: 'Queued but never sent: full\nqueued' });
  });

  it.each(entries.map((entry) => [entry.kind, entry]))(
    'rejects missing required fields for %s', (_kind, entry) => {
      const { kind, id } = entry as { kind: string; id: string };
      expect(() => load({ ...fixture(), entries: [{ kind, id }] })).toThrow('entries[0].');
    },
  );

  for (const entry of entries) {
    for (const field of Object.keys(entry).filter((key) => key !== 'id' && key !== 'kind')) {
      it(`rejects a corrupt ${entry.kind}.${field} before normalization`, () => {
        const invalid = field === 'exitCode' ? 'invalid' : null;
        expect(() => load({ messages: [], entries: [{ ...entry, [field]: invalid }] }))
          .toThrow(`entries[0].${field}`);
      });
    }
  }

  it.each([
    ['assistant', { thinking: 3 }, 'thinking'],
    ['assistant', { usage: { inputTokens: 1, outputTokens: 'bad' } }, 'usage.outputTokens'],
    ['tool', { live: [null] }, 'live[0]'],
    ['tool', { args: [] }, 'args'],
    ['tool', { patch: { path: 'x', kind: 'update', added: 1, removed: 1,
      truncated: false, lineCount: 1, hunks: [{ oldStart: 1, oldCount: 1,
        newStart: 1, newCount: 1, lines: [{ kind: 'add', text: null }] }] } },
      'patch.hunks[0].lines[0].text'],
    ['team', { runs: [{ label: 'child', description: 'work', phase: 'done', turns: 1,
      toolCalls: 1, usage, filesTouched: [false], messagesSent: 0 }] }, 'runs[0].filesTouched[0]'],
    ['todo', { items: [{ content: 'work', activeForm: 'working', status: 'invalid' }] },
      'items[0].status'],
    ['compaction', { tailRelief: { messages: 2, charsRemoved: 'bad' } }, 'tailRelief.charsRemoved'],
    ['service', { rows: [2] }, 'rows[0]'],
    ['queued', { queueId: '' }, 'queueId'],
  ])('checks nested and optional %s payloads (%#)', (kind, extra, field) => {
    const entry = entries.find((candidate) => candidate.kind === kind)!;
    expect(() => load({ messages: [], entries: [{ ...entry, ...(extra as object) }] }))
      .toThrow(`entries[0].${field}`);
  });

  it('accepts legacy team tier omission and arbitrary supported model IDs', () => {
    const team = entries.find((entry) => entry.kind === 'team')!;
    const loaded = load({ entries: [{ ...team, runs: [{ label: 'child', description: 'work',
      phase: 'done', turns: 1, toolCalls: 0, usage, filesTouched: [], messagesSent: 0 }] }],
      messages: [], model: { providerId: 'openai', modelId: 'private-deployment' } });
    expect(loaded.model?.modelId).toBe('private-deployment');
    expect(loaded.entries[0]).toMatchObject({ runs: [{ label: 'child' }] });
  });

  it.each([
    [{ role: 'user', content: [], timestamp: 'invalid' }, 'timestamp'],
    [{ role: 'assistant', content: [{ type: 'thinking', text: '', signature: 1 }] },
      'content[0].signature'],
    [{ role: 'assistant', content: [], stopReason: 'invalid' }, 'stopReason'],
    [{ role: 'tool_result', content: '', toolCallId: 'call', isError: 'false' }, 'isError'],
    [{ role: 'user', content: [{ type: 'unknown' }] }, 'content[0].type'],
    [{ role: 'assistant', content: [null] }, 'content[0]'],
    [{ role: 'unknown', content: '' }, 'role'],
  ])('checks message optional fields and discriminants (%#)', (message, field) => {
    expect(() => load({ messages: [message], entries: [] })).toThrow(`messages[0].${field}`);
  });

  it.each([
    [null, 'session'],
    [{ messages: [null], entries: [] }, 'messages[0]'],
    [{ messages: [], entries: [null] }, 'entries[0]'],
    [{ messages: [], entries: [{ id: 'e', kind: 'unknown' }] }, 'entries[0].kind'],
    [{ messages: [], entries: [entries[0], entries[0]] }, 'entries[1].id'],
    [{ messages: [], entries: [{ id: 'a', kind: 'queued', queueId: 'q', text: '' },
      { id: 'b', kind: 'queued', queueId: 'q', text: '' }] }, 'entries[1].queueId'],
    [{ ...fixture(), model: null }, 'model'],
    [{ ...fixture(), model: { providerId: 'unsupported', modelId: 'm' } }, 'model.providerId'],
    [{ ...fixture(), model: { providerId: 'anthropic', modelId: 'm', baseUrl: 3 } }, 'model.baseUrl'],
    [{ messages: [{ role: 'user', content: [{ type: 'image', data: 'x' }] }], entries: [] },
      'messages[0].content[0].mediaType'],
    [{ messages: [{ role: 'assistant', content: [{ type: 'tool_call', toolCallId: 'x',
      toolName: 'tool', args: null }] }], entries: [] }, 'messages[0].content[0].args'],
    [{ messages: [{ role: 'tool_result', content: 'text' }], entries: [] },
      'messages[0].toolCallId'],
  ])('rejects corrupt data with a field path (%#)', (value, path) => {
    expect(() => load(value)).toThrow(path as string);
  });

  it('normalizes TODO during preparation and accepts absent model and empty messages', () => {
    expect(load({ messages: [], entries: [], todos: [null, { content: '  work  ' }] }).todos)
      .toEqual([{ content: 'work', activeForm: 'work', status: 'in_progress' }]);
    expect(load({ messages: [], entries: [], todos: 'invalid' }).todos).toEqual([]);
    expect(load({ messages: [], entries: [] }).todos).toBeUndefined();
  });
});
