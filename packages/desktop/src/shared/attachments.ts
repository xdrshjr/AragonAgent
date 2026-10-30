/**
 * Attachments, desktop side (desktop-attachments-and-tool-voice §3.1).
 *
 * Types and PURE functions only: the renderer, the session host and the main process all import
 * this file and share nothing else at run time. The metadata types live in `tui/model`
 * (layering: `Entry` names them) and are re-exported here so every desktop module has one place
 * to import from.
 *
 * Trust: the host never believes the renderer. File type comes from magic bytes, names are
 * re-sanitised, limits are re-checked with the SAME constants the renderer used.
 */

import type {
  AttachmentKind,
  AttachmentMeta,
  ImageMediaType,
} from '@aragon-agent/tui/model/agent/attachment-meta';

export type { AttachmentKind, AttachmentMeta, ImageMediaType };
export { ATTACHMENT_REF_RE, ATTACHMENT_ID_RE, isAttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';

export const ATTACHMENT_LIMITS = {
  /** Anthropic documents 1568 px as the long edge beyond which images are only downscaled. */
  maxImageEdgePx: 1568,
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 8,
  maxImageBytesPerMessage: 20 * 1024 * 1024,
  maxAttachmentsPerMessage: 20,
  /** Soft: past either session limit new images are sent as paths instead (never dropped). */
  maxSessionImageBytes: 48 * 1024 * 1024,
  maxInlineImageMessagesPerSession: 12,
  /** A non-image file with no disk path (dragged out of a browser). */
  maxStagedFileBytes: 25 * 1024 * 1024,
  thumbEdgePx: 160,
  thumbMaxBytes: 12 * 1024,
  maxThumbsPerMessage: 8,
  nameMaxChars: 80,
} as const;

/** Per-command deadline for a `submit` that carries attachment bytes. */
export const COMMAND_TIMEOUT_MS_WITH_ATTACHMENTS = 60_000;

/** One attachment on its way from the composer to the host. */
export interface SubmitAttachment {
  /** 'image1' | 'file2' ...: assigned by the draft, only format-checked by the host. */
  ref: string;
  kind: AttachmentKind;
  name: string;
  /** image: processed bytes. file/folder: absent (path only). Path-less file: staged bytes. */
  bytes?: ArrayBuffer;
  /** A hint only; the host trusts the magic bytes. */
  declaredMediaType?: string;
  /** file/folder: absolute path on the user's machine. */
  path?: string;
  width?: number;
  height?: number;
  /** image: data:image/jpeg;base64,... within `thumbMaxBytes`. */
  thumb?: string;
}

export type ImageMode = 'inline' | 'path';

export type AttachmentRejectReason =
  | 'bad_type'
  | 'too_large'
  | 'too_many'
  | 'session_budget'
  | 'bad_ref'
  | 'stage_failed'
  | 'path_missing';

export interface SubmitResultValue {
  attachments: AttachmentMeta[];
  dropped: { ref: string; reason: AttachmentRejectReason }[];
  /** inline -> path because of a session budget; text and path were both delivered. */
  downgraded?: { ref: string; reason: 'session_budget' | 'image_budget' }[];
}

/** `attachment.read` answer: bytes for staged files, the user's own path for references. */
export interface AttachmentReadValue {
  name: string;
  kind: AttachmentKind;
  mediaType?: string;
  bytes?: ArrayBuffer;
  /** A reference attachment (the user's own file): the renderer re-attaches by path. */
  path?: string;
}

/** Biggest payload `attachment.read` will return (matches the per-message image budget). */
export const ATTACHMENT_READ_MAX_BYTES = 20 * 1024 * 1024;

export const SUBMIT_REF_RE = /^(image|file|folder)[1-9][0-9]{0,2}$/;

/** What the up-to-date UI knows about image input for the active model (host-computed). */
export interface ImageInputView {
  support: 'yes' | 'no' | 'unknown';
  source: 'catalog' | 'discovery' | 'heuristic' | 'override';
  /** Core's `IMAGE_TOKEN_ESTIMATE`; the renderer carries no second copy of the number. */
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

// Path separators, C0/C1 controls, bidi overrides/isolates, zero-width and BOM characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\\/\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩​-‏﻿]/g;

/** A display name that is safe inside a label the MODEL reads and a row the USER reads. */
export function sanitizeAttachmentName(raw: string, maxChars: number = ATTACHMENT_LIMITS.nameMaxChars): string {
  const cleaned = raw.replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const base = cleaned.length > 0 ? cleaned : 'attachment';
  const points = Array.from(base);
  if (points.length <= maxChars) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 10 ? Array.from(base.slice(dot)) : [];
  const room = Math.max(1, maxChars - ext.length - 1);
  return `${points.slice(0, room).join('')}~${ext.join('')}`;
}

// ---------------------------------------------------------------------------
// Image type + metadata
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** PNG / JPEG / GIF / WebP by magic bytes; anything else is not an image we send. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return 'image/gif';
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  return null;
}

/** File extension for a staged copy. */
export function extensionFor(type: ImageMediaType | null): string {
  switch (type) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'bin';
  }
}

/**
 * Remove EXIF/XMP (APP1) and IPTC (APP13) segments from a JPEG; keep ICC (APP2), APP0 and the
 * Adobe APP14 colour marker, which affect how pixels decode. Lossless; a malformed stream is
 * returned unchanged rather than half-edited.
 */
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (!startsWith(input, [0xff, 0xd8])) return input;
  const kept: Uint8Array[] = [input.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) return input;
    const marker = input[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    // Start of scan: the entropy-coded data runs to the end; copy the rest verbatim.
    if (marker === 0xda) { kept.push(input.subarray(offset)); return concat(kept); }
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      kept.push(input.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const length = (input[offset + 2]! << 8) | input[offset + 3]!;
    if (length < 2 || offset + 2 + length > input.length) return input;
    const drop = marker === 0xe1 || marker === 0xed;
    if (!drop) kept.push(input.subarray(offset, offset + 2 + length));
    offset += 2 + length;
  }
  return input;
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** Remove ancillary text/time/EXIF chunks from a PNG; colour and transparency chunks stay. */
export function stripPngAncillary(input: Uint8Array): Uint8Array {
  if (!startsWith(input, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return input;
  const kept: Uint8Array[] = [input.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= input.length) {
    const length = ((input[offset]! << 24) | (input[offset + 1]! << 16) | (input[offset + 2]! << 8) | input[offset + 3]!) >>> 0;
    const end = offset + 12 + length;
    if (end > input.length) return input;
    const type = String.fromCharCode(input[offset + 4]!, input[offset + 5]!, input[offset + 6]!, input[offset + 7]!);
    if (!PNG_DROP.has(type)) kept.push(input.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return concat(kept);
  }
  return input; // no IEND: not a stream we understand well enough to edit
}

/** Dispatch on the sniffed type; GIF and WebP pass through untouched. */
export function stripImageMetadata(bytes: Uint8Array, type: ImageMediaType): Uint8Array {
  if (type === 'image/jpeg') return stripJpegMetadata(bytes);
  if (type === 'image/png') return stripPngAncillary(bytes);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers shared by UI and host
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Roughly how many tokens one image costs; `cap` is the host-declared `tokenEstimate`. */
export function estimateImageTokens(width: number, height: number, cap: number): number {
  if (!(width > 0) || !(height > 0)) return cap;
  return Math.min(cap, Math.ceil((width * height) / 750));
}

/** `@image1` / `@file2` mentions in message text, in order of appearance. */
export function findAttachmentMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(^|\s)@((?:image|file|folder)[1-9][0-9]{0,2})\b/g;
  for (let match = re.exec(text); match; match = re.exec(text)) out.push(match[2]!);
  return out;
}

/** The label the model sees in front of every inline image. ASCII on purpose: agent-facing. */
export function imageLabel(ref: string, name: string, width?: number, height?: number): string {
  const size = width && height ? `, ${width}x${height}` : '';
  return `[${ref}: ${name}${size}]`;
}
