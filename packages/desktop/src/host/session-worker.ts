/**
 * Worker thread that parses session files so the main process never does.
 *
 * `meta` is the LAST key in a session file, so reading a row means parsing the whole file -
 * hundreds of megabytes for a long history. The main process sends the stat'ed files that
 * missed its cache; this thread parses them and answers in small batches, so the sidebar
 * fills progressively and the main thread's frame budget is untouched.
 *
 * Lives under `src/host/` (staged as real files next to the engine) rather than in the asar:
 * a worker started from an archive path is one more platform assumption we do not need.
 */

import { parentPort } from 'node:worker_threads';
import { describeSessionFile, type SessionFileStat, type SessionRowData } from '@aragon-agent/cli/dist/host/sessions.js';

const BATCH_SIZE = 20;

export type WorkerRequest = { kind: 'parse'; jobId: number; files: SessionFileStat[] };
export type WorkerReply =
  | { kind: 'rows'; jobId: number; rows: SessionRowData[] }
  | { kind: 'done'; jobId: number };

parentPort?.on('message', (message: WorkerRequest) => {
  if (message.kind !== 'parse') return;
  let batch: SessionRowData[] = [];
  for (const file of message.files) {
    batch.push(describeSessionFile(file));
    if (batch.length >= BATCH_SIZE) {
      parentPort?.postMessage({ kind: 'rows', jobId: message.jobId, rows: batch } satisfies WorkerReply);
      batch = [];
    }
  }
  if (batch.length > 0) {
    parentPort?.postMessage({ kind: 'rows', jobId: message.jobId, rows: batch } satisfies WorkerReply);
  }
  parentPort?.postMessage({ kind: 'done', jobId: message.jobId } satisfies WorkerReply);
});
