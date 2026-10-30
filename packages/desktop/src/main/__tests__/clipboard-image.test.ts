import { describe, expect, it } from 'vitest';
import {
  CLIPBOARD_MAX_PIXELS, CLIPBOARD_MAX_PNG_BYTES, CLIPBOARD_THROTTLE_MS, createClipboardImageReader,
  type ClipboardEntry, type ClipboardImageSource,
} from '../clipboard-image.js';

const entry = (types: string[], bytes: Uint8Array = Uint8Array.from([1, 2, 3])): ClipboardEntry => ({
  types,
  getType: async () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }),
});
const image = (over: Partial<{ empty: boolean; width: number; height: number; png: Uint8Array }> = {}): ClipboardImageSource => ({
  isEmpty: () => over.empty ?? false,
  getSize: () => ({ width: over.width ?? 10, height: over.height ?? 5 }),
  toPNG: () => over.png ?? Uint8Array.from([9, 9]),
});

let clock = 1_000;
const reader = (entries: ClipboardEntry[] | (() => Promise<ClipboardEntry[]>), decoded: ClipboardImageSource = image()) =>
  createClipboardImageReader(
    { read: typeof entries === 'function' ? entries : async () => entries },
    () => decoded,
    () => clock,
  );
const later = (): void => { clock += CLIPBOARD_THROTTLE_MS + 1; };

describe('native:read-clipboard-image (AC-P4)', () => {
  it('answers null for an empty clipboard and for one with only text', async () => {
    expect(await reader([]).read()).toEqual({ ok: true, value: null });
    later();
    expect(await reader([entry(['text/plain'])]).read()).toEqual({ ok: true, value: null });
  });

  it('answers null when the bytes do not decode to a picture', async () => {
    later();
    expect(await reader([entry(['image/png'])], image({ empty: true })).read()).toEqual({ ok: true, value: null });
  });

  it('returns a PNG as-is with the dimensions the decoder reported', async () => {
    later();
    const outcome = await reader([entry(['image/png'], Uint8Array.from([7, 7, 7]))], image({ width: 640, height: 480 })).read();
    expect(outcome.ok && outcome.value && { w: outcome.value.width, h: outcome.value.height, b: [...new Uint8Array(outcome.value.bytes)] })
      .toEqual({ w: 640, h: 480, b: [7, 7, 7] });
  });

  it('re-encodes a non-PNG source (a DIB turned into image/bmp, say) as PNG', async () => {
    later();
    const outcome = await reader([entry(['image/bmp'])], image({ png: Uint8Array.from([5, 6]) })).read();
    expect(outcome.ok && outcome.value && [...new Uint8Array(outcome.value.bytes)]).toEqual([5, 6]);
  });

  it('prefers image/png over another image type', async () => {
    later();
    const outcome = await reader([entry(['image/bmp'], Uint8Array.from([1])), entry(['image/png'], Uint8Array.from([2]))]).read();
    expect(outcome.ok && outcome.value && [...new Uint8Array(outcome.value.bytes)]).toEqual([2]);
  });

  it('refuses a picture over 64 megapixels with too_large', async () => {
    later();
    const side = Math.ceil(Math.sqrt(CLIPBOARD_MAX_PIXELS)) + 1;
    expect(await reader([entry(['image/png'])], image({ width: side, height: side })).read())
      .toMatchObject({ ok: false, code: 'too_large' });
  });

  it('refuses a PNG over 25 MiB before decoding it', async () => {
    later();
    let decoded = false;
    const big = new Uint8Array(CLIPBOARD_MAX_PNG_BYTES + 1);
    const guarded = createClipboardImageReader(
      { read: async () => [entry(['image/png'], big)] },
      () => { decoded = true; return image(); },
      () => clock,
    );
    expect(await guarded.read()).toMatchObject({ ok: false, code: 'too_large' });
    expect(decoded).toBe(false);
  });

  it('reports unavailable instead of throwing when the clipboard cannot be read', async () => {
    later();
    const broken = reader(async () => { throw new Error('no display'); });
    expect(await broken.read()).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('throttles: a second read within 250 ms gets null without touching the clipboard', async () => {
    later();
    let reads = 0;
    const counted = reader(async () => { reads += 1; return [entry(['image/png'])]; });
    expect((await counted.read()).ok).toBe(true);
    expect(await counted.read()).toEqual({ ok: true, value: null });
    expect(reads).toBe(1);
    later();
    await counted.read();
    expect(reads).toBe(2);
  });
});
