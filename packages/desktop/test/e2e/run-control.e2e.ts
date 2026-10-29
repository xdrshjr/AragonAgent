/**
 * E-3 approval guard, E-4 the Esc ladder, E-6 an external edit of config.json (what the terminal
 * does), E-10 notifications. All against the real window and the scripted model.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from './fixtures/harness.js';

const BASH_TURN = { deltas: ['Running it.'], toolCalls: [{ name: 'bash', args: { command: 'echo guard-test' } }] };

describe('E-3 approval', () => {
  it('starts with focus on Deny and ignores a press in the first moments (no accidental Enter)', async () => {
    const app = await start('E-3 approval', { configExtra: { confirmTools: true }, turns: [BASH_TURN, { deltas: ['Understood, not running it.'] }] });
    await app.openWorkspace();
    await app.send('run echo');

    // Act in the SAME task the card appears in, so "immediately" really is immediately.
    const focused = await app.window.evaluate(() => new Promise<string>((resolve) => {
      const allow = (): HTMLElement | undefined =>
        [...document.querySelectorAll('button')].find((button) => /Allow once/.test(button.textContent ?? ''));
      const observer = new MutationObserver(() => {
        const button = allow();
        if (!button) return;
        observer.disconnect();
        const active = document.activeElement?.textContent ?? '';
        button.click();
        resolve(active);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }));
    expect(focused).toMatch(/Deny/);

    // The early click did nothing: the card is still waiting and the command never ran.
    await app.window.waitForTimeout(150);
    expect(await app.window.getByRole('button', { name: 'Allow once' }).count()).toBe(1);
    expect(app.mock.requests()).toHaveLength(1);

    await app.window.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Understood, not running it.');
    expect(app.mock.requests()).toHaveLength(2);
  });
});

describe('E-4 Esc ladder', () => {
  it('the first Esc arms ("press again"), the second stops the stream and the model connection closes', async () => {
    const app = await start('E-4 esc', {
      turns: [{ deltas: ['x'.repeat(200)], tokensPerSecond: 5, holdOpen: true }],
      allowUnconsumed: true,
    });
    await app.openWorkspace();
    await app.send('write something long');
    await expect.poll(() => app.mock.requests().length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => app.transcript().innerText()).toContain('xxxx');

    await app.composer().press('Escape');
    await expect.poll(() => app.window.getByText(/Press Esc again/).count()).toBeGreaterThan(0);
    expect(app.mock.requests()[0]!.closedByClient).toBe(false); // one press alone stops nothing

    await app.composer().press('Escape');
    await expect.poll(() => app.mock.requests()[0]!.closedByClient, { timeout: 15_000 }).toBe(true);
    app.mock.release();
  });
});

describe('E-6 the terminal edits config.json while the desktop is open', () => {
  it('shows the new model within a couple of seconds when idle', async () => {
    const app = await start('E-6 external edit');
    await app.openWorkspace();
    await expect.poll(() => app.window.getByRole('button', { name: /mock-1/ }).count(), { timeout: 15_000 }).toBeGreaterThan(0);

    const path = join(app.home, 'config.json');
    const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...config, model: 'mock-2' }, null, 2)}\n`);

    await expect.poll(() => app.window.getByRole('button', { name: /mock-2/ }).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  });
});

/** Focus is an operating-system fact the harness cannot rely on (CI has no focused window), so the test sets it. */
const setFocused = (app: Awaited<ReturnType<typeof start>>, focused: boolean) =>
  app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows().forEach((window) => { window.isFocused = () => value; });
  }, focused as never);

describe('E-10 system notifications', () => {
  it('notifies when a turn ends in an unfocused window, not in a focused one, and does not merge turns', async () => {
    const app = await start('E-10 notifications', {
      turns: [{ deltas: ['First answer.'+String.fromCharCode(10)+'More detail.'] }, { deltas: ['Second answer.'] }, { deltas: ['Third answer.'] }],
    });
    await app.openWorkspace();

    // Focused: the turn ends and nothing is queued.
    await setFocused(app, true);
    await app.send('one');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('First answer.');
    await app.window.waitForTimeout(500);
    expect(await app.drainNotifications()).toEqual([]);

    // Unfocused: one notification per turn, titled with the workspace, quoting the first line only.
    await setFocused(app, false);
    await app.send('two');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Second answer.');
    const seen: Array<{ title: string; body: string; sessionId?: string }> = [];
    await expect.poll(async () => { seen.push(...(await app.drainNotifications())); return seen.length; }, { timeout: 15_000 }).toBe(1);
    expect(seen[0]!.body).toBe('Second answer.');
    expect(seen[0]!.title).toContain('aragon-e2e-work');

    await app.send('three');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Third answer.');
    await expect.poll(async () => { seen.push(...(await app.drainNotifications())); return seen.length; }, { timeout: 15_000 }).toBe(2);
    expect(seen[1]!.body).toBe('Third answer.');
    // Clicking the notification as the OS would focuses the window on that session (queue is empty now: false).
    expect(await app.activateNotification(0)).toBe(false);
  });
});
