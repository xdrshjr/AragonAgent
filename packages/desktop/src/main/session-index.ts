/**
 * The sidebar's session list: stat first, parse later, cache across launches.
 *
 * `meta` is the last key of a session file, so a row can only be built by parsing the whole
 * file. With hundreds of long sessions that is far too slow for the main thread, so listing is
 * three-staged (spec 3.3):
 *   1. `scan()` (`readdir` + `stat`) gives an immediate skeleton ordered by mtime;
 *   2. a persistent cache keyed by `mtimeMs + size` fills every row it already knows;
 *   3. only the misses go to a worker thread, which answers in small batches that are merged
 *      and announced as they land.
 * A file that fails to parse keeps a visible "unreadable" row - the terminal's listing drops
 * it silently, which hides the one fact the user needs.
 *
 * The class is Electron-free: the parser, the scanner and the lock probe are injected.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionFileStat, SessionRowData } from '@aragon-agent/cli/dist/host/sessions.js';
import { workspaceGroupKey } from '../shared/desktop-state.js';
import type { SessionHostStatus, SessionRowDto } from '../shared/ipc-contract.js';

export const SESSION_CACHE_FILE = 'desktop-session-cache.json';
const CACHE_VERSION = 1;

export interface SessionParser {
  /** Parse the files; call `onRows` per batch; resolve when finished. */
  parse(files: SessionFileStat[], onRows: (rows: SessionRowData[]) => void): Promise<void>;
  dispose(): void;
}

export interface SessionIndexOptions {
  homeRoot: string;
  scan(): SessionFileStat[];
  parser: SessionParser;
  /** True when a live process that is not one of our hosts holds the session. */
  isLiveElsewhere(id: string): boolean;
  hostStatusOf(id: string): SessionHostStatus | null;
  onChanged(reason: 'files' | 'metadata'): void;
  caseInsensitiveVolume: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  row: SessionRowData;
}

export class SessionIndex {
  private files: SessionFileStat[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private job = 0;
  private cacheLoaded = false;

  constructor(private readonly options: SessionIndexOptions) {}

  private get cachePath(): string {
    return join(this.options.homeRoot, SESSION_CACHE_FILE);
  }

  private loadCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as {
        version?: number;
        rows?: Record<string, CacheEntry>;
      };
      if (raw.version !== CACHE_VERSION || !raw.rows) return;
      for (const [id, entry] of Object.entries(raw.rows)) this.cache.set(id, entry);
    } catch {
      // A damaged or missing cache is simply rebuilt; it holds nothing the files do not.
      this.cache.clear();
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
    this.persistTimer.unref?.();
  }

  persistNow(): void {
    try {
      mkdirSync(this.options.homeRoot, { recursive: true });
      const rows: Record<string, CacheEntry> = {};
      for (const [id, entry] of this.cache) rows[id] = entry;
      const tmp = `${this.cachePath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, rows }), 'utf8');
      renameSync(tmp, this.cachePath);
    } catch {
      /* The cache is an optimisation; failing to save it costs one slower launch. */
    }
  }

  /** Re-scan and parse whatever changed. Resolves when the background parse has finished. */
  async refresh(): Promise<void> {
    this.loadCache();
    const files = this.options.scan();
    const present = new Set(files.map((file) => file.id));
    for (const id of [...this.cache.keys()]) if (!present.has(id)) this.cache.delete(id);
    this.files = files;
    const misses = files.filter((file) => {
      const hit = this.cache.get(file.id);
      return !hit || hit.mtimeMs !== file.mtimeMs || hit.size !== file.size;
    });
    this.options.onChanged('files');
    if (misses.length === 0) return;
    const job = ++this.job;
    await this.options.parser.parse(misses, (rows) => {
      if (job !== this.job) return; // a newer refresh superseded this one
      for (const row of rows) this.cache.set(row.id, { mtimeMs: row.mtimeMs, size: row.size, row });
      this.persistSoon();
      this.options.onChanged('metadata');
    });
  }

  /** The current list, newest first, optionally filtered. Never blocks on parsing. */
  list(query?: string): SessionRowDto[] {
    this.loadCache();
    const needle = query?.trim().toLowerCase() ?? '';
    const rows: SessionRowDto[] = [];
    for (const file of this.files) {
      const cached = this.cache.get(file.id);
      const fresh = cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size;
      const data = fresh ? cached.row : null;
      const dto = this.toDto(file, data);
      if (needle && !`${dto.title ?? ''} ${dto.cwd} ${dto.model} ${dto.id}`.toLowerCase().includes(needle)) continue;
      rows.push(dto);
    }
    return rows;
  }

  private toDto(file: SessionFileStat, data: SessionRowData | null): SessionRowDto {
    const cwd = data?.cwd ?? '';
    return {
      id: file.id,
      title: data?.title ?? null,
      cwd,
      groupKey: cwd ? workspaceGroupKey(cwd, this.options.caseInsensitiveVolume) : '',
      updatedAt: data?.updatedAt ?? file.mtimeMs,
      turns: data?.turns ?? 0,
      provider: data?.provider ?? '',
      model: data?.model ?? '',
      origin: data?.origin ?? 'exec',
      pinned: data?.pinned ?? false,
      ...(data?.branchOf ? { branchOf: data.branchOf } : {}),
      unreadable: data?.unreadable ?? false,
      liveElsewhere: data?.live === true ? this.options.isLiveElsewhere(file.id) : false,
      pending: data === null,
      hostStatus: this.options.hostStatusOf(file.id),
    };
  }

  /** True once a row exists for this id (a brand-new session has no file yet). */
  has(id: string): boolean {
    return this.files.some((file) => file.id === id) || existsSync(join(this.options.homeRoot, 'sessions', `${id}.json`));
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistNow();
    this.options.parser.dispose();
  }
}
