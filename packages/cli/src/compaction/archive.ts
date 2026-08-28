/**
 * The compaction archive - a compaction stops being irreversible
 * (context-auto-compaction-hardening §3.5 / W4).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`), and that INCLUDES the field names below and every
 * string `/compact history` and `/compact show` print.
 *
 * WHAT THIS IS FOR. Round 1's non-goal was stated plainly: "the dropped messages
 * are gone". Combined with R-1 - "the summary is wrong or lossy, and the agent
 * proceeds confidently on a false record... this is the feature's defining risk
 * and it cannot be eliminated" - the product was asking the user to accept an
 * unverifiable, unrecoverable transformation of their session. That is the wrong
 * default for a tool that runs unattended. This does not add undo (§12: restoring
 * an over-full history re-creates the condition that triggered compaction). It
 * adds FIDELITY ON DISK, so R-1 becomes something a human can check.
 *
 * NO IMPORTS FROM `ui/`. This module writes files and formats two report blocks;
 * it has no terminal, no theme and no glyphs.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@aragon-agent/core';
import { getCompactionArchiveDir } from '../config/app-paths.js';
import { getLogger } from '../logging/logger.js';
import { COMPACTION_BLOCK_VERSION, COMPACTION_LIMITS } from './limits.js';
import type { CompactionMode, CompactionUiTrigger } from './types.js';

const FILE_PREFIX = 'compaction-';
const FILE_SUFFIX = '.json';

/** Bumped only when the SHAPE changes; the reader rejects anything else. */
export const ARCHIVE_FORMAT_VERSION = 1;

export interface CompactionArchive {
  version: number;
  /** `COMPACTION_BLOCK_VERSION` at write time, so a bad summary ties to a revision. */
  blockVersion: string;
  createdAt: number;
  /**
   * Which process wrote this.
   *
   * STORED INSIDE THE DOCUMENT as well as in the name, so a file renamed or
   * copied by hand is still self-describing and the reader never has to parse a
   * filename for meaning it cannot verify.
   */
  runId: string;
  /** 1-based within this run. */
  index: number;
  trigger: CompactionUiTrigger;
  mode: CompactionMode;
  model: string;
  generation: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /**
   * THE NUMBER. Deliberately not called `droppedMessages`: that name already
   * means a COUNT in three typed places (`CompactionPlan`, `finish`'s `applied`
   * argument, and `AgentEvent.compaction_end`), and this is the document someone
   * reads while diagnosing a bad summary (RV-3).
   */
  droppedCount: number;
  summary?: string;
  tailRelief?: { messages: number; charsRemoved: number };
  /** True when `dropped` was shortened to fit `archiveMaxBytes`. */
  clipped: boolean;
  /** THE ARRAY. Verbatim, oldest first. */
  dropped: Message[];
}

/** One row of `/compact history`, already resolved from disk. */
export interface ArchiveListing {
  entries: ArchiveEntry[];
  /** Archives in the directory belonging to OTHER runs. Counted, never listed. */
  otherRuns: number;
  dir: string;
}

export interface ArchiveEntry {
  path: string;
  fileName: string;
  index: number;
  createdAt: number;
  trigger: CompactionUiTrigger;
  mode: CompactionMode;
  model: string;
  tokensBefore: number;
  tokensAfter: number;
  droppedCount: number;
  summary?: string;
  tailRelief?: { messages: number; charsRemoved: number };
  clipped: boolean;
}

export interface ArchiveWriteInput {
  runId: string;
  index: number;
  trigger: CompactionUiTrigger;
  mode: CompactionMode;
  model: string;
  generation: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  summary?: string;
  tailRelief?: { messages: number; charsRemoved: number };
  dropped: Message[];
  /** Injected by the tests; production passes nothing. */
  dir?: string;
  now?: number;
}

/**
 * `compaction-<YYYY-MM-DD>-<hhmmss>-<runId>-<index>.json`.
 *
 * THE RUN ID IS IN THE NAME BECAUSE THE DIRECTORY IS SHARED (RV-6).
 * `file-sink.ts` makes log retention best-effort precisely because "on Windows
 * another `aragon` process may hold a handle on a file we would like to remove",
 * so concurrent CLI processes are an acknowledged in-tree condition rather than
 * an edge case. Without this segment `/compact history` presents another
 * session's compactions as this one's and `/compact show 2` is ambiguous the
 * moment two runs both reach their second compaction.
 */
export function archiveFileName(runId: string, index: number, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${FILE_PREFIX}${date}-${time}-${runId}-${index}${FILE_SUFFIX}`;
}

/**
 * The inverse of `archiveFileName`, or `null` when the name is not one of ours.
 *
 * AN EXACT PARSE RATHER THAN `name.includes('-' + runId + '-')`, because that
 * substring test is not the question either caller is asking. A run id is a pid
 * in base 36 followed by four base-36 characters of the clock, so a six-character
 * all-digit one matches the `hhmmss` segment of EVERY other run's file written at
 * that second - and the two places this attribution is used are precisely the two
 * RV-6 exists to protect: retention deleting a neighbour's archive, and
 * `/compact history` presenting one as this run's.
 *
 * KEEP IT IN STEP WITH `archiveFileName` ABOVE. The two are one format, written
 * adjacently so a change to either is visible against the other.
 */
function parseArchiveName(name: string): { runId: string; index: number } | null {
  const match = /^compaction-\d{4}-\d{2}-\d{2}-\d{6}-(.+)-(\d+)\.json$/.exec(name);
  if (!match) return null;
  return { runId: match[1]!, index: Number(match[2]) };
}

/**
 * Mint this process's archive key.
 *
 * NOT `SessionMeta.id`: that exists only once a session has been SAVED, and the
 * unattended long run this feature serves is exactly the one nobody saved. Short,
 * filename-safe, and only ever compared for equality - a grouping key, not an
 * identity.
 */
export function mintRunId(pid: number = process.pid, now: number = Date.now()): string {
  return `${pid.toString(36)}${now.toString(36).slice(-4)}`;
}

/**
 * Serialize, clipping the dropped bodies from the OLDEST end if the document
 * exceeds `archiveMaxBytes`.
 *
 * THE METADATA AND THE SUMMARY ARE NEVER CLIPPED. A truncated archive that still
 * says what happened, when, and with which model beats no archive at all - and
 * the oldest dropped messages are the least likely to be the ones a human came
 * looking for.
 */
export function serializeArchive(doc: CompactionArchive, maxBytes: number): string {
  let dropped = doc.dropped;
  let clipped = doc.clipped;
  let text = JSON.stringify({ ...doc, dropped, clipped }, null, 2);
  while (Buffer.byteLength(text, 'utf8') > maxBytes && dropped.length > 0) {
    // HALVED RATHER THAN SHIFTED ONE AT A TIME: a 100 MB archive of 4 000
    // messages would otherwise re-serialize 4 000 times, inside a write that is
    // supposed to be invisible to the run.
    dropped = dropped.slice(Math.max(1, Math.ceil(dropped.length / 2)));
    clipped = true;
    text = JSON.stringify({ ...doc, dropped, clipped }, null, 2);
  }
  return text;
}

/**
 * Write one archive, then prune. Returns the path written, or `null`.
 *
 * NEVER THROWS. The caller runs inside an event handler on the compaction path;
 * a filesystem is not allowed to affect whether a session survives its context
 * window. Every failure is a `warn` with the path and nothing else - a toast for
 * a best-effort audit file trains users to ignore toasts.
 */
export function writeArchive(input: ArchiveWriteInput): string | null {
  const dir = input.dir ?? getCompactionArchiveDir();
  const now = input.now ?? Date.now();
  const path = join(dir, archiveFileName(input.runId, input.index, new Date(now)));
  try {
    mkdirSync(dir, { recursive: true });
    const doc: CompactionArchive = {
      version: ARCHIVE_FORMAT_VERSION,
      blockVersion: COMPACTION_BLOCK_VERSION,
      createdAt: now,
      runId: input.runId,
      index: input.index,
      trigger: input.trigger,
      mode: input.mode,
      model: input.model,
      generation: input.generation,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      messagesBefore: input.messagesBefore,
      messagesAfter: input.messagesAfter,
      droppedCount: input.dropped.length,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.tailRelief ? { tailRelief: input.tailRelief } : {}),
      clipped: false,
      dropped: input.dropped,
    };
    writeFileSync(path, serializeArchive(doc, COMPACTION_LIMITS.archiveMaxBytes), 'utf8');
  } catch (err) {
    getLogger()
      .child('compaction')
      .warn('compaction_archive_failed', { path, error: errorText(err) });
    return null;
  }
  pruneArchives(input.runId, dir, now);
  return path;
}

/**
 * Two-tier retention, and the ORDER MATTERS (§3.5.2 / RV-6).
 *
 *  1. WITHIN THIS RUN: keep the newest `archiveMaxFiles` files carrying THIS
 *     `runId`. This is the bound that protects the user from their own long
 *     session, and it can never touch another run.
 *  2. ACROSS RUNS: delete files older than `archiveMaxAgeMs`, regardless of
 *     `runId`, so an abandoned run's archives do not accumulate forever. AGE, not
 *     count - a count-based global prune is exactly the rule that deletes a live
 *     session's work while it is still running.
 *
 * Best-effort throughout, in the `enforceRetention` shape: every `rmSync` in its
 * own `try`, a locked file skipped rather than fatal.
 */
export function pruneArchives(runId: string, dir: string, now: number): void {
  let files: { path: string; name: string; mtime: number }[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .map((name) => {
        const path = join(dir, name);
        try {
          return { path, name, mtime: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; name: string; mtime: number } => e !== null);
  } catch {
    return; // The directory does not exist yet, or is unreadable.
  }

  const mine = files
    .filter((f) => parseArchiveName(f.name)?.runId === runId)
    .sort((a, b) => a.mtime - b.mtime);
  for (const f of mine.slice(0, Math.max(0, mine.length - COMPACTION_LIMITS.archiveMaxFiles))) {
    remove(f.path);
  }

  for (const f of files) {
    if (now - f.mtime > COMPACTION_LIMITS.archiveMaxAgeMs) remove(f.path);
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Held by another instance. Retention is best-effort by design.
  }
}

/**
 * This run's archives, newest first, plus a COUNT of everyone else's.
 *
 * THE COUNT IS REPORTED RATHER THAN THE FILES, because the alternative is a user
 * concluding their own compactions went missing when the directory holds a
 * neighbour's.
 */
export function listArchives(runId: string, dirOverride?: string): ArchiveListing {
  const dir = dirOverride ?? getCompactionArchiveDir();
  const entries: ArchiveEntry[] = [];
  let otherRuns = 0;
  let names: string[];
  try {
    names = readdirSync(dir).filter(
      (name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX),
    );
  } catch {
    return { entries: [], otherRuns: 0, dir };
  }

  for (const name of names) {
    if (parseArchiveName(name)?.runId !== runId) {
      otherRuns += 1;
      continue;
    }
    const entry = readArchiveEntry(join(dir, name), name);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => b.index - a.index);
  return { entries, otherRuns, dir };
}

/** One archive by its `#n`, or `null`. `n` is the index within THIS run. */
export function findArchive(runId: string, index: number, dirOverride?: string): ArchiveEntry | null {
  return listArchives(runId, dirOverride).entries.find((e) => e.index === index) ?? null;
}

/**
 * Read one document's METADATA. The `dropped` array is never returned.
 *
 * `/compact show` prints no message bodies (DH-9): a single archive can be
 * megabytes and the transcript is not a pager. The path is the useful output.
 */
function readArchiveEntry(path: string, fileName: string): ArchiveEntry | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CompactionArchive>;
    if (raw.version !== ARCHIVE_FORMAT_VERSION) return null;
    return {
      path,
      fileName,
      index: Number(raw.index ?? 0),
      createdAt: Number(raw.createdAt ?? 0),
      trigger: (raw.trigger ?? 'pressure') as CompactionUiTrigger,
      mode: (raw.mode ?? 'none') as CompactionMode,
      model: String(raw.model ?? ''),
      tokensBefore: Number(raw.tokensBefore ?? 0),
      tokensAfter: Number(raw.tokensAfter ?? 0),
      droppedCount: Number(raw.droppedCount ?? 0),
      ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
      ...(raw.tailRelief ? { tailRelief: raw.tailRelief } : {}),
      clipped: raw.clipped === true,
    };
  } catch {
    // A half-written file from a process that was killed mid-write, or a format
    // from a future version. Skipping it is the only sensible reading.
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
