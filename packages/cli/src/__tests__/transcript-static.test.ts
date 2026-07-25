import { describe, expect, it } from 'vitest';
import { computeSettledCount } from '../ui/Transcript.js';
import type { Entry } from '../agent/reducer.js';

const user = (id: string): Entry => ({ id, kind: 'user', text: 'hi' });
const asstDone = (id: string): Entry => ({
  id,
  kind: 'assistant',
  text: 'a',
  thinkingOpen: false,
  streaming: false,
});
const asstStreaming = (id: string): Entry => ({
  id,
  kind: 'assistant',
  text: 'a',
  thinkingOpen: false,
  streaming: true,
});
const toolDone = (id: string): Entry => ({
  id,
  kind: 'tool',
  toolCallId: 'c',
  name: 'bash',
  label: 'bash',
  argsRaw: '',
  status: 'done',
});
const toolRunning = (id: string): Entry => ({
  id,
  kind: 'tool',
  toolCallId: 'c',
  name: 'bash',
  label: 'bash',
  argsRaw: '',
  status: 'running',
});

describe('computeSettledCount', () => {
  it('always keeps the last entry live', () => {
    const entries = [user('e1'), asstDone('e2'), toolDone('e3')];
    expect(computeSettledCount(entries, {})).toBe(2);
  });

  it('stops before a streaming assistant entry', () => {
    const entries = [user('e1'), asstStreaming('e2'), toolDone('e3')];
    expect(computeSettledCount(entries, {})).toBe(1);
  });

  it('stops before a running tool card', () => {
    const entries = [user('e1'), toolRunning('e2'), asstDone('e3')];
    expect(computeSettledCount(entries, {})).toBe(1);
  });

  it('stops before an expanded tool card', () => {
    const entries = [user('e1'), toolDone('e2'), asstDone('e3'), user('e4')];
    expect(computeSettledCount(entries, { e2: true })).toBe(1);
  });

  it('is non-decreasing as entries terminalize', () => {
    const a = computeSettledCount([user('e1')], {});
    const b = computeSettledCount([user('e1'), asstDone('e2')], {});
    const c = computeSettledCount([user('e1'), asstDone('e2'), toolDone('e3')], {});
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(c).toBe(2);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(b);
  });
});
