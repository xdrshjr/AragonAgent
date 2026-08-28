/**
 * Saving and resuming a session with a retry card (llm-api-retry-backoff §11,
 * AC-26).
 *
 * `normalizeLoadedEntries` is the third clause of the load-path fix the team and
 * todo cards each already needed (R-10). Two things go wrong without it, and only
 * the first is visible: the card claims to be counting down to an instant in the
 * past, AND it never settles — so `Transcript`'s MONOTONIC boundary never advances
 * past it and every frame for the rest of the session re-renders the whole tail.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-retry-sess-'));
process.env.ARAGON_HOME = TMP;

const { saveSession, loadSession, normalizeLoadedEntries } = await import(
  '../session/persist.js'
);
const { computeSettledCount } = await import('../ui/Transcript.js');
type Entry = import('../agent/reducer.js').Entry;

const SESSION = join(TMP, 'retry-session.json');

function card(phase: Extract<Entry, { kind: 'retry' }>['phase'], resumeAt?: number): Entry {
  return {
    id: 'e3',
    kind: 'retry',
    attempt: 3,
    maxRetries: 10,
    errorType: 'overloaded',
    message: 'anthropic API error 529: overloaded',
    delayMs: 8000,
    ...(resumeAt !== undefined ? { resumeAt } : {}),
    phase,
    startedAt: 1_700_000_000_000,
  };
}

beforeEach(() => {
  rmSync(SESSION, { force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('a card saved mid-wait resumes as interrupted (AC-26)', () => {
  it('rewrites phase and drops resumeAt', () => {
    const entries: Entry[] = [
      { id: 'e1', kind: 'user', text: 'hello' },
      card('waiting', 1_700_000_030_000),
    ];
    saveSession(SESSION, {
      model: { providerId: 'anthropic', modelId: 'claude' },
      messages: [],
      entries,
      todos: [],
    });

    const loaded = loadSession(SESSION);
    const restored = loaded.entries.find((e) => e.kind === 'retry') as Extract<
      Entry,
      { kind: 'retry' }
    >;
    expect(restored.phase).toBe('interrupted');
    expect(restored.resumeAt).toBeUndefined();
    // Everything else survives, so the row still reports what the turn cost.
    expect(restored).toMatchObject({ attempt: 3, maxRetries: 10, errorType: 'overloaded' });
  });

  it('normalizes the `retrying` phase too, not only `waiting`', () => {
    const [normalized] = normalizeLoadedEntries([card('retrying')]) as Array<
      Extract<Entry, { kind: 'retry' }>
    >;
    expect(normalized?.phase).toBe('interrupted');
  });

  it('leaves an ALREADY-SETTLED card exactly as it was', () => {
    for (const phase of ['recovered', 'exhausted', 'interrupted'] as const) {
      const original = card(phase);
      const [normalized] = normalizeLoadedEntries([original]);
      expect(normalized, phase).toEqual(original);
    }
  });

  it('the restored transcript does not pin the settled boundary', () => {
    // The second half of R-10, and the one a user only notices as a session that
    // gets slower the longer it runs.
    const entries: Entry[] = [
      { id: 'e1', kind: 'user', text: 'hello' },
      card('waiting', 1_700_000_030_000),
      { id: 'e4', kind: 'notice', level: 'info', text: 'resumed' },
    ];
    saveSession(SESSION, {
      model: { providerId: 'anthropic', modelId: 'claude' },
      messages: [],
      entries,
      todos: [],
    });
    const loaded = loadSession(SESSION);
    const settled = computeSettledCount(loaded.entries, {});
    // Everything but the live tail is settled, i.e. the card is in `<Static>`.
    expect(settled).toBe(loaded.entries.length - 1);
  });

  it('the card round-trips through JSON without a format change', () => {
    // JSON-serialisable by construction is what keeps `SESSION_VERSION` at 1.
    const entries: Entry[] = [card('recovered')];
    saveSession(SESSION, {
      model: { providerId: 'anthropic', modelId: 'claude' },
      messages: [],
      entries,
      todos: [],
    });
    expect(loadSession(SESSION).entries).toEqual(entries);
    expect(loadSession(SESSION).version).toBe(1);
  });
});
