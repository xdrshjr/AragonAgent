/**
 * Pure helpers for showing attachments in the transcript. No React, no DOM.
 */

import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; ref: string; attachment: AttachmentMeta };

const MENTION_RE = /(^|\s)@((?:image|file|folder)[1-9][0-9]{0,2})\b/g;

/**
 * Split message text into plain runs and `@imageN` mentions that name one of `attachments`.
 * A mention that matches nothing (an e-mail address, a stray handle) stays plain text. The
 * concatenation of every segment's text (a mention contributing `@ref`) is ALWAYS the input, so
 * what the user typed is never rewritten.
 */
export function splitMentions(text: string, attachments: readonly AttachmentMeta[] | undefined): TextSegment[] {
  if (!attachments || attachments.length === 0 || !text.includes('@')) return [{ kind: 'text', text }];
  const byRef = new Map(attachments.map((a) => [a.ref, a]));
  const out: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const ref = match[2]!;
    const attachment = byRef.get(ref);
    if (!attachment) continue;
    const lead = match[1]!;
    const start = (match.index ?? 0) + lead.length; // the '@'
    if (start > cursor) out.push({ kind: 'text', text: text.slice(cursor, start) });
    out.push({ kind: 'mention', ref, attachment });
    cursor = start + 1 + ref.length;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/** Base64 of raw bytes without blowing the argument limit of `String.fromCharCode`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/** Only these ever become an `<img>` source from host bytes; the CSP allows `data:` images. */
const SHOWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function dataUrlFor(mediaType: string | undefined, bytes: ArrayBuffer): string | null {
  if (!mediaType || !SHOWABLE.has(mediaType)) return null;
  return `data:${mediaType};base64,${bytesToBase64(new Uint8Array(bytes))}`;
}
