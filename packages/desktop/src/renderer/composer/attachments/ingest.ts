/**
 * Turning dropped / pasted / picked `File`s into tray entries (spec 3.2).
 *
 *   image            -> decode, shrink if needed, thumbnail      (bytes in memory, status processing)
 *   file / folder    -> the user's OWN path is the attachment    (nothing is copied or uploaded)
 *   path-less file   -> its bytes, staged by the host           (dragged out of a browser)
 *
 * Limits are checked BEFORE a file joins the tray - a drop that would exceed them tells the
 * user at once instead of failing at send time. Everything the sandboxed page may learn about
 * the disk goes through `statPath` (the `native:stat-path` IPC): type and size, never content.
 */

import { ATTACHMENT_LIMITS, formatBytes, type AttachmentRejectReason } from '../../../shared/attachments.js';
import type { Translate } from '../../i18n/index.js';
import {
  addAttachmentDraft,
  getAttachmentDrafts,
  updateAttachmentDraft,
  type AttachmentDraft,
} from './attachment-draft-store.js';
import { looksLikeForeignImage } from './image-formats.js';
import { ImageError, blobToArrayBuffer, processImage, runLimited, type ImageDeps } from './image-pipeline.js';

export type IngestOrigin = 'paste' | 'drop' | 'picker';

export interface IngestDeps {
  /** Absolute path of a `File` on disk, or '' (the preload's `pathForFile`). */
  pathForFile(file: File): string;
  /** Type and size of a path, or null when the question could not be asked. */
  statPath(path: string): Promise<{ kind: 'file' | 'folder' | 'missing'; size: number } | null>;
  image: ImageDeps;
  notify(level: 'info' | 'warn' | 'error', text: string): void;
  t: Translate;
  now(): Date;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const GENERIC_PASTE_NAME = /^(image|unknown|blob)?(\.\w{1,5})?$/i;

/** A conservative first guess from the declared type / extension; the host decides by magic bytes. */
export function looksLikeImage(file: { name: string; type: string }): boolean {
  const type = (file.type ?? '').toLowerCase();
  return IMAGE_TYPES.has(type) || (type === '' && IMAGE_EXT.test(file.name ?? '')) || looksLikeForeignImage(file);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `Screenshot 2026-10-29 14.32.05.png` - what a nameless clipboard image is called. */
export function screenshotName(date: Date, type: string): string {
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'png';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Screenshot ${day} ${time}.${ext}`;
}

function displayName(file: File, origin: IngestOrigin, deps: IngestDeps): string {
  if (origin === 'paste' && GENERIC_PASTE_NAME.test(file.name)) {
    return screenshotName(deps.now(), file.type);
  }
  return file.name || 'attachment';
}

const countsAsImage = (item: AttachmentDraft): boolean => item.kind === 'image' && item.status !== 'error';

/** Why a new file may not join, or null. Checked before it is added. */
function limitFor(sessionId: string, image: boolean, deps: IngestDeps): string | null {
  const items = getAttachmentDrafts(sessionId);
  if (items.length >= ATTACHMENT_LIMITS.maxAttachmentsPerMessage) {
    return deps.t('chat.attach.tooMany', { n: ATTACHMENT_LIMITS.maxAttachmentsPerMessage });
  }
  if (image && items.filter(countsAsImage).length >= ATTACHMENT_LIMITS.maxImagesPerMessage) {
    return deps.t('chat.attach.tooManyImages', { n: ATTACHMENT_LIMITS.maxImagesPerMessage });
  }
  return null;
}

function readyImageBytes(sessionId: string, except?: string): number {
  return getAttachmentDrafts(sessionId)
    .filter((item) => item.kind === 'image' && item.status === 'ready' && item.localId !== except)
    .reduce((sum, item) => sum + item.size, 0);
}

/** Add every file; resolves when all image processing has settled. Never throws. */
export async function ingestFiles(
  sessionId: string, files: readonly File[], origin: IngestOrigin, deps: IngestDeps,
): Promise<AttachmentDraft[]> {
  const added: AttachmentDraft[] = [];
  const jobs: Promise<void>[] = [];
  for (const file of files) {
    const image = looksLikeImage(file);
    const refused = limitFor(sessionId, image, deps);
    if (refused) { deps.notify('warn', refused); continue; }
    if (image) {
      const draft = addAttachmentDraft(sessionId, {
        kind: 'image', name: displayName(file, origin, deps), size: file.size,
        ...(file.type ? { declaredMediaType: file.type } : {}),
      });
      added.push(draft);
      jobs.push(processInto(sessionId, draft, file, deps));
      continue;
    }
    const draft = await addReference(sessionId, file, deps);
    if (draft) added.push(draft);
  }
  await Promise.all(jobs);
  return added;
}

/** The original of an image that failed to process, kept only so Retry has something to retry. */
const failedSources = new Map<string, Blob>();

/** Re-run the processing of an errored image draft (the chip's Retry). */
export function retryImage(sessionId: string, draft: AttachmentDraft, deps: IngestDeps): Promise<void> {
  const source = failedSources.get(draft.localId);
  if (!source) return Promise.resolve();
  updateAttachmentDraft(sessionId, draft.localId, { status: 'processing' });
  return processInto(sessionId, draft, source, deps);
}

export function forgetFailedSource(localId: string): void {
  failedSources.delete(localId);
}

async function processInto(sessionId: string, draft: AttachmentDraft, source: Blob, deps: IngestDeps): Promise<void> {
  try {
    const out = await runLimited(() => processImage(source, deps.image));
    failedSources.delete(draft.localId);
    if (readyImageBytes(sessionId, draft.localId) + out.bytes.byteLength > ATTACHMENT_LIMITS.maxImageBytesPerMessage) {
      failedSources.set(draft.localId, source);
      updateAttachmentDraft(sessionId, draft.localId, { status: 'error', error: 'too_large' });
      return;
    }
    updateAttachmentDraft(sessionId, draft.localId, {
      status: 'ready', bytes: out.bytes, size: out.bytes.byteLength, width: out.width, height: out.height,
      declaredMediaType: out.mediaType,
      ...(out.thumb ? { previewUrl: out.thumb } : {}),
      ...(out.firstFrameOnly ? { firstFrameOnly: true } : {}),
    });
  } catch (error) {
    const reason: AttachmentRejectReason | 'decode_failed' =
      error instanceof ImageError ? (error.reason === 'bad_type' ? 'bad_type' : error.reason) : 'decode_failed';
    failedSources.set(draft.localId, source);
    updateAttachmentDraft(sessionId, draft.localId, { status: 'error', error: reason });
  }
}

async function addReference(sessionId: string, file: File, deps: IngestDeps): Promise<AttachmentDraft | null> {
  const path = deps.pathForFile(file);
  if (path) {
    const stat = await deps.statPath(path);
    if (stat?.kind === 'missing') {
      deps.notify('warn', deps.t('chat.attach.pathMissing', { name: file.name }));
      return null;
    }
    const kind = stat?.kind === 'folder' ? 'folder' : 'file';
    return addAttachmentDraft(sessionId, {
      kind, name: file.name || path, status: 'ready', path, size: Math.max(0, stat?.size ?? file.size),
    });
  }
  if (file.size > ATTACHMENT_LIMITS.maxStagedFileBytes) {
    deps.notify('warn', deps.t('chat.attach.fileTooLarge', {
      name: file.name, limit: formatBytes(ATTACHMENT_LIMITS.maxStagedFileBytes),
    }));
    return null;
  }
  try {
    const bytes = await blobToArrayBuffer(file);
    return addAttachmentDraft(sessionId, {
      kind: 'file', name: file.name || 'attachment', status: 'ready', bytes, size: bytes.byteLength,
    });
  } catch {
    deps.notify('warn', deps.t('chat.attach.pathMissing', { name: file.name }));
    return null;
  }
}
