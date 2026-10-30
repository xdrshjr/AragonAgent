/**
 * A withdrawn queued message comes back with its attachments (spec 3.7).
 *
 * `queue.cancel` answers `{ text, attachmentIds, attachments }`: the metadata is enough to
 * rebuild the chips, and `attachment.read` fetches each one's bytes (or, for a reference, the
 * user's own path) from the host, which kept them for exactly this. One item that cannot be
 * fetched never costs the others; the caller is told how many failed so it can say so.
 */

import type { AttachmentMeta, AttachmentReadValue } from '../../../shared/attachments.js';
import type { CommandResult } from '../../../shared/port-protocol.js';
import { restoreAttachmentDrafts, type AttachmentDraft } from './attachment-draft-store.js';

export interface WithdrawnValue {
  text?: string;
  attachments?: AttachmentMeta[];
}

export function isWithdrawnValue(value: unknown): value is Required<Pick<WithdrawnValue, 'attachments'>> & WithdrawnValue {
  return typeof value === 'object' && value !== null
    && Array.isArray((value as WithdrawnValue).attachments) && (value as WithdrawnValue).attachments!.length > 0;
}

export function draftFromRead(meta: AttachmentMeta, read: AttachmentReadValue): AttachmentDraft | null {
  const base = {
    localId: '', ref: meta.ref, kind: meta.kind, name: meta.name, status: 'ready' as const, size: meta.size,
    ...(meta.width ? { width: meta.width } : {}),
    ...(meta.height ? { height: meta.height } : {}),
    ...(meta.thumb ? { previewUrl: meta.thumb } : {}),
  };
  if (read.path) return { ...base, path: read.path };
  if (!read.bytes) return null;
  return {
    ...base, bytes: read.bytes, size: read.bytes.byteLength,
    ...(read.mediaType ? { declaredMediaType: read.mediaType } : {}),
  };
}

/** Returns the number of attachments that could not be brought back. */
export async function restoreWithdrawnAttachments(
  sessionId: string,
  value: { attachments: AttachmentMeta[] },
  read: (id: string) => Promise<CommandResult>,
): Promise<number> {
  const drafts: AttachmentDraft[] = [];
  let failed = 0;
  for (const meta of value.attachments) {
    const answer = await read(meta.id);
    const draft = answer.ok ? draftFromRead(meta, answer.value as AttachmentReadValue) : null;
    if (draft) drafts.push(draft); else failed += 1;
  }
  if (drafts.length > 0) restoreAttachmentDrafts(sessionId, drafts);
  return failed;
}
