/**
 * User-declared context windows, read from `~/.aragon-agent/model-windows.json`
 * (path owned by `app-paths.ts`).
 *
 * WHY THIS FILE EXISTS. `ModelRegistry.getContextWindow` resolves a window from
 * API discovery, the builtin model lists and the ten-entry catalog - and for
 * every other id (a gateway alias, a self-hosted model, a release too new for
 * the table) it returns the explicitly-untrusted 128k `fallback`. The gauge
 * then renders `?` forever, by design: it refuses to divide by a guessed
 * denominator. The one number that can make the denominator real is the user's
 * own, and `config.json`'s `contextWindow` key can only hold ONE of it. This
 * file is the per-model form of the same assertion.
 *
 * THE APPLICATION NEVER WRITES IT. A file the user owns by hand cannot be
 * clobbered by an upgrade, and its absence is the ordinary case, not an error.
 *
 * ASCII ONLY: `src/config/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`).
 */

import { readFileSync, statSync } from 'node:fs';
import { getLogger } from '../logging/logger.js';
import { getModelWindowsPath } from './app-paths.js';

/** Structural bounds only; there is no policy surface to tune here. */
export interface ModelWindowsLimits {
  /** Entries beyond this many are dropped, in file order. */
  readonly maxEntries: number;
  /** Keys longer than this are dropped rather than trusted as ids. */
  readonly maxKeyLength: number;
  /** A window below the smallest real context (1k) is a typo, not a limit. */
  readonly minWindow: number;
  /** A window above 1e9 tokens is also a typo; no model ships that today. */
  readonly maxWindow: number;
}

export const MODEL_WINDOWS_LIMITS: ModelWindowsLimits = {
  maxEntries: 512,
  maxKeyLength: 200,
  minWindow: 1_024,
  maxWindow: 1_000_000_000,
} as const;

/** Normalized model id -> declared window. Keys are stored ALREADY normalized. */
export type ModelWindowTable = ReadonlyMap<string, number>;

/**
 * Same normalization core's `catalogModelId` applies, restated here because it
 * is not part of Core's public surface and a second exporter would be a
 * dependency on an internal. Keep the two in step: a date-stamped id
 * (`kimi-k3-20260716`) and its bare form must resolve to one entry.
 */
export function normalizeModelKey(modelId: string): string {
  return modelId.trim().toLowerCase()
    .replace(/^(models|openai|anthropic|google)\//, '')
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
}

function isWindowValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= MODEL_WINDOWS_LIMITS.minWindow && value <= MODEL_WINDOWS_LIMITS.maxWindow;
}

/** What a parse produced, and whether the FILE itself was at fault. */
export interface ModelWindowsParse {
  table: ModelWindowTable;
  /**
   * True only when the text could not be understood at all (bad JSON, wrong
   * top-level type). A valid file with zero USABLE entries is `false`: the
   * user wrote JSON, the values were the problem, and every dead value was
   * already dropped rather than trusted.
   */
  malformed: boolean;
}

/**
 * Parse already-decoded text into a table. NEVER THROWS - a hand-edited file
 * is the rule here, not the exception, and a typo must cost the user one dead
 * entry, not the session. Two accepted shapes:
 *
 *   { "version": 1, "windows": { "kimi-k3": 1048576 } }
 *   { "kimi-k3": 1048576 }                        (bare map, same effect)
 *
 * The wrapper exists so the format can grow fields without a migration; the
 * bare map is accepted because the first shape a user types is the simple one.
 * A leading UTF-8 BOM is tolerated: `readFileSync(..., 'utf8')` does not strip
 * it, `JSON.parse` cannot parse it, and Notepad writes it by default.
 */
export function parseModelWindowsResult(text: string): ModelWindowsParse {
  const body = text.replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { table: new Map(), malformed: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { table: new Map(), malformed: true };
  }
  const record = parsed as Record<string, unknown>;
  const source = record.windows !== undefined && record.windows !== null &&
    typeof record.windows === 'object' && !Array.isArray(record.windows)
    ? record.windows as Record<string, unknown>
    : record;
  const table = new Map<string, number>();
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeModelKey(rawKey);
    if (key.length === 0 || key.length > MODEL_WINDOWS_LIMITS.maxKeyLength) continue;
    if (!isWindowValue(rawValue)) continue;
    table.set(key, rawValue);
    if (table.size >= MODEL_WINDOWS_LIMITS.maxEntries) break;
  }
  return { table, malformed: false };
}

/** The table alone, for callers that do not care why it might be empty. */
export function parseModelWindows(text: string): ModelWindowTable {
  return parseModelWindowsResult(text).table;
}

/**
 * Decode the raw bytes the way a Windows text editor may have saved them.
 *
 * `readFileSync(path, 'utf8')` alone fails THREE ways on this machine's most
 * common editors: a UTF-8 BOM survives into the string and kills `JSON.parse`,
 * and Notepad's "Unicode" saves are UTF-16LE (or BE), which decode as NUL-laden
 * mojibake. All three are silent feature-death for exactly the user who just
 * tried to configure it, so the sniff happens before any parse.
 */
function decodeModelWindowsFile(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Big-endian UTF-16: Node has no utf16be decoder, so swap pairs in place
    // on a COPY and reuse the little-endian decoder.
    const swapped = Buffer.from(bytes.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const high = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = high;
    }
    return swapped.toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('utf8');
}

/** Cache stamp: two files with the same mtime and size are assumed the same. */
interface FileStamp {
  mtimeMs: number;
  size: number;
}

/**
 * mtime-cached lookup over the file.
 *
 * WHY A STAT PER LOOKUP RATHER THAN A LOAD AT STARTUP: `getModelInfoFor` is
 * called on every measurement, and the meter's `refreshValidity` re-reads the
 * window precisely so a moved denominator (a `/model` switch, a live config
 * edit) re-measures without a relaunch. A user saving this file mid-session
 * gets the same treatment - `statSync` is microseconds, and the read itself
 * only happens when the stamp actually changes.
 *
 * THE STAMP IS mtimeMs+size, so a rewrite that lands in the SAME millisecond
 * with the SAME byte count serves the previous table once. Squeezing that
 * window shut would need a content hash per lookup, which is exactly the cost
 * the stamp exists to avoid; the next differing write clears it regardless.
 */
export class ModelWindows {
  private readonly path: string;
  private table: ModelWindowTable = new Map();
  private stamp: FileStamp | null = null;

  constructor(path: string = getModelWindowsPath()) {
    this.path = path;
  }

  /** The declared window for `modelId`, or `undefined` when nobody declared one. */
  lookup(modelId: string): number | undefined {
    this.refresh();
    return this.table.get(normalizeModelKey(modelId));
  }

  private refresh(): void {
    let stamp: FileStamp;
    try {
      const stats = statSync(this.path);
      stamp = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      // A deleted file (ENOENT) is a decision: drop the entries. Any OTHER
      // failure (EACCES, an antivirus lock) is transient, and blanking every
      // declared window because a scanner held the file open for 50 ms would
      // swing the gauge to `?` for a reason the user cannot see - keep the
      // last good table and try again on the next lookup.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.stamp = null;
        this.table = new Map();
      }
      return;
    }
    if (stamp.mtimeMs === this.stamp?.mtimeMs && stamp.size === this.stamp.size) return;
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch {
      return; // Appeared in the stat, gone in the read: try again next lookup.
    }
    const result = parseModelWindowsResult(decodeModelWindowsFile(bytes));
    if (result.malformed) {
      getLogger().warn(
        'config',
        'model-windows.json could not be parsed; ignoring it until it is fixed',
        { path: this.path },
      );
    }
    this.table = result.table;
    this.stamp = stamp;
  }
}
