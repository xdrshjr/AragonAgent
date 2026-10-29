/**
 * Containment for paths the renderer may ask the OS to open, the persistent desktop state,
 * the diagnostics archive, one-time port tokens and engine-root resolution. Real files in a
 * temp directory - these are exactly the places where mocking the filesystem would hide the bug.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopStateStore } from '../desktop-state-store.js';
import { buildDiagnosticsZip, recentLogFiles } from '../diagnostics.js';
import { resolveEngineRoot } from '../engine-loader.js';
import { isInsideDir, resolveAllowedPath } from '../native-bridge.js';
import { TOKEN_TTL_MS, TokenStore } from '../session-channel.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(os.tmpdir(), 'aragon-main-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('isInsideDir / resolveAllowedPath', () => {
  it('compares whole path segments, not string prefixes', () => {
    expect(isInsideDir('/work', '/work/src/a.ts')).toBe(true);
    expect(isInsideDir('/work', '/work')).toBe(true);
    expect(isInsideDir('/work', '/work-evil/a.ts')).toBe(false);
    expect(isInsideDir('/work', '/other')).toBe(false);
  });

  it('opens a file inside the workspace and refuses one outside it', () => {
    const work = join(dir, 'work');
    mkdirSync(work);
    writeFileSync(join(work, 'a.txt'), 'x');
    writeFileSync(join(dir, 'outside.txt'), 'x');
    expect(resolveAllowedPath([work], 'a.txt')).toBeTruthy();
    expect(resolveAllowedPath([work], '../outside.txt')).toBeNull();
    expect(resolveAllowedPath([work], join(dir, 'outside.txt'))).toBeNull();
    expect(resolveAllowedPath([work], 'missing.txt')).toBeNull();
    expect(resolveAllowedPath([work], 'a\0.txt')).toBeNull();
  });

  it('refuses a link that points out of the workspace (checked AFTER resolving it)', () => {
    const work = join(dir, 'work');
    const secret = join(dir, 'secret');
    mkdirSync(work);
    mkdirSync(secret);
    writeFileSync(join(secret, 'key.txt'), 'private');
    try {
      symlinkSync(secret, join(work, 'link'), 'junction');
    } catch {
      return; // the platform refused to create the link; nothing to assert
    }
    expect(resolveAllowedPath([work], 'link/key.txt')).toBeNull();
  });
});

describe('DesktopStateStore', () => {
  it('round-trips a patch through the file and keeps unknown fields', () => {
    writeFileSync(join(dir, 'desktop-state.json'), JSON.stringify({ language: 'zh-CN', futureKey: 7 }));
    const store = new DesktopStateStore(dir);
    expect(store.get().language).toBe('zh-CN');
    store.patch({ enterToSend: false });
    const onDisk = JSON.parse(readFileSync(join(dir, 'desktop-state.json'), 'utf8'));
    expect(onDisk).toMatchObject({ language: 'zh-CN', enterToSend: false, futureKey: 7, schema: 1 });
    expect(new DesktopStateStore(dir).get().enterToSend).toBe(false);
  });

  it('moves a corrupt file aside, uses defaults and says so once', () => {
    writeFileSync(join(dir, 'desktop-state.json'), '{ not json');
    const store = new DesktopStateStore(dir, () => 123);
    expect(store.get().language).toBe('auto');
    expect(store.corruptNotice).toContain('desktop-state.json.corrupt-123');
    expect(existsSync(join(dir, 'desktop-state.json.corrupt-123'))).toBe(true);
    expect(existsSync(join(dir, 'desktop-state.json'))).toBe(false);
  });

  it('with no home yet it keeps state in memory and never writes', () => {
    const store = new DesktopStateStore(null);
    store.patch({ enterToSend: false });
    expect(store.get().enterToSend).toBe(false);
    expect(existsSync(join(process.cwd(), 'desktop-state.json'))).toBe(false);
  });
});

describe('buildDiagnosticsZip', () => {
  it('includes recent logs and the doctor report, redacts text, and never ships config.json', () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    writeFileSync(join(logs, 'desktop-main-2026-10-27.jsonl'), 'line with SECRET-KEY inside');
    writeFileSync(join(dir, 'config.json'), '{"apiKeys":{"anthropic":"SECRET-KEY"}}');
    const bytes = buildDiagnosticsZip({
      logsDir: logs, now: Date.now(), redact: (text) => text.replaceAll('SECRET-KEY', '[redacted]'),
      doctor: { ok: true }, summary: { v: 1 }, desktopStatePath: join(dir, 'desktop-state.json'),
    });
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['summary.json', 'doctor.json', 'logs/desktop-main-2026-10-27.jsonl']));
    expect(Object.keys(files).some((name) => name.includes('config.json'))).toBe(false);
    for (const content of Object.values(files)) expect(strFromU8(content)).not.toContain('SECRET-KEY');
  });

  it('skips logs older than three days', () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    writeFileSync(join(logs, 'desktop-old.jsonl'), 'x');
    expect(recentLogFiles(logs, Date.now() + 4 * 24 * 60 * 60 * 1000)).toEqual([]);
    expect(recentLogFiles(logs, Date.now())).toEqual(['desktop-old.jsonl']);
  });
});

describe('TokenStore', () => {
  it('is one-time, bound to its session and window, and expires', () => {
    let now = 1000;
    const store = new TokenStore(() => now);
    const token = store.issue('s1', 7);
    expect(store.consume(token, 's2', 7)).toBe(false); // wrong session burns it
    expect(store.consume(token, 's1', 7)).toBe(false); // already spent
    const second = store.issue('s1', 7);
    expect(store.consume(second, 's1', 8)).toBe(false); // wrong window
    const third = store.issue('s1', 7);
    expect(store.consume(third, 's1', 7)).toBe(true);
    const stale = store.issue('s1', 7);
    now += TOKEN_TTL_MS + 1;
    expect(store.consume(stale, 's1', 7)).toBe(false);
    expect(store.consume('made-up', 's1', 7)).toBe(false);
  });
});

describe('resolveEngineRoot', () => {
  it('finds the workspace cli in development and the resources copy when packaged', () => {
    const appRoot = join(dir, 'packages', 'desktop');
    const cli = join(dir, 'packages', 'cli');
    mkdirSync(join(cli, 'dist', 'host'), { recursive: true });
    writeFileSync(join(cli, 'dist', 'host', 'settings.js'), '');
    mkdirSync(appRoot, { recursive: true });
    expect(resolveEngineRoot({ appRoot, isPackaged: false }).root).toBe(cli);

    const resources = join(dir, 'resources');
    const packagedCli = join(resources, 'engine', 'node_modules', '@aragon-agent', 'cli');
    mkdirSync(join(packagedCli, 'dist', 'host'), { recursive: true });
    writeFileSync(join(packagedCli, 'dist', 'host', 'settings.js'), '');
    expect(resolveEngineRoot({ appRoot, isPackaged: true, resourcesPath: resources }).root).toBe(packagedCli);
  });

  it('reports every place it looked when the engine is missing', () => {
    const result = resolveEngineRoot({ appRoot: join(dir, 'nowhere'), isPackaged: true, resourcesPath: join(dir, 'res') });
    expect(result.root).toBeNull();
    expect(result.attempted.length).toBeGreaterThan(0);
  });
});
