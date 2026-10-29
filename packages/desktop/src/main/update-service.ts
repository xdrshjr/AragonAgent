/**
 * Update NOTIFICATION. Not an updater.
 *
 * It reads one small JSON manifest from a feed URL, compares versions and tells the user that a
 * newer build exists, with a button that opens the download page in their browser. It never
 * downloads a file, never runs anything and never verifies a signature - so there is no updater
 * to hijack. (An in-place installer is a separate, certificate-gated tier; `install()` is its
 * extension point and answers `false`.)
 *
 * The URLs are the attack surface, so they are checked against a host list that is fixed when the
 * app is BUILT. Neither the manifest nor `desktop-state.json` can add to it; if the manifest could
 * name its own allowed hosts, whoever could alter the manifest could also allow their own site.
 * Loopback `http` is permitted only in the `e2e` flavor, where the harness serves a fake feed.
 *
 * `sha256` in the manifest is display-only. Nothing here checks it and nothing may imply that it
 * was checked.
 *
 * Electron-free on purpose: the network fetch is injected (see `update-fetch.ts`), so every branch
 * here is unit-tested without a window.
 */

import type { UpdateStatus } from '../shared/ipc-contract.js';

export const FIRST_CHECK_DELAY_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_MANIFEST_BYTES = 64 * 1024;

export type FetchFailureKind = 'timeout' | 'network' | 'too_large';

export class UpdateFetchError extends Error {
  constructor(readonly kind: FetchFailureKind, message: string) {
    super(message);
    this.name = 'UpdateFetchError';
  }
}

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
}

/** Returns the response body as text; throws {@link UpdateFetchError}. */
export type FetchText = (url: string, options: FetchOptions) => Promise<string>;

export interface UpdateConfig {
  /** Build-time feed. `null` means this build has no update feed. */
  feedUrl: string | null;
  /** Hosts `https` URLs may point at. Fixed at build time. */
  allowedHosts: readonly string[];
  /** `http://127.0.0.1` / `localhost` accepted (the `e2e` flavor only). */
  allowLoopbackHttp: boolean;
}

/** The persisted, user-editable part. */
export interface UpdatePrefs {
  enabled: boolean;
  feedUrl: string | null;
  skippedVersion: string | null;
  lastCheckedAt: number;
}

export interface UpdateStore {
  read(): UpdatePrefs;
  write(patch: Partial<UpdatePrefs>): void;
}

export interface UpdateServiceDeps {
  currentVersion: string;
  config: UpdateConfig;
  store: UpdateStore;
  fetchText: FetchText;
  onStatus?(status: UpdateStatus): void;
  now?(): number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface Manifest {
  version: string;
  releasedAt?: string;
  notesUrl?: string;
  downloadUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

interface ParsedVersion { core: [number, number, number]; pre: string[] }

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw: string): ParsedVersion | null {
  const match = SEMVER.exec(raw.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** Negative when `a` is older than `b`; `null` when either is not a version. Semver precedence. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isAllowedUrl(raw: string, config: Pick<UpdateConfig, 'allowedHosts' | 'allowLoopbackHttp'>): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') return config.allowedHosts.some((allowed) => allowed.toLowerCase() === host);
  if (url.protocol === 'http:') return config.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname === '::1' ? '[::1]' : host);
  return false;
}

/** The manifest, or `null` when it is not one. Unknown fields (including `sha256`) are dropped. */
export function parseManifest(text: string, config: Pick<UpdateConfig, 'allowedHosts' | 'allowLoopbackHttp'>): Manifest | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const version = record.version;
  const downloadUrl = record.downloadUrl;
  if (typeof version !== 'string' || parseVersion(version) === null) return null;
  if (typeof downloadUrl !== 'string' || !isAllowedUrl(downloadUrl, config)) return null;
  const notesUrl = typeof record.notesUrl === 'string' && isAllowedUrl(record.notesUrl, config) ? record.notesUrl : undefined;
  const releasedAt = typeof record.releasedAt === 'string' && !Number.isNaN(Date.parse(record.releasedAt))
    ? record.releasedAt : undefined;
  return { version, downloadUrl, ...(notesUrl ? { notesUrl } : {}), ...(releasedAt ? { releasedAt } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

export class UpdateService {
  private status: UpdateStatus;
  private available: Manifest | null = null;
  private inflight: Promise<UpdateStatus> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.status = this.initialStatus();
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private feed(): string | null {
    const prefs = this.deps.store.read();
    return prefs.feedUrl ?? this.deps.config.feedUrl;
  }

  private initialStatus(): UpdateStatus {
    const unsupported = this.unsupportedReason();
    return unsupported ? { state: 'unsupported', message: unsupported } : { state: 'idle' };
  }

  /** Why no check can run, or `null` when one can. */
  private unsupportedReason(): string | null {
    const prefs = this.deps.store.read();
    if (!prefs.enabled) return 'Update checks are switched off in Settings.';
    const feed = this.feed();
    if (!feed) return 'This build has no update feed configured. Download new versions from the project releases page.';
    if (!isAllowedUrl(feed, this.deps.config)) return 'The configured update feed is not an allowed address.';
    return null;
  }

  current(): UpdateStatus { return this.status; }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status;
    this.deps.onStatus?.(status);
    return status;
  }

  /**
   * One check. Concurrent calls share the same request. `manual` shows an update the user
   * previously skipped (they asked, so the answer should be the truth); scheduled checks do not.
   */
  check(options: { manual?: boolean } = {}): Promise<UpdateStatus> {
    if (this.inflight) return this.inflight;
    const unsupported = this.unsupportedReason();
    if (unsupported) return Promise.resolve(this.set({ state: 'unsupported', message: unsupported }));
    this.inflight = this.run(options.manual === true).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(manual: boolean): Promise<UpdateStatus> {
    this.set({ state: 'checking' });
    const feed = this.feed()!;
    let body: string;
    try {
      body = await this.deps.fetchText(feed, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_MANIFEST_BYTES });
    } catch (error) {
      const kind = error instanceof UpdateFetchError ? error.kind : 'network';
      return this.set({ state: 'error', kind: kind === 'timeout' ? 'timeout' : kind === 'too_large' ? 'bad_manifest' : 'network', checkedAt: this.now() });
    }
    const checkedAt = this.now();
    this.deps.store.write({ lastCheckedAt: checkedAt });
    const manifest = parseManifest(body, this.deps.config);
    if (!manifest) return this.set({ state: 'error', kind: 'bad_manifest', checkedAt });

    this.available = null;
    const order = compareVersions(this.deps.currentVersion, manifest.version);
    if (order === null || order >= 0) return this.set({ state: 'uptodate', checkedAt });
    // A pre-release is never pushed at a user running a stable build.
    const prerelease = (parseVersion(manifest.version)?.pre.length ?? 0) > 0;
    const runningPrerelease = (parseVersion(this.deps.currentVersion)?.pre.length ?? 0) > 0;
    if (prerelease && !runningPrerelease) return this.set({ state: 'uptodate', checkedAt });
    if (!manual && this.deps.store.read().skippedVersion === manifest.version) {
      return this.set({ state: 'uptodate', checkedAt });
    }
    this.available = manifest;
    return this.set({
      state: 'available', version: manifest.version, downloadUrl: manifest.downloadUrl,
      ...(manifest.notesUrl ? { notesUrl: manifest.notesUrl } : {}),
      ...(manifest.releasedAt ? { releasedAt: manifest.releasedAt } : {}),
    });
  }

  /** Stop mentioning this version (until a newer one appears or the user checks by hand). */
  skipVersion(version: string): UpdateStatus {
    this.deps.store.write({ skippedVersion: version });
    if (this.status.state === 'available' && this.status.version === version) {
      this.available = null;
      return this.set({ state: 'uptodate', checkedAt: this.now() });
    }
    return this.status;
  }

  /** The URL to open, from the manifest that produced the current `available` status. Re-validated. */
  downloadUrl(): string | null {
    const manifest = this.available;
    if (!manifest || !isAllowedUrl(manifest.downloadUrl, this.deps.config)) return null;
    return manifest.downloadUrl;
  }

  /** Tier-2 extension point (certificate-gated in-place install). Not implemented. */
  install(): boolean { return false; }

  /** First check after a short delay (startup is busy enough), then every six hours. */
  start(): void {
    this.stop();
    const timeout = this.deps.setTimer ?? setTimeout;
    const every = this.deps.setIntervalFn ?? setInterval;
    this.firstTimer = timeout(() => { void this.check(); }, FIRST_CHECK_DELAY_MS);
    this.interval = every(() => { void this.check(); }, CHECK_INTERVAL_MS);
    // Neither timer may keep the process alive on its own.
    (this.firstTimer as { unref?: () => void }).unref?.();
    (this.interval as { unref?: () => void }).unref?.();
  }

  stop(): void {
    (this.deps.clearTimer ?? clearTimeout)(this.firstTimer ?? undefined);
    (this.deps.clearIntervalFn ?? clearInterval)(this.interval ?? undefined);
    this.firstTimer = null;
    this.interval = null;
  }

  /** The preference changed: re-derive whether a check can run. */
  refreshSupport(): UpdateStatus {
    const unsupported = this.unsupportedReason();
    if (unsupported) return this.set({ state: 'unsupported', message: unsupported });
    return this.status.state === 'unsupported' ? this.set({ state: 'idle' }) : this.status;
  }
}
