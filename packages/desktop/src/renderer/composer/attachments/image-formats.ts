/**
 * Picture formats the host does not accept as they are, but the browser can draw (completion
 * spec X-1): BMP, AVIF, ICO and SVG. They are decoded here and re-encoded as PNG / JPEG, so what
 * reaches the host is an ordinary picture and its magic-number check (which does not trust the
 * renderer) needs no change.
 *
 * HEIC / HEIF / TIFF are NOT here: Chromium cannot decode them, so they stay file references and
 * the chip says that the model will only get a path.
 */

export type ForeignImageKind = 'bmp' | 'avif' | 'ico' | 'svg';

/** An SVG is text a person may have written by hand; past this it is not a picture we want to parse. */
export const SVG_MAX_BYTES = 2 * 1024 * 1024;
/** How much of an SVG is read to decide that it is one. */
const SVG_SNIFF_CHARS = 2048;
/** BITMAPCOREHEADER, BITMAPINFOHEADER, V2, V3, V4, V5 header sizes: what follows the 14-byte file header. */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const ascii = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return false;
  const brands = [ascii(bytes, 8, 4)];
  const boxEnd = Math.min(bytes.length, ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0);
  // Compatible brands follow the major brand and the 4-byte minor version.
  for (let at = 16; at + 4 <= Math.min(boxEnd, 64); at += 4) brands.push(ascii(bytes, at, 4));
  return brands.includes('avif') || brands.includes('avis');
}

function isSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, SVG_SNIFF_CHARS)).replace(/^\uFEFF/, '');
  if (!/<svg[\s>]/i.test(head)) return false;
  // A DTD that declares entities is how an XML document pulls in other content: refuse it outright.
  // The WHOLE document is checked, not the sniffed head - padding pushes a declaration out of any window.
  return !/<!ENTITY/i.test(new TextDecoder('utf-8').decode(bytes));
}

/** What the bytes are, among the formats that need converting; `null` for everything else. */
export function sniffForeignImage(bytes: Uint8Array): ForeignImageKind | null {
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d
    && BMP_DIB_SIZES.has(bytes[14]! | (bytes[15]! << 8)) && bytes[16] === 0 && bytes[17] === 0) return 'bmp';
  if (bytes.length >= 22 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0
    && (bytes[4]! | (bytes[5]! << 8)) > 0) return 'ico';
  if (isAvif(bytes)) return 'avif';
  if (isSvg(bytes)) return 'svg';
  return null;
}

const FOREIGN_TYPES = new Set([
  'image/bmp', 'image/x-ms-bmp', 'image/avif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon',
]);
const FOREIGN_EXT = /\.(bmp|avif|svg|ico)$/i;
const PATH_ONLY_EXT = /\.(heic|heif|tiff?)$/i;

/** A first guess from the declared type / extension; the bytes decide in `processImage`. */
export function looksLikeForeignImage(file: { name: string; type: string }): boolean {
  const type = (file.type ?? '').toLowerCase();
  return FOREIGN_TYPES.has(type) || (type === '' && FOREIGN_EXT.test(file.name ?? ''));
}

/** Formats the browser cannot decode: attached by path, so the model reads no pixels. */
export function isPathOnlyImageFormat(name: string): boolean {
  return PATH_ONLY_EXT.test(name);
}
