/**
 * Turn a composer submission into what the engine receives (desktop-attachments-and-tool-voice §3.5).
 *
 * THE HOST IS THE ONLY CONSTRUCTOR of the multimodal message and of every label the model reads,
 * so the renderer cannot inject an instruction line, and nothing the user typed is rewritten:
 *
 *   parts[0]            text(message)             message = user words + optional "Attached files:" block
 *   per inline image    text("[image1: a.png, 1568x882]"), image(base64)
 *
 * Each attachment fails alone: a rejected one is reported in `dropped` and the rest (and the
 * text) still go out. The host shares its process with the engine, so everything here is
 * `fs.promises` with a yield between attachments; the base64 of a 5 MiB image must not freeze
 * streaming or the heartbeat.
 *
 * Agent-facing strings in this file are English and ASCII.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import type { ContentPart } from '@aragon-agent/core';
import {
  ATTACHMENT_LIMITS,
  SUBMIT_REF_RE,
  extensionFor,
  imageLabel,
  sanitizeAttachmentName,
  sniffImageType,
  stripImageMetadata,
  type AttachmentMeta,
  type AttachmentRejectReason,
  type ImageMode,
  type ImageMediaType,
  type SubmitAttachment,
  type SubmitResultValue,
} from '../shared/attachments.js';
import { appendLedger, ensureSessionDir, type LedgerEntry } from './attachment-ledger.js';

export interface BuildInput {
  text: string;
  attachments: SubmitAttachment[];
  imageMode: ImageMode;
}

export interface BuildContext {
  /** `<home>/attachments/<sessionId>`, already validated by `sessionAttachmentsDir`. */
  dir: string;
  /** Image parts already in the conversation (budget input). */
  usage(): { bytes: number; messages: number };
}

export interface BuiltSubmission {
  /** The plain-text view: user words plus the host-built path block. */
  message: string;
  /** Present only when at least one image goes inline. */
  parts?: ContentPart[];
  metas: AttachmentMeta[];
  dropped: SubmitResultValue['dropped'];
  downgraded: NonNullable<SubmitResultValue['downgraded']>;
  /** Inline image bytes keyed by id, kept while the message waits in the queue (withdrawal). */
  retained: { id: string; bytes: Uint8Array }[];
}

const THUMB_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
/** data-URL length bound that matches the tui read-side check for `thumbMaxBytes` of image. */
const THUMB_MAX_CHARS = 17_000;
const NO_TEXT = '(no message text; see the attached files)';

const newId = (): string => `att-${randomBytes(6).toString('hex')}`;
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Accumulator {
  built: BuiltSubmission;
  fileLines: string[];
  inlineParts: ContentPart[];
  images: number;
  imageBytes: number;
  thumbs: number;
  sessionBytes: number;
  sessionMessages: number;
}

export async function buildSubmission(input: BuildInput, ctx: BuildContext): Promise<BuiltSubmission> {
  const usage = ctx.usage();
  const acc: Accumulator = {
    built: { message: '', metas: [], dropped: [], downgraded: [], retained: [] },
    fileLines: [], inlineParts: [], images: 0, imageBytes: 0, thumbs: 0,
    sessionBytes: usage.bytes, sessionMessages: usage.messages,
  };
  const seen = new Set<string>();
  let count = 0;
  for (const item of input.attachments) {
    if (count >= ATTACHMENT_LIMITS.maxAttachmentsPerMessage) { drop(acc, item.ref, 'too_many'); continue; }
    if (typeof item.ref !== 'string' || !SUBMIT_REF_RE.test(item.ref) || seen.has(item.ref)) {
      drop(acc, String(item.ref), 'bad_ref');
      continue;
    }
    seen.add(item.ref);
    count += 1;
    const reason = item.kind === 'image'
      ? await addImage(acc, item, input.imageMode, ctx.dir)
      : await addReference(acc, item, ctx.dir);
    if (reason) drop(acc, item.ref, reason);
    await yieldToLoop();
  }
  return finish(acc, input.text);
}

function drop(acc: Accumulator, ref: string, reason: AttachmentRejectReason): void {
  acc.built.dropped.push({ ref, reason });
}

function finish(acc: Accumulator, text: string): BuiltSubmission {
  const { built } = acc;
  const base = text.trim().length > 0 ? text : (built.metas.length > 0 ? NO_TEXT : text);
  built.message = acc.fileLines.length > 0
    ? `${base}\n\nAttached files:\n${acc.fileLines.join('\n')}`
    : base;
  if (acc.inlineParts.length > 0) {
    built.parts = [{ type: 'text', text: built.message }, ...acc.inlineParts];
  }
  return built;
}

async function stage(dir: string, id: string, ext: string, bytes: Uint8Array): Promise<string | null> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${id}.${ext}`);
    await writeFile(path, bytes, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

function record(dir: string, entry: Omit<LedgerEntry, 'at'>): void {
  ensureSessionDirSafe(dir);
  appendLedger(dir, { ...entry, at: Date.now() });
}

function ensureSessionDirSafe(dir: string): void {
  try { ensureSessionDir(dir); } catch { /* the append reports the failure */ }
}

async function addImage(
  acc: Accumulator, item: SubmitAttachment, mode: ImageMode, dir: string,
): Promise<AttachmentRejectReason | null> {
  if (!item.bytes || item.bytes.byteLength === 0) return 'bad_type';
  const bytes = new Uint8Array(item.bytes);
  const type = sniffImageType(bytes);
  if (!type) return 'bad_type'; // the file's own bytes decide, never the declared type
  if (bytes.length > ATTACHMENT_LIMITS.maxImageBytes) return 'too_large';
  if (acc.images >= ATTACHMENT_LIMITS.maxImagesPerMessage) return 'too_many';
  if (acc.imageBytes + bytes.length > ATTACHMENT_LIMITS.maxImageBytesPerMessage) return 'too_large';
  acc.images += 1;
  acc.imageBytes += bytes.length;

  const clean = stripImageMetadata(bytes, type);
  const name = sanitizeAttachmentName(item.name);
  const inline = decideInline(acc, mode, item.ref, clean.length);
  const id = newId();
  const path = await stage(dir, id, extensionFor(type), clean);
  if (path) {
    record(dir, { id, kind: 'image', name, path, size: clean.length, staged: true, mediaType: type });
  } else if (!inline) {
    return 'stage_failed'; // a path-only image with no file has nothing to point at
  }
  const thumb = acceptThumb(acc, item.thumb);
  acc.built.metas.push(metaOf(item, id, name, clean.length, inline ? 'inline' : 'path', thumb));
  if (inline) addInline(acc, item, name, type, clean, id);
  else if (path) acc.fileLines.push(`- ${item.ref}: ${path}`);
  return null;
}

function decideInline(acc: Accumulator, mode: ImageMode, ref: string, size: number): boolean {
  if (mode === 'path') return false;
  const overBytes = acc.sessionBytes + Math.ceil(size * 4 / 3) > ATTACHMENT_LIMITS.maxSessionImageBytes;
  const overMessages = acc.sessionMessages >= ATTACHMENT_LIMITS.maxInlineImageMessagesPerSession;
  if (overBytes || overMessages) {
    acc.built.downgraded.push({ ref, reason: 'session_budget' });
    return false;
  }
  acc.sessionBytes += Math.ceil(size * 4 / 3);
  // The first inline image of this message is what makes it a "message with images".
  if (!acc.built.metas.some((meta) => meta.sent === 'inline')) acc.sessionMessages += 1;
  return true;
}

function addInline(
  acc: Accumulator, item: SubmitAttachment, name: string, type: ImageMediaType, bytes: Uint8Array, id: string,
): void {
  acc.inlineParts.push(
    { type: 'text', text: imageLabel(item.ref, name, item.width, item.height) },
    { type: 'image', mediaType: type, data: Buffer.from(bytes).toString('base64') },
  );
  acc.built.retained.push({ id, bytes });
}

function acceptThumb(acc: Accumulator, thumb: string | undefined): string | undefined {
  if (!thumb || acc.thumbs >= ATTACHMENT_LIMITS.maxThumbsPerMessage) return undefined;
  if (thumb.length > THUMB_MAX_CHARS || !THUMB_RE.test(thumb)) return undefined;
  acc.thumbs += 1;
  return thumb;
}

function metaOf(
  item: SubmitAttachment, id: string, name: string, size: number,
  sent: AttachmentMeta['sent'], thumb?: string,
): AttachmentMeta {
  const dim = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  const width = dim(item.width);
  const height = dim(item.height);
  return {
    id, ref: item.ref, kind: item.kind, name, size, sent,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(thumb ? { thumb } : {}),
  };
}

async function addReference(
  acc: Accumulator, item: SubmitAttachment, dir: string,
): Promise<AttachmentRejectReason | null> {
  const name = sanitizeAttachmentName(item.name);
  const id = newId();
  if (item.path !== undefined) return addPathReference(acc, item, id, name, dir);
  // A file without a disk path (dragged out of a browser): its bytes are staged.
  if (item.kind !== 'file' || !item.bytes) return 'path_missing';
  if (item.bytes.byteLength > ATTACHMENT_LIMITS.maxStagedFileBytes) return 'too_large';
  const bytes = new Uint8Array(item.bytes);
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? 'bin';
  const path = await stage(dir, id, ext, bytes);
  if (!path) return 'stage_failed';
  record(dir, { id, kind: 'file', name, path, size: bytes.length, staged: true });
  acc.built.metas.push(metaOf(item, id, name, bytes.length, 'reference'));
  acc.fileLines.push(`- ${item.ref}: ${path}`);
  return null;
}

async function addPathReference(
  acc: Accumulator, item: SubmitAttachment, id: string, name: string, dir: string,
): Promise<AttachmentRejectReason | null> {
  const path = item.path!;
  if (!isAbsolute(path) || path.includes('\0')) return 'path_missing';
  let info;
  try { info = await stat(path); } catch { return 'path_missing'; }
  // The disk decides folder vs file, not the renderer's claim.
  const kind = info.isDirectory() ? 'folder' : 'file';
  record(dir, { id, kind, name: name || basename(path), path, size: kind === 'folder' ? 0 : info.size, staged: false });
  acc.built.metas.push(metaOf({ ...item, kind }, id, name, kind === 'folder' ? 0 : info.size, 'reference'));
  acc.fileLines.push(`- ${item.ref}: ${path}`);
  return null;
}
