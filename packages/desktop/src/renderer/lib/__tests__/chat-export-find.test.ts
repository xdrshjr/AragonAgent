/** AC-79 (pure half) and AC-80: Markdown export and in-conversation find. */

import { describe, expect, it } from 'vitest';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import {
  DEFAULT_EXPORT_OPTIONS, TOOL_OUTPUT_LIMIT, fenceFor, summarizeArgs, transcriptToMarkdown, type ExportMeta,
} from '../chat-export.js';
import { entrySearchText, findMatches, stepMatch } from '../chat-find.js';

const meta: ExportMeta = { title: 'My session', appVersion: '1.2.0', exportedAt: '2026-10-28T00:00:00.000Z', sessionId: 'abcdef1234567890', cwdName: 'repo' };
const user = (id: string, text: string): Entry => ({ id, kind: 'user', text });
const assistant = (id: string, text: string, extra: Record<string, unknown> = {}): Entry =>
  ({ id, kind: 'assistant', text, thinkingOpen: false, streaming: false, ...extra }) as Entry;
const tool = (id: string, extra: Record<string, unknown> = {}): Entry =>
  ({ id, kind: 'tool', toolCallId: id, name: 'bash', label: 'bash', argsRaw: '{"command":"npm test"}', args: { command: 'npm test' }, status: 'done', ...extra }) as Entry;

describe('transcriptToMarkdown', () => {
  it('starts with the title and a provenance line', () => {
    const md = transcriptToMarkdown([], meta, DEFAULT_EXPORT_OPTIONS);
    expect(md.split('\n')[0]).toBe('# My session');
    expect(md).toContain('Exported from AragonAgent Desktop 1.2.0 · 2026-10-28T00:00:00.000Z · session abcdef12 · repo');
  });

  it('an untitled session still gets a heading', () => {
    expect(transcriptToMarkdown([], { ...meta, title: null }, DEFAULT_EXPORT_OPTIONS)).toMatch(/^# Untitled session/);
  });

  it('renders user and assistant turns, and a one-line summary per tool call, in order', () => {
    const md = transcriptToMarkdown([user('1', 'run the tests'), tool('2'), assistant('3', 'All **green**.')], meta, DEFAULT_EXPORT_OPTIONS);
    const order = ['## You\n\nrun the tests', '*Tool · bash · `npm test` — done*', '## Assistant\n\nAll **green**.'].map((part) => md.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('tool output and thinking are left out by default', () => {
    const entries = [tool('1', { preview: 'SECRET OUTPUT' }), assistant('2', 'ok', { thinking: 'private reasoning' })];
    const md = transcriptToMarkdown(entries, meta, DEFAULT_EXPORT_OPTIONS);
    expect(md).not.toContain('SECRET OUTPUT');
    expect(md).not.toContain('private reasoning');
  });

  it('with output enabled it is fenced, truncated to 2 KB and says so', () => {
    const md = transcriptToMarkdown([tool('1', { preview: 'Q'.repeat(TOOL_OUTPUT_LIMIT + 500) })], meta, { includeToolOutput: true, includeThinking: false });
    expect(md).toContain('*(output truncated)*');
    expect((md.match(/Q/g) ?? []).length).toBe(TOOL_OUTPUT_LIMIT);
  });

  it('the fence is longer than any backtick run in the content', () => {
    expect(fenceFor('no ticks')).toBe('```');
    expect(fenceFor('has ``` inside')).toBe('````');
    expect(fenceFor('``````')).toBe('```````');
    const md = transcriptToMarkdown([tool('1', { preview: 'before\n```\ninside\n```\nafter' })], meta, { includeToolOutput: true, includeThinking: false });
    expect(md).toContain('````\nbefore');
  });

  it('thinking appears inside a details block when enabled', () => {
    const md = transcriptToMarkdown([assistant('1', 'done', { thinking: 'step by step' })], meta, { includeToolOutput: false, includeThinking: true });
    expect(md).toContain('<summary>Thinking</summary>');
    expect(md).toContain('step by step');
  });

  it('an unknown entry kind becomes a visible placeholder, never a silent gap', () => {
    const md = transcriptToMarkdown([{ id: 'x', kind: 'hologram' } as unknown as Entry], meta, DEFAULT_EXPORT_OPTIONS);
    expect(md).toContain('*(unsupported entry: hologram)*');
  });

  it('every known kind renders without throwing', () => {
    const kinds: Entry[] = [
      user('1', 'u'), { id: '2', kind: 'queued', text: 'q' }, assistant('3', 'a'), tool('4'),
      { id: '5', kind: 'notice', level: 'info', text: 'n' }, { id: '6', kind: 'retry', message: 'r' } as unknown as Entry,
      { id: '7', kind: 'fast', status: 'ok', text: 'f' } as unknown as Entry, { id: '8', kind: 'compaction' } as unknown as Entry,
      { id: '9', kind: 'governance' } as unknown as Entry, { id: '10', kind: 'team' } as unknown as Entry,
      { id: '11', kind: 'todo' } as unknown as Entry, { id: '12', kind: 'service' } as unknown as Entry,
    ];
    expect(() => transcriptToMarkdown(kinds, meta, { includeToolOutput: true, includeThinking: true })).not.toThrow();
    expect(transcriptToMarkdown(kinds, meta, DEFAULT_EXPORT_OPTIONS)).not.toContain('unsupported entry');
  });

  it('summarizeArgs picks the first string argument, flattens whitespace, caps length and defuses backticks', () => {
    expect(summarizeArgs(tool('1', { args: { command: 'echo `hi`\n  there' } }) as never)).toBe("echo 'hi' there");
    expect(summarizeArgs(tool('1', { args: { command: 'x'.repeat(500) } }) as never).length).toBeLessThanOrEqual(120);
  });
});

describe('findMatches', () => {
  const entries: Entry[] = [user('1', 'Hello World'), assistant('2', 'hello again, HELLO'), tool('3', { preview: 'no match here' })];

  it('is case-insensitive and reports every occurrence with its entry', () => {
    const { matches } = findMatches(entries, 'hello');
    expect(matches.map((match) => match.entryIndex)).toEqual([0, 1, 1]);
    expect(matches[0]).toMatchObject({ start: 0, end: 5 });
  });

  it('matches CJK substrings and searches tool output', () => {
    expect(findMatches([user('1', '修复登录问题')], '登录').matches).toHaveLength(1);
    expect(findMatches(entries, 'no match here').matches[0]?.entryIndex).toBe(2);
  });

  it('an empty query matches nothing, and a query is a literal (no regex)', () => {
    expect(findMatches(entries, '').matches).toEqual([]);
    expect(findMatches([user('1', 'a.b')], '.').matches).toHaveLength(1);
    expect(findMatches([user('1', 'abc')], '.*').matches).toEqual([]);
  });

  it('caps the result and says it was capped', () => {
    const many = [user('1', 'a'.repeat(50))];
    const result = findMatches(many, 'a', { max: 10 });
    expect(result.matches).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(findMatches(many, 'a', { max: 100 }).truncated).toBe(false);
  });

  it('a streaming entry whose text grew is re-read, not served stale from the cache', () => {
    const entry = assistant('1', 'abc', { streaming: true });
    expect(entrySearchText(entry)).toBe('abc');
    (entry as { text: string }).text = 'abc def'; // mutated in place
    expect(entrySearchText(entry)).toBe('abc def');
    expect(findMatches([entry], 'def').matches).toHaveLength(1);
  });

  it('5,000 entries of about 2 KB search in well under a second (AC-80)', () => {
    const big: Entry[] = Array.from({ length: 5000 }, (_unused, index) =>
      assistant(String(index), `${'lorem ipsum dolor sit amet '.repeat(75)}${index === 3140 ? ' needle-3141' : ''}`));
    const started = performance.now();
    const result = findMatches(big, 'needle-3141');
    const elapsed = performance.now() - started;
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.entryIndex).toBe(3140);
    expect(elapsed).toBeLessThan(300); // budget is 100 ms; 3x slack for a loaded CI machine
    // eslint-disable-next-line no-console
    console.info(`find: 5000 x ~2KB cold search took ${elapsed.toFixed(1)} ms`);
  });
});

describe('stepMatch', () => {
  it('wraps both ways and is -1 with no matches', () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
