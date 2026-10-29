/**
 * E-7 (a session a terminal is writing) and E-8 (nothing the app started outlives it).
 *
 * Both were listed as "not written" at the end of v1.1. E-7 uses a real lock file (`sessions/<id>.lock`
 * with a live pid on this host) and asserts the dialog really has two buttons - the v1.1 text said three.
 * E-8 records every process below the app's main process, quits through the normal path, and checks that
 * no recorded (pid, start time) is alive afterwards.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeBigSession } from './fixtures/big-session.js';
import { start } from './fixtures/harness.js';
import { descendantsOf, snapshotProcesses, stillAlive } from './fixtures/proc-tree.js';

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('E-7 a session held by a terminal', () => {
  it('is marked, asks "cancel or branch" (two buttons), branches without touching the original, and frees up when the lock is gone', async () => {
    let sessionFile = '';
    let lockFile = '';
    const app = await start('E-7 busy elsewhere', {
      seed: ({ home, workDir }) => {
        sessionFile = writeBigSession(home, 'termheld1', 4, workDir);
        // The index only looks at the lock of a session whose own metadata says it is live (a cheap prefilter).
        const saved = JSON.parse(readFileSync(sessionFile, 'utf8'));
        saved.meta.live = true;
        writeFileSync(sessionFile, JSON.stringify(saved));
        lockFile = join(home, 'sessions', 'termheld1.lock');
        // This test process is alive, on this host, and is not one of the app's own hosts: exactly "a terminal".
        writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: hostname() }));
      },
    });
    const before = digest(sessionFile);
    const row = app.window.getByRole('button', { name: /Untitled session/ }).first();
    await row.waitFor({ timeout: 60_000 });
    expect(await app.window.getByLabel('In use in a terminal').count()).toBeGreaterThan(0);

    await row.click();
    const dialog = app.window.getByRole('dialog');
    await dialog.waitFor({ timeout: 10_000 });
    const buttons = await dialog.getByRole('button').allInnerTexts();
    expect(buttons, 'the dialog offers exactly Cancel and Branch').toHaveLength(2);
    expect(buttons.map((text) => text.trim())).toEqual(['Cancel', 'Branch as new session']);

    // Cancel: nothing is written, nothing is opened.
    const filesBefore = readdirSync(join(app.home, 'sessions')).sort();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    expect(digest(sessionFile)).toBe(before);
    expect(readdirSync(join(app.home, 'sessions')).sort()).toEqual(filesBefore);

    // Branch: a new session with the same conversation; the held file is byte-for-byte unchanged.
    await row.click();
    await app.window.getByRole('dialog').getByRole('button', { name: 'Branch as new session' }).click();
    await expect.poll(() => app.transcript().innerText(), { timeout: 60_000 }).toContain('question number 1');
    expect(digest(sessionFile)).toBe(before);

    // The "terminal" exits: the next refresh shows the row as writable and it opens without a dialog.
    rmSync(lockFile);
    await expect.poll(() => existsSync(lockFile)).toBe(false);
    await expect.poll(async () => app.window.getByLabel('In use in a terminal').count(), { timeout: 30_000, interval: 1000 }).toBe(0);
  }, 180_000);
});

describe('E-8 nothing outlives the app', () => {
  it('after a normal quit no process the app started is still running', async () => {
    const app = await start('E-8 process tree', { turns: [{ deltas: ['hello'] }] });
    await app.openWorkspace();
    await app.send('hi');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('hello');
    const mainPid = await app.evaluate(() => process.pid);
    const recorded = descendantsOf(mainPid, snapshotProcesses());
    expect(recorded.length, 'the app has child processes to leak in the first place').toBeGreaterThan(2);

    await app.evaluate(({ app: electronApp }) => { electronApp.quit(); });
    await expect.poll(() => stillAlive(recorded, snapshotProcesses()).length, {
      timeout: 15_000, interval: 500, message: 'a process the app started survived its exit',
    }).toBe(0);
  }, 120_000);
});
