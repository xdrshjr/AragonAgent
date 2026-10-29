/**
 * E-1 and E-2: the first message through a real window, and a streamed reply with a tool call.
 * These two are also the platform probe (spec P6): if a real Electron window cannot be driven
 * against a scripted model here, nothing after them is worth writing.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from './fixtures/harness.js';

describe('E-1 first message', () => {
  it('opens a workspace from the recent list, sends one message and shows the reply', async () => {
    const app = await start('E-1 first message', { turns: [{ deltas: ['Hello ', 'from the mock.'] }] });
    await app.openWorkspace();
    await app.send('Say hello');

    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Hello from the mock.');
    await expect.poll(() => app.transcript().innerText()).toContain('Say hello');
    // Exactly one model request: the app did not send anything the user did not type.
    expect(app.mock.requests()).toHaveLength(1);
    const user = app.mock.requests()[0]!.messages.filter((message) => message.role === 'user');
    expect(user.at(-1)?.content).toBe('Say hello');
  });

  it('starts unconfigured, leaves no config file behind until the last onboarding step', async () => {
    const app = await start('E-1 onboarding', { config: 'none', state: { dismissedHints: [] } });
    // The first screen is onboarding, not a broken-looking empty window.
    await app.window.getByRole('heading').first().waitFor({ timeout: 30_000 });
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(app.home, 'config.json'))).toBe(false);
  });
});

describe('E-2 streaming and a tool call', () => {
  it('shows the tool running and then done, and sends the tool result back to the model', async () => {
    const app = await start('E-2 tool call', {
      turns: [
        { deltas: ['Let me look.'], toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' } }] },
        { deltas: ['The file says: tomato.'] },
      ],
      seed: ({ workDir }) => writeFileSync(join(workDir, 'notes.txt'), 'tomato\n'),
    });
    await app.openWorkspace();
    await app.send('What is in notes.txt?');

    const card = app.window.locator('.tool').first();
    await card.waitFor({ timeout: 30_000 });
    await expect.poll(() => card.getAttribute('data-status'), { timeout: 30_000 }).toBe('done');
    await expect.poll(() => app.transcript().innerText()).toContain('The file says: tomato.');

    // The second request carries the tool's result, so the model really got the file's contents.
    expect(app.mock.requests()).toHaveLength(2);
    const second = app.mock.requests()[1]!.messages;
    expect(second.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('tomato'))).toBe(true);
  });
});
