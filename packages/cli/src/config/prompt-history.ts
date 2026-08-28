/**
 * The prompts the user submitted, as an append-only JSON Lines file at
 * `<home>/prompt-history.jsonl` (config-state-separation §4.3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT IN config.json ANY MORE: it used to be a `promptHistory`
 * array inside the config file, which meant every single submit rewrote the
 * whole file — API key section included — and left a user who opened
 * `config.json` to change their model scrolling past their own typing. A
 * config file holds what the user DECLARED; this holds what they DID.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * APPEND, never read-modify-write. Two `aragon` windows are an ordinary setup,
 * and `O_APPEND` + one `writeSync` per entry means they interleave instead of
 * overwriting each other's snapshots. It also means a process killed mid-write
 * costs one broken line rather than a truncated array that reads back as "your
 * history is gone" — hence the per-line tolerance in `parseLine`.
 *
 * FAILURE POLICY (C2), the same one `skills/usage.ts` documents: every function
 * here swallows its errors. This is recall convenience; a read-only home
 * directory must degrade to "no history", never to a CLI that will not start.
 * The one thing that policy makes dangerous is a MISSING WRITE — it would be
 * invisible — which is why the write path creates `<home>` first and why a
 * failed append is logged rather than merely ignored.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import process from 'node:process';
import { getHomeRoot, getPromptHistoryPath } from './app-paths.js';
import { PROMPT_HISTORY_CAP } from './schema.js';
import { getLogger } from '../logging/logger.js';

export const PROMPT_HISTORY_FILENAME = 'prompt-history.jsonl';
export const PROMPT_HISTORY_LINE_VERSION = 1;

/**
 * Longer submissions are not recorded at all (D-6).
 *
 * Storing a TRUNCATED copy would be worse than storing nothing: the user
 * presses `↑`, gets back something that looks complete, and sends half a
 * prompt. 16 KiB is far past anything typed by hand.
 */
export const PROMPT_ENTRY_MAX_CHARS = 16_384;

/** Physical lines tolerated before the file is rewritten down to the cap. */
export const HISTORY_COMPACT_AT_LINES = 400;

export interface PromptHistoryEntry {
  /** Line schema version. Lines with any other value are skipped, not fatal. */
  v: number;
  /** `Date.now()` at submit time. */
  ts: number;
  /** The prompt verbatim — never redacted (D-5). */
  text: string;
}

interface LoadedFile {
  entries: PromptHistoryEntry[];
  /** Non-empty physical lines, INCLUDING unparseable ones (compaction input). */
  lines: number;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let memory: string[] | null = null;
let loadedLines = 0;
let appendedLines = 0;

/**
 * Starts `true`, and that initial value is load-bearing (RV-5).
 *
 * `loadConfig()` calls `setHistoryEnabled()`, but the startup migration runs
 * BEFORE any `loadConfig()`. Something has to be true in that window, and
 * `true` is what the config key itself defaults to. The one case in that window
 * that must honour an explicit opt-out — importing a legacy `promptHistory` —
 * reads the value straight off the config file instead of trusting this flag
 * (see `migrate-state-out-of-config.ts`).
 */
let historyEnabled = true;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseLine(line: string): PromptHistoryEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<PromptHistoryEntry>;
    if (!parsed || typeof parsed !== 'object') return null;
    // Unknown versions are skipped rather than coerced: that is what lets a
    // future field be added without an older CLI reading the file as garbage.
    if (parsed.v !== PROMPT_HISTORY_LINE_VERSION) return null;
    if (typeof parsed.text !== 'string' || parsed.text.length === 0) return null;
    const ts = typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : 0;
    return { v: PROMPT_HISTORY_LINE_VERSION, ts, text: parsed.text };
  } catch {
    return null;
  }
}

/**
 * Read and parse the file. `null` means the read itself failed — distinct from
 * "no file yet", because compaction must not rewrite a file it could not read.
 */
function readFromDisk(): LoadedFile | null {
  const path = getPromptHistoryPath();
  if (!existsSync(path)) return { entries: [], lines: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const entries: PromptHistoryEntry[] = [];
  let lines = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    lines += 1;
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return { entries, lines };
}

/**
 * Drop repeats, keeping the LAST occurrence, then keep the newest `cap`.
 *
 * Oldest-first ordering is the contract `PromptInput` walks with `↑`/`↓`, and
 * "last occurrence wins" reproduces what the old in-config implementation did
 * with `filter(p => p !== text)` followed by an append.
 */
function dedupeEntries(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  const seen = new Set<string>();
  const reversed: PromptHistoryEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as PromptHistoryEntry;
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    reversed.push(entry);
  }
  reversed.reverse();
  return reversed.slice(-PROMPT_HISTORY_CAP);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * The recall list: oldest first, de-duplicated, capped. Cached for the life of
 * the process so `/reload` — which calls `loadConfig()` again — cannot discard
 * entries added during this session.
 *
 * Reads even when `historyEnabled` is false (RV-12): turning recording off
 * stops new writes, but someone who wants to see what is already stored before
 * deleting it must not be told "nothing here" while the file still exists.
 */
export function loadPromptHistory(): string[] {
  if (memory !== null) return memory;
  const read = readFromDisk() ?? { entries: [], lines: 0 };
  memory = dedupeEntries(read.entries).map((entry) => entry.text);
  loadedLines = read.lines;
  appendedLines = 0;
  return memory;
}

/** Every entry on disk with its timestamp, newest first. For `history list`. */
export function listPromptHistory(): PromptHistoryEntry[] {
  const read = readFromDisk();
  if (!read) return [];
  return [...read.entries].reverse();
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append one line. Returns whether it reached the disk.
 *
 * `mkdirSync` IS NOT DEFENSIVE NOISE — deleting it breaks a real user. `<home>`
 * is created by the logger (only when `log.toFile` is on) or by the first
 * config write (only when the user changes a setting); someone on a fresh
 * install who did neither has no directory here, `openSync` throws `ENOENT`,
 * the swallow below hides it, and their history silently never persists.
 *
 * A short-lived descriptor rather than a kept-open one: this is a once-per-
 * submit write, and a descriptor held for the life of the process would make
 * `aragon history clear` unable to delete the file on Windows.
 */
function appendLine(entry: PromptHistoryEntry): boolean {
  try {
    mkdirSync(getHomeRoot(), { recursive: true });
    const fd = openSync(getPromptHistoryPath(), 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    getLogger().warn('history', 'history_append_failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Record one submitted prompt and return THE UPDATED LIST.
 *
 * The return value is the whole point of the signature (RV-1). `App.tsx` writes
 * `setPromptHistory(appendPrompt(text))`: the recall list rendered by the
 * composer is React state, and a module-level array updated in here re-renders
 * nothing. Drop the return value and `↑` stops recalling what was just
 * submitted — but only until the next restart, which makes it about as hard to
 * diagnose as a bug in this area gets.
 *
 * Returns the current list unchanged when recording is off, the text is blank,
 * or the text is oversized, so callers never need a branch.
 */
export function appendPrompt(text: string, now = Date.now()): string[] {
  const current = loadPromptHistory();
  if (!historyEnabled) return current;
  if (text.trim().length === 0) return current;
  if (text.length > PROMPT_ENTRY_MAX_CHARS) {
    getLogger().debug('history', 'prompt_history_entry_too_large', {
      chars: text.length,
      max: PROMPT_ENTRY_MAX_CHARS,
    });
    return current;
  }

  memory = [...current.filter((prompt) => prompt !== text), text].slice(-PROMPT_HISTORY_CAP);

  if (appendLine({ v: PROMPT_HISTORY_LINE_VERSION, ts: now, text })) {
    appendedLines += 1;
    if (loadedLines + appendedLines > HISTORY_COMPACT_AT_LINES) compact();
  }
  return memory;
}

/**
 * Rewrite the file down to the cap.
 *
 * THE RE-READ ON THE FIRST LINE IS THE WHOLE POINT (RV-3). Writing this
 * process's in-memory array over the file would reintroduce exactly the
 * multi-instance clobbering that append-only exists to avoid — and not "a few
 * trailing entries" either, but everything every other instance wrote since
 * this one last read. A failed read therefore skips compaction entirely: the
 * file keeps growing and the next append tries again, which is strictly better
 * than replacing it with a stale snapshot.
 */
function compact(): void {
  const disk = readFromDisk();
  if (!disk) return;

  // Entries this session has but the file does not — normally none, since the
  // appends above are already on disk. It only matters if a read raced a write.
  const onDisk = new Set(disk.entries.map((entry) => entry.text));
  const carried: PromptHistoryEntry[] = (memory ?? [])
    .filter((text) => !onDisk.has(text))
    .map((text) => ({ v: PROMPT_HISTORY_LINE_VERSION, ts: Date.now(), text }));

  const kept = dedupeEntries([...disk.entries, ...carried]);
  const path = getPromptHistoryPath();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(getHomeRoot(), { recursive: true });
    const payload = kept.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
    // rename does not preserve mode everywhere, and this file holds the user's
    // prompts verbatim — re-apply it rather than hope (RV-6, as `store.ts` does).
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    memory = kept.map((entry) => entry.text);
    loadedLines = kept.length;
    appendedLines = 0;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing further to try; the original file is untouched either way.
    }
    getLogger().warn('history', 'history_compact_failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Migration-only: append the texts that are not in the file yet, returning how
 * many were written.
 *
 * Ignores `historyEnabled` on purpose — the caller decides, because it is the
 * only code that can see an explicit `historyEnabled: false` in the config file
 * before `loadConfig()` has run (§4.6 step 3).
 */
export function importLegacyPromptHistory(entries: string[]): number {
  const read = readFromDisk();
  if (!read) return 0;
  const known = new Set(read.entries.map((entry) => entry.text));
  let written = 0;
  for (const text of entries) {
    if (typeof text !== 'string') continue;
    if (text.trim().length === 0) continue;
    if (text.length > PROMPT_ENTRY_MAX_CHARS) continue;
    if (known.has(text)) continue;
    if (!appendLine({ v: PROMPT_HISTORY_LINE_VERSION, ts: Date.now(), text })) break;
    known.add(text);
    written += 1;
  }
  // The cache, if anything already built one, no longer matches the file.
  if (written > 0) memory = null;
  return written;
}

/** Delete the file and empty the cache. Returns how many entries were removed. */
export function clearPromptHistory(): number {
  const removed = readFromDisk()?.entries.length ?? 0;
  try {
    rmSync(getPromptHistoryPath(), { force: true });
  } catch {
    // Same policy as every other failure here: a file we could not delete is
    // not worth an error the user can do nothing about.
  }
  memory = [];
  loadedLines = 0;
  appendedLines = 0;
  return removed;
}

/** Called once by `loadConfig()` after `historyEnabled` has been resolved. */
export function setHistoryEnabled(enabled: boolean): void {
  historyEnabled = enabled;
}

/** Test-only: forget the cache, the line counters and the switch. */
export function resetPromptHistoryForTests(): void {
  memory = null;
  loadedLines = 0;
  appendedLines = 0;
  historyEnabled = true;
}
