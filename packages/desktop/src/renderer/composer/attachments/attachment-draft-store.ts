/**
 * The attachments of each session's message-in-progress, in memory (spec 3.2, D-2, D-17).
 *
 * WHY NOT IN `chat-drafts`: that module mirrors the draft into `sessionStorage` so a reload keeps
 * the text, and image bytes must never go there (a screenshot may hold a secret). Only light
 * references to files and folders (a path, a name) are mirrored back into the draft, so a crash
 * recovery keeps them; an image that was lost is reported once through `hydrate`.
 *
 * Reference names (`image1`, `file2`): counted per kind, per message, NEVER reused after a
 * removal - so an `@image2` already typed into the text cannot silently point at a different
 * picture. The counters reset when the message is sent.
 */

import {
  getDraft,
  setDraftRefs,
  type DraftRef,
} from '../../lib/chat-drafts.js';
import {
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentRejectReason,
  type ImageMode,
  type SubmitAttachment,
} from '../../../shared/attachments.js';

export type DraftStatus = 'processing' | 'ready' | 'error';
export type DraftError = AttachmentRejectReason | 'decode_failed';

export interface AttachmentDraft {
  /** Stable React key and handle; not the reference name. */
  localId: string;
  ref: string;
  kind: AttachmentKind;
  name: string;
  status: DraftStatus;
  error?: DraftError;
  /** Size in bytes of what will be sent (0 for a folder / unknown). */
  size: number;
  bytes?: ArrayBuffer;
  declaredMediaType?: string;
  path?: string;
  width?: number;
  height?: number;
  /** `data:` thumbnail, the only preview form the CSP allows. */
  previewUrl?: string;
  /** An animated GIF was reduced to its first frame (shown as a note on the chip). */
  firstFrameOnly?: boolean;
}

interface SessionAttachments {
  items: AttachmentDraft[];
  counters: Record<AttachmentKind, number>;
  /** The user's explicit choice on the capability banner; null = follow the default. */
  modeChoice: ImageMode | null;
  /** The `unknown` hint was closed for this message. */
  hintDismissed: boolean;
}

const EMPTY_ITEMS: readonly AttachmentDraft[] = Object.freeze([]);
const sessions = new Map<string, SessionAttachments>();
const listeners = new Set<() => void>();
let localCounter = 0;
/** Which sessions have been read back from the persisted references already. */
const hydrated = new Set<string>();
let version = 0;

const fresh = (): SessionAttachments => ({
  items: [], counters: { image: 0, file: 0, folder: 0 }, modeChoice: null, hintDismissed: false,
});

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function subscribeAttachments(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Bumps on every change; a cheap `useSyncExternalStore` snapshot for per-session selectors. */
export const attachmentsVersion = (): number => version;

function sessionOf(sessionId: string): SessionAttachments {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = fresh();
    sessions.set(sessionId, entry);
  }
  return entry;
}

export function getAttachmentDrafts(sessionId: string): readonly AttachmentDraft[] {
  return sessions.get(sessionId)?.items ?? EMPTY_ITEMS;
}

export function getModeChoice(sessionId: string): ImageMode | null {
  return sessions.get(sessionId)?.modeChoice ?? null;
}

export function isHintDismissed(sessionId: string): boolean {
  return sessions.get(sessionId)?.hintDismissed === true;
}

export function setModeChoice(sessionId: string, mode: ImageMode | null): void {
  sessionOf(sessionId).modeChoice = mode;
  notify();
}

export function dismissHint(sessionId: string): void {
  sessionOf(sessionId).hintDismissed = true;
  notify();
}

function persistRefs(sessionId: string): void {
  const items = sessions.get(sessionId)?.items ?? [];
  const refs: DraftRef[] = items
    .filter((item) => item.status !== 'error' || item.kind !== 'image')
    .map((item) => ({
      ref: item.ref, kind: item.kind, name: item.name,
      ...(item.kind !== 'image' && item.path ? { path: item.path } : {}),
    }));
  setDraftRefs(sessionId, refs);
}

/** Allocate the next reference name for a kind. Names are never recycled within a message. */
export function nextRef(sessionId: string, kind: AttachmentKind): string {
  const entry = sessionOf(sessionId);
  entry.counters[kind] += 1;
  return `${kind}${entry.counters[kind]}`;
}

export interface NewDraft {
  kind: AttachmentKind;
  name: string;
  status?: DraftStatus;
  size?: number;
  bytes?: ArrayBuffer;
  declaredMediaType?: string;
  path?: string;
  width?: number;
  height?: number;
  previewUrl?: string;
  /** Restoring: keep the original reference name. */
  ref?: string;
}

export function addAttachmentDraft(sessionId: string, init: NewDraft): AttachmentDraft {
  const entry = sessionOf(sessionId);
  const ref = init.ref ?? nextRef(sessionId, init.kind);
  if (init.ref) {
    const number = Number(init.ref.replace(/^\D+/, ''));
    if (Number.isFinite(number)) entry.counters[init.kind] = Math.max(entry.counters[init.kind], number);
  }
  localCounter += 1;
  const draft: AttachmentDraft = {
    localId: `att-draft-${localCounter}`,
    ref, kind: init.kind, name: init.name, status: init.status ?? 'processing', size: init.size ?? 0,
    ...(init.bytes ? { bytes: init.bytes } : {}),
    ...(init.declaredMediaType ? { declaredMediaType: init.declaredMediaType } : {}),
    ...(init.path ? { path: init.path } : {}),
    ...(init.width ? { width: init.width } : {}),
    ...(init.height ? { height: init.height } : {}),
    ...(init.previewUrl ? { previewUrl: init.previewUrl } : {}),
  };
  entry.items = [...entry.items, draft];
  persistRefs(sessionId);
  notify();
  return draft;
}

export function updateAttachmentDraft(sessionId: string, localId: string, patch: Partial<AttachmentDraft>): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  let changed = false;
  entry.items = entry.items.map((item) => {
    if (item.localId !== localId) return item;
    changed = true;
    const { error: _cleared, ...rest } = item;
    return { ...rest, ...patch };
  });
  if (!changed) return;
  persistRefs(sessionId);
  notify();
}

/** Remove by reference name; returns the removed draft (or null). */
export function removeAttachmentDraft(sessionId: string, ref: string): AttachmentDraft | null {
  return removeAttachmentDrafts(sessionId, [ref])[0] ?? null;
}

/**
 * Remove several drafts as ONE operation: they share an undo slot, so a single "Undo" brings
 * them all back. Only `ready` drafts are kept for undo - an error or half-processed one holds
 * nothing worth restoring.
 */
export function removeAttachmentDrafts(sessionId: string, refs: readonly string[]): AttachmentDraft[] {
  const entry = sessions.get(sessionId);
  if (!entry) return [];
  const found = entry.items.filter((item) => refs.includes(item.ref));
  if (found.length === 0) return [];
  entry.items = entry.items.filter((item) => !found.includes(item));
  if (!entry.items.some((item) => item.kind === 'image')) { entry.modeChoice = null; entry.hintDismissed = false; }
  rememberRemoved(sessionId, found.filter((item) => item.status === 'ready'));
  persistRefs(sessionId);
  notify();
  return found;
}

// ---- undo buffer for removed attachments (completion spec U-1) ---------------------------------
//
// In memory only, like the drafts: the bytes of a screenshot never reach sessionStorage or a log.
// The buffer is the one place image bytes outlive the tray, so every way out is explicit: a
// successful send, closing / leaving the session, 30 s, or being pushed out by newer removals.

/** Removal operations (a batch counts once) remembered per session. */
export const REMOVED_BUFFER_MAX = 5;
export const REMOVED_BUFFER_TTL_MS = 30_000;

interface RemovedDraft {
  draft: AttachmentDraft;
  /** All drafts removed by one operation share a group. */
  group: number;
  timer: ReturnType<typeof setTimeout>;
}

const removedBuffers = new Map<string, RemovedDraft[]>();
let removalGroup = 0;

function dropRemoved(sessionId: string, predicate: (item: RemovedDraft) => boolean): void {
  const kept: RemovedDraft[] = [];
  for (const item of removedBuffers.get(sessionId) ?? []) {
    if (predicate(item)) clearTimeout(item.timer); else kept.push(item);
  }
  if (kept.length > 0) removedBuffers.set(sessionId, kept); else removedBuffers.delete(sessionId);
}

function rememberRemoved(sessionId: string, drafts: readonly AttachmentDraft[]): void {
  if (drafts.length === 0) return;
  removalGroup += 1;
  const group = removalGroup;
  const added = drafts.map<RemovedDraft>((draft) => ({
    draft, group,
    timer: setTimeout(() => dropRemoved(sessionId, (item) => item.draft.localId === draft.localId), REMOVED_BUFFER_TTL_MS),
  }));
  const all = [...(removedBuffers.get(sessionId) ?? []), ...added];
  const groups = [...new Set(all.map((item) => item.group))];
  const evicted = new Set(groups.slice(0, Math.max(0, groups.length - REMOVED_BUFFER_MAX)));
  removedBuffers.set(sessionId, all);
  if (evicted.size > 0) dropRemoved(sessionId, (item) => evicted.has(item.group));
}

/** How many removed drafts are still restorable (tests, and the toast's "Undo" visibility). */
export function removedBufferSize(sessionId: string): number {
  return removedBuffers.get(sessionId)?.length ?? 0;
}

export function clearRemovedBuffer(sessionId: string): void {
  dropRemoved(sessionId, () => true);
}

export type RestoreResult =
  | { ok: true; draft: AttachmentDraft; originalRef: string }
  | { ok: false; reason: 'gone' | 'limit' };

/**
 * Put a removed draft back. It keeps its reference name when nobody else took it - so an
 * `@image2` already typed into the text is valid again - and gets a fresh one otherwise.
 * Counted against the same per-message limits as a new attachment.
 */
export function restoreRemovedDraft(sessionId: string, localId: string): RestoreResult {
  const held = removedBuffers.get(sessionId)?.find((item) => item.draft.localId === localId);
  if (!held) return { ok: false, reason: 'gone' };
  const entry = sessionOf(sessionId);
  const { draft } = held;
  const imageCount = entry.items.filter((item) => item.kind === 'image' && item.status !== 'error').length;
  if (entry.items.length >= ATTACHMENT_LIMITS.maxAttachmentsPerMessage
    || (draft.kind === 'image' && imageCount >= ATTACHMENT_LIMITS.maxImagesPerMessage)) {
    return { ok: false, reason: 'limit' };
  }
  const taken = entry.items.some((item) => item.ref === draft.ref);
  const ref = taken ? nextRef(sessionId, draft.kind) : draft.ref;
  if (!taken) {
    const number = Number(ref.replace(/^\D+/, ''));
    if (Number.isFinite(number)) entry.counters[draft.kind] = Math.max(entry.counters[draft.kind], number);
  }
  localCounter += 1;
  const restored: AttachmentDraft = { ...draft, ref, localId: `att-draft-${localCounter}`, status: 'ready' };
  dropRemoved(sessionId, (item) => item.draft.localId === localId);
  entry.items = [...entry.items, restored];
  persistRefs(sessionId);
  notify();
  return { ok: true, draft: restored, originalRef: draft.ref };
}

/** After a send (or an explicit discard): empty the tray and start the numbering over. */
export function clearAttachmentDrafts(sessionId: string): void {
  clearRemovedBuffer(sessionId);
  if (!sessions.has(sessionId)) return;
  sessions.set(sessionId, fresh());
  persistRefs(sessionId);
  notify();
}

/** Drop everything for a closed session. */
export function forgetAttachments(sessionId: string): void {
  clearRemovedBuffer(sessionId);
  sessions.delete(sessionId);
  hydrated.delete(sessionId);
  notify();
}

/**
 * Put previously built drafts back (a withdrawn queued message, an edited failed send). They
 * are `ready` and keep their reference names; anything already in the tray stays.
 */
export function restoreAttachmentDrafts(sessionId: string, items: readonly AttachmentDraft[]): void {
  const entry = sessionOf(sessionId);
  for (const item of items) {
    if (entry.items.some((existing) => existing.ref === item.ref)) continue;
    const number = Number(item.ref.replace(/^\D+/, ''));
    if (Number.isFinite(number)) entry.counters[item.kind] = Math.max(entry.counters[item.kind], number);
    localCounter += 1;
    entry.items = [...entry.items, { ...item, localId: `att-draft-${localCounter}`, status: 'ready' }];
  }
  persistRefs(sessionId);
  notify();
}

/**
 * Read the persisted references back after a reload. Files and folders return as `ready` chips;
 * images cannot (their bytes were never stored), so their count is returned for one toast.
 * Idempotent per session.
 */
export function hydrateAttachments(sessionId: string): { lostImages: number } {
  if (hydrated.has(sessionId) || (sessions.get(sessionId)?.items.length ?? 0) > 0) {
    hydrated.add(sessionId);
    return { lostImages: 0 };
  }
  hydrated.add(sessionId);
  const refs = getDraft(sessionId).refs ?? [];
  if (refs.length === 0) return { lostImages: 0 };
  const entry = sessionOf(sessionId);
  let lost = 0;
  for (const ref of refs) {
    const number = Number(ref.ref.replace(/^\D+/, ''));
    if (Number.isFinite(number)) entry.counters[ref.kind] = Math.max(entry.counters[ref.kind], number);
    if (ref.kind === 'image' || !ref.path) { lost += ref.kind === 'image' ? 1 : 0; continue; }
    localCounter += 1;
    entry.items = [...entry.items, {
      localId: `att-draft-${localCounter}`, ref: ref.ref, kind: ref.kind, name: ref.name, status: 'ready',
      size: 0, path: ref.path,
    }];
  }
  persistRefs(sessionId);
  notify();
  return { lostImages: lost };
}

/** What goes over the port for one draft: no UI-only fields. */
export function toSubmitAttachment(draft: AttachmentDraft): SubmitAttachment {
  return {
    ref: draft.ref, kind: draft.kind, name: draft.name,
    ...(draft.bytes ? { bytes: draft.bytes } : {}),
    ...(draft.declaredMediaType ? { declaredMediaType: draft.declaredMediaType } : {}),
    ...(draft.path ? { path: draft.path } : {}),
    ...(draft.width ? { width: draft.width } : {}),
    ...(draft.height ? { height: draft.height } : {}),
    ...(draft.previewUrl && draft.kind === 'image' ? { thumb: draft.previewUrl } : {}),
  };
}

/** Test seam: forget everything, as a fresh window would. */
export function resetAttachmentStore(): void {
  for (const sessionId of [...removedBuffers.keys()]) clearRemovedBuffer(sessionId);
  sessions.clear();
  hydrated.clear();
  version += 1;
  for (const listener of [...listeners]) listener();
}
