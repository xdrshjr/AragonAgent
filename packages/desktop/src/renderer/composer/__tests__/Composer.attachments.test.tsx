import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession, type FakeHost } from '../../chat/__tests__/kit.js';
import { clearDrafts, getDraft } from '../../lib/chat-drafts.js';
import { resetAttachmentStore } from '../attachments/attachment-draft-store.js';
import { resetImageOverrides } from '../attachments/image-input.js';
import { setImageDeps, type ImageDeps } from '../attachments/image-pipeline.js';
import { sessionStore } from '../../store/session-store.js';
import { Composer } from '../Composer.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const png = (name = 'shot.png'): File => new File([PNG], name, { type: 'image/png' });

/** Decoding is held until the test releases it, so the "processing" state can be observed. */
let release: (() => void) | null = null;
let hold = false;
const fakeDeps: ImageDeps = {
  decode: async () => {
    if (hold) await new Promise<void>((resolve) => { release = resolve; });
    return { width: 120, height: 80, close: () => undefined };
  },
  encode: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
  toDataUrl: async () => 'data:image/jpeg;base64,AAAA',
};

const stats: Record<string, { kind: 'file' | 'folder' | 'missing'; size: number }> = {};
const paths: Record<string, string> = {};

function installBridge(): void {
  window.aragon = {
    platform: 'win32',
    on: () => () => undefined,
    pathForFile: (file: { name: string }) => paths[file.name] ?? '',
    invoke: vi.fn(async (channel: string, arg: { path?: string }) => {
      if (channel === 'desktop-state:get') return { ok: true, value: { enterToSend: true, dismissedHints: ['attachments.reference'] } };
      if (channel === 'native:stat-path') return { ok: true, value: stats[arg.path ?? ''] ?? { kind: 'file', size: 1 } };
      return { ok: false, code: 'internal', message: 'not available in this test' };
    }),
  } as unknown as Window['aragon'];
}

async function renderComposer(host: FakeHost) {
  const view = render(<Composer sessionId={host.id} onSent={() => undefined} />);
  await act(async () => { await Promise.resolve(); });
  return { ...view, box: screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement };
}

const clipboard = (files: File[], text = '') => ({ clipboardData: { getData: () => text, files } });
const type = (box: HTMLTextAreaElement, value: string): void => { fireEvent.change(box, { target: { value } }); };
const chips = (): HTMLElement[] => screen.queryAllByRole('listitem');
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Send' });

function drop(box: HTMLElement, files: File[], shift = false): void {
  const target = box.closest('.composer')!;
  const event = createEvent.drop(target, { dataTransfer: { files, types: ['Files'] } });
  if (shift) Object.defineProperty(event, 'shiftKey', { value: true });
  fireEvent(target, event);
}

let host: FakeHost;
beforeEach(() => {
  installBridge();
  clearDrafts();
  resetAttachmentStore();
  resetImageOverrides();
  hold = false;
  release = null;
  setImageDeps(fakeDeps);
  Object.keys(stats).forEach((key) => delete stats[key]);
  Object.keys(paths).forEach((key) => delete paths[key]);
  host = mountSession();
});
afterEach(() => {
  cleanup();
  unmountSession();
  setImageDeps(null);
});

describe('pasting', () => {
  it('turns a pasted picture into a ready image chip named image1', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('')]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.getAttribute('aria-label')).toMatch(/^image1: Screenshot \d{4}-\d{2}-\d{2} /);
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('ready'));
    expect(chips()[0]!.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('pastes only the text when the clipboard holds text and a picture (a spreadsheet copy)', async () => {
    const { box } = await renderComposer(host);
    const notPrevented = fireEvent.paste(box, clipboard([png()], 'A1\tB1'));
    expect(notPrevented).toBe(true); // the browser inserts the text itself
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
  });

  it('still folds a large text paste into a chip', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([], 'x'.repeat(2500)));
    expect(screen.getByRole('button', { name: /Pasted/ })).toBeTruthy();
    expect(chips()).toHaveLength(0);
  });
});

describe('dropping', () => {
  it('adds an image, a file with a path and a folder as three chips, never copying the user files', async () => {
    paths['run.log'] = 'C:\\work\\run.log';
    paths.notes = 'C:\\work\\notes';
    stats['C:\\work\\run.log'] = { kind: 'file', size: 2048 };
    stats['C:\\work\\notes'] = { kind: 'folder', size: 0 };
    const { box } = await renderComposer(host);
    drop(box, [png('a.png'), new File(['x'], 'run.log'), new File([''], 'notes')]);
    await waitFor(() => expect(chips()).toHaveLength(3));
    expect(chips().map((chip) => chip.getAttribute('data-kind'))).toEqual(['image', 'file', 'folder']);
    expect(box.value).toBe(''); // nothing was typed into the box
  });

  it('keeps the old path-text behaviour while Shift is held', async () => {
    paths['a.png'] = 'C:\\work\\a.png';
    const { box } = await renderComposer(host);
    drop(box, [png('a.png')], true);
    await waitFor(() => expect(box.value).toContain('a.png'));
    expect(chips()).toHaveLength(0);
  });

  it('refuses a ninth picture with a toast and does not add it', async () => {
    const { box } = await renderComposer(host);
    drop(box, Array.from({ length: 9 }, (_unused, index) => png(`p${index}.png`)));
    await waitFor(() => expect(chips()).toHaveLength(8));
    const toasts = (): string[] => (sessionStore.get(host.id)?.view?.toasts ?? []).map((toast) => toast.text);
    await waitFor(() => expect(toasts()).toContain('At most 8 images per message.'));
  });
});

describe('references', () => {
  it('offers the attachments first in the @ menu, filters by prefix and inserts @image1', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('a.png')]));
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('ready'));
    type(box, 'look at @im');
    const list = await screen.findByRole('listbox', { name: 'Files' });
    expect(list.textContent).toContain('Attachments in this message');
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('@image1');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('look at @image1 ');
    expect(host.commandsOf('submit')).toHaveLength(0);
  });

  it('the chip button inserts the reference at the caret', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('a.png')]));
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Refer to image1 in the message' }));
    await waitFor(() => expect(box.value).toBe('@image1 '));
  });

  it('does not recycle a name after a removal, and warns about a reference with no attachment', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('a.png')]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(chips()).toHaveLength(0);
    fireEvent.paste(box, clipboard([png('b.png')]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.getAttribute('aria-label')).toMatch(/^image2:/);
    type(box, 'compare @image1 with it');
    expect(screen.getByText('@image1 does not match any attachment.')).toBeTruthy();
  });
});

describe('sending', () => {
  it('blocks Send with a reason while an attachment is processing, then sends everything', async () => {
    hold = true;
    const { box } = await renderComposer(host);
    type(box, 'what is this');
    fireEvent.paste(box, clipboard([png('a.png')]));
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('processing'));
    expect(sendButton().getAttribute('aria-disabled')).toBe('true');
    expect(sendButton().getAttribute('title')).toBe('Attachments are still being prepared…');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(host.commandsOf('submit')).toHaveLength(0);

    hold = false;
    await act(async () => { release?.(); });
    await waitFor(() => expect(sendButton().getAttribute('aria-disabled')).toBe('false'));
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(host.commandsOf('submit')).toHaveLength(1));
    const [command] = host.commandsOf('submit') as unknown as Array<{ text: string; imageMode: string; attachments: Array<Record<string, unknown>> }>;
    expect(command!.text).toBe('what is this');
    expect(command!.imageMode).toBe('inline');
    expect(command!.attachments).toHaveLength(1);
    expect(command!.attachments[0]).toMatchObject({ ref: 'image1', kind: 'image', name: 'a.png', width: 120, height: 80 });
    expect(command!.attachments[0]!.bytes).toBeInstanceOf(ArrayBuffer);
    // The box and the tray empty; numbering starts over.
    await waitFor(() => expect(chips()).toHaveLength(0));
    fireEvent.paste(box, clipboard([png('c.png')]));
    await waitFor(() => expect(chips()[0]!.getAttribute('aria-label')).toMatch(/^image1:/));
  });

  it('sends a picture on its own, with no caption', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('a.png')]));
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('ready'));
    expect(sendButton().getAttribute('aria-disabled')).toBe('false');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(host.commandsOf('submit')).toHaveLength(1));
    expect((host.commandsOf('submit')[0] as { text: string }).text).toBe('');
  });

  it('a failed image shows its reason, blocks Send and can be removed', async () => {
    setImageDeps({ ...fakeDeps, decode: async () => { throw new Error('bad'); } });
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('a.png')]));
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('error'));
    expect(chips()[0]!.textContent).toContain('Could not read this image');
    expect(sendButton().getAttribute('title')).toBe('Remove or retry the attachment that failed before sending.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(chips()).toHaveLength(0);
  });
});

describe('keyboard', () => {
  it('Backspace on a focused chip removes it and moves focus to the neighbour', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, clipboard([png('a.png'), png('b.png')]));
    await waitFor(() => expect(chips()).toHaveLength(2));
    chips()[0]!.focus();
    fireEvent.keyDown(chips()[0]!, { key: 'Backspace' });
    expect(chips()).toHaveLength(1);
    expect(document.activeElement).toBe(chips()[0]);
    fireEvent.keyDown(chips()[0]!, { key: 'Delete' });
    expect(chips()).toHaveLength(0);
    expect(document.activeElement).toBe(box);
  });

  it('opens the file picker from the [+] menu intent and adds what was picked', async () => {
    const { box } = await renderComposer(host);
    const input = screen.getByTestId('attachment-picker') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    const { emitComposerIntent } = await import('../composer-bus.js');
    act(() => emitComposerIntent('add-files'));
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [png('picked.png')] } });
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(box.value).toBe('');
  });
});

describe('persistence', () => {
  it('keeps only light file references for a reload, never image bytes', async () => {
    paths['run.log'] = 'C:\\work\\run.log';
    stats['C:\\work\\run.log'] = { kind: 'file', size: 10 };
    const { box } = await renderComposer(host);
    drop(box, [png('a.png'), new File(['x'], 'run.log')]);
    await waitFor(() => expect(chips()).toHaveLength(2));
    await waitFor(() => expect(chips()[0]!.getAttribute('data-status')).toBe('ready'));
    const stored = JSON.stringify(sessionStorage);
    expect(stored).not.toContain('AAAA');
    expect(stored).not.toContain('previewUrl');
    expect(getDraft('s1').refs).toEqual([
      { ref: 'image1', kind: 'image', name: 'a.png' },
      { ref: 'file1', kind: 'file', name: 'run.log', path: 'C:\\work\\run.log' },
    ]);
  });
});
