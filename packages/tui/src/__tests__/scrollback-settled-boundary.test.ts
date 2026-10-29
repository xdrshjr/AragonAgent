import { describe, expect, it } from 'vitest';
import { CONTEXT_OVERFLOW_NOTICE_PREFIX, type Entry } from '../model/agent/reducer.js';
import {
  isEntryStable,
  isExcluded,
  settleAllEntries,
  settledCount,
} from '../ui/scrollback/settled-boundary.js';

const user = (id: string): Entry => ({ id, kind: 'user', text: id });
const assistant = (id: string, streaming: boolean): Entry => ({
  id, kind: 'assistant', text: 'x', thinkingOpen: false, streaming,
});
const tool = (id: string, status: 'pending' | 'running' | 'done' | 'error'): Entry => ({
  id, kind: 'tool', toolCallId: id, name: 'bash', label: 'bash', argsRaw: '{}', status,
});
const service = (id: string, terminal?: boolean): Entry => ({
  id, kind: 'service', serviceId: id, command: 'srv', status: 'running', exitCode: null,
  startedAt: 0, rows: [], rowsSeen: 0, jobKind: 'service', lastOutputAt: 0, ...(terminal ? { terminal: true } : {}),
}) as Entry;
const notice = (id: string, text: string, level: 'info' | 'warn' | 'error' = 'info'): Entry => ({
  id, kind: 'notice', level, text,
});

describe('isEntryStable (per-kind rule table)', () => {
  it('rejects_printing_running_tool', () => {
    expect(isEntryStable(tool('t', 'running'), true, true)).toBe(false);
  });

  it('rejects_printing_pending_tool (argsRaw is still being streamed)', () => {
    expect(isEntryStable(tool('t', 'pending'), true, true)).toBe(false);
    expect(isEntryStable(tool('t', 'pending'), false, true)).toBe(false);
  });

  it('accepts done and error tools', () => {
    expect(isEntryStable(tool('t', 'done'), true, false)).toBe(true);
    expect(isEntryStable(tool('t', 'error'), true, false)).toBe(true);
  });

  it('assistant is stable only once streaming is over', () => {
    expect(isEntryStable(assistant('a', true), false, true)).toBe(false);
    expect(isEntryStable(assistant('a', false), false, true)).toBe(true);
  });

  it('holds_trailing_context_overflow_notice_while_run_active', () => {
    const overflow = notice('n', `${CONTEXT_OVERFLOW_NOTICE_PREFIX} - try /compact`, 'error');
    expect(isEntryStable(overflow, true, true)).toBe(false);
    expect(isEntryStable(overflow, true, false)).toBe(true); // no longer the tail
    expect(isEntryStable(overflow, false, true)).toBe(true); // run is over
    expect(isEntryStable(notice('n', 'hello', 'error'), true, true)).toBe(true);
    expect(
      isEntryStable(notice('n', `${CONTEXT_OVERFLOW_NOTICE_PREFIX} x`, 'info'), true, true),
    ).toBe(true);
  });

  it('live-flagged cards are unstable until their flag drops', () => {
    const todo = (live: boolean): Entry =>
      ({ id: 't', kind: 'todo', items: [], doneCount: 0, total: 0, live }) as Entry;
    expect(isEntryStable(todo(true), true, false)).toBe(false);
    expect(isEntryStable(todo(false), true, false)).toBe(true);
    const team = (active: boolean): Entry => ({
      id: 'm', kind: 'team', dispatchId: 'd', requested: 1, runs: [], aborted: false, active,
    });
    expect(isEntryStable(team(true), false, false)).toBe(false);
    expect(isEntryStable(team(false), false, false)).toBe(true);
    const fast = (live: boolean): Entry => ({
      id: 'f', kind: 'fast', reviewIndex: 1, model: 'm', status: 'running', turn: 1, live,
    });
    expect(isEntryStable(fast(true), false, false)).toBe(false);
    expect(isEntryStable(fast(false), false, false)).toBe(true);
  });

  it('retry is stable only in its settled phases', () => {
    const retry = (phase: 'waiting' | 'retrying' | 'recovered' | 'exhausted' | 'interrupted'): Entry => ({
      id: 'r', kind: 'retry', attempt: 1, maxRetries: 3, errorType: 'x', message: 'm', delayMs: 1,
      phase, startedAt: 0,
    });
    expect(isEntryStable(retry('waiting'), false, false)).toBe(false);
    expect(isEntryStable(retry('retrying'), false, false)).toBe(false);
    for (const phase of ['recovered', 'exhausted', 'interrupted'] as const) {
      expect(isEntryStable(retry(phase), false, false)).toBe(true);
    }
  });

  it('queued_never_stable', () => {
    const queued: Entry = { id: 'q', kind: 'queued', text: 'later' };
    expect(isEntryStable(queued, false, true)).toBe(false);
    expect(isEntryStable(queued, true, false)).toBe(false);
  });
});

describe('settledCount', () => {
  it('prints_user_message_even_as_last_entry', () => {
    expect(settledCount([user('u1')], true)).toBe(1);
    expect(settledCount([assistant('a', false), user('u1')], true)).toBe(2);
  });

  it('holds a mutable tail while a run is active, releases it when idle', () => {
    const entries = [user('u1'), assistant('a1', false)];
    expect(settledCount(entries, true)).toBe(1);
    expect(settledCount(entries, false)).toBe(2);
  });

  it('prints_final_assistant_when_idle', () => {
    expect(settledCount([user('u'), assistant('a', false)], false)).toBe(2);
  });

  it('the first unstable entry is a wall: nothing after it prints', () => {
    const entries = [user('u1'), assistant('a1', true), user('u2'), assistant('a2', false)];
    expect(settledCount(entries, true)).toBe(1);
  });

  it('a pending tool blocks everything behind it even if later entries are stable', () => {
    const entries = [user('u'), tool('t1', 'pending'), tool('t2', 'done'), assistant('a', false)];
    expect(settledCount(entries, true)).toBe(1);
  });

  it('excluded_service_card_is_never_printed_and_never_a_wall', () => {
    const entries = [user('u1'), service('s1'), user('u2'), assistant('a', false)];
    expect(isExcluded(entries[1]!)).toBe(true);
    expect(settledCount(entries, false)).toBe(4);
    expect(settleAllEntries(entries).map((e) => e.id)).toEqual(['u1', 'u2', 'a']);
  });

  it('service_does_not_block_later_entries', () => {
    const entries = [service('s1'), user('u1'), assistant('a', false)];
    // The service card is skipped, the user message prints, the mutable tail is held.
    expect(settledCount(entries, true)).toBe(2);
    expect(settledCount(entries, false)).toBe(3);
  });

  it('terminal_service_record_prints_in_order', () => {
    const entries = [user('u1'), service('s1', true), user('u2')];
    expect(isExcluded(entries[1]!)).toBe(false);
    expect(isEntryStable(entries[1]!, false, false)).toBe(true);
    expect(settledCount(entries, false)).toBe(3);
  });

  it('a trailing overflow notice holds the boundary while the run is active', () => {
    const overflow = notice('n', `${CONTEXT_OVERFLOW_NOTICE_PREFIX} x`, 'error');
    expect(settledCount([user('u'), overflow], true)).toBe(1);
    expect(settledCount([user('u'), overflow], false)).toBe(2);
  });

  it('settleAllEntries drops queued entries', () => {
    const entries: Entry[] = [user('u'), { id: 'q', kind: 'queued', text: 'x' }];
    expect(settleAllEntries(entries).map((e) => e.id)).toEqual(['u']);
  });

  it('is empty for an empty transcript', () => {
    expect(settledCount([], true)).toBe(0);
    expect(settledCount([], false)).toBe(0);
  });
});
