/**
 * `CommandRouter` with attachments: a fake controller/interaction, a REAL temp home and ledger,
 * and a REAL structured clone (`MessageChannel`) for the new command shapes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialViewState, viewReducer, type ViewAction, type ViewState } from '@aragon-agent/tui/model/agent/reducer';
import { CommandRouter } from '../command-router.js';
import type { AttachmentReadValue, SubmitAttachment, SubmitResultValue } from '../../shared/attachments.js';
import type { CommandResult, HostCommand } from '../../shared/port-protocol.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const img = (ref: string): SubmitAttachment => ({ ref, kind: 'image', name: `${ref}.png`, bytes: buf(PNG), width: 8, height: 8 });

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'aragon-router-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function make(overrides: { submit?: ReturnType<typeof vi.fn>; withdraw?: string } = {}) {
  let state: ViewState = initialViewState();
  const dispatch = (action: ViewAction): void => { state = viewReducer(state, action); };
  const submit = overrides.submit ?? vi.fn(() => ({ accepted: true }));
  const controller = {
    getImageUsageInHistory: () => ({ bytes: 0, messages: 0, images: 0 }),
    withdrawQueuedUserMessage: vi.fn(() => overrides.withdraw ?? 'withdrawn'),
    isRunning: () => false,
    isCompactionBusy: () => false,
  };
  const interaction = { submit, phase: 'idle' };
  const router = new CommandRouter({
    controller: controller as never, interaction: interaction as never, dispatch,
    readState: () => state, cwd: () => '/work', reloadConfig: () => ({ ok: true }),
    writer: {} as never, sessionId: 'sess-1', homeRoot: home,
  });
  return { router, submit, controller, dispatch, state: () => state };
}

const value = <T>(result: CommandResult): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value as T;
};

describe('submit with attachments', () => {
  it('hands the engine one multimodal message and answers with the final metadata', async () => {
    const { router, submit } = make();
    const result = await router.run({ c: 'submit', text: 'see @image1', attachments: [img('image1')] });
    const out = value<SubmitResultValue>(result);
    expect(out.dropped).toEqual([]);
    expect(out.attachments[0]).toMatchObject({ ref: 'image1', sent: 'inline' });
    expect(submit).toHaveBeenCalledTimes(1);
    const [message, options] = submit.mock.calls[0]!;
    expect(message).toBe('see @image1');
    expect(options.attachments.displayText).toBe('see @image1');
    expect(options.attachments.parts).toHaveLength(3);
    expect(options.attachments.metas).toHaveLength(1);
  });

  it('sends the text even when every attachment is refused, and says what was dropped', async () => {
    const { router, submit } = make();
    const bad: SubmitAttachment = { ref: 'image1', kind: 'image', name: 'x.png', bytes: buf(new TextEncoder().encode('nope')) };
    const out = value<SubmitResultValue>(await router.run({ c: 'submit', text: 'hello', attachments: [bad] }));
    expect(out.dropped).toEqual([{ ref: 'image1', reason: 'bad_type' }]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0]).toBe('hello');
  });

  it('fails with attachment_rejected only when there is no text and nothing survived', async () => {
    const { router, submit } = make();
    const bad: SubmitAttachment = { ref: 'image1', kind: 'image', name: 'x.png', bytes: buf(new TextEncoder().encode('nope')) };
    const result = await router.run({ c: 'submit', text: '  ', attachments: [bad] });
    expect(result).toMatchObject({ ok: false, code: 'attachment_rejected' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps the exact pre-attachments behaviour without attachments', async () => {
    const { router, submit } = make();
    expect(await router.run({ c: 'submit', text: 'plain' })).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledWith('plain');
    expect(await router.run({ c: 'submit', text: '   ' })).toMatchObject({ ok: false, code: 'invalid_argument' });
  });

  it('relays a rejection from the interaction layer', async () => {
    const { router } = make({ submit: vi.fn(() => ({ accepted: false, reason: 'busy starting' })) });
    expect(await router.run({ c: 'submit', text: 'x', attachments: [img('image1')] }))
      .toMatchObject({ ok: false, code: 'rejected', message: 'busy starting' });
  });
});

describe('attachment.read', () => {
  it('returns staged bytes for an id of this session and nothing else', async () => {
    const { router } = make();
    const sent = value<SubmitResultValue>(await router.run({ c: 'submit', text: 'x', attachments: [img('image1')] }));
    const id = sent.attachments[0]!.id;
    const read = value<AttachmentReadValue>(await router.run({ c: 'attachment.read', id }));
    expect(read).toMatchObject({ name: 'image1.png', kind: 'image', mediaType: 'image/png' });
    expect(Array.from(new Uint8Array(read.bytes!))).toEqual(Array.from(PNG));
    for (const bad of ['att-000000000000', '../../etc/passwd', 'att-ZZZZZZZZZZZZ', '']) {
      expect(await router.run({ c: 'attachment.read', id: bad })).toMatchObject({ ok: false, code: 'not_found' });
    }
  });

  it('refuses another session\'s attachment even with a valid id', async () => {
    const a = make();
    const sent = value<SubmitResultValue>(await a.router.run({ c: 'submit', text: 'x', attachments: [img('image1')] }));
    const other = new CommandRouter({
      controller: a.controller as never, interaction: { submit: vi.fn(), phase: 'idle' } as never,
      dispatch: () => undefined, readState: () => a.state(), cwd: () => '/work',
      reloadConfig: () => ({ ok: true }), writer: {} as never, sessionId: 'sess-2', homeRoot: home,
    });
    expect(await other.run({ c: 'attachment.read', id: sent.attachments[0]!.id })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('answers a reference attachment with the path, not bytes', async () => {
    const { router } = make();
    const sent = value<SubmitResultValue>(await router.run({
      c: 'submit', text: 'x', attachments: [{ ref: 'file1', kind: 'file', name: 'tmp', path: tmpdir() }],
    }));
    const read = value<AttachmentReadValue>(await router.run({ c: 'attachment.read', id: sent.attachments[0]!.id }));
    expect(read.path).toBe(tmpdir());
    expect(read.bytes).toBeUndefined();
  });
});

describe('image.override', () => {
  it('forwards the user word for a provider/model key to the controller and validates it', async () => {
    const { router, controller } = make();
    const set = vi.fn();
    (controller as unknown as { setImageSupportOverride: typeof set }).setImageSupportOverride = set;
    expect(await router.run({ c: 'image.override', key: 'openai/mock-1', value: 'off' })).toEqual({ ok: true });
    expect(await router.run({ c: 'image.override', key: 'openai/mock-1', value: null })).toEqual({ ok: true });
    expect(set.mock.calls).toEqual([['openai/mock-1', 'off'], ['openai/mock-1', null]]);
    for (const key of ['', 'no-slash', `p/${'k'.repeat(300)}`]) {
      expect(await router.run({ c: 'image.override', key, value: 'on' })).toMatchObject({ ok: false, code: 'invalid_argument' });
    }
    expect(await router.run({ c: 'image.override', key: 'a/b', value: 'maybe' as never })).toMatchObject({ ok: false });
  });
});

describe('queue.cancel with attachments', () => {
  it('returns the text, the ids and the metadata, and keeps the bytes readable', async () => {
    const submit = vi.fn(() => ({ accepted: true, queueId: 'q1' }));
    const { router, dispatch } = make({ submit });
    const sent = value<SubmitResultValue>(await router.run({ c: 'submit', text: 'later', attachments: [img('image1')] }));
    dispatch({ type: 'steerQueued', queueId: 'q1', text: 'later', attachments: sent.attachments });
    const cancelled = value<{ text: string; attachmentIds: string[]; attachments: unknown[] }>(
      await router.run({ c: 'queue.cancel', queueId: 'q1' }));
    expect(cancelled.text).toBe('later');
    expect(cancelled.attachmentIds).toEqual([sent.attachments[0]!.id]);
    expect(cancelled.attachments).toHaveLength(1);
    expect(await router.run({ c: 'attachment.read', id: cancelled.attachmentIds[0]! })).toMatchObject({ ok: true });
  });

  it('keeps the legacy reply shape for a message without attachments', async () => {
    const { router, dispatch } = make();
    dispatch({ type: 'steerQueued', queueId: 'q2', text: 'plain' });
    expect(await router.run({ c: 'queue.cancel', queueId: 'q2' })).toEqual({ ok: true, value: { text: 'plain' } });
  });
});

describe('port serialisation', () => {
  it('survives a real structured clone, ArrayBuffer included', async () => {
    const { port1, port2 } = new MessageChannel();
    const command: HostCommand = { c: 'submit', text: 'x', imageMode: 'path', attachments: [img('image1')] };
    const received = await new Promise<HostCommand>((resolve) => {
      port2.once('message', resolve);
      port1.postMessage(command);
    });
    port1.close(); port2.close();
    expect(received).toMatchObject({ c: 'submit', imageMode: 'path' });
    const att = (received as Extract<HostCommand, { c: 'submit' }>).attachments![0]!;
    expect(att.bytes).toBeInstanceOf(ArrayBuffer);
    expect(att.bytes!.byteLength).toBe(PNG.length);
  });
});
