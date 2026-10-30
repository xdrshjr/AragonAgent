/**
 * Deciding what to do with a picked image BEFORE any pixel is touched (spec 3.2).
 *
 * Pure: no Canvas, no DOM, so every boundary is a table-driven test. The Canvas half lives in
 * `image-pipeline.ts` and is injected, which is also what lets jsdom (which has no Canvas) run
 * the rest of the pipeline.
 *
 * The rule of thumb: an image that is already small enough is passed through BYTE FOR BYTE
 * (lossless, no re-encode); only an image that is too big, an animated GIF over the limit, or a
 * JPEG whose EXIF orientation the host's metadata stripping would otherwise destroy is re-drawn.
 */

import { ATTACHMENT_LIMITS, type ImageMediaType } from '../../../shared/attachments.js';

/** Above this many pixels decoding alone could exhaust memory; refuse it outright. */
export const MAX_DECODE_PIXELS = 64_000_000;
/** A PNG below this many bytes per pixel is treated as a screenshot / chart (kept PNG). */
const SCREENSHOT_BYTES_PER_PIXEL = 0.5;
/** Total re-encode attempts before giving up (spec: at most 4 rounds). */
export const MAX_ENCODE_ROUNDS = 4;

export interface ImageFacts {
  width: number;
  height: number;
  bytes: number;
  type: ImageMediaType;
  /** EXIF orientation 2..8: the bytes carry a rotation the host would strip, so re-draw. */
  needsOrientationFix?: boolean;
  /**
   * The picture is a converted format (BMP / AVIF / ICO / SVG): always re-drawn, and PNG goes first
   * because such sources often carry transparency or flat colour that a JPEG would smear.
   */
  converted?: boolean;
}

export interface EncodeRound {
  format: 'png' | 'jpeg';
  /** 0..1, JPEG only. */
  quality: number;
  /** Target long edge in pixels. */
  edge: number;
}

export type ImagePlan =
  | { action: 'passthrough' }
  | { action: 'encode'; rounds: EncodeRound[]; firstFrameOnly: boolean }
  | { action: 'reject'; reason: 'too_large' | 'decode_failed' };

const longEdge = (facts: ImageFacts): number => Math.max(facts.width, facts.height);

export function planImage(facts: ImageFacts): ImagePlan {
  const { width, height, bytes } = facts;
  if (!(width > 0) || !(height > 0)) return { action: 'reject', reason: 'decode_failed' };
  if (width * height > MAX_DECODE_PIXELS) return { action: 'reject', reason: 'too_large' };
  const fits = longEdge(facts) <= ATTACHMENT_LIMITS.maxImageEdgePx && bytes <= ATTACHMENT_LIMITS.maxImageBytes;
  if (fits && !facts.needsOrientationFix && !facts.converted) return { action: 'passthrough' };
  // An animated GIF cannot be re-drawn frame by frame: keep the first frame as a PNG.
  const firstFrameOnly = facts.type === 'image/gif';
  return { action: 'encode', rounds: encodeRounds(facts, firstFrameOnly), firstFrameOnly };
}

/** The ladder of attempts, mildest first. The caller stops at the first one that fits the byte cap. */
export function encodeRounds(facts: ImageFacts, firstFrameOnly: boolean): EncodeRound[] {
  const edge = Math.min(longEdge(facts), ATTACHMENT_LIMITS.maxImageEdgePx);
  const pixels = facts.width * facts.height;
  const screenshotLike = facts.converted === true
    || ((facts.type === 'image/png' || firstFrameOnly) && facts.bytes / pixels < SCREENSHOT_BYTES_PER_PIXEL);
  const smaller = Math.max(1, Math.floor(edge * 0.8));
  if (screenshotLike) {
    return [
      { format: 'png', quality: 1, edge },
      { format: 'jpeg', quality: 0.85, edge },
      { format: 'jpeg', quality: 0.7, edge },
      { format: 'jpeg', quality: 0.6, edge: smaller },
    ];
  }
  return [
    { format: 'jpeg', quality: 0.9, edge },
    { format: 'jpeg', quality: 0.8, edge },
    { format: 'jpeg', quality: 0.7, edge },
    { format: 'jpeg', quality: 0.6, edge: smaller },
  ];
}

/** Dimensions after scaling so the long edge is `edge` (never enlarges). */
export function scaledSize(width: number, height: number, edge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const ratio = edge / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/**
 * EXIF orientation (1..8) of a JPEG, or 1 when there is none or the stream is malformed.
 * Only the first APP1 segment is read; that is where Exif lives.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return 1;
    if (marker === 0xe1 && isExif(bytes, offset + 4)) return readOrientation(bytes, offset + 10, offset + 2 + length);
    offset += 2 + length;
  }
  return 1;
}

function isExif(bytes: Uint8Array, at: number): boolean {
  return bytes[at] === 0x45 && bytes[at + 1] === 0x78 && bytes[at + 2] === 0x69 && bytes[at + 3] === 0x66
    && bytes[at + 4] === 0 && bytes[at + 5] === 0;
}

function readOrientation(bytes: Uint8Array, tiff: number, end: number): number {
  const little = bytes[tiff] === 0x49;
  if (!little && bytes[tiff] !== 0x4d) return 1;
  const u16 = (at: number): number => (little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!);
  const u32 = (at: number): number => (little
    ? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
    : ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
