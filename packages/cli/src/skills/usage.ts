/**
 * Local skill-usage counters (spec §9) — the input that decides which skills
 * survive Level 1 truncation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS STORED: skill name, use count, last-used timestamp. NOTHING ELSE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * No arguments, no conversation content, no working directory, no machine id.
 * It never leaves this machine and it is never attached to any request. The
 * whole file can be deleted at any time — the only consequence is that the
 * catalog falls back to its pre-ranking order (I-A1). `skills.usageTracking:
 * false` switches it off entirely, and then nothing here reads or writes disk.
 *
 * FAILURE POLICY (D-A14): every function swallows its errors. This is ranking
 * metadata for a display list, not business data. A read-only home directory or
 * a half-written JSON file must degrade to "no usage data" — surfacing an error
 * would spend the user's attention on something whose worst outcome is a
 * slightly worse sort order.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillUsageMap, SkillUsageStat } from '@argon-agent/core/skills';
import { getUserDataDir } from './paths.js';

export const USAGE_FILENAME = 'skill-usage.json';
export const USAGE_SCHEMA = 1;

/** Coalescing window for disk writes. Losing this much on exit costs nothing. */
export const USAGE_FLUSH_DEBOUNCE_MS = 2000;

/** Entries kept before pruning kicks in. */
export const USAGE_MAX_ENTRIES = 500;

/**
 * `<data>/skill-usage.json` — deliberately a SIBLING of `<data>/skills/`, not a
 * child. The skills directory is a scan root; every extra file inside it is one
 * more thing the discovery walk has to recognise and skip.
 */
export function getUsagePath(): string {
  return join(getUserDataDir(), USAGE_FILENAME);
}

interface UsageFile {
  schema: number;
  skills: SkillUsageMap;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let memory: SkillUsageMap | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function isStat(value: unknown): value is SkillUsageStat {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SkillUsageStat>;
  return typeof v.useCount === 'number' && typeof v.lastUsedAt === 'number';
}

function readFromDisk(): SkillUsageMap {
  try {
    const parsed = JSON.parse(readFileSync(getUsagePath(), 'utf-8')) as UsageFile;
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.schema !== USAGE_SCHEMA) return {};
    if (!parsed.skills || typeof parsed.skills !== 'object') return {};
    const out: SkillUsageMap = {};
    for (const [name, stat] of Object.entries(parsed.skills)) {
      // A hand-edited file is a normal thing to encounter; keep the rows that
      // still make sense and drop the rest rather than discarding everything.
      if (!isStat(stat)) continue;
      out[name] = {
        useCount: Math.max(0, Math.floor(stat.useCount)),
        lastUsedAt: Math.max(0, Math.floor(stat.lastUsedAt)),
      };
    }
    return out;
  } catch {
    // Missing / unreadable / corrupt — all the same answer, and the file is
    // left alone: the user may have been editing it, and deleting their work to
    // tidy up our own state would be a strictly worse trade.
    return {};
  }
}

/** Read the usage map, caching it for the life of the process. */
export function loadUsage(): SkillUsageMap {
  if (memory === null) memory = readFromDisk();
  return memory;
}

/**
 * Drop entries for skills that no longer exist, then — if still over the cap —
 * the least recently used ones. Called opportunistically, never on a hot path.
 */
export function pruneUsage(knownNames: string[]): void {
  const map = loadUsage();
  const known = new Set(knownNames);
  let changed = false;

  for (const name of Object.keys(map)) {
    if (!known.has(name)) {
      delete map[name];
      changed = true;
    }
  }

  const names = Object.keys(map);
  if (names.length > USAGE_MAX_ENTRIES) {
    const oldestFirst = names.sort(
      (a, b) => (map[a]?.lastUsedAt ?? 0) - (map[b]?.lastUsedAt ?? 0),
    );
    for (const name of oldestFirst.slice(0, names.length - USAGE_MAX_ENTRIES)) {
      delete map[name];
      changed = true;
    }
  }

  if (changed) {
    dirty = true;
    scheduleFlush();
  }
}

/** Record one deliberate use of a skill. Cheap, in-memory, never throws. */
export function recordUse(name: string, now = Date.now()): void {
  if (name.length === 0) return;
  const map = loadUsage();
  const current = map[name];
  map[name] = {
    useCount: (current?.useCount ?? 0) + 1,
    lastUsedAt: now,
  };
  dirty = true;
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flushUsage();
  }, USAGE_FLUSH_DEBOUNCE_MS);
  // A pending counter write must never be the reason a one-shot `aragon skills
  // list` sits there for two seconds before exiting.
  timer.unref?.();
}

/** Write the map to disk now, if anything changed. Safe to call repeatedly. */
export function flushUsage(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty || memory === null) return;
  const path = getUsagePath();
  // Same tmp+rename discipline the config store uses: a process killed
  // mid-write must not leave a truncated file that reads back as "no usage".
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(getUserDataDir(), { recursive: true });
    const payload: UsageFile = { schema: USAGE_SCHEMA, skills: memory };
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tmp, path);
    dirty = false;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing further to try; the counters simply stay in memory.
    }
  }
}

// ---------------------------------------------------------------------------
// Visibility and erasure (§9 / FG7)
// ---------------------------------------------------------------------------

export interface UsageRow {
  name: string;
  useCount: number;
  lastUsedAt: number;
}

/**
 * Every counter on disk, most recently used first (ties broken by name).
 *
 * Reads even when `skills.usageTracking` is off: switching tracking off stops
 * new writes, but a user who wants to know what is already stored — and then
 * delete it — must not be told "nothing here" while the file still exists.
 */
export function listUsage(): UsageRow[] {
  const map = loadUsage();
  return Object.entries(map)
    .map(([name, stat]) => ({ name, useCount: stat.useCount, lastUsedAt: stat.lastUsedAt }))
    .sort((a, b) =>
      b.lastUsedAt !== a.lastUsedAt
        ? b.lastUsedAt - a.lastUsedAt
        : a.name.localeCompare(b.name, 'en'),
    );
}

/**
 * Delete the file, empty the cache, cancel any pending write, and clear `dirty`.
 * Returns how many entries were removed. Never throws (D-A14).
 *
 * CLEARING `dirty` IS NOT OPTIONAL. `recordUse()` sets it, and `flushUsage()`
 * only returns early when `!dirty || memory === null`. Reset the map without
 * resetting the flag and the very next flush — a scheduled one, or the explicit
 * call at the end of a CLI command — rebuilds the file from an empty map. The
 * user then sees `skill-usage.json` reappear seconds after deleting it, and only
 * under certain call orders, which is the worst possible way to learn that
 * "erase my data" did not.
 */
export function resetUsage(): number {
  const removed = Object.keys(loadUsage()).length;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  memory = {};
  dirty = false;
  try {
    rmSync(getUsagePath(), { force: true });
  } catch {
    // Same policy as everywhere else in this file: a counter file we could not
    // delete is not worth an error the user can do nothing about.
  }
  return removed;
}

/** Test-only: forget the cached map and any pending write. */
export function resetUsageForTests(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  memory = null;
  dirty = false;
}
