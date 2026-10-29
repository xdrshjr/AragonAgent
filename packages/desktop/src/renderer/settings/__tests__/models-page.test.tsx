import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDrafts } from '../../lib/settings-drafts.js';
import { setLanguage } from '../../i18n/index.js';
import { useUi } from '../../store/ui-store.js';
import { REVEAL_MS } from '../connection.js';
import { SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer, type ConfigServer } from './config-server.js';
import { ok, removeBridge } from './test-bridge.js';

function masked(id: string, name: string, tail: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, name, provider: 'anthropic', model: `model-${id}`, baseUrl: null, contextWindow: null,
    key: { present: true, tail, source: 'file' }, ...extra,
  };
}

function libraryView(entries: Array<Record<string, unknown>>, mainId: string | null = null) {
  return makeView({ modelProfiles: { version: 1, entries, mainId, fastId: null, kits: [], defaultKitId: null, kitsVersion: 1 } });
}

let server: ConfigServer;

async function openModels(view = makeView(), extra: Parameters<typeof startConfigServer>[1] = {}, keys: Record<string, string> = {}): Promise<void> {
  server = await startConfigServer(view, extra, keys);
  useUi.setState({ view: 'settings', settingsPage: 'models' });
  render(<SettingsShell />);
}

beforeEach(() => { setLanguage('en'); });
afterEach(() => {
  cleanup();
  removeBridge();
  useDrafts.getState().discardAll();
});

describe('the API key field', () => {
  it('never shows a stored key until asked, then hides it again after 30 seconds', async () => {
    await openModels(libraryView([masked('p1', 'Work', '1234')], 'p1'), {}, { p1: 'sk-real-secret-1234' });
    expect(screen.queryByText(/sk-real-secret/)).toBeNull();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit model profile' });
    const field = within(dialog).getByLabelText('API key') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    expect(field.placeholder).toContain('1234');

    // RTL's async helpers wait on setTimeout, so faking it wholesale would hang them: capture only
    // the reveal timer and fire it by hand.
    const realSetTimeout = globalThis.setTimeout;
    const revealTimers: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === REVEAL_MS) { revealTimers.push(handler); return 0; }
      return realSetTimeout(handler, ms, ...(rest as []));
    }) as unknown as typeof setTimeout);

    await user.click(within(dialog).getByRole('button', { name: 'Show key' }));
    await waitFor(() => expect((within(dialog).getByLabelText('API key') as HTMLInputElement).value).toBe('sk-real-secret-1234'));
    expect(server.bridge.calls('config:reveal-key')).toEqual([{ provider: 'anthropic', profileId: 'p1' }]);
    expect(within(dialog).getByText('The key hides itself again in 30 seconds.')).toBeTruthy();
    expect(REVEAL_MS).toBe(30_000);
    expect(revealTimers).toHaveLength(1);

    await act(async () => { revealTimers[0]!(); });
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).type).toBe('password');
  });

  it('lets a key being typed be shown and hidden without asking the main process', async () => {
    await openModels();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a model profile' });
    await user.type(within(dialog).getByLabelText('API key'), 'sk-typed');
    await user.click(within(dialog).getByRole('button', { name: 'Show key' }));
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).type).toBe('text');
    await user.click(within(dialog).getByRole('button', { name: 'Hide key' }));
    expect((within(dialog).getByLabelText('API key') as HTMLInputElement).type).toBe('password');
    expect(server.bridge.calls('config:reveal-key')).toHaveLength(0);
  });
});

describe('discovery and the connection test on an unsaved draft', () => {
  async function openDraft(): Promise<{ dialog: HTMLElement; user: ReturnType<typeof userEvent.setup> }> {
    await openModels(makeView(), {
      'config:discover-models': () => ok({ models: [{ id: 'gpt-a', name: 'GPT A' }, { id: 'gpt-b' }] }),
    });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a model profile' });
    await user.selectOptions(within(dialog).getByLabelText('Provider'), 'openai');
    await user.type(within(dialog).getByLabelText('Base URL'), 'https://gw.example/v1');
    await user.type(within(dialog).getByLabelText('API key'), 'sk-draft');
    return { dialog, user };
  }

  it('sends the typed key and URL, discovers models, and writes nothing', async () => {
    const { dialog, user } = await openDraft();
    await user.click(within(dialog).getByRole('button', { name: 'Discover models' }));
    expect(await within(dialog).findByText('Found 2 models.')).toBeTruthy();
    expect(server.bridge.calls('config:discover-models')).toEqual([{ provider: 'openai', baseUrl: 'https://gw.example/v1', apiKey: 'sk-draft' }]);
    expect(document.querySelectorAll('#pe-models option')).toHaveLength(2);
    expect(server.patches).toHaveLength(0);
  });

  it('shows the failing stage and an actionable reason for a rejected key', async () => {
    const { dialog, user } = await openDraft();
    server.bridge.set('config:test-connection', () => ok({ ok: false, stage: 'auth', detail: 'HTTP 401 Unauthorized' }));
    await user.type(within(dialog).getByLabelText('Model'), 'gpt-a');
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));

    const stages = await within(dialog).findAllByRole('listitem');
    const text = stages.map((item) => item.textContent);
    expect(text).toEqual([
      'Settingspassed', 'Reach the serverpassed', 'Key acceptedfailed', 'Model availablenot reached', 'Answer streams backnot reached',
    ]);
    expect(within(dialog).getByText(/rejected the key \(401\)/)).toBeTruthy();
    expect(within(dialog).getByText(/HTTP 401 Unauthorized/)).toBeTruthy();
    expect(server.bridge.calls('config:test-connection')).toEqual([
      { provider: 'openai', baseUrl: 'https://gw.example/v1', apiKey: 'sk-draft', model: 'gpt-a' },
    ]);
    expect(server.patches).toHaveLength(0);
  });

  it('points at the base URL and model name for a 404, and at the network for a timeout', async () => {
    const { dialog, user } = await openDraft();
    await user.type(within(dialog).getByLabelText('Model'), 'gpt-a');
    server.bridge.set('config:test-connection', () => ok({ ok: false, stage: 'model', detail: 'HTTP 404' }));
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText(/does not know this model or path \(404\)/)).toBeTruthy();

    server.bridge.set('config:test-connection', () => ok({ ok: false, stage: 'network', detail: 'The connection test timed out.' }));
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText(/Check your network, proxy or VPN/)).toBeTruthy();
  });

  it('reports success with the latency', async () => {
    const { dialog, user } = await openDraft();
    await user.type(within(dialog).getByLabelText('Model'), 'gpt-a');
    server.bridge.set('config:test-connection', () => ok({ ok: true, stage: 'ok', detail: '', latencyMs: 120 }));
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText('Connected in 120 ms.')).toBeTruthy();
  });

  it('forgets a result as soon as the draft changes, so an old verdict never sits beside a new key', async () => {
    const { dialog, user } = await openDraft();
    await user.type(within(dialog).getByLabelText('Model'), 'gpt-a');
    server.bridge.set('config:test-connection', () => ok({ ok: false, stage: 'auth', detail: 'HTTP 401' }));
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    await within(dialog).findByText(/rejected the key/);
    await user.type(within(dialog).getByLabelText('API key'), 'x');
    expect(within(dialog).queryByText(/rejected the key/)).toBeNull();
  });

  it('uses the stored key of a profile being edited when the key field is left empty', async () => {
    await openModels(libraryView([masked('p1', 'Work', '1234')], 'p1'), {
      'config:test-connection': () => ok({ ok: true, stage: 'ok', detail: '', latencyMs: 5 }),
    });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit model profile' });
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    await within(dialog).findByText('Connected in 5 ms.');
    expect(server.bridge.calls('config:test-connection')).toEqual([{ provider: 'anthropic', baseUrl: null, profileId: 'p1', model: 'model-p1' }]);
  });
});

describe('saving the profile library', () => {
  it('writes the whole library once, carrying the stored keys it did not touch', async () => {
    await openModels(libraryView([masked('p1', 'Work', '1111')], 'p1'), {}, { p1: 'sk-existing-1111' });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a model profile' });
    await user.type(within(dialog).getByLabelText('Model'), 'claude-new');
    await user.type(within(dialog).getByLabelText('API key'), 'sk-brand-new');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.patches).toHaveLength(1));
    const library = server.patches[0]!.patch.modelProfiles as { entries: Array<{ model: string; apiKey: string | null }>; mainId: string };
    expect(library.entries.map((entry) => [entry.model, entry.apiKey])).toEqual([['model-p1', 'sk-existing-1111'], ['claude-new', 'sk-brand-new']]);
    expect(library.mainId).toBe('p1');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findAllByText('claude-new', { exact: false })).length).toBeGreaterThan(0);
    expect(screen.getByText('Key …-new')).toBeTruthy();
  });

  it('binds the first profile as the main model', async () => {
    await openModels();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Model'), 'claude-first');
    await user.type(within(dialog).getByLabelText('API key'), 'sk-first');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.patches).toHaveLength(1));
    const library = server.patches[0]!.patch.modelProfiles as { entries: Array<{ id: string }>; mainId: string };
    expect(library.mainId).toBe(library.entries[0]!.id);
  });

  it('keeps the dialog open and names the field when the form is not valid', async () => {
    await openModels();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('This field is required.')).toBeTruthy();
    expect(server.patches).toHaveLength(0);
  });

  it('refuses to save, and says why, when a stored key cannot be read back', async () => {
    await openModels(libraryView([masked('p1', 'Work', '1111')], 'p1'));
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Add profile' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Model'), 'claude-new');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findAllByText(/stored key of "Work" could not be read/)).length).toBeGreaterThan(0);
    expect(server.patches).toHaveLength(0);
  });

  it('does not delete a profile that is bound as the main model', async () => {
    await openModels(libraryView([masked('p1', 'Work', '1111')], 'p1'), {}, { p1: 'k' });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this profile?' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/is bound as the main or fast model/)).toBeTruthy();
    expect(server.patches).toHaveLength(0);
  });

  it('switches the main model with one write', async () => {
    await openModels(libraryView([masked('p1', 'Work', '1111'), masked('p2', 'Home', '2222')], 'p1'), {}, { p1: 'k1', p2: 'k2' });
    const user = userEvent.setup({ delay: null });
    await user.selectOptions(screen.getByLabelText('Main model'), 'p2');
    await waitFor(() => expect(server.patches).toHaveLength(1));
    expect((server.patches[0]!.patch.modelProfiles as { mainId: string }).mainId).toBe('p2');
  });
});
