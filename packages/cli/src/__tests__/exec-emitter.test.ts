/**
 * The three output faces (cli-integration-surface section 5.1 / AC-3 / AC-4 /
 * AC-5 / AC-6 / AC-26).
 *
 * STDOUT PURITY IS THE PROPERTY UNDER TEST. Every assertion here is ultimately
 * about one thing: in `json` and `stream-json` mode, stdout carries the schema
 * and nothing else, because a single stray byte corrupts every consumer -
 * silently, and only in the field (R-2).
 */

import { describe, expect, it } from 'vitest';
import {
  createEmitter,
  JsonEmitter,
  StreamJsonEmitter,
  TextEmitter,
} from '../exec/emitter.js';
import { EXEC_SCHEMA_VERSION, type ExecResultParams } from '../exec/events.js';

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => chunks.join(''),
  };
}

const INIT = {
  sessionId: 's1',
  cli: '0.6.0',
  cwd: '/w',
  startedAt: 1,
  model: { provider: 'anthropic', id: 'm', baseUrl: null },
  permissionMode: 'auto' as const,
  tools: ['read_file', 'bash'],
  resumed: false,
};

const RESULT: ExecResultParams = {
  sessionId: 's1',
  isError: false,
  stopReason: 'end_turn',
  exitCode: 0,
  result: 'done',
  turns: 1,
  durationMs: 5,
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  cost: { amount: 0, currency: 'USD', known: false },
  model: { provider: 'anthropic', id: 'm' },
  todos: null,
  error: null,
};

describe('AC-4 / AC-5: stream-json framing', () => {
  it('emits one JSON object per line and starts with system/init', () => {
    const out = sink();
    const emitter = new StreamJsonEmitter(out.stream);
    emitter.init(INIT);
    emitter.emit({ type: 'user', sessionId: 's1', turn: 1, text: 'hi', source: 'caller' });
    emitter.result(RESULT);

    const lines = out.text().trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      schemaVersion: EXEC_SCHEMA_VERSION,
      sessionId: 's1',
      permissionMode: 'auto',
    });
    expect(parsed[0]?.tools).toEqual(['read_file', 'bash']);
    expect(parsed[0]?.capabilities).toEqual([
      'interrupt', 'fast-policy', 'fast-tier-events', 'session-file', 'turn-lifecycle', 'execution-progress',
    ]);
    expect(parsed[1]?.type).toBe('user');
    expect(parsed[2]?.type).toBe('result');
  });

  it('never pretty-prints, so a line reader can rely on one object per line', () => {
    const out = sink();
    const emitter = new StreamJsonEmitter(out.stream);
    emitter.init(INIT);
    expect(out.text().split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });
});

describe('AC-6: exactly one `result`, always last', () => {
  it('is idempotent in stream-json', () => {
    const out = sink();
    const emitter = new StreamJsonEmitter(out.stream);
    emitter.init(INIT);
    emitter.result(RESULT);
    emitter.result({ ...RESULT, exitCode: 1 });
    const lines = out.text().trimEnd().split('\n');
    expect(lines.filter((l) => l.includes('"type":"result"'))).toHaveLength(1);
    expect(emitter.emitted()?.exitCode).toBe(0);
  });

  it('drops events that arrive after it, so `result` stays last', () => {
    // A late `tool_result` from a torn-down subscription must not break the
    // property every consumer builds its read loop around.
    const out = sink();
    const emitter = new StreamJsonEmitter(out.stream);
    emitter.result(RESULT);
    emitter.emit({ type: 'assistant', sessionId: 's1', turn: 9, text: 'late' });
    expect(out.text()).not.toContain('late');
  });

  it('is idempotent in json mode too', () => {
    const out = sink();
    const emitter = new JsonEmitter(out.stream);
    emitter.result(RESULT);
    emitter.result(RESULT);
    expect(out.text().match(/"type": "result"/g)).toHaveLength(1);
  });
});

describe('AC-3: json mode writes exactly one object and nothing else', () => {
  it('drops init and every intermediate event', () => {
    const out = sink();
    const emitter = new JsonEmitter(out.stream);
    emitter.init(INIT);
    emitter.emit({ type: 'user', sessionId: 's1', turn: 1, text: 'hi', source: 'caller' });
    emitter.result(RESULT);
    const parsed = JSON.parse(out.text()) as Record<string, unknown>;
    expect(parsed.type).toBe('result');
    expect(parsed.schemaVersion).toBe(EXEC_SCHEMA_VERSION);
  });
});

describe('D-1: the text emitter writes nothing at all', () => {
  it('records the result without producing a byte', () => {
    // `runHeadless` owns every byte of the text stream; this object exists only
    // so `runExec` has one shape to talk to.
    const emitter = new TextEmitter();
    emitter.init(INIT);
    emitter.emit({ type: 'assistant', sessionId: 's1', turn: 1, text: 'x' });
    emitter.result(RESULT);
    expect(emitter.emitted()?.stopReason).toBe('end_turn');
  });

  it('is what `createEmitter` returns for `text`', () => {
    const out = sink();
    const emitter = createEmitter('text', out.stream);
    emitter.init(INIT);
    emitter.result(RESULT);
    expect(out.text()).toBe('');
  });
});

describe('AC-26: a 100 KB tool result survives the round trip', () => {
  it('serialises to one line and re-parses intact', () => {
    // NO SECOND TRUNCATION: the event carries what the model saw, which is the
    // only faithful choice - so a consumer needs a line reader with no small
    // buffer cap, and the README says so.
    const out = sink();
    const emitter = new StreamJsonEmitter(out.stream);
    const payload = `${'x'.repeat(50_000)}\nline two\t${'y'.repeat(50_000)}`;
    emitter.emit({
      type: 'tool_result',
      sessionId: 's1',
      turn: 1,
      id: 't1',
      name: 'bash',
      isError: false,
      durationMs: 3,
      output: payload,
    });
    const text = out.text();
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(text) as { output: string };
    expect(parsed.output).toBe(payload);
  });
});
