/**
 * The three output faces of `aragon exec` (cli-integration-surface section 5.1).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * THE EMITTER IS THE ONLY OBJECT HANDED A STDOUT STREAM (R-2). Everything else
 * on the exec path writes to stderr: migration notices, config-parse warnings,
 * untrusted-skill notices, retry lines, `[usage]`, `[team]`, `[todo]` and every
 * log record. One stray `process.stdout.write` corrupts every consumer, silently
 * and only in the field, so the containment is structural rather than a rule
 * anyone has to remember.
 *
 * `result()` IS IDEMPOTENT ON ALL THREE (AC-6). A `finally` and an error handler
 * racing must not produce two `result` lines, and the second call being a no-op
 * is what makes "exactly one, always last" true on every exit path including
 * error, budget and signal - rather than true for the paths someone remembered.
 */

import type { ExecEvent, ExecInitParams, ExecResultEvent, ExecResultParams } from './events.js';
import { buildInitEvent, buildResultEvent, toNdjsonLine } from './events.js';

export interface ExecEmitter {
  init(params: ExecInitParams): void;
  /** Every non-`result` event. Ignored wholesale by `text` and `json`. */
  emit(event: ExecEvent): void;
  /** Exactly once per run; the second call is a no-op. */
  result(params: ExecResultParams): void;
  /** What `result()` actually wrote, or `null`. For tests and for `runExec`. */
  emitted(): ExecResultEvent | null;
}

/**
 * `--output-format text`: WRITES NOTHING (D-1).
 *
 * Text mode delegates to `runHeadless` VERBATIM - same controller, same
 * `quiet`, same `followThrough` - and this object exists only so `runExec` has
 * one shape to talk to. Reimplementing text rendering here would make "the human
 * CLI is unchanged" an argument someone has to trust instead of a fact anyone
 * can check, and the two implementations would drift the first time a retry line
 * changed. AC-1 asserts byte equality on BOTH streams; this class is what makes
 * it true by construction.
 */
export class TextEmitter implements ExecEmitter {
  private done: ExecResultEvent | null = null;

  // The parameters are DECLARED even though they are unused, so a caller
  // holding a concrete `TextEmitter` can call it exactly as it calls the other
  // two. A zero-arity method satisfies the interface and then makes the class
  // unusable through its own type, which is the sort of asymmetry that turns
  // into a cast at the call site.
  init(_params: ExecInitParams): void {
    // Deliberately empty. `runHeadless` owns every byte of the text stream.
  }

  emit(_event: ExecEvent): void {
    // Deliberately empty, same reason.
  }

  result(params: ExecResultParams): void {
    if (this.done) return;
    // RECORDED BUT NOT WRITTEN. `runExec` reads it for the exit code and the
    // session bookkeeping; writing it would append a JSON line to prose that
    // `aragon -p` does not produce.
    this.done = buildResultEvent(params);
  }

  emitted(): ExecResultEvent | null {
    return this.done;
  }
}

/**
 * `--output-format json`: the `result` object alone, pretty-printed, on stdout.
 *
 * `aragon exec --output-format json "..." | jq -r .result` is the intended
 * one-liner, which is why the intermediate events are dropped rather than
 * buffered into an array: a wrapper that wants the stream asks for the stream.
 */
export class JsonEmitter implements ExecEmitter {
  private done: ExecResultEvent | null = null;

  constructor(private readonly out: NodeJS.WritableStream) {}

  init(_params: ExecInitParams): void {
    // The init event is carried by `result.sessionId` / `result.model` for this
    // format. Writing it here would put two objects on a stream documented to
    // carry one.
  }

  emit(_event: ExecEvent): void {
    // Dropped by design; see the class comment.
  }

  result(params: ExecResultParams): void {
    if (this.done) return;
    this.done = buildResultEvent(params);
    this.out.write(`${JSON.stringify(this.done, null, 2)}\n`);
  }

  emitted(): ExecResultEvent | null {
    return this.done;
  }
}

/**
 * `--output-format stream-json`: one JSON object per line, `\n`-terminated, no
 * pretty-printing, UTF-8.
 *
 * EVENTS AFTER `result` ARE DROPPED, not appended. "Exactly one `result`, always
 * last" is the property consumers build their read loop around, and a late
 * `tool_result` arriving from a torn-down subscription would break it in the
 * rarest and least reproducible circumstances there are.
 */
export class StreamJsonEmitter implements ExecEmitter {
  private done: ExecResultEvent | null = null;

  constructor(private readonly out: NodeJS.WritableStream) {}

  init(params: ExecInitParams): void {
    if (this.done) return;
    this.out.write(toNdjsonLine(buildInitEvent(params)));
  }

  emit(event: ExecEvent): void {
    if (this.done) return;
    this.out.write(toNdjsonLine(event));
  }

  result(params: ExecResultParams): void {
    if (this.done) return;
    this.done = buildResultEvent(params);
    this.out.write(toNdjsonLine(this.done));
  }

  emitted(): ExecResultEvent | null {
    return this.done;
  }
}

export function createEmitter(
  format: 'text' | 'json' | 'stream-json',
  out: NodeJS.WritableStream,
): ExecEmitter {
  if (format === 'json') return new JsonEmitter(out);
  if (format === 'stream-json') return new StreamJsonEmitter(out);
  return new TextEmitter();
}
