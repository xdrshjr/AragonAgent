import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../../i18n/index.js';
import { installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { useConfig } from '../../store/config-store.js';
import { useSessionsList } from '../../store/sessions-list-store.js';
import { useUi } from '../../store/ui-store.js';
import { TooltipProvider } from '../../ui/overlay.js';
import { AppShell } from '../AppShell.js';

vi.mock('../../store/actions.js', () => ({
  openSession: vi.fn(async () => ({ ok: true, sessionId: 'opened' })),
  closeSession: vi.fn(async () => undefined),
  reconnectSession: vi.fn(async () => ({ ok: true, sessionId: 'opened' })),
  branchSessionFrom: vi.fn(async () => ({ ok: true, sessionId: 'branched' })),
}));

beforeEach(() => {
  setLanguage('en');
  installBridge({ 'workspace:pick': () => ok({ path: null }) });
  useSessionsList.setState({ rows: [], loaded: true });
  useConfig.setState({ result: null });
  useUi.setState({ view: 'session', activeSessionId: null, developerMode: false });
});
afterEach(() => { cleanup(); removeBridge(); useUi.setState({ developerMode: false }); useConfig.setState({ result: null }); });

const shell = () => render(<TooltipProvider><AppShell recentWorkspaces={[]} noModelBanner={null} /></TooltipProvider>);
const press = () => act(() => { fireEvent.keyDown(window, { key: 'D', ctrlKey: true, shiftKey: true }); });

describe('developer mode', () => {
  it('Ctrl+Shift+D flips the window-wide flag and shows a DEV chip, in memory only', () => {
    shell();
    expect(screen.queryByLabelText('Developer mode is on')).toBeNull();
    press();
    expect(useUi.getState().developerMode).toBe(true);
    expect(screen.getByLabelText('Developer mode is on').textContent).toBe('DEV');
    press();
    expect(useUi.getState().developerMode).toBe(false);
    expect(screen.queryByLabelText('Developer mode is on')).toBeNull();
    // Nothing was written anywhere: no config patch, no desktop-state patch.
    const invoke = window.aragon.invoke as unknown as { mock: { calls: unknown[][] } };
    const writes = invoke.mock.calls.filter(([channel]) => channel === 'config:patch' || channel === 'desktop-state:patch');
    expect(writes).toEqual([]);
  });

  it('starts from config.json developerMode and follows it when the file changes', () => {
    useConfig.setState({ result: { ok: true, view: { developerMode: true } } as never });
    shell();
    expect(useUi.getState().developerMode).toBe(true);
    act(() => { useConfig.setState({ result: { ok: true, view: { developerMode: false } } as never }); });
    expect(useUi.getState().developerMode).toBe(false);
  });
});
