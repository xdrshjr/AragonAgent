import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import { installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { useSessionsList } from '../../store/sessions-list-store.js';
import { useUi } from '../../store/ui-store.js';
import type { SessionRowDto } from '../../../shared/ipc-contract.js';
import { TooltipProvider } from '../../ui/overlay.js';
import { AppShell } from '../AppShell.js';

vi.mock('../../store/actions.js', () => ({
  openSession: vi.fn(async () => ({ ok: true, sessionId: 'opened' })),
  closeSession: vi.fn(async () => undefined),
  reconnectSession: vi.fn(async () => ({ ok: true, sessionId: 'opened' })),
  branchSessionFrom: vi.fn(async () => ({ ok: true, sessionId: 'branched' })),
}));

const row = (id: string, title: string | null): SessionRowDto => ({
  id, title, cwd: `D:/work/${id}`, groupKey: `d:/work/${id}`, updatedAt: 1, turns: 1, provider: 'anthropic', model: 'm',
  origin: 'tui', pinned: false, unreadable: false, liveElsewhere: false, pending: false, hostStatus: null,
});

const LONG = '之前的任务：给这个项目添加完善的用户系统 '.repeat(250); // ~5000 characters, with spaces and a newline below
const MULTILINE = '第一行\n\n   第二行\t第三行';

beforeEach(() => {
  setLanguage('en');
  installBridge({ 'workspace:pick': () => ok({ path: null }) });
  useSessionsList.setState({ rows: [row('one', LONG), row('two', MULTILINE), row('three', null)], loaded: true });
  useUi.setState({
    view: 'session', activeSessionId: null, sidebarOpen: true, sidebarWidth: 260, inspectorOpen: false,
    paletteOpen: false, shortcutsOpen: false, promptPickerOpen: false, settingsPage: 'general',
  });
});
afterEach(() => { cleanup(); removeBridge(); });

const shell = () => render(<TooltipProvider><AppShell recentWorkspaces={[]} noModelBanner={null} /></TooltipProvider>);

describe('title bar: the brand mark replaces the sidebar toggle (AC-95)', () => {
  it('the first element of the title bar is a LOGO image, not a button', () => {
    shell();
    const header = document.querySelector('header.titlebar')!;
    const first = header.firstElementChild as HTMLElement;
    expect(first.querySelector('svg[role="img"]')).not.toBeNull();
    expect(first.tagName).not.toBe('BUTTON');
    expect(within(first as HTMLElement).queryByRole('button')).toBeNull();
    expect(within(first).getByRole('img', { name: 'AragonAgent' })).toBeTruthy();
    // And the old toggle is gone from the bar.
    expect(within(header as HTMLElement).queryByRole('button', { name: 'Toggle sidebar' })).toBeNull();
  });

  it('clicking the mark does nothing', async () => {
    shell();
    const mark = document.querySelector('header.titlebar')!.firstElementChild as HTMLElement;
    await userEvent.setup({ delay: null }).click(mark);
    expect(useUi.getState().sidebarOpen).toBe(true);
    expect(useUi.getState().view).toBe('session');
  });
});

describe('the sidebar still has four ways to be toggled', () => {
  const sessionsButton = (): HTMLElement => within(screen.getByRole('navigation', { name: 'Sessions' })).getAllByRole('button')[0]!;

  it('the rail Sessions button reflects and flips the sidebar (aria-pressed follows visibility)', async () => {
    const user = userEvent.setup({ delay: null });
    shell();
    expect(sessionsButton().getAttribute('aria-pressed')).toBe('true');
    await user.click(sessionsButton());
    expect(useUi.getState().sidebarOpen).toBe(false);
    expect(sessionsButton().getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.sidebar')).toBeNull();
    await user.click(sessionsButton());
    expect(useUi.getState().sidebarOpen).toBe(true);
    expect(document.querySelector('.sidebar-slot .sidebar')).not.toBeNull();
  });

  it('in settings it only returns to the sessions view and leaves the sidebar preference alone (RV-5)', async () => {
    useUi.setState({ view: 'settings', sidebarOpen: false });
    shell();
    expect(sessionsButton().getAttribute('aria-pressed')).toBe('false');
    await userEvent.setup({ delay: null }).click(sessionsButton());
    expect(useUi.getState().view).toBe('session');
    expect(useUi.getState().sidebarOpen).toBe(false);
  });

  it('the sidebar header has a Collapse button', async () => {
    shell();
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useUi.getState().sidebarOpen).toBe(false);
  });

  it('Ctrl+B still toggles it', () => {
    shell();
    act(() => { fireEvent.keyDown(window, { key: 'b', ctrlKey: true }); });
    expect(useUi.getState().sidebarOpen).toBe(false);
  });
});

describe('sidebar rows with very long titles (AC-93)', () => {
  const titles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.srow-title')];

  it('renders a bounded, single-line title and keeps the full text for hover', () => {
    shell();
    const [long, multi, none] = titles();
    expect([...long!.textContent!].length).toBeLessThanOrEqual(201);
    expect(long!.textContent!.endsWith('…')).toBe(true);
    expect(multi!.textContent).toBe('第一行 第二行 第三行'); // no newline can reach a nowrap row
    expect(none!.textContent).toBe('Untitled session');
    const button = long!.closest('button')!;
    expect([...button.title].length).toBeLessThanOrEqual(401);
    expect(button.title.length).toBeGreaterThan(long!.textContent!.length); // hover shows more than the row does
  });

  it('every row sits inside the slot that owns the width', () => {
    shell();
    const slot = document.querySelector<HTMLElement>('.sidebar-slot')!;
    expect(slot.style.width).toBe('260px');
    for (const title of titles()) expect(slot.contains(title)).toBe(true);
  });

  it('the main pane is a sibling of the slot, not a descendant of anything the sidebar can grow', async () => {
    shell();
    await waitFor(() => expect(document.querySelector('main.main')).not.toBeNull());
    const slot = document.querySelector('.sidebar-slot')!;
    expect(slot.contains(document.querySelector('main.main'))).toBe(false);
    expect(slot.parentElement).toBe(document.querySelector('main.main')!.parentElement);
  });
});
