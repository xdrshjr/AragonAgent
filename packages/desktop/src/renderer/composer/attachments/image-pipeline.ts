/**
 * decode -> plan -> resize / re-encode -> thumbnail (spec 3.2).
 *
 * The Canvas work is behind `ImageDeps` so the control flow is testable without a browser
 * engine. Nothing here blocks typing: decode and encode are asynchronous, and at most two
 * images are processed at once (`runLimited`), so dropping eight 4K screenshots queues the rest
 * instead of freezing the window.
 *
 * Bytes stay in memory. The thumbnail is a small `data:` URL, the only form the renderer's CSP
 * lets an `<img>` load (no `blob:`).
 */

import {
  ATTACHMENT_LIMITS,
  sniffImageType,
  type ImageMediaType,
} from '../../../shared/attachments.js';
import { SVG_MAX_BYTES, sniffForeignImage } from './image-formats.js';
import { jpegOrientation, planImage, scaledSize, type EncodeRound } from './plan-image.js';

export type ImageFailure = 'decode_failed' | 'too_large' | 'bad_type';

export class ImageError extends Error {
  constructor(readonly reason: ImageFailure) {
    super(reason);
    this.name = 'ImageError';
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  close(): void;
}

export interface ImageDeps {
  /** Decode with EXIF orientation applied; the dimensions are the displayed ones. */
  decode(blob: Blob): Promise<DecodedImage>;
  /**
   * Draw an SVG on a white background and hand back the raster. Separate from `decode` because
   * `createImageBitmap` does not take SVG reliably; absent in fakes that never see one.
   */
  decodeSvg?(blob: Blob): Promise<DecodedImage>;
  /** Draw `image` at the given size and encode it; `null` when the engine cannot. */
  encode(image: DecodedImage, width: number, height: number, format: 'png' | 'jpeg', quality: number): Promise<Blob | null>;
  toDataUrl(blob: Blob): Promise<string>;
}

export interface ProcessedImage {
  bytes: ArrayBuffer;
  mediaType: ImageMediaType;
  width: number;
  height: number;
  thumb?: string;
  /** An animated GIF was reduced to its first frame. */
  firstFrameOnly: boolean;
}

/** `Blob.arrayBuffer()` with a FileReader fallback (older engines, and jsdom, lack the method). */
export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Decode a format the host does not take; the plan then re-encodes it as PNG / JPEG. */
async function decodeForeign(blob: Blob, original: Uint8Array, kind: 'bmp' | 'avif' | 'ico' | 'svg', deps: ImageDeps): Promise<DecodedImage> {
  if (kind === 'svg') {
    if (original.length > SVG_MAX_BYTES) throw new ImageError('too_large');
    if (!deps.decodeSvg) throw new ImageError('decode_failed');
    return deps.decodeSvg(blob);
  }
  return deps.decode(blob);
}

export async function processImage(blob: Blob, deps: ImageDeps): Promise<ProcessedImage> {
  const original = new Uint8Array(await blobToArrayBuffer(blob));
  const native = sniffImageType(original);
  const foreign = native ? null : sniffForeignImage(original);
  if (!native && !foreign) throw new ImageError('bad_type');
  const type: ImageMediaType = native ?? 'image/png';
  let image: DecodedImage;
  try {
    image = foreign ? await decodeForeign(blob, original, foreign, deps) : await deps.decode(blob);
  } catch (error) {
    throw error instanceof ImageError ? error : new ImageError('decode_failed');
  }
  try {
    const plan = planImage({
      width: image.width, height: image.height, bytes: original.length, type,
      needsOrientationFix: type === 'image/jpeg' && jpegOrientation(original) > 1,
      ...(foreign ? { converted: true } : {}),
    });
    if (plan.action === 'reject') throw new ImageError(plan.reason);
    if (plan.action === 'passthrough') {
      return withThumb({
        bytes: original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer,
        mediaType: type, width: image.width, height: image.height, firstFrameOnly: false,
      }, image, deps);
    }
    const encoded = await encodeWithin(image, plan.rounds, deps);
    return withThumb({ ...encoded, firstFrameOnly: plan.firstFrameOnly }, image, deps);
  } finally {
    image.close();
  }
}

async function encodeWithin(
  image: DecodedImage, rounds: EncodeRound[], deps: ImageDeps,
): Promise<Omit<ProcessedImage, 'firstFrameOnly' | 'thumb'>> {
  for (const round of rounds) {
    const size = scaledSize(image.width, image.height, round.edge);
    const out = await deps.encode(image, size.width, size.height, round.format, round.quality);
    if (!out || out.size === 0) continue;
    if (out.size <= ATTACHMENT_LIMITS.maxImageBytes) {
      return {
        bytes: await blobToArrayBuffer(out),
        mediaType: round.format === 'png' ? 'image/png' : 'image/jpeg',
        width: size.width, height: size.height,
      };
    }
  }
  throw new ImageError('too_large');
}

/** A thumbnail is a nicety: when it cannot be made the chip falls back to an icon. */
async function withThumb(done: Omit<ProcessedImage, 'thumb'>, image: DecodedImage, deps: ImageDeps): Promise<ProcessedImage> {
  const size = scaledSize(image.width, image.height, ATTACHMENT_LIMITS.thumbEdgePx);
  for (const quality of [0.7, 0.55, 0.4]) {
    try {
      const out = await deps.encode(image, size.width, size.height, 'jpeg', quality);
      if (out && out.size > 0 && out.size <= ATTACHMENT_LIMITS.thumbMaxBytes) {
        return { ...done, thumb: await deps.toDataUrl(out) };
      }
    } catch { /* try a lower quality, then give up on the thumbnail */ }
  }
  return done;
}

// ---- the real browser implementation --------------------------------------------------------

export const browserImageDeps: ImageDeps = {
  async decode(blob) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { width: bitmap.width, height: bitmap.height, close: () => bitmap.close(), bitmap } as DecodedImage;
  },
  async encode(image, width, height, format, quality) {
    const bitmap = (image as DecodedImage & { bitmap?: ImageBitmap }).bitmap;
    if (!bitmap) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (format === 'jpeg') {
      // JPEG has no alpha: transparent pixels would turn black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, format === 'png' ? 'image/png' : 'image/jpeg', quality);
    });
  },
  async decodeSvg(blob) {
    // An <img> is the one SVG environment with no script and no outside fetches. The data: URL is
    // what the page CSP allows (blob: is not in img-src); the type is stamped on so the browser
    // does not sniff it as something else.
    const typed = blob.type === 'image/svg+xml' ? blob : new Blob([blob], { type: 'image/svg+xml' });
    const url = await browserImageDeps.toDataUrl(typed);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    const known = natural.width > 0 && natural.height > 0;
    // No intrinsic size (a viewBox only): a square 1024. A tiny icon is scaled UP so it is legible.
    const base = known ? natural : { width: 1024, height: 1024 };
    const longest = Math.max(base.width, base.height);
    const scale = longest < 512 ? 1024 / longest : longest > ATTACHMENT_LIMITS.maxImageEdgePx ? ATTACHMENT_LIMITS.maxImageEdgePx / longest : 1;
    const width = Math.max(1, Math.round(base.width * scale));
    const height = Math.max(1, Math.round(base.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.fillStyle = '#ffffff'; // transparency reads differently on a light and a dark background
    context.fillRect(0, 0, width, height);
    context.drawImage(img, 0, 0, width, height);
    const bitmap = await createImageBitmap(canvas);
    return { width, height, close: () => bitmap.close(), bitmap } as DecodedImage;
  },
  toDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  },
};

/** The Canvas implementation in use. Tests swap it: jsdom has neither `createImageBitmap` nor Canvas. */
let activeDeps: ImageDeps = browserImageDeps;
export const getImageDeps = (): ImageDeps => activeDeps;
export function setImageDeps(deps: ImageDeps | null): void {
  activeDeps = deps ?? browserImageDeps;
}

// ---- bounded concurrency --------------------------------------------------------------------

const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];

/** Run `task` once fewer than two image jobs are in flight. */
export async function runLimited<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}
