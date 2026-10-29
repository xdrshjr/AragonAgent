/**
 * Notices when `config.json` changes under a running desktop app (a terminal saved a model
 * or theme), without ever reading a half-written file as news.
 *
 * Two mechanisms, because neither is enough alone:
 *   - a watcher on the HOME DIRECTORY, not the file: every writer replaces the file by
 *     rename, so a file-level watcher loses its inode after the first save;
 *   - a 5 s poll, because `fs.watch` silently drops events on network and synced drives and
 *     under some antivirus.
 * Both funnel into one comparison of the file's content revision, so a touch that changes
 * nothing, our own write echoing back, and the poll agreeing with the watcher are all the
 * same non-event.
 */

import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';

export interface ConfigRevisionReader {
  /** Current content revision of config.json and whether it parses. */
  read(): { revision: string; ok: boolean };
}

export interface ConfigWatcherOptions {
  homeRoot: string;
  configPath: string;
  reader: ConfigRevisionReader;
  onChange(change: { revision: string; ok: boolean }): void;
  debounceMs?: number;
  pollMs?: number;
  /** Injected for tests. */
  watchFn?: typeof watch;
}

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastRevision: string;
  private lastOk: boolean;
  private stopped = true;

  constructor(private readonly options: ConfigWatcherOptions) {
    const initial = options.reader.read();
    this.lastRevision = initial.revision;
    this.lastOk = initial.ok;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const { homeRoot, configPath, debounceMs = 150, pollMs = 5000 } = this.options;
    const target = basename(configPath);
    try {
      this.watcher = (this.options.watchFn ?? watch)(homeRoot, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== undefined && String(filename) !== target) return;
        this.schedule(debounceMs);
      });
      this.watcher.on('error', () => { this.closeWatcher(); });
    } catch {
      this.watcher = null; // the poll below still covers us
    }
    this.poll = setInterval(() => this.check(), pollMs);
    this.poll.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.closeWatcher();
  }

  /**
   * Record a revision WE just wrote so the echo is not reported. Cheaper than the file read
   * the check would do, and exact: the next check compares equal.
   */
  acknowledge(revision: string, ok = true): void {
    this.lastRevision = revision;
    this.lastOk = ok;
  }

  /** Force a comparison now (used by tests and after a restore). */
  check(): void {
    if (this.stopped) return;
    const current = this.options.reader.read();
    if (current.revision === this.lastRevision && current.ok === this.lastOk) return;
    this.lastRevision = current.revision;
    this.lastOk = current.ok;
    this.options.onChange(current);
  }

  private schedule(debounceMs: number): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.check();
    }, debounceMs);
  }

  private closeWatcher(): void {
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
  }
}
