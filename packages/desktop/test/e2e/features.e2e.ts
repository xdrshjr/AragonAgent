/**
 * The v1.1 completions, through the real window: withdrawing a queued message (AC-55), images from
 * the workspace (AC-60), the update notification (AC-65), failures of the config write (§3.10)
 * and a damaged desktop-state.json (E-9).
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from './fixtures/harness.js';

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function openSettings(app: Awaited<ReturnType<typeof start>>, page: string): Promise<void> {
  await app.window.getByRole('button', { name: 'Settings' }).first().click();
  await app.window.getByRole('navigation', { name: /settings/i }).getByRole('button', { name: page }).click();
}

describe('queue withdrawal (AC-55)', () => {
  it('takes a queued message back into the composer, and the model never receives it', async () => {
    const app = await start('queue withdraw', { turns: [{ deltas: ['working'], holdOpen: true }] });
    await app.openWorkspace();
    await app.send('first question');
    await expect.poll(() => app.mock.requests().length, { timeout: 30_000 }).toBe(1);

    await app.send('also remember this');
    const withdraw = app.window.getByRole('button', { name: 'Withdraw queued message' });
    await withdraw.waitFor({ timeout: 15_000 });
    await withdraw.click();

    await expect.poll(() => app.composer().inputValue(), { timeout: 15_000 }).toBe('also remember this');
    // The text is restored the moment the engine accepts the withdrawal; the queued row leaves the transcript
    // with the next batch of view actions. Asserting the row's absence on the same tick was a race (found by
    // the first 3-run repeat: it passed once and failed once), so wait for it.
    await expect.poll(() => withdraw.count(), { timeout: 10_000 }).toBe(0);

    app.mock.release();
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('working');
    await app.window.waitForTimeout(500);
    // One request in total: the withdrawn text was not sent, now or later.
    expect(app.mock.requests()).toHaveLength(1);
    expect(JSON.stringify(app.mock.requests())).not.toContain('also remember this');
  });
});

describe('workspace images (AC-60)', () => {
  it('shows an image from the working directory and refuses one outside it', async () => {
    const app = await start('asset images', {
      allowConsole: [{ pattern: /404/, reason: 'the asset protocol answers 404 for a refused path, by design (no probing)' }],
      turns: [{ deltas: ['Here: ![shot](pic.png) and ![bad](../outside.png)'] }],
      seed: ({ workDir }) => {
        writeFileSync(join(workDir, 'pic.png'), PNG);
        writeFileSync(join(workDir, '..', 'outside.png'), PNG);
      },
    });
    await app.openWorkspace();
    await app.send('show me');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Here:');

    const good = app.window.locator('img[src^="aragon-asset://"][src$="pic.png"]');
    await good.waitFor({ timeout: 15_000 });
    await expect.poll(() => good.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);

    // The traversal never produced a loaded image: it fell back to its alt text.
    await expect.poll(() => app.transcript().innerText()).toContain('bad');
    expect(await app.window.locator('img[src*="outside.png"]').count()).toBe(0);
  });
});

describe('update notification (AC-65)', () => {
  it('offers a newer version from a local feed, opens nothing by itself, and remembers a skip', async () => {
    const hits: string[] = [];
    const feed = createServer((req, res) => {
      hits.push(req.url ?? '');
      const { port } = feed.address() as AddressInfo;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9', downloadUrl: `http://127.0.0.1:${port}/download`, releasedAt: '2026-11-03T00:00:00Z', sha256: { 'win-x64': 'x' } }));
    });
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    const { port } = feed.address() as AddressInfo;
    try {
      const app = await start('update notification', {
        args: [`--e2e-feed=http://127.0.0.1:${port}/latest.json`],
        state: { update: { channel: 'stable', lastCheckedAt: 0, skippedVersion: null, enabled: true, feedUrl: null } },
      });
      await app.window.getByRole('button', { name: 'Settings' }).first().waitFor({ timeout: 30_000 });
      await openSettings(app, 'Updates');
      await app.window.getByText('Version 9.9.9 is available.').waitFor({ timeout: 30_000 });
      expect(hits.length).toBeGreaterThan(0);
      await app.window.getByRole('button', { name: /Version 9\.9\.9 available/ }).waitFor();

      await app.window.getByRole('button', { name: 'Skip this version' }).click();
      await app.window.getByText('You are up to date.').waitFor();
      await expect.poll(() => app.window.getByRole('button', { name: /Version 9\.9\.9 available/ }).count()).toBe(0);
      const saved = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(app.home, 'desktop-state.json'), 'utf8')));
      expect(saved.update.skippedVersion).toBe('9.9.9');
    } finally {
      await new Promise<void>((resolve) => feed.close(() => resolve()));
    }
  });
});

describe('config write failures (§3.10)', () => {
  for (const fault of ['enospc', 'eacces']) {
    it(`says the save failed, plainly, when the disk reports ${fault}`, async () => {
      const app = await start(`fault ${fault}`, { args: [`--e2e-fault=${fault}`] });
      await app.window.getByRole('button', { name: 'Settings' }).first().waitFor({ timeout: 30_000 });
      await openSettings(app, 'Retry');
      await app.window.getByRole('switch', { name: 'Retry failed requests' }).click();
      await app.window.getByRole('button', { name: 'Save' }).first().click();
      await app.window.getByText(/Could not save \(write_failed\)/).waitFor({ timeout: 15_000 });
    });
  }
});

describe('E-9 a damaged desktop-state.json', () => {
  it('starts anyway, keeps the broken file aside and uses defaults', async () => {
    const app = await start('E-9 corrupt state', {
      seed: ({ home }) => writeFileSync(join(home, 'desktop-state.json'), '{ not json'),
    });
    // The defaults are in use, so the language follows the system (this machine may be Chinese).
    await app.window.getByRole('button', { name: /Settings|设置/ }).first().waitFor({ timeout: 30_000 });
    await app.window.getByRole('status').filter({ hasText: /could not be read|无法读取/ }).waitFor({ timeout: 15_000 });
    expect(readdirSync(app.home).some((name) => name.startsWith('desktop-state.json.corrupt-'))).toBe(true);
    expect(existsSync(join(app.home, 'config.json'))).toBe(true);
  });
});
