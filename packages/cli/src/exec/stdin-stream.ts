/**
 * `--input-format stream-json`: an NDJSON reader on stdin
 * (cli-integration-surface section 4.1).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * TOLERANT BY CONTRACT (AC-20). A malformed line yields ONE non-fatal `error`
 * event and is skipped; an unknown `type` is ignored entirely. The forward
 * compatibility the schema promises consumers has to run in both directions, or
 * a caller written against a newer version could not talk to an older CLI at
 * all - and a run that dies on one bad line is the worst possible failure for a
 * long-lived worker feeding turns down a pipe.
 *
 * Three message types are understood:
 *
 *   { "type": "user", "text": "..." }   the next turn
 *   { "type": "interrupt" }             abort the turn in flight
 *   { "type": "end" }                   no more turns; settle and exit
 *
 * Reaching end-of-stream means the same as `end`, so a caller that simply closes
 * the pipe is not punished for it.
 */

import type { ExecPromptSource } from './runner.js';

export interface StdinStreamOptions {
  input: NodeJS.ReadableStream;
  /** A non-fatal parse failure. The caller turns this into an `error` event. */
  onBadLine: (message: string) => void;
  /** `{"type":"interrupt"}`. The caller aborts the run in flight. */
  onInterrupt: () => void;
}

/**
 * A prompt source backed by NDJSON on stdin.
 *
 * IT BUFFERS RATHER THAN PAUSING THE STREAM. A caller may legitimately push
 * three turns in one write before the first has finished, and a reader that only
 * accepted a line when someone was waiting for one would deadlock the second and
 * third behind a turn that is minutes long.
 */
export function createStdinPromptSource(opts: StdinStreamOptions): ExecPromptSource {
  const queue: string[] = [];
  const waiting: ((value: string | null) => void)[] = [];
  let finished = false;
  let buffer = '';

  const deliver = (text: string): void => {
    const resolve = waiting.shift();
    if (resolve) resolve(text);
    else queue.push(text);
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    // Everything still parked is answered with `null`, so a `next()` in flight
    // when the pipe closes resolves instead of hanging the process forever.
    while (waiting.length > 0) waiting.shift()?.(null);
  };

  const handleLine = (line: string): void => {
    // AFTER `end`, NOTHING ELSE IS A TURN. Lines arrive in chunks, so a caller
    // that wrote `end` and a stray `user` in one write would otherwise have the
    // second QUEUED and run - the exact opposite of what `end` means, and
    // invisible until someone looked at the transcript.
    if (finished) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      opts.onBadLine(`Skipped a line that is not JSON: ${clip(trimmed)}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      opts.onBadLine(`Skipped a line that is not a JSON object: ${clip(trimmed)}`);
      return;
    }
    const message = parsed as { type?: unknown; text?: unknown; content?: unknown };
    if (message.type === 'end') {
      finish();
      return;
    }
    if (message.type === 'interrupt') {
      opts.onInterrupt();
      return;
    }
    if (message.type !== 'user') {
      // An unknown type is IGNORED, not reported: reporting it would make every
      // additive change to the schema noisy for callers running an older CLI.
      return;
    }
    const text = typeof message.text === 'string' ? message.text : message.content;
    if (typeof text !== 'string' || text.trim().length === 0) {
      opts.onBadLine('Skipped a "user" message with no non-empty "text".');
      return;
    }
    deliver(text);
  };

  opts.input.setEncoding?.('utf-8');
  opts.input.on('data', (chunk: string | Buffer) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  opts.input.on('end', () => {
    // A final line with no trailing newline is still a line.
    if (buffer.length > 0) {
      handleLine(buffer);
      buffer = '';
    }
    finish();
  });
  opts.input.on('error', () => finish());

  return {
    next: (): Promise<string | null> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (finished) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => waiting.push(resolve));
    },
  };
}

/**
 * Serve a fixed list of prompts, then delegate.
 *
 * Used for `aragon exec --input-format stream-json "first turn"`, where the
 * positional argument is the opening message and stdin supplies the rest.
 */
export function prefixSource(prefix: string[], rest: ExecPromptSource): ExecPromptSource {
  const pending = [...prefix];
  return {
    next: async (): Promise<string | null> => {
      const first = pending.shift();
      if (first !== undefined) return first;
      return rest.next();
    },
  };
}

function clip(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}
