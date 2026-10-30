/**
 * `native:read-clipboard-image`: the picture on the OS clipboard, for the cases where the page's
 * own `paste` event carries no `File` (a screenshot tool or chat app that puts only a DIB or a
 * private format on the clipboard). Electron's clipboard module reads those.
 *
 * Deliberately narrow, because the clipboard is the most private surface a window can touch:
 *   - it returns an IMAGE only - never text, never a file list;
 *   - nothing is cached, saved or logged, and there is no polling: the caller is a paste or a menu
 *     click, and a 250 ms throttle keeps even a runaway caller from sampling the clipboard;
 *   - an empty clipboard answers `null` and the renderer says nothing.
 * Free of Electron imports (the clipboard is injected) so the limits are plain unit tests.
 */

import type { ClipboardImageResult } from '../shared/ipc-contract.js';

/** Above this many pixels even decoding the PNG back in the renderer could exhaust memory. */
export const CLIPBOARD_MAX_PIXELS = 64_000_000;
/** Matches the host's ceiling for one staged picture. */
export const CLIPBOARD_MAX_PNG_BYTES = 25 * 1024 * 1024;
export const CLIPBOARD_THROTTLE_MS = 250;

export interface ClipboardImageSource {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Uint8Array;
}

/** The shape of Electron's (W3C-style, async) `clipboard.read()` entries. */
export interface ClipboardEntry {
  readonly types: readonly string[];
  getType(type: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface ClipboardLike {
  read(): Promise<readonly ClipboardEntry[]>;
}

export type ClipboardImageOutcome =
  | { ok: true; value: ClipboardImageResult | null }
  | { ok: false; code: 'too_large' | 'unavailable'; message: string };

export interface ClipboardImageReader {
  read(): Promise<ClipboardImageOutcome>;
}

const TOO_LARGE: ClipboardImageOutcome = {
  ok: false, code: 'too_large', message: 'The picture on the clipboard is too large.',
};

/** `image/png` first (lossless, what screenshot tools put there), then any other `image/*`. */
function pickImageType(entries: readonly ClipboardEntry[]): { entry: ClipboardEntry; type: string } | null {
  for (const wanted of ['image/png', null] as const) {
    for (const entry of entries) {
      const type = wanted ? entry.types.find((candidate) => candidate === wanted) : entry.types.find((candidate) => candidate.startsWith('image/'));
      if (type) return { entry, type };
    }
  }
  return null;
}

/**
 * Electron 45's `clipboard` has no `readImage()` any more (the module is now the async W3C-style
 * `read()`); `decode` is `nativeImage.createFromBuffer`, used only to learn the dimensions and to
 * normalise a non-PNG source to PNG.
 */
export function createClipboardImageReader(
  clipboard: ClipboardLike,
  decode: (bytes: Uint8Array) => ClipboardImageSource,
  now: () => number = Date.now,
): ClipboardImageReader {
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    async read() {
      const at = now();
      if (at - lastAt < CLIPBOARD_THROTTLE_MS) return { ok: true, value: null };
      lastAt = at;
      try {
        const picked = pickImageType(await clipboard.read());
        if (!picked) return { ok: true, value: null };
        const raw = new Uint8Array(await (await picked.entry.getType(picked.type)).arrayBuffer());
        // Refuse by size BEFORE decoding: a decoder given a hostile 4 GB blob is the problem.
        if (raw.byteLength > CLIPBOARD_MAX_PNG_BYTES) return TOO_LARGE;
        const image = decode(raw);
        if (image.isEmpty()) return { ok: true, value: null };
        const { width, height } = image.getSize();
        if (width * height > CLIPBOARD_MAX_PIXELS) return TOO_LARGE;
        const png = picked.type === 'image/png' ? raw : image.toPNG();
        if (png.byteLength > CLIPBOARD_MAX_PNG_BYTES) return TOO_LARGE;
        // A fresh ArrayBuffer of exactly these bytes: a Buffer's backing store may be a shared pool.
        return { ok: true, value: { bytes: new Uint8Array(png).buffer, width, height } };
      } catch {
        // No display / clipboard service (a headless session, a locked-down desktop).
        return { ok: false, code: 'unavailable', message: 'The clipboard could not be read.' };
      }
    },
  };
}
