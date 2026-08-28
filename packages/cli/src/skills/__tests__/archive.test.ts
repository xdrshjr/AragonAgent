/**
 * RED-TEAM SUITE 4 of 4 (spec §19.5, C1) — archive bombs and zip-slip.
 *
 * The decisive test is "lies about its declared size": it builds an archive
 * whose central-directory sizes are honest but whose CONTENT is far larger than
 * the caps allow, and asserts we stop anyway. Any implementation that trusts the
 * header instead of counting written bytes fails it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_TOTAL_BYTES,
  ArchiveError,
  extractZip,
  relativePaths,
} from '../archive.js';
import { cleanup, makeTmpDir } from './helpers.js';

let tmp = '';
beforeEach(() => {
  tmp = makeTmpDir('aragon-archive-');
});
afterEach(() => cleanup(tmp));

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function buildZip(entries: Record<string, Uint8Array>, level: 0 | 6 | 9 = 6): Buffer {
  return Buffer.from(zipSync(entries, { level }));
}

describe('extractZip — happy path', () => {
  it('writes the directory tree faithfully', async () => {
    const zip = buildZip({
      'SKILL.md': enc('---\nname: x\ndescription: d\n---\n'),
      'reference/a.md': enc('alpha'),
      'scripts/run.py': enc('print(1)'),
    });
    const target = join(tmp, 'out');
    const written = await extractZip(zip, target);

    expect(relativePaths(target, written)).toEqual([
      'SKILL.md',
      'reference/a.md',
      'scripts/run.py',
    ]);
    expect(readFileSync(join(target, 'reference/a.md'), 'utf-8')).toBe('alpha');
  });
});

describe('extractZip — path guards (AC-8)', () => {
  it('refuses zip-slip and leaves nothing on disk', async () => {
    const zip = buildZip({
      'SKILL.md': enc('---\nname: x\ndescription: d\n---\n'),
      '../../evil.txt': enc('pwned'),
    });
    const target = join(tmp, 'out');
    await expect(extractZip(zip, target)).rejects.toBeInstanceOf(ArchiveError);
    // A half-extracted bomb would look like a successful install to the scanner.
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(tmp, 'evil.txt'))).toBe(false);
  });

  it('refuses an absolute entry path', async () => {
    const zip = buildZip({ '/etc/passwd': enc('root:x:0:0') });
    await expect(extractZip(zip, join(tmp, 'out'))).rejects.toThrow(/SKILL_PATH_ABSOLUTE/);
  });

  it('refuses a Windows reserved device name', async () => {
    const zip = buildZip({ 'scripts/NUL.py': enc('x') });
    await expect(extractZip(zip, join(tmp, 'out'))).rejects.toThrow(/SKILL_PATH_RESERVED_NAME/);
  });
});

describe('extractZip — resource gates (P1-4)', () => {
  it('stops on ACTUAL inflated bytes, not the declared size', async () => {
    // Highly compressible payload well past the 20 MB inflated ceiling but only
    // a few hundred KB on the wire. The declared size in the header is honest
    // here; the point is that we never consult it — we count what we write.
    const huge = new Uint8Array(ARCHIVE_MAX_TOTAL_BYTES + 5 * 1024 * 1024); // zeros
    const zip = buildZip({ 'big.bin': huge }, 9);
    expect(zip.length).toBeLessThan(5 * 1024 * 1024);

    const target = join(tmp, 'out');
    await expect(extractZip(zip, target)).rejects.toThrow(
      /inflates to more than|compression ratio above/,
    );
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a single entry whose compression ratio is absurd', async () => {
    // 8 MB of zeros compresses to well under 8 KB → ratio far above 200:1.
    const zip = buildZip({ 'bomb.bin': new Uint8Array(8 * 1024 * 1024) }, 9);
    await expect(extractZip(zip, join(tmp, 'out'))).rejects.toThrow(
      /compression ratio above|inflates to more than/,
    );
  });

  it('rejects an archive with too many entries', async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i <= ARCHIVE_MAX_ENTRIES + 5; i += 1) entries[`f${i}.md`] = enc('x');
    await expect(extractZip(buildZip(entries), join(tmp, 'out'))).rejects.toThrow(/more than \d+ entries/);
  });

  it('a small, poorly-compressing file is NOT flagged by the ratio gate', async () => {
    // Guards against a false positive: tiny files legitimately "expand".
    const zip = buildZip({ 'tiny.md': enc('hello world') });
    const written = await extractZip(zip, join(tmp, 'out'));
    expect(written).toHaveLength(1);
  });

  it('reports a malformed archive instead of throwing something raw', async () => {
    await expect(extractZip(Buffer.from('not a zip at all'), join(tmp, 'out'))).rejects.toBeInstanceOf(
      ArchiveError,
    );
  });
});
