/** Completion round P4: runs of finished reads / searches fold into one row, in a real Transcript. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ViewAction } from '@aragon-agent/tui/model/agent/reducer';
import { setLanguage } from '../../i18n/index.js';
import { useUi } from '../../store/ui-store.js';
import { Transcript, type TranscriptHandle } from '../Transcript.js';
import { mountSession, reduce, unmountSession } from './kit.js';

function call(id: string, name: string, args: Record<string, unknown>, isError = false): ViewAction[] {
  return [
    { type: 'toolCallStart', toolCallId: id, toolName: name },
    { type: 'toolCallEnd', toolCallId: id, args },
    { type: 'toolExecStart', toolCallId: id },
    { type: 'toolExecEnd', toolCallId: id, isError, duration: 20, preview: `result of ${id}` },
  ];
}

/** A turn that reads five files, searches twice and then edits one. */
function exploration(): ViewAction[] {
  return [
    { type: 'submit', text: 'Explore the repo' },
    { type: 'runStart' },
    { type: 'turnStart' },
    ...['a', 'b', 'c', 'd', 'e'].flatMap((name) => call(`r-${name}`, 'read_file', { path: `src/${name}.ts` })),
    ...['x', 'y'].flatMap((name) => call(`g-${name}`, 'grep', { pattern: name })),
    ...call('w1', 'edit_file', { path: 'src/a.ts' }),
    { type: 'turnEnd', usage: { inputTokens: 1, outputTokens: 1 }, costDelta: 0 },
    { type: 'runEnd' },
  ];
}

const groupHeads = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.tool-group-head')];
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.tool')];

beforeEach(() => {
  setLanguage('en');
  useUi.setState({ developerMode: false, groupToolRuns: true, expandedToolGroups: new Set() });
  mountSession({ view: reduce(exploration()) });
});
afterEach(() => { cleanup(); unmountSession(); useUi.setState({ developerMode: false, groupToolRuns: true, expandedToolGroups: new Set() }); });

describe('folded exploration (AC-G1)', () => {
  it('shows ONE summary line for the seven reads and searches, and the edit as its own card', () => {
    render(<Transcript sessionId="s1" />);
    expect(groupHeads()).toHaveLength(1);
    expect(groupHeads()[0]!.textContent).toBe('Looked at 5 files · searched 2 times');
    expect(groupHeads()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(cards()).toHaveLength(1); // only the edit
    expect(cards()[0]!.textContent).not.toContain('result of');
  });

  it('opens in place: the members are the same cards, byte for byte, as without grouping', () => {
    useUi.setState({ groupToolRuns: false });
    const plain = render(<Transcript sessionId="s1" />);
    const without = cards().map((card) => card.outerHTML);
    plain.unmount();
    expect(without).toHaveLength(8);

    useUi.setState({ groupToolRuns: true });
    render(<Transcript sessionId="s1" />);
    fireEvent.click(groupHeads()[0]!);
    expect(groupHeads()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(cards().map((card) => card.outerHTML)).toEqual(without);
    fireEvent.click(groupHeads()[0]!);
    expect(cards()).toHaveLength(1);
  });

  it('names the action for a screen reader, in the voice of the summary', () => {
    render(<Transcript sessionId="s1" />);
    expect(groupHeads()[0]!.getAttribute('aria-label')).toBe('Looked at 5 files · searched 2 times. Show each step');
  });
});

describe('the ways out (AC-G4)', () => {
  it('developer mode shows every call and no group', () => {
    useUi.setState({ developerMode: true });
    render(<Transcript sessionId="s1" />);
    expect(groupHeads()).toHaveLength(0);
    expect(cards()).toHaveLength(8);
  });

  it('the preference switches grouping off', () => {
    useUi.setState({ groupToolRuns: false });
    render(<Transcript sessionId="s1" />);
    expect(groupHeads()).toHaveLength(0);
    expect(cards()).toHaveLength(8);
  });
});

describe('find and jumps (AC-G5)', () => {
  it('scrolling to an entry folded inside a group opens that group first', () => {
    const handle = createRef<TranscriptHandle>();
    render(<Transcript sessionId="s1" ref={handle} />);
    expect(cards()).toHaveLength(1);
    // entries: user(0), assistant? none, then tools - index 3 is the third read.
    act(() => handle.current!.scrollToEntry(4));
    expect(groupHeads()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-entry-id]')).not.toBeNull();
  });

  it('a find match inside a folded member is reachable by its entry id', () => {
    render(<Transcript sessionId="s1" />);
    fireEvent.click(groupHeads()[0]!);
    const members = [...document.querySelectorAll('[data-entry-id]')];
    expect(members).toHaveLength(7);
  });
});

describe('a tool served by another program (AC-M2)', () => {
  function external(name: string): ViewAction[] {
    return [
      { type: 'submit', text: 'go' },
      { type: 'runStart' },
      { type: 'turnStart' },
      ...call('x1', name, { url: 'https://example.com' }),
      { type: 'turnEnd', usage: { inputTokens: 1, outputTokens: 1 }, costDelta: 0 },
      { type: 'runEnd' },
    ];
  }

  it('shows where it came from beside its own title, and never the wrapper name', () => {
    unmountSession();
    mountSession({ view: reduce(external('mcp__playwright__browser_navigate')) });
    render(<Transcript sessionId="s1" />);
    const head = document.querySelector('.tool-head')!;
    expect(head.querySelector('.tool-name')!.textContent).toBe('Browser navigate');
    expect(head.querySelector('.tool-origin')!.textContent).toBe('from playwright');
    expect(head.textContent).not.toContain('mcp__');
  });

  it('developer mode shows the raw name and no label', () => {
    unmountSession();
    mountSession({ view: reduce(external('mcp__playwright__browser_navigate')) });
    useUi.setState({ developerMode: true });
    render(<Transcript sessionId="s1" />);
    const head = document.querySelector('.tool-head')!;
    expect(head.querySelector('.tool-origin')).toBeNull();
    expect(head.textContent).toContain('mcp__playwright__browser_navigate');
  });
});
