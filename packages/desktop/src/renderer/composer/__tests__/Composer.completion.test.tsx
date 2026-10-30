/** Completion round: feature switch, undo of a removal, and the chip's preview. */
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetActionToasts } from '../../chat/action-toast-store.js';
import { mountSession, unmountSession, type FakeHost } from '../../chat/__tests__/kit.js';
import { ToastStack } from '../../chat/ToastStack.js';
import { clearDrafts } from '../../lib/chat-drafts.js';
import { useUi } from '../../store/ui-store.js';
import { removedBufferSize, resetAttachmentStore } from '../attachments/attachment-draft-store.js';
import { resetImageOverrides } from '../attachments/image-input.js';
import { setImageDeps, type ImageDeps } from '../attachments/image-pipeline.js';
import { sessionStore } from '../../store/session-store.js';
import { emitComposerIntent } from '../composer-bus.js';
import { Composer } from '../Composer.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const png = (name = 'shot.png'): File => new File([PNG], name, { type: 'image/png' });

const fakeDeps: ImageDeps = {
  decode: async () => ({ width: 120, height: 80, close: () => undefined }),
  encode: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
  toDataUrl: async () => 'data:image/jpeg;base64,AAAA',
};

/** What `native:read-clipboard-image` answers in the current test. */
let clipboardReply: unknown = { ok: true, value: null };

function installBridge(): void {
  clipboardReply = { ok: true, value: null };
  window.aragon = {
    platform: 'win32',
    on: () => () => undefined,
    pathForFile: () => '',
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'desktop-state:get') return { ok: true, value: { enterToSend: true, dismissedHints: ['attachments.reference'] } };
      if (channel === 'native:read-clipboard-image') return clipboardReply;
      return { ok: false, code: 'internal', message: 'not available in this test' };
    }),
  } as unknown as Window['aragon'];
}

const clipboardCalls = (): number =>
  (window.aragon.invoke as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([channel]) => channel === 'native:read-clipboard-image').length;

async function renderComposer(host: FakeHost) {
  const view = render(<><Composer sessionId={host.id} onSent={() => undefined} /><ToastStack sessionId={host.id} /></>);
  await act(async () => { await Promise.resolve(); });
  return { ...view, box: screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement };
}

const clipboard = (files: File[], text = '') => ({ clipboardData: { getData: () => text, files, types: files.length ? ['Files'] : [] } });
const chips = (): HTMLElement[] => screen.queryAllByRole('listitem');

let host: FakeHost;
beforeEach(() => {
  installBridge();
  clearDrafts();
  resetAttachmentStore();
  resetImageOverrides();
  resetActionToasts();
  useUi.setState({ attachmentsEnabled: true });
  setImageDeps(fakeDeps);
  host = mountSession();
});
afterEach(() => {
  cleanup();
  unmountSession();
  setImageDeps(null);
  useUi.setState({ attachmentsEnabled: true });
});

async function pasteOne(box: HTMLElement, name = 'a.png'): Promise<void> {
  fireEvent.paste(box, clipboard([png(name)]));
  await waitFor(() => expect(chips().some((chip) => chip.getAttribute('data-status') === 'ready')).toBe(true));
}

describe('ARAGON_DESKTOP_ATTACHMENTS=0 (AC-F1)', () => {
  beforeEach(() => { useUi.setState({ attachmentsEnabled: false }); });

  it('does not intercept a pasted picture and creates no chip', async () => {
    const { box } = await renderComposer(host);
    const notPrevented = fireEvent.paste(box, clipboard([png()]));
    expect(notPrevented).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
  });

  it('inserts the path text for a drop, as if Shift were held', async () => {
    (window.aragon as { pathForFile?: unknown }).pathForFile = () => 'C:\\work\\a.png';
    const { box } = await renderComposer(host);
    const target = box.closest('.composer')!;
    fireEvent(target, createEvent.drop(target, { dataTransfer: { files: [png('a.png')], types: ['Files'] } }));
    await waitFor(() => expect(box.value).toContain('a.png'));
    expect(chips()).toHaveLength(0);
  });

  it('renders no file input and no tray', async () => {
    await renderComposer(host);
    expect(screen.queryByTestId('attachment-picker')).toBeNull();
  });

  it('is back on when the switch is on (default)', async () => {
    useUi.setState({ attachmentsEnabled: true });
    await renderComposer(host);
    expect(screen.getByTestId('attachment-picker')).toBeTruthy();
  });
});

describe('removing is undoable (AC-U1)', () => {
  it('Undo brings the same picture back under the same reference', async () => {
    const { box } = await renderComposer(host);
    await pasteOne(box, 'a.png');
    expect(chips()[0]!.getAttribute('aria-label')).toMatch(/^image1: a\.png/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(chips()).toHaveLength(0);
    expect(removedBufferSize(host.id)).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(chips()[0]!.getAttribute('aria-label')).toMatch(/^image1: a\.png/);
    expect(chips()[0]!.getAttribute('data-status')).toBe('ready');
  });

  it('removing with the keyboard offers the same Undo', async () => {
    const { box } = await renderComposer(host);
    await pasteOne(box);
    fireEvent.keyDown(chips()[0]!, { key: 'Delete' });
    expect(chips()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('leaving the session ends the undo window', async () => {
    const { box, unmount } = await renderComposer(host);
    await pasteOne(box);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(removedBufferSize(host.id)).toBe(1);
    unmount();
    expect(removedBufferSize(host.id)).toBe(0);
  });
});

describe('previewing a picture in the tray (AC-U4)', () => {
  it('opens the processed picture from a data: URL and returns focus to the button', async () => {
    const { box } = await renderComposer(host);
    await pasteOne(box);
    const button = screen.getByRole('button', { name: 'Preview a.png' });
    button.focus();
    fireEvent.click(button);
    const image = await screen.findByRole('img', { name: 'a.png' });
    expect(image.getAttribute('src')).toMatch(/^data:image\/(png|jpeg);base64,/);
    expect(image.getAttribute('src')!.startsWith('blob:')).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('has no Preview for a file chip', async () => {
    (window.aragon as { pathForFile?: unknown }).pathForFile = () => 'C:\\work\\run.log';
    const { box } = await renderComposer(host);
    const target = box.closest('.composer')!;
    fireEvent(target, createEvent.drop(target, { dataTransfer: { files: [new File(['x'], 'run.log')], types: ['Files'] } }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(screen.queryByRole('button', { name: /^Preview/ })).toBeNull();
  });
});

/** A real browser's ClipboardEvent data: `types` is always present and lists what is on the clipboard. */
const rich = (over: { files?: File[]; items?: unknown[]; types: string[]; text?: string }) => ({
  clipboardData: { getData: () => over.text ?? '', files: over.files ?? [], items: over.items ?? [], types: over.types },
});

describe('paste fallbacks (AC-P1..P3)', () => {
  it('P1: finds a picture that is only in clipboardData.items', async () => {
    const { box } = await renderComposer(host);
    const item = { kind: 'file', type: 'image/png', getAsFile: () => png('from-item.png') };
    fireEvent.paste(box, rich({ items: [item], types: ['Files'] }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(clipboardCalls()).toBe(0);
  });

  it('P2: a clipboard that lists no text or file format asks the OS, and the picture becomes a chip', async () => {
    clipboardReply = { ok: true, value: { bytes: PNG.buffer.slice(0), width: 120, height: 80 } };
    const { box } = await renderComposer(host);
    const notPrevented = fireEvent.paste(box, rich({ types: ['application/x-private-dib'] }));
    expect(notPrevented).toBe(false); // the default paste was cancelled: we are handling it
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(clipboardCalls()).toBe(1);
  });

  it('P2: nothing on the OS clipboard means no chip and NO feedback at all', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, rich({ types: [] }));
    await waitFor(() => expect(clipboardCalls()).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect(chips()).toHaveLength(0);
    expect(screen.queryByRole('status')?.textContent ?? '').not.toMatch(/clipboard/i);
  });

  it('P2: a too_large answer tells the user', async () => {
    clipboardReply = { ok: false, code: 'too_large', message: 'x' };
    const { box } = await renderComposer(host);
    fireEvent.paste(box, rich({ types: [] }));
    await waitFor(() => expect(sessionToasts()).toContain('The image on the clipboard is too large to attach.'));
  });

  it('P3: pasting text never asks the OS', async () => {
    const { box } = await renderComposer(host);
    fireEvent.paste(box, rich({ types: ['text/plain'], text: 'hello' }));
    expect(clipboardCalls()).toBe(0);
  });

  it('P3: html or a uri-list with NO plain text is left to the browser (RV-5)', async () => {
    const { box } = await renderComposer(host);
    for (const types of [['text/html'], ['text/uri-list'], ['text/html', 'text/uri-list']]) {
      const notPrevented = fireEvent.paste(box, rich({ types }));
      expect(notPrevented).toBe(true);
    }
    expect(clipboardCalls()).toBe(0);
  });

  it('a paste and a menu click at the same moment add the picture once', async () => {
    clipboardReply = { ok: true, value: { bytes: PNG.buffer.slice(0), width: 120, height: 80 } };
    const { box } = await renderComposer(host);
    fireEvent.paste(box, rich({ types: [] }));
    fireEvent.paste(box, rich({ types: [] }));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(clipboardCalls()).toBe(1);
  });

  it('with the feature switched off, no paste ever reaches the clipboard channel', async () => {
    useUi.setState({ attachmentsEnabled: false });
    const { box } = await renderComposer(host);
    const notPrevented = fireEvent.paste(box, rich({ types: [] }));
    expect(notPrevented).toBe(true);
    expect(clipboardCalls()).toBe(0);
  });
});

describe('"Paste image from clipboard" in the + menu (P-2)', () => {
  it('reports an empty clipboard when the user asked for it explicitly', async () => {
    await renderComposer(host);
    emitComposerIntent('paste-clipboard-image');
    await waitFor(() => expect(sessionToasts()).toContain('There is no image on the clipboard.'));
  });

  it('adds the picture when there is one', async () => {
    clipboardReply = { ok: true, value: { bytes: PNG.buffer.slice(0), width: 120, height: 80 } };
    await renderComposer(host);
    emitComposerIntent('paste-clipboard-image');
    await waitFor(() => expect(chips()).toHaveLength(1));
  });
});

function sessionToasts(): string[] {
  return (sessionStore.get(host.id)?.view?.toasts ?? []).map((toast) => toast.text);
}

describe('the tray speaks for people who cannot see it change (AC-A1)', () => {
  const live = (): string => document.querySelector('.composer [aria-live="polite"][aria-atomic="true"]')?.textContent ?? '';

  it('says nothing on first render, announces an addition, then a removal (including the last one)', async () => {
    const { box } = await renderComposer(host);
    expect(live()).toBe('');
    await pasteOne(box, 'a.png');
    await waitFor(() => expect(live()).toBe('Added a.png. 1 attachments in this message.'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    await waitFor(() => expect(live()).toBe('Removed. 0 attachments in this message.'));
  });

  it('thumbnails carry the name and size as their alt text', async () => {
    const { box } = await renderComposer(host);
    await pasteOne(box, 'a.png');
    expect(chips()[0]!.querySelector('img')?.getAttribute('alt')).toBe('a.png, 120×80');
  });
});
