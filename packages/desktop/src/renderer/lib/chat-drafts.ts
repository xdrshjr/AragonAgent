/**
 * Per-session composer drafts: held in memory so switching sessions never loses typed text, and
 * mirrored into `sessionStorage` so a reload or a renderer crash-recovery does not lose it either.
 *
 * NOT persisted to disk: a draft may contain pasted secrets, and the checkpoint/desktop state files
 * are not the place for text the user has not chosen to send. `sessionStorage` belongs to the window's
 * web contents - it survives a reload, vanishes when the app quits and is never written to the user
 * directory. Nothing here touches `localStorage` or the main process; a test pins that.
 */

export interface PasteChipData {
  id: string;
  text: string;
  lines: number;
}

/**
 * An attachment REFERENCE that survives a reload: just enough to put a file/folder chip back
 * (its path) or to tell the user an image was lost. Image bytes are never stored here - they live
 * in memory only (`attachment-draft-store`), because a screenshot may contain a secret.
 */
export interface DraftRef {
  ref: string;
  kind: 'image' | 'file' | 'folder';
  name: string;
  /** file / folder only: the user's own absolute path. */
  path?: string;
}

export interface Draft {
  text: string;
  chips: PasteChipData[];
  /** Absent in drafts written before attachments existed; `setDraft` keeps what is there. */
  refs?: DraftRef[];
}

/** A paste larger than either bound collapses into a chip instead of flooding the textarea. */
export const LARGE_PASTE = { chars: 2000, lines: 40 } as const;

const drafts = new Map<string, Draft>();

const STORAGE_PREFIX = 'aragon.draft.v1.';
/** A serialized draft larger than this is kept in memory only (and warned about once). */
export const MAX_STORED_DRAFT_BYTES = 64 * 1024;
let warnedOversize = false;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // access itself can throw (privacy mode, disabled storage)
  }
}

function isChip(value: unknown): value is PasteChipData {
  const chip = value as Partial<PasteChipData> | null;
  return typeof chip === 'object' && chip !== null && typeof chip.id === 'string'
    && typeof chip.text === 'string' && typeof chip.lines === 'number';
}

function isRef(value: unknown): value is DraftRef {
  const ref = value as Partial<DraftRef> | null;
  return typeof ref === 'object' && ref !== null && typeof ref.ref === 'string' && typeof ref.name === 'string'
    && (ref.kind === 'image' || ref.kind === 'file' || ref.kind === 'folder')
    && (ref.path === undefined || typeof ref.path === 'string');
}

function readStored(sessionId: string): Draft | null {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed.text !== 'string' || !Array.isArray(parsed.chips) || !parsed.chips.every(isChip)) return null;
    const refs = Array.isArray(parsed.refs) ? parsed.refs.filter(isRef) : [];
    return { text: parsed.text, chips: parsed.chips, ...(refs.length > 0 ? { refs } : {}) };
  } catch {
    return null;
  }
}

function writeStored(sessionId: string, draft: Draft | null): void {
  try {
    const area = storage();
    if (!area) return;
    if (draft === null) { area.removeItem(STORAGE_PREFIX + sessionId); return; }
    const raw = JSON.stringify(draft);
    if (raw.length > MAX_STORED_DRAFT_BYTES) {
      area.removeItem(STORAGE_PREFIX + sessionId); // never leave a stale, shorter copy behind
      if (!warnedOversize) {
        warnedOversize = true;
        console.warn('A draft is too large to survive a reload; it is kept in memory only.');
      }
      return;
    }
    area.setItem(STORAGE_PREFIX + sessionId, raw);
  } catch {
    /* quota or disabled storage: the in-memory draft is unaffected */
  }
}

export const EMPTY_DRAFT: Draft = { text: '', chips: [] };

export function getDraft(sessionId: string): Draft {
  const live = drafts.get(sessionId);
  if (live) return live;
  const stored = readStored(sessionId);
  if (stored) drafts.set(sessionId, stored);
  return stored ?? EMPTY_DRAFT;
}

export function setDraft(sessionId: string, draft: Draft): void {
  // The text/chips writer does not know about attachment references: keep the ones on record.
  const refs = draft.refs ?? drafts.get(sessionId)?.refs ?? readStored(sessionId)?.refs;
  const next: Draft = refs && refs.length > 0 ? { ...draft, refs } : { text: draft.text, chips: draft.chips };
  if (next.text === '' && next.chips.length === 0 && !next.refs) {
    drafts.delete(sessionId);
    writeStored(sessionId, null);
    return;
  }
  drafts.set(sessionId, next);
  writeStored(sessionId, next);
}

/** Record the attachment references of a session's draft (empty list = none). */
export function setDraftRefs(sessionId: string, refs: DraftRef[]): void {
  const current = drafts.get(sessionId) ?? readStored(sessionId) ?? EMPTY_DRAFT;
  setDraft(sessionId, { text: current.text, chips: current.chips, refs });
}

/** Forget one session's draft (session closed or deleted). */
export function discardDraft(sessionId: string): void {
  drafts.delete(sessionId);
  writeStored(sessionId, null);
}

export function clearDrafts(): void {
  drafts.clear();
  try {
    const area = storage();
    if (!area) return;
    for (const key of Object.keys(area)) if (key.startsWith(STORAGE_PREFIX)) area.removeItem(key);
  } catch {
    /* nothing to clear */
  }
}

/** Test seam: drop the in-memory map only, as a reloaded page would have it. */
export function forgetMemoryDrafts(): void {
  drafts.clear();
  warnedOversize = false;
}

export function countTextLines(text: string): number {
  return text === '' ? 0 : text.split(/\r\n|\r|\n/).length;
}

export function isLargePaste(text: string): boolean {
  return text.length > LARGE_PASTE.chars || countTextLines(text) > LARGE_PASTE.lines;
}

/** The message that is actually sent: chips first (in paste order), then what was typed. */
export function composeMessage(draft: Draft): string {
  const parts = [...draft.chips.map((chip) => chip.text), draft.text].filter((part) => part.trim() !== '');
  return parts.join('\n\n');
}

export function hasContent(draft: Draft): boolean {
  return composeMessage(draft).trim() !== '';
}

let chipCounter = 0;
export function makeChip(text: string): PasteChipData {
  chipCounter += 1;
  return { id: `paste-${chipCounter}`, text, lines: countTextLines(text) };
}
