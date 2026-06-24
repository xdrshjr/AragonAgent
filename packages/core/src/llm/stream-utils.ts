/**
 * SSE stream parser and convenience helpers for LLM streaming.
 */

import type { AssistantMessage, StreamEvent } from './types.js';

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
 * Parse a `ReadableStream<Uint8Array>` (typically `Response.body`) into an
 * async iterator of {@link SSEEvent} objects.
 *
 * Handles:
 * - Multi-line `data:` fields (concatenated with `\n`)
 * - `event:` and `id:` fields
 * - Proper `\n\n` event boundary detection
 * - Graceful abort via `signal`
 *
 * The iterator ends when the stream closes or `signal` fires.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterableIterator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Set up abort listener to release the reader
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete events separated by \n\n
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseSSEBlock(rawEvent);
        if (parsed) {
          yield parsed;
        }
      }
    }

    // Flush any trailing data that wasn't terminated by \n\n
    if (buffer.trim().length > 0) {
      const parsed = parseSSEBlock(buffer);
      if (parsed) {
        yield parsed;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * Parse a single SSE block (the text between two `\n\n` boundaries) into an
 * {@link SSEEvent}.  Returns `undefined` for comment-only or empty blocks.
 */
function parseSSEBlock(block: string): SSEEvent | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    // Comment lines start with ':'
    if (line.startsWith(':')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      // Field with no value — treat field name as the value (per SSE spec)
      continue;
    }

    const field = line.slice(0, colonIdx);
    // Value starts after ':' — strip a single leading space if present
    let value = line.slice(colonIdx + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    switch (field) {
      case 'event':
        event = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      // 'retry' and unknown fields are ignored
    }
  }

  if (dataLines.length === 0 && event === undefined) {
    return undefined;
  }

  return {
    event,
    data: dataLines.join('\n'),
    id,
  };
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
