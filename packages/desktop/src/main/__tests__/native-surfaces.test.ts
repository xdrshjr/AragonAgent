/** Native strings (key parity), taskbar / dock activity (AC-83) and the session export flow (AC-79, main half). */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_TABLES, nativeText, resolveNativeLocale } from '../native-strings.js';
import { planActivity } from '../native-bridge.js';
import {
  MAX_EXPORT_BYTES, collectConfigSecrets, exportSession, scrubSecrets, slugifyName, suggestFileName, writeFileAtomic, type SessionExportDeps,
} from '../session-export.js';

describe('native strings', () => {
  it('both languages have exactly the same keys, and no value is empty', () => {
    expect(Object.keys(NATIVE_TABLES.zh).sort()).toEqual(Object.keys(NATIVE_TABLES.en).sort());
    for (const table of [NATIVE_TABLES.en, NATIVE_TABLES.zh]) {
      for (const value of Object.values(table)) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('follows the language setting, and the OS locale for "auto"', () => {
    expect(resolveNativeLocale('en', 'zh-CN')).toBe('en');
    expect(resolveNativeLocale('zh-CN', 'en-US')).toBe('zh');
    expect(resolveNativeLocale('auto', 'zh-TW')).toBe('zh');
    expect(resolveNativeLocale('auto', 'fr')).toBe('en');
    expect(nativeText('zh', 'crash.reload')).not.toBe(nativeText('en', 'crash.reload'));
  });
});

describe('planActivity (AC-83)', () => {
  it('Windows: indeterminate progress while running in the background, flash while waiting in the background', () => {
    expect(planActivity({ running: 2, waiting: 0 }, 0, 'win32', false)).toEqual({ progress: 2, flash: false, badge: null, bounce: false });
    expect(planActivity({ running: 0, waiting: 1 }, 0, 'win32', false)).toEqual({ progress: -1, flash: true, badge: null, bounce: false });
  });

  it('Windows: nothing intrusive while the window is focused', () => {
    expect(planActivity({ running: 3, waiting: 2 }, 0, 'win32', true)).toEqual({ progress: -1, flash: false, badge: null, bounce: false });
  });

  it('macOS: the badge is the waiting count; the dock bounces only when it grows and the window is in the background', () => {
    expect(planActivity({ running: 1, waiting: 2 }, 1, 'darwin', false)).toEqual({ progress: null, flash: null, badge: 2, bounce: true });
    expect(planActivity({ running: 1, waiting: 2 }, 2, 'darwin', false).bounce).toBe(false);
    expect(planActivity({ running: 1, waiting: 3 }, 2, 'darwin', true).bounce).toBe(false);
    expect(planActivity({ running: 0, waiting: 0 }, 2, 'darwin', false)).toMatchObject({ badge: 0, bounce: false });
  });

  it('Linux: badge only', () => {
    expect(planActivity({ running: 5, waiting: 1 }, 0, 'linux', false)).toEqual({ progress: null, flash: null, badge: 1, bounce: false });
  });
});

describe('slugifyName / suggestFileName', () => {
  it('keeps letters, digits and CJK; everything else becomes one dash; bounded length', () => {
    expect(slugifyName('Fix: the bug / now?')).toBe('Fix-the-bug-now');
    expect(slugifyName('修复 登录 问题')).toBe('修复-登录-问题');
    expect(slugifyName('   ')).toBe('conversation');
    expect(slugifyName('../../etc/passwd')).toBe('etc-passwd');
    expect(slugifyName('a'.repeat(300)).length).toBeLessThanOrEqual(60);
  });

  it('appends a timestamp and the .md extension once', () => {
    const name = suggestFileName('My chat.md', new Date(2026, 9, 28, 7, 5));
    expect(name).toBe('My-chat-20261028-0705.md');
  });
});

describe('scrubSecrets', () => {
  it('removes a configured key everywhere, longest first, and known key shapes', () => {
    const text = 'key=sk-abcdef1234567890 and also my-secret-key plus my-secret and a ghp_abcdefghijklmnopqrstuvwxyz';
    const out = scrubSecrets(text, ['my-secret', 'my-secret-key'], (value) => value);
    expect(out).not.toContain('my-secret');
    expect(out).not.toContain('sk-');
    expect(out).not.toContain('ghp_');
    expect(out).toContain('[redacted]');
  });

  it('ignores very short "secrets" (they would shred ordinary words) and runs the engine redactor last', () => {
    const redact = vi.fn((value: string) => `${value}!`);
    expect(scrubSecrets('abc abc', ['abc'], redact)).toBe('abc abc!');
    expect(redact).toHaveBeenCalledTimes(1);
  });
});

describe('collectConfigSecrets', () => {
  it('finds the legacy apiKeys map and profile keys, and nothing else', () => {
    const secrets = collectConfigSecrets({
      provider: 'openai', model: 'm', apiKeys: { openai: 'k-one-1234', anthropic: 'k-two-5678', empty: null },
      modelProfiles: { entries: [{ id: 'p', apiKey: 'k-three-9012', model: 'x' }] },
      note: 'apiKey in prose', other: { deep: { apiKey: 'k-four-3456' } },
    });
    expect(secrets.sort()).toEqual(['k-four-3456', 'k-one-1234', 'k-three-9012', 'k-two-5678']);
  });

  it('is safe on junk', () => {
    expect(collectConfigSecrets(null)).toEqual([]);
    expect(collectConfigSecrets('string')).toEqual([]);
    expect(collectConfigSecrets([1, 2])).toEqual([]);
  });
});

describe('exportSession', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(os.tmpdir(), 'aragon-export-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const deps = (overrides: Partial<SessionExportDeps> = {}): SessionExportDeps => ({
    chooseFile: async (defaultPath) => join(dir, defaultPath.split(/[\\/]/).pop()!),
    redact: (text) => text,
    secrets: () => [],
    writeAtomic: writeFileAtomic,
    defaultDirectory: () => dir,
    now: () => new Date(2026, 0, 2, 3, 4),
    ...overrides,
  });
  const request = { sessionId: 's1', suggestedName: 'Hello', markdown: '# Hello\n\nbody\n' };

  it('writes the file at the chosen path and reports it', async () => {
    const result = await exportSession(deps(), request);
    expect(result.ok).toBe(true);
    const path = (result as { value: { path: string } }).value.path;
    expect(readFileSync(path, 'utf8')).toBe('# Hello\n\nbody\n');
    expect(path.endsWith('Hello-20260102-0304.md')).toBe(true);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]); // atomic: no temp file left
  });

  it('a cancelled dialog creates nothing and says "cancelled"', async () => {
    const result = await exportSession(deps({ chooseFile: async () => null }), request);
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('an oversize document is refused before any dialog is shown', async () => {
    const chooseFile = vi.fn(async () => join(dir, 'x.md'));
    const result = await exportSession(deps({ chooseFile }), { ...request, markdown: 'x'.repeat(MAX_EXPORT_BYTES + 1) });
    expect(result).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(chooseFile).not.toHaveBeenCalled();
  });

  it('removes configured keys from the written file', async () => {
    const result = await exportSession(deps({ secrets: () => ['TOP-SECRET-VALUE'] }), {
      ...request, markdown: 'the tool printed TOP-SECRET-VALUE and sk-live-abcdefghijklmnop',
    });
    const text = readFileSync((result as { value: { path: string } }).value.path, 'utf8');
    expect(text).not.toContain('TOP-SECRET-VALUE');
    expect(text).not.toMatch(/sk-/);
  });

  it('a write failure is reported with a neutral message and no partial file', async () => {
    const result = await exportSession(deps({
      writeAtomic: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); },
    }), request);
    expect(result).toMatchObject({ ok: false, code: 'write_failed' });
    expect((result as { message: string }).message).toContain('EACCES');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writeFileAtomic replaces an existing file in one step', () => {
    const target = join(dir, 'a.md');
    writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
  });
});
