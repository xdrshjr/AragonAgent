/**
 * Start the real desktop app against a scripted local model and a private home directory.
 *
 * Nothing in the app is stubbed: the window is a real Electron window, the session host is a real
 * `utilityProcess` running the real engine, and the only fake is the HTTP endpoint the engine is
 * pointed at (through the ordinary `baseUrl` setting).
 *
 * Two ways in, same tests: `electron .` from the source build (development), or a packaged E2E
 * build named by `ARAGON_E2E_APP`. That variable is read HERE, by the launcher; the app itself
 * reads no environment variable for test behavior - its switches are command-line only and exist
 * only in non-release builds (see `src/main/e2e-support.ts`).
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { startMockLlm, type MockLlm, type MockTurn } from '../mock-llm/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..', '..', '..');

/** Console errors that are known and harmless; each one carries the reason. Nothing else is tolerated. */
export const CONSOLE_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /Electron Security Warning/, reason: 'Electron prints this in unpackaged runs only; the CSP is set and checked elsewhere' },
];

export interface LaunchOptions {
  /** Pre-write a usable model config pointing at the mock (default), or start unconfigured. */
  config?: 'configured' | 'none';
  /** Extra keys merged into `config.json`. */
  configExtra?: Record<string, unknown>;
  /** Merged into `desktop-state.json` (updates are switched OFF unless a test says otherwise). */
  state?: Record<string, unknown>;
  /** The model's script. */
  turns?: MockTurn[];
  /** Extra command-line switches (`--e2e-fault=...`, `--e2e-feed=...`). `--e2e` is always passed. */
  args?: string[];
  /** Seed files before the app starts (sessions, a broken desktop-state.json...). */
  seed?(context: { home: string; workDir: string }): void;
  /** Console messages this test expects (each with the reason), on top of the global allow-list. */
  allowConsole?: ReadonlyArray<{ pattern: RegExp; reason: string }>;
  /** Keep the temp home after `close()` (for post-mortems). */
  keepHome?: boolean;
}

export interface WindowGeometry {
  bounds: { x: number; y: number; width: number; height: number };
  normalBounds: { x: number; y: number; width: number; height: number };
  maximized: boolean;
  zoom: number;
  visible: boolean;
  overlayHeight: number | null;
  overlayColor: string | null;
  overlaySymbol: string | null;
  backgroundColor: string | null;
}

type MainHooks = {
  crashRenderer(i?: number): void; getWindowGeometry(i?: number): WindowGeometry; setZoom(f: number, i?: number): void;
  pendingMessageBoxes(): Array<{ kind: string; choices: string[] }>; answerMessageBox(i: number): boolean;
};
/** Read INSIDE each `app.evaluate` callback: those run in the main process, where module scope does not exist. */
type WithHooks = { __aragonE2e: MainHooks };

export interface Launched {
  app: ElectronApplication;
  window: Page;
  home: string;
  workDir: string;
  mock: MockLlm;
  /** Lines from the renderer's console / uncaught errors. */
  logs: string[];
  /** The renderer's problems that are NOT on the allow-list; a test fails if this is not empty. */
  problems(): string[];
  /** The conversation log region. */
  transcript(): Locator;
  composer(): Locator;
  /** Open the pre-seeded workspace through the "recent" list (no native dialog). */
  openWorkspace(): Promise<void>;
  /** Type into the composer and press Enter. */
  send(text: string): Promise<void>;
  /** Run code in the main process. */
  evaluate<T, A = undefined>(fn: (electronModule: typeof import('electron'), arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  /** Read and clear the app's in-memory notification queue (main-process global; not reachable from the page). */
  drainNotifications(): Promise<Array<{ title: string; body: string; sessionId?: string }>>;
  /** Click the n-th queued notification as the OS would. */
  activateNotification(index?: number): Promise<boolean>;
  /** `webContents.forcefullyCrashRenderer()` on a window (main process). */
  crashRenderer(windowIndex?: number): Promise<void>;
  /** The window's live geometry as the main process sees it. */
  geometry(windowIndex?: number): Promise<WindowGeometry>;
  setZoom(factor: number, windowIndex?: number): Promise<void>;
  /** Native message boxes the app is waiting on (recovery dialogs). */
  pendingBoxes(): Promise<Array<{ kind: string; choices: string[] }>>;
  answerBox(index: number): Promise<boolean>;
  /** Path of the persisted `desktop-state.json` in this run's home. */
  statePath(): string;
  close(): Promise<void>;
}

/** The environment the app is started with: ours, minus what would make Electron behave as Node. */
export function launchEnvironment(home: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE; // a shell exporting this makes Electron start as plain Node and never open a window
  env.ARAGON_HOME = home;
  return env;
}

function modelConfig(mockUrl: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: 'openai', model: 'mock-1', baseUrl: `${mockUrl}/v1`, apiKeys: { openai: 'test-key' },
    // Anything that would make its OWN model call would consume scripted turns out of order.
    taskSummary: { enabled: false, fallback: true },
    compaction: { enabled: false },
    team: { enabled: false },
    skills: { enabled: false },
    ...extra,
  };
}

/**
 * Turn Playwright's bare "Target page, context or browser has been closed" into a sentence that names
 * the likely cause. Only the message changes; the failure still propagates.
 */
export function explainLaunchFailure(error: unknown, context: { sourceNewerThanDist: boolean }): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = original.message;
  const hints: string[] = [];
  if (context.sourceNewerThanDist) {
    hints.push('dist/ is older than src/: run `npm run build -w packages/desktop` first.');
  }
  if (/Target page, context or browser has been closed|process exited|exited with code/i.test(message)) {
    hints.push('The app quit right after starting. Another AragonAgent instance probably holds the single-instance lock for this userData; the harness passes --e2e-user-data=<home>/electron-user-data to avoid that, so check that flag took effect.');
  }
  if (/EADDRINUSE|address already in use/i.test(message)) {
    hints.push('A port is already in use: look for an orphaned electron / mock-LLM process.');
  }
  if (hints.length === 0) return original;
  const explained = new Error([message, '', 'Likely cause:', ...hints.map((hint) => `- ${hint}`)].join('\n'));
  explained.cause = original;
  return explained;
}

/** True when any file under `src/` is newer than the compiled main entry (a stale `dist/` runs old code). */
function sourceIsNewerThanDist(): boolean {
  try {
    const built = statSync(join(desktopRoot, 'dist', 'main', 'index.js')).mtimeMs;
    return statSync(join(desktopRoot, 'src', 'main', 'index.ts')).mtimeMs > built;
  } catch {
    return false;
  }
}

export async function launchApp(options: LaunchOptions = {}): Promise<Launched> {
  const home = mkdtempSync(join(tmpdir(), 'aragon-e2e-home-'));
  const workDir = mkdtempSync(join(tmpdir(), 'aragon-e2e-work-'));
  const mock = await startMockLlm();
  mock.script(options.turns ?? []);

  if ((options.config ?? 'configured') === 'configured') {
    writeFileSync(join(home, 'config.json'), `${JSON.stringify(modelConfig(mock.url, options.configExtra ?? {}), null, 2)}\n`);
  }
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'desktop-state.json'), JSON.stringify({
    schema: 1, recentWorkspaces: [workDir], language: 'en', dismissedHints: ['onboarding-v1'],
    update: { channel: 'stable', lastCheckedAt: 0, skippedVersion: null, enabled: false, feedUrl: null },
    ...(options.state ?? {}),
  }));
  options.seed?.({ home, workDir });

  const packaged = process.env.ARAGON_E2E_APP;
  const electronPath = createRequire(import.meta.url)('electron') as string;
  // Derived from `home`, not random: two instances started on the SAME home still collide on the lock
  // (so single-instance behavior stays testable), while different tests never share one.
  const userDataDir = join(home, 'electron-user-data');
  let app: ElectronApplication;
  let window: Page;
  try {
    app = await electron.launch({
      executablePath: packaged ?? electronPath,
      args: [...(packaged ? [] : ['.']), '--e2e', `--e2e-user-data=${userDataDir}`, ...(options.args ?? [])],
      cwd: desktopRoot,
      env: launchEnvironment(home),
      timeout: 90_000,
    });
    window = await app.firstWindow();
  } catch (error) {
    throw explainLaunchFailure(error, { sourceNewerThanDist: !packaged && sourceIsNewerThanDist() });
  }
  const logs: string[] = [];
  window.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') logs.push(`${message.type()}: ${message.text()} @${message.location().url}:${message.location().lineNumber}`); });
  window.on('pageerror', (error) => logs.push(`pageerror: ${error.message}`));

  const launched: Launched = {
    app, window, home, workDir, mock, logs,
    problems: () => logs.filter((line) => ![...CONSOLE_ALLOWLIST, ...(options.allowConsole ?? [])].some((entry) => entry.pattern.test(line))),
    transcript: () => window.getByRole('log', { name: 'Conversation' }),
    composer: () => window.getByRole('combobox', { name: 'Message' }),
    async openWorkspace() {
      await window.getByRole('button', { name: workDir }).click();
      await launched.composer().waitFor({ state: 'visible', timeout: 60_000 });
    },
    async send(text) {
      const box = launched.composer();
      await box.fill(text);
      await box.press('Enter');
    },
    evaluate: (fn, arg) => app.evaluate(fn as never, arg as never) as never,
    drainNotifications: () => app.evaluate(() => (globalThis as unknown as { __aragonE2e: { drainNotifications(): Array<{ title: string; body: string; sessionId?: string }> } }).__aragonE2e.drainNotifications()),
    activateNotification: (index = 0) => app.evaluate((_electron, at) => (globalThis as unknown as { __aragonE2e: { activateNotification(i: number): boolean } }).__aragonE2e.activateNotification(at), index),
    crashRenderer: (windowIndex = 0) => app.evaluate((_electron, at) => (globalThis as unknown as WithHooks).__aragonE2e.crashRenderer(at), windowIndex),
    geometry: (windowIndex = 0) => app.evaluate((_electron, at) => (globalThis as unknown as WithHooks).__aragonE2e.getWindowGeometry(at), windowIndex),
    setZoom: (factor, windowIndex = 0) => app.evaluate((_electron, args) => (globalThis as unknown as WithHooks).__aragonE2e.setZoom(args.factor, args.at), { factor, at: windowIndex }),
    pendingBoxes: () => app.evaluate(() => (globalThis as unknown as WithHooks).__aragonE2e.pendingMessageBoxes()),
    answerBox: (index) => app.evaluate((_electron, at) => (globalThis as unknown as WithHooks).__aragonE2e.answerMessageBox(at), index),
    statePath: () => join(home, 'desktop-state.json'),
    async close() {
      // A normal close can wait forever: with a run still in progress the app asks "Quit? 1 session is still
      // working" and `app.close()` waits for a person to answer. One test that failed mid-run then held the
      // single-instance lock for the next ones, and the first 3-run repeat turned one flake into 21 failures.
      // After a grace period, end it for good - the test is over, nobody is going to answer.
      const closed = await Promise.race([
        app.close().then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (!closed) {
        await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
        try { app.process().kill(); } catch { /* already gone */ }
      }
      await mock.close().catch(() => undefined);
      if (!options.keepHome) {
        rmSync(home, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
  return launched;
}
