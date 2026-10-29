/**
 * What a host reports in answer to the main process's 2 s `ping`: that it is alive, and which
 * processes it has started.
 *
 * THE DESCENDANT LIST IS THE ORPHAN INSURANCE. When a host is killed, its `bash`, background
 * services and sub-agents are not killed with it on Windows, and once the host is gone their
 * parent links are too, so nothing can find them afterwards. So the host keeps the main
 * process supplied with `{pid, startedAt}` for every descendant while it is alive; after a
 * crash the main process can kill exactly those, checking the creation time first so a pid the
 * OS has since recycled is never touched.
 *
 * Enumeration shells out to `ps` or PowerShell, which costs tens to hundreds of
 * milliseconds. It therefore runs only while there is something to find (a run in progress or
 * a live background service), asynchronously, at most once per interval; an idle session
 * answers with the empty list for free.
 */

import { execFile } from 'node:child_process';
import process from 'node:process';
import type { HostControlMsg } from '../shared/port-protocol.js';

export interface Descendant { pid: number; startedAt: number }

export interface ProcessRow { pid: number; ppid: number; startedAt: number }

/** Walk the parent links from `root` and return every descendant. Pure; tested directly. */
export function collectDescendants(rows: readonly ProcessRow[], root: number): Descendant[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: Descendant[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ pid: child.pid, startedAt: child.startedAt });
      queue.push(child.pid);
    }
  }
  return out;
}

/** Parse `ps -A -o pid=,ppid=,lstart=` output. */
export function parsePsOutput(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(`${match[3]} UTC`);
    if (Number.isFinite(startedAt)) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt });
  }
  return rows;
}

/** Parse the JSON array PowerShell emits for `Win32_Process`. */
export function parseWindowsProcessJson(text: string): ProcessRow[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const rows: ProcessRow[] = [];
    for (const item of list as { ProcessId?: number; ParentProcessId?: number; Created?: string }[]) {
      const startedAt = item.Created ? Date.parse(item.Created) : NaN;
      if (typeof item.ProcessId === 'number' && typeof item.ParentProcessId === 'number' && Number.isFinite(startedAt)) {
        rows.push({ pid: item.ProcessId, ppid: item.ParentProcessId, startedAt });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function listProcesses(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 6000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => resolve(error ? [] : parseWindowsProcessJson(stdout)));
      return;
    }
    execFile('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { timeout: 4000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolve(error ? [] : parsePsOutput(stdout)));
  });
}

export interface HeartbeatOptions {
  /** True while there might be descendants worth reporting. */
  hasWork(): boolean;
  send(message: HostControlMsg): void;
  rootPid?: number;
  platform?: NodeJS.Platform;
  list?: (platform: NodeJS.Platform) => Promise<ProcessRow[]>;
}

export class Heartbeat {
  private cached: Descendant[] = [];
  private refreshing = false;

  constructor(private readonly options: HeartbeatOptions) {}

  /** Answer one ping with the freshest descendant list we have, refreshing it in the background. */
  pong(): void {
    this.options.send({ v: 1, kind: 'pong', descendants: this.options.hasWork() ? this.cached : [] });
    if (this.options.hasWork()) void this.refresh();
    else this.cached = [];
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const platform = this.options.platform ?? process.platform;
      const rows = await (this.options.list ?? listProcesses)(platform);
      this.cached = collectDescendants(rows, this.options.rootPid ?? process.pid);
    } finally {
      this.refreshing = false;
    }
  }
}
