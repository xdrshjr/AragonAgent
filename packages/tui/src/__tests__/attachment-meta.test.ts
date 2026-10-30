import { describe, expect, it } from 'vitest';
import {
  attachmentSummaryLine,
  isAttachmentMeta,
  sanitizeAttachmentMetas,
  type AttachmentMeta,
} from '../model/agent/attachment-meta.js';
import { KNOWN_VOICE_TOOLS, PHRASE_VOICE_TOOLS, THINKING_WORD_COUNT } from '../ui/tool-voice.js';
import { ACTIVITY_PHRASES } from '../ui/activity-phrases.js';

const good: AttachmentMeta = {
  id: 'att-0123456789ab', ref: 'image1', kind: 'image', name: 'shot.png', size: 1024,
  width: 10, height: 10, sent: 'inline', thumb: 'data:image/jpeg;base64,AAAA',
};

describe('isAttachmentMeta', () => {
  it('accepts a well-formed record', () => {
    expect(isAttachmentMeta(good)).toBe(true);
  });
  it.each([
    ['svg thumb', { ...good, thumb: 'data:image/svg+xml,<svg/>' }],
    ['oversize thumb', { ...good, thumb: 'data:image/jpeg;base64,' + 'A'.repeat(20_000) }],
    ['bad id', { ...good, id: 'att-xyz' }],
    ['bad ref', { ...good, ref: 'image0' }],
    ['negative size', { ...good, size: -1 }],
    ['bad sent', { ...good, sent: 'maybe' }],
    ['empty name', { ...good, name: '' }],
    ['not an object', 'x'],
  ])('rejects %s', (_label, value) => {
    expect(isAttachmentMeta(value)).toBe(false);
  });
});

describe('sanitizeAttachmentMetas', () => {
  it('drops only the bad items and counts them', () => {
    const out = sanitizeAttachmentMetas([good, { ...good, size: -1 }, { ...good, id: 'bad' }]);
    expect(out.metas).toEqual([good]);
    expect(out.dropped).toBe(2);
  });
  it('returns undefined when nothing survives', () => {
    expect(sanitizeAttachmentMetas([{ nope: 1 }]).metas).toBeUndefined();
  });
  it('treats an absent field as zero dropped', () => {
    expect(sanitizeAttachmentMetas(undefined)).toEqual({ metas: undefined, dropped: 0 });
  });
});

describe('attachmentSummaryLine', () => {
  it('renders one ASCII-bracketed token per attachment and strips control chars', () => {
    const line = attachmentSummaryLine([good, { ...good, kind: 'file', ref: 'file1', name: 'a\nb.log' }]);
    expect(line).toBe('[image: shot.png] [file: a b.log]');
  });
});

describe('voice table exports', () => {
  it('exposes the table keys and counts', () => {
    expect(KNOWN_VOICE_TOOLS.length).toBeGreaterThan(20);
    expect(KNOWN_VOICE_TOOLS).toContain('read_file');
    expect(PHRASE_VOICE_TOOLS.length).toBeGreaterThan(0);
    expect(THINKING_WORD_COUNT).toBe(ACTIVITY_PHRASES.length);
  });
});
