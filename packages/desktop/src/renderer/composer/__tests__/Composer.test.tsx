import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession, type FakeHost } from '../../chat/__tests__/kit.js';
import { clearDrafts } from '../../lib/chat-drafts.js';
import { emitComposerIntent } from '../composer-bus.js';
import { Transcript } from '../../chat/Transcript.js';
import { sessionStore } from '../../store/session-store.js';
import { Composer } from '../Composer.js';

function installBridge(enterToSend = true): void {
  window.aragon = {
    platform: 'win32',
    on: () => () => undefined,
    invoke: vi.fn(async (channel: string) => (channel === 'desktop-state:get'
      ? { ok: true, value: { enterToSend } }
      : { ok: false, code: 'internal', message: 'not available in this test' })),
  } as unknown as Window['aragon'];
}

async function renderComposer(host: FakeHost, onSent: () => void = () => undefined) {
  const view = render(<Composer sessionId={host.id} onSent={onSent} />);
  await act(async () => { await Promise.resolve(); }); // let the desktop-state read settle
  return { ...view, box: screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement };
}

const type = (box: HTMLTextAreaElement, value: string): void => { fireEvent.change(box, { target: { value } }); };
const submits = (host: FakeHost): unknown[] => host.commandsOf('submit');

let host: FakeHost;

beforeEach(() => {
  installBridge();
  clearDrafts();
  host = mountSession();
});

afterEach(() => {
  cleanup();
  unmountSession();
  unmountSession('s2');
});

describe('Composer sending', () => {
  it('sends on Enter and clears the box once the host accepted it', async () => {
    const onSent = vi.fn();
    const { box } = await renderComposer(host, onSent);
    type(box, 'hello there');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(submits(host)).toEqual([{ c: 'submit', text: 'hello there' }]));
    await waitFor(() => expect(box.value).toBe(''));
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('never sends on Enter while an IME composition is in progress', async () => {
    const { box } = await renderComposer(host);
    type(box, 'nihao');
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    expect(submits(host)).toHaveLength(0);
    expect(box.value).toBe('nihao');
  });

  it('keeps Shift+Enter for a new line', async () => {
    const { box } = await renderComposer(host);
    type(box, 'line one');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(submits(host)).toHaveLength(0);
  });

  it('does not send an empty message and shows Send as unavailable', async () => {
    const { box } = await renderComposer(host);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(submits(host)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('inverts Enter / Ctrl+Enter when the preference says Enter inserts a newline', async () => {
    installBridge(false);
    const { box } = await renderComposer(host);
    type(box, 'draft');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(submits(host)).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(submits(host)).toHaveLength(1));
  });

  it('moves the message into a bubble that shows the reason, with Retry and Edit, when the host rejects it', async () => {
    host.respond = (command) => (command.c === 'submit'
      ? { ok: false, code: 'rejected', message: 'A run is still starting.' }
      : { ok: true });
    const { box } = await renderComposer(host);
    type(box, 'keep me');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe('')); // the bubble owns the text now
    const bubble = render(<Transcript sessionId={host.id} />).container;
    await waitFor(() => expect(bubble.querySelector('[data-pending="failed"]')).not.toBeNull());
    expect(bubble.querySelector('[data-pending="failed"]')!.textContent).toContain('A run is still starting.');
    expect(bubble.querySelector('[data-pending="failed"]')!.textContent).toContain('keep me');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // Edit hands the text back to the composer and removes the bubble.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(box.value).toBe('keep me'));
    expect(bubble.querySelector('[data-pending]')).toBeNull();
  });
});

describe('Composer while a run is live', () => {
  beforeEach(() => { host.dispatch({ type: 'runStart' }); });

  it('turns the primary button into Queue and adds a labelled Stop button', async () => {
    const { box } = await renderComposer(host);
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    type(box, 'follow-up');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(submits(host)).toEqual([{ c: 'submit', text: 'follow-up' }]));
  });

  it('Esc sends the interrupt command and shows the host\'s "press again" hint', async () => {
    host.respond = (command) => (command.c === 'interrupt' ? { ok: true, value: { action: 'hint' } } : { ok: true });
    const { box } = await renderComposer(host);
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(host.commandsOf('interrupt')).toHaveLength(1));
    expect((await screen.findByRole('status')).textContent).toContain('Press Esc again to stop');
  });

  it('the Stop button takes both steps of the ladder in one click', async () => {
    host.respond = (command) => (command.c === 'interrupt' ? { ok: true, value: { action: 'hint' } } : { ok: true });
    await renderComposer(host);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(host.commandsOf('interrupt')).toHaveLength(2));
  });

  it('does not offer Stop when idle', async () => {
    host.dispatch({ type: 'runEnd' });
    await renderComposer(host);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

describe('Composer paste chip', () => {
  const bigPaste = Array.from({ length: 60 }, (_unused, index) => `line ${index}`).join('\n');

  it('collapses a large paste into a removable chip and sends its full text', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, { clipboardData: { getData: () => bigPaste } });
    expect(box.value).toBe('');
    expect(screen.getByText('Pasted 60 lines')).toBeTruthy();
    type(box, 'summarise this');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(submits(host)).toEqual([{ c: 'submit', text: `${bigPaste}\n\nsummarise this` }]));
    expect(screen.queryByText('Pasted 60 lines')).toBeNull();
  });

  it('lets a small paste through to the textarea untouched', async () => {
    const { box } = await renderComposer(host);
    const notPrevented = fireEvent.paste(box, { clipboardData: { getData: () => 'short' } });
    expect(notPrevented).toBe(true);
    expect(screen.queryByText(/Pasted/)).toBeNull();
  });

  it('removes the chip on request so it is not sent', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, { clipboardData: { getData: () => bigPaste } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text' }));
    expect(screen.queryByText('Pasted 60 lines')).toBeNull();
    type(box, 'x');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(submits(host)).toEqual([{ c: 'submit', text: 'x' }]));
  });
});

describe('Composer slash menu', () => {
  it('opens on "/" with the three groups and greys the commands that do not apply', async () => {
    const { box } = await renderComposer(host);
    type(box, '/');
    const list = screen.getByRole('listbox', { name: 'Commands' });
    expect(list.textContent).toContain('Runs now');
    expect(list.textContent).toContain('Opens a panel');
    expect(list.textContent).toContain('Not applicable in the desktop app');
    const update = screen.getAllByRole('option').find((option) => option.textContent?.startsWith('/update'));
    expect(update?.getAttribute('aria-disabled')).toBe('true');
  });

  it('navigates with the arrow keys and wraps around', async () => {
    const { box } = await renderComposer(host);
    type(box, '/');
    const selected = (): string => screen.getAllByRole('option').findIndex((option) => option.getAttribute('aria-selected') === 'true').toString();
    expect(selected()).toBe('0');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(selected()).toBe('1');
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(selected()).toBe(String(screen.getAllByRole('option').length - 1));
  });

  it('runs /clear on the host when picked with Enter, and does not send it as a message', async () => {
    const { box } = await renderComposer(host);
    type(box, '/clear');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(host.commandsOf('slash')).toEqual([{ c: 'slash', name: 'clear', args: '' }]));
    expect(submits(host)).toHaveLength(0);
    expect(box.value).toBe('');
  });

  it('Esc closes the menu without interrupting anything', async () => {
    host.dispatch({ type: 'runStart' });
    const { box } = await renderComposer(host);
    type(box, '/');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(host.commandsOf('interrupt')).toHaveLength(0);
  });

  it('a typed "/compact focus" sends the slash command with its arguments', async () => {
    const { box } = await renderComposer(host);
    type(box, '/compact keep the schema');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(host.commandsOf('slash')).toEqual([{ c: 'slash', name: 'compact', args: 'keep the schema' }]));
  });
});

describe('Composer @ mentions', () => {
  it('searches after a pause and inserts the picked relative path as text', async () => {
    host.respond = (command) => (command.c === 'files.search'
      ? { ok: true, value: { paths: ['src/a.ts', 'src/b.ts'], truncated: false } }
      : { ok: true });
    const { box } = await renderComposer(host);
    type(box, 'open @sr');
    await screen.findByRole('listbox', { name: 'Files' });
    expect(host.commandsOf('files.search')).toEqual([{ c: 'files.search', query: 'sr' }]);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('open src/b.ts ');
    expect(submits(host)).toHaveLength(0);
  });

  it('drops a stale answer that arrives after a newer query', async () => {
    const resolvers = new Map<string, (paths: string[]) => void>();
    host.respond = (command) => (command.c === 'files.search'
      ? new Promise((resolve) => {
        resolvers.set(command.query, (paths) => resolve({ ok: true, value: { paths, truncated: false } }));
      })
      : { ok: true });
    const { box } = await renderComposer(host);
    type(box, '@a');
    await waitFor(() => expect(resolvers.has('a')).toBe(true));
    type(box, '@ab');
    await waitFor(() => expect(resolvers.has('ab')).toBe(true));
    await act(async () => { resolvers.get('ab')!(['fresh.ts']); });
    await act(async () => { resolvers.get('a')!(['stale.ts']); });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['fresh.ts']);
  });

  it('shows a readable message when the search fails', async () => {
    host.respond = (command) => (command.c === 'files.search'
      ? { ok: false, code: 'timeout', message: 'x' }
      : { ok: true });
    const { box } = await renderComposer(host);
    type(box, '@x');
    expect((await screen.findByRole('alert')).textContent).toContain('did not answer in time');
  });
});

describe('Composer drafts and mode', () => {
  it('keeps a separate draft per session across switches', async () => {
    const first = await renderComposer(host);
    type(first.box, 'draft one');
    first.unmount();
    const second = mountSession({ id: 's2' });
    const secondView = await renderComposer(second);
    expect(secondView.box.value).toBe('');
    type(secondView.box, 'draft two');
    secondView.unmount();
    const back = await renderComposer(host);
    expect(back.box.value).toBe('draft one');
  });

  it('Shift+Tab cycles the posture through the host', async () => {
    const { box } = await renderComposer(host);
    fireEvent.keyDown(box, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(host.commandsOf('posture.cycle')).toHaveLength(1));
    expect(box.value).toBe('');
  });

  it('shows the current model and a dash, not $0, for an unknown cost', async () => {
    await renderComposer(host);
    expect(screen.getByText('test-model')).toBeTruthy();
    expect(document.querySelector('[data-kind="cost"]')?.textContent).toContain(String.fromCharCode(0x2013));
    expect(document.querySelector('[data-kind="cost"]')?.textContent).not.toContain('$0');
  });
});

describe('Composer restoring a withdrawn message', () => {
  it('replaces an empty box with the returned text', async () => {
    const { box } = await renderComposer(host);
    act(() => emitComposerIntent('restore-text', 'take me back'));
    await waitFor(() => expect(box.value).toBe('take me back'));
  });

  it('appends on a new line and never overwrites what was typed meanwhile', async () => {
    const { box } = await renderComposer(host);
    type(box, 'draft in progress');
    act(() => emitComposerIntent('restore-text', 'take me back'));
    await waitFor(() => expect(box.value).toBe('draft in progress\ntake me back'));
    expect(box.selectionStart).toBe(box.value.length);
  });
});

describe('Composer dropping files', () => {
  function drop(box: HTMLElement, files: Array<{ name: string }>): void {
    // Shift keeps the pre-attachments behaviour: the path is inserted as text. jsdom has no
    // DragEvent, so the modifier is attached by hand.
    const event = createEvent.drop(box.closest('.composer')!, { dataTransfer: { files, types: ['Files'] } });
    Object.defineProperty(event, 'shiftKey', { value: true });
    fireEvent(box.closest('.composer')!, event);
  }
  const withPaths = (paths: Record<string, string>) => {
    (window.aragon as unknown as { pathForFile: (file: { name: string }) => string }).pathForFile =
      (file) => paths[file.name] ?? '';
  };

  it('inserts the path relative to the working directory for a file inside it', async () => {
    unmountSession();
    host = mountSession({ meta: { cwd: 'C:\\work\\repo' } });
    const { box } = await renderComposer(host);
    withPaths({ 'a.ts': 'C:\\work\\repo\\src\\a.ts' });
    drop(box, [{ name: 'a.ts' }]);
    await waitFor(() => expect(box.value).toBe('src/a.ts '));
  });

  it('inserts a quoted absolute path and tells the user when the file is outside the directory', async () => {
    unmountSession();
    host = mountSession({ meta: { cwd: 'C:\\work\\repo' } });
    const { box } = await renderComposer(host);
    withPaths({ 'x.txt': 'D:\\elsewhere\\x.txt' });
    drop(box, [{ name: 'x.txt' }]);
    await waitFor(() => expect(box.value).toBe('"D:/elsewhere/x.txt" '));
  });

  it('falls back to the bare name when the page was handed something that is not a file on disk', async () => {
    const { box } = await renderComposer(host);
    withPaths({});
    drop(box, [{ name: 'from-a-browser.png' }]);
    await waitFor(() => expect(box.value).toBe('from-a-browser.png '));
  });
});

describe('Composer [+] menu: build the project index', () => {
  async function openDialog(): Promise<void> {
    await renderComposer(host);
    act(() => emitComposerIntent('open-plus'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Build project index' }));
  }

  it('asks first, and sends nothing until the user confirms', async () => {
    await openDialog();
    expect(await screen.findByText('Build the project index?')).toBeTruthy();
    expect(host.commandsOf('index.build')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Build the project index?')).toBeNull());
    expect(host.commandsOf('index.build')).toHaveLength(0);
  });

  it('sends index.build once on confirm and closes the dialog', async () => {
    await openDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Build index' }));
    await waitFor(() => expect(host.commandsOf('index.build')).toEqual([{ c: 'index.build' }]));
    await waitFor(() => expect(screen.queryByText('Build the project index?')).toBeNull());
  });

  it('tells the user, without an error colour, when the agent is busy', async () => {
    host.respond = (command) => (command.c === 'index.build'
      ? { ok: false, code: 'busy', message: 'The agent is busy.' } : { ok: true });
    await openDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Build index' }));
    await waitFor(() => {
      const toast = sessionStore.get(host.id)?.view?.toasts.at(-1);
      expect(toast).toMatchObject({ level: 'info' });
    });
  });
});
