import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession, type FakeHost } from '../../../chat/__tests__/kit.js';
import type { ImageInputView } from '../../../../shared/attachments.js';
import { onComposerIntent } from '../../composer-bus.js';
import { getModeChoice, resetAttachmentStore } from '../attachment-draft-store.js';
import { effectiveImageInput, resetImageOverrides } from '../image-input.js';
import { ImageSupportBanner } from '../ImageSupportBanner.js';
import { useImageMode } from '../use-image-mode.js';

const view = (support: ImageInputView['support'], source: ImageInputView['source'] = 'catalog'): ImageInputView =>
  ({ support, source, tokenEstimate: 1600 });

let host: FakeHost;
let patches: Array<Record<string, unknown>>;

function installBridge(): void {
  patches = [];
  window.aragon = {
    platform: 'win32',
    on: () => () => undefined,
    invoke: vi.fn(async (channel: string, arg: Record<string, unknown>) => {
      if (channel === 'desktop-state:get') return { ok: true, value: { enterToSend: true, imageInputOverrides: {} } };
      if (channel === 'desktop-state:patch') {
        patches.push(arg);
        return { ok: true, value: { imageInputOverrides: arg.imageInputOverrides } };
      }
      return { ok: false, code: 'internal', message: 'n/a' };
    }),
  } as unknown as Window['aragon'];
}

function mount(support: ImageInputView['support']): void {
  unmountSession();
  host = mountSession({ meta: { provider: 'acme', model: 'm-1', imageInput: view(support) } });
}

/** Another snapshot with different capability, as the host sends after a model switch. */
function switchModel(support: ImageInputView['support'], model = 'm-2'): void {
  (host as unknown as { meta: unknown }).meta = { sessionId: 's1', cwd: '/w', provider: 'acme', model, resumed: false,
    postureCycle: ['build'], governanceUnavailable: null, slashCommands: [], imageInput: view(support) };
  host.snapshot();
}

function Probe() {
  const { mode } = useImageMode('s1');
  return <span data-testid="mode">{mode}</span>;
}

const banner = (count = 1, onRemove = () => undefined) =>
  render(<><ImageSupportBanner sessionId="s1" imageCount={count} onRemoveImages={onRemove} /><Probe /></>);
const mode = (): string => screen.getByTestId('mode').textContent ?? '';

beforeEach(() => { installBridge(); resetAttachmentStore(); resetImageOverrides(); });
afterEach(() => { cleanup(); unmountSession(); });

describe('model that reads images (yes)', () => {
  it('shows nothing and sends pictures', () => {
    mount('yes');
    const { container } = banner();
    expect(container.querySelector('.att-banner')).toBeNull();
    expect(mode()).toBe('inline');
  });
});

describe('model that does not (no)', () => {
  beforeEach(() => mount('no'));

  it('warns before sending, defaults to file paths and offers the four ways out', () => {
    banner();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('m-1 may not be able to read images');
    expect(mode()).toBe('path');
    for (const name of ['Send images anyway', 'Attach as file paths', 'Remove images', 'Switch model…']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Attach as file paths' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('is absent with no pictures in the tray', () => {
    const { container } = banner(0);
    expect(container.querySelector('.att-banner')).toBeNull();
  });

  it('"Send images anyway" switches the mode and shrinks to one reversible line', () => {
    banner();
    fireEvent.click(screen.getByRole('button', { name: 'Send images anyway' }));
    expect(mode()).toBe('inline');
    expect(screen.getByRole('status').textContent).toContain('Sending as images');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(getModeChoice('s1')).toBeNull();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('"Remove images" and "Switch model…" act', () => {
    const remove = vi.fn();
    const opened = vi.fn();
    const off = onComposerIntent('open-model', opened);
    banner(1, remove);
    fireEvent.click(screen.getByRole('button', { name: 'Remove images' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch model…' }));
    off();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('remembering "send anyway" writes an override for this model only', async () => {
    banner();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember my choice for this model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send images anyway' }));
    await waitFor(() => expect(patches).toEqual([{ imageInputOverrides: { 'acme/m-1': 'on' } }]));
    // With the override the model now counts as reading images: the banner is gone.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('recomputes when the next snapshot reports another model', async () => {
    banner();
    expect(screen.getByRole('alert')).toBeTruthy();
    switchModel('yes');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(mode()).toBe('inline');
    switchModel('no', 'm-3');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('m-3'));
  });

  it('forgets a "paths" choice once a model that reads images takes over', async () => {
    banner();
    fireEvent.click(screen.getByRole('button', { name: 'Attach as file paths' }));
    expect(mode()).toBe('path');
    switchModel('yes');
    await waitFor(() => expect(mode()).toBe('inline'));
  });
});

describe('model we cannot tell (unknown)', () => {
  beforeEach(() => mount('unknown'));

  it('is one muted line, not an alert, and defaults to sending pictures', () => {
    banner();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Cannot confirm m-1 reads images');
    expect(mode()).toBe('inline');
  });

  it('can switch to paths, and shrinks to a reversible line', () => {
    banner();
    fireEvent.click(screen.getByRole('button', { name: 'Attach as paths instead' }));
    expect(mode()).toBe('path');
    expect(screen.getByRole('status').textContent).toContain('Sending as file paths');
  });

  it('"Don’t ask again" writes override on and the line goes away', async () => {
    banner();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t ask again' }));
    await waitFor(() => expect(patches).toEqual([{ imageInputOverrides: { 'acme/m-1': 'on' } }]));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('the close button hides it for this message only', () => {
    banner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(mode()).toBe('inline');
  });
});

describe('effectiveImageInput', () => {
  it('lets the user override the host in both directions and keeps the token estimate', () => {
    expect(effectiveImageInput(view('no'), { 'p/m': 'on' }, 'p/m')).toEqual({ support: 'yes', source: 'override', tokenEstimate: 1600 });
    expect(effectiveImageInput(view('yes'), { 'p/m': 'off' }, 'p/m')).toMatchObject({ support: 'no', source: 'override' });
    expect(effectiveImageInput(view('unknown'), { 'p/other': 'on' }, 'p/m')).toEqual(view('unknown'));
  });

  it('treats a host that sends no capability as unknown', () => {
    expect(effectiveImageInput(undefined, {}, 'p/m').support).toBe('unknown');
  });
});
