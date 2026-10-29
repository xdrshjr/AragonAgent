/** Presentation helpers for transcript rows. Pure; text that is shown to people goes through `t`. */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';

type ToolEntry = Extract<Entry, { kind: 'tool' }>;

export type ToolFamily = 'bash' | 'edit' | 'write' | 'read' | 'search' | 'list' | 'job' | 'generic';

const FAMILY_BY_NAME: Record<string, ToolFamily> = {
  bash: 'bash', bash_output: 'bash', bash_kill: 'bash',
  edit_file: 'edit', write_file: 'write', read_file: 'read',
  grep: 'search', glob: 'search', list_dir: 'list',
  job_wait: 'job', job_list: 'job',
};

export function toolFamily(name: string): ToolFamily {
  return FAMILY_BY_NAME[name] ?? 'generic';
}

function firstLine(text: string): string {
  const at = text.search(/\r|\n/);
  return at === -1 ? text : text.slice(0, at);
}

export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

function stringArg(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** One-line summary of a tool call's arguments ("npm test", "src/a.ts", "TODO in src"). */
export function summarizeToolArgs(entry: ToolEntry): string {
  const { args, name } = entry;
  const family = toolFamily(name);
  if (family === 'bash') return clip(firstLine(stringArg(args, 'command') ?? ''), 140);
  if (family === 'search') return clip(stringArg(args, 'pattern') ?? '', 100);
  const path = stringArg(args, 'path', 'file', 'file_path', 'dir');
  if (path) return clip(path, 120);
  if (args) {
    for (const value of Object.values(args)) if (typeof value === 'string') return clip(firstLine(value), 100);
  }
  // Arguments still streaming in: show the raw start rather than nothing.
  return clip(firstLine(entry.argsRaw), 100);
}

/** `+12 -3` style counts for a patch. */
export function patchCounts(patch: { added: number; removed: number }): string {
  return `+${patch.added} −${patch.removed}`;
}

/** "4.2 s" / "12 s" / "2 m 05 s" - short, locale-neutral. */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

/** Context usage as a ring percentage, or `null` when the window is unknown. */
export function contextPercent(context: { pct: number; windowKnown: boolean }): number | null {
  return context.windowKnown ? Math.max(0, Math.min(100, Math.round(context.pct))) : null;
}

export function formatTokenCount(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The cost badge text: an en dash when there is nothing trustworthy to show, never "$0". */
export function formatCostBadge(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '–';
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

/** Last path segments, for compact chips ("my-repo/src"). */
export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

/** `hh:mm:ss` in the user's locale-independent 24 h form, for "restored to ...". */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
