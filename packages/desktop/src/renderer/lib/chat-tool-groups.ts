/**
 * Folding a run of read-only exploration into one row (completion spec P4, T-1..T-4).
 *
 * A tour of an unfamiliar codebase is a dozen reads and searches in a row. Each is a plain-language
 * card on its own, but together they push the actual answer off screen. This turns "read, read,
 * search, read, list" into ONE line ("Looked at 3 files, searched twice, browsed 1 folder") that
 * opens in place.
 *
 * It is a VIEW over the entries, computed while rendering: the reducer, the session file and the
 * export never see it (the export is a record and stays one block per call). Everything below is
 * about not swallowing something the reader should see - so it folds only calls that FINISHED
 * SUCCESSFULLY and only the three read-only families; anything that wrote, ran a command, failed,
 * is still running or waits for approval stays a card in its original place.
 */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { VoiceMode } from '@aragon-agent/tui/ui/tool-voice';
import { toolFamily } from './chat-format.js';

export type ToolEntry = Extract<Entry, { kind: 'tool' }>;

/** A run shorter than this stays as separate cards: folding two things saves nothing. */
export const MIN_GROUP_SIZE = 3;

export type GroupedFamily = 'read' | 'search' | 'list';
const GROUPED_FAMILIES: ReadonlySet<string> = new Set<GroupedFamily>(['read', 'search', 'list']);

export interface ToolGroupRow {
  kind: 'toolGroup';
  /** The first member's entry id: stable while the run grows at its tail. */
  id: string;
  entryIds: string[];
  members: ToolEntry[];
  counts: Record<GroupedFamily, number>;
  expanded: boolean;
}

export type TranscriptRow = Entry | ToolGroupRow;

export interface GroupOptions {
  /** The `groupToolRuns` preference (the kill switch). */
  enabled: boolean;
  voiceMode: VoiceMode;
  /** Group ids the reader (or a find match) opened. */
  expanded: ReadonlySet<string>;
}

export const isToolGroup = (row: TranscriptRow): row is ToolGroupRow => row.kind === 'toolGroup';

/** Finished, succeeded, and read-only. Everything else is shown on its own. */
export function isGroupable(entry: Entry): entry is ToolEntry {
  return entry.kind === 'tool'
    && entry.status === 'done'
    && entry.isError !== true
    && GROUPED_FAMILIES.has(toolFamily(entry.name));
}

function makeGroup(members: ToolEntry[], expanded: ReadonlySet<string>): ToolGroupRow {
  const counts: Record<GroupedFamily, number> = { read: 0, search: 0, list: 0 };
  for (const member of members) counts[toolFamily(member.name) as GroupedFamily] += 1;
  const id = members[0]!.id;
  return { kind: 'toolGroup', id, entryIds: members.map((member) => member.id), members, counts, expanded: expanded.has(id) };
}

/**
 * Entries -> rows. With the feature off, or in developer mode (which shows exactly what the app
 * showed before grouping existed), the SAME array comes back, so callers can rely on identity.
 */
export function groupToolRuns(entries: readonly Entry[], options: GroupOptions): readonly TranscriptRow[] {
  if (!options.enabled || options.voiceMode === 'developer') return entries;
  const rows: TranscriptRow[] = [];
  let run: ToolEntry[] = [];
  const flush = (): void => {
    if (run.length >= MIN_GROUP_SIZE) rows.push(makeGroup(run, options.expanded));
    else rows.push(...run);
    run = [];
  };
  for (const entry of entries) {
    // ANY entry that is not a groupable tool ends the run: text between two reads, a failed call,
    // a notice, a todo, a user message - all of them are something the reader must see in order.
    if (isGroupable(entry)) { run.push(entry); continue; }
    flush();
    rows.push(entry);
  }
  flush();
  return rows;
}

/** Ids of every entry a row stands for. */
export function entryIdsOf(row: TranscriptRow): readonly string[] {
  return isToolGroup(row) ? row.entryIds : [row.id];
}

/**
 * The row an entry is drawn in: its own row, or the group that swallowed it. `-1` when absent.
 * EVERY "entry id -> row" lookup (find, jump anchors, restoring a scroll position) must come
 * through here: a caller that compares `row.id === entryId` silently misses a folded member.
 */
export function rowIndexOfEntry(rows: readonly TranscriptRow[], entryId: string): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (isToolGroup(row) ? row.entryIds.includes(entryId) : row.id === entryId) return index;
  }
  return -1;
}

/** The group a given entry is folded into, if any. */
export function groupOfEntry(rows: readonly TranscriptRow[], entryId: string): ToolGroupRow | null {
  const row = rows[rowIndexOfEntry(rows, entryId)];
  return row && isToolGroup(row) ? row : null;
}
