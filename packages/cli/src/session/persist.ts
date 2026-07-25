/**
 * Session save/resume (spec §6.3). Persists BOTH the engine `messages` and the
 * visual `entries`: on abort the loop breaks before pushing the in-flight
 * assistant message, so `messages` and `entries` legitimately diverge (R9).
 * `messages` is what the engine resends on resume; `entries` is the faithful
 * visual replay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Message, ModelRef } from '@argon-agent/core';
import type { Entry } from '../agent/reducer.js';
import { getSessionsDir } from '../config/store.js';

export interface SavedSession {
  version: number;
  savedAt: number;
  model: ModelRef;
  messages: Message[];
  entries: Entry[];
}

const SESSION_VERSION = 1;

/** Resolve a `/save` target: absolute/relative path, or a name in the data dir. */
export function resolveSessionPath(nameOrPath: string | undefined, cwd: string): string {
  if (!nameOrPath || nameOrPath.trim().length === 0) {
    return join(getSessionsDir(), `session-${defaultStamp()}.json`);
  }
  const value = nameOrPath.trim();
  if (isAbsolute(value)) return ensureJsonExt(value);
  if (value.includes('/') || value.includes('\\')) return ensureJsonExt(resolve(cwd, value));
  return join(getSessionsDir(), ensureJsonExt(value));
}

function ensureJsonExt(p: string): string {
  return p.endsWith('.json') ? p : `${p}.json`;
}

function defaultStamp(): string {
  // Filesystem-safe timestamp without punctuation that breaks on Windows.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function saveSession(
  filePath: string,
  data: { model: ModelRef; messages: Message[]; entries: Entry[] },
): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload: SavedSession = {
    version: SESSION_VERSION,
    savedAt: Date.now(),
    model: data.model,
    messages: data.messages,
    entries: data.entries,
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

export function loadSession(filePath: string): SavedSession {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as SavedSession;
  if (!parsed || !Array.isArray(parsed.messages) || !Array.isArray(parsed.entries)) {
    throw new Error('Invalid session file (missing messages/entries).');
  }
  return parsed;
}
