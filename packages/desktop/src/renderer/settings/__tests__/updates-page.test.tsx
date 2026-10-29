import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import { UpdateBadge } from '../../layout/UpdateBadge.js';
import { useUpdates } from '../../store/update-store.js';
import { useUi } from '../../store/ui-store.js';
import type { UpdateStatus } from '../../../shared/ipc-contract.js';
import { defaultDesktopState } from '../../../shared/desktop-state.js';
import { UpdatesPage } from '../InfoPages.js';
import { installBridge, ok, removeBridge, type TestBridge } from './test-bridge.js';

const AVAILABLE: UpdateStatus = {
  state: 'available', version: '0.2.0', downloadUrl: 'https://downloads.example.com/a.exe', releasedAt: '2026-11-03T00:00:00Z',
};

let bridge: TestBridge;
function setup(check: UpdateStatus, extra: Parameters<typeof installBridge>[0] = {}): void {
  let state = defaultDesktopState();
  bridge = installBridge({
    'update:check': () => ok(check),
    'desktop-state:get': () => ok(state),
    'desktop-state:patch': (arg: never) => { state = { ...state, ...(arg as object) }; return ok(state); },
    ...extra,
  });
}

beforeEach(() => { setLanguage('en'); useUpdates.setState({ status: null }); });
afterEach(() => { cleanup(); removeBridge(); });

describe('Updates page', () => {
  it('offers the download page and Skip when a newer version exists, and says nothing is installed by the app', async () => {
    setup(AVAILABLE);
    render(<UpdatesPage />);
    expect(await screen.findByText('Version 0.2.0 is available.')).toBeTruthy();
    expect(screen.getByText(/downloads\.example\.com\) opens in your browser/)).toBeTruthy();
    expect(screen.getByText(/Nothing is downloaded or installed by this app/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open download page' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip this version' })).toBeTruthy();
  });

  it('opens the download WITHOUT passing a URL: the main process owns the address', async () => {
    setup(AVAILABLE, { 'update:open-download': () => ok({ opened: true }) });
    const user = userEvent.setup({ delay: null });
    render(<UpdatesPage />);
    await user.click(await screen.findByRole('button', { name: 'Open download page' }));
    await waitFor(() => expect(bridge.calls('update:open-download')).toHaveLength(1));
    expect(bridge.calls('update:open-download')[0]).toBeUndefined();
  });

  it('skip sends the version and the page stops offering it', async () => {
    setup(AVAILABLE, { 'update:skip-version': () => ok({ state: 'uptodate', checkedAt: 1 }) });
    const user = userEvent.setup({ delay: null });
    render(<UpdatesPage />);
    await user.click(await screen.findByRole('button', { name: 'Skip this version' }));
    expect(bridge.calls('update:skip-version')).toEqual([{ version: '0.2.0' }]);
    expect(await screen.findByText('You are up to date.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open download page' })).toBeNull();
  });

  it('explains an unsupported build in the app\'s own words and offers no download', async () => {
    setup({ state: 'unsupported', message: 'This build has no update feed configured.' });
    render(<UpdatesPage />);
    expect(await screen.findByText('This build has no update feed configured.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open download page' })).toBeNull();
  });

  it.each([
    ['network', 'Could not reach the update server. Try again later.'],
    ['timeout', 'The update server took too long to answer.'],
    ['bad_manifest', 'The update server sent something this app does not understand.'],
  ] as const)('shows %s as a calm sentence (no dialog, no error code)', async (kind, text) => {
    setup({ state: 'error', kind, checkedAt: 1 });
    render(<UpdatesPage />);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('the automatic-check switch writes the update section and keeps the other fields', async () => {
    setup({ state: 'uptodate', checkedAt: 1 });
    const user = userEvent.setup({ delay: null });
    render(<UpdatesPage />);
    const toggle = await screen.findByRole('switch', { name: 'Check for updates in the background' });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await user.click(toggle);
    await waitFor(() => expect(bridge.calls('desktop-state:patch')).toHaveLength(1));
    expect(bridge.calls('desktop-state:patch')[0]).toMatchObject({ update: { enabled: false, channel: 'stable', skippedVersion: null } });
    expect(screen.getByText(/no identifiers/)).toBeTruthy();
  });
});

describe('UpdateBadge', () => {
  it('shows only while a version is on offer, and opens the Updates page', async () => {
    setup(AVAILABLE);
    const user = userEvent.setup({ delay: null });
    render(<UpdateBadge />);
    expect(screen.queryByRole('button')).toBeNull();
    useUpdates.setState({ status: AVAILABLE });
    await user.click(await screen.findByRole('button', { name: /Version 0\.2\.0 available/ }));
    expect(useUi.getState().settingsPage).toBe('updates');
    useUpdates.setState({ status: { state: 'uptodate', checkedAt: 1 } });
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });
});
