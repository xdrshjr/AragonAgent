import { describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_LIMITS } from '../../../../shared/attachments.js';
import { ImageError, processImage, runLimited, type ImageDeps } from '../image-pipeline.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
const file = (bytes: Uint8Array = PNG): Blob => new Blob([bytes as BlobPart], { type: 'image/png' });
const blobOf = (size: number): Blob => new Blob([new Uint8Array(size)]);

function deps(over: Partial<ImageDeps> & { size?: [number, number] } = {}): ImageDeps & { encodes: Array<[number, number, string, number]> } {
  const encodes: Array<[number, number, string, number]> = [];
  const [width, height] = over.size ?? [100, 50];
  return {
    encodes,
    decode: over.decode ?? (async () => ({ width, height, close: vi.fn() })),
    encode: over.encode ?? (async (_image, w, h, format, quality) => {
      encodes.push([w, h, format, quality]);
      return blobOf(format === 'jpeg' && quality === 0.7 && w === 1568 ? 1000 : 500); // the thumbnail ladder shares this
    }),
    toDataUrl: over.toDataUrl ?? (async () => 'data:image/jpeg;base64,THUMB'),
  };
}

describe('processImage', () => {
  it('passes a small picture through byte for byte and adds a thumbnail', async () => {
    const d = deps();
    const out = await processImage(file(), d);
    expect(new Uint8Array(out.bytes)).toEqual(PNG);
    expect(out).toMatchObject({ mediaType: 'image/png', width: 100, height: 50, thumb: 'data:image/jpeg;base64,THUMB', firstFrameOnly: false });
    expect(d.encodes).toEqual([[100, 50, 'jpeg', 0.7]]); // only the thumbnail was drawn
  });

  it('shrinks a large picture to the edge limit and sends the re-encoded bytes', async () => {
    const d = deps({ size: [3136, 1568] });
    const out = await processImage(file(), d);
    // the first full-size draw is the largest encode; later ones are the thumbnail
    expect(d.encodes[0]).toEqual([ATTACHMENT_LIMITS.maxImageEdgePx, 784, 'png', 1]);
    expect(out).toMatchObject({ width: ATTACHMENT_LIMITS.maxImageEdgePx, height: 784, mediaType: 'image/png' });
  });

  it('walks down the quality ladder until the result fits the byte cap', async () => {
    const over = new Blob([new Uint8Array(ATTACHMENT_LIMITS.maxImageBytes + 1)]);
    const d = deps({
      size: [4000, 3000],
      encode: async (_image, w, _h, format, quality) => {
        if (w <= ATTACHMENT_LIMITS.thumbEdgePx) return blobOf(10);
        return quality > 0.7 || format === 'png' ? over : blobOf(2000);
      },
    });
    const out = await processImage(file(new Uint8Array([...PNG, ...new Array(10).fill(1)])), d);
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.bytes.byteLength).toBe(2000);
  });

  it('gives up with too_large after the last round', async () => {
    const over = new Blob([new Uint8Array(ATTACHMENT_LIMITS.maxImageBytes + 1)]);
    const d = deps({ size: [4000, 3000], encode: async (_i, w) => (w <= ATTACHMENT_LIMITS.thumbEdgePx ? blobOf(10) : over) });
    await expect(processImage(file(), d)).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('refuses bytes that are not an image, whatever the name says', async () => {
    await expect(processImage(new Blob([new TextEncoder().encode('MZ not an image')]), deps())).rejects.toBeInstanceOf(ImageError);
    await expect(processImage(new Blob([new TextEncoder().encode('MZ not an image')]), deps())).rejects.toMatchObject({ reason: 'bad_type' });
  });

  it('turns a decode failure into decode_failed and closes the bitmap it did get', async () => {
    await expect(processImage(file(), deps({ decode: async () => { throw new Error('corrupt'); } })))
      .rejects.toMatchObject({ reason: 'decode_failed' });
    const close = vi.fn();
    await processImage(file(), deps({ decode: async () => ({ width: 10, height: 10, close }) }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps going without a thumbnail when drawing one fails', async () => {
    const out = await processImage(file(), deps({ encode: async () => { throw new Error('no canvas'); } }));
    expect(out.thumb).toBeUndefined();
    expect(out.bytes.byteLength).toBe(PNG.length);
  });
});

describe('runLimited', () => {
  it('runs at most two jobs at once and finishes them all', async () => {
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const job = (): Promise<void> => runLimited(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
    });
    const all = Promise.all([job(), job(), job(), job()]);
    await Promise.resolve();
    expect(running).toBe(2);
    while (gates.length > 0 || running > 0) {
      gates.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await all;
    expect(peak).toBe(2);
  });
});
