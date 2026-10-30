import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '../../../../shared/attachments.js';
import {
  MAX_DECODE_PIXELS,
  MAX_ENCODE_ROUNDS,
  encodeRounds,
  jpegOrientation,
  planImage,
  scaledSize,
  type ImageFacts,
} from '../plan-image.js';

const EDGE = ATTACHMENT_LIMITS.maxImageEdgePx;
const CAP = ATTACHMENT_LIMITS.maxImageBytes;
const facts = (over: Partial<ImageFacts>): ImageFacts => ({
  width: 800, height: 600, bytes: 100_000, type: 'image/png', ...over,
});

describe('planImage boundaries', () => {
  it.each([
    ['exactly the edge limit', { width: EDGE, height: 100 }, 'passthrough'],
    ['one pixel over the edge limit', { width: EDGE + 1, height: 100 }, 'encode'],
    ['tall image at the limit', { width: 100, height: EDGE }, 'passthrough'],
    ['exactly the byte cap', { bytes: CAP }, 'passthrough'],
    ['one byte over the cap', { bytes: CAP + 1 }, 'encode'],
  ] as const)('%s -> %s', (_label, over, action) => {
    expect(planImage(facts(over)).action).toBe(action);
  });

  it('rejects an unreadable size and an absurd pixel count', () => {
    expect(planImage(facts({ width: 0 }))).toEqual({ action: 'reject', reason: 'decode_failed' });
    expect(planImage(facts({ width: MAX_DECODE_PIXELS, height: 2 }))).toEqual({ action: 'reject', reason: 'too_large' });
  });

  it('re-draws a JPEG whose rotation lives in EXIF, because the host strips EXIF', () => {
    expect(planImage(facts({ type: 'image/jpeg', needsOrientationFix: true })).action).toBe('encode');
    expect(planImage(facts({ type: 'image/jpeg' })).action).toBe('passthrough');
  });

  it('keeps only the first frame of an oversized GIF', () => {
    const plan = planImage(facts({ type: 'image/gif', bytes: CAP + 1 }));
    expect(plan).toMatchObject({ action: 'encode', firstFrameOnly: true });
  });
});

describe('encodeRounds', () => {
  it('tries PNG first for a screenshot-like PNG, then falls to JPEG, never more than four rounds', () => {
    const rounds = encodeRounds(facts({ width: 3000, height: 2000, bytes: 1_000_000 }), false);
    expect(rounds).toHaveLength(MAX_ENCODE_ROUNDS);
    expect(rounds[0]).toMatchObject({ format: 'png', edge: EDGE });
    expect(rounds.slice(1).every((round) => round.format === 'jpeg')).toBe(true);
  });

  it('goes straight to JPEG for a photo-like PNG and for any JPEG', () => {
    const photo = encodeRounds(facts({ width: 3000, height: 2000, bytes: 9_000_000 }), false);
    expect(photo[0]).toMatchObject({ format: 'jpeg', quality: 0.9 });
    expect(encodeRounds(facts({ type: 'image/jpeg', width: 4000, height: 3000 }), false)[0]).toMatchObject({ format: 'jpeg' });
  });

  it('lowers quality step by step and shrinks the edge only on the last round', () => {
    const rounds = encodeRounds(facts({ type: 'image/jpeg', width: 4000, height: 3000 }), false);
    expect(rounds.map((round) => round.quality)).toEqual([0.9, 0.8, 0.7, 0.6]);
    expect(rounds.map((round) => round.edge)).toEqual([EDGE, EDGE, EDGE, Math.floor(EDGE * 0.8)]);
  });

  it('never enlarges a small image that only needs a re-draw', () => {
    const rounds = encodeRounds(facts({ type: 'image/jpeg', width: 400, height: 300 }), false);
    expect(rounds[0]!.edge).toBe(400);
  });
});

describe('scaledSize', () => {
  it('scales the long edge down and keeps the ratio', () => {
    expect(scaledSize(3136, 1568, EDGE)).toEqual({ width: EDGE, height: 784 });
    expect(scaledSize(1000, 500, EDGE)).toEqual({ width: 1000, height: 500 });
  });
});

describe('jpegOrientation', () => {
  /** SOI, APP1 "Exif\0\0", big-endian TIFF with one IFD entry: tag 0x0112 = `value`. */
  const exif = (value: number): Uint8Array => Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, 0x1e,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, value, 0x00, 0x00,
    0xff, 0xd9,
  ]);

  it('reads the orientation tag', () => {
    expect(jpegOrientation(exif(6))).toBe(6);
    expect(jpegOrientation(exif(1))).toBe(1);
  });

  it('answers 1 for anything it cannot parse', () => {
    expect(jpegOrientation(Uint8Array.from([0x89, 0x50]))).toBe(1);
    expect(jpegOrientation(Uint8Array.from([0xff, 0xd8, 0xff, 0xda]))).toBe(1);
    expect(jpegOrientation(exif(9))).toBe(1);
  });
});
