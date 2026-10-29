/**
 * `WindowManager` chrome colours: one thin test over a fake `BrowserWindow`. The colour decisions
 * themselves are pure (`overlayFor`, tested in shared/); this proves the manager applies them at
 * every call site, does not repeat work, and does not persist before the saved state is read.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDesktopState } from '../../shared/desktop-state.js';
import { CHROME_COLORS } from '../../shared/window-chrome.js';

const electron = vi.hoisted(() => {
  const nativeTheme = { shouldUseDarkColors: false };
  class FakeWindow {
    static next = 1;
    id = FakeWindow.next++;
    destroyed = false;
    handlers = new Map<string, Array<() => void>>();
    webContents = {
      id: 100 + this.id, zoom: 1, handlers: new Map<string, Array<() => void>>(),
      on(event: string, handler: () => void) { (this.handlers.get(event) ?? this.handlers.set(event, []).get(event)!).push(handler); },
      getZoomFactor() { return this.zoom; },
      setZoomFactor(factor: number) { this.zoom = factor; },
      send: vi.fn(),
    };
    setTitleBarOverlay = vi.fn();
    setBackgroundColor = vi.fn();
    setWindowButtonPosition = vi.fn();
    setBounds = vi.fn();
    setSize = vi.fn();
    maximize = vi.fn();
    show = vi.fn();
    loadURL = vi.fn(async () => undefined);
    isDestroyed() { return this.destroyed; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    isFocused() { return true; }
    getBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; }
    getNormalBounds() { return { x: 0, y: 0, width: 1000, height: 700 }; }
    constructor(public options: Record<string, unknown>) {}
    on(event: string, handler: () => void) { (this.handlers.get(event) ?? this.handlers.set(event, []).get(event)!).push(handler); }
    once(event: string, handler: () => void) { this.on(event, handler); }
  }
  return { nativeTheme, FakeWindow };
});

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeWindow,
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
  nativeTheme: electron.nativeTheme,
}));

const { WindowManager, PERSIST_DEBOUNCE_MS } = await import('../window-manager.js');

const realPlatform = process.platform;

function build(opts: { state?: ReturnType<typeof defaultDesktopState>; saved?: unknown[] } = {}) {
  const saved: unknown[] = opts.saved ?? [];
  const manager = new WindowManager({
    preloadPath: 'preload.js', startUrl: 'app://x', getState: () => opts.state ?? defaultDesktopState(),
    saveWindow: (window) => { saved.push(window); },
  });
  const window = manager.create() as unknown as InstanceType<typeof electron.FakeWindow>;
  return { manager, window, saved };
}

beforeEach(() => {
  vi.useFakeTimers();
  electron.nativeTheme.shouldUseDarkColors = false;
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

describe('WindowManager chrome', () => {
  it('opens with OS colours when no application theme is known yet', () => {
    const { window, manager } = build();
    expect(window.options.backgroundColor).toBe(CHROME_COLORS.light.page);
    expect(manager.overlayOf(window as never)?.color).toBe(CHROME_COLORS.light.bar);
  });

  it('setChromeTheme uses the application theme even when the OS disagrees (OS light + app dark)', () => {
    const { manager, window } = build();
    expect(manager.setChromeTheme(window as never, 'dark')).toBe(true);
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ color: CHROME_COLORS.dark.bar, symbolColor: CHROME_COLORS.dark.symbol }),
    );
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(CHROME_COLORS.dark.page);
    expect(manager.overlayOf(window as never)).toMatchObject({ color: '#171717', backgroundColor: '#121212', height: 39 });
  });

  it('the same theme again is a no-op: false, no Electron call', () => {
    const { manager, window } = build();
    manager.setChromeTheme(window as never, 'warm');
    window.setTitleBarOverlay.mockClear();
    window.setBackgroundColor.mockClear();
    expect(manager.setChromeTheme(window as never, 'warm')).toBe(false);
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('a zoom change keeps the application theme instead of snapping back to the OS colours', () => {
    const { manager, window } = build();
    manager.setChromeTheme(window as never, 'dark');
    manager.setZoomFactor(window as never, 1.6);
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ color: CHROME_COLORS.dark.bar, height: Math.round(40 * 1.6) - 1 }),
    );
    expect(manager.overlayOf(window as never)?.height).toBe(63);
  });

  it('did-finish-load re-applies the chrome (a crash reload does not wait for the renderer)', () => {
    const { manager, window } = build();
    manager.setChromeTheme(window as never, 'warm');
    window.setTitleBarOverlay.mockClear();
    for (const handler of window.webContents.handlers.get('did-finish-load') ?? []) handler();
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith(expect.objectContaining({ color: CHROME_COLORS.warm.bar }));
  });

  it('does not persist before the saved state has been read, and does afterwards', () => {
    const { manager, window, saved } = build();
    manager.setChromeTheme(window as never, 'dark');
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2);
    expect(saved).toHaveLength(0); // restored is false: writing now would overwrite the real file with defaults
    manager.restoreFromState();
    manager.setChromeTheme(window as never, 'light');
    vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ chromeTheme: 'light' });
  });

  it('restoreFromState applies the stored theme to a still-hidden window', () => {
    const state = defaultDesktopState();
    state.windows = [{
      id: 'w1', bounds: { x: 10, y: 10, width: 1000, height: 700 }, maximized: false, sidebarWidth: 260,
      inspectorWidth: 400, inspectorOpen: false, inspectorTab: 'changes', openSessions: [], activeSession: null, chromeTheme: 'warm',
    }];
    const { manager, window } = build({ state });
    manager.restoreFromState();
    expect(manager.overlayOf(window as never)?.color).toBe(CHROME_COLORS.warm.bar);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(CHROME_COLORS.warm.page);
  });

  it('a destroyed window is ignored without throwing', () => {
    const { manager, window } = build();
    window.destroyed = true;
    expect(manager.setChromeTheme(window as never, 'dark')).toBe(false);
    expect(() => manager.applyZoom(window as never)).not.toThrow();
  });

  it('on macOS only the background changes (no caption strip exists)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { manager, window } = build();
    manager.setChromeTheme(window as never, 'dark');
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(CHROME_COLORS.dark.page);
    expect(manager.overlayOf(window as never)).toBeNull();
  });
});

describe('the native theme is never forced (R2)', () => {
  it('window-manager.ts does not assign the nativeTheme source', () => {
    const file = fileURLToPath(new URL('../window-manager.ts', import.meta.url));
    const source = readFileSync(file, 'utf8');
    expect(source.length).toBeGreaterThan(1000); // guard against scanning nothing
    expect(source).not.toMatch(/themeSource/);
  });
});
