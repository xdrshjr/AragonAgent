/**
 * `SessionParser` backed by a `worker_threads` Worker, so parsing hundreds of session files
 * never runs on the main process's event loop. One worker is started lazily and reused; if it
 * dies (a parse crash on a hostile file) the in-flight job resolves with whatever arrived and
 * the next job starts a fresh worker - a bad file costs one batch, never the sidebar.
 */

import { Worker } from 'node:worker_threads';
import type { SessionFileStat, SessionRowData } from '@aragon-agent/cli/dist/host/sessions.js';
import type { WorkerReply, WorkerRequest } from '../host/session-worker.js';
import type { SessionParser } from './session-index.js';

export function createWorkerParser(workerFile: string): SessionParser {
  let worker: Worker | null = null;
  let jobId = 0;
  let active: { id: number; onRows(rows: SessionRowData[]): void; finish(): void } | null = null;

  const ensure = (): Worker => {
    if (worker) return worker;
    const next = new Worker(workerFile);
    next.on('message', (reply: WorkerReply) => {
      if (!active || reply.jobId !== active.id) return;
      if (reply.kind === 'rows') active.onRows(reply.rows);
      else active.finish();
    });
    const drop = (): void => {
      if (worker === next) worker = null;
      active?.finish();
    };
    next.on('error', drop);
    next.on('exit', drop);
    worker = next;
    return next;
  };

  return {
    parse(files: SessionFileStat[], onRows) {
      return new Promise<void>((resolve) => {
        active?.finish(); // a newer request supersedes the one still running
        const id = ++jobId;
        const entry = {
          id, onRows,
          finish: () => { if (active === entry) active = null; resolve(); },
        };
        active = entry;
        try {
          ensure().postMessage({ kind: 'parse', jobId: id, files } satisfies WorkerRequest);
        } catch {
          entry.finish();
        }
      });
    },
    dispose() {
      active?.finish();
      void worker?.terminate();
      worker = null;
    },
  };
}
