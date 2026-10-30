/** Completion round P3: what the buttons on a "the provider refused the picture" notice do (AC-R1..R4). */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialViewState, type Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import type { HostCommand } from '../../../shared/port-protocol.js';
import { resetImageOverrides } from '../../composer/attachments/image-input.js';
import { resetAttachmentStore } from '../../composer/attachments/attachment-draft-store.js';
import { setLanguage, useT } from '../../i18n/index.js';
import { actionsFor, classifyErrorNotice, noticeHintKey } from '../../lib/chat-errors.js';
import { installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { resetActionToasts } from '../action-toast-store.js';
import { runErrorAction } from '../error-actions.js';
import { NoticeRow } from '../NoticeRow.js';
import { ToastStack } from '../ToastStack.js';
import { mountSession, unmountSession, type FakeHost } from './kit.js';

const REFUSED = 'invalid_request_error: messages.0.content.1: image input is not supported by this model';
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).buffer;

const inlineImage: AttachmentMeta = {
  id: 'att-000000000001', ref: 'image1', kind: 'image', name: 'shot.png', size: 4096,
  width: 100, height: 50, thumb: 'data:image/jpeg;base64,/9j/4AAQ', sent: 'inline',
};
const user = (attachments: AttachmentMeta[]): Entry => ({ id: 'u1', kind: 'user', text: 'what is this?', attachments });
const failure = (text = REFUSED): Entry => ({ id: 'n1', kind: 'notice', level: 'error', text });

let host: FakeHost;
let gate: { release(): void } | null;

/** Hold the acknowledgement of `image.override` until the test lets it go. */
function holdOverrideAck(): void {
  let release = (): void => undefined;
  const open = new Promise<void>((resolve) => { release = resolve; });
  gate = { release };
  host.respond = async (command: HostCommand) => {
    if (command.c === 'image.override') await open;
    if (command.c === 'attachment.read') return { ok: true, value: { name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: PNG_BYTES } };
    return { ok: true };
  };
}

function mount(support: 'yes' | 'no' | 'unknown', entries: Entry[]): void {
  unmountSession();
  host = mountSession({
    view: { ...initialViewState(), entries },
    meta: { provider: 'acme', model: 'm-1', imageInput: { support, source: 'catalog', tokenEstimate: 1600 } },
  });
  host.respond = (command) => (command.c === 'attachment.read'
    ? { ok: true, value: { name: 'shot.png', kind: 'image', mediaType: 'image/png', bytes: PNG_BYTES } }
    : { ok: true });
}

function Harness({ entry }: { entry: Extract<Entry, { kind: 'notice' }> }) {
  const t = useT();
  return (
    <>
      <NoticeRow sessionId="s1" entry={entry} canRetry onAction={(action) => { void runErrorAction('s1', action, t); }} />
      <ToastStack sessionId="s1" />
    </>
  );
}
const show = () => render(<Harness entry={failure() as Extract<Entry, { kind: 'notice' }>} />);
const sentNames = (): string[] => host.commands.map((command) => command.c);

let patches: Array<Record<string, unknown>>;
beforeEach(() => {
  setLanguage('en');
  resetImageOverrides();
  resetAttachmentStore();
  resetActionToasts();
  patches = [];
  installBridge({
    'desktop-state:get': () => ok({ enterToSend: true, imageInputOverrides: {} }),
    'desktop-state:patch': (arg: unknown) => { patches.push(arg as Record<string, unknown>); return ok({ imageInputOverrides: (arg as { imageInputOverrides: unknown }).imageInputOverrides }); },
  });
  gate = null;
});
afterEach(() => { cleanup(); unmountSession(); removeBridge(); });

describe('classification and tiering (pure)', () => {
  it('shows the merged action for unknown / no models and the one-off for yes models', () => {
    const classified = classifyErrorNotice(REFUSED)!;
    expect(actionsFor(classified, 'unknown')).toEqual(['no-image-retry', 'retry']);
    expect(actionsFor(classified, 'no')).toEqual(['no-image-retry', 'retry']);
    expect(actionsFor(classified, 'yes')).toEqual(['send-as-paths', 'retry']);
    expect(noticeHintKey(classified, 'yes')).toBe('chat.error.hint.gateway');
    expect(noticeHintKey(classified, 'unknown')).toBe('chat.error.hint.newMessage');
  });

  it('never offers the permanent action for a complaint about SIZE (AC-R2)', () => {
    for (const text of [
      '400 Bad Request: image exceeds 5 MB maximum',
      'invalid_request_error: image is too large',
      'HTTP 400: image dimensions exceed the limit',
      'invalid_request_error: request payload too large (image_url)',
    ]) {
      const classified = classifyErrorNotice(text);
      expect(classified?.condition, text).not.toBe('image-refused');
    }
  });

  it('leaves every other condition untouched by the tiering', () => {
    const classified = classifyErrorNotice('Rate limited, retry in 5s')!;
    expect(actionsFor(classified, 'unknown')).toEqual(classified.actions);
    expect(noticeHintKey(classified, 'unknown')).toBeNull();
  });
});

describe('AC-R1 · a model of unknown capability refuses the picture', () => {
  it('writes the override and waits for the host BEFORE resending, then resends the pictures as paths', async () => {
    mount('unknown', [user([inlineImage]), failure()]);
    holdOverrideAck();
    show();
    expect(screen.queryByRole('button', { name: 'Send pictures as file paths instead' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /This model cannot see images/ }));

    await waitFor(() => expect(sentNames()).toContain('image.override'));
    expect(host.commandsOf('image.override')[0]).toMatchObject({ key: 'acme/m-1', value: 'off' });
    // Held: nothing may have been resent while the host has not acknowledged the override.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(sentNames()).not.toContain('submit');
    expect(sentNames()).not.toContain('attachment.read');

    act(() => gate!.release());
    await waitFor(() => expect(sentNames()).toContain('submit'));
    expect(sentNames().indexOf('image.override')).toBeLessThan(sentNames().indexOf('submit'));
    expect(JSON.stringify(host.commandsOf('submit')[0])).toContain('path');
    expect(patches.at(-1)).toMatchObject({ imageInputOverrides: { 'acme/m-1': 'off' } });
  });

  it('explains honestly that a new message is added', () => {
    mount('unknown', [user([inlineImage]), failure()]);
    show();
    expect(screen.getByText(/adds a new message to the conversation/)).toBeTruthy();
  });

  it('offers Undo afterwards, which puts the override back to "unset" and tells the host', async () => {
    mount('unknown', [user([inlineImage]), failure()]);
    show();
    fireEvent.click(screen.getByRole('button', { name: /This model cannot see images/ }));
    await screen.findByText(/Marked m-1 as not reading images/);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(host.commandsOf('image.override').at(-1)).toMatchObject({ key: 'acme/m-1', value: null }));
    await waitFor(() => expect(patches.at(-1)).toEqual({ imageInputOverrides: {} }));
  });

  it('does not resend (or write anything) when the host rejects the override', async () => {
    mount('unknown', [user([inlineImage]), failure()]);
    host.respond = (command) => (command.c === 'image.override' ? { ok: false, code: 'rejected', message: 'no' } : { ok: true });
    show();
    fireEvent.click(screen.getByRole('button', { name: /This model cannot see images/ }));
    await waitFor(() => expect(sentNames()).toContain('image.override'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(sentNames()).not.toContain('submit');
  });
});

describe('AC-R3 · the failed turn had no picture but the history does', () => {
  it('records the override and simply retries the text (the host projects old pictures away)', async () => {
    mount('unknown', [user([]), failure()]);
    show();
    fireEvent.click(screen.getByRole('button', { name: /This model cannot see images/ }));
    await waitFor(() => expect(sentNames()).toContain('submit'));
    expect(sentNames().indexOf('image.override')).toBeLessThan(sentNames().indexOf('submit'));
    expect(sentNames()).not.toContain('attachment.read');
    expect(host.commandsOf('submit')[0]).toMatchObject({ text: 'what is this?' });
  });
});

describe('AC-R1b · a model the catalog says reads images', () => {
  it('shows only the one-off button and a gateway hint, never the permanent one', () => {
    mount('yes', [user([inlineImage]), failure()]);
    show();
    expect(screen.getByRole('button', { name: 'Send pictures as file paths instead' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /This model cannot see images/ })).toBeNull();
    expect(screen.getByText(/gateway in between may be dropping them/)).toBeTruthy();
  });

  it('resends once without writing an override, then offers the permanent choice as a follow-up', async () => {
    mount('yes', [user([inlineImage]), failure()]);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Send pictures as file paths instead' }));
    await waitFor(() => expect(sentNames()).toContain('submit'));
    expect(sentNames()).not.toContain('image.override');
    expect(patches).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: 'Never send images to this model' }));
    await waitFor(() => expect(host.commandsOf('image.override')[0]).toMatchObject({ key: 'acme/m-1', value: 'off' }));
  });
});
