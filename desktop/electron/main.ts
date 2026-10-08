/**
 * Electron main entry: window, `app://` protocol serving the Next.js static
 * export, IPC wiring, lifecycle.
 *
 * Renderer loading rules:
 * - dev: the Next dev server (http://localhost:3000), with DevTools available.
 * - packaged: `app://local/index.html` served from `out/` through a custom
 *   protocol, so absolute asset URLs (`/_next/...`) resolve inside the app
 *   bundle without a local HTTP server.
 */

import path from 'node:path';
import { BrowserWindow, app, net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { SessionRegistry } from './agent/registry';
import { SettingsStore } from './settings/store';
import { registerIpc } from './ipc/register';
import { resolveRuntime } from './agent/runtime';

const DEV_URL = process.env.ARAGON_DESKTOP_DEV_URL ?? 'http://localhost:3000';
const isDev = !app.isPackaged;

// Must run before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow: BrowserWindow | null = null;
let registry: SessionRegistry | null = null;

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(main);
}

async function main(): Promise<void> {
  const settings = new SettingsStore(app.getPath('userData'));
  await settings.load();

  const runtime = resolveRuntime();
  const launcherPath = (): string => {
    if (runtime.exists) return runtime.launcherPath;
    throw new Error(
      isDev
        ? 'CLI runtime not built. Run `npm run build -w packages/core -w packages/cli` first.'
        : 'Bundled agent runtime is missing.',
    );
  };

  registry = new SessionRegistry({
    userDataDir: app.getPath('userData'),
    settings,
    send: (channel, ...args) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
    },
    execPath: process.execPath,
    launcherPath,
  });

  registerIpc({
    getWindow: () => mainWindow,
    registry,
    settings,
    launcherPath,
  });

  registerAppProtocol();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const file = path.join(exportDir(), pathname);
    // Path traversal guard: the resolved file must stay inside the export dir.
    if (!path.normalize(file).startsWith(path.normalize(exportDir()))) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function exportDir(): string {
  return path.join(app.getAppPath(), 'out');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#F0EEE6',
    title: 'AragonAgent',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload requires the shared protocol module (channel names). A
      // SANDBOXED preload may only require 'electron' - any relative require
      // throws and the bridge never reaches the page (the "plain browser tab"
      // hint appears inside the app). contextIsolation stays on, so the page
      // still sees nothing but window.aragon.
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('app://');
    if (!allowed) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadURL('app://local/index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Terminal-verifiable bridge check: ARAGON_DESKTOP_BRIDGE_CHECK=1 prints
  // whether the preload actually exposed window.aragon, then exits. Used by
  // the dev/packaging smoke flows; inert in normal runs.
  if (process.env.ARAGON_DESKTOP_BRIDGE_CHECK === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      void mainWindow?.webContents
        .executeJavaScript('typeof window.aragon')
        .then((kind: unknown) => {
          console.log(`[bridge-check] window.aragon is ${String(kind)}`);
          app.exit(kind === 'object' ? 0 : 3);
        })
        .catch((error: unknown) => {
          console.error('[bridge-check] failed:', error);
          app.exit(4);
        });
    });
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;

app.on('before-quit', (event) => {
  if (quitting || !registry) return;
  quitting = true;
  event.preventDefault();
  registry
    .shutdown()
    .catch(() => undefined)
    .finally(() => {
      registry = null;
      app.quit();
    });
});
