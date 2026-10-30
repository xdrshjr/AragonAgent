import { describe, expect, it, vi } from 'vitest';
import { ImageError, processImage, type ImageDeps } from '../image-pipeline.js';
import {
  SVG_MAX_BYTES, isPathOnlyImageFormat, looksLikeForeignImage, sniffForeignImage,
} from '../image-formats.js';
import { looksLikeImage } from '../ingest.js';

/** `Uint8Array<ArrayBuffer>` (not the wider `ArrayBufferLike`), so it is a valid `BlobPart`. */
const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;

/** `BM`, file size, reserved, offset, then a BITMAPINFOHEADER (size 40). */
const BMP = (() => {
  const bytes = new Uint8Array(54);
  bytes[0] = 0x42; bytes[1] = 0x4d; bytes[10] = 54; bytes[14] = 40;
  return bytes;
})();
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0]);
const AVIF = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x61, 0x76, 0x69, 0x66]);
const HEIC = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);

describe('sniffForeignImage', () => {
  it.each([
    ['a BMP', BMP, 'bmp'],
    ['an ICO', ICO, 'ico'],
    ['an AVIF (major brand avif)', AVIF, 'avif'],
    ['an SVG', text('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'), 'svg'],
    ['an SVG after an XML declaration and a BOM', text('\uFEFF<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'), 'svg'],
  ] as const)('recognises %s', (_name, bytes, kind) => {
    expect(sniffForeignImage(bytes)).toBe(kind);
  });

  it('does not take a HEIC for an AVIF (both are ISO-BMFF boxes with the same layout)', () => {
    expect(sniffForeignImage(HEIC)).toBeNull();
  });

  it('refuses an SVG that declares entities (the XML way to pull in other content)', () => {
    const hostile = text('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>');
    expect(sniffForeignImage(hostile)).toBeNull();
  });

  it('is not fooled by a name: plain text, a short buffer and an unknown header are nothing', () => {
    expect(sniffForeignImage(text('hello <b>world</b>'))).toBeNull();
    expect(sniffForeignImage(Uint8Array.from([0x42, 0x4d, 1]))).toBeNull();
    expect(sniffForeignImage(new Uint8Array(0))).toBeNull();
    const badBmp = Uint8Array.from(BMP); badBmp[14] = 7; // not a DIB header size
    expect(sniffForeignImage(badBmp)).toBeNull();
  });
});

describe('guessing from a declared type or extension', () => {
  it('treats the converted formats as images, and the path-only ones as files (AC-X4)', () => {
    for (const name of ['a.bmp', 'a.avif', 'a.svg', 'a.ico']) expect(looksLikeImage({ name, type: '' })).toBe(true);
    expect(looksLikeImage({ name: 'x', type: 'image/svg+xml' })).toBe(true);
    expect(looksLikeImage({ name: 'x', type: 'image/vnd.microsoft.icon' })).toBe(true);
    for (const name of ['a.heic', 'a.heif', 'a.tif', 'a.tiff']) expect(looksLikeImage({ name, type: '' })).toBe(false);
    expect(looksLikeForeignImage({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });

  it('knows which formats can only be sent as a path', () => {
    expect(['IMG_1.HEIC', 'a.heif', 'scan.TIFF', 'x.tif'].every(isPathOnlyImageFormat)).toBe(true);
    expect(['a.png', 'a.bmp', 'a.heic.txt'].some(isPathOnlyImageFormat)).toBe(false);
  });
});

function fakeDeps(over: Partial<ImageDeps> = {}) {
  const encodes: Array<{ w: number; h: number; format: string }> = [];
  const deps: ImageDeps = {
    decode: over.decode ?? (async () => ({ width: 200, height: 100, close: vi.fn() })),
    ...(over.decodeSvg ? { decodeSvg: over.decodeSvg } : {}),
    encode: async (_image, w, h, format) => { encodes.push({ w, h, format }); return new Blob([new Uint8Array(500)]); },
    toDataUrl: async () => 'data:image/jpeg;base64,THUMB',
  };
  return { deps, encodes };
}

describe('processImage with a converted format (AC-X1)', () => {
  it.each([['bmp', BMP], ['ico', ICO], ['avif', AVIF]] as const)('re-encodes a %s as PNG even though it is small', async (_kind, bytes) => {
    const { deps, encodes } = fakeDeps();
    const out = await processImage(new Blob([bytes as BlobPart]), deps);
    expect(out.mediaType).toBe('image/png');
    expect(encodes[0]).toMatchObject({ format: 'png', w: 200, h: 100 }); // never a byte-for-byte pass-through
    expect(out.bytes.byteLength).toBe(500);
  });

  it('draws an SVG through decodeSvg, not through decode', async () => {
    const decode = vi.fn(async () => ({ width: 1, height: 1, close: () => undefined }));
    const decodeSvg = vi.fn(async () => ({ width: 64, height: 32, close: () => undefined }));
    const { deps } = fakeDeps({ decode, decodeSvg });
    const out = await processImage(new Blob([text('<svg width="64" height="32"></svg>')]), deps);
    expect(decodeSvg).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
    expect(out).toMatchObject({ mediaType: 'image/png', width: 64, height: 32 });
  });

  it('rejects an SVG over 2 MiB as too_large without parsing it (AC-X3)', async () => {
    const decodeSvg = vi.fn();
    const { deps } = fakeDeps({ decodeSvg: decodeSvg as never });
    const huge = text(`<svg>${' '.repeat(SVG_MAX_BYTES)}</svg>`);
    await expect(processImage(new Blob([huge]), deps)).rejects.toMatchObject({ reason: 'too_large' });
    expect(decodeSvg).not.toHaveBeenCalled();
  });

  it('turns a broken SVG into decode_failed (the chip offers Retry)', async () => {
    const { deps } = fakeDeps({ decodeSvg: async () => { throw new Error('bad svg'); } });
    await expect(processImage(new Blob([text('<svg><</svg>')]), deps)).rejects.toMatchObject({ reason: 'decode_failed' });
  });

  it('fails an SVG cleanly when the engine has no SVG path', async () => {
    const { deps } = fakeDeps();
    await expect(processImage(new Blob([text('<svg/>')]), deps)).rejects.toBeInstanceOf(ImageError);
  });

  it('still refuses what is not a picture at all', async () => {
    const { deps } = fakeDeps();
    await expect(processImage(new Blob([text('just text')]), deps)).rejects.toMatchObject({ reason: 'bad_type' });
    await expect(processImage(new Blob([HEIC as BlobPart]), deps)).rejects.toMatchObject({ reason: 'bad_type' });
  });
});
