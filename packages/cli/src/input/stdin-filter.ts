/**
 * Stdin filter (mouse-wheel-region-routing section 4.2 / 5.2, extended by
 * tui-paste-handling section 5.1).
 *
 * WHY A WRAPPER AND NOT A SECOND LISTENER. Ink 5.2.1 owns stdin in a way that
 * forbids a second reader: `components/App.js` calls `setEncoding('utf8')`,
 * `ref()`, `setRawMode(true)`, subscribes to `'readable'` and drains with
 * `read()`. Attaching our own `'data'` listener to the same `process.stdin`
 * would switch the stream into flowing mode and RACE Ink's `read()` for chunks
 * -- some keystrokes would reach Ink, some would not, non-deterministically
 * (D-3). So the filter REPLACES the stream Ink is given: it reads the real
 * stdin, strips every mouse report, frames every paste, and writes the
 * remainder into a `PassThrough` that carries the surface Ink requires.
 *
 * ONE CHANNEL, NOT TWO, AND THAT NOW COVERS PASTES AS WELL (D-2 / D-3). A second
 * chained filter would need a second `PassThrough` and would reopen the ordering
 * hazard this note closes; a side-channel paste emit would apply the payload
 * BEFORE text that preceded it in the same chunk, because `wrapper.write` is
 * asynchronous and a synchronous emit is not. The paste therefore travels
 * INLINE, wrapped in `PASTE_OPEN` / `PASTE_CLOSE` (I-5).
 *
 * ORDERING IS AN INVARIANT, NOT A CONVENTION (I-8). The caller must build this
 * filter BEFORE anything writes `\x1b[?1000h` or `\x1b[?2004h`. Reporting or
 * bracketed paste enabled while Ink still holds the raw stream does not degrade
 * the feature -- it types `[<0;12;5M` or `[200~` into the user's message, which
 * is strictly worse than the bug being fixed.
 *
 * THE HANDLE ANSWERS EXACTLY ONE QUESTION: "is a stream wrapped?" (I-11 / D-17).
 * It stopped being the answer to "is the mouse on?" the moment paste could build
 * a filter on its own -- `paste` defaults to `true`, so `aragon --no-mouse`
 * builds one. `cli.tsx` reads its own `mouseOn` / `pasteOn` booleans; this module
 * is told which features it is running and never derives them.
 */

import { PassThrough } from 'node:stream';
import {
  MAX_PENDING_MOUSE_CHARS,
  splitMouseEvents,
  isMousePrefix,
  type MouseEvent,
} from './mouse-events.js';
import {
  ENTER_NEWLINE_FRAME,
  PASTE_ASSEMBLY_MAX_MS,
  PASTE_BURST_MS,
  PASTE_CLOSE,
  PASTE_MAX_BYTES,
  PASTE_OPEN,
  formatPasteSize,
  type PasteBridge,
} from './limits.js';
import {
  PASTE_BEGIN_MARK,
  PASTE_END_MARK,
  classifyChunk,
  sanitisePaste,
  trailingPastePrefixLength,
} from './paste-parse.js';
import { splitEnterSequences, trailingEnterPrefixLength } from './enter-sequences.js';

export interface MouseSource {
  /**
   * Returns an unsubscribe function. Multiple subscribers are allowed -- the
   * wheel router and (since tui-selection-and-scroll-follow) the selection
   * controller both take this one channel, and each ignores the kinds it does
   * not own.
   *
   * With `features.mouse` false the channel exists and stays SILENT forever, so
   * a subscriber written against it does not have to know which features are on.
   */
  subscribe(listener: (event: MouseEvent) => void): () => void;
}

/**
 * Which stream-level features this filter is running.
 *
 * TOLD, NEVER DERIVED (D-17 / P0-1). With `{ mouse: false, paste: true }` no
 * `MouseEvent` is ever emitted and `splitMouseEvents` is not called at all: a
 * `--no-mouse` session never wrote `?1000h`, so no real report can arrive, and
 * running the parser anyway could only ever EAT pasted bytes that happen to look
 * like one. With `{ mouse: true, paste: false }` this is byte-for-byte the
 * v0.6.3 mouse filter.
 */
export interface StdinFilterFeatures {
  /** Parse and strip SGR / X10 mouse reports, and emit `MouseEvent`s. */
  readonly mouse: boolean;
  /** Recognise pastes and deliver them framed. */
  readonly paste: boolean;
}

export interface StdinFilter {
  /** Hand this to Ink: `render(<App/>, { stdin: filter.stdin })`. */
  readonly stdin: NodeJS.ReadStream;
  readonly source: MouseSource;
  /** Idempotent. Detaches from the real stdin and clears every timer (I-7). */
  dispose(): void;
}

/**
 * How long a possible-prefix tail is held before being flushed as text.
 *
 * This is what stops a lone `\x1b` -- the Esc key, which aborts a run -- from
 * being held hostage waiting for a `[` that will never arrive. Worst-case Esc
 * latency becomes 12 ms, and only for the keystroke that is literally a bare
 * ESC; every other key resolves both prefix tests to false immediately.
 */
const PENDING_FLUSH_MS = 12;

/**
 * Ceiling on the held-back tail, shared by both prefix families.
 *
 * NO CHANGE IS NEEDED HERE FOR PASTE (P2-5). `MAX_PENDING_MOUSE_CHARS` is 32 and
 * the longest paste marker is 6, so 32 already covers both. v1 of the design said
 * the ceiling "becomes `max(MAX_PENDING_MOUSE_CHARS, PASTE_BEGIN_MARK.length)`",
 * which is the same number written in a way that invites someone to edit the
 * constant.
 *
 * TAKEN FROM THE MODULE THAT OWNS IT rather than written again: this file already
 * imports from `mouse-events.js`, so there is no cycle to dodge here and no
 * reason for a second copy of a number whose only justification is that it equals
 * that one.
 */
const MAX_PENDING_CHARS = MAX_PENDING_MOUSE_CHARS;

/** The paste assembly state machine (section 5.1). */
type PasteState =
  | { kind: 'idle' }
  /** Tier 1: inside `\x1b[200~`, exact. */
  | { kind: 'bracketed'; body: string; bytes: number; overflow: boolean }
  /** Tier 2: coalescing a classified burst. */
  | { kind: 'burst'; body: string; bytes: number };

/** Assign a method onto the PassThrough without widening its public type. */
function define(target: PassThrough, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Length of the trailing run of `text` that is a proper prefix of a mouse
 * report, or 0. Shortest match wins, mirroring `trailingPastePrefixLength`.
 *
 * MEASURED SEPARATELY FROM THE PASTE FAMILY, and the longer hold wins.
 * `isMousePrefix` does not match `\x1b[2`, which IS a prefix of both paste
 * markers, so a single combined test would leak half a marker into the draft.
 */
function trailingMousePrefixLength(text: string): number {
  const max = Math.min(text.length, MAX_PENDING_CHARS);
  for (let k = 1; k <= max; k += 1) {
    if (isMousePrefix(text.slice(text.length - k))) return k;
  }
  return 0;
}

export function createStdinFilter(
  real: NodeJS.ReadStream,
  features: StdinFilterFeatures,
  bridge?: PasteBridge,
  onWarn?: (reason: string) => void,
): StdinFilter {
  const wrapper = new PassThrough();
  const listeners = new Set<(event: MouseEvent) => void>();

  let pending = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let burstTimer: NodeJS.Timeout | null = null;
  let assemblyTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let finished = false;
  let paste: PasteState = { kind: 'idle' };
  let discardBracketed = false;
  let outputBatch: { chunks: string[]; refused: boolean } | null = null;

  const writeInput = (text: string): void => {
    if (disposed || outputBatch?.refused) return;
    if (outputBatch) outputBatch.chunks.push(text);
    else wrapper.write(text);
  };

  // --- The surface Ink reads off the stream it is handed. ------------------
  // `isRawModeSupported()` reads `props.stdin.isTTY` (App.js:34), so this has
  // to be a DELEGATING GETTER rather than a snapshot: a stdin that is not a TTY
  // must still report so through the wrapper, or Ink throws instead of falling
  // back.
  Object.defineProperty(wrapper, 'isTTY', {
    get: () => real.isTTY,
    configurable: true,
  });
  define(wrapper, 'setRawMode', (mode: boolean) => {
    real.setRawMode?.(mode);
    return wrapper;
  });
  define(wrapper, 'ref', () => {
    real.ref?.();
    return wrapper;
  });
  define(wrapper, 'unref', () => {
    real.unref?.();
    return wrapper;
  });

  const emit = (event: MouseEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };

  const clearTimer = (t: NodeJS.Timeout | null): null => {
    if (t) clearTimeout(t);
    return null;
  };

  /** `.unref()` so a held tail can never keep the process alive on its own. */
  const arm = (fn: () => void, ms: number): NodeJS.Timeout | null => {
    if (finished || disposed) return null;
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  };

  // -----------------------------------------------------------------------
  // Paste emission
  // -----------------------------------------------------------------------

  /**
   * Write one frame, or refuse the paste and say so.
   *
   * D-11: above `PASTE_MAX_BYTES` the body is DROPPED and the user gets a toast
   * naming the size and the limit. Truncating would lose their data and look
   * like success. The body stops being accumulated the moment it goes over
   * (`overflow`), so memory stays bounded while the rest of the payload is still
   * being consumed -- consuming it is not optional, because the alternative is
   * two megabytes of the user's file arriving as keystrokes.
   */
  const emitPaste = (body: string, bytes: number, overflow: boolean): void => {
    if (disposed) return;
    if (overflow || bytes > PASTE_MAX_BYTES) {
      if (outputBatch?.refused) return;
      if (outputBatch) outputBatch.refused = true;
      const text =
        `Paste too large (${formatPasteSize(bytes)}); limit is ` +
        `${formatPasteSize(PASTE_MAX_BYTES)}. Nothing was inserted.`;
      onWarn?.(text);
      bridge?.notify?.('warn', text);
      return;
    }
    const payload = sanitisePaste(body);
    if (payload.length === 0) return;
    // ONE `write()` call, at the position the paste occupied in the stream.
    writeInput(PASTE_OPEN + payload + PASTE_CLOSE);
  };

  const flushBurst = (): void => {
    burstTimer = clearTimer(burstTimer);
    if (paste.kind !== 'burst') return;
    const { body, bytes } = paste;
    paste = { kind: 'idle' };
    emitPaste(body, bytes, false);
  };

  const flushBracketed = (reason: 'end' | 'timeout'): void => {
    assemblyTimer = clearTimer(assemblyTimer);
    if (paste.kind !== 'bracketed') return;
    const { body, bytes, overflow } = paste;
    paste = { kind: 'idle' };
    if (discardBracketed) {
      discardBracketed = false;
      if (outputBatch) outputBatch.refused = true;
      return;
    }
    if (reason === 'timeout') {
      // I-4: an unterminated marker must never wedge input. Emitting what
      // arrived is strictly better than holding the keyboard hostage.
      onWarn?.('bracketed paste never terminated; flushing what arrived');
    }
    emitPaste(body, bytes, overflow);
  };

  // -----------------------------------------------------------------------
  // The scan (section 5.1, and the ORDER below is the specification)
  // -----------------------------------------------------------------------

  /**
   * Text that reached the pass-through: Tier 2 classification, then mouse
   * stripping, then Ink.
   *
   * MOUSE PARSING IS SUSPENDED FOR THE DURATION OF ANY PASTE BODY (I-3), burst
   * and bracketed alike. The Tier 2 population is precisely the terminals with
   * no bracketed paste, and the likeliest thing such a user pastes into a TUI
   * dev tool is a terminal log full of `\x1b[<0;12;5M`-shaped bytes. Eating
   * those would corrupt their data silently. v1 covered only Tier 1, which left
   * the loss in place for exactly the terminals Tier 2 exists to serve (P1-7).
   */
  const handleText = (text: string, holdTail: boolean): void => {
    if (text.length === 0) return;

    if (paste.kind === 'burst') {
      paste = { kind: 'burst', body: paste.body + text, bytes: paste.bytes + byteLength(text) };
      burstTimer = clearTimer(burstTimer);
      burstTimer = arm(flushBurst, PASTE_BURST_MS);
      return;
    }

    if (features.paste && classifyChunk(text) === 'paste') {
      paste = { kind: 'burst', body: text, bytes: byteLength(text) };
      burstTimer = clearTimer(burstTimer);
      burstTimer = arm(flushBurst, PASTE_BURST_MS);
      return;
    }

    // Ink conflates DEL Backspace with CSI Delete. Normalize only keyboard
    // text, after burst classification, preserving ESC for Alt+Backspace.
    text = text.replace(/\x7f/g, '\x08');
    if (!features.mouse) {
      writeInput(text);
      return;
    }
    const split = splitMouseEvents(text);
    if (split.text.length > 0) writeInput(split.text);
    for (const event of split.events) emit(event);
    if (split.pending.length === 0) return;
    // `holdTail` is false when a paste marker follows this run in the SAME
    // chunk: no later byte can complete the mouse prefix, so holding it would
    // reorder it behind the paste. Appending (never prepending) is what keeps
    // `pending` in stream order when both prefix families fire at once.
    if (holdTail) pending += split.pending;
    else writeInput(split.pending);
  };

  const handleOutsidePaste = (text: string, holdTail: boolean): void => {
    const segments = splitEnterSequences(text);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (segment.kind === 'text') {
        handleText(segment.text, holdTail && index === segments.length - 1);
        continue;
      }
      // A key terminates the heuristic paste before its internal frame is written.
      flushBurst();
      writeInput(segment.kind === 'submit' ? '\r' : ENTER_NEWLINE_FRAME);
    }
  };

  const appendBracketed = (text: string): void => {
    if (paste.kind !== 'bracketed' || text.length === 0 || discardBracketed) return;
    const bytes = paste.bytes + byteLength(text);
    const overflow = paste.overflow || bytes > PASTE_MAX_BYTES;
    paste = {
      kind: 'bracketed',
      body: overflow ? paste.body : paste.body + text,
      bytes,
      overflow,
    };
  };

  const feed = (raw: string): void => {
    let rest = raw;
    while (rest.length > 0) {
      if (paste.kind === 'bracketed') {
        const end = rest.indexOf(PASTE_END_MARK);
        if (end === -1) {
          // Hold a trailing strict prefix of the END marker for the next chunk.
          // NO 12 ms FLUSH TIMER HERE: inside a body every byte is payload, so
          // nothing is being kept from the keyboard, and `assemblyTimer` is the
          // bound that matters (I-4).
          const hold = trailingPastePrefixLength(rest);
          appendBracketed(rest.slice(0, rest.length - hold));
          pending = rest.slice(rest.length - hold);
          return;
        }
        appendBracketed(rest.slice(0, end));
        flushBracketed('end');
        rest = rest.slice(end + PASTE_END_MARK.length);
        continue;
      }

      // idle | burst. BOTH markers are consumed unconditionally, in every mode
      // and whether or not this process enabled DEC 2004 (I-16): something else
      // may have left it on, and a stray END typed into the draft is the same
      // failure arriving from outside.
      const begin = rest.indexOf(PASTE_BEGIN_MARK);
      const strayEnd = rest.indexOf(PASTE_END_MARK);
      const first =
        begin === -1 ? strayEnd : strayEnd === -1 ? begin : Math.min(begin, strayEnd);

      if (first === -1) {
        // THIRD PREFIX FAMILY: a torn CSI-u Enter sequence
        // (tui-shift-enter-copy-queue 3.4). `keep = max(...)` holds the longest
        // tail any family might still complete; the three families share only
        // the ESC / ESC-[ head bytes, which the max keeps for whoever needs
        // them. The existing 12 ms flush and the 32-char ceiling bound the
        // hold, so no new timer is needed.
        const keep = Math.max(
          trailingPastePrefixLength(rest),
          features.mouse ? trailingMousePrefixLength(rest) : 0,
          trailingEnterPrefixLength(rest),
        );
        const tail = rest.slice(rest.length - keep);
        handleOutsidePaste(rest.slice(0, rest.length - keep), true);
        pending += tail;
        return;
      }

      handleOutsidePaste(rest.slice(0, first), false);
      if (begin === -1 || first < begin) {
        rest = rest.slice(first + PASTE_END_MARK.length);
        continue;
      }
      // P2-4: the burst is flushed FIRST, so two bodies can never be
      // concatenated into one token out of order.
      flushBurst();
      paste = { kind: 'bracketed', body: '', bytes: 0, overflow: false };
      assemblyTimer = clearTimer(assemblyTimer);
      assemblyTimer = arm(() => flushBracketed('timeout'), PASTE_ASSEMBLY_MAX_MS);
      rest = rest.slice(first + PASTE_BEGIN_MARK.length);
    }
  };

  const flushPending = (): void => {
    flushTimer = clearTimer(flushTimer);
    if (pending.length === 0 || disposed) return;
    const text = pending;
    pending = '';
    // A tail that never completed is ordinary text; it goes through the same
    // scan so a burst already open keeps coalescing it.
    handleOutsidePaste(text, false);
  };

  const onData = (chunk: string | Buffer): void => {
    if (disposed || finished) return;
    flushTimer = clearTimer(flushTimer);
    const decoded = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const carried = pending;
    pending = '';
    // A rejected paste must not leave earlier text or a later Enter executable.
    const batch = { chunks: [] as string[], refused: false };
    outputBatch = batch;
    try {
      feed(carried + decoded.replace(/\u0000/g, ''));
    } finally {
      outputBatch = null;
    }
    if (batch.refused) {
      burstTimer = clearTimer(burstTimer);
      if (paste.kind === 'bracketed') {
        // Keep consuming an unfinished body so its next chunk cannot become keys.
        discardBracketed = true;
        paste = { kind: 'bracketed', body: '', bytes: 0, overflow: false };
      } else {
        pending = '';
        paste = { kind: 'idle' };
        assemblyTimer = clearTimer(assemblyTimer);
      }
      return;
    }
    if (disposed || finished) return;
    for (const text of batch.chunks) wrapper.write(text);
    if (paste.kind === 'bracketed' || pending.length === 0) return;
    if (pending.length > MAX_PENDING_CHARS) {
      // A malformed sequence that looks like a prefix forever must never wedge
      // input: past the ceiling the tail becomes ordinary text.
      const text = pending;
      pending = '';
      handleOutsidePaste(text, false);
      return;
    }
    flushTimer = arm(flushPending, PENDING_FLUSH_MS);
  };

  // P2-7: a closed stdin must still terminate Ink's reader, or it waits forever
  // on a stream that will never produce another byte.
  const onEnd = (): void => {
    if (finished || disposed) return;
    finished = true;
    flushTimer = clearTimer(flushTimer);
    burstTimer = clearTimer(burstTimer);
    assemblyTimer = clearTimer(assemblyTimer);
    const tail = pending;
    pending = '';
    if (paste.kind === 'bracketed') {
      appendBracketed(tail);
      flushBracketed('timeout');
    } else {
      // The pending prefix belongs to the currently open burst, if any.
      handleOutsidePaste(tail, false);
      flushBurst();
    }
    wrapper.end();
  };

  // `setEncoding('utf8')` on the REAL stream so Node's StringDecoder handles
  // multi-byte boundaries for us -- the scan works on characters, and a UTF-8
  // sequence split across two chunks would otherwise become two mojibake
  // characters before it ever reached `splitMouseEvents`.
  real.setEncoding?.('utf8');
  real.on('data', onData);
  real.once('end', onEnd);
  real.once('close', onEnd);

  return {
    stdin: wrapper as unknown as NodeJS.ReadStream,
    source: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      flushTimer = clearTimer(flushTimer);
      burstTimer = clearTimer(burstTimer);
      assemblyTimer = clearTimer(assemblyTimer);
      real.removeListener('data', onData);
      real.removeListener('end', onEnd);
      real.removeListener('close', onEnd);
      listeners.clear();
      // I-7: a live `'data'` listener on stdin keeps the event loop alive, and
      // `aragon` would hang on exit instead of returning to the shell.
      real.pause?.();
      real.unref?.();
    },
  };
}

/**
 * Build a filter, or `null` if construction throws.
 *
 * The `null` return is the whole point (P0-1): a construction failure must
 * degrade to "the wheel is inert and pastes are keystrokes" -- a supported,
 * tested rung of the fail-safe ladder -- rather than leaving `?1000h` or `?2004h`
 * on with no filter in front of Ink. `cli.tsx` derives BOTH `mouseOn` and
 * `pasteOn` from the returned handle for exactly that reason.
 */
export function tryCreateStdinFilter(
  real: NodeJS.ReadStream,
  features: StdinFilterFeatures,
  onError?: (reason: string) => void,
  bridge?: PasteBridge,
): StdinFilter | null {
  try {
    return createStdinFilter(real, features, bridge, onError);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    return null;
  }
}
