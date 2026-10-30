import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translate } from '../../../i18n/index.js';
import { ATTACHMENT_LIMITS } from '../../../../shared/attachments.js';
import { getAttachmentDrafts, resetAttachmentStore } from '../attachment-draft-store.js';
import { type ImageDeps } from '../image-pipeline.js';
import { ingestFiles, looksLikeImage, retryImage, screenshotName, type IngestDeps } from '../ingest.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const imageDeps: ImageDeps = {
  decode: async () => ({ width: 10, height: 10, close: () => undefined }),
  encode: async () => new Blob([Uint8Array.from([1])], { type: 'image/jpeg' }),
  toDataUrl: async () => 'data:image/jpeg;base64,AAAA',
};

let notes: string[];
let paths: Record<string, string>;
let stat: IngestDeps['statPath'];
const deps = (over: Partial<IngestDeps> = {}): IngestDeps => ({
  pathForFile: (file) => paths[file.name] ?? '',
  statPath: (path) => stat(path),
  image: imageDeps,
  notify: (_level, text) => notes.push(text),
  t: translate,
  now: () => new Date(2026, 9, 29, 14, 32, 5),
  ...over,
});

beforeEach(() => {
  resetAttachmentStore();
  notes = [];
  paths = {};
  stat = async () => ({ kind: 'file', size: 5 });
});
afterEach(() => vi.restoreAllMocks());

describe('looksLikeImage / screenshotName', () => {
  it('trusts the four formats the providers accept, plus the four it converts (BMP / AVIF / ICO / SVG)', () => {
    expect(looksLikeImage({ name: 'a', type: 'image/webp' })).toBe(true);
    expect(looksLikeImage({ name: 'a.PNG', type: '' })).toBe(true);
    for (const type of ['image/svg+xml', 'image/bmp', 'image/avif', 'image/x-icon']) expect(looksLikeImage({ name: 'a', type })).toBe(true);
    expect(looksLikeImage({ name: 'a.svg', type: '' })).toBe(true);
    // The browser cannot decode these, so they stay file references (completion spec X-1).
    for (const type of ['image/heic', 'image/heif', 'image/tiff', 'application/pdf']) expect(looksLikeImage({ name: 'a', type })).toBe(false);
    expect(looksLikeImage({ name: 'a.heic', type: '' })).toBe(false);
  });

  it('names a nameless clipboard picture after the local time', () => {
    expect(screenshotName(new Date(2026, 9, 29, 14, 32, 5), 'image/png')).toBe('Screenshot 2026-10-29 14.32.05.png');
    expect(screenshotName(new Date(2026, 0, 2, 3, 4, 5), 'image/jpeg')).toBe('Screenshot 2026-01-02 03.04.05.jpg');
  });
});

describe('ingestFiles', () => {
  it('refers to a file on disk by its path and never reads or copies it', async () => {
    paths['run.log'] = 'C:\\work\\run.log';
    stat = async () => ({ kind: 'file', size: 2048 });
    const file = new File(['secret'], 'run.log');
    const read = vi.fn();
    Object.defineProperty(file, 'arrayBuffer', { value: read });
    await ingestFiles('s1', [file], 'drop', deps());
    expect(getAttachmentDrafts('s1')).toMatchObject([{ kind: 'file', ref: 'file1', status: 'ready', path: 'C:\\work\\run.log', size: 2048 }]);
    expect(getAttachmentDrafts('s1')[0]!.bytes).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('classifies a folder by what the disk says and reports a missing path without adding it', async () => {
    paths.d = 'C:\\d';
    paths.gone = 'C:\\gone';
    stat = async (path) => (path === 'C:\\d' ? { kind: 'folder', size: 0 } : { kind: 'missing', size: 0 });
    await ingestFiles('s1', [new File([''], 'd'), new File([''], 'gone')], 'drop', deps());
    expect(getAttachmentDrafts('s1').map((item) => [item.kind, item.ref])).toEqual([['folder', 'folder1']]);
    expect(notes).toEqual(['"gone" could not be found, so it was not attached.']);
  });

  it('stages a file with no disk path by its bytes, within the size limit', async () => {
    await ingestFiles('s1', [new File([Uint8Array.from([1, 2, 3])], 'doc.txt')], 'drop', deps());
    expect(getAttachmentDrafts('s1')[0]).toMatchObject({ kind: 'file', status: 'ready', size: 3 });
    const big = new File([new Uint8Array(8)], 'big.bin');
    Object.defineProperty(big, 'size', { value: ATTACHMENT_LIMITS.maxStagedFileBytes + 1 });
    await ingestFiles('s1', [big], 'drop', deps());
    expect(getAttachmentDrafts('s1')).toHaveLength(1);
    expect(notes[0]).toContain('"big.bin" is too large to attach');
  });

  it('keeps the twenty-first attachment out of the tray and says so', async () => {
    const files = Array.from({ length: 21 }, (_unused, index) => new File([Uint8Array.from([index])], `f${index}.txt`));
    await ingestFiles('s1', files, 'drop', deps());
    expect(getAttachmentDrafts('s1')).toHaveLength(ATTACHMENT_LIMITS.maxAttachmentsPerMessage);
    expect(notes).toEqual(['At most 20 attachments per message.']);
  });

  it('keeps a picture that cannot be decoded as an error chip, and Retry processes it again', async () => {
    let fail = true;
    const flaky: ImageDeps = { ...imageDeps, decode: async () => { if (fail) throw new Error('x'); return { width: 4, height: 4, close: () => undefined }; } };
    const [added] = await ingestFiles('s1', [new File([PNG], 'a.png', { type: 'image/png' })], 'drop', deps({ image: flaky }));
    expect(getAttachmentDrafts('s1')[0]).toMatchObject({ status: 'error', error: 'decode_failed' });
    fail = false;
    await retryImage('s1', added!, deps({ image: flaky }));
    expect(getAttachmentDrafts('s1')[0]).toMatchObject({ status: 'ready', width: 4, height: 4 });
  });

  it('refuses a ninth picture before it joins the tray', async () => {
    const files = Array.from({ length: 9 }, (_unused, index) => new File([PNG], `p${index}.png`, { type: 'image/png' }));
    await ingestFiles('s1', files, 'drop', deps());
    expect(getAttachmentDrafts('s1').filter((item) => item.kind === 'image')).toHaveLength(ATTACHMENT_LIMITS.maxImagesPerMessage);
    expect(notes).toEqual(['At most 8 images per message.']);
  });
});
