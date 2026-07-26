import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearExitSnapshot,
  publishExitSnapshot,
  readExitSnapshot,
} from '../ui/exit-snapshot.js';
import type { Entry } from '../agent/reducer.js';

const entry = (id: string): Entry => ({ id, kind: 'user', text: id });
const usage = { inputTokens: 1, outputTokens: 2, costUsd: 0.5 };

beforeEach(() => clearExitSnapshot());

describe('exit snapshot', () => {
  it('returns undefined before anything is published (replay is skipped, not crashed)', () => {
    expect(readExitSnapshot()).toBeUndefined();
  });

  it('hands the same entries array back across the React boundary', () => {
    const entries = [entry('a'), entry('b')];
    publishExitSnapshot({
      entries,
      usageTotal: usage,
      provider: 'anthropic',
      model: 'm',
      startedAt: 10,
    });
    expect(readExitSnapshot()?.entries).toBe(entries);
  });

  it('overwrites rather than appends', () => {
    publishExitSnapshot({
      entries: [entry('a')],
      usageTotal: usage,
      provider: 'anthropic',
      model: 'm',
      startedAt: 10,
    });
    publishExitSnapshot({
      entries: [entry('a'), entry('b')],
      usageTotal: usage,
      provider: 'anthropic',
      model: 'm2',
      startedAt: 10,
    });
    const snap = readExitSnapshot();
    expect(snap?.entries).toHaveLength(2);
    expect(snap?.model).toBe('m2');
  });
});
