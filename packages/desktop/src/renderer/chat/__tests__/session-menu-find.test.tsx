/**
 * AC-77 / AC-78 / AC-81 (component half): the ⋯ session menu is reachable and does what its labels
 * say, `/reset` really resets, and find jumps to a match in a transcript of thousands of rows.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewAction } from '@aragon-agent/tui/model/agent/reducer';
import { runSlashItem } from '../../composer/slash-actions.js';
import { buildSlashItems } from '../../lib/chat-slash.js';
import { sessionStore } from '../../store/session-store.js';
import { useUi } from '../../store/ui-store.js';
import { MenuList, nextEnabled, type MenuItemData } from '../../ui/MenuList.js';
import { FindBar } from '../FindBar.js';
import { SessionBar } from '../SessionBar.js';
import { SESSION_MENU, disabledReasonKey, menuMatrixIds } from '../session-menu.js';
import type { TranscriptHandle } from '../Transcript.js';
import { mountSession, unmountSession, type FakeHost } from './kit.js';

const t = ((key: string) => key) as never;
const invoke = vi.fn(async (_channel: string, _arg?: unknown) => ({ ok: true, value: { opened: true } }));
let host: FakeHost;

beforeEach(() => {
  invoke.mockClear();
  window.aragon = { platform: 'win32', on: () => () => undefined, invoke } as unknown as Window['aragon'];
  useUi.setState({ exportSessionId: null, findSessionId: null });
  host = mountSession();
});
afterEach(() => { cleanup(); unmountSession(); });

const open = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
  await screen.findByRole('menu', { name: 'Session actions' });
};

describe('session menu (AC-78)', () => {
  it('the ⋯ button is a keyboard-reachable menu button; opening it puts focus on the first item', async () => {
    render(<SessionBar sessionId="s1" />);
    const trigger = screen.getByRole('button', { name: 'Session actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await open();
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(expect.arrayContaining(['New conversation', 'Save checkpoint', 'Export as Markdown…']));
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
  });

  it('arrow keys, Home and End move focus and wrap', async () => {
    render(<SessionBar sessionId="s1" />);
    await open();
    const items = screen.getAllByRole('menuitem');
    const menu = screen.getByRole('menu');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    render(<SessionBar sessionId="s1" />);
    await open();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Session actions' })));
  });

  it('"New conversation" is disabled with a reason while a run is in progress, and works when idle', async () => {
    host.dispatch({ type: 'runStart' });
    render(<SessionBar sessionId="s1" />);
    await open();
    const item = screen.getByRole('menuitem', { name: /New conversation/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('Not available while a run is in progress.');
    fireEvent.click(item);
    expect(host.commandsOf('slash')).toEqual([]);
  });

  it('idle: "New conversation" sends exactly the clear command the host recognises', async () => {
    render(<SessionBar sessionId="s1" />);
    await open();
    fireEvent.click(screen.getByRole('menuitem', { name: /New conversation/ }));
    await waitFor(() => expect(host.commandsOf('slash')).toEqual([{ c: 'slash', name: 'clear', args: '' }]));
  });

  it('"Save checkpoint" sends session.save and reports the path', async () => {
    host.respond = (command) => (command.c === 'session.save' ? { ok: true, value: { path: 'C:/home/sessions/s1.json' } } : { ok: true });
    render(<SessionBar sessionId="s1" />);
    await open();
    fireEvent.click(screen.getByRole('menuitem', { name: /Save checkpoint/ }));
    await waitFor(() => expect(host.commandsOf('session.save')).toHaveLength(1));
    await waitFor(() => expect(sessionStore.get('s1')?.view?.toasts.some((toast) => toast.text.includes('C:/home/sessions/s1.json'))).toBe(true));
  });

  it('"Export as Markdown" opens the export dialog for this session', async () => {
    render(<SessionBar sessionId="s1" />);
    await open();
    fireEvent.click(screen.getByRole('menuitem', { name: /Export as Markdown/ }));
    expect(useUi.getState().exportSessionId).toBe('s1');
  });

  it('"Show working folder" asks the main process to reveal the session directory', async () => {
    render(<SessionBar sessionId="s1" />);
    await open();
    fireEvent.click(screen.getByRole('menuitem', { name: /Show working folder/ }));
    expect(invoke).toHaveBeenCalledWith('native:open-path', { sessionId: 's1', relPath: '/work/repo', reveal: true });
  });
});

describe('menu data', () => {
  it('every item that claims a matrix command is claimed by a real one, and ids are unique', () => {
    const ids = SESSION_MENU.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...menuMatrixIds()].sort()).toEqual(['branch', 'clear', 'exit', 'reset', 'save', 'session']);
  });

  it('disabledReasonKey only disables what the context says is unavailable', () => {
    const byId = (id: string) => SESSION_MENU.find((item) => item.id === id)!;
    expect(disabledReasonKey(byId('new'), { running: false, hasCwd: true })).toBeNull();
    expect(disabledReasonKey(byId('new'), { running: true, hasCwd: true })).toBe('chat.menu.newBusy');
    expect(disabledReasonKey(byId('reveal'), { running: false, hasCwd: false })).toBe('chat.bar.cwdNone');
    expect(disabledReasonKey(byId('save'), { running: true, hasCwd: false })).toBeNull();
  });

  it('nextEnabled skips disabled items and wraps', () => {
    const items: MenuItemData[] = [
      { id: 'a', label: 'a' }, { id: 'b', label: 'b', disabled: true }, { id: 'c', label: 'c' },
    ];
    expect(nextEnabled(items, 0, 1)).toBe(2);
    expect(nextEnabled(items, 2, 1)).toBe(0);
    expect(nextEnabled(items, 0, -1)).toBe(2);
    expect(nextEnabled([{ id: 'x', label: 'x', disabled: true }], -1, 1)).toBe(-1);
  });

  it('MenuList does not activate a disabled item', () => {
    const onSelect = vi.fn();
    render(<MenuList label="m" onSelect={onSelect} items={[{ id: 'a', label: 'A', disabled: true, disabledReason: 'why' }, { id: 'b', label: 'B' }]} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /A/ }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /B/ }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });
});

describe('slash commands act (AC-77)', () => {
  const item = (id: string) => buildSlashItems(id).find((candidate) => candidate.id === id)!;

  it('/reset sends {c:"slash", name:"clear", args:""} even when the user typed arguments', async () => {
    runSlashItem(item('reset'), 'ignored arguments', 's1', t);
    await waitFor(() => expect(host.commandsOf('slash')).toEqual([{ c: 'slash', name: 'clear', args: '' }]));
    expect(useUi.getState().sidebarOpen).toBe(true); // and it did NOT just "open the sidebar" as before
  });

  it('/save sends session.save', async () => {
    runSlashItem(item('save'), '', 's1', t);
    await waitFor(() => expect(host.commandsOf('session.save')).toHaveLength(1));
  });

  it('/queue with nothing queued says so instead of silently doing nothing', async () => {
    runSlashItem(item('queue'), '', 's1', t);
    await waitFor(() => expect(sessionStore.get('s1')?.view?.toasts.some((toast) => toast.text === 'chat.queue.empty')).toBe(true));
  });
});

function manyEntries(count: number, needleAt: number): ViewAction[] {
  const actions: ViewAction[] = [];
  for (let index = 0; index < count; index += 1) {
    actions.push({ type: 'submit', text: index === needleAt ? 'the only needle-xyzzy here' : `message number ${index}` });
  }
  return actions;
}

describe('FindBar (AC-81)', () => {
  const handle = () => {
    const ref = createRef<TranscriptHandle>();
    const scrollToEntry = vi.fn();
    (ref as { current: TranscriptHandle | null }).current = {
      resumeFollow: vi.fn(), scrollToEntry, isFollowing: () => true,
    };
    return { ref, scrollToEntry };
  };

  it('finds a phrase far outside any rendered window and jumps to its entry', async () => {
    host.dispatch(...manyEntries(3000, 2141));
    const { ref, scrollToEntry } = handle();
    render(<FindBar sessionId="s1" transcript={ref} />);
    const box = screen.getByRole('textbox', { name: 'Find in conversation' });
    fireEvent.change(box, { target: { value: 'needle-xyzzy' } });
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeTruthy());
    // The reducer may trim the oldest rows, so the index is wherever the entry actually is now.
    const where = sessionStore.get('s1')!.view!.entries.findIndex((entry) => entry.kind === 'user' && entry.text.includes('needle-xyzzy'));
    expect(where).toBeGreaterThan(0);
    await waitFor(() => expect(scrollToEntry).toHaveBeenCalledWith(where));
  });

  it('reports no matches in a live region, and Enter / Shift+Enter wrap through the results', async () => {
    host.dispatch(...manyEntries(5, 99));
    const { ref, scrollToEntry } = handle();
    render(<FindBar sessionId="s1" transcript={ref} />);
    const box = screen.getByRole('textbox', { name: 'Find in conversation' });
    fireEvent.change(box, { target: { value: 'zzz-nothing' } });
    await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy());
    expect(screen.getByText('No matches').getAttribute('aria-live')).toBe('polite');

    fireEvent.change(box, { target: { value: 'message number' } });
    await waitFor(() => expect(screen.getByText('1 of 5')).toBeTruthy());
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('2 of 5')).toBeTruthy());
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(screen.getByText('5 of 5')).toBeTruthy());
    expect(scrollToEntry).toHaveBeenLastCalledWith(4);
  });

  it('Escape closes the bar and asks for composer focus', async () => {
    useUi.setState({ findSessionId: 's1', composerFocusNonce: 0 });
    const { ref } = handle();
    render(<FindBar sessionId="s1" transcript={ref} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Find in conversation' }), { key: 'Escape' });
    expect(useUi.getState().findSessionId).toBeNull();
    expect(useUi.getState().composerFocusNonce).toBe(1);
  });

  it('closing restores following the tail when it was following before', async () => {
    const { ref } = handle();
    const view = render(<FindBar sessionId="s1" transcript={ref} />);
    view.unmount();
    expect((ref.current as TranscriptHandle).resumeFollow).toHaveBeenCalledTimes(1);
  });
});

void act;
