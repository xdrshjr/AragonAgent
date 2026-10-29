/**
 * Windows: creation with restored geometry, platform title bar, and the session -> window
 * ownership table.
 *
 * Security posture is set here, once, for every window: context isolation, sandbox, no Node
 * integration, web security on, no webview. A session is owned by at most one window (R19):
 * opening it again focuses the owner instead of creating a second writer of the same
 * conversation.
 *
 * Geometry: the window is created hidden BEFORE the engine loads (the saved state lives in the
 * engine's home), and is shown only once it is both painted and positioned - `restoreFromState()`
 * supplies the position, with a short cap so a slow engine never keeps the window invisible.
 */

import { BrowserWindow, screen, nativeTheme } from 'electron';
import type { DesktopState, WindowState } from '../shared/desktop-state.js';
import type { BroadcastChannel, BroadcastContract } from '../shared/ipc-contract.js';
import { overlayFor, type ChromeTheme, type OverlayParams } from '../shared/window-chrome.js';
import {
  DEFAULT_SIZE, MIN_SIZE, TrailingDebounce, buildWindowState, clampZoom, planWindowBounds, type BoundsPlan, type Rect,
} from './window-bounds.js';

export interface WindowManagerOptions {
  preloadPath: string;
  /** `http://localhost:5273` in development, `app://renderer/index.html` when packaged. */
  startUrl: string;
  iconPath?: string;
  getState(): DesktopState;
  saveWindow(window: WindowState): void;
  /** `--e2e`: open at exactly this size and ignore (and never write) saved window state. */
  fixedSize?: { width: number; height: number };
  /** Wire renderer-crash recovery onto a new window (see renderer-recovery.ts). */
  attachRecovery?(window: BrowserWindow): void;
  log?(level: 'info' | 'warn', message: string, extra?: Record<string, unknown>): void;
}

/** After the first paint, how long to wait for saved geometry before showing at the default. */
export const STATE_WAIT_CAP_MS = 700;
/** Move / resize persist this long after the last event; close and quit flush immediately. */
export const PERSIST_DEBOUNCE_MS = 400;
const ZOOM_STEP = 0.1;

/** Per-window bookkeeping for the show latch, zoom, chrome colours and debounced persistence. */
interface Chrome {
  restored: boolean;
  painted: boolean;
  shown: boolean;
  zoom: number;
  /** The application theme the chrome is painted for; undefined until one is known (then the OS decides). */
  theme: ChromeTheme | undefined;
  /** What was last handed to Electron, kept because Electron has no getter for it (E2E reads this). */
  lastOverlay: OverlayParams | null;
  persist: TrailingDebounce;
  capTimer: ReturnType<typeof setTimeout> | null;
}

export class WindowManager {
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly owners = new Map<string, number>();
  private readonly chrome = new Map<number, Chrome>();
  private stateApplied = false;
  private quitting = false;

  constructor(private readonly options: WindowManagerOptions) {}

  private displays(): Rect[] {
    return screen.getAllDisplays().map((display) => ({ ...display.workArea }));
  }

  private plan(): BoundsPlan {
    if (this.options.fixedSize) return { bounds: { ...this.options.fixedSize }, maximize: false, zoom: 1 };
    return planWindowBounds(this.options.getState().windows[0], this.displays(), DEFAULT_SIZE);
  }

  /** The application is going away: renderer "failures" from here on are our own teardown. */
  markQuitting(): void {
    this.quitting = true;
    this.flushPersist();
  }

  isQuitting(): boolean {
    return this.quitting;
  }

  create(): BrowserWindow {
    const fixed = this.options.fixedSize;
    // Before the engine has told us the home, the state is a placeholder: open at the default size and
    // let restoreFromState() move the (still hidden) window. A window opened later (macOS `activate`)
    // already has the real state.
    const plan = fixed || this.stateApplied ? this.plan() : planWindowBounds(undefined, [], DEFAULT_SIZE);
    const isMac = process.platform === 'darwin';
    const overlay = overlayFor(plan.chromeTheme, nativeTheme.shouldUseDarkColors, plan.zoom);
    const window = new BrowserWindow({
      ...plan.bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      show: false, // shown once painted AND positioned, so the first thing seen is a settled frame
      backgroundColor: overlay.backgroundColor,
      title: 'AragonAgent',
      ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      ...(isMac ? { trafficLightPosition: { x: 14, y: 12 } } : {
        titleBarOverlay: { color: overlay.color, symbolColor: overlay.symbolColor, height: overlay.height },
      }),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    const chrome: Chrome = {
      restored: Boolean(fixed) || this.stateApplied,
      painted: false,
      shown: false,
      zoom: plan.zoom,
      theme: plan.chromeTheme,
      lastOverlay: isMac ? null : overlay,
      persist: new TrailingDebounce(() => this.persistNow(window), PERSIST_DEBOUNCE_MS),
      capTimer: null,
    };
    this.chrome.set(window.id, chrome);
    this.windows.set(window.id, window);
    if (plan.maximize) window.maximize();
    window.once('ready-to-show', () => {
      chrome.painted = true;
      if (!chrome.restored) {
        chrome.capTimer = setTimeout(() => { chrome.capTimer = null; this.maybeShow(window, true); }, STATE_WAIT_CAP_MS);
      }
      this.maybeShow(window, false);
    });
    window.on('closed', () => {
      chrome.persist.cancel();
      if (chrome.capTimer) clearTimeout(chrome.capTimer);
      this.chrome.delete(window.id);
      this.windows.delete(window.id);
      for (const [session, owner] of this.owners) if (owner === window.id) this.owners.delete(session);
    });
    const schedule = (): void => { if (chrome.restored && !fixed) chrome.persist.trigger(); };
    window.on('resize', schedule);
    window.on('move', schedule);
    window.on('close', () => { if (!fixed) chrome.persist.flush(); });
    const announce = (): void => this.send(window, 'window:state', {
      maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused(),
    });
    window.on('maximize', announce);
    window.on('unmaximize', announce);
    window.on('enter-full-screen', announce);
    window.on('leave-full-screen', announce);
    window.on('focus', announce);
    window.on('blur', announce);
    // The zoom factor is reset by a navigation, and a crash reload is one: re-apply on every load.
    window.webContents.on('did-finish-load', () => this.applyZoom(window));
    this.options.attachRecovery?.(window);
    void window.loadURL(this.options.startUrl);
    return window;
  }

  /**
   * The saved state is known: move / resize / zoom the (still hidden) window and let it show.
   * Idempotent. Must run right after `state.load()` with no `await` in between, so no `persist` can
   * fire against the placeholder state. A window that is already visible is left alone - moving it
   * now would be the "appears, then jumps" flicker this exists to avoid.
   */
  restoreFromState(): void {
    this.stateApplied = true;
    for (const window of this.windows.values()) {
      const chrome = this.chrome.get(window.id);
      if (!chrome || chrome.restored) continue;
      if (chrome.shown) {
        chrome.restored = true;
        this.options.log?.('info', 'window-restore-skipped-late');
        continue;
      }
      const plan = this.plan();
      chrome.zoom = plan.zoom;
      chrome.theme = plan.chromeTheme;
      this.applyBounds(window, plan);
      chrome.restored = true;
      this.maybeShow(window, false);
    }
  }

  private applyBounds(window: BrowserWindow, plan: BoundsPlan): void {
    if (window.isDestroyed()) return;
    const { x, y, width, height } = plan.bounds;
    if (x !== undefined && y !== undefined) window.setBounds({ x, y, width, height });
    else window.setSize(width, height);
    if (plan.maximize) window.maximize();
    this.applyZoom(window);
  }

  private maybeShow(window: BrowserWindow, capElapsed: boolean): void {
    const chrome = this.chrome.get(window.id);
    if (!chrome || chrome.shown || window.isDestroyed()) return;
    if (!chrome.painted || !(chrome.restored || capElapsed)) return;
    chrome.shown = true;
    if (chrome.capTimer) { clearTimeout(chrome.capTimer); chrome.capTimer = null; }
    window.show();
  }

  /**
   * Idempotent: set the page zoom and re-apply the chrome (the caption-button strip must stay as tall
   * as the page header, which scales with the zoom). Also the `did-finish-load` hook, so a crash
   * reload restores the chrome without waiting for the renderer to report its theme again.
   */
  applyZoom(window: BrowserWindow): void {
    const chrome = this.chrome.get(window.id);
    if (!chrome || window.isDestroyed()) return;
    const factor = clampZoom(chrome.zoom);
    try {
      if (Math.abs(window.webContents.getZoomFactor() - factor) > 0.001) window.webContents.setZoomFactor(factor);
      if (process.platform === 'darwin') {
        window.setWindowButtonPosition({ x: Math.round(14 * factor), y: Math.round(12 * factor) });
      }
    } catch (error) {
      this.options.log?.('warn', 'applyZoom failed', { error: String(error) });
    }
    this.applyChrome(window);
  }

  /**
   * The ONE place chrome colours are chosen and applied: the caption-button strip (Windows / Linux)
   * and the window background (all platforms), from the application theme - never `nativeTheme`
   * directly. Never force the native theme from here or anywhere (the `nativeTheme` source
   * setter): it changes the renderer's `prefers-color-scheme`, which the `auto` theme reads, so
   * forcing it makes `auto` follow us back.
   */
  private applyChrome(window: BrowserWindow): void {
    const chrome = this.chrome.get(window.id);
    if (!chrome || window.isDestroyed()) return;
    const overlay = overlayFor(chrome.theme, nativeTheme.shouldUseDarkColors, clampZoom(chrome.zoom));
    try {
      if (process.platform !== 'darwin') {
        window.setTitleBarOverlay({ color: overlay.color, symbolColor: overlay.symbolColor, height: overlay.height });
      }
      window.setBackgroundColor(overlay.backgroundColor);
      chrome.lastOverlay = process.platform === 'darwin' ? null : overlay;
    } catch (error) {
      this.options.log?.('warn', 'applyChrome failed', { error: String(error) });
    }
  }

  /**
   * The renderer reports the theme it resolved. False when nothing changed (no Electron call, no
   * write) or the window is gone. Persisted only once the saved state has been read - writing earlier
   * would overwrite it with the placeholder geometry.
   */
  setChromeTheme(window: BrowserWindow, theme: ChromeTheme): boolean {
    const chrome = this.chrome.get(window.id);
    if (!chrome || window.isDestroyed() || chrome.theme === theme) return false;
    chrome.theme = theme;
    this.applyChrome(window);
    if (chrome.restored && !this.options.fixedSize) chrome.persist.trigger();
    return true;
  }

  /** The parameters last handed to Electron for this window's chrome (null on macOS / unknown). */
  overlayOf(window: BrowserWindow): OverlayParams | null {
    return this.chrome.get(window.id)?.lastOverlay ?? null;
  }

  /** View > Zoom In / Out / Reset. `direction` 0 resets. */
  adjustZoom(window: BrowserWindow | null, direction: -1 | 0 | 1): void {
    const target = window ?? this.primary();
    const chrome = target ? this.chrome.get(target.id) : undefined;
    if (!target || !chrome) return;
    chrome.zoom = direction === 0 ? 1 : clampZoom(chrome.zoom + direction * ZOOM_STEP);
    this.applyZoom(target);
    if (chrome.restored && !this.options.fixedSize) chrome.persist.trigger();
  }

  /** Set an absolute factor (test hook and future settings UI); same persistence as the menu. */
  setZoomFactor(window: BrowserWindow, factor: number): void {
    const chrome = this.chrome.get(window.id);
    if (!chrome) return;
    chrome.zoom = clampZoom(factor);
    this.applyZoom(window);
    if (chrome.restored && !this.options.fixedSize) chrome.persist.trigger();
  }

  zoomOf(window: BrowserWindow): number {
    return this.chrome.get(window.id)?.zoom ?? 1;
  }

  private persistNow(window: BrowserWindow): void {
    const chrome = this.chrome.get(window.id);
    // Never write before the saved state has been read: the default geometry would overwrite it.
    if (!chrome?.restored || window.isDestroyed()) return;
    this.options.saveWindow(buildWindowState({
      bounds: window.getBounds(), normalBounds: window.getNormalBounds(),
      maximized: window.isMaximized(), zoom: chrome.zoom,
      ...(chrome.theme === undefined ? {} : { chromeTheme: chrome.theme }),
    }, this.options.getState().windows[0]));
  }

  /** Write any pending geometry now (before-quit). */
  flushPersist(): void {
    if (this.options.fixedSize) return;
    for (const chrome of this.chrome.values()) chrome.persist.flush();
  }

  all(): BrowserWindow[] {
    return [...this.windows.values()];
  }

  primary(): BrowserWindow | null {
    return this.all()[0] ?? null;
  }

  fromWebContentsId(id: number): BrowserWindow | null {
    return this.all().find((window) => window.webContents.id === id) ?? null;
  }

  /** Claim a session for a window; false when another window already owns it. */
  claim(sessionId: string, windowId: number): boolean {
    const owner = this.owners.get(sessionId);
    if (owner !== undefined && owner !== windowId && this.windows.has(owner)) return false;
    this.owners.set(sessionId, windowId);
    return true;
  }

  ownerOf(sessionId: string): BrowserWindow | null {
    const id = this.owners.get(sessionId);
    return id === undefined ? null : (this.windows.get(id) ?? null);
  }

  release(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  focus(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  send<K extends BroadcastChannel>(window: BrowserWindow, channel: K, payload: BroadcastContract[K]): void {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }

  broadcast<K extends BroadcastChannel>(channel: K, payload: BroadcastContract[K]): void {
    for (const window of this.windows.values()) this.send(window, channel, payload);
  }
}
