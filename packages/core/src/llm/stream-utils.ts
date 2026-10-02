/**
 * SSE stream parser and convenience helpers for LLM streaming.
 */

import type { AssistantMessage, StreamEvent } from './types.js';
import { SseParser } from './sse-parser.js';

// ---------------------------------------------------------------------------
// SSE event type
// ---------------------------------------------------------------------------

export interface SSEEvent {
  /** The `event:` field value.  Undefined when omitted by the server. */
  event?: string;
  /** The concatenated `data:` field value (may span multiple lines). */
  data: string;
  /** The `id:` field value. */
  id?: string;
}

// ---------------------------------------------------------------------------
// Generic SSE parser
// ---------------------------------------------------------------------------

/**
 * Parse model SSE frames, retaining the normal EOF compatibility extension.
 * Abort drops pending data; all early exits cancel once without awaiting cleanup.
 * Throws SseFrameLimitError when an individual frame exceeds its capacity.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterableIterator<SSEEvent> {
  if (signal?.aborted) return;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const parser = new SseParser();
  let reachedEof = false;
  let cancelled = false;
  const cancelOnce = (): void => {
    if (cancelled) return;
    cancelled = true;
    try {
      // A transport can reject or never settle its cleanup promise.
      void reader.cancel().catch(() => {});
    } catch {
      // A synchronous transport cleanup failure must not mask the stream result.
    }
  };
  signal?.addEventListener('abort', cancelOnce, { once: true });
  try {
    if (signal?.aborted) { cancelOnce(); return; }
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return;
      if (done) { reachedEof = true; break; }
      for (const event of decodeChunk(value, decoder, parser)) {
        if (signal?.aborted) return;
        yield event;
        if (signal?.aborted) return;
      }
    }
    if (signal?.aborted) return;
    for (const event of parser.push(decoder.decode())) {
      if (signal?.aborted) return;
      yield event;
    }
    if (signal?.aborted) return;
    for (const event of parser.finish()) {
      if (signal?.aborted) return;
      yield event;
    }
  } catch (err) {
    cancelOnce();
    if (signal?.aborted) return;
    throw err;
  } finally {
    signal?.removeEventListener('abort', cancelOnce);
    parser.clear();
    if (!reachedEof) cancelOnce();
    reader.releaseLock();
  }
}

function* decodeChunk(
  bytes: Uint8Array,
  decoder: TextDecoder,
  parser: SseParser,
): IterableIterator<SSEEvent> {
  const decodeSliceBytes = 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += decodeSliceBytes) {
    const slice = bytes.subarray(offset, offset + decodeSliceBytes);
    yield* parser.push(decoder.decode(slice, { stream: true }));
  }
}

// ---------------------------------------------------------------------------
// Convenience: streamLLM / completeLLM
// ---------------------------------------------------------------------------

// These are re-exported from providers/index.ts where the ProviderRegistry
// singleton is available.  Declared here as standalone signatures for the
// module's public API documentation.

/**
 * Consume a StreamEvent iterator and return the final AssistantMessage.
 *
 * This is the generic "complete" implementation that any provider can use:
 * it iterates the stream, discards incremental deltas, and returns the
 * assembled message from the `done` event.
 */
export async function consumeStream(
  stream: AsyncIterableIterator<StreamEvent>,
): Promise<AssistantMessage> {
  let result: AssistantMessage | undefined;

  for await (const event of stream) {
    if (event.type === 'done') {
      result = event.message;
    } else if (event.type === 'error') {
      throw event.error;
    }
  }

  if (!result) {
    throw new Error('Stream ended without a done event');
  }

  return result;
}
