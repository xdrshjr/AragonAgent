/**
 * "Export as Markdown": the main-process half. The renderer builds the Markdown (it owns the
 * transcript); this module decides WHERE it goes and makes sure no configured secret goes with it.
 *
 * Electron-free: the save dialog, the redactor and the file writer are injected, so the flow
 * (cancel, oversize, redact, atomic write, failure) is unit-tested without a window.
 *
 * Redaction is best effort and deliberately layered: the engine's own redactor (the one the
 * diagnostics zip uses), then an exact-substring pass over every configured API key, then a pattern
 * pass for the common key shapes. The dialog tells the user to review the file before sharing it.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { IpcResult } from '../shared/ipc-contract.js';

export const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const MAX_NAME = 60;
const REDACTED = '[redacted]';
/** Key shapes worth catching even when the key is not in the configuration. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

export interface SessionExportRequest {
  sessionId: string;
  suggestedName: string;
  markdown: string;
  cwd?: string;
}

export interface SessionExportDeps {
  /** Show the save dialog; null when the user cancelled. */
  chooseFile(defaultPath: string): Promise<string | null>;
  /** The engine's redactor (same one the diagnostics export uses). */
  redact(text: string): string;
  /** Every configured API key, for exact-substring removal. */
  secrets(): readonly string[];
  /** Write `text` to `path` so a half-written file is never visible. */
  writeAtomic(path: string, text: string): void;
  /** Where the dialog opens: the session's working directory when it exists, else Documents. */
  defaultDirectory(cwd: string | undefined): string;
  now(): Date;
}

/** Letters, digits, `.`, `_`, `-` and CJK survive; everything else becomes `-`. */
export function slugifyName(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9._㐀-鿿぀-ヿ가-힯-]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, MAX_NAME);
  return slug || 'conversation';
}

export function stampOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function suggestFileName(suggestedName: string, date: Date): string {
  return `${slugifyName(suggestedName.replace(/\.md$/i, ''))}-${stampOf(date)}.md`;
}

/** Remove configured keys (exact), then known key shapes, then run the engine's redactor. */
export function scrubSecrets(text: string, secrets: readonly string[], redact: (text: string) => string): string {
  let out = text;
  // Longest first, so a key that contains another key is removed whole.
  for (const secret of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED);
  }
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return redact(out);
}

/**
 * Every API key the configuration holds: the `apiKeys` map, and any `apiKey` field anywhere (model
 * profiles). The engine's secret registry covers only the profile keys, so a key typed in the legacy
 * per-provider map would otherwise reach an exported file unless it happened to look like a known vendor key.
 */
export function collectConfigSecrets(config: unknown, depth = 0): string[] {
  if (depth > 6 || typeof config !== 'object' || config === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (key === 'apiKeys' && typeof value === 'object' && value !== null) {
      for (const secret of Object.values(value as Record<string, unknown>)) if (typeof secret === 'string') found.push(secret);
    } else if (key === 'apiKey' && typeof value === 'string') {
      found.push(value);
    } else {
      found.push(...collectConfigSecrets(value, depth + 1));
    }
  }
  return found;
}

export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export async function exportSession(
  deps: SessionExportDeps, request: SessionExportRequest,
): Promise<IpcResult<{ path: string }>> {
  if (Buffer.byteLength(request.markdown, 'utf8') > MAX_EXPORT_BYTES) {
    return { ok: false, code: 'invalid_argument', message: 'The conversation is too large to export (over 20 MB).' };
  }
  const defaultPath = join(deps.defaultDirectory(request.cwd), suggestFileName(request.suggestedName, deps.now()));
  const chosen = await deps.chooseFile(defaultPath);
  if (chosen === null) return { ok: false, code: 'cancelled', message: 'Export cancelled.' };
  const text = scrubSecrets(request.markdown, deps.secrets(), deps.redact);
  try {
    deps.writeAtomic(chosen, text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { ok: false, code: 'write_failed', message: `The file could not be written${code ? ` (${code})` : ''}.` };
  }
  return { ok: true, value: { path: chosen } };
}
