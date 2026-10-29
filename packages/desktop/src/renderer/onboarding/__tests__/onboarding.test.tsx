import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import { makeView, startConfigServer, type ConfigServer } from '../../settings/__tests__/config-server.js';
import { ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { openSession } from '../../store/actions.js';
import { Onboarding } from '../Onboarding.js';

// Opening a real session needs a MessagePort handshake; the flow under test only needs to know it was asked.
vi.mock('../../store/actions.js', () => ({
  openSession: vi.fn(async () => ({ ok: true, sessionId: 's1' })),
  closeSession: vi.fn(async () => undefined),
  reconnectSession: vi.fn(async () => ({ ok: true, sessionId: 's1' })),
}));

const PROMPTS = ['Explain this repo', 'Find the bug', 'Write tests', 'Fourth prompt'].map((title, index) => ({
  id: `p${index}`, title, content: title, useCount: 0, updatedAt: index,
}));

let server: ConfigServer;
const onFinished = vi.fn();
const onSkip = vi.fn();

async function start(extra: Parameters<typeof startConfigServer>[1] = {}): Promise<ReturnType<typeof userEvent.setup>> {
  server = await startConfigServer(makeView(), {
    'prompts:list': () => ok(PROMPTS),
    'workspace:recent': () => ok(['D:/work/alpha', 'D:/work/beta']),
    'workspace:pick': () => ok({ path: 'D:/picked' }),
    'config:discover-models': () => ok({ models: [{ id: 'claude-x' }] }),
    ...extra,
  });
  render(<Onboarding onFinished={onFinished} onSkip={onSkip} />);
  return userEvent.setup({ delay: null });
}

const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';

beforeEach(() => { setLanguage('en'); onFinished.mockClear(); onSkip.mockClear(); vi.mocked(openSession).mockClear(); });
afterEach(() => { cleanup(); removeBridge(); });

describe('the three steps', () => {
  it('walks provider, connect, folder, and goes back', async () => {
    const user = await start();
    expect(heading()).toBe('Choose a provider');
    expect(screen.getByText('Provider', { selector: 'li' }).getAttribute('aria-current')).toBe('step');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(heading()).toBe('Connect a model');
    expect(document.activeElement?.id).toBe('onb-title');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(heading()).toBe('Choose a provider');
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true);
  });

  it('needs a key and a model before moving on', async () => {
    const user = await start();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.type(screen.getByLabelText('API key'), 'sk-key');
    expect(next.disabled).toBe(true);
    await user.type(screen.getByLabelText('Model'), 'claude-x');
    expect(next.disabled).toBe(false);
  });

  it('asks for a valid base URL for a custom endpoint', async () => {
    const user = await start();
    await user.click(screen.getByRole('radio', { name: /Custom endpoint/ }));
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.type(screen.getByLabelText('Base URL'), 'nonsense');
    expect(screen.getByRole('alert').textContent).toBe('This value is not valid.');
    expect(next.disabled).toBe(true);
    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'https://gw.example/v1');
    expect(next.disabled).toBe(false);
  });

  it('can be skipped at any step without writing anything', async () => {
    const user = await start();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('API key'), 'sk-key');
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(server.patches).toHaveLength(0);
    expect(onFinished).not.toHaveBeenCalled();
  });
});

describe('the connection check', () => {
  async function toConnect(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('API key'), 'sk-key');
    await user.type(screen.getByLabelText('Model'), 'claude-x');
  }

  it('explains a rejected key in terms of what to do', async () => {
    const user = await start({ 'config:test-connection': () => ok({ ok: false, stage: 'auth', detail: 'HTTP 401' }) });
    await toConnect(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/rejected the key \(401\)/)).toBeTruthy();
    expect(screen.getByText('Key accepted').parentElement?.textContent).toContain('failed');
    expect(screen.getByText('Reach the server').parentElement?.textContent).toContain('passed');
    expect(server.bridge.calls('config:test-connection')).toEqual([{ provider: 'anthropic', baseUrl: null, apiKey: 'sk-key', model: 'claude-x' }]);
  });

  it('points at the URL and model for a 404 and at the network for a timeout', async () => {
    const user = await start({ 'config:test-connection': () => ok({ ok: false, stage: 'model', detail: 'HTTP 404' }) });
    await toConnect(user);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/does not know this model or path \(404\)/)).toBeTruthy();
    server.bridge.set('config:test-connection', () => ok({ ok: false, stage: 'network', detail: 'The connection test timed out.' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/network, proxy or VPN/)).toBeTruthy();
  });

  it('discovers models from the draft and offers them for the model field', async () => {
    const user = await start();
    await toConnect(user);
    await user.click(screen.getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByText('Found 1 models.')).toBeTruthy();
    expect(server.bridge.calls('config:discover-models')).toEqual([{ provider: 'anthropic', baseUrl: null, apiKey: 'sk-key' }]);
    expect(document.querySelectorAll('#onb-models option')).toHaveLength(1);
    expect(server.patches).toHaveLength(0);
  });
});

describe('finishing', () => {
  async function toWorkspace(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('API key'), 'sk-onboard-secret');
    await user.type(screen.getByLabelText('Model'), 'claude-x');
    await user.click(screen.getByRole('button', { name: 'Next' }));
  }

  it('shows the first three library prompts as examples and the recent folders', async () => {
    const user = await start();
    await toWorkspace(user);
    expect(heading()).toBe('Choose a folder to work in');
    const examples = await screen.findByText('Things you can ask for:');
    const list = within(examples.parentElement!).getAllByRole('listitem').map((item) => item.textContent);
    expect(list).toEqual(['Explain this repo', 'Find the bug', 'Write tests']);
    expect(screen.getByRole('radio', { name: 'D:/work/alpha' })).toBeTruthy();
  });

  it('writes the key to disk exactly once, in one patch that also binds the main model', async () => {
    const user = await start({ 'config:test-connection': () => ok({ ok: true, stage: 'ok', detail: '', latencyMs: 3 }) });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('API key'), 'sk-onboard-secret');
    await user.type(screen.getByLabelText('Model'), 'claude-x');
    await user.click(screen.getByRole('button', { name: 'Discover models' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connected in 3 ms.');
    expect(server.patches).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('radio', { name: 'D:/work/beta' }));
    await user.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(server.patches).toHaveLength(1);
    const library = server.patches[0]!.patch.modelProfiles as { entries: Array<{ id: string; provider: string; model: string; apiKey: string }>; mainId: string };
    expect(Object.keys(server.patches[0]!.patch)).toEqual(['modelProfiles']);
    expect(library.entries).toHaveLength(1);
    expect(library.entries[0]).toMatchObject({ provider: 'anthropic', model: 'claude-x', apiKey: 'sk-onboard-secret' });
    expect(library.mainId).toBe(library.entries[0]!.id);
    expect(openSession).toHaveBeenCalledWith({ cwd: 'D:/work/beta' });
    expect(JSON.stringify(server.view())).not.toContain('sk-onboard-secret');
  });

  it('opens no session when the folder is left for later', async () => {
    const user = await start();
    await toWorkspace(user);
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(openSession).not.toHaveBeenCalled();
  });

  it('stays on the last step with a visible error when the save fails', async () => {
    const user = await start({ 'config:patch': () => ok({ ok: false as const, code: 'write_failed', revision: 'r1' }) });
    await toWorkspace(user);
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not save (write_failed). Nothing was changed.');
    expect(onFinished).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Finish' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('writes the OpenAI protocol plus the base URL for a custom endpoint', async () => {
    const user = await start();
    await user.click(screen.getByRole('radio', { name: /Custom endpoint/ }));
    await user.type(screen.getByLabelText('Base URL'), 'https://gw.example/v1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByLabelText('API key'), 'sk-gw');
    await user.type(screen.getByLabelText('Model'), 'local-model');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    const library = server.patches[0]!.patch.modelProfiles as { entries: Array<Record<string, unknown>> };
    expect(library.entries[0]).toMatchObject({ provider: 'openai', baseUrl: 'https://gw.example/v1', model: 'local-model' });
  });
});
