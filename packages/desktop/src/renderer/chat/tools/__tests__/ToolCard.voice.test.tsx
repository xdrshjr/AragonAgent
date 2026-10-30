import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry, ViewAction } from '@aragon-agent/tui/model/agent/reducer';
import { setLanguage } from '../../../i18n/index.js';
import { ToolCard } from '../ToolCard.js';
import { reduce } from '../../__tests__/kit.js';

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

function tool(name: string, args: Record<string, unknown>, finish: 'running' | 'done' | 'failed'): ToolEntry {
  const actions: ViewAction[] = [
    { type: 'runStart' },
    { type: 'toolCallStart', toolCallId: `call-${name}`, toolName: name },
    { type: 'toolCallEnd', toolCallId: `call-${name}`, args },
    { type: 'toolExecStart', toolCallId: `call-${name}` },
  ];
  if (finish !== 'running') {
    actions.push({ type: 'toolExecEnd', toolCallId: `call-${name}`, isError: finish === 'failed', duration: 1200, preview: 'out' });
  }
  const found = reduce(actions).entries.find((entry): entry is ToolEntry => entry.kind === 'tool');
  if (!found) throw new Error('no tool entry');
  return found;
}

const RAW = ['read_file', 'ledger_apply', 'edit_file', 'bash'];

function domText(): string {
  const parts: string[] = [document.body.textContent ?? ''];
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of ['title', 'aria-label', 'alt']) {
      const value = element.getAttribute(attribute);
      if (value) parts.push(value);
    }
  }
  return parts.join('\n');
}

beforeEach(() => setLanguage('en'));
afterEach(() => { cleanup(); setLanguage('en'); });

describe('ToolCard voice', () => {
  it.each([
    ['running', 'read_file', { path: 'src/a.ts' }],
    ['done', 'read_file', { path: 'src/a.ts' }],
    ['failed', 'ledger_apply', { agent: 'x' }],
  ] as const)('friendly %s: no raw identifier anywhere in the DOM', (state, name, args) => {
    const entry = tool(name, args, state);
    render(<ToolCard sessionId="s1" entry={entry} expanded={false} voiceMode="friendly" />);
    const text = domText();
    for (const raw of RAW) expect(text).not.toContain(raw);
  });

  it('friendly running shows a phrase, then the steady title once done', () => {
    const running = render(<ToolCard sessionId="s1" entry={tool('grep', { pattern: 'retry' }, 'running')} expanded={false} voiceMode="friendly" />);
    const phrase = running.container.querySelector('.tool-name')!.textContent!;
    expect(phrase).toMatch(/(Searching for|Hunting for|Tracking down) retry/);
    running.unmount();
    const done = render(<ToolCard sessionId="s1" entry={tool('grep', { pattern: 'retry' }, 'done')} expanded={false} voiceMode="friendly" />);
    expect(done.container.querySelector('.tool-name')!.textContent).toBe('Search text');
  });

  it('the phrase is stable across re-renders of the same call', () => {
    const entry = tool('bash', { command: 'npm test' }, 'running');
    const view = render(<ToolCard sessionId="s1" entry={entry} expanded={false} voiceMode="friendly" />);
    const first = view.container.querySelector('.tool-name')!.textContent;
    view.rerender(<ToolCard sessionId="s1" entry={{ ...entry }} expanded={false} voiceMode="friendly" />);
    expect(view.container.querySelector('.tool-name')!.textContent).toBe(first);
  });

  it('failed keeps a plain failure badge in both voices', () => {
    for (const mode of ['friendly', 'developer'] as const) {
      const view = render(<ToolCard sessionId="s1" entry={tool('bash', { command: 'false' }, 'failed')} expanded={false} voiceMode={mode} />);
      expect(view.container.querySelector('[data-failed="true"]')).not.toBeNull();
      expect(view.getAllByRole('img', { name: 'Failed' }).length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('developer renders the registry label and, expanded, the raw identifier', () => {
    const entry = tool('read_file', { path: 'src/a.ts' }, 'done');
    const view = render(<ToolCard sessionId="s1" entry={entry} expanded voiceMode="developer" />);
    expect(view.container.querySelector('.tool-name')!.textContent).toBe(entry.label);
    expect(view.container.querySelector('.tool-ident')!.textContent).toBe('read_file');
    expect(view.getByRole('button', { expanded: true }).getAttribute('aria-label')).toBeNull();
  });

  it('developer collapsed shows no extra identifier row', () => {
    const view = render(<ToolCard sessionId="s1" entry={tool('read_file', { path: 'a' }, 'done')} expanded={false} voiceMode="developer" />);
    expect(view.container.querySelector('.tool-ident')).toBeNull();
  });

  it('reduced motion pins the first variant for every call', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('reduce'), media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const seen = new Set<string>();
      for (let n = 0; n < 6; n += 1) {
        const base = tool('grep', { pattern: 'x' }, 'running');
        const view = render(<ToolCard sessionId="s1" entry={{ ...base, toolCallId: `id-${n}` }} expanded={false} voiceMode="friendly" />);
        seen.add(view.container.querySelector('.tool-name')!.textContent!);
        view.unmount();
      }
      expect([...seen]).toEqual(['Searching for x']);
    } finally {
      window.matchMedia = original;
    }
  });

  it('speaks Chinese when the language is zh-CN and still hides the identifier', () => {
    setLanguage('zh-CN');
    const view = render(<ToolCard sessionId="s1" entry={tool('read_file', { path: 'src/a.ts' }, 'done')} expanded={false} voiceMode="friendly" />);
    expect(view.container.querySelector('.tool-name')!.textContent).toBe('读取文件');
    expect(domText()).not.toContain('read_file');
  });
});
