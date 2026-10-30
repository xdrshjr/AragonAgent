/**
 * Completion round, through a real window against the scripted model: undo of a removal, the SVG
 * safety property, the model-refuses-images recovery and tool-run grouping. Same model mock as
 * `attachments.e2e.ts`.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { start } from './fixtures/harness.js';
import { makePngBase64 } from './fixtures/png.js';
import type { Launched } from './fixtures/launch.js';

const PNG_BASE64 = makePngBase64(64, 48);

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

/** Drop one file onto the composer the way the OS does: a DragEvent whose dataTransfer holds it. */
async function dropFile(app: Launched, content: string, fileName: string, type: string): Promise<void> {
  await app.window.evaluate(({ text, name, mime }) => {
    const data = new DataTransfer();
    data.items.add(new File([text], name, { type: mime }));
    const target = document.querySelector('.composer') as HTMLElement;
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, { text: content, name: fileName, mime: type });
}

type Part = { type?: string; text?: string; image_url?: { url?: string } };
const parts = (content: unknown): Part[] => (Array.isArray(content) ? content as Part[] : []);

describe('E-B1 paste, remove, undo, send', () => {
  it('brings the same picture back and sends exactly the bytes that were pasted', async () => {
    const app = await start('E-B1 undo', { turns: [{ deltas: ['I see it.'] }] });
    await app.openWorkspace();
    await pasteImage(app);
    const chip = app.window.locator('.att-chip').first();
    await expect.poll(() => chip.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready');

    await app.window.getByRole('button', { name: /^Remove / }).click();
    await expect.poll(() => app.window.locator('.att-chip').count()).toBe(0);
    await app.window.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => app.window.locator('.att-chip[data-status="ready"]').count(), { timeout: 10_000 }).toBe(1);

    await app.send('what is in @image1?');
    await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('I see it.');
    const user = app.mock.requests()[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
    const image = parts(user.content).find((part) => part.type === 'image_url');
    // A picture this small is passed through untouched, so the bytes must match the original exactly.
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it('shows the processed picture in the preview, from a data: URL', async () => {
    const app = await start('E-B1 preview', { turns: [] });
    await app.openWorkspace();
    await pasteImage(app);
    await app.window.locator('.att-chip[data-status="ready"]').first().waitFor({ timeout: 30_000 });
    await app.window.getByRole('button', { name: /^Preview / }).click();
    const image = app.window.locator('.lightbox-img');
    await image.waitFor({ timeout: 10_000 });
    expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // The picture really decoded (a blocked / blank load would leave naturalWidth at 0).
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(64);
    await app.window.keyboard.press('Escape');
    await expect.poll(() => app.window.getByRole('dialog').count()).toBe(0);
  }, 90_000);
});

describe('E-B2 an SVG with a script and an outside reference', () => {
  it('is drawn as a picture without running the script or fetching anything', async () => {
    const hits: string[] = [];
    const probe: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.statusCode = 200; res.end(); });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="60">
      <script>window.__pwned = true; fetch('http://127.0.0.1:${port}/script');</script>
      <image href="http://127.0.0.1:${port}/image.png" width="80" height="60"/>
      <rect width="80" height="60" fill="tomato"/></svg>`;
    try {
      const app = await start('E-B2 svg', { turns: [{ deltas: ['A red box.'] }] });
      await app.openWorkspace();
      await dropFile(app, svg, 'evil.svg', 'image/svg+xml');
      const chip = app.window.locator('.att-chip').first();
      await expect.poll(() => chip.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready');
      expect(await chip.getAttribute('data-kind')).toBe('image');

      await app.send('what is this?');
      await expect.poll(() => app.transcript().innerText(), { timeout: 30_000 }).toContain('A red box.');
      const user = app.mock.requests()[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
      expect(parts(user.content).find((part) => part.type === 'image_url')?.image_url?.url).toMatch(/^data:image\/(png|jpeg);base64,/);

      expect(await app.window.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }, 120_000);

  it('turns a BMP into a normal picture chip', async () => {
    const app = await start('E-B2 bmp', { turns: [] });
    await app.openWorkspace();
    // 2x2, 24-bit BMP (header 14 + DIB 40 + 2 rows of 8 bytes).
    const header = Buffer.alloc(54);
    header.write('BM'); header.writeUInt32LE(54 + 16, 2); header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14); header.writeInt32LE(2, 18); header.writeInt32LE(2, 22);
    header.writeUInt16LE(1, 26); header.writeUInt16LE(24, 28); header.writeUInt32LE(16, 34);
    const pixels = Buffer.alloc(16, 0x80);
    const base64 = Buffer.concat([header, pixels]).toString('base64');
    await app.window.evaluate(({ data }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'tiny.bmp', { type: 'image/bmp' }));
      (document.querySelector('.composer') as HTMLElement)
        .dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { data: base64 });
    const chip = app.window.locator('.att-chip').first();
    await expect.poll(() => chip.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready');
    expect(await chip.getAttribute('data-kind')).toBe('image');
  }, 90_000);
});

describe('a file the browser cannot decode', () => {
  it('stays a path reference and says so on the chip', async () => {
    const app = await start('E-B2 heic', {
      turns: [],
      seed: ({ workDir }) => writeFileSync(join(workDir, 'IMG_0001.heic'), 'not really a heic'),
    });
    await app.openWorkspace();
    await app.window.getByTestId('attachment-picker').setInputFiles(join(app.workDir, 'IMG_0001.heic'));
    const chip = app.window.locator('.att-chip').first();
    await expect.poll(() => chip.getAttribute('data-status'), { timeout: 30_000 }).toBe('ready');
    expect(await chip.getAttribute('data-kind')).toBe('file');
    expect(await chip.innerText()).toContain('path only');
  });
});

describe('E-B3 the model refuses the picture', () => {
  it('records that, resends as a path, and the next request carries no image', async () => {
    const app = await start('E-B3 refused', {
      turns: [
        { fail: { status: 400, message: 'Invalid request: image input is not supported by this model' } },
        { deltas: ['Got the path.'] },
      ],
    });
    await app.openWorkspace();
    await pasteImage(app);
    await app.window.locator('.att-chip[data-status="ready"]').first().waitFor({ timeout: 30_000 });
    // An unknown model defaults to sending the picture; the user accepts that.
    await app.send('what is this?');

    const recover = app.window.getByRole('button', { name: /This model cannot see images/ });
    await recover.waitFor({ timeout: 60_000 });
    expect(await app.window.getByText(/adds a new message to the conversation/).count()).toBeGreaterThan(0);
    await recover.click();

    await expect.poll(() => app.transcript().innerText(), { timeout: 60_000 }).toContain('Got the path.');
    const requests = app.mock.requests();
    expect(requests).toHaveLength(2);
    const first = requests[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(first.content)).toContain('image_url');
    const second = requests[1]!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(JSON.stringify(second.content)).not.toContain('image_url');
    expect(JSON.stringify(second.content)).toContain('Attached files:');

    // The decision was written down, and the toast offers to take it back.
    await app.window.getByText(/as not reading images/).waitFor({ timeout: 10_000 });
    const saved = JSON.parse(readFileSync(app.statePath(), 'utf8')) as { imageInputOverrides?: Record<string, string> };
    expect(saved.imageInputOverrides).toEqual({ 'openai/mock-1': 'off' });
  }, 120_000);
});

describe('E-B4 a run of reads folds into one line', () => {
  it('folds the reads, keeps the failed call as a card, opens in place and obeys developer mode', async () => {
    const reads = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    const app = await start('E-B4 groups', {
      turns: [
        {
          deltas: ['Looking around.'],
          toolCalls: [...reads.map((name) => ({ name: 'read_file', args: { path: name } })), { name: 'read_file', args: { path: 'missing.txt' } }],
        },
        { deltas: ['All read.'] },
      ],
      seed: ({ workDir }) => { for (const name of reads) writeFileSync(join(workDir, name), `${name}
`); },
    });
    await app.openWorkspace();
    await app.send('look at everything');
    await expect.poll(() => app.transcript().innerText(), { timeout: 60_000 }).toContain('All read.');

    const head = app.window.locator('.tool-group-head');
    await expect.poll(() => head.count()).toBe(1);
    expect(await head.innerText()).toContain('Looked at 4 files');
    // The failed call is its own card, not swallowed by the summary.
    await expect.poll(() => app.window.locator('.tool[data-failed="true"]').count()).toBe(1);
    expect(await app.window.locator('.tool-group-members').count()).toBe(0);

    // Opening the group must not move the line the reader is looking at.
    const before = (await head.boundingBox())!.y;
    await head.click();
    await expect.poll(() => app.window.locator('.tool-group-members .tool').count()).toBe(4);
    const after = (await head.boundingBox())!.y;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
    await head.click();
    await expect.poll(() => app.window.locator('.tool-group-members').count()).toBe(0);

    // Developer mode shows every call and no group.
    await app.window.keyboard.press('Control+Shift+D');
    await expect.poll(() => app.window.locator('.tool-group-head').count()).toBe(0);
    await expect.poll(() => app.window.locator('.tool').count()).toBe(5);
  }, 120_000);
});
