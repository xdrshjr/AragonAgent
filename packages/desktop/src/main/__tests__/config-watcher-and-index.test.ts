/**
 * Terminal-writes-while-desktop-runs (AC-16) and the sidebar's staged listing (spec 3.3).
 *
 * The watcher is driven through its injected `watch` function and a scripted revision reader;
 * the index through a fake scanner and parser. Both run against real timers where debouncing
 * is the thing being tested, and a real temp directory for the cache file.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionFileStat, SessionRowData } from '@aragon-agent/cli/dist/host/sessions.js';
import { ConfigWatcher } from '../config-watcher.js';
import { SESSION_CACHE_FILE, SessionIndex, type SessionParser } from '../session-index.js';

describe('ConfigWatcher', () => {
  let revision = 'r1';
  let ok = true;
  let fire: ((event: string, filename: string | null) => void) | null = null;
  const changes: { revision: string; ok: boolean }[] = [];
  const make = (): ConfigWatcher => new ConfigWatcher({
    homeRoot: '/home', configPath: '/home/config.json',
    reader: { read: () => ({ revision, ok }) },
    onChange: (change) => changes.push(change),
    debounceMs: 50, pollMs: 5000,
    watchFn: ((_dir: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
      fire = listener;
      return { on: () => undefined, close: () => undefined };
    }) as never,
  });

  beforeEach(() => { vi.useFakeTimers(); revision = 'r1'; ok = true; changes.length = 0; fire = null; });
  afterEach(() => { vi.useRealTimers(); });

  it('reports a real content change once, after the debounce', () => {
    const watcher = make();
    watcher.start();
    revision = 'r2';
    fire!('rename', 'config.json');
    fire!('change', 'config.json'); // an editor typically emits several events per save
    expect(changes).toHaveLength(0);
    vi.advanceTimersByTime(60);
    expect(changes).toEqual([{ revision: 'r2', ok: true }]);
    watcher.stop();
  });

  it('ignores other files in the home directory and touches that change nothing', () => {
    const watcher = make();
    watcher.start();
    fire!('change', 'quick-prompts.json');
    vi.advanceTimersByTime(100);
    fire!('change', 'config.json'); // same revision: antivirus touch or our own echo
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(0);
    watcher.stop();
  });

  it('does not report its own write once it has acknowledged the new revision', () => {
    const watcher = make();
    watcher.start();
    revision = 'mine';
    watcher.acknowledge('mine');
    fire!('change', 'config.json');
    vi.advanceTimersByTime(100);
    expect(changes).toHaveLength(0);
    watcher.stop();
  });

  it('falls back to polling when the watcher never fires (network drives, some antivirus)', () => {
    const watcher = make();
    watcher.start();
    revision = 'r2';
    vi.advanceTimersByTime(5100);
    expect(changes).toEqual([{ revision: 'r2', ok: true }]);
    watcher.stop();
  });

  it('reports a file becoming unreadable and recovering, without waiting for a content change', () => {
    const watcher = make();
    watcher.start();
    ok = false;
    revision = 'r-bad';
    vi.advanceTimersByTime(5100);
    ok = true;
    revision = 'r-good';
    vi.advanceTimersByTime(5100);
    expect(changes.map((change) => change.ok)).toEqual([false, true]);
    watcher.stop();
  });

  it('survives a platform where watching the directory throws', () => {
    const watcher = new ConfigWatcher({
      homeRoot: '/home', configPath: '/home/config.json', reader: { read: () => ({ revision, ok }) },
      onChange: (change) => changes.push(change), pollMs: 1000,
      watchFn: (() => { throw new Error('ENOSPC'); }) as never,
    });
    watcher.start();
    revision = 'r2';
    vi.advanceTimersByTime(1100);
    expect(changes).toHaveLength(1);
    watcher.stop();
  });
});

describe('SessionIndex', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(os.tmpdir(), 'aragon-index-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const file = (id: string, mtimeMs: number, size = 10): SessionFileStat => ({ id, path: `/s/${id}.json`, mtimeMs, size });
  const row = (id: string, overrides: Partial<SessionRowData> = {}): SessionRowData => ({
    id, path: `/s/${id}.json`, mtimeMs: 1, size: 10, unreadable: false, title: `title ${id}`, cwd: 'D:\\Work\\Repo',
    updatedAt: 5, turns: 2, provider: 'anthropic', model: 'm', origin: 'tui', pinned: false, live: false, ...overrides,
  });
  const make = (files: SessionFileStat[], parse: SessionParser['parse']) => {
    const changes: string[] = [];
    const index = new SessionIndex({
      homeRoot: dir, scan: () => files, parser: { parse, dispose: () => undefined },
      isLiveElsewhere: (id) => id === 'locked', hostStatusOf: () => null,
      onChanged: (reason) => changes.push(reason), caseInsensitiveVolume: true,
    });
    return { index, changes };
  };

  it('lists a skeleton from stat alone, then fills rows as the worker answers', async () => {
    let release: (() => void) | undefined;
    const { index, changes } = make([file('a', 2), file('b', 1)], (files, onRows) => new Promise((resolve) => {
      release = () => { onRows(files.map((f) => row(f.id, { mtimeMs: f.mtimeMs }))); resolve(); };
    }));
    const refreshing = index.refresh();
    expect(index.list().map((r) => [r.id, r.pending, r.title])).toEqual([['a', true, null], ['b', true, null]]);
    release!();
    await refreshing;
    expect(index.list().map((r) => [r.id, r.pending, r.title])).toEqual([['a', false, 'title a'], ['b', false, 'title b']]);
    expect(changes).toEqual(expect.arrayContaining(['files', 'metadata']));
  });

  it('only sends changed files to the parser on the second refresh (mtime + size cache)', async () => {
    const parsed: string[][] = [];
    const files = [file('a', 2), file('b', 1)];
    const { index } = make(files, async (batch, onRows) => { parsed.push(batch.map((f) => f.id)); onRows(batch.map((f) => row(f.id, { mtimeMs: f.mtimeMs }))); });
    await index.refresh();
    files[0] = file('a', 3); // a was edited
    await index.refresh();
    expect(parsed).toEqual([['a', 'b'], ['a']]);
  });

  it('persists the cache and a second launch needs no parsing at all', async () => {
    const files = [file('a', 2)];
    const first = make(files, async (batch, onRows) => onRows(batch.map((f) => row(f.id, { mtimeMs: f.mtimeMs }))));
    await first.index.refresh();
    first.index.persistNow();
    expect(existsSync(join(dir, SESSION_CACHE_FILE))).toBe(true);
    const parse = vi.fn(async () => undefined);
    const second = make(files, parse);
    await second.index.refresh();
    expect(parse).not.toHaveBeenCalled();
    expect(second.index.list()[0]?.title).toBe('title a');
  });

  it('survives a corrupt cache file by rebuilding', async () => {
    writeFileSync(join(dir, SESSION_CACHE_FILE), '{ nope');
    const { index } = make([file('a', 2)], async (batch, onRows) => onRows(batch.map((f) => row(f.id, { mtimeMs: f.mtimeMs }))));
    await index.refresh();
    expect(index.list()[0]?.title).toBe('title a');
  });

  it('keeps an unreadable file visible and groups one folder spelled two ways together', async () => {
    const { index } = make([file('a', 3), file('bad', 2), file('c', 1)], async (batch, onRows) => onRows([
      row('a', { mtimeMs: 3, cwd: 'D:\\Work\\Repo' }),
      row('bad', { mtimeMs: 2, unreadable: true, title: null, cwd: '' }),
      row('c', { mtimeMs: 1, cwd: 'd:/work/repo' }),
    ]));
    await index.refresh();
    const rows = index.list();
    expect(rows.find((r) => r.id === 'bad')?.unreadable).toBe(true);
    expect(rows.find((r) => r.id === 'a')?.groupKey).toBe(rows.find((r) => r.id === 'c')?.groupKey);
  });

  it('filters by title, folder and model, and flags sessions a terminal holds', async () => {
    const { index } = make([file('locked', 2), file('free', 1)], async (batch, onRows) => onRows(batch.map((f) => row(f.id, { mtimeMs: f.mtimeMs, live: true, title: f.id === 'free' ? 'refactor parser' : 'fix login' }))));
    await index.refresh();
    expect(index.list('parser').map((r) => r.id)).toEqual(['free']);
    expect(index.list().find((r) => r.id === 'locked')?.liveElsewhere).toBe(true);
    expect(index.list().find((r) => r.id === 'free')?.liveElsewhere).toBe(false);
  });

  it('drops cache entries for files that were deleted', async () => {
    const files = [file('a', 2), file('b', 1)];
    const { index } = make(files, async (batch, onRows) => onRows(batch.map((f) => row(f.id, { mtimeMs: f.mtimeMs }))));
    await index.refresh();
    files.pop();
    await index.refresh();
    index.persistNow();
    expect(Object.keys(JSON.parse(readFileSync(join(dir, SESSION_CACHE_FILE), 'utf8')).rows)).toEqual(['a']);
  });
});
