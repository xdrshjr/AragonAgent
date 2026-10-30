import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import { setLanguage } from '../../i18n/index.js';
import { splitMentions } from '../../lib/attachment-text.js';
import { attachmentLines, transcriptToMarkdown, DEFAULT_EXPORT_OPTIONS } from '../../lib/chat-export.js';
import { estimateHeight } from '../../lib/chat-virtual.js';
import { installBridge, ok, removeBridge, type TestBridge } from '../../settings/__tests__/test-bridge.js';
import { UserMessage } from '../UserMessage.js';
import { mountSession, unmountSession, type FakeHost } from './kit.js';

const THUMB = 'data:image/jpeg;base64,/9j/4AAQ';
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

function image(n: number, extra: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: `att-00000000000${n}`, ref: `image${n}`, kind: 'image', name: `shot${n}.png`, size: 4096,
    width: 100, height: 50, thumb: THUMB, sent: 'inline', ...extra,
  };
}
const file: AttachmentMeta = {
  id: 'att-0000000000f1', ref: 'file1', kind: 'file', name: 'build.log', size: 2048, sent: 'reference',
};

const userEntry = (text: string, attachments: AttachmentMeta[]): Extract<Entry, { kind: 'user' }> =>
  ({ id: 'e1', kind: 'user', text, attachments });

let host: FakeHost;
let bridge: TestBridge;

beforeEach(() => {
  setLanguage('en');
  bridge = installBridge({
    'native:reveal-attachment': () => ok({ opened: true }),
    'native:save-attachment': () => ok({ path: 'C:/x.png' }),
  });
  host = mountSession();
  host.respond = (command) => (command.c === 'attachment.read'
    ? { ok: true, value: { name: 'shot1.png', kind: 'image', mediaType: 'image/png', bytes: PNG_BYTES } }
    : { ok: true });
});
afterEach(() => { cleanup(); unmountSession(); removeBridge(); });

const show = (entry: Extract<Entry, { kind: 'user' }>) =>
  render(<UserMessage sessionId="s1" entry={entry} queueNumber={0} />);

describe('attachment strip', () => {
  it('shows one thumbnail per image, with the file as a pill', () => {
    const view = show(userEntry('look', [image(1), image(2), file]));
    expect(view.container.querySelectorAll('.att-thumb')).toHaveLength(2);
    expect(view.container.querySelector('.att-thumb img')!.getAttribute('alt')).toBe('shot1.png');
    expect(screen.getByRole('button', { name: 'File: build.log' })).toBeTruthy();
  });

  it('collapses images past four into +N on the fourth', () => {
    const view = show(userEntry('many', [1, 2, 3, 4, 5, 6].map((n) => image(n))));
    expect(view.container.querySelectorAll('.att-thumb')).toHaveLength(4);
    expect(view.container.querySelector('.att-more')!.textContent).toBe('+2');
  });

  it('marks an image that went as a path, and not one that went inline', () => {
    const view = show(userEntry('x', [image(1, { sent: 'path' }), image(2)]));
    expect(view.container.querySelectorAll('.att-path-mark')).toHaveLength(1);
  });

  it('renders nothing for an entry without attachments, and the text is unchanged', () => {
    const view = show({ id: 'e1', kind: 'user', text: 'plain @image1' });
    expect(view.container.querySelector('.att-strip')).toBeNull();
    expect(view.container.querySelector('.bubble')!.textContent).toBe('plain @image1');
  });
});

describe('@mentions in the bubble', () => {
  it('turns a matching mention into a pill and leaves a non-matching one as text', () => {
    const view = show(userEntry('circle @image1 and @image9, mail me@file1.com', [image(1)]));
    const pills = view.container.querySelectorAll('.att-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0]!.textContent).toBe('@image1');
    // The visible text is the typed text, character for character.
    expect(view.container.querySelector('.bubble')!.textContent).toBe('circle @image1 and @image9, mail me@file1.com');
  });

  it('splitMentions keeps every character and ignores mentions inside words', () => {
    const text = 'a@image1 @image1 @file1';
    const segments = splitMentions(text, [image(1)]);
    expect(segments.map((s) => (s.kind === 'text' ? s.text : `@${s.ref}`)).join('')).toBe(text);
    expect(segments.filter((s) => s.kind === 'mention')).toHaveLength(1);
  });
});

describe('lightbox', () => {
  it('opens on click with the thumbnail, then swaps in the original', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    host.respond = async () => {
      await gate;
      return { ok: true, value: { name: 'shot1.png', kind: 'image', mediaType: 'image/png', bytes: PNG_BYTES } };
    };
    show(userEntry('look', [image(1), image(2)]));
    fireEvent.click(screen.getByRole('button', { name: 'Open shot1.png' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.lightbox-img')!.getAttribute('src')).toBe(THUMB);
    expect(dialog.querySelector('.lightbox-loading')).not.toBeNull();
    release();
    await waitFor(() => expect(dialog.querySelector('.lightbox-img')!.getAttribute('data-original')).toBe('true'));
    expect(dialog.querySelector('.lightbox-img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(host.commandsOf('attachment.read')).toEqual([{ c: 'attachment.read', id: 'att-000000000001' }]);
  });

  it('moves between images with the arrow keys and closes on Escape, returning focus', async () => {
    show(userEntry('look', [image(1), image(2)]));
    const trigger = screen.getByRole('button', { name: 'Open shot1.png' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('1 of 2');
    act(() => { fireEvent.keyDown(document, { key: 'ArrowRight' }); });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('2 of 2'));
    act(() => { fireEvent.keyDown(document, { key: 'ArrowRight' }); });
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('1 of 2'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('keeps the enlarged thumbnail and says so when the original is gone', async () => {
    host.respond = () => ({ ok: false, code: 'not_found', message: 'gone' });
    show(userEntry('look', [image(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Open shot1.png' }));
    expect(await screen.findByText(/no longer on this machine/)).toBeTruthy();
    expect(screen.getByRole('dialog').querySelector('.lightbox-img')!.getAttribute('src')).toBe(THUMB);
  });

  it('reveals through the main process by id, never by path', async () => {
    show(userEntry('look', [image(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Open shot1.png' }));
    const reveal = await screen.findByRole('button', { name: 'Show in folder' });
    await waitFor(() => expect(reveal.hasAttribute('disabled')).toBe(false));
    fireEvent.click(reveal);
    await waitFor(() => expect(bridge.calls('native:reveal-attachment')).toEqual([
      { sessionId: 's1', attachmentId: 'att-000000000001' },
    ]));
  });
});

describe('height estimate and export', () => {
  it('adds the strip height for entries with attachments only', () => {
    const plain: Entry = { id: 'a', kind: 'user', text: 'x' };
    expect(estimateHeight(userEntry('x', [image(1)])) - estimateHeight(plain)).toBe(104);
  });

  it('exports one quoted line per attachment, with no bytes and no path', () => {
    const lines = attachmentLines([image(1), file]);
    expect(lines).toContain('> 📎 image1 — shot1.png (image, 4.0 KB)');
    expect(lines).toContain('> 📎 file1 — build.log (file, 2.0 KB)');
    expect(lines).not.toMatch(/data:|base64|[A-Za-z]:[\\/]/);
    const markdown = transcriptToMarkdown(
      [userEntry('hello', [image(1)])],
      { title: 't', appVersion: '1', exportedAt: '2026-01-01', sessionId: 's1', cwdName: 'repo' },
      DEFAULT_EXPORT_OPTIONS,
    );
    expect(markdown).toContain('hello\n\n> 📎 image1');
  });
});
