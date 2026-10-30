import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_GC_MAX_AGE_MS,
  classifyStatPath,
  collectAttachmentGarbage,
  removeSessionAttachments,
} from '../attachment-paths.js';
import { INVALID, IPC_VALIDATORS } from '../ipc-validate.js';
import { defaultDesktopState, normalizeDesktopState, LIMITS } from '../../shared/desktop-state.js';
import { IPC_CHANNELS, type IpcChannel } from '../../shared/ipc-contract.js';

const validate = (channel: IpcChannel, raw: unknown): unknown =>
  (IPC_VALIDATORS[channel] as (value: unknown) => unknown)(raw);

describe('classifyStatPath (RV-12)', () => {
  it('never touches the filesystem for a UNC path and reports it unverified', () => {
    const stat = vi.fn();
    for (const path of ['\\\\server\\share\\a.txt', '//server/share/a.txt']) {
      expect(classifyStatPath(path, stat as never)).toEqual({ ok: true, kind: 'file', size: -1 });
    }
    expect(stat).not.toHaveBeenCalled();
  });

  it('refuses Windows device namespaces in either slash direction', () => {
    const stat = vi.fn();
    for (const path of ['\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', '//?/C:/x', '//./COM1/']) {
      expect(classifyStatPath(path, stat as never)).toMatchObject({ ok: false });
    }
    expect(stat).not.toHaveBeenCalled();
  });

  it('refuses relative, NUL-bearing and overlong paths', () => {
    for (const path of ['rel/a.txt', 'a\0b', '', `/${'a'.repeat(5000)}`]) {
      expect(classifyStatPath(path)).toMatchObject({ ok: false });
    }
  });

  it('reports type and size only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aragon-stat-'));
    try {
      writeFileSync(join(dir, 'f.txt'), 'abcd');
      expect(classifyStatPath(join(dir, 'f.txt'))).toEqual({ ok: true, kind: 'file', size: 4 });
      expect(classifyStatPath(dir)).toEqual({ ok: true, kind: 'folder', size: 0 });
      expect(classifyStatPath(join(dir, 'nope'))).toEqual({ ok: true, kind: 'missing', size: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('attachment garbage collection (R-13)', () => {
  let home: string;
  const dayMs = 24 * 60 * 60 * 1000;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'aragon-gc-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const makeDir = (name: string, ageDays: number): string => {
    const dir = join(home, 'attachments', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'att-0123456789ab.png'), 'x');
    const when = new Date(Date.now() - ageDays * dayMs);
    utimesSync(dir, when, when);
    return dir;
  };

  it('removes only old directories whose session is gone', () => {
    const old = makeDir('gone-old', 40);
    const fresh = makeDir('gone-fresh', 2);
    const live = makeDir('alive-old', 90);
    const removed = collectAttachmentGarbage({ homeRoot: home, liveSessions: new Set(['alive-old']) });
    expect(removed).toEqual(['gone-old']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(live)).toBe(true);
  });

  it('honours an explicit age and never leaves attachments/', () => {
    const outside = join(home, 'attachments-evil');
    mkdirSync(outside);
    makeDir('s1', 1);
    const removed = collectAttachmentGarbage({
      homeRoot: home, liveSessions: new Set(), maxAgeMs: ATTACHMENT_GC_MAX_AGE_MS / 1000,
    });
    expect(removed).toEqual(['s1']);
    expect(existsSync(outside)).toBe(true);
  });

  it('removes a deleted session\'s directory and ignores ids that could escape', () => {
    const dir = makeDir('s2', 0);
    removeSessionAttachments(home, '..');
    removeSessionAttachments(home, 'a/b');
    expect(existsSync(join(home, 'attachments'))).toBe(true);
    removeSessionAttachments(home, 's2');
    expect(existsSync(dir)).toBe(false);
  });
});

describe('new IPC channels', () => {
  it('registers every new channel in the allow-list and the validator map', () => {
    for (const channel of ['native:stat-path', 'native:reveal-attachment', 'native:save-attachment', 'native:read-clipboard-image'] as const) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IPC_VALIDATORS[channel]).toBeTypeOf('function');
    }
  });

  it('validates arguments strictly', () => {
    expect(validate('native:stat-path', { path: '/a' })).toEqual({ path: '/a' });
    expect(validate('native:stat-path', { path: '' })).toBe(INVALID);
    expect(validate('native:stat-path', { path: 3 })).toBe(INVALID);
    // The clipboard channel takes no argument at all: nothing the page sends can steer it.
    expect(validate('native:read-clipboard-image', undefined)).toBeUndefined();
    expect(validate('native:read-clipboard-image', { path: '/etc/passwd' })).toBe(INVALID);
    expect(validate('native:reveal-attachment', { sessionId: '../x', attachmentId: 'a' })).toBe(INVALID);
    expect(validate('native:reveal-attachment', { sessionId: 's1', attachmentId: 'att-0123456789ab' }))
      .toEqual({ sessionId: 's1', attachmentId: 'att-0123456789ab' });
    expect(validate('native:save-attachment', { sessionId: 's1', attachmentId: 'a', suggestedName: 'x.png' }))
      .toEqual({ sessionId: 's1', attachmentId: 'a', suggestedName: 'x.png' });
    expect(validate('desktop-state:patch', { imageInputOverrides: { 'a/b': 'on' } }))
      .toEqual({ imageInputOverrides: { 'a/b': 'on' } });
  });
});

describe('imageInputOverrides in desktop state', () => {
  it('defaults empty and keeps only valid, bounded rows', () => {
    expect(defaultDesktopState().imageInputOverrides).toEqual({});
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) many[`p/m${i}`] = i % 2 ? 'on' : 'off';
    many[''] = 'on';
    many['p/bad'] = 'maybe';
    many[`p/${'k'.repeat(300)}`] = 'on';
    const state = normalizeDesktopState({ imageInputOverrides: many });
    const keys = Object.keys(state.imageInputOverrides);
    expect(keys.length).toBe(LIMITS.imageOverrides);
    expect(keys).not.toContain('');
    expect(keys).not.toContain('p/bad');
    expect(Object.values(state.imageInputOverrides).every((v) => v === 'on' || v === 'off')).toBe(true);
  });

  it('is not mistaken for an unknown extra field', () => {
    const state = normalizeDesktopState({ imageInputOverrides: { 'a/b': 'off' }, future: 1 });
    expect(state.imageInputOverrides).toEqual({ 'a/b': 'off' });
    expect(state.extras).toEqual({ future: 1 });
  });
});
