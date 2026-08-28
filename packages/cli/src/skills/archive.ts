/**
 * Zip extraction with runtime gates (spec §9.2.1 / P1-4).
 *
 * WHY STREAMING AND NOT `fflate.unzipSync()`:
 *
 *   `unzipSync` inflates the whole archive into memory in one call. There is
 *   literally no "before extraction" moment at which a size check could run,
 *   and no way to abort partway. A 5 MB upload at a 1000:1 ratio is 5 GB in the
 *   process before anything gets a vote.
 *
 *   The earlier design proposed summing the entries' DECLARED uncompressed
 *   sizes first. That is not a check: the zip central directory is written by
 *   whoever built the archive, so an attacker declares 1 KB and ships 50 MB.
 *   The only judge that cannot be lied to is the count of bytes we have
 *   actually written, which is why all three gates below sit on the write path
 *   and every one of them can abort mid-entry.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { checkStagedPath } from '@aragon-agent/core/skills';

/** Cap on the COMPRESSED download. The 20 MB below is the inflated total. */
export const ARCHIVE_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
/** Cap on bytes actually written to disk across the whole archive. */
export const ARCHIVE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Cap on bytes actually written for one entry. */
export const ARCHIVE_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
/** Inflated:compressed ratio ceiling, applied only to non-trivial entries. */
export const ARCHIVE_MAX_RATIO = 200;
/** Entries below this compressed size skip the ratio gate (a 20-byte file
 *  legitimately expands enormously and would false-positive). */
export const ARCHIVE_RATIO_MIN_COMPRESSED = 1024;
export const ARCHIVE_MAX_ENTRIES = 200;

export class ArchiveError extends Error {}

interface PendingEntry {
  path: string;
  chunks: Buffer[];
  written: number;
}

/**
 * Extract a zip into `targetDir`, enforcing the four gates.
 *
 * On ANY violation the target directory is removed entirely — a partially
 * extracted bomb left on disk would be indistinguishable from a successful
 * install to the next `discover()` pass.
 */
export async function extractZip(buffer: Buffer, targetDir: string): Promise<string[]> {
  mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];
  let totalInflated = 0;
  let entryCount = 0;
  let failure: Error | null = null;

  const fail = (message: string): void => {
    if (!failure) failure = new ArchiveError(message);
  };

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const unzip = new Unzip((file) => {
      if (failure) return;

      entryCount += 1;
      if (entryCount > ARCHIVE_MAX_ENTRIES) {
        fail(`archive has more than ${ARCHIVE_MAX_ENTRIES} entries`);
        return;
      }

      const name = file.name.replace(/\\/g, '/');
      // Directory entries carry no data; the parent mkdir below covers them.
      if (name.endsWith('/')) return;

      // FIRST of the two path defences (§8.3 validate is the second). Applied
      // before a single byte is written, so a zip-slip entry never exists.
      const pathIssue = checkStagedPath(name);
      if (pathIssue) {
        fail(`${pathIssue.code}: ${pathIssue.message}`);
        return;
      }
      const absolute = resolve(targetDir, name);
      const rel = relative(targetDir, absolute);
      if (rel.startsWith('..') || rel.length === 0) {
        fail(`entry escapes the extraction root: ${name}`);
        return;
      }

      const pending: PendingEntry = { path: absolute, chunks: [], written: 0 };
      // fflate names the COMPRESSED size `size` and the uncompressed one
      // `originalSize`; both are absent for streaming-built archives, in which
      // case the ratio gate simply does not apply and the byte gates carry it.
      const compressed = file.size ?? 0;

      file.ondata = (err, chunk, final) => {
        if (failure) return;
        if (err) {
          fail(`failed to inflate ${name}: ${err.message}`);
          return;
        }
        if (chunk && chunk.length > 0) {
          pending.written += chunk.length;
          totalInflated += chunk.length;
          // Gate 1 + 2: real bytes, checked as they arrive so we can stop.
          if (pending.written > ARCHIVE_MAX_ENTRY_BYTES) {
            fail(`${name} inflates to more than ${ARCHIVE_MAX_ENTRY_BYTES} bytes`);
            return;
          }
          if (totalInflated > ARCHIVE_MAX_TOTAL_BYTES) {
            fail(`archive inflates to more than ${ARCHIVE_MAX_TOTAL_BYTES} bytes`);
            return;
          }
          pending.chunks.push(Buffer.from(chunk));
        }
        if (!final) return;

        // Gate 3: compression ratio, computed from what we actually produced.
        if (
          compressed >= ARCHIVE_RATIO_MIN_COMPRESSED &&
          pending.written / compressed > ARCHIVE_MAX_RATIO
        ) {
          fail(
            `${name} has a compression ratio above ${ARCHIVE_MAX_RATIO}:1 ` +
              `(${pending.written} from ${compressed} bytes)`,
          );
          return;
        }

        try {
          mkdirSync(dirname(pending.path), { recursive: true });
          writeFileSync(pending.path, Buffer.concat(pending.chunks));
          written.push(pending.path);
        } catch (writeErr) {
          fail(`could not write ${name}: ${(writeErr as Error).message}`);
        }
      };

      file.start();
    });

    unzip.register(UnzipInflate);
    try {
      unzip.push(new Uint8Array(buffer), true);
      resolvePromise();
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)));
    }
  }).catch((err: Error) => {
    fail(`malformed zip archive: ${err.message}`);
  });

  // fflate's streaming reader does not throw on garbage — it simply never
  // yields an entry. Left unchecked, "this .zip is actually an HTML error page"
  // would surface much later as a puzzling SKILL_MD_MISSING instead of the
  // truth, so zero entries is treated as a malformed archive here.
  if (!failure && entryCount === 0) {
    fail('no entries found - the file is not a valid zip archive');
  }

  if (failure) {
    rmSync(targetDir, { recursive: true, force: true });
    throw failure;
  }
  return written;
}

/** Convenience for tests and callers that want the relative view. */
export function relativePaths(root: string, files: string[]): string[] {
  return files.map((f) => relative(root, f).replace(/\\/g, '/')).sort();
}
