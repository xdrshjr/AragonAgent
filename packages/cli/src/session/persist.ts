/**
 * Session save/resume (spec §6.3). Persists BOTH the engine `messages` and the
 * visual `entries`: on abort the loop breaks before pushing the in-flight
 * assistant message, so `messages` and `entries` legitimately diverge (R9).
 * `messages` is what the engine resends on resume; `entries` is the faithful
 * visual replay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Message, ModelRef } from '@aragon-agent/core';
import type { Entry } from '../agent/reducer.js';
import type { TodoItem } from '../todo/types.js';
import { getSessionsDir } from '../config/store.js';

/**
 * Bookkeeping `aragon exec` attaches to the sessions it owns
 * (cli-integration-surface §5.2).
 *
 * ITS PRESENCE IS ALSO A MARKER, AND THAT IS LOAD-BEARING (P1-5 / R-16). This
 * directory is SHARED with the TUI's `/save`: `resolveSessionPath` above puts
 * every bare-name and default `/save` target in `getSessionsDir()`. So
 * `aragon sessions list` / `prune` operate ONLY on files carrying `meta.id`,
 * which is what stops a maintenance command destroying conversations a human
 * saved by hand. Anything that starts writing `meta` from the TUI path must
 * revisit that scoping first.
 */
export interface SessionMeta {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** Cumulative across invocations, not per run. */
  turns: number;
  /** The CLI version that last wrote this file. */
  cli: string;
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SavedSession {
  version: number;
  savedAt: number;
  model: ModelRef;
  messages: Message[];
  entries: Entry[];
  /**
   * The live todo list at save time (todo-plan-execution §3.13).
   *
   * `SESSION_VERSION` STAYS 1: the field is additive and optional, `loadSession`
   * validates only that `messages` and `entries` are arrays, and an older file
   * simply yields `undefined` — which `restoreTodos` treats as "clear", the
   * right answer for a session that predates the feature (D-20 / D-22).
   */
  todos?: TodoItem[];
  /**
   * Written only by `aragon exec` (cli-integration-surface §5.2 / D-10).
   *
   * `SESSION_VERSION` STAYS 1 for the reason `todos?` records above, and this is
   * the precedent that file's own comments already set: the field is additive
   * and optional, and `loadSession` validates only array-ness of `messages` /
   * `entries`. A TUI `/save` file simply has no `meta`, which is exactly how
   * `sessions list` tells the two apart.
   */
  meta?: SessionMeta;
}

const SESSION_VERSION = 1;

/** Resolve a `/save` target: absolute/relative path, or a name in the data dir. */
export function resolveSessionPath(nameOrPath: string | undefined, cwd: string): string {
  if (!nameOrPath || nameOrPath.trim().length === 0) {
    return join(getSessionsDir(), `session-${defaultStamp()}.json`);
  }
  const value = nameOrPath.trim();
  if (isAbsolute(value)) return ensureJsonExt(value);
  if (value.includes('/') || value.includes('\\')) return ensureJsonExt(resolve(cwd, value));
  return join(getSessionsDir(), ensureJsonExt(value));
}

function ensureJsonExt(p: string): string {
  return p.endsWith('.json') ? p : `${p}.json`;
}

function defaultStamp(): string {
  // Filesystem-safe timestamp without punctuation that breaks on Windows.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Drop the live tool tail on the way to disk (agent-activity-presentation-live
 * D-24 / AC-34).
 *
 * THIS IS THE SERIALIZER, AND IT IS THE ONLY ONE (P1-2). `saveSession` writes
 * `entries` VERBATIM -- the module doc below says so in those words -- and
 * `agent/reducer.ts` contains no serializer at all, so a `/save` issued DURING a
 * run would capture `live` / `liveSeq` / `lastOutputAt` however carefully the
 * reducer were written.
 *
 * Three reasons to drop it, in order of weight: a resumed session's tail
 * describes a process that no longer exists; the settled `preview` supersedes it
 * entirely, so it is strictly redundant; and it is the only mutable-while-live
 * field a tool entry has, so persisting it would force a `normalizeLoadedEntries`
 * clause -- the class of clause round 1's D-9 exists for.
 *
 * STRIPPING RATHER THAN TRUSTING ABSENCE IS WHAT MAKES DECLINING THAT CLAUSE
 * HONEST. A tool entry saved mid-run keeps `status: 'running'` and
 * `normalizeLoadedEntries` has no clause for tool entries (it never has -- the
 * four it carries are all about other kinds). With the tail stripped, `showLive`
 * is false and the resumed card is byte-identical to what today's build draws
 * for the same file: one `running` row. With the tail present it would be a
 * multi-row card describing a process that died with the last session, counting
 * seconds against a `lastOutputAt` from yesterday.
 */
function stripLiveToolOutput(entries: Entry[]): Entry[] {
  return entries.map((e) =>
    e.kind === 'tool' &&
    (e.live !== undefined || e.liveSeq !== undefined || e.lastOutputAt !== undefined)
      ? { ...e, live: undefined, liveSeq: undefined, lastOutputAt: undefined }
      : e,
  );
}

/**
 * Drop the service tail on the way to disk, beside `stripLiveToolOutput` and for
 * the same three reasons (background-service-supervision §6).
 *
 * A resumed card's tail describes a PROCESS THAT NO LONGER EXISTS - it died with
 * the session, because nothing in this package outlives the CLI by design. The
 * tail is also the only unbounded field a service entry carries, and dropping it
 * keeps a saved session's size a function of how many services ran rather than
 * of how chatty they were.
 *
 * `rowsSeen` IS KEPT. It is the revision cursor, not display data, and a
 * restored card that reported 0 rows seen while `normalizeLoadedEntries` was
 * flipping its status would produce a revision collision with a live card that
 * genuinely has none.
 */
function stripServiceTail(entries: Entry[]): Entry[] {
  return entries.map((e) => (e.kind === 'service' && e.rows.length > 0 ? { ...e, rows: [] } : e));
}

/**
 * `data` GAINS `todos`, AND WIDENING `SavedSession` ALONE IS NOT ENOUGH (P0-2):
 * the writer below builds its payload from THIS parameter, not from the type, so
 * a `todos?` field on the interface with no field here would ship a key nothing
 * ever writes.
 *
 * `meta` JOINS ON EXACTLY THOSE TERMS (cli-integration-surface P2-6). Adding it
 * to `SavedSession` alone would type-check, `aragon exec` would appear to write
 * sessions, and `sessions list` would report none of them — because the marker
 * that identifies an exec-managed file would never be on disk. It is SPREAD
 * conditionally so a `/save` from the TUI, which passes no `meta`, produces a
 * payload with no such key and a file byte-identical to today's.
 */
export function saveSession(
  filePath: string,
  data: {
    model: ModelRef;
    messages: Message[];
    entries: Entry[];
    todos: TodoItem[];
    meta?: SessionMeta;
  },
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload: SavedSession = {
    version: SESSION_VERSION,
    savedAt: Date.now(),
    model: data.model,
    messages: data.messages,
    entries: stripServiceTail(stripLiveToolOutput(data.entries)),
    todos: data.todos,
    ...(data.meta ? { meta: data.meta } : {}),
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

/**
 * Settle any team entry that was saved mid-dispatch (team-subagents §5.3 / P1-5),
 * and any todo card that was saved mid-run (todo-plan-execution §3.8 / C-5).
 *
 * `saveSession` writes `entries` verbatim and `loadSession` validates only
 * array-ness, so a session saved while a dispatch was in flight resumes with a
 * `kind: 'team'` entry claiming `active: true` while nothing is running. TWO
 * things then go wrong at once: the card spins forever, and `Transcript`'s
 * settled boundary is MONOTONIC — an entry that never settles never reaches
 * `<Static>` and is re-rendered on every frame for the rest of the session.
 *
 * `aborted: true` is also simply TRUE: the children died with the process.
 *
 * This belongs in the LOAD path rather than the reducer because the reducer
 * never legitimately sees a stale-active entry — only the file does.
 */
export function normalizeLoadedEntries(entries: Entry[]): Entry[] {
  return entries.map((entry) => {
    if (entry.kind === 'team' && entry.active) {
      return { ...entry, active: false, aborted: true };
    }
    // `interrupted: true` is the todo analogue of the team entry's `aborted`,
    // and true for the same reason: the run behind the card died with the
    // process (P2-6). Without it a resumed `2/7` reads as a run still in flight.
    if (entry.kind === 'todo' && entry.live) {
      return { ...entry, live: false, interrupted: true };
    }
    // THE THIRD CLAUSE (llm-api-retry-backoff §6.4 / R-10 / AC-26). A card saved
    // mid-wait would resume claiming to be counting down to an instant in the past,
    // and — worse — it would never settle, so `Transcript`'s MONOTONIC boundary
    // would never advance past it and every frame for the rest of the session
    // would re-render the whole tail. `resumeAt` is dropped for the same reason
    // the phase changes: there is no attempt coming.
    if (entry.kind === 'retry' && (entry.phase === 'waiting' || entry.phase === 'retrying')) {
      return { ...entry, phase: 'interrupted', resumeAt: undefined };
    }
    // THE FOURTH CLAUSE (fast-model-tier §5.4 / C-5 / AC-28). A review card
    // saved while its call was open resumes claiming to be running while nothing
    // is, and — the part that actually costs — it never settles, so
    // `Transcript`'s MONOTONIC boundary never advances past it and every frame
    // for the rest of the session re-renders the whole tail.
    //
    // `dropped` rather than `failed`: the review did not fail, it never got an
    // answer, and its critique died with the process.
    if (entry.kind === 'fast' && entry.live) {
      return {
        ...entry,
        live: false,
        status: 'dropped',
        detail: 'interrupted (session resumed)',
      };
    }
    // THE FIFTH CLAUSE (context-auto-compaction §5.5 / C-8 / AC-19). A compaction
    // card saved while its summarization was open resumes claiming to be running
    // while nothing is, and — the part that actually costs — it never settles, so
    // `Transcript`'s MONOTONIC boundary never advances past it and every frame for
    // the rest of the session re-renders the whole tail.
    //
    // `applied: false` is also simply TRUE: whatever the call was going to
    // return died with the process, and the history on disk is the PRE-compaction
    // one. A card that claimed otherwise would tell the user their session had
    // been compacted when it had not.
    if (entry.kind === 'compaction' && entry.live) {
      return {
        ...entry,
        live: false,
        applied: false,
        mode: 'none',
        reason: 'interrupted (session resumed)',
      };
    }
    // THE SIXTH CLAUSE (background-service-supervision §6 / R-7). A card saved
    // while its service was up resumes claiming to be running while nothing is -
    // the process died with the session, because nothing here outlives the CLI.
    //
    // AND `starting` IS THE ONE THAT ACTUALLY COSTS: it is the single service
    // status that blocks `Transcript`'s MONOTONIC settled boundary (D-11), so a
    // restored `starting` card would never settle and every frame for the rest of
    // the session would re-render the whole tail. `ready` / `running` would
    // "only" be a lie; this one is a lie that gets slower.
    //
    // `stopped` rather than `exited`: we did not observe an exit code, and
    // claiming one would be inventing a number. The terminal record the session
    // may also carry is already terminal and is left alone.
    if (
      entry.kind === 'service' &&
      (entry.status === 'starting' || entry.status === 'ready' || entry.status === 'running')
    ) {
      return { ...entry, status: 'stopped', rows: [] };
    }
    return entry;
  });
}

export function loadSession(filePath: string): SavedSession {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as SavedSession;
  if (!parsed || !Array.isArray(parsed.messages) || !Array.isArray(parsed.entries)) {
    throw new Error('Invalid session file (missing messages/entries).');
  }
  return { ...parsed, entries: normalizeLoadedEntries(parsed.entries) };
}
