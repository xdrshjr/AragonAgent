/**
 * v1.3 shell polish in a REAL window (AC-93 ... AC-102): the geometry claims jsdom cannot check.
 *
 * Pixel colours of the native caption strip are NOT observable (the screenshot excludes it and
 * Electron has no getter), so E-L3 asserts what the main process last handed to Electron - the
 * hook reads `chrome.lastOverlay` - and that the page's own title bar is the same colour.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHROME_COLORS, type ChromeTheme } from '../../src/shared/window-chrome.js';
import { writeBigSession } from './fixtures/big-session.js';
import { start } from './fixtures/harness.js';
import type { Launched } from './fixtures/launch.js';

const isMac = process.platform === 'darwin';
const readWindow = (app: Launched): Record<string, any> | undefined => JSON.parse(readFileSync(app.statePath(), 'utf8')).windows?.[0];

const rect = (app: Launched, selector: string) => app.window.evaluate((sel) => {
  const box = document.querySelector(sel)?.getBoundingClientRect();
  return box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null;
}, selector);

const noSideways = (app: Launched) => app.window.evaluate(() => ({
  page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  body: (document.querySelector('.body') as HTMLElement).scrollWidth - (document.querySelector('.body') as HTMLElement).clientWidth,
}));

const rgbToHex = (rgb: string): string => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
};

/** Resize the window and wait until the PAGE (not just the window) has that many CSS px at the current zoom. */
async function resizeTo(app: Launched, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, width: w, height: 600 }); }, width);
  await expect.poll(() => app.window.evaluate(() => document.documentElement.clientWidth), { timeout: 10_000 }).toBeLessThanOrEqual(width + 2);
  await new Promise((resolve) => setTimeout(resolve, 400)); // let the ResizeObserver-driven layout tier settle
}

async function openInspector(app: Launched): Promise<void> {
  await app.openWorkspace();
  await app.window.getByRole('button', { name: 'Toggle inspector' }).click();
  await app.window.locator('.inspector').waitFor({ state: 'visible' });
}

describe('E-L1 a long session title does not widen the sidebar (AC-93)', () => {
  it('keeps the sidebar slot at its width, the main pane to its right, and no sideways scroll', async () => {
    const app = await start('long title', {
      seed: ({ home, workDir }) => {
        writeBigSession(home, 'longtitle1', 4, workDir, { index: 0, text: `${'之前的任务：给这个项目添加完善的用户系统 - '.repeat(120)}` });
        writeBigSession(home, 'multiline1', 4, workDir, { index: 0, text: 'first line\n\n   second\tline' });
      },
    });
    await app.window.locator('.srow').first().waitFor({ state: 'visible', timeout: 60_000 });
    const slot = await rect(app, '.sidebar-slot');
    const sidebar = await rect(app, '.sidebar');
    const main = await rect(app, 'main.main');
    expect(slot!.width).toBeCloseTo(260, 0);
    expect(sidebar!.width).toBeLessThanOrEqual(slot!.width + 0.5);
    expect(main!.left).toBeGreaterThanOrEqual(sidebar!.right - 1);
    expect(await noSideways(app)).toEqual({ page: 0, body: 0 });
    // The row's title is cut with an ellipsis, and hovering offers the full text.
    const title = app.window.locator('.srow-main').first();
    expect(((await title.getAttribute('title')) ?? '').length).toBeGreaterThan(0);
    expect(app.problems()).toEqual([]);
  });
});

describe('E-L2 the brand mark (AC-95)', () => {
  it('is the first title-bar element at the top left, is not a button, and clicking it changes nothing', async () => {
    const app = await start('brand mark');
    const mark = app.window.locator('header.titlebar > :first-child');
    const box = await mark.boundingBox();
    expect(box!.x).toBeLessThan(80);
    expect(box!.y).toBeLessThan(20);
    expect(await mark.evaluate((element) => element.tagName)).not.toBe('BUTTON');
    expect(await mark.locator('svg[role="img"]').count()).toBe(1);
    await mark.click();
    await expect.poll(() => app.window.locator('.sidebar').count()).toBe(1);
  });
});

describe.skipIf(isMac)('E-L3 window controls follow the APPLICATION theme (AC-96 / AC-98)', () => {
  for (const [setting, theme] of [['light', 'light'], ['cool', 'dark'], ['warm', 'warm']] as Array<[string, ChromeTheme]>) {
    it(`theme "${setting}": the strip, the window background and the page's own title bar agree`, async () => {
      const app = await start(`chrome ${setting}`, { configExtra: { theme: setting } });
      await app.window.locator('header.titlebar').waitFor({ state: 'visible', timeout: 60_000 });
      await expect.poll(async () => (await app.geometry()).overlayColor, { timeout: 30_000 }).toBe(CHROME_COLORS[theme].bar);
      const geometry = await app.geometry();
      expect(geometry.overlaySymbol).toBe(CHROME_COLORS[theme].symbol);
      expect(geometry.backgroundColor).toBe(CHROME_COLORS[theme].page);
      const barColour = await app.window.evaluate(() => getComputedStyle(document.querySelector('header.titlebar')!).backgroundColor);
      expect(rgbToHex(barColour)).toBe(geometry.overlayColor);
      // The strip leaves the bar's divider line alone.
      expect(geometry.overlayHeight).toBe(Math.round(40 * geometry.zoom) - 1);
    });
  }

  it('leaves room for the strip at every zoom (the gutter is not a fixed 150px)', async () => {
    const app = await start('chrome gutter');
    await app.window.locator('header.titlebar').waitFor({ state: 'visible', timeout: 60_000 });
    for (const factor of [0.8, 1, 1.6]) {
      await app.setZoom(factor);
      await expect.poll(async () => (await app.geometry()).zoom, { timeout: 10_000 }).toBeCloseTo(factor, 2);
      const { padding, search } = await app.window.evaluate(() => ({
        padding: parseFloat(getComputedStyle(document.querySelector('header.titlebar')!).paddingRight),
        search: document.querySelector('.search-trigger')!.getBoundingClientRect().right,
      }));
      const viewport = await app.window.evaluate(() => document.documentElement.clientWidth);
      expect(search, `zoom ${factor}: the search box ends before the caption strip`).toBeLessThanOrEqual(viewport - padding + 1);
      // 138 DIP of native buttons, in CSS px at this zoom.
      expect(padding, `zoom ${factor}`).toBeGreaterThanOrEqual(138 / factor - 2);
    }
  });
});

describe('E-L4 / E-L5 inspector tabs and width (AC-99 / AC-100)', () => {
  it('lists six single-line tabs, and the strip scrolls when the window is at its narrowest', async () => {
    const app = await start('inspector tabs', { configExtra: {} });
    await openInspector(app);
    const heights = await app.window.evaluate(() => [...document.querySelectorAll('.tab')].map((tab) => ({
      height: tab.getBoundingClientRect().height, lines: tab.getClientRects().length,
    })));
    expect(heights).toHaveLength(6);
    expect(new Set(heights.map((entry) => Math.round(entry.height))).size).toBe(1);
    expect(heights.every((entry) => entry.lines === 1), JSON.stringify(heights)).toBe(true);

    await resizeTo(app, 800);
    const strip = await app.window.evaluate(() => {
      const list = document.querySelector('.tabs-list') as HTMLElement;
      const active = list.querySelector('[data-state="active"]')!.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return {
        overflow: list.scrollWidth > list.clientWidth, visible: active.left >= bounds.left - 1 && active.right <= bounds.right + 1,
        active: [active.left, active.right], bounds: [bounds.left, bounds.right], scrollLeft: list.scrollLeft, name: list.querySelector('[data-state="active"]')!.textContent,
      };
    });
    expect(strip.visible, JSON.stringify(strip)).toBe(true);
  });

  it('is draggable, persists across the renderer patch, and double-click restores the default', async () => {
    const app = await start('inspector width');
    await openInspector(app);
    expect((await rect(app, '.inspector'))!.width).toBeCloseTo(400, 0);
    const handle = (await app.window.locator('.inspector-resizer').boundingBox())!;
    const y = handle.y + handle.height / 2;
    await app.window.mouse.move(handle.x + 2, y);
    await app.window.mouse.down();
    await app.window.mouse.move(handle.x - 118, y, { steps: 8 });
    await app.window.mouse.up();
    await expect.poll(async () => Math.round((await rect(app, '.inspector'))!.width), { timeout: 5_000 }).toBeGreaterThan(480);
    await expect.poll(() => readWindow(app)?.inspectorWidth ?? 0, { timeout: 10_000 }).toBeGreaterThan(480);

    await app.window.locator('.inspector-resizer').dblclick();
    await expect.poll(async () => Math.round((await rect(app, '.inspector'))!.width), { timeout: 5_000 }).toBe(400);
  });
});

describe('E-L6 settings are centred in the pane (AC-102)', () => {
  for (const [page, name] of [['General', 'General'], ['Models', 'Models'], ['Prompts', 'Prompts']]) {
    it(`${page}: equal left and right margins, and the title and content share a left edge`, async () => {
      const app = await start(`settings ${page}`);
      await app.window.getByRole('button', { name: 'Settings' }).first().click();
      await app.window.getByRole('button', { name, exact: true }).click();
      await app.window.locator('.settings-scroll .settings-col').waitFor({ state: 'visible' });
      const measure = () => app.window.evaluate(() => {
        const main = document.querySelector('.settings-main')!.getBoundingClientRect();
        const col = document.querySelector('.settings-scroll .settings-col')!.getBoundingClientRect();
        const head = document.querySelector('.settings-head .settings-col')!.getBoundingClientRect();
        const foot = document.querySelector('.set-footer .settings-col')!.getBoundingClientRect();
        return { left: col.left - main.left, right: main.right - col.right, head: head.left - col.left, foot: foot.left - col.left };
      });
      const wide = await measure();
      expect(Math.abs(wide.left - wide.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(wide.head)).toBeLessThanOrEqual(1);
      expect(Math.abs(wide.foot)).toBeLessThanOrEqual(1);

      await resizeTo(app, 800);
      await expect.poll(async () => (await rect(app, '.settings-main'))!.width, { timeout: 10_000 }).toBeLessThan(700);
      const narrow = await measure();
      expect(Math.abs(narrow.left - narrow.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(narrow.head)).toBeLessThanOrEqual(1);
      expect(Math.abs(narrow.foot)).toBeLessThanOrEqual(1);
    });
  }
});

describe('E-L7 the main pane keeps its floor in a narrow window (AC-101)', () => {
  it('zoom 1.0 at 800px: the sidebar yields, main >= 360, and it all comes back when the window grows', async () => {
    const app = await start('narrow zoom 1');
    await openInspector(app);
    await resizeTo(app, 800);
    await expect.poll(async () => await app.window.locator('.sidebar').count(), { timeout: 10_000 }).toBe(0);
    expect((await rect(app, 'main.main'))!.width).toBeGreaterThanOrEqual(359);
    expect(await noSideways(app)).toEqual({ page: 0, body: 0 });

    await resizeTo(app, 1280);
    await expect.poll(async () => await app.window.locator('.sidebar').count(), { timeout: 10_000 }).toBe(1);
  });

  it('zoom 1.5 at 800px (about 533 CSS px): still no sideways scroll, tabs still one line', async () => {
    const app = await start('narrow zoom 1.5');
    await openInspector(app);
    await resizeTo(app, 800);
    await app.setZoom(1.5);
    await expect.poll(async () => (await app.geometry()).zoom, { timeout: 10_000 }).toBeCloseTo(1.5, 2);
    await expect.poll(async () => await app.window.locator('.body[data-tier="3"]').count(), { timeout: 10_000 }).toBe(1);
    expect(await noSideways(app)).toEqual({ page: 0, body: 0 });
    expect((await rect(app, 'main.main'))!.width).toBeGreaterThanOrEqual(239);
    const lines = await app.window.evaluate(() => [...document.querySelectorAll('.tab')].map((tab) => tab.getClientRects().length));
    expect(lines.every((count) => count === 1)).toBe(true);
  });

  it('with the sidebar auto-hidden, the rail Sessions button closes the inspector and the list returns (RV-5)', async () => {
    const app = await start('narrow rail');
    await openInspector(app);
    await resizeTo(app, 800);
    await expect.poll(async () => await app.window.locator('.sidebar').count(), { timeout: 10_000 }).toBe(0);
    await app.window.getByRole('navigation').getByRole('button').first().click();
    await expect.poll(async () => await app.window.locator('.inspector').count()).toBe(0);
    await expect.poll(async () => await app.window.locator('.sidebar').count()).toBe(1);
  });
});
