import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialViewState } from '@aragon-agent/tui/model/agent/reducer';
import { setLanguage } from '../../i18n/index.js';
import { installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { mountSession, unmountSession } from '../../panels/__tests__/session-fixture.js';
import { openSession } from '../../store/actions.js';
import { useSessionsList } from '../../store/sessions-list-store.js';
import { useUi } from '../../store/ui-store.js';
import type { SessionRowDto } from '../../../shared/ipc-contract.js';
import { CommandPalette } from '../CommandPalette.js';
import { ShortcutSheet } from '../ShortcutSheet.js';

vi.mock('../../store/actions.js', () => ({
  openSession: vi.fn(async () => ({ ok: true, sessionId: 'opened' })),
  closeSession: vi.fn(async () => undefined),
  reconnectSession: vi.fn(async () => ({ ok: true, sessionId: 'opened' })),
}));

const row = (id: string, title: string, extra: Partial<SessionRowDto> = {}): SessionRowDto => ({
  id, title, cwd: `D:/work/${id}`, groupKey: `d:/work/${id}`, updatedAt: 1, turns: 1, provider: 'anthropic', model: 'm',
  origin: 'tui', pinned: false, unreadable: false, liveElsewhere: false, pending: false, hostStatus: null, ...extra,
});

const palette = (): HTMLElement => screen.getByRole('dialog');
const selectedLabel = (): string | undefined =>
  within(palette()).getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')?.textContent ?? undefined;

beforeEach(() => {
  setLanguage('en');
  installBridge({ 'workspace:pick': () => ok({ path: 'D:/picked' }) });
  useSessionsList.setState({ rows: [row('one', 'Fix the login race'), row('two', 'Refactor the db', { liveElsewhere: true })] });
  useUi.setState({
    paletteOpen: false, shortcutsOpen: false, promptPickerOpen: false, view: 'session', activeSessionId: null,
    sidebarOpen: true, inspectorOpen: false, settingsPage: 'general',
  });
  vi.mocked(openSession).mockClear();
});
afterEach(() => { cleanup(); unmountSession('one'); removeBridge(); });

function openPalette(): void {
  act(() => { useUi.getState().setPaletteOpen(true); });
}

describe('keyboard use', () => {
  it('filters as you type, moves with the arrows and runs the selected item on Enter', async () => {
    render(<CommandPalette />);
    openPalette();
    const user = userEvent.setup({ delay: null });
    expect(await screen.findByRole('combobox')).toBeTruthy();

    await user.keyboard('models');
    expect(selectedLabel()).toBe('Settings: Models');
    await user.keyboard('{Enter}');

    expect(useUi.getState().view).toBe('settings');
    expect(useUi.getState().settingsPage).toBe('models');
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it('wraps around with the arrow keys', async () => {
    render(<CommandPalette />);
    openPalette();
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('combobox');
    const options = within(palette()).getAllByRole('option');
    await user.keyboard('{ArrowUp}');
    expect(selectedLabel()).toBe(options[options.length - 1]!.textContent);
  });

  it('says so when nothing matches', async () => {
    render(<CommandPalette />);
    openPalette();
    await userEvent.setup({ delay: null }).keyboard('qqqqqq');
    expect(await screen.findByText('Nothing matches.')).toBeTruthy();
  });

  it('finds an action by its translated name', async () => {
    setLanguage('zh-CN');
    render(<CommandPalette />);
    openPalette();
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('combobox');
    await user.keyboard('\u6a21\u578b');
    expect(selectedLabel()).toContain('\u6a21\u578b');
    await user.keyboard('{Enter}');
    expect(useUi.getState().settingsPage).toBe('models');
  });
});

describe('focus', () => {
  it('returns to the element that had it before the palette opened', async () => {
    render(<><button>composer</button><CommandPalette /></>);
    const trigger = screen.getByRole('button', { name: 'composer' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    openPalette();
    await screen.findByRole('combobox');
    expect(document.activeElement).not.toBe(trigger);
    await userEvent.setup({ delay: null }).keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus after running an action too', async () => {
    render(<><button>composer</button><CommandPalette /></>);
    const trigger = screen.getByRole('button', { name: 'composer' });
    trigger.focus();
    openPalette();
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('combobox');
    await user.keyboard('toggle sidebar{Enter}');
    expect(useUi.getState().sidebarOpen).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('what it can do', () => {
  it('toggles panels and opens the overlays', async () => {
    render(<CommandPalette />);
    const user = userEvent.setup({ delay: null });
    openPalette();
    await screen.findByRole('combobox');
    await user.keyboard('toggle inspector{Enter}');
    expect(useUi.getState().inspectorOpen).toBe(true);

    openPalette();
    await screen.findByRole('combobox');
    await user.keyboard('prompt library{Enter}');
    expect(useUi.getState().promptPickerOpen).toBe(true);
  });

  it('opens a chosen inspector tab', async () => {
    render(<CommandPalette />);
    openPalette();
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('combobox');
    await user.keyboard('inspector: jobs{Enter}');
    expect(useUi.getState()).toMatchObject({ inspectorTab: 'jobs', inspectorOpen: true });
  });

  it('switches to a session that is already open without reopening it', async () => {
    mountSession('one', initialViewState());
    render(<CommandPalette />);
    openPalette();
    const user = userEvent.setup({ delay: null });
    await screen.findByRole('combobox');
    await user.keyboard('login race{Enter}');
    expect(useUi.getState().activeSessionId).toBe('one');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('opens a saved session, and a session held by a terminal read-only', async () => {
    render(<CommandPalette />);
    const user = userEvent.setup({ delay: null });
    openPalette();
    await screen.findByRole('combobox');
    await user.keyboard('login race{Enter}');
    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ id: 'one', cwd: 'D:/work/one' }));

    openPalette();
    await screen.findByRole('combobox');
    await user.keyboard('refactor{Enter}');
    await waitFor(() => expect(openSession).toHaveBeenLastCalledWith({ id: 'two', cwd: 'D:/work/two', readOnly: true }));
  });

  it('picks a folder for a new session', async () => {
    render(<CommandPalette />);
    openPalette();
    await screen.findByRole('combobox');
    await userEvent.setup({ delay: null }).keyboard('new session{Enter}');
    await waitFor(() => expect(openSession).toHaveBeenCalledWith({ cwd: 'D:/picked' }));
  });
});

describe('ShortcutSheet', () => {
  it('lists the desktop shortcuts and what each terminal key does here', () => {
    render(<ShortcutSheet />);
    act(() => { useUi.getState().setShortcutsOpen(true); });
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getByText('Command palette')).toBeTruthy();
    expect(within(sheet).getByText('Switch to session 1 to 9')).toBeTruthy();
    expect(within(sheet).getByText('Cycle the mode (same key)')).toBeTruthy();
    expect(within(sheet).getByText('Scrolling, selection and mouse: the window handles these itself')).toBeTruthy();
    // Windows in the test bridge: Ctrl, not the command glyph.
    expect(within(sheet).getAllByText('Ctrl').length).toBeGreaterThan(5);
    expect(within(sheet).queryByText('\u2318')).toBeNull();
  });

  it('uses the command glyph on macOS', () => {
    installBridge({}, 'darwin');
    render(<ShortcutSheet />);
    act(() => { useUi.getState().setShortcutsOpen(true); });
    const sheet = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getAllByText('\u2318').length).toBeGreaterThan(5);
  });

  it('closes with its button and gives focus back', async () => {
    render(<><button>opener</button><ShortcutSheet /></>);
    screen.getByRole('button', { name: 'opener' }).focus();
    act(() => { useUi.getState().setShortcutsOpen(true); });
    await userEvent.setup({ delay: null }).click(await screen.findByRole('button', { name: 'Close' }));
    expect(useUi.getState().shortcutsOpen).toBe(false);
  });
});
