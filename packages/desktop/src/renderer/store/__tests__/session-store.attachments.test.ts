import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession, type FakeHost } from '../../chat/__tests__/kit.js';
import {
  addAttachmentDraft,
  getAttachmentDrafts,
  resetAttachmentStore,
  type AttachmentDraft,
} from '../../composer/attachments/attachment-draft-store.js';
import type { AttachmentMeta } from '../../../shared/attachments.js';
import { sessionStore } from '../session-store.js';

const BYTES = Uint8Array.from([1, 2, 3, 4]).buffer;
const meta = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  id: 'att-0123456789ab', ref: 'image1', kind: 'image', name: 'a.png', size: 4, sent: 'inline', ...over,
});

function draft(): AttachmentDraft {
  const added = addAttachmentDraft('s1', {
    kind: 'image', name: 'a.png', status: 'ready', bytes: BYTES, size: 4, width: 10, height: 10,
    previewUrl: 'data:image/jpeg;base64,AAAA',
  });
  return added;
}

const toasts = (): string[] => (sessionStore.get('s1')?.view?.toasts ?? []).map((toast) => toast.text);
const settle = (): Promise<void> => act(async () => { await Promise.resolve(); await Promise.resolve(); });

let host: FakeHost;
beforeEach(() => { resetAttachmentStore(); host = mountSession(); });
afterEach(() => { unmountSession(); vi.useRealTimers(); });

describe('sendMessage with attachments', () => {
  it('sends the files and the image mode, and keeps the plain command for a plain message', async () => {
    await sessionStore.sendMessage('s1', 'plain');
    expect(host.commandsOf('submit')).toEqual([{ c: 'submit', text: 'plain' }]);

    const sent = draft();
    await sessionStore.sendMessage('s1', 'look', [sent], 'path');
    const command = host.commandsOf('submit')[1] as unknown as { text: string; imageMode: string; attachments: Array<Record<string, unknown>> };
    expect(command.imageMode).toBe('path');
    expect(command.attachments).toEqual([{
      ref: 'image1', kind: 'image', name: 'a.png', bytes: BYTES, width: 10, height: 10, thumb: 'data:image/jpeg;base64,AAAA',
    }]);
  });

  it('gives a submit with attachments 60 s, and never re-sends it after a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    host.respond = () => new Promise(() => undefined);
    void sessionStore.sendMessage('s1', 'slow', [draft()], 'inline');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessionStore.get('s1')!.pendingSends[0]!.state).toBe('sending'); // past the 15 s of a plain command
    await vi.advanceTimersByTimeAsync(41_000);
    expect(sessionStore.get('s1')!.pendingSends[0]).toMatchObject({ state: 'failed', error: { code: 'timeout' } });
    expect(host.commandsOf('submit')).toHaveLength(1);
  });

  it('Retry resends the very same attachments from the same bubble', async () => {
    let attempt = 0;
    host.respond = (command) => (command.c === 'submit' && ++attempt === 1
      ? { ok: false, code: 'rejected', message: 'No.' }
      : { ok: true });
    await sessionStore.sendMessage('s1', 'try me', [draft()], 'inline');
    const failed = sessionStore.get('s1')!.pendingSends[0]!;
    expect(failed.state).toBe('failed');
    await sessionStore.retrySend('s1', failed.localId);
    const [first, second] = host.commandsOf('submit') as unknown as Array<{ attachments: unknown; imageMode: string }>;
    expect(second!.attachments).toEqual(first!.attachments);
    expect(second!.imageMode).toBe('inline');
  });

  it('Edit puts the text back and the attachments into the tray', async () => {
    host.respond = () => ({ ok: false, code: 'port_closed', message: 'gone' });
    await sessionStore.sendMessage('s1', 'keep', [draft()], 'inline');
    resetAttachmentStore(); // the composer cleared its tray when it handed the message over
    const failed = sessionStore.get('s1')!.pendingSends[0]!;
    expect(sessionStore.takePendingSend('s1', failed.localId)).toBe('keep');
    expect(getAttachmentDrafts('s1')).toMatchObject([{ ref: 'image1', status: 'ready', name: 'a.png' }]);
    expect(getAttachmentDrafts('s1')[0]!.bytes).toBe(BYTES);
  });

  it('says which attachments were refused and which were sent as paths', async () => {
    host.respond = (command) => (command.c === 'submit'
      ? {
        ok: true,
        value: {
          attachments: [meta({ ref: 'image2', name: 'b.png', sent: 'path' })],
          dropped: [{ ref: 'image1', reason: 'bad_type' }],
          downgraded: [{ ref: 'image2', reason: 'session_budget' }],
        },
      }
      : { ok: true });
    await sessionStore.sendMessage('s1', 'x', [draft()], 'inline');
    expect(toasts()).toContain('"image1" was not sent: not a supported image');
    expect(toasts().some((text) => text.includes('"b.png" was sent as a file path'))).toBe(true);
  });
});

describe('withdrawing a queued message', () => {
  it('brings its attachments back through attachment.read, in the original order and naming', async () => {
    host.respond = (command) => {
      if (command.c === 'queue.cancel') {
        return { ok: true, value: { text: 'hello', attachmentIds: ['att-0123456789ab', 'att-ba9876543210'], attachments: [
          meta(), meta({ id: 'att-ba9876543210', ref: 'file1', kind: 'file', name: 'run.log', sent: 'reference' }),
        ] } };
      }
      if (command.c === 'attachment.read') {
        return command.id === 'att-0123456789ab'
          ? { ok: true, value: { name: 'a.png', kind: 'image', mediaType: 'image/png', bytes: BYTES } }
          : { ok: true, value: { name: 'run.log', kind: 'file', path: 'C:\\work\\run.log' } };
      }
      return { ok: true };
    };
    const answer = await sessionStore.command('s1', { c: 'queue.cancel', queueId: 'q1' });
    expect(answer).toMatchObject({ ok: true, value: { text: 'hello' } });
    await settle();
    await vi.waitFor(() => expect(getAttachmentDrafts('s1')).toHaveLength(2));
    expect(getAttachmentDrafts('s1').map((item) => [item.ref, item.status])).toEqual([['image1', 'ready'], ['file1', 'ready']]);
    expect(getAttachmentDrafts('s1')[0]!.bytes).toBe(BYTES);
    expect(getAttachmentDrafts('s1')[1]!.path).toBe('C:\\work\\run.log');
  });

  it('restores what it can and says how many it could not', async () => {
    host.respond = (command) => {
      if (command.c === 'queue.cancel') return { ok: true, value: { text: 'x', attachments: [meta()] } };
      if (command.c === 'attachment.read') return { ok: false, code: 'not_found', message: 'gone' };
      return { ok: true };
    };
    await sessionStore.command('s1', { c: 'queue.cancel', queueId: 'q1' });
    await vi.waitFor(() => expect(toasts()).toContain('1 attachment(s) could not be brought back.'));
    expect(getAttachmentDrafts('s1')).toHaveLength(0);
  });

  it('is a no-op for a message without attachments', async () => {
    host.respond = (command) => (command.c === 'queue.cancel' ? { ok: true, value: { text: 'plain' } } : { ok: true });
    await sessionStore.command('s1', { c: 'queue.cancel', queueId: 'q1' });
    await settle();
    expect(host.commandsOf('attachment.read')).toHaveLength(0);
  });
});
