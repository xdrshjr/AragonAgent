/** Completion round: Settings > General > Image input, and the tool-run folding switch (AC-S2). */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDesktopState, type DesktopState } from '../../../shared/desktop-state.js';
import { mountSession, unmountSession, type FakeHost } from '../../chat/__tests__/kit.js';
import { resetImageOverrides } from '../../composer/attachments/image-input.js';
import { setLanguage } from '../../i18n/index.js';
import { useUi } from '../../store/ui-store.js';
import { SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer } from './config-server.js';
import { ok, removeBridge } from './test-bridge.js';

let state: DesktopState;
let host: FakeHost | null;

async function open(overrides: DesktopState['imageInputOverrides']): Promise<void> {
  state = { ...defaultDesktopState(), imageInputOverrides: overrides };
  await startConfigServer(makeView(), {
    'desktop-state:get': () => ok(state),
    'desktop-state:patch': (arg: Partial<DesktopState>) => { state = { ...state, ...arg }; return ok(state); },
  });
  useUi.setState({ view: 'settings', settingsPage: 'general' });
  render(<SettingsShell />);
}

beforeEach(() => { setLanguage('en'); resetImageOverrides(); host = null; useUi.setState({ groupToolRuns: true }); });
afterEach(() => { cleanup(); removeBridge(); unmountSession(); setLanguage('en'); useUi.setState({ groupToolRuns: true }); });

describe('image input overrides', () => {
  it('says so plainly when there is nothing to show', async () => {
    await open({});
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it('lists every decision with its meaning, and restoring one removes it from the file', async () => {
    const user = userEvent.setup({ delay: null });
    await open({ 'acme/m-1': 'off', 'acme/m-2': 'on' });
    expect(await screen.findByText('m-1')).toBeTruthy();
    expect(screen.getByText(/Pictures are not sent/)).toBeTruthy();
    expect(screen.getByText(/Pictures are always sent/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Restore default for m-1' }));
    await waitFor(() => expect(state.imageInputOverrides).toEqual({ 'acme/m-2': 'on' }));
    await waitFor(() => expect(screen.queryByText('m-1')).toBeNull());
  });

  it('tells an open session on that model that the decision is gone', async () => {
    const user = userEvent.setup({ delay: null });
    host = mountSession({ meta: { provider: 'acme', model: 'm-1' } });
    await open({ 'acme/m-1': 'off' });
    await user.click(await screen.findByRole('button', { name: 'Restore default for m-1' }));
    await waitFor(() => expect(host!.commandsOf('image.override').at(-1)).toMatchObject({ key: 'acme/m-1', value: null }));
  });

  it('keeps a model name that itself contains a slash intact', async () => {
    await open({ 'openrouter/anthropic/claude-x': 'off' });
    expect(await screen.findByText('anthropic/claude-x')).toBeTruthy();
  });
});

describe('folding runs of reads', () => {
  it('is on by default, switches the window at once and is saved in the desktop state', async () => {
    const user = userEvent.setup({ delay: null });
    await open({});
    const toggle = await screen.findByRole('switch', { name: 'Fold runs of reading and searching' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(useUi.getState().groupToolRuns).toBe(false);
    await waitFor(() => expect(state.groupToolRuns).toBe(false));
  });
});
