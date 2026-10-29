import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../shared/ipc-contract.js';
import {
  CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, UpdateFetchError, UpdateService, compareVersions, isAllowedUrl,
  parseManifest, type FetchText, type UpdateConfig, type UpdatePrefs,
} from '../update-service.js';

const HOSTS = ['downloads.example.com'];
const CONFIG: UpdateConfig = { feedUrl: 'https://downloads.example.com/latest.json', allowedHosts: HOSTS, allowLoopbackHttp: false };

const manifest = (patch: Record<string, unknown> = {}): string => JSON.stringify({
  version: '0.2.0', releasedAt: '2026-11-03T00:00:00Z', notesUrl: 'https://downloads.example.com/notes',
  downloadUrl: 'https://downloads.example.com/AragonAgent-0.2.0.exe', sha256: { 'win-x64': 'abc' }, ...patch,
});

function make(options: { config?: Partial<UpdateConfig>; prefs?: Partial<UpdatePrefs>; fetch?: FetchText; current?: string } = {}) {
  let prefs: UpdatePrefs = { enabled: true, feedUrl: null, skippedVersion: null, lastCheckedAt: 0, ...options.prefs };
  const statuses: UpdateStatus[] = [];
  const fetchText = vi.fn<FetchText>(options.fetch ?? (async () => manifest()));
  const service = new UpdateService({
    currentVersion: options.current ?? '0.1.0',
    config: { ...CONFIG, ...options.config },
    store: { read: () => prefs, write: (patch) => { prefs = { ...prefs, ...patch }; } },
    fetchText, now: () => 1_000, onStatus: (status) => statuses.push(status),
  });
  return { service, fetchText, statuses, prefs: () => prefs };
}

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.2.0', -1], ['0.2.0', '0.1.9', 1], ['1.0.0', '1.0.0', 0], ['0.9.0', '0.10.0', -1],
    ['1.0.0-beta.1', '1.0.0', -1], ['1.0.0-beta.2', '1.0.0-beta.10', -1], ['1.0.0-alpha', '1.0.0-beta', -1],
    ['v1.2.3', '1.2.3', 0], ['1.0.0+build5', '1.0.0', 0],
  ])('%s vs %s -> %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b)!)).toBe(expected);
  });

  it('is null for something that is not a version, never a number that could be misread', () => {
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
  });
});

describe('isAllowedUrl (the build-time host list is the only allowance)', () => {
  const cfg = { allowedHosts: HOSTS, allowLoopbackHttp: false };
  it('accepts https on a listed host, case-insensitively', () => {
    expect(isAllowedUrl('https://downloads.example.com/x', cfg)).toBe(true);
    expect(isAllowedUrl('https://DOWNLOADS.example.com/x', cfg)).toBe(true);
  });
  it.each([
    ['another host', 'https://evil.example.org/x'],
    ['a sub-domain nobody listed', 'https://a.downloads.example.com/x'],
    ['a look-alike prefix', 'https://downloads.example.com.evil.org/x'],
    ['plain http', 'http://downloads.example.com/x'],
    ['file:', 'file:///C:/Windows/System32/calc.exe'],
    ['javascript:', 'javascript:alert(1)'],
    ['credentials in the URL', 'https://user:pw@downloads.example.com/x'],
    ['not a URL', 'downloads.example.com/x'],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedUrl(url, cfg)).toBe(false);
  });
  it('allows loopback http ONLY when the harness flag is on', () => {
    expect(isAllowedUrl('http://127.0.0.1:5000/latest.json', cfg)).toBe(false);
    expect(isAllowedUrl('http://127.0.0.1:5000/latest.json', { ...cfg, allowLoopbackHttp: true })).toBe(true);
    expect(isAllowedUrl('http://evil.example.org/', { ...cfg, allowLoopbackHttp: true })).toBe(false);
  });
});

describe('parseManifest', () => {
  it('keeps only the fields it uses (sha256 is dropped, never presented as verified)', () => {
    const parsed = parseManifest(manifest(), CONFIG);
    expect(parsed).toEqual({
      version: '0.2.0', releasedAt: '2026-11-03T00:00:00Z',
      notesUrl: 'https://downloads.example.com/notes', downloadUrl: 'https://downloads.example.com/AragonAgent-0.2.0.exe',
    });
    expect(JSON.stringify(parsed)).not.toContain('sha256');
  });
  it('refuses a manifest whose downloadUrl is not allowed, and never lets it name its own allowed hosts', () => {
    expect(parseManifest(manifest({ downloadUrl: 'https://evil.example.org/a.exe' }), CONFIG)).toBeNull();
    expect(parseManifest(manifest({ downloadUrl: 'https://evil.example.org/a.exe', allowedHosts: ['evil.example.org'] }), CONFIG)).toBeNull();
    expect(parseManifest(manifest({ downloadUrl: 'file:///x' }), CONFIG)).toBeNull();
  });
  it('drops a notesUrl that is not allowed instead of failing the whole manifest', () => {
    expect(parseManifest(manifest({ notesUrl: 'https://evil.example.org/n' }), CONFIG)?.notesUrl).toBeUndefined();
  });
  it.each(['', 'not json', '[]', '{"version":"x","downloadUrl":"https://downloads.example.com/a"}', '{"version":"1.0.0"}'])(
    'rejects %j', (text) => { expect(parseManifest(text, CONFIG)).toBeNull(); });
});

describe('UpdateService.check', () => {
  it('reports an available update with the details the page needs', async () => {
    const { service, prefs } = make();
    expect(await service.check()).toEqual({
      state: 'available', version: '0.2.0', downloadUrl: 'https://downloads.example.com/AragonAgent-0.2.0.exe',
      notesUrl: 'https://downloads.example.com/notes', releasedAt: '2026-11-03T00:00:00Z',
    });
    expect(service.downloadUrl()).toBe('https://downloads.example.com/AragonAgent-0.2.0.exe');
    expect(prefs().lastCheckedAt).toBe(1_000);
  });

  it('says up to date when the feed is not newer', async () => {
    expect(await make({ current: '0.2.0' }).service.check()).toEqual({ state: 'uptodate', checkedAt: 1_000 });
    expect(await make({ current: '0.3.0' }).service.check()).toEqual({ state: 'uptodate', checkedAt: 1_000 });
  });

  it('does not push a pre-release at a stable build, but does at a pre-release one', async () => {
    const beta = async () => manifest({ version: '0.3.0-beta.1' });
    expect((await make({ fetch: beta }).service.check()).state).toBe('uptodate');
    expect((await make({ fetch: beta, current: '0.2.0-beta.1' }).service.check()).state).toBe('available');
  });

  it('stays quiet about a skipped version on a scheduled check but shows it when the user asks', async () => {
    const { service } = make({ prefs: { skippedVersion: '0.2.0' } });
    expect((await service.check()).state).toBe('uptodate');
    expect(service.downloadUrl()).toBeNull();
    expect((await service.check({ manual: true })).state).toBe('available');
  });

  it('a newer version than the skipped one is announced', async () => {
    const { service } = make({ prefs: { skippedVersion: '0.2.0' }, fetch: async () => manifest({ version: '0.2.1' }) });
    expect((await service.check()).state).toBe('available');
  });

  it('skipVersion persists, clears the offer and removes the download address', async () => {
    const { service, prefs } = make();
    await service.check();
    expect(service.skipVersion('0.2.0').state).toBe('uptodate');
    expect(prefs().skippedVersion).toBe('0.2.0');
    expect(service.downloadUrl()).toBeNull();
  });

  it('shares one request between concurrent checks', async () => {
    const { service, fetchText } = make();
    await Promise.all([service.check(), service.check(), service.check()]);
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a timeout', new UpdateFetchError('timeout', 't'), 'timeout'],
    ['a network failure', new UpdateFetchError('network', 'n'), 'network'],
    ['an oversize body', new UpdateFetchError('too_large', 'big'), 'bad_manifest'],
    ['an unexpected exception', new Error('boom'), 'network'],
  ] as const)('maps %s to an error state, never a thrown exception', async (_label, failure, kind) => {
    const { service } = make({ fetch: async () => { throw failure; } });
    expect(await service.check()).toEqual({ state: 'error', kind, checkedAt: 1_000 });
  });

  it('treats a malformed manifest as bad_manifest and offers nothing to open', async () => {
    const { service } = make({ fetch: async () => '{"nope":true}' });
    expect(await service.check()).toEqual({ state: 'error', kind: 'bad_manifest', checkedAt: 1_000 });
    expect(service.downloadUrl()).toBeNull();
  });

  it('is unsupported, and makes no request, with no feed, when switched off, or for a disallowed feed', async () => {
    for (const make1 of [
      make({ config: { feedUrl: null } }),
      make({ prefs: { enabled: false } }),
      make({ config: { feedUrl: 'https://evil.example.org/latest.json' } }),
      make({ prefs: { feedUrl: 'http://127.0.0.1:9/latest.json' } }),
    ]) {
      expect((await make1.service.check()).state).toBe('unsupported');
      expect(make1.fetchText).not.toHaveBeenCalled();
    }
  });

  it('uses the user\'s feed override when it passes the same host check', async () => {
    const { service, fetchText } = make({ prefs: { feedUrl: 'https://downloads.example.com/beta.json' } });
    await service.check();
    expect(fetchText.mock.calls[0]![0]).toBe('https://downloads.example.com/beta.json');
  });

  it('allows a loopback feed override only when the harness flag is on (release builds can never)', async () => {
    const loop = 'http://127.0.0.1:4010/latest.json';
    const closed = make({ prefs: { feedUrl: loop } });
    expect((await closed.service.check()).state).toBe('unsupported');
    const open = make({
      config: { allowLoopbackHttp: true, feedUrl: loop },
      fetch: async () => manifest({ downloadUrl: 'http://127.0.0.1:4010/a.exe', notesUrl: undefined }),
    });
    expect((await open.service.check()).state).toBe('available');
  });
});

describe('UpdateService schedule', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('checks once after the startup delay and then on the interval, and stops cleanly', async () => {
    const { service, fetchText } = make();
    service.start();
    expect(fetchText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(fetchText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetchText.mock.calls.length).toBeGreaterThanOrEqual(2);
    const before = fetchText.mock.calls.length;
    service.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(fetchText).toHaveBeenCalledTimes(before);
  });

  it('refreshSupport follows the preference without a restart', async () => {
    const holder = make({ prefs: { enabled: false } });
    expect(holder.service.current().state).toBe('unsupported');
    // flip the preference through the same store the service reads
    holder.prefs().enabled = true;
    expect(holder.service.refreshSupport().state).toBe('idle');
  });
});

describe('install (Tier-2 extension point)', () => {
  it('is not implemented and says so', () => {
    expect(make().service.install()).toBe(false);
  });
});
