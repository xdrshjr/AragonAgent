/**
 * v1.2 lifecycle scenarios in a REAL window: where it opens and what zoom it keeps (AC-71), what happens
 * when its renderer dies (AC-73 / AC-74), and the session-menu / export / find flows (AC-77, 79, 81).
 *
 * Geometry tests pass `--e2e-restore-window`: plain `--e2e` pins a 1280x800 window and never reads or
 * writes window state, which would make "restores the saved geometry" impossible to observe.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeBigSession } from './fixtures/big-session.js';
import { start } from './fixtures/harness.js';
import type { Launched } from './fixtures/launch.js';

const panel = { sidebarWidth: 260, inspectorWidth: 340, inspectorOpen: false, inspectorTab: 'changes', openSessions: [], activeSession: null };
const seeded = (extra: Record<string, unknown>) => ({
  windows: [{ id: 'w1', bounds: { x: 120, y: 90, width: 1000, height: 700 }, maximized: false, ...panel, ...extra }],
});
const readWindow = (app: Launched): Record<string, any> => JSON.parse(readFileSync(app.statePath(), 'utf8')).windows[0];
const near = (actual: number, wanted: number, slack = 2): boolean => Math.abs(actual - wanted) <= slack;

/**
 * Read the page from the MAIN process. After a renderer crash Playwright's `Page` object stays marked
 * "crashed" for good even though Electron has reloaded the window, so everything after a crash is asked
 * of the live `webContents` instead (and typing goes through real input events sent to it).
 */
const inPage = <T,>(app: Launched, expression: string): Promise<T | null> =>
  app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(code).catch(() => null), expression) as Promise<T | null>;

const COMPOSER = "textarea[role='combobox']";
const composerValue = (app: Launched) => inPage<string>(app, `document.querySelector(${JSON.stringify(COMPOSER)})?.value ?? null`);
const transcriptText = (app: Launched) => inPage<string>(app, "document.querySelector('[role=\"log\"]')?.innerText ?? ''");
const hasText = (app: Launched, text: string) => inPage<boolean>(app, `document.body.innerText.includes(${JSON.stringify(text)})`);

async function typeAndSend(app: Launched, text: string): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, args) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    contents.focus();
    await contents.executeJavaScript(`document.querySelector(${JSON.stringify(args.selector)})?.focus()`);
    await contents.insertText(args.text);
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  }, { selector: COMPOSER, text });
}

describe('AC-71 window geometry', () => {
  it('opens at the saved bounds, applies the saved zoom, and a move does not erase the zoom', async () => {
    const app = await start('window restore', { args: ['--e2e-restore-window'], state: seeded({ zoom: 1.25 }) });
    await expect.poll(async () => (await app.geometry()).visible, { timeout: 30_000 }).toBe(true);
    const geometry = await app.geometry();
    expect(near(geometry.bounds.x, 120) && near(geometry.bounds.y, 90)).toBe(true);
    expect(near(geometry.bounds.width, 1000) && near(geometry.bounds.height, 700)).toBe(true);
    expect(geometry.zoom).toBeCloseTo(1.25, 2);
    expect(geometry.maximized).toBe(false);

    // Move it, then wait past the debounce AND past the renderer's own layout write (600 ms): both
    // writers have run, and neither may drop the zoom or revert the bounds.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setBounds({ x: 160, y: 120, width: 1040, height: 720 }); });
    await expect.poll(() => readWindow(app).bounds.x, { timeout: 10_000 }).toBe(160);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    let saved = readWindow(app);
    expect(saved.zoom).toBeCloseTo(1.25, 2);
    expect(near(saved.bounds.x, 160) && near(saved.bounds.width, 1040)).toBe(true);

    // THE regression: the renderer writes its panel layout through the same entry, with the geometry it read
    // at start-up. Toggling the inspector triggers that write AFTER the move was saved; it must not put the old
    // bounds back or drop the zoom (found by reading App.tsx; mutation-checked by removing the merge).
    await app.window.keyboard.press('Control+j');
    await expect.poll(() => readWindow(app).inspectorOpen, { timeout: 10_000 }).toBe(true);
    saved = readWindow(app);
    expect(saved.zoom).toBeCloseTo(1.25, 2);
    expect(near(saved.bounds.x, 160) && near(saved.bounds.width, 1040)).toBe(true);
  });

  it('a maximized window restores maximized and un-maximizes back to the saved normal bounds', async () => {
    const app = await start('window maximized', { args: ['--e2e-restore-window'], state: seeded({ maximized: true }) });
    await expect.poll(async () => (await app.geometry()).maximized, { timeout: 30_000 }).toBe(true);
    const geometry = await app.geometry();
    expect(near(geometry.normalBounds.width, 1000) && near(geometry.normalBounds.height, 700)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.unmaximize(); });
    await expect.poll(async () => near((await app.geometry()).bounds.width, 1000), { timeout: 10_000 }).toBe(true);
  });

  it('a position on a display that no longer exists keeps the size and the window is visible', async () => {
    const app = await start('window offscreen', {
      args: ['--e2e-restore-window'], state: { windows: [{ id: 'w1', bounds: { x: 50_000, y: 50_000, width: 1000, height: 700 }, maximized: false, ...panel }] },
    });
    await expect.poll(async () => (await app.geometry()).visible, { timeout: 30_000 }).toBe(true);
    const geometry = await app.geometry();
    expect(near(geometry.bounds.width, 1000)).toBe(true);
    expect(geometry.bounds.x).toBeLessThan(10_000);
  });

  it('with an engine that cannot load, the window still appears (at the default size)', async () => {
    const app = await start('window engine failure', {
      args: ['--e2e-restore-window'], config: 'none', state: { windows: 'garbage' },
    });
    await expect.poll(async () => (await app.geometry()).visible, { timeout: 30_000 }).toBe(true);
  });
});

describe('AC-75 zoom keeps the page header and the window-controls strip the same height', () => {
  for (const factor of [1, 1.25, 1.5]) {
    it(`at ${factor * 100}%`, async () => {
      const app = await start(`zoom ${factor}`, { args: ['--e2e-restore-window'] });
      await app.setZoom(factor);
      await expect.poll(async () => (await app.geometry()).zoom, { timeout: 10_000 }).toBeCloseTo(factor, 2);
      const geometry = await app.geometry();
      if (geometry.overlayHeight === null) return; // macOS: traffic lights, no overlay strip
      const header = await app.window.locator('header.titlebar').first().boundingBox();
      expect(header, 'the page header must exist for this check to mean anything').not.toBeNull();
      // Playwright reports CSS px (it already divides out the zoom); header height * zoom = DIP, which must meet the strip's.
      const rendered = await app.window.evaluate(() => (document.querySelector('header.titlebar') as HTMLElement).getBoundingClientRect().height);
      expect(Math.abs(rendered * factor - geometry.overlayHeight)).toBeLessThanOrEqual(2);
      await expect.poll(() => readWindow(app).zoom, { timeout: 10_000 }).toBeCloseTo(factor, 2);
    });
  }
});

describe('AC-73 / AC-74 the renderer dies', () => {
  it('heals itself: reloads, re-attaches the session, keeps the draft, and the session host is untouched', async () => {
    const app = await start('renderer crash', { turns: [{ deltas: ['Hello back.'] }, { deltas: ['Second reply.'] }] });
    await app.openWorkspace();
    await app.send('hi');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Hello back.');
    await app.composer().fill('an unsent draft');
    const hostPid = () => app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().find((metric) => metric.type === 'Utility' && /session-host/i.test(metric.name ?? ''))?.pid ?? 0);
    const before = await hostPid();
    expect(before).toBeGreaterThan(0);

    await app.crashRenderer();

    await expect.poll(() => composerValue(app), { timeout: 30_000, interval: 500 }).toBe('an unsent draft');
    await expect.poll(() => transcriptText(app), { timeout: 30_000, interval: 500 }).toContain('Hello back.');
    expect(await hostPid()).toBe(before);

    await typeAndSend(app, 'again');
    await expect.poll(() => transcriptText(app), { timeout: 30_000, interval: 500 }).toContain('Second reply.');
  }, 120_000);

  it('a third crash inside a minute asks instead of reloading a fourth time', async () => {
    const app = await start('renderer crash loop', { allowUnconsumed: true });
    await expect.poll(async () => (await app.geometry()).visible, { timeout: 30_000 }).toBe(true);
    for (let crash = 0; crash < 3; crash += 1) {
      await app.crashRenderer();
      await new Promise((resolve) => setTimeout(resolve, crash < 2 ? 3000 : 500));
    }
    await expect.poll(async () => (await app.pendingBoxes()).length, { timeout: 10_000 }).toBe(1);
    const [box] = await app.pendingBoxes();
    expect(box?.kind).toBe('crash');
    expect(box?.choices).toEqual(['reload', 'logs', 'quit']);
    expect(await app.answerBox(0)).toBe(true); // "Reload"
    await expect.poll(() => hasText(app, app.workDir), { timeout: 30_000, interval: 500 }).toBe(true);
  }, 120_000);

  it('a failed load of the main frame is recovered by loading the app again', async () => {
    const app = await start('load failure', { allowUnconsumed: true });
    await expect.poll(async () => (await app.geometry()).visible, { timeout: 30_000 }).toBe(true);
    await app.evaluate(() => (globalThis as unknown as { __aragonE2e: { failLoad(): void } }).__aragonE2e.failLoad());
    // The window sits on the failed address until the recovery restarts it onto the app's own page.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getURL()), { timeout: 30_000, interval: 500 })
      .toMatch(/^app:\/\/renderer\//);
    await expect.poll(() => hasText(app, app.workDir), { timeout: 30_000, interval: 500 }).toBe(true);
  }, 120_000);
});

describe('AC-77 / AC-78 / AC-79 session menu, /reset, /save and export', () => {
  it('the ⋯ menu saves a checkpoint, branches, resets, and exports Markdown without the API key', async () => {
    const app = await start('session menu', {
      turns: [{ deltas: ['First answer, which mentions test-key and sk-live-abcdefghijklmnop.'] }],
      allowUnconsumed: true,
    });
    await app.openWorkspace();
    await app.send('hello menu');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('First answer');
    const page = app.window;

    // Save checkpoint -> a toast with the path, and the file exists.
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: /Save checkpoint/ }).click();
    await expect.poll(async () => (await page.locator('.toast').allInnerTexts()).join(' '), { timeout: 15_000 }).toMatch(/Checkpoint saved to .+/);
    expect(readdirSync(join(app.home, 'sessions')).length).toBeGreaterThan(0);

    // Export: the save dialog is native, so answer it from the main process.
    const target = join(app.workDir, 'export.md');
    await app.evaluate(({ dialog }, filePath) => {
      (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = async () => ({ canceled: false, filePath });
    }, target);
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: /Export as Markdown/ }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect.poll(() => existsSync(target), { timeout: 15_000 }).toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text.split('\n')[0]).toMatch(/^# /);
    expect(text).toContain('First answer');
    expect(text).not.toContain('test-key'); // the configured API key
    expect(text).not.toMatch(/sk-/);

    // Reset: the transcript is archived and a new conversation starts (menu item, idle).
    await page.getByRole('button', { name: 'Session actions' }).click();
    await page.getByRole('menuitem', { name: /New conversation/ }).click();
    await expect.poll(() => app.transcript().innerText(), { timeout: 15_000 }).not.toContain('First answer');
  }, 120_000);

  it('/reset in the composer does what /clear does, and cancelling the export dialog is silent', async () => {
    const app = await start('slash reset', { turns: [{ deltas: ['An answer to clear.'] }], allowUnconsumed: true });
    await app.openWorkspace();
    await app.send('before reset');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('An answer to clear.');
    await app.evaluate(({ dialog }) => {
      (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = async () => ({ canceled: true });
    });
    await app.window.getByRole('button', { name: 'Session actions' }).click();
    await app.window.getByRole('menuitem', { name: /Export as Markdown/ }).click();
    await app.window.getByRole('button', { name: 'Export', exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await app.window.getByRole('alert').count()).toBe(0);
    await app.window.getByRole('button', { name: 'Cancel' }).click();

    await app.composer().fill('/reset');
    await app.composer().press('Enter');
    await expect.poll(() => app.transcript().innerText(), { timeout: 15_000 }).not.toContain('An answer to clear.');
  }, 120_000);
});

describe('AC-81 find in a long conversation', () => {
  it('Ctrl+F finds a phrase in the loaded part of a 5,000-entry session, scrolls to it and highlights it', async () => {
    const needle = 'needle-xyzzy-4500';
    const app = await start('find big', {
      turns: [],
      seed: ({ home, workDir }) => { writeBigSession(home, 'bigsession1', 5000, workDir, { index: 4500, text: `the ${needle} sits here` }); },
    });
    const row = app.window.getByRole('button', { name: /Untitled session|question number/ }).first();
    await row.waitFor({ timeout: 60_000 });
    await row.click();
    await app.window.locator('.row').first().waitFor({ timeout: 60_000 });

    await app.window.keyboard.press('Control+f');
    const box = app.window.getByRole('textbox', { name: 'Find in conversation' });
    await box.fill(needle);
    await app.window.getByText('1 of 1').waitFor({ state: 'visible', timeout: 10_000 });
    const target = app.window.locator('.row', { hasText: needle });
    await target.waitFor({ state: 'visible', timeout: 10_000 });
    const inView = await target.evaluate((element) => {
      const scroller = element.closest('.transcript')!.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return rect.top >= scroller.top - 1 && rect.bottom <= scroller.bottom + 1;
    });
    expect(inView).toBe(true);
    expect(await app.window.evaluate(() => (globalThis as unknown as { CSS: { highlights?: Map<string, { size: number }> } }).CSS.highlights?.get('find-current')?.size ?? 0)).toBeGreaterThan(0);

    await box.press('Enter'); // a single match: wraps to itself
    await app.window.getByText('1 of 1').waitFor({ state: 'visible' });
    await box.press('Escape');
    await box.waitFor({ state: 'hidden', timeout: 10_000 });
    await expect.poll(() => app.composer().evaluate((element) => element === document.activeElement), { timeout: 10_000 }).toBe(true);
  }, 180_000);
});
