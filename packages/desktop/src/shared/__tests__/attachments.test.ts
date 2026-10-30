import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_LIMITS,
  estimateImageTokens,
  extensionFor,
  findAttachmentMentions,
  formatBytes,
  imageLabel,
  sanitizeAttachmentName,
  sniffImageType,
  stripJpegMetadata,
  stripPngAncillary,
} from '../attachments.js';
import { buildCsp } from '../csp.js';

const hex = (text: string): Uint8Array => Uint8Array.from(text.trim().split(/\s+/).map((b) => parseInt(b, 16)));

describe('sniffImageType', () => {
  it('reads the magic bytes, never an extension', () => {
    expect(sniffImageType(hex('89 50 4E 47 0D 0A 1A 0A 00'))).toBe('image/png');
    expect(sniffImageType(hex('FF D8 FF E0 00 10'))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a....'))).toBe('image/gif');
    expect(sniffImageType(new TextEncoder().encode('GIF87a....'))).toBe('image/gif');
    expect(sniffImageType(hex('52 49 46 46 00 00 00 00 57 45 42 50'))).toBe('image/webp');
  });

  it('rejects truncated, disguised and non-image bytes', () => {
    expect(sniffImageType(hex('89 50 4E'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(sniffImageType(hex('52 49 46 46 00 00 00 00 57 41 56 45'))).toBeNull(); // RIFF WAVE
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  it('maps a sniffed type to a staging extension', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg');
    expect(extensionFor(null)).toBe('bin');
  });
});

describe('stripJpegMetadata', () => {
  // SOI, APP0 (JFIF), APP1 (Exif with GPS-ish payload), APP2 (ICC), APP13 (IPTC), SOS + data, EOI
  const app0 = 'FF E0 00 04 AA BB';
  const app1 = 'FF E1 00 06 45 78 69 66';
  const app2 = 'FF E2 00 05 49 43 43';
  const app13 = 'FF ED 00 04 11 22';
  const scan = 'FF DA 00 02 12 34 FF D9';
  const jpeg = hex(`FF D8 ${app0} ${app1} ${app2} ${app13} ${scan}`);

  it('drops Exif/XMP (APP1) and IPTC (APP13) and keeps colour-bearing segments', () => {
    const out = stripJpegMetadata(jpeg);
    expect(Array.from(out)).toEqual(Array.from(hex(`FF D8 ${app0} ${app2} ${scan}`)));
  });

  it('returns a malformed stream unchanged rather than half-edited', () => {
    const broken = hex('FF D8 FF E1 FF FF 00');
    expect(stripJpegMetadata(broken)).toBe(broken);
    const notJpeg = hex('00 01 02');
    expect(stripJpegMetadata(notJpeg)).toBe(notJpeg);
  });
});

describe('stripPngAncillary', () => {
  const chunk = (type: string, body: number[] = []): number[] => {
    const len = body.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
      ...Array.from(type).map((c) => c.charCodeAt(0)), ...body, 0, 0, 0, 0];
  };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = Uint8Array.from([
    ...sig, ...chunk('IHDR', new Array(13).fill(1)), ...chunk('tEXt', [65, 0, 66]), ...chunk('eXIf', [1, 2]),
    ...chunk('iCCP', [9]), ...chunk('tIME', [1, 2, 3, 4, 5, 6, 7]), ...chunk('IDAT', [7]), ...chunk('IEND'),
  ]);

  it('removes text, time and EXIF chunks and keeps colour and image chunks', () => {
    const out = stripPngAncillary(png);
    const text = Buffer.from(out).toString('latin1');
    expect(text).not.toContain('tEXt');
    expect(text).not.toContain('eXIf');
    expect(text).not.toContain('tIME');
    expect(text).toContain('IHDR');
    expect(text).toContain('iCCP');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
    expect(sniffImageType(out)).toBe('image/png');
  });

  it('leaves a truncated stream alone', () => {
    const cut = png.subarray(0, 30);
    expect(stripPngAncillary(cut)).toBe(cut);
  });
});

describe('sanitizeAttachmentName', () => {
  it('removes separators, controls and bidi overrides', () => {
    expect(sanitizeAttachmentName('a/b\\c.png')).toBe('a b c.png');
    expect(sanitizeAttachmentName('gp‮ng.exe')).toBe('gp ng.exe');
    expect(sanitizeAttachmentName('x\u0000\u0007y')).toBe('x y');
  });

  it('keeps the extension when truncating by code point', () => {
    const name = sanitizeAttachmentName(`${'a'.repeat(200)}.png`, 20);
    expect(Array.from(name).length).toBeLessThanOrEqual(20);
    expect(name.endsWith('.png')).toBe(true);
    const emoji = sanitizeAttachmentName('\u{1F600}'.repeat(50), 10);
    expect(Array.from(emoji).length).toBeLessThanOrEqual(10);
  });

  it('never returns an empty name', () => {
    expect(sanitizeAttachmentName('   ')).toBe('attachment');
    expect(sanitizeAttachmentName('‮')).toBe('attachment');
  });
});

describe('small helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('');
  });

  it('estimates image tokens against the host cap', () => {
    expect(estimateImageTokens(1568, 882, 1600)).toBe(1600);
    expect(estimateImageTokens(100, 100, 1600)).toBe(14);
    expect(estimateImageTokens(0, 0, 1600)).toBe(1600);
  });

  it('finds @image mentions only at word starts', () => {
    expect(findAttachmentMentions('see @image1 and @file2, not me@image3 or @images')).toEqual(['image1', 'file2']);
    expect(findAttachmentMentions('@image10 @folder3')).toEqual(['image10', 'folder3']);
  });

  it('builds the ASCII label the model reads', () => {
    expect(imageLabel('image1', 'shot.png', 1568, 882)).toBe('[image1: shot.png, 1568x882]');
    expect(imageLabel('image2', 'x.png')).toBe('[image2: x.png]');
  });

  it('keeps the renderer CSP from loosening for previews (data: yes, blob: no)', () => {
    const img = buildCsp(null).split(';').map((s) => s.trim()).find((s) => s.startsWith('img-src'));
    expect(img).toBe("img-src 'self' data: aragon-asset:");
  });

  it('keeps the limits internally consistent', () => {
    expect(ATTACHMENT_LIMITS.maxImageBytes * 4).toBeGreaterThanOrEqual(ATTACHMENT_LIMITS.maxImageBytesPerMessage);
    expect(ATTACHMENT_LIMITS.maxImagesPerMessage).toBeLessThanOrEqual(ATTACHMENT_LIMITS.maxAttachmentsPerMessage);
  });
});
