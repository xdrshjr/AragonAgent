/**
 * The inspector's "Changes" list: file edits aggregated out of the transcript's tool entries.
 *
 * The structured diff the reducer stores on a tool entry (`entry.patch`) is the source of
 * truth for what changed; a tool that clearly writes a file but carries no patch (an older
 * session, or a patch the host already handed out) is still listed, and its diff is fetched
 * on demand with `file-patch.get`. Aggregation is by path, in order of first appearance.
 */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { FilePatch } from '@aragon-agent/tui/model/tools/patch';

export type ChangeStatus = 'M' | 'A';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  added: number;
  removed: number;
  /** How many tool calls touched it. */
  edits: number;
  /** The newest tool call that touched it: the one whose diff is shown. */
  toolCallId: string;
  /** The newest structured diff, when the entry still carries one. */
  patch: FilePatch | undefined;
}

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

const WRITE_TOOLS = /^(edit|write|create|multi_?edit|apply_?patch|str_replace\w*)$/i;
const PATH_ARGS = ['path', 'file_path', 'filePath', 'file'] as const;

function pathOf(entry: ToolEntry): string | null {
  if (entry.patch) return entry.patch.path;
  if (!WRITE_TOOLS.test(entry.name) || !entry.args) return null;
  for (const key of PATH_ARGS) {
    const value = entry.args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export function aggregateChanges(entries: readonly Entry[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const entry of entries) {
    if (entry.kind !== 'tool' || entry.isError || entry.status === 'error') continue;
    if (entry.status !== 'done' && !entry.patch) continue;
    const path = pathOf(entry);
    if (path === null) continue;
    const previous = byPath.get(path);
    const created = entry.patch?.kind === 'create';
    byPath.set(path, {
      path,
      // A file this session created stays "added" however often it is edited afterwards.
      status: previous?.status === 'A' || (previous === undefined && created) ? 'A' : 'M',
      added: (previous?.added ?? 0) + (entry.patch?.added ?? 0),
      removed: (previous?.removed ?? 0) + (entry.patch?.removed ?? 0),
      edits: (previous?.edits ?? 0) + 1,
      toolCallId: entry.toolCallId,
      patch: entry.patch ?? previous?.patch,
    });
  }
  return [...byPath.values()];
}
