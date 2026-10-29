/**
 * E-5: the app survives the loss of its session host process and of its page. These are the
 * recoveries the supervisor and the window already implement; the test only proves they work
 * through the real processes, so a regression cannot hide behind unit tests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from './fixtures/harness.js';

describe('E-5 recovery', () => {
  it('restarts a killed session host and keeps the conversation on screen', async () => {
    const app = await start('E-5 host killed', {
      turns: [{ deltas: ['First reply.'] }, { deltas: ['Reply after recovery.'] }],
    });
    await app.openWorkspace();
    await app.send('before');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('First reply.');

    // A crash recovers the last CHECKPOINT, which is written a moment after the turn ends (the
    // "Saved" stamp also shows for the empty first one), so wait for the reply to be on disk.
    await expect.poll(() => readdirSync(join(app.home, 'sessions')).some((name) => {
      try { return readFileSync(join(app.home, 'sessions', name), 'utf8').includes('First reply.'); } catch { return false; }
    }), { timeout: 30_000 }).toBe(true);

    // Kill the session host (a utilityProcess); nothing else.
    const killed = await app.evaluate(({ app: electronApp }) => {
      const host = electronApp.getAppMetrics().find((metric) => metric.type === 'Utility' && /session-host/i.test(metric.name ?? ''));
      if (!host) return JSON.stringify(electronApp.getAppMetrics().map((metric) => [metric.type, metric.name, metric.serviceName]));
      process.kill(host.pid);
      return true;
    });
    expect(killed, 'no session-host process among the app metrics').toBe(true);

    // The transcript is still there, and a new message works once the host is back.
    expect(await app.transcript().innerText()).toContain('First reply.');
    await expect.poll(async () => {
      await app.composer().fill('after');
      await app.composer().press('Enter');
      return app.transcript().innerText();
    }, { timeout: 45_000, interval: 3_000 }).toContain('Reply after recovery.');
    expect(await app.transcript().innerText()).toContain('First reply.');
  });

  it('reloads the page and finds the same session again', async () => {
    const app = await start('E-5 page reload', { turns: [{ deltas: ['Still here.'] }] });
    await app.openWorkspace();
    await app.send('hello');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Still here.');

    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.webContents.reload(); });
    await app.window.waitForLoadState('domcontentloaded');
    // After a reload the session list shows the saved conversation; opening it restores the text.
    await app.window.getByRole('button', { name: /hello/ }).first().click({ timeout: 30_000 });
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Still here.');
  });
});
