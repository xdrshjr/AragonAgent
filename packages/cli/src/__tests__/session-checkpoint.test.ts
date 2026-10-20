/**
 * The session checkpoint writer (tui-session-id-resume 7.1 T-6..T-14, T-42,
 * T-46, T-47).
 *
 * THREE OF THESE ARE DATA-LOSS GUARDS rather than formatting checks:
 *
 *   - T-10: a history that cannot be resent is NOT written, so the last good
 *     file survives instead of being replaced by one that 400s on resume.
 *   - T-8 / T-46: every repair happens on a COPY. The engine owns the live
 *     history, and a host that edited it would change the next request.
 *   - T-46 also proves the OTHER direction is untouched: `/save` still records a
 *     `running` card, which is the decision `live-session.test.ts` pins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Message } from '@aragon-agent/core';
import type { Entry, UsageTotal } from '../agent/reducer.js';
import {
  SessionCheckpointWriter,
  closeDanglingToolCalls,
  isSendable,
  settleRunningToolCards,
  type CheckpointDeps,
  type LiveSessionView,
} from '../session/checkpoint.js';
import { SESSION_CHECKPOINT_LIMITS } from '../session/limits.js';
import { loadSession, saveSession } from '../session/persist.js';

// THE WRITE COUNT IS THE ASSERTION IN THREE OF THESE TESTS, and it cannot be
// observed through the file: a second write of unchanged content produces the
// same bytes. The spy keeps the real implementation (so nothing is faked) and
// records how often the serializer actually ran.
vi.mock('../session/persist.js', { spy: true });

const DIR = join(tmpdir(), 'aragon-checkpoint-test');
const MODEL = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' };

const ZERO_USAGE: UsageTotal = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

function userMessage(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function toolCallMessage(toolCallId: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_call', toolCallId, toolName: 'bash', args: {} }],
    stopReason: 'tool_use',
  };
}

function toolEntry(status: 'running' | 'done'): Entry {
  return {
    id: 'e7',
    kind: 'tool',
    toolCallId: 'call-1',
    name: 'bash',
    label: 'Run: npm test',
    argsRaw: '{}',
    status,
    ...(status === 'running'
      ? { live: ['line one'], liveSeq: 2, lastOutputAt: 1_700_000_000_000 }
      : {}),
  };
}

interface Harness {
  writer: SessionCheckpointWriter;
  path: string;
  history: { messages: Message[] };
  entries: Entry[];
}

/** A writer over a temporary directory, with mutable live data. */
function harness(overrides: Partial<CheckpointDeps> = {}): Harness {
  const history: { messages: Message[] } = { messages: [] };
  const entries: Entry[] = [];
  const usage: UsageTotal = { ...ZERO_USAGE };
  const writer = new SessionCheckpointWriter({
    readView: (): LiveSessionView => ({ id: 'a4k2m9', entries, usageTotal: usage }),
    readHistory: () => ({ messages: history.messages }),
    readTodos: () => [],
    readModel: () => MODEL,
    readCwd: () => join(tmpdir(), 'aragon-cwd'),
    version: '0.6.25',
    startPinned: false,
    pathFor: (id) => join(DIR, `${id}.json`),
    // NO REAL LOCK: the writer's lock lives in the sessions directory, which
    // this suite has no business touching. T-48 exercises it through this port.
    lockFor: () => null,
    ...overrides,
  });
  return { writer, path: join(DIR, 'a4k2m9.json'), history, entries };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe('T-6 / T-14 / I-4: the file the loader can read', () => {
  it('writes a session the loader can read', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'), assistantMessage('hello'));
    expect(h.writer.start().ok).toBe(true);

    const saved = loadSession(h.path);
    // UNTRUSTED-INPUT SAFE: `loadSession` runs the full recursive validator, so
    // this assertion covers the entry shapes as well as the history.
    expect(saved.messages).toHaveLength(2);
    expect(saved.meta?.origin).toBe('tui');
    expect(saved.meta?.id).toBe('a4k2m9');
    expect(saved.meta?.cli).toBe('0.6.25');
    // `turns` is counted FROM THE FILE, so it survives a reload unchanged.
    expect(saved.meta?.turns).toBe(1);
  });

  it('writes an empty checkpoint for a zero-turn session', () => {
    const h = harness();
    expect(h.writer.start().ok).toBe(true);
    // A session with no turns is legal and must be resumable: the id is on screen
    // from the first frame, and `--resume` of it has to open, not fail.
    const saved = loadSession(h.path);
    expect(saved.messages).toEqual([]);
    expect(saved.entries).toEqual([]);
  });
});

describe('T-7 / D-4: the atomic replacement', () => {
  it('replaces the file atomically and leaves no temp file', () => {
    const h = harness();
    h.history.messages.push(userMessage('one'));
    h.writer.start();
    h.history.messages.push(assistantMessage('two'));
    h.writer.writeNow();

    expect(readdirSync(DIR).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(loadSession(h.path).messages).toHaveLength(2);
  });
});

describe('T-8 / T-9 / I-2: repairs happen on the copy only', () => {
  it('never mutates the live history', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'), toolCallMessage('call-1'));
    const before = JSON.parse(JSON.stringify(h.history.messages)) as Message[];
    h.writer.start();
    expect(h.history.messages).toEqual(before);
  });

  it('closes a dangling tool call on the copy only', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'), toolCallMessage('call-1'));
    const result = h.writer.start();
    expect(result.ok).toBe(true);
    expect(result.ok && result.repaired).toBe(1);

    const saved = loadSession(h.path);
    const last = saved.messages[saved.messages.length - 1];
    expect(last?.role).toBe('tool_result');
    if (last?.role !== 'tool_result') throw new Error('unreachable');
    expect(last.toolCallId).toBe('call-1');
    expect(last.isError).toBe(true);
    // THE TEXT IS READ BY THE MODEL NEXT TURN, so it is pinned verbatim rather
    // than left to whatever the implementation felt like writing.
    expect(last.content).toBe('interrupted before completion');
    // And the live history still ends with the tool call it ended with before.
    expect(h.history.messages).toHaveLength(2);
  });

  it('is sendable for an empty history and not for an open tool call', () => {
    expect(isSendable([])).toBe(true);
    expect(isSendable([userMessage('hi')])).toBe(true);
    expect(isSendable([toolCallMessage('call-1')])).toBe(false);
    expect(closeDanglingToolCalls([toolCallMessage('call-1')]).repaired).toBe(1);
  });
});

describe('T-10 / D-3 / I-4: the write gate', () => {
  it('skips the write when the history is not sendable', () => {
    const h = harness();
    h.history.messages.push(userMessage('good'), assistantMessage('answer'));
    expect(h.writer.start().ok).toBe(true);
    const good = readFileSync(h.path, 'utf-8');

    // An orphan `tool_result` cannot be repaired host-side: inventing the call it
    // belongs to would forge a tool call the engine never made.
    h.history.messages.push({ role: 'tool_result', toolCallId: 'ghost', content: 'x' });
    const result = h.writer.writeNow();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('not-sendable');
    expect(readFileSync(h.path, 'utf-8')).toBe(good);
  });
});

describe('T-11 / T-11b / I-10: not writing is a success', () => {
  it('does not rewrite an unchanged session', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'));
    h.writer.start();
    const before = statSync(h.path).mtimeMs;
    h.writer.writeNow();
    expect(statSync(h.path).mtimeMs).toBe(before);
  });

  it('coalesces several agent_end events into one write', async () => {
    const h = harness();
    const listeners: Array<() => void> = [];
    h.writer.attach((fn) => {
      listeners.push(fn);
      return () => {};
    });
    h.history.messages.push(userMessage('hi'));
    vi.mocked(saveSession).mockClear();
    // Three boundaries inside the debounce window, exactly as a todo
    // follow-through produces them.
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    expect(existsSync(h.path)).toBe(false);
    await new Promise((resolve) =>
      setTimeout(resolve, SESSION_CHECKPOINT_LIMITS.debounceMs + 250),
    );
    // ONE SERIALIZATION, AND ONLY ONE. Counting messages in the file would pass
    // just as happily after three identical writes, and "there were not three"
    // is the entire claim the debounce makes.
    expect(loadSession(h.path).messages).toHaveLength(1);
    expect(vi.mocked(saveSession)).toHaveBeenCalledTimes(1);
    expect(readdirSync(DIR).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('T-12 / I-8: a failed write never throws', () => {
  it('reports write-failed when the directory refuses the write', () => {
    const parent = join(DIR, 'not-a-directory');
    // A regular FILE where a directory has to be: creating the directory fails on
    // every platform, and the writer must answer with a value, not an exception.
    rmSync(parent, { recursive: true, force: true });
    writeFileSync(parent, 'x');
    const h = harness({ pathFor: (id) => join(parent, `${id}.json`) });
    h.history.messages.push(userMessage('hi'));
    const result = h.writer.start();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('write-failed');
    expect(existsSync(join(parent, 'a4k2m9.json'))).toBe(false);
  });
});

describe('T-13 / 6.1: meta.pinned and meta.live', () => {
  it('marks pinned and live and clears live on the exit flush', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'));
    h.writer.start();
    // The running checkpoint carries `live`; the exit flush must not, or
    // `sessions prune` would treat a finished session as one still being written.
    expect(loadSession(h.path).meta?.live).toBe(true);

    h.writer.writeNow({ pin: true });
    expect(loadSession(h.path).meta?.pinned).toBe(true);

    h.writer.flushSync('exit');
    const saved = loadSession(h.path);
    expect(saved.meta?.pinned).toBe(true);
    expect(saved.meta?.live).toBeUndefined();
  });

  it('is idempotent: the second exit flush writes nothing', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'));
    h.writer.start();
    expect(h.writer.flushSync('exit').ok).toBe(true);
    const after = readFileSync(h.path, 'utf-8');
    h.history.messages.push(assistantMessage('a turn that arrived after exit'));
    expect(h.writer.flushSync('exit').ok).toBe(true);
    expect(readFileSync(h.path, 'utf-8')).toBe(after);
  });
});

describe('T-42 / D-21: the headless shape', () => {
  it('writes exactly one checkpoint for a headless run', () => {
    // `-p` has no App, so there is no transcript: `entries` is empty by design and
    // `messages` is authoritative (K-15).
    const h = harness({ readView: () => ({ id: 'a4k2m9', entries: [], usageTotal: ZERO_USAGE }) });
    h.history.messages.push(userMessage('summarize this'), assistantMessage('done'));
    vi.mocked(saveSession).mockClear();
    expect(h.writer.flushSync('exit').ok).toBe(true);
    const saved = loadSession(h.path);
    expect(saved.entries).toEqual([]);
    expect(saved.messages).toHaveLength(2);
    // EXACTLY ONE: `start()` was never called (S-13), so the placeholder written
    // by the id claim is the only earlier file and this flush is the only write
    // the run makes.
    expect(vi.mocked(saveSession)).toHaveBeenCalledTimes(1);
    // The three exit paths all fire on a normal quit; the second and third must
    // add nothing.
    h.writer.flushSync('exit');
    h.writer.flushSync('signal');
    expect(vi.mocked(saveSession)).toHaveBeenCalledTimes(1);
  });

  it('reports no-identity rather than inventing one', () => {
    const h = harness({ readView: () => undefined });
    const result = h.writer.flushSync('exit');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('no-identity');
    expect(existsSync(h.path)).toBe(false);
  });
});

describe('T-46 / D-22 / I-11: settling live cards', () => {
  it('settles a running tool card on the copy only', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'), assistantMessage('running it'));
    h.entries.push(toolEntry('running'));
    const inputSnapshot = JSON.parse(JSON.stringify(h.entries)) as Entry[];

    expect(h.writer.start().ok).toBe(true);
    const card = loadSession(h.path).entries[0];
    expect(card?.kind).toBe('tool');
    if (card?.kind !== 'tool') throw new Error('unreachable');
    // NOT `running`: a card that never settles keeps `ToolCard` spinning and keeps
    // `Transcript`'s MONOTONIC boundary from ever passing it (D-22).
    expect(card.status).toBe('error');
    expect(card.isError).toBe(true);
    expect(card.preview).toBe('interrupted (session checkpoint)');
    expect(card.live).toBeUndefined();
    expect(card.liveSeq).toBeUndefined();
    expect(card.lastOutputAt).toBeUndefined();
    // THE LIVE COPY IS UNTOUCHED, which is the whole reason this happens here
    // rather than on the load path (I-2).
    expect(JSON.parse(JSON.stringify(h.entries))).toEqual(inputSnapshot);
  });

  it('leaves a settled card exactly as it was', () => {
    const entries = [toolEntry('done')];
    const settled = settleRunningToolCards(entries);
    expect(settled.settled).toBe(0);
    expect(settled.entries[0]).toBe(entries[0]);
  });

  it('DOES NOT change what /save writes: a running card stays running there', () => {
    // THE OTHER HALF OF D-22. `live-session.test.ts` pins this behaviour for
    // `/save`, so the settlement must live in the checkpoint writer and nowhere
    // else - otherwise one of the two decisions silently dies.
    const path = join(DIR, 'exported.json');
    saveSession(path, {
      model: MODEL,
      messages: [userMessage('hi')],
      entries: [toolEntry('running')],
      todos: [],
    });
    const card = loadSession(path).entries[0];
    expect(card?.kind === 'tool' && card.status).toBe('running');
  });

  it('counts what it settled, for the log that explains a later diff (K-10)', () => {
    const h = harness();
    h.history.messages.push(userMessage('hi'));
    h.entries.push(toolEntry('running'));
    const result = h.writer.start();
    expect(result.ok && result.settled).toBe(1);
  });
});

describe('T-48 / S-7: the writer holds the id it writes', () => {
  interface LockTrace {
    requested: string[];
    released: string[];
  }

  function lockHarness(): { harness: Harness; trace: LockTrace } {
    const trace: LockTrace = { requested: [], released: [] };
    const h = harness({
      lockFor: (id: string) => {
        trace.requested.push(id);
        return {
          path: join(DIR, `${id}.lock`),
          release: () => trace.released.push(id),
        };
      },
    });
    return { harness: h, trace };
  }

  it('takes the lock once and releases it on the exit flush', () => {
    // WITHOUT THIS CLAIM `meta.live` IS UNVERIFIABLE, and `sessions prune
    // --origin tui --yes` deletes the checkpoint of a session that is running at
    // that moment: the flag said a writer believed itself alive, and nothing else
    // in the directory could confirm it (S-7).
    const { harness: h, trace } = lockHarness();
    h.history.messages.push(userMessage('hi'));
    h.writer.start();
    h.writer.writeNow();
    // One claim for the whole process, not one per write.
    expect(trace.requested).toEqual(['a4k2m9']);
    expect(trace.released).toEqual([]);

    h.writer.flushSync('exit');
    expect(trace.released).toEqual(['a4k2m9']);
  });

  it('moves the claim to the new id after a rotation', () => {
    // `/resume` rotates the identity (D-15) and the writer follows the published
    // view, so the lock must follow it too - otherwise the old file keeps
    // advertising a live writer that has moved on, and the new one has none.
    let id = 'a4k2m9';
    const trace: LockTrace = { requested: [], released: [] };
    const writer = new SessionCheckpointWriter({
      readView: (): LiveSessionView => ({ id, entries: [], usageTotal: ZERO_USAGE }),
      readHistory: () => ({ messages: [userMessage('hi')] }),
      readTodos: () => [],
      readModel: () => MODEL,
      readCwd: () => join(tmpdir(), 'aragon-cwd'),
      version: '0.6.25',
      pathFor: (target) => join(DIR, `${target}.json`),
      lockFor: (target) => {
        trace.requested.push(target);
        return { path: join(DIR, `${target}.lock`), release: () => trace.released.push(target) };
      },
    });
    expect(writer.start().ok).toBe(true);
    expect(trace.requested).toEqual(['a4k2m9']);

    id = 'a4k2m9-x7f2';
    writer.writeNow();
    expect(trace.released).toEqual(['a4k2m9']);
    expect(trace.requested).toEqual(['a4k2m9', 'a4k2m9-x7f2']);
    writer.dispose();
    expect(trace.released).toEqual(['a4k2m9', 'a4k2m9-x7f2']);
  });

  it('writes anyway when the claim is refused', () => {
    // A lock is a claim on a file, not a gate on the conversation: if someone else
    // holds it the checkpoint is still this id's own content, and refusing to
    // write would lose the transcript to protect a flag.
    const h = harness({ lockFor: () => null });
    h.history.messages.push(userMessage('hi'));
    expect(h.writer.start().ok).toBe(true);
    expect(loadSession(h.path).messages).toHaveLength(1);
  });
});

describe('T-47 / I-4 (second clause): every product re-reads', () => {
  it('re-reads every checkpoint it writes', () => {
    const cases: Array<() => { path: string; entries: number }> = [
      () => {
        const h = harness();
        h.history.messages.push(userMessage('hi'), assistantMessage('hello'));
        h.writer.start();
        return { path: h.path, entries: 0 };
      },
      () => {
        const h = harness();
        h.history.messages.push(userMessage('hi'), toolCallMessage('call-1'));
        h.writer.start();
        return { path: h.path, entries: 0 };
      },
      () => {
        const h = harness();
        h.writer.start();
        return { path: h.path, entries: 0 };
      },
      () => {
        const h = harness();
        h.history.messages.push(userMessage('hi'));
        h.entries.push(toolEntry('running'));
        h.writer.start();
        return { path: h.path, entries: 1 };
      },
    ];
    for (const build of cases) {
      rmSync(DIR, { recursive: true, force: true });
      mkdirSync(DIR, { recursive: true });
      const { path, entries } = build();
      const saved = loadSession(path);
      expect(saved.entries).toHaveLength(entries);
      expect(Array.isArray(saved.messages)).toBe(true);
    }
  });
});
