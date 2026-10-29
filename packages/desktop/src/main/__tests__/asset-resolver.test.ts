import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetHeaders } from '../protocols.js';
import { isInside, MAX_ASSET_BYTES, readAsset } from '../asset-resolver.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
// Module scope, not `beforeAll`: `it.each` rows are built at collection time and name these paths.
const root = mkdtempSync(join(tmpdir(), 'aragon-asset-'));
const cwd = join(root, 'work');
const outside = join(root, 'work-evil');

beforeAll(() => {
  mkdirSync(join(cwd, 'img'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(cwd, 'img', 'a.png'), PNG);
  writeFileSync(join(cwd, 'img', 'UPPER.PNG'), PNG);
  writeFileSync(join(cwd, 'notes.txt'), 'text');
  writeFileSync(join(cwd, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(outside, 'secret.png'), PNG);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('readAsset', () => {
  it('serves an image inside the working directory with a fixed content type', async () => {
    const asset = await readAsset(cwd, 'img/a.png');
    expect(asset?.contentType).toBe('image/png');
    expect(asset?.body.equals(PNG)).toBe(true);
  });

  it('matches extensions case-insensitively', async () => {
    expect((await readAsset(cwd, 'img/UPPER.PNG'))?.contentType).toBe('image/png');
  });

  it('serves svg as image/svg+xml (the sandbox CSP, not the type, is what keeps it inert)', async () => {
    expect((await readAsset(cwd, 'logo.svg'))?.contentType).toBe('image/svg+xml');
  });

  it.each([
    ['dot-dot traversal', '../work-evil/secret.png'],
    ['nested traversal', 'img/../../work-evil/secret.png'],
    ['an absolute path', join(outside, 'secret.png')],
    ['a drive-letter form', 'C:/Windows/win.png'],
    ['an NTFS alternate data stream', 'img/a.png:hidden'],
    ['a NUL byte', 'img/a.png\0.txt'],
    ['an empty path', ''],
    ['a non-allow-listed extension', 'notes.txt'],
    ['a missing file', 'img/missing.png'],
    ['a directory', 'img'],
  ])('refuses %s', async (_label, rel) => {
    expect(await readAsset(cwd, rel)).toBeNull();
  });

  it('refuses a file over the size limit and accepts one at it', async () => {
    writeFileSync(join(cwd, 'big.png'), Buffer.alloc(2048));
    expect(await readAsset(cwd, 'big.png', 2047)).toBeNull();
    expect((await readAsset(cwd, 'big.png', 2048))?.body.length).toBe(2048);
    expect(MAX_ASSET_BYTES).toBe(10 * 1024 * 1024);
  });

  it('refuses a link that leaves the working directory (junction on Windows, symlink elsewhere)', async () => {
    const link = join(cwd, 'escape');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // the platform will not let this account create links; nothing to assert
    }
    expect(await readAsset(cwd, 'escape/secret.png')).toBeNull();
  });

  it('refuses a file link whose target is outside', async () => {
    const link = join(cwd, 'leak.png');
    try {
      symlinkSync(join(outside, 'secret.png'), link, 'file');
    } catch {
      return;
    }
    expect(await readAsset(cwd, 'leak.png')).toBeNull();
  });
});

describe('isInside', () => {
  it('compares path segments, so a sibling sharing a prefix is not inside', () => {
    expect(isInside('/a/work', '/a/work/x.png')).toBe(true);
    expect(isInside('/a/work', '/a/work-evil/x.png')).toBe(false);
    expect(isInside('/a/work', '/a/work')).toBe(false);
    expect(isInside('/a/work', '/a/..hidden')).toBe(false);
  });

  it('accepts a child whose NAME merely starts with two dots', () => {
    expect(isInside('/a/work', '/a/work/..cache/x.png')).toBe(true);
  });
});

describe('assetHeaders', () => {
  it('pins the type, forbids sniffing, sandboxes direct navigation and disables caching', () => {
    expect(assetHeaders('image/svg+xml')).toEqual({
      'Content-Type': 'image/svg+xml',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'no-store',
    });
  });
});
