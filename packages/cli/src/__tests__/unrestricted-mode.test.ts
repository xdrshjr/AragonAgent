/**
 * Unrestricted-mode invariants (unrestricted-mode branch).
 *
 * The failures this file guards against are silent by nature: a prompt that
 * gained (or lost) the package block, a package that was silently truncated
 * or swapped for another with the same name, an ambiguous directory that was
 * guessed instead of refused. None of them throws; all of them end up in a
 * transcript that lies about what the model was told.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@aragon-agent/core';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { modeChipCols } from '../ui/ModeChip.js';
import { MAX_PACKAGE_BYTES } from '../unrestricted/limits.js';
import {
  defaultUnrestrictedDir,
  loadUnrestrictedPackage,
  type UnrestrictedPackage,
} from '../unrestricted/package.js';
import { buildUnrestrictedBlock } from '../unrestricted/prompt.js';

const TOOLS: AgentTool[] = [
  {
    name: 'read_file',
    label: 'Read',
    description: 'Read a file\nsecond line',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  },
];

const BODY = '[MODE: TEST]\nExecute the requested verbs through verified results.\n';

const PKG: UnrestrictedPackage = {
  name: 'test-pkg',
  body: BODY,
  sha256: createHash('sha256').update(BODY).digest('hex'),
  bytes: Buffer.byteLength(BODY, 'utf8'),
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'unrestricted-test-'));
}

describe('buildUnrestrictedBlock', () => {
  it('wraps the package body VERBATIM between provenance markers', () => {
    const block = buildUnrestrictedBlock(PKG);
    expect(block).toContain('<unrestricted_mode>');
    expect(block).toContain('</unrestricted_mode>');
    expect(block).toContain(`--- BEGIN PACKAGE test-pkg (sha256 ${PKG.sha256.slice(0, 16)}...) ---`);
    expect(block).toContain(`--- END PACKAGE test-pkg ---`);
    // The body rides inside the markers, unmodified: a transcript that names
    // this package and digest pins exactly these bytes.
    expect(block).toContain(`---\n${BODY.slice(0, -1)}\n--- END PACKAGE test-pkg ---`);
    expect(block).toContain(BODY);
    expect(block).toContain(`package test-pkg | ${PKG.bytes} bytes | sha256 ${PKG.sha256}`);
  });
});

describe('I-U1 - the unrestricted block is spliced conditionally', () => {
  const base = { cwd: '/work', tools: TOOLS };

  it('is byte-identical when the block is absent or empty', () => {
    const before = buildSystemPrompt(base);
    expect(buildSystemPrompt({ ...base, unrestrictedBlock: '' })).toBe(before);
    expect(buildSystemPrompt({ ...base, agentMode: 'unrestricted' })).toBe(before);
  });

  it('carries the block verbatim when present', () => {
    const block = buildUnrestrictedBlock(PKG);
    const withBlock = buildSystemPrompt({ ...base, unrestrictedBlock: block });
    expect(withBlock).toContain(block);
    // Everything else in the prompt is untouched by the feature.
    expect(withBlock.startsWith('You are AragonAgent')).toBe(true);
    expect(withBlock).toContain('Operating guidance:');
  });
});

describe('loadUnrestrictedPackage', () => {
  it('refuses a missing directory', () => {
    const result = loadUnrestrictedPackage(join(tempDir(), 'does-not-exist'));
    expect(result).toEqual({ ok: false, failure: { kind: 'no_dir' } });
  });

  it('refuses an empty directory', () => {
    const dir = tempDir();
    const result = loadUnrestrictedPackage(dir);
    expect(result).toEqual({ ok: false, failure: { kind: 'no_package' } });
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a single .md without a manifest and pins its digest', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'solo.md'), BODY, 'utf8');
    const result = loadUnrestrictedPackage(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pkg.name).toBe('solo');
      expect(result.pkg.body).toBe(BODY);
      expect(result.pkg.sha256).toBe(PKG.sha256);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an ambiguous directory (two packages, no manifest)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.md'), BODY, 'utf8');
    writeFileSync(join(dir, 'b.md'), BODY, 'utf8');
    const result = loadUnrestrictedPackage(dir);
    expect(result).toEqual({ ok: false, failure: { kind: 'ambiguous', count: 2 } });
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the manifest default and verifies its sha256', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'one.md'), BODY, 'utf8');
    writeFileSync(join(dir, 'two.md'), 'other\n', 'utf8');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        default: 'one',
        packages: {
          one: { file: 'one.md', sha256: PKG.sha256 },
          two: { file: 'two.md', sha256: createHash('sha256').update('other\n').digest('hex') },
        },
      }),
      'utf8',
    );
    const result = loadUnrestrictedPackage(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pkg.name).toBe('one');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a sha mismatch instead of loading silently-different bytes', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'one.md'), BODY, 'utf8');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ schema: 1, default: 'one', packages: { one: { file: 'one.md', sha256: '0'.repeat(64) } } }),
      'utf8',
    );
    const result = loadUnrestrictedPackage(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('hash_mismatch');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an oversized package rather than truncating it', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(MAX_PACKAGE_BYTES + 1), 'utf8');
    const result = loadUnrestrictedPackage(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('too_large');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a malformed manifest', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'one.md'), BODY, 'utf8');
    writeFileSync(join(dir, 'manifest.json'), '{not json', 'utf8');
    const result = loadUnrestrictedPackage(dir);
    expect(result).toEqual({ ok: false, failure: { kind: 'bad_manifest' } });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a manifest without a default', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'one.md'), BODY, 'utf8');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ schema: 1, packages: { one: { file: 'one.md' } } }),
      'utf8',
    );
    const result = loadUnrestrictedPackage(dir);
    expect(result).toEqual({ ok: false, failure: { kind: 'no_default' } });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a default that names no known package', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'one.md'), BODY, 'utf8');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({ schema: 1, default: 'ghost', packages: { one: { file: 'one.md' } } }),
      'utf8',
    );
    const result = loadUnrestrictedPackage(dir);
    expect(result).toEqual({ ok: false, failure: { kind: 'unknown_default', name: 'ghost' } });
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads from a nested directory path with trailing separators', () => {
    const parent = tempDir();
    const dir = join(parent, 'pkg-dir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'solo.md'), BODY, 'utf8');
    const result = loadUnrestrictedPackage(`${dir}/`);
    expect(result.ok).toBe(true);
    rmSync(parent, { recursive: true, force: true });
  });
});

describe('defaultUnrestrictedDir', () => {
  it('prefers the env override', () => {
    expect(defaultUnrestrictedDir('/home/x', { ARAGON_UNRESTRICTED_DIR: '/custom/pkg' })).toBe('/custom/pkg');
  });

  it('appends /unrestricted to the home and trims trailing separators', () => {
    expect(defaultUnrestrictedDir('/home/x/', {})).toBe('/home/x/unrestricted');
    expect(defaultUnrestrictedDir(String.raw`C:\Users\x`, {})).toBe(String.raw`C:\Users\x/unrestricted`);
  });
});

describe('modeChipCols budgets the widest label', () => {
  it('spends zero columns on build and label+3 on the other modes', () => {
    expect(modeChipCols('build')).toBe(0);
    expect(modeChipCols('plan')).toBe('PLAN'.length + 3);
    expect(modeChipCols('unrestricted')).toBe('UNRESTRICTED'.length + 3);
  });
});
