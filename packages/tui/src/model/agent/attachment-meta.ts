/**
 * Attachment metadata carried by transcript entries (desktop-attachments-and-tool-voice).
 *
 * Pure types and pure functions: no IO, no React, no Ink, nothing Electron. It lives in
 * `tui/model` because `Entry` (here), `SubmitMessageOptions` (cli) and the desktop all
 * name it, and the layering is core <- tui <- cli <- desktop. ASCII ONLY.
 *
 * Only METADATA ever reaches an entry: never the bytes. The thumbnail is a tiny data URL so
 * a reopened session can paint its strip without touching the staging area.
 */

export type AttachmentKind = 'image' | 'file' | 'folder';
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface AttachmentMeta {
  /** 'att-' + 12 hex, host-assigned; also the staging file name and ledger key. */
  readonly id: string;
  /** 'image1' | 'file2' ...; stable within one message. */
  readonly ref: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  /** Bytes (0 for a folder). */
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  /** data:image/(jpeg|png|webp);base64,... capped at `ATTACHMENT_META_LIMITS.thumbMaxChars`. */
  readonly thumb?: string;
  /** Whether the image part really went to the model, or only its path did. */
  readonly sent: 'inline' | 'path' | 'reference';
}

export const ATTACHMENT_META_LIMITS = {
  nameMaxChars: 200,
  /** ~12 KiB of image bytes as base64 plus the data-URL prefix. */
  thumbMaxChars: 17_000,
  maxPerEntry: 20,
} as const;

/** `@image1`, `@file2`, `@folder3` as written in message text. */
export const ATTACHMENT_REF_RE = /^(image|file|folder)[1-9][0-9]{0,2}$/;
export const ATTACHMENT_ID_RE = /^att-[0-9a-f]{12}$/;
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * One dim terminal row for entries that carry attachments: `[image: a.png] [file: b.log]`.
 * The terminal has no thumbnails, so this is the whole of its attachment UI. ASCII brackets.
 */
export function attachmentSummaryLine(attachments: readonly AttachmentMeta[]): string {
  return attachments.map((a) => `[${a.kind}: ${a.name.replace(/[\u0000-\u001f\u007f]/g, ' ')}]`).join(' ');
}

/** Read-side validation: a session file is untrusted input. */
export function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== 'string' || !ATTACHMENT_ID_RE.test(m.id)) return false;
  if (typeof m.ref !== 'string' || !ATTACHMENT_REF_RE.test(m.ref)) return false;
  if (m.kind !== 'image' && m.kind !== 'file' && m.kind !== 'folder') return false;
  if (typeof m.name !== 'string' || m.name.length === 0
    || m.name.length > ATTACHMENT_META_LIMITS.nameMaxChars) return false;
  if (typeof m.size !== 'number' || !Number.isFinite(m.size) || m.size < 0) return false;
  if (m.sent !== 'inline' && m.sent !== 'path' && m.sent !== 'reference') return false;
  for (const key of ['width', 'height'] as const) {
    const dim = m[key];
    if (dim !== undefined && (typeof dim !== 'number' || !Number.isFinite(dim) || dim < 0)) return false;
  }
  if (m.thumb !== undefined) {
    if (typeof m.thumb !== 'string' || m.thumb.length > ATTACHMENT_META_LIMITS.thumbMaxChars
      || !THUMB_RE.test(m.thumb)) return false;
  }
  return true;
}

/**
 * Keep the valid items of a loaded list and report how many were dropped; one bad item
 * must never cost the whole session. Returns undefined for "no attachments".
 */
export function sanitizeAttachmentMetas(value: unknown): { metas: AttachmentMeta[] | undefined; dropped: number } {
  if (!Array.isArray(value)) return { metas: undefined, dropped: value === undefined ? 0 : 1 };
  const kept = value.slice(0, ATTACHMENT_META_LIMITS.maxPerEntry).filter(isAttachmentMeta);
  const dropped = value.length - kept.length;
  return { metas: kept.length > 0 ? kept : undefined, dropped };
}
