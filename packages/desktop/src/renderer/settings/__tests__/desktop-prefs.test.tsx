import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDesktopState, type DesktopState } from '../../../shared/desktop-state.js';
import { getLanguage, setLanguage } from '../../i18n/index.js';
import { useUi } from '../../store/ui-store.js';
import { SettingsShell } from '../SettingsShell.js';
import { makeView, startConfigServer, type ConfigServer } from './config-server.js';
import { ok, removeBridge } from './test-bridge.js';

let server: ConfigServer;
let state: DesktopState;

beforeEach(async () => {
  setLanguage('en');
  state = defaultDesktopState();
  server = await startConfigServer(makeView(), {
    'desktop-state:get': () => ok(state),
    'desktop-state:patch': (arg: Partial<DesktopState>) => { state = { ...state, ...arg }; return ok(state); },
  });
  useUi.setState({ view: 'settings', settingsPage: 'general' });
  render(<SettingsShell />);
});
afterEach(() => { cleanup(); removeBridge(); setLanguage('en'); });

describe('desktop-only preferences', () => {
  it('switches the language at once and stores it in the desktop state', async () => {
    const user = userEvent.setup({ delay: null });
    await user.selectOptions(await screen.findByLabelText('Language'), 'zh-CN');
    await waitFor(() => expect(state.language).toBe('zh-CN'));
    expect(getLanguage()).toBe('zh-CN');
    expect(await screen.findByRole('heading', { level: 1, name: '通用' })).toBeTruthy();
    expect(server.patches).toHaveLength(0);
  });

  it('clamps a number to the limits the main process enforces and says so', async () => {
    const user = userEvent.setup({ delay: null });
    const field = await screen.findByLabelText('Sessions kept running');
    await user.clear(field);
    await user.type(field, '99');
    await user.tab();
    await waitFor(() => expect(state.maxLiveHosts).toBe(12));
    expect((screen.getByLabelText('Sessions kept running') as HTMLInputElement).value).toBe('12');
    expect(screen.getByText('Will be saved as 12 (adjusted to the allowed range).')).toBeTruthy();
  });

  it('commits a number with Enter, and writes nothing when the value did not change', async () => {
    const user = userEvent.setup({ delay: null });
    const field = await screen.findByLabelText('Sleep idle sessions after (minutes)');
    await user.clear(field);
    await user.type(field, '30{Enter}');
    await waitFor(() => expect(state.parkAfterIdleMinutes).toBe(30));
    const before = server.bridge.calls('desktop-state:patch').length;
    await user.click(field);
    await user.tab();
    expect(server.bridge.calls('desktop-state:patch')).toHaveLength(before);
  });

  it('never touches config.json', async () => {
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole('switch', { name: 'Enter sends the message' }));
    await waitFor(() => expect(state.enterToSend).toBe(false));
    expect(server.patches).toHaveLength(0);
  });
});
