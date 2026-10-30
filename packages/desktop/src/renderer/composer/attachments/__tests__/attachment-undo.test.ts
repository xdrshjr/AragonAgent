import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOVED_BUFFER_MAX, REMOVED_BUFFER_TTL_MS, addAttachmentDraft, clearAttachmentDrafts, forgetAttachments,
  getAttachmentDrafts, removeAttachmentDraft, removeAttachmentDrafts, removedBufferSize, resetAttachmentStore,
  restoreRemovedDraft,
} from '../attachment-draft-store.js';

const ready = (sessionId: string, name = 'a.png') =>
  addAttachmentDraft(sessionId, {
    kind: 'image', name, status: 'ready', size: 3, bytes: Uint8Array.from([1, 2, 3]).buffer, declaredMediaType: 'image/png',
  });

beforeEach(() => { vi.useFakeTimers(); resetAttachmentStore(); });
afterEach(() => { vi.useRealTimers(); resetAttachmentStore(); });

describe('undoing a removal', () => {
  it('restores the same bytes under the SAME reference when nobody took it', () => {
    ready('s1', 'a.png');
    const second = ready('s1', 'b.png');
    removeAttachmentDraft('s1', second.ref);
    const result = restoreRemovedDraft('s1', second.localId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.ref).toBe('image2');
    expect(result.originalRef).toBe('image2');
    expect(new Uint8Array(result.draft.bytes!)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(getAttachmentDrafts('s1').map((d) => d.ref)).toEqual(['image1', 'image2']);
  });

  it('keeps the counter ahead: a picture added meanwhile gets image2, and image1 comes back as image1', () => {
    const first = ready('s1');
    removeAttachmentDraft('s1', first.ref);
    const next = ready('s1', 'c.png');
    expect(next.ref).toBe('image2');
    const result = restoreRemovedDraft('s1', first.localId);
    expect(result.ok && result.draft.ref).toBe('image1');
  });

  it('gives a new reference when the old one has been taken', () => {
    const first = ready('s1');
    removeAttachmentDrafts('s1', [first.ref]);
    addAttachmentDraft('s1', {
      kind: 'image', name: 'x.png', status: 'ready', ref: 'image1', size: 1, bytes: new ArrayBuffer(1), declaredMediaType: 'image/png',
    });
    const result = restoreRemovedDraft('s1', first.localId);
    expect(result.ok && result.draft.ref).not.toBe('image1');
    expect(result.ok && result.originalRef).toBe('image1');
  });

  it('is refused (and keeps the entry) when the message is already full', () => {
    const first = ready('s1');
    removeAttachmentDraft('s1', first.ref);
    for (let index = 0; index < 8; index += 1) ready('s1', `p${index}.png`);
    expect(restoreRemovedDraft('s1', first.localId)).toEqual({ ok: false, reason: 'limit' });
    expect(removedBufferSize('s1')).toBe(1);
  });

  it('restores a whole batch removal draft by draft', () => {
    const drafts = [ready('s1', 'a.png'), ready('s1', 'b.png'), ready('s1', 'c.png')];
    removeAttachmentDrafts('s1', drafts.map((d) => d.ref));
    expect(getAttachmentDrafts('s1')).toHaveLength(0);
    for (const draft of drafts) expect(restoreRemovedDraft('s1', draft.localId).ok).toBe(true);
    expect(getAttachmentDrafts('s1')).toHaveLength(3);
  });

  it('does not keep a processing draft - there is nothing to restore', () => {
    const processing = addAttachmentDraft('s1', { kind: 'image', name: 'p.png' });
    removeAttachmentDraft('s1', processing.ref);
    expect(removedBufferSize('s1')).toBe(0);
  });
});

describe('when the undo buffer lets go of the bytes (AC-U2)', () => {
  it('after a successful send (the tray is cleared)', () => {
    removeAttachmentDraft('s1', ready('s1').ref);
    expect(removedBufferSize('s1')).toBe(1);
    clearAttachmentDrafts('s1');
    expect(removedBufferSize('s1')).toBe(0);
  });

  it('when the session closes', () => {
    removeAttachmentDraft('s1', ready('s1').ref);
    forgetAttachments('s1');
    expect(removedBufferSize('s1')).toBe(0);
  });

  it('after 30 seconds', () => {
    removeAttachmentDraft('s1', ready('s1').ref);
    vi.advanceTimersByTime(REMOVED_BUFFER_TTL_MS - 1);
    expect(removedBufferSize('s1')).toBe(1);
    vi.advanceTimersByTime(2);
    expect(removedBufferSize('s1')).toBe(0);
  });

  it('when newer removals push the oldest out', () => {
    const ids: string[] = [];
    for (let index = 0; index < REMOVED_BUFFER_MAX + 1; index += 1) {
      const draft = ready('s1', `p${index}.png`);
      ids.push(draft.localId);
      removeAttachmentDraft('s1', draft.ref);
    }
    expect(removedBufferSize('s1')).toBe(REMOVED_BUFFER_MAX);
    expect(restoreRemovedDraft('s1', ids[0]!)).toEqual({ ok: false, reason: 'gone' });
  });

  it('is per session: another session keeps its own buffer', () => {
    removeAttachmentDraft('s1', ready('s1').ref);
    removeAttachmentDraft('s2', ready('s2').ref);
    forgetAttachments('s1');
    expect(removedBufferSize('s2')).toBe(1);
  });
});
