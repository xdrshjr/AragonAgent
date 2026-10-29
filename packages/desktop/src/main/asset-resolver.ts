/**
 * `aragon-asset://<sessionId>/<relPath>` -> the bytes of ONE image inside the session's working
 * directory, or `null`. This is the only code that reads a file on behalf of a renderer URL, so
 * it fails closed and does not distinguish "missing" from "refused" (404 either way: no probing).
 *
 * The order is deliberate:
 *   1. reject shapes that can never be a plain relative image path (`:` covers NTFS alternate
 *      data streams and drive letters; NUL; absolute paths; non-allow-listed extensions);
 *   2. `realpath` BOTH the root and the target (native, so Windows short names and case are
 *      normalised the same on both sides) and compare PATH SEGMENTS - a junction or symlink that
 *      leaves the root is only visible after resolution, and `startsWith` would accept
 *      `C:/work-evil` as inside `C:/work`;
 *   3. open ONCE and judge the HANDLE (`fstat`: regular file, <= limit), then read from that
 *      handle - the path is never opened a second time, so there is no check/use window.
 */

import { realpath as realpathCallback } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** Content types come from this table, never from sniffing the bytes. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

export interface Asset {
  body: Buffer;
  contentType: string;
}

const nativeRealpath = promisify(realpathCallback.native);

/** True when `child` is strictly inside `parent`; both already resolved. Compares whole segments. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== '..';
}

function plausibleRelativePath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.includes('\0') || relPath.includes(':')) return false;
  return !isAbsolute(relPath);
}

export async function readAsset(
  cwd: string,
  relPath: string,
  limit: number = MAX_ASSET_BYTES,
): Promise<Asset | null> {
  if (!plausibleRelativePath(relPath)) return null;
  const contentType = ASSET_TYPES[extname(relPath).toLowerCase()];
  if (!contentType) return null;
  try {
    const root = await nativeRealpath(cwd);
    const target = await nativeRealpath(resolve(root, relPath));
    if (!isInside(root, target)) return null;
    const handle = await open(target, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) return null;
      const body = await handle.readFile();
      // The file can grow between `fstat` and the read; the cap applies to what we actually hold.
      if (body.length > limit) return null;
      return { body, contentType };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
