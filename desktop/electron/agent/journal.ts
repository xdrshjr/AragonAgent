/**
 * Per-session event journal: an append-only NDJSON file under
 * `<userData>/sessions/<id>/events.jsonl`.
 *
 * The journal is the desktop's own replay source. The CLI's session file holds
 * the model-facing history; the journal holds the FULL event stream (deltas,
 * tool outputs, notices), which is what the transcript view needs and what the
 * CLI cannot re-emit on resume. Torn final lines (power loss mid-append) are
 * tolerated: a trailing fragment without a newline is dropped on read.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isExecEvent, type ExecEvent } from '../../shared/exec-events.js';

export class SessionJournal {
  private readonly file: string;

  private writeChain: Promise<void> = Promise.resolve();

  constructor(sessionsDir: string, sessionId: string) {
    this.file = path.join(sessionsDir, sessionId, 'events.jsonl');
  }

  /** All parseable events in order; corrupt lines are skipped, not fatal. */
  async readAll(): Promise<ExecEvent[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const events: ExecEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isExecEvent(parsed)) events.push(parsed);
      } catch {
        // Skip a torn or corrupt line; the journal stays useful.
      }
    }
    return events;
  }

  /** Append one event; serialized so concurrent appends cannot interleave. */
  append(event: ExecEvent): void {
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    }).catch((error: unknown) => {
      // A journal write failure must never break the live stream; the event is
      // still forwarded to the renderer, only replay-after-restart loses it.
      console.error('[journal] append failed:', error instanceof Error ? error.message : error);
    });
  }

  /** Wait for queued appends to reach disk (used before close/remove/quit). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Delete the journal directory. */
  async remove(): Promise<void> {
    await fs.rm(path.dirname(this.file), { recursive: true, force: true });
  }
}
