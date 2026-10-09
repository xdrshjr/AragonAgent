/**
 * `model-windows.json` parsing and lookup.
 *
 * The file is HAND-EDITED BY USERS, so the parse rules are the contract: every
 * case below is a shape a user can realistically produce with a text editor,
 * and the rule is always "a typo costs one dead entry, never the session".
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODEL_WINDOWS_LIMITS,
  ModelWindows,
  normalizeModelKey,
  parseModelWindows,
  parseModelWindowsResult,
} from '../config/model-windows.js';

const dirs: string[] = [];

function tempFile(name = 'model-windows.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-windows-test-'));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  // Directories this suite built under os.tmpdir(), per the TEST-ISOLATION
  // CONTRACT in app-paths.ts (rule 3: never delete a path a function returned).
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe('parseModelWindows', () => {
  it('reads the wrapped shape', () => {
    const table = parseModelWindows('{"version":1,"windows":{"kimi-k3":1048576}}');
    expect(table.get('kimi-k3')).toBe(1048576);
  });

  it('reads the bare map a user types first', () => {
    const table = parseModelWindows('{"kimi-k3": 1048576}');
    expect(table.get('kimi-k3')).toBe(1048576);
  });

  it('drops values a context window cannot be', () => {
    const table = parseModelWindows(
      '{"windows":{"a":0,"b":-5,"c":1.5,"d":"8192","e":null,"f":1023,"g":2000000001,"h":1048576}}',
    );
    expect(table.size).toBe(1);
    expect(table.get('h')).toBe(1048576);
  });

  it('normalizes keys the way the registry normalizes model ids', () => {
    expect(normalizeModelKey('Kimi-K3')).toBe('kimi-k3');
    expect(normalizeModelKey('models/glm-5.3')).toBe('glm-5.3');
    expect(normalizeModelKey('kimi-k3-20260716')).toBe('kimi-k3');
    const table = parseModelWindows('{"Kimi-K3": 1048576}');
    expect(table.get('kimi-k3')).toBe(1048576);
  });

  it('caps the entry count in file order', () => {
    const entries = Array.from(
      { length: MODEL_WINDOWS_LIMITS.maxEntries + 50 },
      (_, i) => `"m-${i}": 1048576`,
    ).join(',');
    const table = parseModelWindows(`{"windows":{${entries}}}`);
    expect(table.size).toBe(MODEL_WINDOWS_LIMITS.maxEntries);
    expect(table.get('m-0')).toBe(1048576);
    expect(table.has(`m-${MODEL_WINDOWS_LIMITS.maxEntries + 10}`)).toBe(false);
  });

  it('returns an empty table for anything that is not the file it wants', () => {
    for (const bad of ['', '   ', 'not json', '[]', '"a string"', '42', '{"windows":[1,2]}']) {
      expect(parseModelWindows(bad).size).toBe(0);
    }
  });

  it('flags malformed bodies apart from valid-but-empty ones', () => {
    expect(parseModelWindowsResult('not json').malformed).toBe(true);
    expect(parseModelWindowsResult('[]').malformed).toBe(true);
    expect(parseModelWindowsResult('{}').malformed).toBe(false);
    expect(parseModelWindowsResult('{"windows":{"a":1}}').malformed).toBe(false);
  });

  it('tolerates a UTF-8 BOM in front of an otherwise valid body', () => {
    const table = parseModelWindows('\uFEFF{"windows":{"kimi-k3":1048576}}');
    expect(table.get('kimi-k3')).toBe(1048576);
  });
});

describe('ModelWindows lookup', () => {
  it('reports nothing for a missing file', () => {
    expect(new ModelWindows(tempFile()).lookup('kimi-k3')).toBeUndefined();
  });

  it('finds a declared window, normalized', () => {
    const path = tempFile();
    writeFileSync(path, '{"windows":{"kimi-k3":1048576}}', 'utf8');
    const windows = new ModelWindows(path);
    expect(windows.lookup('kimi-k3')).toBe(1048576);
    expect(windows.lookup('KIMI-K3-20260716')).toBe(1048576);
    expect(windows.lookup('glm-5.3')).toBeUndefined();
  });

  it('picks up an edit without a new instance', () => {
    const path = tempFile();
    writeFileSync(path, '{"windows":{"kimi-k3":1048576}}', 'utf8');
    const windows = new ModelWindows(path);
    expect(windows.lookup('kimi-k3')).toBe(1048576);
    // Different length so the cache stamp differs even on same-millisecond mtimes.
    writeFileSync(path, '{"windows":{"kimi-k3":2097152,"glm-5.3":1048576}}', 'utf8');
    expect(windows.lookup('kimi-k3')).toBe(2097152);
    expect(windows.lookup('glm-5.3')).toBe(1048576);
  });

  it('degrades to nothing when the file becomes garbage', () => {
    const path = tempFile();
    writeFileSync(path, '{"windows":{"kimi-k3":1048576}}', 'utf8');
    const windows = new ModelWindows(path);
    expect(windows.lookup('kimi-k3')).toBe(1048576);
    writeFileSync(path, '{broken', 'utf8');
    expect(windows.lookup('kimi-k3')).toBeUndefined();
  });

  it('a deleted file clears its declarations', () => {
    const path = tempFile();
    writeFileSync(path, '{"windows":{"kimi-k3":1048576}}', 'utf8');
    const windows = new ModelWindows(path);
    expect(windows.lookup('kimi-k3')).toBe(1048576);
    rmSync(path);
    expect(windows.lookup('kimi-k3')).toBeUndefined();
  });

  it.each([
    ['UTF-8 with BOM', () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])],
    ['UTF-16LE with BOM (Notepad "Unicode")', () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])],
    ['UTF-16BE with BOM', () => Buffer.concat([Buffer.from([0xfe, 0xff]), swapPairs(Buffer.from(body, 'utf16le'))])],
  ])('reads a file saved as %s', (_label, encode) => {
    const path = tempFile();
    writeFileSync(path, encode());
    expect(new ModelWindows(path).lookup('kimi-k3')).toBe(1048576);
  });
});

/** UTF-16BE helper: reverse each 16-bit unit of a little-endian encoding. */
function swapPairs(le: Buffer): Buffer {
  const out = Buffer.from(le);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const high = out[i];
    out[i] = out[i + 1];
    out[i + 1] = high;
  }
  return out;
}

const body = '{"windows":{"kimi-k3":1048576}}';
