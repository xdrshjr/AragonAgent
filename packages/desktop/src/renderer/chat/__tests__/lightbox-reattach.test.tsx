/** Completion round P5: the viewer keeps its copy / save / reveal, and gains "Attach to a new message" (AC-L1, AC-L2). */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import { Composer } from '../../composer/Composer.js';
import { resetAttachmentStore } from '../../composer/attachments/attachment-draft-store.js';
import { resetImageOverrides } from '../../composer/attachments/image-input.js';
import { setImageDeps, type ImageDeps } from '../../composer/attachments/image-pipeline.js';
import { clearDrafts } from '../../lib/chat-drafts.js';
import { setLanguage } from '../../i18n/index.js';
import { useUi } from '../../store/ui-store.js';
import { installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { UserMessage } from '../UserMessage.js';
import { mountSession, unmountSession, type FakeHost } from './kit.js';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).buffer;
const meta: AttachmentMeta = {
  id: 'att-000000000001', ref: 'image1', kind: 'image', name: 'shot1.png', size: 4096,
  width: 100, height: 50, thumb: 'data:image/jpeg;base64,/9j/4AAQ', sent: 'inline',
};
const entry: Extract<Entry, { kind: 'user' }> = { id: 'e1', kind: 'user', text: 'look', attachments: [meta] };

const fakeDeps: ImageDeps = {
  decode: async () => ({ width: 100, height: 50, close: () => undefined }),
  encode: async () => new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/jpeg' }),
  toDataUrl: async () => 'data:image/jpeg;base64,AAAA',
};

let host: FakeHost;
beforeEach(() => {
  setLanguage('en');
  clearDrafts();
  resetAttachmentStore();
  resetImageOverrides();
  setImageDeps(fakeDeps);
  useUi.setState({ attachmentsEnabled: true });
  installBridge({
    'native:reveal-attachment': () => ok({ opened: true }),
    'native:save-attachment': () => ok({ path: 'C:/x.png' }),
    'desktop-state:get': () => ok({ enterToSend: true, dismissedHints: ['attachments.reference'] }),
  });
  host = mountSession();
  host.respond = (command) => (command.c === 'attachment.read'
    ? { ok: true, value: { name: 'shot1.png', kind: 'image', mediaType: 'image/png', bytes: PNG_BYTES } }
    : { ok: true });
});
afterEach(() => { cleanup(); unmountSession(); removeBridge(); setImageDeps(null); useUi.setState({ attachmentsEnabled: true }); });

async function openViewer(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Open shot1.png' }));
  await screen.findByRole('dialog');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Show in folder' }).hasAttribute('disabled')).toBe(false));
}

describe('the viewer keeps what it had (AC-L1)', () => {
  it('still offers copy, save and show in folder', async () => {
    render(<UserMessage sessionId="s1" entry={entry} queueNumber={0} />);
    await openViewer();
    for (const name of ['Copy image', 'Save as…', 'Show in folder']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name.replace('…', '')}`) }), name).toBeTruthy();
    }
  });
});

describe('attach again (AC-L2)', () => {
  it('puts the picture into the composer tray as a NEW draft, through the normal pipeline', async () => {
    render(<><UserMessage sessionId="s1" entry={entry} queueNumber={0} /><Composer sessionId="s1" onSent={() => undefined} /></>);
    await act(async () => { await Promise.resolve(); });
    await openViewer();
    fireEvent.click(screen.getByRole('button', { name: 'Attach to a new message' }));
    // The modal viewer hides the page behind it from the accessibility tree, so look in the DOM.
    const trayChips = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.att-chip')];
    await waitFor(() => expect(trayChips().some((chip) => chip.getAttribute('data-status') === 'ready')).toBe(true));
    const chips = trayChips();
    expect(chips).toHaveLength(1);
    expect(chips[0]!.getAttribute('aria-label')).toMatch(/^image1: shot1\.png/);
  });

  it('is absent when the attachments switch is off', async () => {
    useUi.setState({ attachmentsEnabled: false });
    render(<UserMessage sessionId="s1" entry={entry} queueNumber={0} />);
    await openViewer();
    expect(screen.queryByRole('button', { name: 'Attach to a new message' })).toBeNull();
  });

  it('respects the per-message limit like any other attachment', async () => {
    render(<><UserMessage sessionId="s1" entry={entry} queueNumber={0} /><Composer sessionId="s1" onSent={() => undefined} /></>);
    await act(async () => { await Promise.resolve(); });
    await openViewer();
    const button = screen.getByRole('button', { name: 'Attach to a new message' });
    for (let index = 0; index < 9; index += 1) fireEvent.click(button);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const count = document.querySelectorAll('.att-chip').length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(8);
  });
});
