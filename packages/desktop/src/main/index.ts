/**
 * Electron main process: the composition root.
 *
 * ORDER MATTERS HERE and is why this file is one long function rather than many small ones:
 *   1. `registerSchemes()` runs at MODULE SCOPE - Electron rejects a custom scheme registered
 *      after `app.ready`;
 *   2. the single-instance lock is taken before anything else starts, so a second launch only
 *      forwards its arguments and exits;
 *   3. `ARAGON_HOME` is settled BEFORE the engine is imported (the engine reads it once, when
 *      it first loads), and the engine is loaded through `engine-loader` only;
 *   4. the window is created before the engine finishes anything slow, so the first thing the
 *      user sees is a painted frame, and an engine that cannot load becomes a readable error
 *      page instead of a white window.
 *
 * `--smoke` runs the same boot against a throwaway home, forks one real session host, waits
 * for `ready`, and exits 0/1. It exists to prove an INSTALLED build can load the engine from
 * `resources/engine` - the one thing a development run cannot show (AC-38).
 */

import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, powerMonitor, shell } from 'electron';
import { readAsset } from './asset-resolver.js';
import { ConfigService } from './config-service.js';
import { ConfigWatcher } from './config-watcher.js';
import { DesktopStateStore } from './desktop-state-store.js';
import { buildDiagnosticsZip } from './diagnostics.js';
import { createElectronLauncher } from './electron-launcher.js';
import { loadEngine, type Engine } from './engine-loader.js';
import { registerIpc, type Services } from './ipc-handlers.js';
import { createLogger } from './logging.js';
import { collectAttachmentGarbage } from './attachment-paths.js';
import { NativeBridge } from './native-bridge.js';
import { createProcessReaper } from './process-reaper.js';
import { APP_ORIGIN, installProtocols, registerSchemes } from './protocols.js';
import { queryInstalledSkills } from './skills-catalog.js';
import { SessionChannelService } from './session-channel.js';
import { SessionIndex } from './session-index.js';
import { SessionSupervisor } from './session-supervisor.js';
import { resolveFlavor } from './build-flavor.js';
import {
  E2E_WINDOW, E2eDialogQueue, NotificationQueue, installE2eHooks, parseE2eOptions, type E2eHostHooks,
} from './e2e-support.js';
import { nativeText, resolveNativeLocale, type NativeKey } from './native-strings.js';
import { collectConfigSecrets, exportSession, writeFileAtomic } from './session-export.js';
import { RecoveryPolicy, attachRendererRecovery, type RecoveryChoice } from './renderer-recovery.js';
import { fetchManifestText } from './update-fetch.js';
import { UpdateService, type UpdateConfig, type UpdateStore } from './update-service.js';
import { WindowManager } from './window-manager.js';
import { createWorkerParser } from './worker-parser.js';

registerSchemes();

const SMOKE = process.argv.includes('--smoke');
const FLAVOR = resolveFlavor(app.isPackaged);
/** Test switches: all-off in a release build whatever the command line says (see build-flavor.ts). */
const E2E = parseE2eOptions(process.argv, FLAVOR);
/** `--e2e` pins the window and writes nothing, unless `--e2e-restore-window` asks for the real path. */
const PIN_WINDOW = E2E.enabled && !E2E.restoreWindow;
const e2eNotifications = new NotificationQueue();
const e2eDialogs = new E2eDialogQueue();
let recoveryServices: Services | null = null;
const DEV_SERVER = process.env.ARAGON_DESKTOP_DEV_URL ?? null;

function paths() {
  const appRoot = app.getAppPath();
  const packaged = app.isPackaged;
  const engineDir = packaged ? join(process.resourcesPath, 'engine') : null;
  return {
    appRoot,
    packaged,
    preload: join(appRoot, 'dist', 'preload', 'index.cjs'),
    rendererRoot: join(appRoot, 'dist', 'renderer'),
    hostEntry: engineDir ? join(engineDir, 'host', 'entry.js') : join(appRoot, 'dist', 'host', 'entry.js'),
    hostWorker: engineDir ? join(engineDir, 'host', 'session-worker.js') : join(appRoot, 'dist', 'host', 'session-worker.js'),
    hostCwd: engineDir ?? appRoot,
    icon: join(appRoot, 'build', 'icon.png'),
  };
}

async function runSmoke(): Promise<void> {
  const where = paths();
  const home = process.env.ARAGON_HOME ?? mkdtempSync(join(os.tmpdir(), 'aragon-smoke-'));
  process.env.ARAGON_HOME = home;
  const report: Record<string, unknown> = { packaged: where.packaged, home };
  let exit = 1;
  try {
    const engine = await loadEngine({ resourcesPath: process.resourcesPath, appRoot: where.appRoot, isPackaged: where.packaged });
    report.engineRoot = engine.root;
    report.versions = engine.versions;
    report.facades = ['settings', 'sessions', 'prompts'].filter((name) => name in engine);
    const supervisor = new SessionSupervisor({
      launcher: createElectronLauncher({ entry: where.hostEntry, cwd: where.hostCwd, homeRoot: home, env: process.env }),
      reaper: createProcessReaper(), homeRoot: home, maxLiveHosts: () => 2, parkAfterIdleMs: () => 0,
      onStatus: (id, status, detail) => { report.lastStatus = { id, status, detail }; },
    });
    const id = engine.sessions.reserveNewSession();
    if (!id) throw new Error('could not reserve a session id');
    const cwd = join(home, 'smoke-cwd');
    mkdirSync(cwd, { recursive: true });
    const opened = supervisor.open(id, cwd, false);
    if (!opened.ok) throw new Error(opened.message);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const status = supervisor.statusOf(id);
      if (status === 'ready') { report.hostReady = true; exit = 0; break; }
      if (status === 'failed' || status === 'crashed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await supervisor.shutdown();
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.ok = exit === 0;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  app.exit(exit);
}

async function main(): Promise<void> {
  if (SMOKE) {
    await app.whenReady();
    await runSmoke();
    return;
  }
  // Before the lock: the lock is keyed to userData, so a test run must not share it with an open instance.
  if (E2E.userDataDir) app.setPath('userData', E2E.userDataDir);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const where = paths();
  const state = new DesktopStateStore(null);
  const windows = new WindowManager({
    preloadPath: where.preload,
    startUrl: DEV_SERVER ?? `${APP_ORIGIN}/index.html`,
    iconPath: where.icon,
    getState: () => services.state.get(),
    saveWindow: (window) => (PIN_WINDOW ? undefined : services.state.patch({ windows: [window] })),
    ...(PIN_WINDOW ? { fixedSize: E2E_WINDOW } : {}),
    log: (level, message, extra) => services.log.log(level, 'window', message, extra),
    attachRecovery: (window) => attachWindowRecovery(window),
  });
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const services: Services = {
    ready,
    engine: null, engineError: null, config: null, state, index: null, supervisor: null,
    channels: new SessionChannelService(), windows, native: null,
    log: { log: () => undefined }, devServer: DEV_SERVER, isPackaged: where.packaged,
    versions: { desktop: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node },
    sessionCwds: new Map(),
    listSkills: async () => ({ ok: false, reason: 'failed', message: 'The engine is not available.' }),
    checkForUpdate: async () => ({ state: 'unsupported', message: 'The engine is not available.' }),
    installUpdate: () => false,
    skipUpdateVersion: () => ({ state: 'unsupported', message: 'The engine is not available.' }),
    updateDownloadUrl: () => null,
    updatePrefsChanged: () => undefined,
    exportDiagnostics: async () => null,
    exportSession: async () => ({ ok: false, code: 'engine_unavailable', message: 'The engine is not available.' }),
    confirmQuit: () => undefined, cancelQuit: () => undefined,
    acknowledgeConfigWrite: () => undefined,
    quitPlan: () => ({ runningSessions: [], liveServices: 0 }),
  };

  app.on('second-instance', () => {
    const window = windows.primary();
    if (window) windows.focus(window);
  });
  await app.whenReady();
  Menu.setApplicationMenu(buildMenu(windows));
  installProtocols({
    rendererRoot: where.rendererRoot,
    devServer: DEV_SERVER,
    resolveAsset: async (sessionId, relPath) => {
      // `URL.host` is lower-cased by the parser; session ids are matched the same way.
      const wanted = sessionId.toLowerCase();
      const key = [...services.sessionCwds.keys()].find((id) => id.toLowerCase() === wanted);
      const cwd = key === undefined ? undefined : services.sessionCwds.get(key);
      return cwd ? readAsset(cwd, relPath) : null;
    },
  });
  registerIpc(ipcMain, services);
  recoveryServices = services;
  installE2eHooks(globalThis, E2E, e2eNotifications, e2eHostHooks(services));
  windows.create();
  nativeTheme.on('updated', () => windows.broadcast('theme:system-changed', { dark: nativeTheme.shouldUseDarkColors }));
  watchPower(services);

  // The engine loads AFTER the window exists; every handler answers `engine_unavailable`
  // until it does, and permanently if it cannot.
  try {
    const engine = await loadEngine({ resourcesPath: process.resourcesPath, appRoot: where.appRoot, isPackaged: where.packaged });
    attachEngine(services, engine, where);
  } catch (error) {
    services.engineError = error instanceof Error ? error.message : String(error);
  } finally {
    // Whether or not the engine loaded, the window must stop waiting for saved geometry.
    services.windows.restoreFromState();
    markReady();
  }
  registerQuitHandling(services);
}

function attachEngine(services: Services, engine: Engine, where: ReturnType<typeof paths>): void {
  const homeRoot = engine.paths.getHomeRoot();
  services.engine = engine;
  services.state = new DesktopStateStore(homeRoot);
  services.state.load();
  // Synchronously adjacent to load(): nothing may persist the placeholder geometry in between.
  services.windows.restoreFromState();
  const config = new ConfigService(engine, { writeFault: E2E.fault });
  services.config = config;
  config.registerSecrets();
  services.log = createLogger({
    logsDir: join(homeRoot, 'logs'),
    redact: (text) => engine.settings.redactText(text, engine.settings.getSecrets()),
  });
  services.log.log('info', 'app', 'engine loaded', { root: engine.root, versions: engine.versions });
  if (services.state.corruptNotice) services.log.log('warn', 'state', services.state.corruptNotice);

  const launcher = createElectronLauncher({
    entry: where.hostEntry, cwd: where.hostCwd, homeRoot, env: process.env,
    onStdout: (line, pid) => services.log.log('debug', 'host', line.trimEnd(), { pid }),
  });
  services.listSkills = (cwd) => queryInstalledSkills(launcher, cwd);
  const supervisor = new SessionSupervisor({
    launcher,
    reaper: createProcessReaper(), homeRoot,
    maxLiveHosts: () => services.state.get().maxLiveHosts,
    parkAfterIdleMs: () => services.state.get().parkAfterIdleMinutes * 60_000,
    onStatus: (id, status, detail) => {
      services.windows.broadcast('session:status', { id, status, ...(detail ? { detail } : {}) });
      services.windows.broadcast('sessions:changed', { reason: 'status' });
      if (status === 'waiting-approval') {
        services.native?.notify('Approval needed', 'A session is waiting for your answer.', id);
      }
    },
  });
  services.supervisor = supervisor;
  const index = new SessionIndex({
    homeRoot,
    scan: () => engine.sessions.scanSessionFiles(),
    parser: createWorkerParser(where.hostWorker),
    isLiveElsewhere: (id) => engine.sessions.isLiveOwnedElsewhere(id, supervisor.ownPids()),
    hostStatusOf: (id) => supervisor.statusOf(id),
    onChanged: (reason) => services.windows.broadcast('sessions:changed', { reason }),
    caseInsensitiveVolume: process.platform === 'win32' || process.platform === 'darwin',
  });
  services.index = index;
  services.native = new NativeBridge({
    sessionCwd: (id) => services.sessionCwds.get(id) ?? null,
    homeRoot,
    ...(E2E.enabled ? { queue: e2eNotifications } : {}),
    onNotificationClick: (id) => {
      const window = (id ? services.windows.ownerOf(id) : null) ?? services.windows.primary();
      if (window) {
        services.windows.focus(window);
        if (id) services.windows.send(window, 'session:focus', { id, approval: true });
      }
    },
  });

  const watcher = new ConfigWatcher({
    homeRoot, configPath: config.path,
    reader: { read: () => config.readRevision() },
    onChange: ({ revision, ok }) => {
      config.registerSecrets();
      services.log.log('info', 'config', 'config.json changed on disk', { ok });
      services.windows.broadcast('config:changed', { revision, ok });
      supervisor.broadcast({ v: 1, kind: 'config-changed', revision });
    },
  });
  watcher.start();
  services.acknowledgeConfigWrite = (revision) => watcher.acknowledge(revision);

  services.quitPlan = () => ({ runningSessions: supervisor.runningIds(), liveServices: supervisor.liveServiceCount() });
  services.exportDiagnostics = async (window) => {
    const result = await (window
      ? dialog.showSaveDialog(window, { defaultPath: 'aragon-diagnostics.zip', filters: [{ name: 'Zip', extensions: ['zip'] }] })
      : dialog.showSaveDialog({ defaultPath: 'aragon-diagnostics.zip' }));
    if (result.canceled || !result.filePath) return null;
    const doctor = await engine.settings.runDoctorChecks({}).catch((error: unknown) => ({ error: String(error) }));
    const zip = buildDiagnosticsZip({
      logsDir: join(homeRoot, 'logs'), now: Date.now(),
      redact: (text) => engine.settings.redactText(text, engine.settings.getSecrets()),
      doctor,
      summary: { versions: engine.versions, platform: process.platform, arch: process.arch, electron: process.versions.electron, packaged: where.packaged },
      desktopStatePath: services.state.path,
    });
    writeFileSync(result.filePath, zip);
    return result.filePath;
  };

  services.exportSession = (window, request) => exportSession({
    chooseFile: async (defaultPath) => {
      const locale = nativeLocaleOf(services);
      const options = {
        title: nativeText(locale, 'export.title'), defaultPath,
        filters: [{ name: nativeText(locale, 'export.filter'), extensions: ['md'] }],
      };
      const result = window && !window.isDestroyed() ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    redact: (text) => engine.settings.redactText(text, engine.settings.getSecrets()),
    // The engine's registry only holds profile keys; the legacy `apiKeys` map is read from the config itself.
    secrets: () => [...engine.settings.getSecrets(), ...collectConfigSecrets(readJsonFile(config.path))],
    writeAtomic: writeFileAtomic,
    defaultDirectory: (cwd) => (cwd && isExistingDirectory(cwd) ? cwd : app.getPath('documents')),
    now: () => new Date(),
  }, request);

  attachUpdates(services, where);

  void index.refresh();
  setInterval(() => void index.refresh(), 5000).unref();
  // Staged attachments of sessions that are gone and untouched for 30 days. Off the startup path.
  setTimeout(() => {
    try {
      const live = new Set(engine.sessions.scanSessionFiles().map((file) => file.id));
      collectAttachmentGarbage({ homeRoot, liveSessions: live });
    } catch { /* housekeeping only */ }
  }, 60_000).unref();
  app.on('will-quit', () => { watcher.stop(); index.dispose(); });
}

/** The build-time update settings: `extraMetadata.updates` in electron-builder.yml, merged into package.json. */
function readBuildUpdates(appRoot: string): { feedUrl: string | null; allowedHosts: string[] } {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { updates?: { feedUrl?: unknown; allowedHosts?: unknown } };
    const feedUrl = typeof pkg.updates?.feedUrl === 'string' && pkg.updates.feedUrl ? pkg.updates.feedUrl : null;
    const allowedHosts = Array.isArray(pkg.updates?.allowedHosts)
      ? pkg.updates.allowedHosts.filter((host): host is string => typeof host === 'string' && host.length > 0) : [];
    return { feedUrl, allowedHosts };
  } catch {
    return { feedUrl: null, allowedHosts: [] };
  }
}

/**
 * The update NOTIFICATION service (see update-service.ts). With no build-time feed it stays
 * `unsupported` - no placeholder address is ever baked in - unless a non-release build was started
 * with `--e2e-feed`, which is how the harness points it at a local fake.
 */
function attachUpdates(services: Services, where: ReturnType<typeof paths>): void {
  const build = readBuildUpdates(where.appRoot);
  const config: UpdateConfig = {
    feedUrl: E2E.feedUrl ?? build.feedUrl,
    allowedHosts: build.allowedHosts,
    allowLoopbackHttp: E2E.enabled,
  };
  const store: UpdateStore = {
    read: () => {
      const { enabled, feedUrl, skippedVersion, lastCheckedAt } = services.state.get().update;
      return { enabled, feedUrl, skippedVersion, lastCheckedAt };
    },
    write: (patch) => { services.state.patch({ update: { ...services.state.get().update, ...patch } }); },
  };
  const update = new UpdateService({
    currentVersion: app.getVersion(), config, store, fetchText: fetchManifestText,
    onStatus: (status) => services.windows.broadcast('update:status', status),
  });
  services.checkForUpdate = () => update.check({ manual: true });
  services.installUpdate = () => update.install();
  services.skipUpdateVersion = (version) => update.skipVersion(version);
  services.updateDownloadUrl = () => update.downloadUrl();
  services.updatePrefsChanged = () => { update.refreshSupport(); };
  update.start();
  app.on('will-quit', () => update.stop());
}

/**
 * Quit sequence. If anything is running (or a background service is alive) the first
 * `before-quit` is cancelled and the window is asked; its answer (`app:quit-confirmed`) lets
 * the second one through. Hosts are then asked to flush and exit, and anything still standing
 * after the grace period is killed as a TREE so no shell or service outlives the app.
 */
function registerQuitHandling(services: Services): void {
  let confirmed = false;
  let shuttingDown = false;
  services.confirmQuit = () => { confirmed = true; app.quit(); };
  services.cancelQuit = () => { confirmed = false; };
  app.on('before-quit', (event) => {
    services.windows.flushPersist();
    if (shuttingDown) return;
    const plan = services.quitPlan();
    const needsAsk = plan.runningSessions.length > 0 || plan.liveServices > 0;
    if (needsAsk && !confirmed && services.windows.primary()) {
      event.preventDefault();
      services.windows.broadcast('app:quit-requested', plan);
      return;
    }
    // From here the renderer is torn down by us; its "killed" reports are not crashes.
    services.windows.markQuitting();
    if (!services.supervisor) return;
    event.preventDefault();
    shuttingDown = true;
    void services.supervisor.shutdown().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) services.windows.create();
  });
}

function buildMenu(windows: WindowManager): Menu {
  const isMac = process.platform === 'darwin';
  // Explicit items instead of the built-in zoom roles: the roles neither persist the factor nor resize
  // the Windows caption-button strip, which would then stop lining up with the page header.
  const zoom = (direction: -1 | 0 | 1) => (): void => windows.adjustZoom(BrowserWindow.getFocusedWindow(), direction);
  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: zoom(0) },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: zoom(1) },
      { label: 'Zoom In (numpad)', accelerator: 'CmdOrCtrl+numadd', visible: false, click: zoom(1) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: zoom(-1) },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' as const },
    { role: 'editMenu' as const },
    viewMenu,
    { role: 'windowMenu' as const },
  ]);
}

/** Crash / load-failure / hang recovery for one window (the policy lives in renderer-recovery.ts). */
function attachWindowRecovery(window: BrowserWindow): void {
  const services = recoveryServices;
  if (!services) return;
  attachRendererRecovery(window.webContents, {
    policy: new RecoveryPolicy(),
    isQuitting: () => services.windows.isQuitting(),
    devServer: DEV_SERVER !== null,
    detail: () => services.engineError,
    ask: (kind, detail) => askRecovery(services, window, kind, detail),
    restart: () => {
      const startUrl = DEV_SERVER ?? `${APP_ORIGIN}/index.html`;
      const current = window.webContents.getURL();
      if (current.startsWith(DEV_SERVER ?? APP_ORIGIN)) window.webContents.reload();
      else void window.loadURL(startUrl);
    },
    openLogs: () => { void shell.openPath(logDirectory(services)); },
    quit: () => app.quit(),
    log: (level, message, extra) => services.log.log(level, 'window', message, extra),
  });
}

function readJsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isExistingDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function nativeLocaleOf(services: Services) {
  return resolveNativeLocale(services.state.get().language, app.getLocale());
}

function logDirectory(services: Services): string {
  return services.engine ? join(services.engine.paths.getHomeRoot(), 'logs') : app.getPath('logs');
}

async function askRecovery(
  services: Services, window: BrowserWindow, kind: 'crash' | 'hang', detail: string | null,
): Promise<RecoveryChoice> {
  const locale = nativeLocaleOf(services);
  const text = (key: NativeKey): string => nativeText(locale, key);
  const buttons: Array<{ key: NativeKey; choice: RecoveryChoice }> = kind === 'crash'
    ? [{ key: 'crash.reload', choice: 'reload' }, { key: 'crash.openLogs', choice: 'logs' }, { key: 'crash.quit', choice: 'quit' }]
    : [{ key: 'hang.wait', choice: 'wait' }, { key: 'hang.reload', choice: 'reload' }];
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: text(`${kind}.title` as NativeKey),
    message: text(`${kind}.message` as NativeKey),
    detail: [text(`${kind}.detail` as NativeKey), detail].filter(Boolean).join('\n\n'),
    buttons: buttons.map((button) => text(button.key)),
    defaultId: 0,
    cancelId: kind === 'hang' ? 0 : buttons.length - 1,
    noLink: true,
  };
  const index = E2E.enabled
    ? await e2eDialogs.ask(kind, buttons.map((button) => button.choice))
    : (await (window.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options))).response;
  return buttons[index]?.choice ?? buttons[buttons.length - 1]!.choice;
}

/**
 * Sleep / wake. `resume` does not fire on every desktop, so the supervisor also guards against a
 * frozen timer by itself (session-supervisor.ts `beat`); this only makes the common case immediate.
 */
function watchPower(services: Services): void {
  try {
    powerMonitor.on('resume', () => {
      services.supervisor?.noteResume();
      services.log.log('info', 'power', 'system resumed');
    });
  } catch (error) {
    services.log.log('warn', 'power', 'powerMonitor unavailable', { error: String(error) });
  }
}

/** The hooks that need Electron objects; installed only in a non-release `--e2e` run. */
function e2eHostHooks(services: Services): E2eHostHooks {
  const at = (index: number): BrowserWindow => {
    const window = services.windows.all()[index];
    if (!window) throw new Error(`no window ${index}`);
    return window;
  };
  return {
    crashRenderer: (index = 0) => at(index).webContents.forcefullyCrashRenderer(),
    failLoad: (index = 0) => { void at(index).loadURL('http://127.0.0.1:1').catch(() => undefined); },
    pendingMessageBoxes: () => e2eDialogs.pending(),
    answerMessageBox: (index) => e2eDialogs.answer(index),
    getWindowGeometry: (index = 0) => {
      const window = at(index);
      // Electron has no getter for the caption strip and the screenshot excludes it: read what we last sent.
      const overlay = services.windows.overlayOf(window);
      return {
        bounds: window.getBounds(), normalBounds: window.getNormalBounds(), maximized: window.isMaximized(),
        zoom: window.webContents.getZoomFactor(), visible: window.isVisible(),
        overlayHeight: overlay?.height ?? null,
        overlayColor: overlay?.color ?? null,
        overlaySymbol: overlay?.symbolColor ?? null,
        backgroundColor: overlay?.backgroundColor ?? null,
      };
    },
    setZoom: (factor, index = 0) => services.windows.setZoomFactor(at(index), factor),
  };
}

void main().catch((error: unknown) => {
  process.stderr.write(`aragon desktop failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
