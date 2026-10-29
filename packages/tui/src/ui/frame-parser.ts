/** Recognize Ink's erase-lines prefix without accepting arbitrary control writes. */
export function matchInkErasePrefix(chunk: string): { prefix: string; erased: number } | null {
  const match = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/.exec(chunk);
  return match ? { prefix: match[0], erased: match[0].split('\x1b[2K').length - 1 } : null;
}

/** Parse complete frames, including Ink's prefixless initial frame. */
export function parseInkFrame(chunk: string): string[] | null {
  const prefix = matchInkErasePrefix(chunk);
  const body = chunk.slice(prefix?.prefix.length ?? 0);
  if (!body.endsWith('\n')) return null;
  // SGR and OSC-8 may decorate text; cursor movement is never frame content.
  const controls = body.replace(/\x1b\[[0-9;:]*m/g, '')
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(controls)) return null;
  return body.slice(0, -1).split('\n');
}
