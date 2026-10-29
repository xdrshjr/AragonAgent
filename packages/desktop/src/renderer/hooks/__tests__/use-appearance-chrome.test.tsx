import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installBridge, ok, removeBridge, type TestBridge } from '../../settings/__tests__/test-bridge.js';
import { useAppearance, type ThemeSetting } from '../use-appearance.js';

let bridge: TestBridge;
beforeEach(() => { bridge = installBridge({ 'window:set-chrome': () => ok({ applied: true }) }); });
afterEach(() => { cleanup(); removeBridge(); });

type Props = { theme: ThemeSetting | undefined; enabled: boolean };
const mount = (initial: Props) => renderHook(
  (props: Props) => useAppearance({ theme: props.theme, density: undefined, reducedMotion: undefined, enabled: props.enabled }),
  { initialProps: initial },
);

describe('window:set-chrome from useAppearance (RV-3)', () => {
  it('sends nothing before the config has loaded, even though the theme already resolved to "auto"', async () => {
    mount({ theme: undefined, enabled: false });
    await act(async () => { await Promise.resolve(); });
    expect(bridge.calls('window:set-chrome')).toEqual([]);
  });

  it('sends the resolved theme once the config is in, and only once for the same value', async () => {
    const { rerender } = mount({ theme: undefined, enabled: false });
    rerender({ theme: 'warm', enabled: true });
    await waitFor(() => expect(bridge.calls('window:set-chrome')).toEqual([{ theme: 'warm' }]));
    rerender({ theme: 'warm', enabled: true });
    await act(async () => { await Promise.resolve(); });
    expect(bridge.calls('window:set-chrome')).toHaveLength(1);
  });

  it('resolves "cool" to dark and re-sends when the theme changes', async () => {
    const { rerender } = mount({ theme: 'cool', enabled: true });
    await waitFor(() => expect(bridge.calls('window:set-chrome')).toEqual([{ theme: 'dark' }]));
    rerender({ theme: 'light', enabled: true });
    await waitFor(() => expect(bridge.calls('window:set-chrome')).toEqual([{ theme: 'dark' }, { theme: 'light' }]));
  });

  it('does not treat a failed call as delivered: the next enable sends again', async () => {
    bridge.set('window:set-chrome', () => ({ ok: false, code: 'internal', message: 'nope' }));
    const { rerender } = mount({ theme: 'light', enabled: false });
    rerender({ theme: 'light', enabled: true });
    await waitFor(() => expect(bridge.calls('window:set-chrome')).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    bridge.set('window:set-chrome', () => ok({ applied: true }));
    rerender({ theme: 'light', enabled: false });
    rerender({ theme: 'light', enabled: true });
    await waitFor(() => expect(bridge.calls('window:set-chrome')).toHaveLength(2));
  });
});
