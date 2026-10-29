/**
 * A cross-platform snapshot of the process table, to answer one question: after the app quits, is any
 * process it started still alive?
 *
 * A process is identified by (pid, creation time), never by pid alone: Windows reuses pids quickly, and a
 * recycled pid belonging to something unrelated must not be reported as a leak (the same rule
 * `main/process-reaper.ts` applies when it decides what it may kill).
 */
import { execFileSync } from 'node:child_process';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Creation time as the OS reports it (opaque string; compared for equality only). */
  started: string;
}

export function snapshotProcesses(): ProcInfo[] {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.ToString(\'o\'))" }';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split(/\r?\n/).flatMap((line) => {
      const [pid, ppid, started] = line.trim().split('|');
      return pid && ppid && started ? [{ pid: Number(pid), ppid: Number(ppid), started }] : [];
    });
  }
  const out = execFileSync('ps', ['-eo', 'pid=,ppid=,lstart='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), started: match[3]!.trim() }] : [];
  });
}

/** `root` and everything below it, in the given snapshot. */
export function descendantsOf(rootPid: number, table: readonly ProcInfo[]): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const proc of table) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
  const found: ProcInfo[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** The members of `recorded` that are still running right now (same pid AND same start time). */
export function stillAlive(recorded: readonly ProcInfo[], table: readonly ProcInfo[]): ProcInfo[] {
  return recorded.filter((old) => table.some((now) => now.pid === old.pid && now.started === old.started));
}
