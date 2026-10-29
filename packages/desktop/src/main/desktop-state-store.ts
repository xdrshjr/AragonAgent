/**
 * Reads and writes `<home>/desktop-state.json` (window geometry, recent workspaces, language,
 * ...). Electron-free so it can be unit-tested against a temp directory.
 *
 * A damaged file is NEVER fatal and never silently discarded: it is renamed to
 * `desktop-state.json.corrupt-<ts>`, defaults take over, and `corruptNotice` tells the
 * Diagnostics page once what happened to it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DESKTOP_STATE_FILE,
  defaultDesktopState,
  migrateLegacyInspectorWidth,
  normalizeDesktopState,
  serializeDesktopState,
  type DesktopState,
} from '../shared/desktop-state.js';

export class DesktopStateStore {
  private state: DesktopState = defaultDesktopState();
  private noticeText: string | null = null;
  private loaded = false;

  /** `homeRoot: null` keeps everything in memory (before the engine has told us the home). */
  constructor(private readonly homeRoot: string | null, private readonly now: () => number = Date.now) {}

  get path(): string {
    return join(this.homeRoot ?? '', DESKTOP_STATE_FILE);
  }

  /** Set (once) when the file existed but could not be used. */
  get corruptNotice(): string | null {
    return this.noticeText;
  }

  /** Load from disk (idempotent). */
  load(): DesktopState {
    if (this.loaded) return this.state;
    this.loaded = true;
    if (this.homeRoot === null || !existsSync(this.path)) return this.state;
    try {
      this.state = normalizeDesktopState(migrateLegacyInspectorWidth(JSON.parse(readFileSync(this.path, 'utf8'))));
    } catch {
      const backup = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, backup);
        this.noticeText = `desktop-state.json was unreadable and was moved to ${backup}; defaults are in use.`;
      } catch {
        this.noticeText = 'desktop-state.json was unreadable; defaults are in use.';
      }
      this.state = defaultDesktopState();
    }
    return this.state;
  }

  get(): DesktopState {
    return this.load();
  }

  /** Merge a partial update, clamp it, and persist atomically. */
  patch(partial: Partial<Omit<DesktopState, 'extras' | 'schema'>>): DesktopState {
    const current = this.load();
    const merged = normalizeDesktopState({ ...serializeDesktopState(current), ...partial });
    this.state = merged;
    this.write();
    return merged;
  }

  private write(): void {
    if (this.homeRoot === null) return;
    mkdirSync(this.homeRoot, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(serializeDesktopState(this.state), null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
  }
}
