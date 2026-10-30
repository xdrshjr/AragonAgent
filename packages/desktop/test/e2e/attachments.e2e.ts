/**
 * Attachments and tool voice through a real window against the scripted model
 * (desktop-attachments-and-tool-voice §7.3). The model mock is an OpenAI-compatible endpoint, so an
 * inline picture arrives as an `image_url` content part and a path-mode picture as text only.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from './fixtures/harness.js';
import { makePngBase64 } from './fixtures/png.js';
import type { Launched } from './fixtures/launch.js';

/** A real, decodable PNG (the renderer decodes it with createImageBitmap, which rejects a bad CRC). */
const PNG_BASE64 = makePngBase64();

/** Paste a screenshot the way the OS does: a ClipboardEvent whose clipboardData holds one image file. */
async function pasteImage(app: Launched, name = 'shot.png'): Promise<void> {
  await app.composer().focus();
  await app.window.evaluate(async ({ base64, fileName }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], fileName, { type: 'image/png' }));
    const target = document.activeElement as HTMLElement;
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { base64: PNG_BASE64, fileName: name });
}

const contentParts = (content: unknown): Array<{ type?: string; text?: string; image_url?: { url?: string } }> =>
  Array.isArray(content) ? content as Array<{ type?: string; text?: string; image_url?: { url?: string } }> : [];

describe('E-A1 paste, send, see the thumbnail', () => {
  it('sends the picture inline to a model of unknown capability, with a label the user can @-reference', async () => {
    const app = await start('E-A1 paste image', { turns: [{ deltas: ['I can see it.'] }] });
    await app.openWorkspace();
    await pasteImage(app);
    const chip = app.window.locator('.att-chip').first();
    await chip.waitFor({ timeout: 30_000 });
    await expect.poll(() => chip.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready');

    await app.send('what is in @image1?');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('I can see it.');

    const requests = app.mock.requests();
    expect(requests).toHaveLength(1);
    const user = requests[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
    const parts = contentParts(user.content);
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    expect(text).toContain('what is in @image1?');
    expect(text).toMatch(/\[image1: [^\]]+, \d+x\d+\]/);
    const image = parts.find((p) => p.type === 'image_url');
    expect(image?.image_url?.url).toMatch(/^data:image\/(png|jpeg);base64,/);
    // The bubble shows what the user typed, with the picture as a thumbnail strip.
    await expect.poll(() => app.window.locator('.att-strip').count()).toBeGreaterThan(0);
    expect(await app.transcript().innerText()).not.toContain('Attached files:');
  });
});

describe('E-A2 a model known not to read images', () => {
  it('shows the warning before sending and delivers the picture as a file path only', async () => {
    const app = await start('E-A2 non-vision model', {
      turns: [{ deltas: ['Noted.'] }],
      state: { imageInputOverrides: { 'openai/mock-1': 'off' } },
    });
    await app.openWorkspace();
    await pasteImage(app);
    await app.window.locator('.att-chip[data-status="ready"]').first().waitFor({ timeout: 30_000 });
    await app.window.getByRole('alert').filter({ hasText: /image/i }).first().waitFor({ timeout: 10_000 });

    await app.send('look at this');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Noted.');

    const user = app.mock.requests()[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(user.content)).not.toContain('image_url');
    expect(JSON.stringify(user.content)).toContain('Attached files:');
    expect(JSON.stringify(user.content)).toMatch(/image1: .*attachments/);
  });
});

describe('E-A3 a file attached by path', () => {
  it('lists the absolute path for the model without copying the file', async () => {
    const app = await start('E-A3 file by path', {
      turns: [{ deltas: ['ok'] }],
      seed: ({ workDir }) => writeFileSync(join(workDir, 'run.log'), 'boom\n'),
    });
    await app.openWorkspace();
    // The file chooser path: the hidden input is the single door for "Add images and files".
    const picker = app.window.getByTestId('attachment-picker');
    await picker.setInputFiles(join(app.workDir, 'run.log'));
    await app.window.locator('.att-chip[data-status="ready"]').first().waitFor({ timeout: 30_000 });
    await app.send('why did it fail?');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('ok');
    const user = app.mock.requests()[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(user.content)).toContain('Attached files:');
    expect(JSON.stringify(user.content)).toContain('run.log');
  });
});

describe('E-A4 tool voice and developer mode', () => {
  it('speaks plainly by default and shows raw names after the hidden hotkey', async () => {
    const app = await start('E-A4 tool voice', {
      turns: [
        { deltas: ['Looking.'], toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' } }] },
        { deltas: ['Done.'] },
      ],
      seed: ({ workDir }) => writeFileSync(join(workDir, 'notes.txt'), 'tomato\n'),
    });
    await app.openWorkspace();
    await app.send('read it');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('Done.');
    const card = app.window.locator('.tool').first();
    expect(await card.innerText()).not.toContain('read_file');
    expect((await card.getAttribute('aria-label')) ?? '').not.toContain('read_file');

    await app.window.keyboard.press('Control+Shift+D');
    await expect.poll(async () => (await app.window.locator('.tool').first().innerText()).length).toBeGreaterThan(0);
    await expect.poll(async () => app.window.locator('.dev-chip').count()).toBeGreaterThan(0);
  });
});
