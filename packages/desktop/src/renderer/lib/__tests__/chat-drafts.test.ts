/**
 * AC-82: drafts survive a reload (sessionStorage) without ever reaching disk or the main process,
 * and storage trouble never breaks typing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_STORED_DRAFT_BYTES, clearDrafts, discardDraft, forgetMemoryDrafts, getDraft, makeChip, setDraft,
} from '../chat-drafts.js';

const KEY = (id: string): string => `aragon.draft.v1.${id}`;

beforeEach(() => { sessionStorage.clear(); clearDrafts(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('draft persistence in sessionStorage', () => {
  it('a draft written now is readable by a reloaded page (memory gone, storage kept)', () => {
    setDraft('s1', { text: 'half a thought', chips: [makeChip('line1\nline2')] });
    forgetMemoryDrafts(); // what a renderer reload does to the module state
    const restored = getDraft('s1');
    expect(restored.text).toBe('half a thought');
    expect(restored.chips).toHaveLength(1);
    expect(restored.chips[0]?.text).toBe('line1\nline2');
  });

  it('writes are synchronous: the last keystroke is already stored when the renderer dies', () => {
    setDraft('s1', { text: 'a', chips: [] });
    setDraft('s1', { text: 'ab', chips: [] });
    expect(JSON.parse(sessionStorage.getItem(KEY('s1'))!)).toEqual({ text: 'ab', chips: [] });
  });

  it('clearing the draft (sent or emptied) removes the stored copy', () => {
    setDraft('s1', { text: 'x', chips: [] });
    setDraft('s1', { text: '', chips: [] });
    expect(sessionStorage.getItem(KEY('s1'))).toBeNull();
    forgetMemoryDrafts();
    expect(getDraft('s1').text).toBe('');
  });

  it('closing a session discards its draft; clearDrafts discards all', () => {
    setDraft('s1', { text: 'x', chips: [] });
    setDraft('s2', { text: 'y', chips: [] });
    discardDraft('s1');
    expect(sessionStorage.getItem(KEY('s1'))).toBeNull();
    expect(sessionStorage.getItem(KEY('s2'))).not.toBeNull();
    clearDrafts();
    expect(sessionStorage.getItem(KEY('s2'))).toBeNull();
  });

  it('an oversize draft stays in memory only, warns once, and no stale shorter copy is left behind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setDraft('s1', { text: 'short', chips: [] });
    setDraft('s1', { text: 'z'.repeat(MAX_STORED_DRAFT_BYTES + 1), chips: [] });
    expect(sessionStorage.getItem(KEY('s1'))).toBeNull();
    expect(getDraft('s1').text.length).toBe(MAX_STORED_DRAFT_BYTES + 1);
    setDraft('s1', { text: 'z'.repeat(MAX_STORED_DRAFT_BYTES + 2), chips: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a storage that throws (quota, disabled) never breaks the draft', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => setDraft('s1', { text: 'still typing', chips: [] })).not.toThrow();
    expect(getDraft('s1').text).toBe('still typing');
    forgetMemoryDrafts();
    expect(() => getDraft('s1')).not.toThrow();
    expect(getDraft('s1').text).toBe('');
  });

  it('a corrupt or hostile stored value is ignored rather than trusted', () => {
    for (const bad of ['not json', '{"text":5,"chips":[]}', '{"text":"x","chips":"no"}', '{"text":"x","chips":[{"id":1}]}', 'null']) {
      sessionStorage.setItem(KEY('s1'), bad);
      forgetMemoryDrafts();
      expect(getDraft('s1').text).toBe('');
    }
  });

  it('NEVER touches localStorage or the main process (a draft may hold a pasted secret)', () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const ipc = vi.fn();
    window.aragon = { platform: 'win32', on: () => () => undefined, invoke: ipc } as unknown as Window['aragon'];
    setDraft('s1', { text: 'sk-secret-ish', chips: [] });
    getDraft('s1');
    clearDrafts();
    // every call went to sessionStorage's prototype - Storage.prototype is shared, so compare receivers
    for (const call of local.mock.contexts) expect(call).toBe(sessionStorage);
    expect(localStorage.length).toBe(0);
    expect(ipc).not.toHaveBeenCalled();
  });
});
