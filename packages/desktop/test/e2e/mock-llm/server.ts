/**
 * A scripted stand-in for an OpenAI-compatible chat endpoint, with no dependencies.
 *
 * The app talks to it through the engine's ordinary `baseUrl` setting - nothing in the app is
 * stubbed - so what a test sees is the real request/stream/tool-call path. The byte shapes
 * (`chat.completion.chunk` frames, `tool_calls` deltas, a final usage frame, `[DONE]`) are the ones
 * `core/src/llm/providers/openai.ts` parses; if that parser changes, `server.test.ts` here and the
 * E2E scenarios fail together, which is the point.
 *
 * Scripted, not random: request N consumes turn N. A script that is NOT fully consumed by the end
 * of a test is a failure (`unconsumed()`), because "the engine asked the model one time fewer than
 * the scenario assumed" is exactly the sort of change that should not pass quietly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockToolCall {
  name: string;
  /** Sent as the streamed `arguments` JSON. */
  args: Record<string, unknown>;
}

export type MockFailure =
  | { status: 429 | 500 | 503; retryAfter?: number }
  /** Close the connection after this many text deltas, without a terminal frame. */
  | { cutAfter: number };

export interface MockTurn {
  /** Text pieces, streamed one frame each. */
  deltas?: string[];
  toolCalls?: MockToolCall[];
  /** Pause before the first frame. */
  delayMs?: number;
  /** Throttle: this many pieces' worth of characters per second (about 4 characters a token). */
  tokensPerSecond?: number;
  fail?: MockFailure;
  /** Hold the stream open after the last delta until the test calls `release()`. */
  holdOpen?: boolean;
}

export interface RecordedRequest {
  path: string;
  model: string | undefined;
  stream: boolean;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }>;
  tools: string[];
  /** Set once the client dropped the connection before the response finished. */
  closedByClient: boolean;
}

export interface MockLlm {
  url: string;
  /** Replace the script and reset the counter. */
  script(turns: MockTurn[]): void;
  requests(): RecordedRequest[];
  /** Turns not yet requested. */
  unconsumed(): number;
  /** Let a `holdOpen` turn finish. */
  release(): void;
  close(): Promise<void>;
}

const EXHAUSTED: MockTurn = { deltas: ['(mock: script exhausted)'] };
const CHARS_PER_TOKEN = 4;

function frame(delta: Record<string, unknown>, finish: string | null = null): string {
  const body = { id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: 'mock-1', choices: [{ index: 0, delta, finish_reason: finish }] };
  return `data: ${JSON.stringify(body)}\n\n`;
}

const usageFrame = (): string =>
  `data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMockLlm(models: string[] = ['mock-1']): Promise<MockLlm> {
  let turns: MockTurn[] = [];
  let next = 0;
  const seen: RecordedRequest[] = [];
  let releaseHold: (() => void) | null = null;

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: { model?: string; stream?: boolean; messages?: RecordedRequest['messages']; tools?: Array<{ function?: { name?: string } }> } = {};
    try { parsed = JSON.parse(await readBody(req)); } catch { /* recorded as an empty request */ }
    const record: RecordedRequest = {
      path: req.url ?? '', model: parsed.model, stream: parsed.stream === true,
      messages: parsed.messages ?? [], tools: (parsed.tools ?? []).map((tool) => tool.function?.name ?? ''), closedByClient: false,
    };
    seen.push(record);
    res.on('close', () => { if (!res.writableEnded) record.closedByClient = true; });

    const turn = turns[next] ?? EXHAUSTED;
    next += 1;
    if (turn.delayMs) await sleep(turn.delayMs);
    if (turn.fail && 'status' in turn.fail) {
      res.writeHead(turn.fail.status, {
        'content-type': 'application/json', ...(turn.fail.retryAfter ? { 'retry-after': String(turn.fail.retryAfter) } : {}),
      });
      res.end(JSON.stringify({ error: { message: `mock failure ${turn.fail.status}`, type: 'mock_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(frame({ role: 'assistant', content: '' }));

    const deltas = turn.deltas ?? [];
    for (let index = 0; index < deltas.length; index += 1) {
      if (turn.fail && 'cutAfter' in turn.fail && index >= turn.fail.cutAfter) { res.destroy(); return; }
      res.write(frame({ content: deltas[index] }));
      if (turn.tokensPerSecond) await sleep(Math.max(1, Math.round(((deltas[index]!.length / CHARS_PER_TOKEN) / turn.tokensPerSecond) * 1000)));
      if (res.destroyed) return;
    }
    if (turn.fail && 'cutAfter' in turn.fail && turn.fail.cutAfter >= deltas.length) { res.destroy(); return; }

    (turn.toolCalls ?? []).forEach((call, index) => {
      const json = JSON.stringify(call.args);
      res.write(frame({ tool_calls: [{ index, id: `call_${next}_${index}`, type: 'function', function: { name: call.name, arguments: '' } }] }));
      // Arguments arrive in two pieces, as a real stream does.
      const cut = Math.ceil(json.length / 2);
      res.write(frame({ tool_calls: [{ index, function: { arguments: json.slice(0, cut) } }] }));
      res.write(frame({ tool_calls: [{ index, function: { arguments: json.slice(cut) } }] }));
    });

    if (turn.holdOpen) await new Promise<void>((resolve) => { releaseHold = resolve; res.on('close', resolve); });
    if (res.destroyed) return;
    res.write(frame({}, (turn.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop'));
    res.write(usageFrame());
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })) }));
      return;
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      void chat(req, res).catch(() => { if (!res.writableEnded) res.destroy(); });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    script(next_) { turns = [...next_]; next = 0; seen.length = 0; },
    requests: () => [...seen],
    unconsumed: () => Math.max(0, turns.length - next),
    release() { releaseHold?.(); releaseHold = null; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
