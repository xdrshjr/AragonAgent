import { describe, expect, it, vi } from 'vitest';
import { parseSSEStream, type SSEEvent } from '../llm/stream-utils.js';

const encoder = new TextEncoder();
const LIMIT = 1_048_576;

function source(chunks: Array<string | Uint8Array>, close = true) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      if (close) controller.close();
    },
    cancel,
  });
  return { body, cancel };
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSEStream(body)) events.push(event);
  return events;
}

describe('incremental SSE boundaries', () => {
  it.each(['\n', '\r\n', '\r'])('dispatches %j frames before EOF', async (ending) => {
    const { body, cancel } = source([`data: 1${ending}${ending}data: 2${ending}${ending}`], false);
    const stream = parseSSEStream(body);
    expect((await stream.next()).value?.data).toBe('1');
    expect((await stream.next()).value?.data).toBe('2');
    await stream.return!();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  }, 500);

  it('coalesces CRLF split between network chunks', async () => {
    const { body } = source(['data: first\r', '\n\r', '\ndata: second\r', '\n\r', '\n']);
    expect((await collect(body)).map((event) => event.data)).toEqual(['first', 'second']);
  });

  it('decodes split UTF-8 and strips a BOM only at the beginning', async () => {
    const bytes = encoder.encode('\uFEFFdata: \u4e2d\u6587\ndata: \uFEFFtail\n\n');
    const { body } = source([...bytes].map((byte) => new Uint8Array([byte])));
    expect((await collect(body))[0]?.data).toBe('\u4e2d\u6587\n\uFEFFtail');
  });

  it('preserves empty data and event-only frames with event-local IDs', async () => {
    const { body } = source([
      ': heartbeat\nunknown: ignored\n\ndata\nid: 1\nevent: custom\n\n',
      'data:  two spaces\nid: bad\u0000id\n\nevent: only\n\n',
    ]);
    expect(await collect(body)).toEqual([
      { data: '', id: '1', event: 'custom' },
      { data: ' two spaces', id: undefined, event: undefined },
      { data: '', id: undefined, event: 'only' },
    ]);
  });

  it('flushes a complete last line and pending UTF-8 at normal EOF', async () => {
    const { body, cancel } = source(['data: end', new Uint8Array([0xe4])]);
    expect((await collect(body))[0]?.data).toBe('end\uFFFD');
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it('dispatches lazily so cancellation skips later frames in one large chunk', async () => {
    const { body, cancel } = source(['data: first\n\n' + 'data: bad\n\n'.repeat(200_000)], false);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const controller = new AbortController();
    const stream = parseSSEStream(body, controller.signal);
    expect((await stream.next()).value?.data).toBe('first');
    controller.abort();
    expect((await stream.next()).done).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect((decode.mock.calls[0]?.[0] as Uint8Array).byteLength).toBeLessThanOrEqual(16_384);
    decode.mockRestore();
  });
});

describe('SSE frame capacity', () => {
  it.each([
    ['single line', 'data: ' + 'a'.repeat(LIMIT - 8) + '\n\n'],
    ['multiple lines', 'data:\n'.repeat(100) + 'data:' + 'b'.repeat(LIMIT - 607) + '\n\n'],
    ['unfinished line', 'data:' + 'c'.repeat(LIMIT - 5)],
  ])('accepts the exact limit for %s', async (_name, frame) => {
    expect(frame.length).toBe(LIMIT);
    expect(await collect(source([frame]).body)).toHaveLength(1);
  });

  it.each([
    ['single line', 'data:' + 'a'.repeat(LIMIT)],
    ['multiple data lines', 'data:\n'.repeat(Math.ceil(LIMIT / 6))],
    ['comments', ':' + 'x'.repeat(LIMIT)],
    ['unknown fields', 'unknown:\n'.repeat(Math.ceil(LIMIT / 9))],
  ])('rejects oversized %s and cancels the reader', async (_name, frame) => {
    const { body, cancel } = source([frame], false);
    await expect(collect(body)).rejects.toMatchObject({ name: 'SseFrameLimitError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  }, 1_000);

  it('resets capacity after every frame', async () => {
    const frame = 'data:' + 'a'.repeat(LIMIT - 7) + '\n\n';
    expect(await collect(source([frame + frame]).body)).toHaveLength(2);
  });

  it('keeps split CRLF terminators outside the next exact-capacity frame', async () => {
    const frame = 'data:' + 'a'.repeat(LIMIT - 8) + '\r\n\r';
    expect(frame.length).toBe(LIMIT);
    const { body } = source([frame, '\n' + frame, '\n']);
    expect(await collect(body)).toHaveLength(2);
  });

  it('rejects one code unit beyond the CRLF frame boundary', async () => {
    const frame = 'data:' + 'a'.repeat(LIMIT - 7) + '\r\n\r';
    expect(frame.length).toBe(LIMIT + 1);
    await expect(collect(source([frame, '\n']).body))
      .rejects.toMatchObject({ name: 'SseFrameLimitError' });
  });

  it('cancels once if flushing the UTF-8 decoder exceeds capacity at EOF', async () => {
    const { body } = source(['data:' + 'a'.repeat(LIMIT - 5), new Uint8Array([0xe4])]);
    const reader = body.getReader();
    const cancel = vi.spyOn(reader, 'cancel');
    vi.spyOn(body, 'getReader').mockReturnValue(reader);
    await expect(collect(body)).rejects.toMatchObject({ name: 'SseFrameLimitError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});

describe('SSE reader ownership', () => {
  it('ends silently when transport abort rejects a pending read', async () => {
    let transport!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { transport = controller; },
    });
    const caller = new AbortController();
    // Fetch observes its signal before the parser receives the response body.
    caller.signal.addEventListener('abort', () => {
      transport.error(new DOMException('Request aborted', 'AbortError'));
    }, { once: true });
    const stream = parseSSEStream(body, caller.signal);
    const pending = stream.next();
    caller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(body.locked).toBe(false);
  });

  it('preserves transport errors when the caller has not cancelled', async () => {
    let transport!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { transport = controller; },
    });
    const failure = new Error('Connection reset');
    const pending = parseSSEStream(body, new AbortController().signal).next();
    transport.error(failure);
    await expect(pending).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it('does not acquire a reader for an already aborted request', async () => {
    const { body } = source([], false);
    const acquire = vi.spyOn(body, 'getReader');
    const controller = new AbortController();
    controller.abort();
    expect((await parseSSEStream(body, controller.signal).next()).done).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each(['pending', 'reject', 'throw'])('aborts a pending read when cancel is %s', async (mode) => {
    const cancel = vi.fn(() => {
      if (mode === 'throw') throw new Error('cancel failed');
      if (mode === 'reject') return Promise.reject(new Error('cancel failed'));
      return new Promise<void>(() => {});
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"partial":')); },
      cancel,
    });
    const controller = new AbortController();
    const stream = parseSSEStream(body, controller.signal);
    const pending = stream.next();
    await Promise.resolve();
    controller.abort();
    expect((await pending).done).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  }, 500);

  it.each(['break', 'return'])('cancels once on consumer %s', async (mode) => {
    const { body, cancel } = source(['data: [DONE]\n\n'], false);
    if (mode === 'break') {
      for await (const event of parseSSEStream(body)) {
        expect(event.data).toBe('[DONE]');
        break;
      }
    } else {
      const stream = parseSSEStream(body);
      await stream.next();
      await stream.return!();
    }
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each(['pending', 'reject'])('does not await %s cleanup on consumer return', async (mode) => {
    const cancel = vi.fn(() => mode === 'pending'
      ? new Promise<void>(() => {}) : Promise.reject(new Error('cancel failed')));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: ok\n\n')); },
      cancel,
    });
    const stream = parseSSEStream(body);
    await stream.next();
    expect((await stream.return!()).done).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  }, 500);
});
